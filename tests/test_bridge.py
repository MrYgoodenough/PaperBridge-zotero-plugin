"""Focused loopback, durable queue, cancellation, and artifact-retention tests."""
import importlib.util
import json
import os
import threading
import sys
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))

# Load the standalone service without starting its HTTP entry point.
spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "backend/server.py")
# Keep test path overrides separate from any service imported by another test.
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

# An offline subprocess exercises real pipes, exit codes, progress filtering, and serial execution.
ENGINE_FIXTURE = r'''
import json, sys, time
from pathlib import Path
request = json.load(sys.stdin)
folder = Path(request["folder"])
(folder / "started").write_text("started")
print("PB:" + json.dumps({"stage": request["api_key"], "state": "done", "api_key": request["api_key"],
    "phase": "translating", "counts": {"total": 2, "success": 1, "failed": -1, "cache": True, "api_key": request["api_key"]}}), flush=True)
while request["model"] == "blocked" and not (folder / "release").exists():
    time.sleep(0.01)
(folder / "translated.pdf").write_bytes(b"%PDF-offline-result")
(folder / "quality.json").write_text(json.dumps({"status": "complete", "note": request["api_key"]}))
(folder / "usage.json").write_text(json.dumps({"api_requests": 1, "input_tokens": 12}))
(folder / "manifest.json").write_text(json.dumps({"profile": request["profile"], "capabilities": request["capabilities"]}))
print(request["api_key"], file=sys.stderr)
sys.exit(1 if request["model"] == "failure" else 0)
'''


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Create an isolated store with manually driven workers."""
    monkeypatch.setattr(bridge, "JOBS", tmp_path / "jobs")
    monkeypatch.setenv("PAPERBRIDGE_CACHE_DIR",str(tmp_path / "cache"))
    result = bridge.JobStore()
    monkeypatch.setattr(result.pool, "submit", lambda *args: None)
    yield result
    result.pool.shutdown()


def request(tmp_path, **changes):
    """Build a local PDF request without a real credential or provider call."""
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.7\nfixture")
    return {"source_path": str(source), "api_key": "secret-fixture", **changes}


def wait_for(predicate, timeout=5):
    """Wait briefly for observable test worker progress without depending on timing."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Timed out waiting for offline worker")


@pytest.fixture
def running_store(store, monkeypatch):
    """Use actual subprocesses, replacing only the expensive engine entry point."""
    monkeypatch.delattr(store.pool, "submit")
    popen = subprocess.Popen
    def launch(command, **kwargs):
        """Keep credentials out of argv/env and run a deterministic local engine fixture."""
        assert "secret-fixture" not in json.dumps(command)
        assert "PYTHONHOME" not in kwargs["env"] and "PYTHONPATH" not in kwargs["env"]
        return popen([sys.executable, "-I", "-u", "-c", ENGINE_FIXTURE], **kwargs)
    monkeypatch.setattr(bridge.subprocess, "Popen", launch)
    yield store
    store.shutdown()


def test_cache_reuses_identical_pdf_and_settings(store, tmp_path):
    """Only a quality-verified complete result may be reused."""
    first = store.submit(request(tmp_path))
    folder = store.attempt_folder(store.jobs[first["id"]])
    (folder / "translated.pdf").write_bytes(b"%PDF-fixture")
    (folder / "quality.json").write_text('{"status":"complete"}')
    store.finish(store.jobs[first["id"]], folder, 0, "", "secret-fixture")
    cached = store.submit(request(tmp_path))
    assert cached["state"] == "done" and cached["cached"]
    assert "secret-fixture" not in json.dumps(store.jobs)
    other = store.submit(request(tmp_path, model="another-model"))
    assert other["state"] == "queued"
    assert first["id"] != other["id"]


def test_cancel_queued_job(store, tmp_path):
    """A late executor callback cannot run an already cancelled job."""
    job = store.submit(request(tmp_path))
    assert store.cancel(job["id"])["state"] == "cancelled"
    store.run(job["id"], store.attempt_folder(job), {}, "secret")
    assert store.snapshot(job["id"])["state"] == "cancelled"


