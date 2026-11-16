"""Verify shared identities and conservative ownership cleanup for legacy and flat jobs."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from contextlib import closing
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from library_cache import add_document_column, describe, document_identity, normalize_config, prune


def reference(letter):
    """Build a deterministic document ownership reference."""
    return {"fingerprint":letter*64,"document_key":hashlib.sha256(letter.encode()).hexdigest(),
            "model":"deepseek-flash","lang_out":"zh-CN"}


def seed(tmp_path, refs):
    """Seed disposable source caches and document-owned paragraphs, not saved results."""
    cache, jobs = tmp_path / "cache", tmp_path / "jobs"
    cache.mkdir(); jobs.mkdir()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        add_document_column(db)
        for ref in refs:
            folder = jobs / ref["fingerprint"]; folder.mkdir()
            (folder / "source.pdf").write_bytes(b"disposable source fixture")
            db.execute("INSERT INTO paragraphs VALUES (?,?,?)",(ref["fingerprint"],"译文",ref["document_key"]))
    return cache,jobs


def flat_attempt(jobs, ref, number=1, output=True):
    """Seed immutable attempt ownership with either a retained output or disposable input."""
    folder = jobs / "attempts" / f"{ref['fingerprint'][:32]}-{number}"
    folder.mkdir(parents=True)
    identity = {key: ref[key] for key in ("fingerprint", "document_key")}
    (folder / "identity.json").write_text(json.dumps(identity), encoding="utf-8")
    filename = "translated.pdf" if output else "source.pdf"
    (folder / filename).write_bytes(ref["fingerprint"].encode("ascii"))
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


def test_legacy_cache_is_attributed_before_pruning(tmp_path, monkeypatch):
    """Legacy migration preserves surviving owners and releases every Windows database handle."""
    cache,jobs = tmp_path/"cache",tmp_path/"jobs"
    (cache/"babeldoc").mkdir(parents=True);jobs.mkdir()
    a,b = reference("a"),reference("b")
    text = "A cached paragraph"
    with closing(sqlite3.connect(cache / "paragraphs.sqlite")) as db, db:
        db.execute("CREATE TABLE paragraphs (key TEXT PRIMARY KEY,translation TEXT NOT NULL)")
        for ref in [a,b]:
            namespace=json.dumps(["paperbridge-compact-v1",ref["model"],ref["lang_out"],ref["document_key"]],separators=(",", ":"))
            key=hashlib.sha256((namespace+"\0"+text).encode()).hexdigest()
            db.execute("INSERT INTO paragraphs VALUES (?,?)",(key,"缓存译文"))
    with closing(sqlite3.connect(cache / "babeldoc/cache.v1.db")) as db, db:
        db.execute("CREATE TABLE _translationcache (translate_engine TEXT,original_text TEXT)")
        db.execute("INSERT INTO _translationcache VALUES (?,?)",("paperbridge","prefix\n## Here is the input:\n\n"+json.dumps([{"id":0,"input":text}])))
    connections = []
    original_connect = sqlite3.connect

    def tracked_connect(*args, **kwargs):
        """Retain real connections so garbage collection cannot hide a missing explicit close."""
        connection = original_connect(*args, **kwargs)
        connections.append(connection)
        return connection

    with monkeypatch.context() as patch:
        patch.setattr(sqlite3, "connect", tracked_connect)
        prune(cache,jobs,[a],[b],sweep=True)
    assert connections
    for connection in connections:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connection.execute("SELECT 1")
    with closing(sqlite3.connect(cache / "paragraphs.sqlite")) as db:
        assert db.execute("SELECT document_key FROM paragraphs").fetchall()==[(b["document_key"],)]
    with closing(sqlite3.connect(cache / "babeldoc/cache.v1.db")) as db:
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
    attempts = [flat_attempt(jobs, ref, output=False) for ref in (removed, shared, active, orphan)]
    retry = flat_attempt(jobs, removed, number=2, output=False)
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
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert {row[0] for row in db.execute("SELECT document_key FROM paragraphs")} == {
            shared["document_key"], active["document_key"]}


@pytest.mark.parametrize("layout", ["legacy", "nested", "flat"])
@pytest.mark.parametrize("sweep", [False, True])
def test_stale_cleanup_refs_preserve_result_and_sidecars(tmp_path, layout, sweep):
    """Old pending references cannot discard saved results or their recovery evidence."""
    retained, disposable = reference("a"), reference("b")
    cache, jobs = seed(tmp_path, [retained, disposable])
    folder = jobs / retained["fingerprint"]
    if layout == "nested":
        folder = folder / "attempts" / "old-job" / "1"
    if layout == "flat":
        folder = flat_attempt(jobs, retained)
    else:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "translated.pdf").write_bytes(b"retained translated PDF")
    for name in ("alignment.json", "manifest.json", "quality.json", "usage.json"):
        (folder / name).write_text(json.dumps({"fixture": name}), encoding="utf-8")
    expected = {path.name: path.read_bytes() for path in folder.iterdir() if path.is_file()}

    result = prune(cache, jobs, [retained, disposable], [], sweep=sweep)

    assert result["removed_jobs"] == [disposable["fingerprint"]]
    assert not (jobs / disposable["fingerprint"]).exists()
    assert (jobs / retained["fingerprint"]).is_dir()
    assert {name: (folder / name).read_bytes() for name in expected} == expected
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT document_key FROM paragraphs").fetchall() == [(retained["document_key"],)]


@pytest.mark.parametrize("sidecar", ["alignment.json", "manifest.json", "quality.json"])
def test_prune_preserves_result_evidence_without_cached_pdf(tmp_path, sidecar):
    """A Zotero-imported PDF can still depend on its otherwise orphaned result sidecar."""
    ref = reference("a")
    cache, jobs = seed(tmp_path, [ref])
    folder = flat_attempt(jobs, ref, output=False)
    path = folder / sidecar
    path.write_bytes(b'{"fixture":"retained result evidence"}')

    assert prune(cache, jobs, [ref], [], sweep=True)["removed_jobs"] == []
    assert path.read_bytes() == b'{"fixture":"retained result evidence"}'
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT count(*) FROM paragraphs").fetchone()[0] == 1


def test_retained_other_page_range_protects_shared_paragraphs(tmp_path):
    """A retained flat result protects document paragraphs without a frontend keep entry."""
    disposable, retained = reference("a"), reference("b")
    retained["document_key"] = disposable["document_key"]
    cache, jobs = seed(tmp_path, [disposable])
    folder = flat_attempt(jobs, retained)

    assert prune(cache, jobs, [disposable], [])["removed_jobs"] == [disposable["fingerprint"]]
    assert (folder / "translated.pdf").is_file()
    with sqlite3.connect(cache / "paragraphs.sqlite") as db:
        assert db.execute("SELECT count(*) FROM paragraphs").fetchone()[0] == 1


def test_unknown_disposable_attempt_is_not_guessed_unowned(tmp_path):
    """Even a source-only attempt is not disposable when its identity is unreadable."""
    cache, jobs = seed(tmp_path, [])
    ref = reference("a")
    folder = flat_attempt(jobs, ref, output=False)
    (folder / "identity.json").write_bytes(b"{")

    assert prune(cache, jobs, [ref], [], sweep=True)["removed_jobs"] == []
    assert (folder / "source.pdf").is_file()


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
