"""Verify shared identities and conservative ownership cleanup for legacy and flat jobs."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from library_cache import add_document_column, describe, document_identity, normalize_config, prune


def reference(letter):
    """Build a deterministic document ownership reference."""
    return {"fingerprint":letter*64,"document_key":hashlib.sha256(letter.encode()).hexdigest(),
            "model":"deepseek-flash","lang_out":"zh-CN"}


def seed(tmp_path, refs):
    """Seed minimal cache and artifact records for cleanup tests."""
    cache, jobs = tmp_path / "cache", tmp_path / "jobs"
    cache.mkdir(); jobs.mkdir()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        add_document_column(db)
        for ref in refs:
            folder = jobs / ref["fingerprint"]; folder.mkdir()
            (folder / "translated.pdf").write_text("fixture")
            db.execute("INSERT INTO paragraphs VALUES (?,?,?)",(ref["fingerprint"],"译文",ref["document_key"]))
    return cache,jobs


def flat_attempt(jobs, ref, number=1):
    """Seed a short attempt directory with the server's immutable ownership sidecar."""
    folder = jobs / "attempts" / f"{ref['fingerprint'][:32]}-{number}"
    folder.mkdir(parents=True)
    identity = {key: ref[key] for key in ("fingerprint", "document_key")}
    (folder / "identity.json").write_text(json.dumps(identity), encoding="utf-8")
    (folder / "translated.pdf").write_bytes(ref["fingerprint"].encode("ascii"))
    return folder


def test_shared_reference_prevents_cleanup(tmp_path):
    """A surviving library owner prevents artifact deletion."""
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
    """Different page-range artifacts can share document-owned paragraphs."""
    a,b = reference("a"),reference("b")
    b["document_key"] = a["document_key"]
    cache,jobs = seed(tmp_path,[a,b])
    prune(cache,jobs,[a],[b])
    assert not (jobs / a["fingerprint"]).exists()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT count(*) FROM paragraphs").fetchone()[0]==2


def test_legacy_cache_is_attributed_before_pruning(tmp_path):
    """Legacy ownership migration preserves only surviving owners."""
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


@pytest.mark.parametrize("output_folder", ["", "attempts/job-1"])
def test_describe_survives_source_deletion(tmp_path, output_folder):
    """Locate an output even after its original source is deleted."""
    jobs=tmp_path/"jobs";jobs.mkdir()
    source=tmp_path/"source.pdf";source.write_bytes(b"%PDF-fixture")
    request={"source_path":str(source),"model":"deepseek-flash","base_url":"https://api.deepseek.com","lang_out":"zh-CN","pages":""}
    identity=describe(request,jobs)
    folder=jobs/identity["fingerprint"]/output_folder;folder.mkdir(parents=True)
    (folder/"translated.pdf").write_bytes(b"translated fixture")
    output=tmp_path/"attachment.pdf";output.write_bytes(b"translated fixture")
    source.unlink()
    migrated=describe({**request,"translated_path":str(output)},jobs)
    assert migrated["fingerprint"]==identity["fingerprint"]
    assert migrated["document_key"] == ""


def test_describe_flat_attempt_uses_identity_sidecar(tmp_path):
    """An imported PDF recovers both identities without its original source or long path."""
    jobs = tmp_path / "jobs"
    ref = reference("a")
    folder = flat_attempt(jobs, ref, number=12)
    output = tmp_path / "attachment.pdf"
    output.write_bytes((folder / "translated.pdf").read_bytes())
    request = {"source_path": str(tmp_path / "missing.pdf"), "translated_path": str(output)}
    assert describe(request, jobs) == {key: ref[key] for key in ("fingerprint", "document_key")}