@pytest.mark.parametrize("legacy_manifest", [False, True])
def test_completed_pdf_hash_is_required_for_cache_reuse(store, tmp_path, legacy_manifest):
    """A changed PDF is retained as history but never reused as a verified complete result."""
    job = store.submit(request(tmp_path))
    folder = store.attempt_folder(job)
    (folder / "translated.pdf").write_bytes(b"%PDF-original-result")
    (folder / "quality.json").write_text('{"status":"complete"}')
    live = store.jobs[job["id"]]
    store.finish(live, folder, 0, "", "secret-fixture")
    if legacy_manifest:
        live.pop("output_sha256")
    assert store.submit(request(tmp_path))["id"] == job["id"]
    (folder / "translated.pdf").write_bytes(b"%PDF-modified-result")
    replacement = store.submit(request(tmp_path))
    assert replacement["id"] != job["id"] and not replacement["cached"]
    assert live["state"] == "done" and (folder / "translated.pdf").is_file()


@pytest.mark.parametrize("changes", [{"pages": "1;rm -rf"}, {"base_url": "http://example.com"}, {"api_key": ""}])
def test_validates_provider_and_page_input(store, tmp_path, changes):
    """Reject invalid input before queueing or persisting credentials."""
    with pytest.raises(ValueError):
        store.submit(request(tmp_path, **changes))


def test_rejects_fake_pdf(store, tmp_path):
    """Require a PDF source signature, independently of output quality."""
    data = request(tmp_path)
    Path(data["source_path"]).write_text("plain text")
    with pytest.raises(ValueError, match="PDF"):
        store.submit(data)


def test_token_is_private_and_stable(tmp_path, monkeypatch):
    """Keep loopback authentication stable and private across restarts."""
    monkeypatch.setattr(bridge, "RUNTIME", tmp_path)
    first = bridge.read_token()
    assert len(first) >= 32
    assert bridge.read_token() == first
    if os.name != "nt":
        # Windows has no POSIX permission bits; the data directory ACL applies instead.
        assert (tmp_path / "token").stat().st_mode & 0o777 == 0o600


def test_duplicate_requests_share_running_job(store, tmp_path):
    """Share exact active work instead of submitting a second paid request."""
    first = store.submit(request(tmp_path))
    second = store.submit(request(tmp_path))
    assert first["id"] == second["id"]


def test_completed_jobs_keep_only_result_and_usage(tmp_path):
    """Remove intermediates without losing quality or manifest sidecars."""
    job = tmp_path / "job"
    job.mkdir()
    for name in ["source.pdf", "repaired.pdf", "translated.pdf", "usage.json", "quality.json", "manifest.json", "identity.json"]:
        (job / name).write_text("fixture")
    (job / "work").mkdir()
    (job / "work/intermediate.pdf").write_text("fixture")
    original = tmp_path / "original.pdf"
    original.write_text("original")
    bridge.clean_completed_job(job)
    assert {p.name for p in job.iterdir()} == {"translated.pdf", "usage.json", "quality.json", "manifest.json", "identity.json"}
    assert original.read_text() == "original"


def test_library_prune_cancels_only_unowned_queued_job(store,tmp_path):
    """Explicit owner removal cancels only work with no remaining owner."""
    first = store.submit(request(tmp_path,pages="1"))
    second = store.submit(request(tmp_path,pages="2"))
    store.prune_library({"remove":[first],"keep":[second]})
    assert store.snapshot(first["id"])["state"] == "cancelled"
    assert not (bridge.JOBS / first["fingerprint"]).exists()
    assert not store.attempt_folder(first).exists()
    assert store.snapshot(second["id"])["state"] == "queued"
    assert (bridge.JOBS / second["fingerprint"]).exists()
    assert store.attempt_folder(second).exists()


def test_library_prune_waits_for_running_process_before_cleanup(store,tmp_path):
    """Never remove an attempt while its engine is still writing files."""
    job=store.submit(request(tmp_path))
    folder=store.attempt_folder(job)
    operations=[]
    class Process:
        def poll(self):
            """Report the simulated engine as active."""
            return None
        def terminate(self):
            """Observe cancellation ordering."""
            operations.append("terminate")
        def wait(self,timeout):
            """Require the artifact folder to exist until process exit."""
            assert folder.exists()
            operations.append("wait")
            return 0
    store.jobs[job["id"]].update(state="running")
    store.processes[job["id"]] = Process()
    store.prune_library({"remove":[job],"keep":[]})
    assert operations==["terminate","wait"]
    assert not folder.exists()


def test_loopback_auth_and_origin(store):
    """Reject unauthenticated and browser-origin requests."""
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


