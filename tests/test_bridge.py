import importlib.util
import json
import os
import threading
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "backend/server.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "JOBS", tmp_path / "jobs")
    monkeypatch.setenv("PAPERBRIDGE_CACHE_DIR",str(tmp_path / "cache"))
    result = bridge.JobStore()
    monkeypatch.setattr(result.pool, "submit", lambda *args: None)
    yield result
    result.pool.shutdown()


def request(tmp_path, **changes):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.7\nfixture")
    return {"source_path": str(source), "api_key": "secret-fixture", **changes}


def test_cache_reuses_identical_pdf_and_settings(store, tmp_path):
    first = store.submit(request(tmp_path))
    folder = next(bridge.JOBS.iterdir())
    (folder / "translated.pdf").write_bytes(b"%PDF-fixture")
    store.jobs[first["id"]]["state"] = "done"
    cached = store.submit(request(tmp_path))
    assert cached["state"] == "done" and cached["cached"]
    assert "secret-fixture" not in json.dumps(store.jobs)
    other = store.submit(request(tmp_path, model="another-model"))
    assert other["state"] == "queued"
    assert first["id"] != other["id"]


def test_cancel_queued_job(store, tmp_path):
    job = store.submit(request(tmp_path))
    assert store.cancel(job["id"])["state"] == "cancelled"
    store.run(job["id"], next(bridge.JOBS.iterdir()), {}, "secret")
    assert store.snapshot(job["id"])["state"] == "cancelled"


@pytest.mark.parametrize("changes", [{"pages": "1;rm -rf"}, {"base_url": "http://example.com"}, {"api_key": ""}])
def test_validates_provider_and_page_input(store, tmp_path, changes):
    with pytest.raises(ValueError):
        store.submit(request(tmp_path, **changes))


def test_rejects_fake_pdf(store, tmp_path):
    data = request(tmp_path)
    Path(data["source_path"]).write_text("plain text")
    with pytest.raises(ValueError, match="PDF"):
        store.submit(data)


def test_token_is_private_and_stable(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "RUNTIME", tmp_path)
    first = bridge.read_token()
    assert len(first) >= 32
    assert bridge.read_token() == first
    if os.name != "nt":
        # Windows has no POSIX permission bits; the data directory ACL applies instead.
        assert (tmp_path / "token").stat().st_mode & 0o777 == 0o600


def test_duplicate_requests_share_running_job(store, tmp_path):
    first = store.submit(request(tmp_path))
    second = store.submit(request(tmp_path))
    assert first["id"] == second["id"]


def test_completed_jobs_keep_only_result_and_usage(tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    for name in ["source.pdf", "repaired.pdf", "translated.pdf", "usage.json"]:
        (job / name).write_text("fixture")
    (job / "work").mkdir()
    (job / "work/intermediate.pdf").write_text("fixture")
    original = tmp_path / "original.pdf"
    original.write_text("original")
    bridge.clean_completed_job(job)
    assert {p.name for p in job.iterdir()} == {"translated.pdf", "usage.json"}
    assert original.read_text() == "original"


def test_library_prune_cancels_only_unowned_queued_job(store,tmp_path):
    first = store.submit(request(tmp_path,pages="1"))
    second = store.submit(request(tmp_path,pages="2"))
    store.prune_library({"remove":[first],"keep":[second]})
    assert store.snapshot(first["id"])["state"] == "cancelled"
    assert not (bridge.JOBS / first["fingerprint"]).exists()
    assert store.snapshot(second["id"])["state"] == "queued"
    assert (bridge.JOBS / second["fingerprint"]).exists()


def test_library_prune_waits_for_running_process_before_cleanup(store,tmp_path):
    job=store.submit(request(tmp_path))
    folder=bridge.JOBS / job["fingerprint"]
    operations=[]
    class Process:
        def poll(self): return None
        def terminate(self): operations.append("terminate")
        def wait(self,timeout):
            assert folder.exists()
            operations.append("wait")
            return 0
    store.jobs[job["id"]].update(state="running",process=Process())
    store.prune_library({"remove":[job],"keep":[]})
    assert operations==["terminate","wait"]
    assert not folder.exists()


def test_loopback_auth_and_origin(store):
    server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
    server.token, server.store = "test-token", store
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/health"
    try:
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(url)
        assert error.value.code == 401
        headers = {"Authorization": "Bearer test-token"}
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as response:
            assert json.load(response)["version"] == bridge.VERSION
        headers["Origin"] = "https://evil.example"
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(urllib.request.Request(url, headers=headers))
        assert error.value.code == 403
    finally:
        server.shutdown()
        server.server_close()
