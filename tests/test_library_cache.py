import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from library_cache import add_document_column, describe, prune


def reference(letter):
    return {"fingerprint":letter*64,"document_key":hashlib.sha256(letter.encode()).hexdigest(),
            "model":"deepseek-flash","lang_out":"zh-CN"}


def seed(tmp_path, refs):
    cache, jobs = tmp_path / "cache", tmp_path / "jobs"
    cache.mkdir(); jobs.mkdir()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        add_document_column(db)
        for ref in refs:
            folder = jobs / ref["fingerprint"]; folder.mkdir()
            (folder / "translated.pdf").write_text("fixture")
            db.execute("INSERT INTO paragraphs VALUES (?,?,?)",(ref["fingerprint"],"译文",ref["document_key"]))
    return cache,jobs


def test_shared_reference_prevents_cleanup(tmp_path):
    a,b = reference("a"),reference("b")
    cache,jobs = seed(tmp_path,[a,b])
    prune(cache,jobs,[a],[a,b])
    assert (jobs / a["fingerprint"]).exists()
    prune(cache,jobs,[a],[b])
    assert not (jobs / a["fingerprint"]).exists()
    assert (jobs / b["fingerprint"]).exists()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT document_key FROM paragraphs").fetchall()==[(b["document_key"],)]


def test_other_page_range_keeps_shared_paragraphs(tmp_path):
    a,b = reference("a"),reference("b")
    b["document_key"] = a["document_key"]
    cache,jobs = seed(tmp_path,[a,b])
    prune(cache,jobs,[a],[b])
    assert not (jobs / a["fingerprint"]).exists()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT count(*) FROM paragraphs").fetchone()[0]==2


def test_legacy_cache_is_attributed_before_pruning(tmp_path):
    cache,jobs = tmp_path/"cache",tmp_path/"jobs"
    (cache/"babeldoc").mkdir(parents=True);jobs.mkdir()
    a,b = reference("a"),reference("b")
    text = "A cached paragraph"
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        db.execute("CREATE TABLE paragraphs (key TEXT PRIMARY KEY,translation TEXT NOT NULL)")
        for ref in [a,b]:
            namespace=json.dumps(["paperbridge-compact-v1",ref["model"],ref["lang_out"],ref["document_key"]],separators=(",", ":"))
            key=hashlib.sha256((namespace+"\0"+text).encode()).hexdigest()
            db.execute("INSERT INTO paragraphs VALUES (?,?)",(key,"缓存译文"))
    with sqlite3.connect(cache / "babeldoc/cache.v1.db") as db:
        db.execute("CREATE TABLE _translationcache (translate_engine TEXT,original_text TEXT)")
        db.execute("INSERT INTO _translationcache VALUES (?,?)",("paperbridge","prefix\n## Here is the input:\n\n"+json.dumps([{"id":0,"input":text}])))
    prune(cache,jobs,[a],[b],sweep=True)
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT document_key FROM paragraphs").fetchall()==[(b["document_key"],)]
    with sqlite3.connect(cache / "babeldoc/cache.v1.db") as db:
        assert db.execute("SELECT count(*) FROM _translationcache").fetchone()[0]==0


def test_describe_survives_source_deletion(tmp_path):
    jobs=tmp_path/"jobs";jobs.mkdir()
    source=tmp_path/"source.pdf";source.write_bytes(b"%PDF-fixture")
    request={"source_path":str(source),"model":"deepseek-flash","base_url":"https://api.deepseek.com","lang_out":"zh-CN","pages":""}
    identity=describe(request,jobs)
    folder=jobs/identity["fingerprint"];folder.mkdir()
    (folder/"translated.pdf").write_bytes(b"translated fixture")
    output=tmp_path/"attachment.pdf";output.write_bytes(b"translated fixture")
    source.unlink()
    migrated=describe({**request,"translated_path":str(output)},jobs)
    assert migrated["fingerprint"]==identity["fingerprint"]