@pytest.mark.parametrize("state", ["queued", "running", "cancelling"])
def test_restart_interrupts_without_replaying_and_preserves_source(store, tmp_path, monkeypatch, state):
    """Restart recovers usage but never replays an uncertain provider request."""
    job = store.submit(request(tmp_path))
    live = store.jobs[job["id"]]
    live["state"] = live["attempts"][-1]["state"] = state
    folder = store.attempt_folder(live)
    (folder / "usage.json").write_text('{"api_requests":2,"input_tokens":17}')
    store.persist(live)
    Path(request(tmp_path)["source_path"]).unlink()
    recovered = bridge.JobStore()
    try:
        snapshot = recovered.snapshot(job["id"])
        assert snapshot["state"] == snapshot["attempts"][-1]["state"] == "interrupted"
        assert snapshot["usage"]["input_tokens"] == 17
        assert (bridge.JOBS / job["fingerprint"] / "source.pdf").read_bytes() == b"%PDF-1.7\nfixture"
        assert recovered.processes == {}
        assert recovered.list_jobs() == [snapshot]
        with pytest.raises(ValueError, match="API Key"):
            recovered.retry(job["id"], {})
        monkeypatch.setattr(recovered.pool, "submit", lambda *args: None)
        retry = recovered.retry(job["id"], {"api_key": "fresh-key"})
        assert retry["id"] != job["id"]
        assert retry["previous_job_id"] == retry["root_job_id"] == job["id"]
        assert len(retry["attempts"]) == 2 and retry["usage"]["input_tokens"] == 17
        assert recovered.attempt_folder(retry).joinpath("source.pdf").is_file()
        assert recovered.snapshot(job["id"])["state"] == "interrupted"
    finally:
        recovered.pool.shutdown()


@pytest.mark.parametrize("quality,code,expected", [
    ("complete", 0, "done"), ("partial", 0, "done"), ("unusable", 0, "failed"),
    ("unknown", 0, "failed"), (None, 0, "failed"), ("complete", 1, "failed"),
])
def test_output_requires_engine_success_and_quality(store, tmp_path, quality, code, expected):
    """A PDF or an optimistic engine progress event is not proof of translation success."""
    job = store.submit(request(tmp_path))
    folder = store.attempt_folder(job)
    (folder / "translated.pdf").write_bytes(b"%PDF-result")
    if quality:
        (folder / "quality.json").write_text(json.dumps({"status": quality}))
    store.finish(store.jobs[job["id"]], folder, code, "", "secret-fixture")
    result = store.snapshot(job["id"])
    assert result["state"] == expected
    assert result["quality"]["status"] == (quality or "unknown")
    assert bool(result["output_path"]) == (expected == "done")
    duplicate = store.submit(request(tmp_path))
    assert (duplicate["id"] == job["id"]) == (quality == "complete" and code == 0)


def test_failed_retry_keeps_prior_pdf_sidecars_and_all_usage(store, tmp_path):
    """Failed replacement preserves a partial result and immutable attempt history."""
    job = store.submit(request(tmp_path))
    folder = store.attempt_folder(job)
    (folder / "translated.pdf").write_bytes(b"%PDF-prior")
    (folder / "quality.json").write_text('{"status":"partial","failed":1}')
    (folder / "manifest.json").write_text('{"engine":"fixture"}')
    (folder / "usage.json").write_text('{"api_requests":1,"input_tokens":30}')
    store.finish(store.jobs[job["id"]], folder, 0, "", "secret-fixture")
    retry = store.retry(job["id"], {"api_key": "fresh-key"})
    second = store.attempt_folder(retry)
    (second / "usage.json").write_text('{"api_requests":1,"input_tokens":7}')
    (second / "translated.pdf").write_bytes(b"%PDF-bad-replacement")
    (second / "quality.json").write_text('{"status":"unusable"}')
    store.finish(store.jobs[retry["id"]], second, 1, "provider failed", "fresh-key")
    result = store.snapshot(retry["id"])
    assert result["state"] == "failed"
    assert Path(result["output_path"]).read_bytes() == b"%PDF-prior"
    assert result["quality"]["status"] == "partial"
    assert result["attempts"][-1]["quality"]["status"] == "unusable"
    assert result["usage"]["input_tokens"] == 37
    assert [attempt["usage"]["input_tokens"] for attempt in result["attempts"]] == [30, 7]
    assert (folder / "manifest.json").is_file()
    assert (bridge.JOBS / job["fingerprint"] / "translated.pdf").read_bytes() == b"%PDF-prior"
    # Removing source/output caches must not erase observed historical charges.
    store.prune_library({"remove": [result], "keep": []})
    assert not folder.exists() and not second.exists()
    assert store.snapshot(retry["id"])["usage"]["input_tokens"] == 37
    with pytest.raises(ValueError, match="快照"):
        store.retry(retry["id"], {"api_key": "new-key"})


