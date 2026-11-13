"""Document ownership and deletion for plugin caches; no Zotero database writes."""
import hashlib
import json
import re
import shutil
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

# Translation instructions are shared by document and paragraph cache identities.
PROMPT_VERSION = "paperbridge-compact-v1"
# Result evidence changes invalidate full PDFs, not valid paragraph translations.
ENGINE_VERSION = "babeldoc-0.6.4-protected-v4-no-references"
# Separate evidence-bearing results from legacy PDF-only jobs.
QUALITY_VERSION = 1
# Preserve the existing provider and request limits unless explicitly configured.
DEFAULT_BASE_URL = "https://api.deepseek.com"
# The bundled default model remains unchanged.
DEFAULT_MODEL = "deepseek-flash"
# The existing completion limit also provides the compatible-profile default.
DEFAULT_MAX_TOKENS = 8192


def normalize_endpoint(value):
    """Canonicalize an HTTP endpoint without accepting embedded credentials."""
    parts = urlsplit(value.strip())
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise ValueError("base_url must be an HTTP(S) endpoint")
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise ValueError("base_url must not contain credentials, a query, or a fragment")
    scheme = parts.scheme.lower()
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    if port is not None and port != {"https": 443, "http": 80}[scheme]:
        host += f":{port}"
    path = parts.path.rstrip("/")
    # DeepSeek documents both spellings as the same OpenAI-compatible endpoint.
    if host == "api.deepseek.com" and path == "/v1":
        path = ""
    return urlunsplit((scheme, host, path, "", ""))


def normalize_config(request):
    """Return credential-free profile/base_url/model/lang_out/pages/capabilities settings."""
    profile = request.get("profile", "deepseek")
    if profile not in {"deepseek", "compatible"}:
        raise ValueError("profile must be deepseek or compatible")
    supplied = request.get("capabilities", {})
    if not isinstance(supplied, dict) or set(supplied) - {"json_mode", "thinking_disabled", "max_tokens"}:
        raise ValueError("Unsupported capabilities")
    capabilities = {"json_mode": profile == "deepseek", "thinking_disabled": profile == "deepseek",
                    "max_tokens": DEFAULT_MAX_TOKENS, **supplied}
    for name in ("json_mode", "thinking_disabled"):
        if type(capabilities[name]) is not bool:
            raise ValueError(f"{name} must be a boolean")
    if type(capabilities["max_tokens"]) is not int or capabilities["max_tokens"] <= 0:
        raise ValueError("max_tokens must be a positive integer")
    endpoint = request.get("base_url", DEFAULT_BASE_URL if profile == "deepseek" else "")
    model = request.get("model", DEFAULT_MODEL if profile == "deepseek" else "")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model is required")
    if not isinstance(endpoint, str):
        raise ValueError("base_url must be a string")
    language = request.get("lang_out", "zh-CN")
    pages = request.get("pages", "") or ""
    if not isinstance(language, str) or not language.strip() or not isinstance(pages, str):
        raise ValueError("lang_out and pages must be strings, with a nonempty language")
    return {"profile": profile, "base_url": normalize_endpoint(endpoint), "model": model.strip(),
            "lang_out": language.strip(), "pages": pages.strip(),
            "capabilities": capabilities}


def document_identity(content, request):
    """Return fingerprint and document_key SHA-256 strings using canonical nonsecret settings."""
    settings = {**normalize_config(request), "prompt": PROMPT_VERSION, "font": "songti-sc-v1",
                "engine": ENGINE_VERSION, "quality_version": QUALITY_VERSION}
    return {"fingerprint": hashlib.sha256(content + json.dumps(settings, sort_keys=True).encode()).hexdigest(),
            "document_key": hashlib.sha256(content).hexdigest()}


def paragraph_namespace(request, document_key, lang_in="en"):
    """Isolate paragraphs by provider, endpoint, capabilities, prompt, model, languages, and document."""
    settings = normalize_config(request)
    settings.pop("pages")
    return json.dumps({**settings, "prompt": PROMPT_VERSION, "lang_in": lang_in,
                       "document_key": document_key}, sort_keys=True, separators=(",", ":"))


def _attempt_identity(folder):
    """Read validated ownership only from a recognized immutable flat attempt folder."""
    if (folder.is_symlink() or not folder.is_dir()
            or not re.fullmatch(r"[a-f0-9]{32}-[1-9][0-9]*", folder.name)):
        return None
    try:
        data = json.loads((folder / "identity.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    identity = {key: data.get(key) for key in ("fingerprint", "document_key")}
    if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
               for value in identity.values()):
        return None
    return identity


def describe(request, jobs):
    """Identify a source, or recover output ownership from legacy paths or flat sidecars."""
    source = Path(request["source_path"]) if request.get("source_path") else None
    if source and source.is_file():
        return document_identity(source.read_bytes(), request)
    output = Path(request["translated_path"]) if request.get("translated_path") else None
    if output and output.is_file():
        digest = hashlib.sha256(output.read_bytes()).digest()
        for path in jobs.rglob("translated.pdf"):
            if hashlib.sha256(path.read_bytes()).digest() == digest:
                parts = path.relative_to(jobs).parts
                if parts[0] == "attempts" and len(parts) == 3:
                    identity = _attempt_identity(path.parent)
                    if identity is not None:
                        return identity
                elif re.fullmatch(r"[a-f0-9]{64}", parts[0]):
                    return {"fingerprint":parts[0], "document_key":""}
    return {"fingerprint":"", "document_key":""}


def add_document_column(db):
    """Ensure paragraph ownership can be tracked across cache schema versions."""
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
    """Remove unowned caches, preserving shared/active fingerprints and unknown attempts."""
    for ref in [*remove,*keep]:
        for key in ["fingerprint","document_key"]:
            if ref.get(key) and not re.fullmatch(r"[a-f0-9]{64}",ref[key]):
                raise ValueError("Invalid cache identity")
    keep_jobs = {r["fingerprint"] for r in keep if r.get("fingerprint")}
    keep_docs = {r["document_key"] for r in keep if r.get("document_key")}
    active = set(active)
    deleted_jobs = {r["fingerprint"] for r in remove if r.get("fingerprint")} - keep_jobs
    deleted_docs = {r["document_key"] for r in remove if r.get("document_key")} - keep_docs
    if sweep:
        migrate_paragraphs(cache,[*keep,*remove])
        deleted_jobs.update(p.name for p in jobs.iterdir() if p.is_dir() and re.fullmatch(r"[a-f0-9]{64}",p.name) and p.name not in keep_jobs)
    removed = set()
    for fingerprint in deleted_jobs - active:
        folder = jobs / fingerprint
        if folder.exists():
            shutil.rmtree(folder)
            removed.add(fingerprint)
    attempts = jobs / "attempts"
    if attempts.is_dir():
        for folder in attempts.iterdir():
            identity = _attempt_identity(folder)
            # Missing or invalid sidecars never establish permission to delete an attempt.
            if identity is None:
                continue
            fingerprint = identity["fingerprint"]
            if fingerprint in keep_jobs or fingerprint in active:
                continue
            if sweep or fingerprint in deleted_jobs:
                shutil.rmtree(folder)
                removed.add(fingerprint)
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
    return {"removed_jobs":sorted(removed),"removed_paragraphs":rows,"shared_jobs_preserved":len(keep_jobs)}
