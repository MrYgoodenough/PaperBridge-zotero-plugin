"""Document ownership and deletion for plugin caches; no Zotero database writes."""
import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path

PROMPT_VERSION = "paperbridge-compact-v1"
ENGINE_VERSION = "babeldoc-0.6.4-protected-v4-no-references"


def describe(request, jobs):
    source = Path(request["source_path"]) if request.get("source_path") else None
    if source and source.is_file():
        content = source.read_bytes()
        settings = {"model":request["model"], "base_url":request["base_url"], "lang_out":request["lang_out"],
                    "pages":request["pages"], "font":"songti-sc-v1", "engine":ENGINE_VERSION}
        return {"fingerprint":hashlib.sha256(content + json.dumps(settings,sort_keys=True).encode()).hexdigest(),
                "document_key":hashlib.sha256(content).hexdigest()}
    output = Path(request["translated_path"]) if request.get("translated_path") else None
    if output and output.is_file():
        digest = hashlib.sha256(output.read_bytes()).digest()
        for path in jobs.glob("*/translated.pdf"):
            if hashlib.sha256(path.read_bytes()).digest() == digest:
                return {"fingerprint":path.parent.name, "document_key":""}
    return {"fingerprint":"", "document_key":""}


def add_document_column(db):
    db.execute("CREATE TABLE IF NOT EXISTS paragraphs (key TEXT PRIMARY KEY, translation TEXT NOT NULL, document_key TEXT)")
    if "document_key" not in {row[1] for row in db.execute("PRAGMA table_info(paragraphs)")}:
        db.execute("ALTER TABLE paragraphs ADD COLUMN document_key TEXT")
    db.execute("CREATE INDEX IF NOT EXISTS paragraphs_document ON paragraphs(document_key)")


def migrate_paragraphs(cache, references):
    """Attribute legacy hashed paragraph rows before retiring the second cache."""
    paragraph_path = cache / "paragraphs.sqlite"
    old_path = cache / "babeldoc/cache.v1.db"
    if not paragraph_path.exists():
        return
    texts = set()
    if old_path.exists():
        with sqlite3.connect(old_path) as old:
            for (text,) in old.execute("SELECT original_text FROM _translationcache WHERE translate_engine='paperbridge'"):
                marker = "## Here is the input:\n\n"
                if marker in text:
                    texts.update(p["input"] for p in json.loads(text.split(marker,1)[1]))
                else:
                    texts.add(text.split("Now translate the following text:\n\n",1)[-1])
    with sqlite3.connect(paragraph_path) as db:
        add_document_column(db)
        for ref in references:
            doc = ref.get("document_key")
            if not doc:
                continue
            namespace = json.dumps([PROMPT_VERSION,ref["model"],ref["lang_out"],doc],separators=(",", ":"))
            keys = [(doc,hashlib.sha256((namespace+"\0"+text).encode()).hexdigest()) for text in texts]
            db.executemany("UPDATE paragraphs SET document_key=? WHERE key=? AND document_key IS NULL",keys)
        # Unattributed prototype cache entries have no surviving library owner.
        db.execute("DELETE FROM paragraphs WHERE document_key IS NULL")
        db.commit()
        db.execute("VACUUM")
    if old_path.exists():
        with sqlite3.connect(old_path) as old:
            old.execute("DELETE FROM _translationcache WHERE translate_engine='paperbridge'")
            old.commit()
            old.execute("VACUUM")


def prune(cache, jobs, remove, keep, sweep=False, active=()):
    for ref in [*remove,*keep]:
        for key in ["fingerprint","document_key"]:
            if ref.get(key) and not re.fullmatch(r"[a-f0-9]{64}",ref[key]):
                raise ValueError("Invalid cache identity")
    keep_jobs = {r["fingerprint"] for r in keep if r.get("fingerprint")}
    keep_docs = {r["document_key"] for r in keep if r.get("document_key")}
    deleted_jobs = {r["fingerprint"] for r in remove if r.get("fingerprint")} - keep_jobs
    deleted_docs = {r["document_key"] for r in remove if r.get("document_key")} - keep_docs
    if sweep:
        migrate_paragraphs(cache,[*keep,*remove])
        deleted_jobs.update(p.name for p in jobs.iterdir() if p.is_dir() and re.fullmatch(r"[a-f0-9]{64}",p.name) and p.name not in keep_jobs)
    removed = []
    for fingerprint in deleted_jobs - set(active):
        folder = jobs / fingerprint
        if folder.exists():
            shutil.rmtree(folder)
            removed.append(fingerprint)
    path = cache / "paragraphs.sqlite"
    rows = 0
    if path.exists():
        with sqlite3.connect(path) as db:
            add_document_column(db)
            if sweep:
                existing_docs = {row[0] for row in db.execute("SELECT DISTINCT document_key FROM paragraphs")}
                deleted_docs.update(existing_docs - keep_docs)
            for doc in deleted_docs:
                rows += db.execute("DELETE FROM paragraphs WHERE document_key=?",(doc,)).rowcount
            db.commit()
            if rows:
                db.execute("VACUUM")
    return {"removed_jobs":removed,"removed_paragraphs":rows,"shared_jobs_preserved":len(keep_jobs)}