def test_attempt_layout_keeps_paths_short_and_ownership_durable(store, tmp_path):
    """Avoid redundant hash nesting while retaining cache identity and retry isolation."""
    job = store.submit(request(tmp_path))
    folder = store.attempt_folder(job)
    assert folder == bridge.JOBS / "attempts" / (job["id"] + "-1")
    assert json.loads((folder / "identity.json").read_text()) == {
        "fingerprint": job["fingerprint"], "document_key": job["document_key"]}
    store.cancel(job["id"])
    retry = store.retry(job["id"], {"api_key": "fresh-key"})
    assert store.attempt_folder(retry) != folder
    assert store.attempt_folder(retry, retry["attempts"][0]) == folder
    assert (folder / "source.pdf").is_file()


def test_legacy_attempt_record_can_restart_and_retry_in_new_layout(store, tmp_path, monkeypatch):
    """Old records retain their original paths even if old attempt files were cleaned."""
    job = store.submit(request(tmp_path))
    live = store.jobs[job["id"]]
    live["attempts"][0].pop("layout")
    legacy = bridge.JOBS / job["fingerprint"] / "attempts" / (job["id"] + "-1")
    assert store.attempt_folder(live) == legacy
    store.persist(live)
    recovered = bridge.JobStore()
    try:
        monkeypatch.setattr(recovered.pool, "submit", lambda *args: None)
        retry = recovered.retry(job["id"], {"api_key": "fresh-key"})
        assert recovered.attempt_folder(retry, retry["attempts"][0]) == legacy
        assert recovered.attempt_folder(retry) == bridge.JOBS / "attempts" / (retry["id"] + "-2")
        assert recovered.attempt_folder(retry).joinpath("source.pdf").is_file()
    finally:
        recovered.pool.shutdown()


def test_source_and_config_are_frozen_before_queue(store, tmp_path):
    """Editing the original PDF or settings cannot change queued work."""
    payload = request(tmp_path, capabilities={"json_mode": False})
    result = store.submit(payload)
    Path(payload["source_path"]).write_bytes(b"%PDF-changed")
    payload["capabilities"]["json_mode"] = True
    result["config"]["capabilities"]["json_mode"] = True
    snapshot = store.snapshot(result["id"])
    assert snapshot["config"]["capabilities"]["json_mode"] is False
    assert store.attempt_folder(snapshot).joinpath("source.pdf").read_bytes() == b"%PDF-1.7\nfixture"
    assert bridge.describe({**snapshot["config"], "source_path": str(store.attempt_folder(snapshot) / "source.pdf")},
                           bridge.JOBS)["fingerprint"] == snapshot["fingerprint"]
    assert all("secret-fixture" not in path.read_text() for path in store.records.glob("*.json"))


@pytest.mark.parametrize("changes", [
    {"base_url": "https://user:password@example.com"},
    {"base_url": "https://example.com?api_key=secret"},
    {"capabilities": {"api_key": "another-secret"}},
    {"capabilities": {"custom": "secret-fixture"}},
    {"pages": "3-1"}, {"pages": "0"}, {"profile": "unknown"},
])
def test_secret_configuration_is_not_persisted(store, tmp_path, changes):
    """Prevent credential-bearing configuration from entering records or cache identity."""
    with pytest.raises(ValueError):
        store.submit(request(tmp_path, **changes))
    assert store.list_jobs() == []
    assert not list(store.records.glob("*.json"))


def test_atomic_record_failure_preserves_last_record(tmp_path, monkeypatch):
    """A failed replace leaves valid prior JSON and no half-written public record."""
    path = tmp_path / "record.json"
    bridge.atomic_json(path, {"value": "prior"})
    def fail_replace(*args):
        """Simulate a filesystem replacement failure."""
        raise OSError("replace failed")
    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError):
        bridge.atomic_json(path, {"value": "next"})
    assert json.loads(path.read_text()) == {"value": "prior"}
    assert not (tmp_path / "record.json.tmp").exists()