@pytest.mark.parametrize("sweep", [False, True])
def test_prune_flat_attempts_preserves_shared_and_active_fingerprints(tmp_path, sweep):
    """Delete all unowned attempts once per fingerprint while retaining surviving owners."""
    removed, shared, active, orphan = [reference(letter) for letter in "abcd"]
    cache, jobs = seed(tmp_path, [removed, shared, active])
    attempts = [flat_attempt(jobs, ref) for ref in (removed, shared, active, orphan)]
    retry = flat_attempt(jobs, removed, number=2)
    result = prune(cache, jobs, [removed, shared, active], [shared], sweep=sweep,
                   active=[active["fingerprint"]])
    expected = {removed["fingerprint"]}
    if sweep:
        expected.add(orphan["fingerprint"])
    assert set(result["removed_jobs"]) == expected
    assert len(result["removed_jobs"]) == len(expected)
    assert not attempts[0].exists() and not retry.exists()
    assert not (jobs / removed["fingerprint"]).exists()
    for ref, folder in zip((shared, active), attempts[1:3]):
        assert folder.is_dir() and (folder / "identity.json").is_file()
        assert (jobs / ref["fingerprint"]).is_dir()
    # The orphan has no legacy directory, so sweep must discover its flat sidecar.
    assert attempts[3].exists() == (not sweep)


def test_unknown_flat_identities_are_not_described_or_pruned(tmp_path):
    """Missing, malformed, or unrecognized ownership must not authorize guessed deletion."""
    cache, jobs = seed(tmp_path, [])
    ref = reference("a")
    identity = {key: ref[key] for key in ("fingerprint", "document_key")}
    # Partial or ill-typed sidecars cannot establish ownership.
    sidecars = [None, b"{", b"\xff", b"[]",
                json.dumps({"fingerprint": ref["fingerprint"]}).encode("utf-8"),
                json.dumps({**identity, "fingerprint": "invalid"}).encode("utf-8"),
                json.dumps({**identity, "document_key": 1}).encode("utf-8")]
    folders = []
    for number, sidecar in enumerate(sidecars, start=1):
        folder = flat_attempt(jobs, ref, number)
        path = folder / "identity.json"
        if sidecar is None:
            path.unlink()
        else:
            path.write_bytes(sidecar)
        folders.append(folder)
    for name in ("unknown", f"{'b' * 32}-0"):
        folder = jobs / "attempts" / name
        folder.mkdir()
        (folder / "identity.json").write_text(json.dumps(identity), encoding="utf-8")
        (folder / "translated.pdf").write_bytes(b"unrecognized layout")
        folders.append(folder)
    for folder in folders:
        assert describe({"translated_path": str(folder / "translated.pdf")}, jobs) == {
            "fingerprint": "", "document_key": ""}
    for sweep in (False, True):
        result = prune(cache, jobs, [ref], [], sweep=sweep)
        assert result["removed_jobs"] == []
        assert all((folder / "translated.pdf").is_file() for folder in folders)


def test_shared_identity_normalizes_endpoint_and_ignores_credentials(tmp_path):
    """Server and describe identities share all relevant normalized settings, never keys."""
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-fixture")
    request = {"source_path": str(source), "base_url": "https://API.DEEPSEEK.com:443/v1/", "api_key": "secret"}
    config = normalize_config(request)
    assert set(config) == {"profile", "base_url", "model", "lang_out", "pages", "capabilities"}
    assert config["base_url"] == "https://api.deepseek.com"
    assert "secret" not in json.dumps(config)
    identity = document_identity(source.read_bytes(), config)
    assert identity == describe(request, tmp_path)
    assert identity == document_identity(source.read_bytes(), {**request, "api_key": "different"})
    assert identity != document_identity(source.read_bytes(), {**config, "profile": "compatible"})
    assert identity != document_identity(source.read_bytes(), {**config, "capabilities": {"max_tokens": 3000}})


@pytest.mark.parametrize("update", [
    {"profile": "native"}, {"capabilities": {"max_tokens": 0}}, {"capabilities": {"max_tokens": True}},
    {"capabilities": {"json_mode": "true"}}, {"base_url": "https://secret@example.org/v1"},
    {"base_url": "https://example.org/v1?key=secret"}, {"capabilities": {"unknown": True}},
])
def test_config_rejects_unsupported_or_credential_bearing_settings(update):
    """Validate the bounded capability contract before dispatch or persistence."""
    with pytest.raises(ValueError):
        normalize_config(update)