def test_cancel_escalates_to_kill(store, tmp_path, monkeypatch):
    """Cancellation never waits indefinitely for a process ignoring termination."""
    job = store.submit(request(tmp_path))
    operations = []
    class Process:
        def poll(self):
            """Simulate a currently running engine."""
            return None
        def terminate(self):
            """Record the initial graceful termination request."""
            operations.append("terminate")
        def kill(self):
            """Record forced termination."""
            operations.append("kill")
        def wait(self, timeout):
            """Ignore graceful termination, then honor a forced kill."""
            assert timeout == bridge.STOP_TIMEOUT
            operations.append("wait")
            if "kill" not in operations:
                raise subprocess.TimeoutExpired("engine", timeout)
            return -9
    store.jobs[job["id"]]["state"] = "running"
    store.processes[job["id"]] = Process()
    assert store.cancel(job["id"])["state"] == "cancelled"
    assert operations == ["terminate", "wait", "kill", "wait"]


def test_http_list_get_cancel_and_explicit_retry(store, tmp_path):
    """Exercise the public queue/retry contract through authenticated HTTP."""
    server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
    server.token, server.store = "test-token", store
    threading.Thread(target=server.serve_forever, daemon=True).start()
    def call(path, data=None):
        """Perform an authenticated JSON operation against the local test service."""
        body = None if data is None else json.dumps(data).encode()
        message = urllib.request.Request(f"http://127.0.0.1:{server.server_port}" + path, data=body,
                                         headers={"Authorization": "Bearer test-token"})
        with urllib.request.urlopen(message) as response:
            return response.status, json.load(response)
    try:
        status, job = call("/jobs", request(tmp_path))
        assert status == 202
        assert call("/jobs")[1]["jobs"][0]["id"] == job["id"]
        assert call("/jobs/" + job["id"])[1]["config"]["profile"] == "deepseek"
        assert call("/jobs/" + job["id"] + "/cancel", {})[1]["state"] == "cancelled"
        with pytest.raises(urllib.error.HTTPError) as error:
            call("/jobs/" + job["id"] + "/retry", {})
        assert error.value.code == 400
        status, retry = call("/jobs/" + job["id"] + "/retry", {"api_key": "fresh-key"})
        assert status == 202 and retry["id"] != job["id"]
        assert retry["retry_warning"]
        assert len(call("/jobs")[1]["jobs"]) == 2
    finally:
        server.shutdown()
        server.server_close()


def test_real_worker_serializes_and_ignores_lifecycle_events(running_store, tmp_path):
    """Real pipe I/O cannot bypass serial scheduling or overwrite authoritative state."""
    first = running_store.submit(request(tmp_path, model="blocked"))
    second = running_store.submit(request(tmp_path, model="next"))
    folder = running_store.attempt_folder(first)
    wait_for(lambda: (folder / "started").exists())
    wait_for(lambda: running_store.snapshot(first["id"])["phase"] == "translating")
    assert running_store.snapshot(first["id"])["counts"] == {"total": 2, "success": 1}
    assert running_store.snapshot(first["id"])["state"] == "running"
    assert running_store.snapshot(second["id"])["state"] == "queued"
    assert not running_store.attempt_folder(second).joinpath("started").exists()
    (folder / "release").touch()
    wait_for(lambda: running_store.snapshot(second["id"])["state"] == "done")
    for job in (first, second):
        snapshot = running_store.snapshot(job["id"])
        assert snapshot["state"] == "done" and snapshot["save_state"] == "engine_produced"
        assert snapshot["usage"]["input_tokens"] == 12
        assert "secret-fixture" not in json.dumps(snapshot)
        assert Path(snapshot["manifest_path"]).is_file()
        assert "secret-fixture" not in (running_store.records / (job["id"] + ".json")).read_text()


def test_running_cancel_releases_serial_queue(running_store, tmp_path):
    """Cancelling a running subprocess lets the next queued paper finish."""
    first = running_store.submit(request(tmp_path, model="blocked"))
    second = running_store.submit(request(tmp_path, model="next"))
    wait_for(lambda: running_store.attempt_folder(first).joinpath("started").exists())
    assert running_store.cancel(first["id"])["state"] == "cancelled"
    wait_for(lambda: running_store.snapshot(second["id"])["state"] == "done")
    assert first["id"] not in running_store.processes
    assert (bridge.JOBS / first["fingerprint"] / "source.pdf").is_file()


def test_launch_failure_is_persisted_without_stalling_queue(store, tmp_path, monkeypatch):
    """A failed process launch is a terminal attempt, not a permanently running job."""
    job = store.submit(request(tmp_path))
    def fail_launch(*args, **kwargs):
        """Simulate an unavailable interpreter without invoking a provider."""
        raise OSError("Cannot launch secret-fixture")
    monkeypatch.setattr(bridge.subprocess, "Popen", fail_launch)
    store.run(job["id"], store.attempt_folder(job), job["config"], "secret-fixture")
    result = store.snapshot(job["id"])
    assert result["state"] == result["attempts"][-1]["state"] == "failed"
    assert result["error"] == "Cannot launch [REDACTED]"
    assert store.processes == store.workers == {}
    assert json.loads((store.records / (job["id"] + ".json")).read_text())["state"] == "failed"


def test_shared_identity_includes_profile_and_capabilities(store, tmp_path):
    """Server and cache description use the same provider-aware identity."""
    default = store.submit(request(tmp_path))
    variants = [store.submit(request(tmp_path, capabilities={"json_mode": False})),
                store.submit(request(tmp_path, profile="compatible", model="deepseek-flash",
                                     base_url="https://api.deepseek.com"))]
    assert len({job["fingerprint"] for job in (default, *variants)}) == 3
    canonical = store.submit(request(tmp_path, base_url="https://API.DeepSeek.com:443/v1/"))
    assert canonical["id"] == default["id"]


def test_usage_uncertainty_gauges_can_resolve(store, tmp_path):
    """Resolved responses clear in-flight uncertainty without erasing observed tokens."""
    job = store.submit(request(tmp_path))
    path = store.attempt_folder(job) / "usage.json"
    path.write_text('{"api_requests":1,"unknown_usage_requests":1,"in_flight_requests":1,"billing_uncertain":true}')
    assert store.snapshot(job["id"])["usage"]["billing_uncertain"]
    path.write_text('{"api_requests":1,"input_tokens":20,"unknown_usage_requests":0,"in_flight_requests":0,"billing_uncertain":false}')
    result = store.snapshot(job["id"])
    assert result["usage"]["input_tokens"] == 20
    assert not result["usage"]["billing_uncertain"]
    assert result["usage"]["in_flight_requests"] == result["usage"]["unknown_usage_requests"] == 0


@pytest.mark.parametrize("running", [False, True])
def test_cancel_still_stops_when_record_persistence_fails(store, tmp_path, monkeypatch, running):
    """Disk failures cannot strand queued work or prevent a running engine from stopping."""
    job = store.submit(request(tmp_path))
    stopped = []
    process = object()
    if running:
        store.jobs[job["id"]]["state"] = "running"
        store.processes[job["id"]] = process
        monkeypatch.setattr(store, "stop_process", lambda value: stopped.append(value) or True)
    def fail_persist(*args):
        """Fail both cancellation record writes, as a full disk would."""
        raise OSError("disk full")
    with monkeypatch.context() as patch:
        patch.setattr(store, "persist", fail_persist)
        with pytest.warns(UserWarning, match="disk full"):
            result = store.cancel(job["id"])
    assert result["state"] == result["attempts"][-1]["state"] == "cancelled"
    assert "disk full" in result["error"]
    assert stopped == ([process] if running else [])
    assert job["id"] not in store.processes
    retry = store.retry(job["id"], {"api_key": "fresh-key"})
    assert retry["state"] == "queued" and retry["id"] != job["id"]


def test_retry_persistence_failure_never_enqueues_or_mutates_original(store, tmp_path, monkeypatch):
    """An unwritable retry record leaves the original job recoverable and unscheduled."""
    job = store.submit(request(tmp_path))
    original = store.cancel(job["id"])
    scheduled = []
    monkeypatch.setattr(store.pool, "submit", lambda *args: scheduled.append(args))
    def fail_persist(*args):
        """Fail before the new retry becomes visible or reaches the executor."""
        raise OSError("disk full")
    with monkeypatch.context() as patch:
        patch.setattr(store, "persist", fail_persist)
        with pytest.raises(OSError, match="disk full"):
            store.retry(job["id"], {"api_key": "fresh-key"})
    assert scheduled == []
    assert store.list_jobs() == [original]
    assert len(list(store.records.glob("*.json"))) == 1
    retry = store.retry(job["id"], {"api_key": "fresh-key"})
    assert retry["state"] == "queued" and len(scheduled) == 1
