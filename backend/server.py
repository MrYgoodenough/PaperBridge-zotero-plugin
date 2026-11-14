"""Authenticated loopback bridge. Files, jobs and caches stay in this project."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import shutil
import subprocess
import sys
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit
import warnings
from library_cache import ENGINE_VERSION, describe, normalize_config, prune
from errors import explain_error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Project-local paths keep the bridge isolated from other Python applications.
ROOT = Path(__file__).resolve().parents[1]
# A caller-selected state directory also supports packaged installations.
RUNTIME = Path(os.environ.get("PAPERBRIDGE_STATE_DIR",ROOT / ".runtime"))
# Durable records and immutable artifact folders share the existing cache root.
JOBS = RUNTIME / "jobs"
# Public plugin version.
VERSION = "0.3.4"
# Independently versioned on-disk records.
RECORD_VERSION = 1
# Active attempts must never restart automatically after losing their worker.
ACTIVE_STATES = {"queued", "running", "cancelling"}
# Only these numeric counters belong in public summaries, not request bodies.
USAGE_FIELDS = ("api_requests", "input_tokens", "cached_input_tokens", "uncached_input_tokens",
                "output_tokens", "local_cache_hits", "paragraph_cache_hits")
# These observed gauges may decrease after an in-flight request returns.
USAGE_GAUGES = ("failed_requests", "in_flight_requests", "unknown_usage_requests")
# Bound cancellation and retained diagnostic text without adding a scheduler.
STOP_TIMEOUT = 5
# Maximum diagnostic characters exposed by a job.
ERROR_LIMIT = 4000
# Only explicit quality evidence permits an output to become the current result.
USABLE_QUALITIES = {"complete", "partial"}
# Explicit retries may repeat charges even when the previous response was lost.
RETRY_WARNING = "重试可能重复计费；未收到响应的请求也可能已收费。"
# Only engine progress data, never lifecycle or ownership fields, may cross stdout.
PROGRESS_PHASES = {"preparing", "parsing", "translating", "typesetting", "restoring", "finished"}
# Live counters use the existing quality evidence vocabulary.
QUALITY_COUNTS = {"total", "success", "cache", "skipped", "failed", "unknown", "unresolved",
                  "attempts", "cache_hits", "fallbacks", "failure_events"}


def timestamp():
    """Return a portable UTC timestamp for persisted attempt records."""
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    """Replace a small JSON record without exposing a half-written file."""
    temporary = path.with_name(path.name + ".tmp")
    try:
        with open(temporary, "w", encoding="utf-8",
                  opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_copy(source, destination):
    """Flush a source snapshot or result before atomically publishing its name."""
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        with source.open("rb") as incoming, temporary.open("wb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def redact(value, key):
    """Remove credentials from engine diagnostics and structured quality evidence."""
    if isinstance(value, str):
        for secret in (key, quote(key, safe="")):
            if secret:
                value = value.replace(secret, "[REDACTED]")
        return value
    if isinstance(value, dict):
        return {name: redact(item, key) for name, item in value.items()
                if not re.search(r"key|secret|password|authorization|credential", name, re.I)}
    if isinstance(value, list):
        return [redact(item, key) for item in value]
    return value


def configuration(request, key):
    """Freeze nonsecret provider options; never persist endpoint credentials."""
    config = normalize_config(request)
    for name in ("model", "base_url", "lang_out", "pages"):
        if not isinstance(config[name], str):
            raise ValueError("Invalid " + name)
        config[name] = config[name].strip()
    endpoint = urlsplit(config["base_url"])
    if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username
            or endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError("API 地址必须使用 HTTPS，且不得包含凭据、查询参数或片段")
    if not config["model"] or not config["lang_out"]:
        raise ValueError("Model and output language are required")
    pages = config["pages"]
    if pages and not re.fullmatch(r"\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*", pages):
        raise ValueError("页码格式示例：1-3,5")
    for part in pages.split(",") if pages else ():
        limits = [int(page) for page in part.split("-")]
        if limits[0] < 1 or limits[-1] < limits[0]:
            raise ValueError("Invalid page range")
    capabilities = config["capabilities"]
    if not isinstance(capabilities, dict) or redact(capabilities, key) != capabilities:
        raise ValueError("Capabilities must be a nonsecret object")
    encoded = json.dumps(config, allow_nan=False)
    if key in encoded or quote(key, safe="") in encoded:
        raise ValueError("Credentials must not appear in job configuration")
    return config


def read_json(path):
    """Treat missing or incomplete sidecars as unknown, not a bridge failure."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def pdf_present(path):
    """Check the existing PDF signature before considering an artifact reusable."""
    try:
        with path.open("rb") as stream:
            return stream.read(5) == b"%PDF-"
    except OSError:
        return False


def file_hash(path):
    """Hash an artifact without loading a large PDF into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_output(job):
    """Reuse only the exact PDF whose successful outcome was durably recorded."""
    if not job.get("output_path"):
        return False
    checksum = job.get("output_sha256")
    if not checksum and job.get("manifest_path"):
        # Earlier durable jobs kept the same checksum only in their manifest.
        checksum = read_json(Path(job["manifest_path"])).get("output_sha256")
    if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
        return False
    output = Path(job["output_path"])
    try:
        return pdf_present(output) and file_hash(output) == checksum
    except OSError:
        return False


def clean_completed_job(folder):
    """Keep result sidecars and isolated retry history, not intermediate PDFs."""
    for path in folder.iterdir():
        if path.name in {"translated.pdf", "usage.json", "manifest.json", "quality.json", "alignment.json", "identity.json", "attempts"}:
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def parent_running(pid):
    """Check host liveness without Windows' destructive os.kill(pid, 0) behavior."""
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def read_token():
    """Read or create the private loopback authentication token."""
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    path = RUNTIME / "token"
    if not path.exists():
        with open(path, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            stream.write(secrets.token_urlsafe(32))
    return path.read_text().strip()


class JobStore:
    def __init__(self):
        """Load durable jobs without ever replaying a request after restart."""
        JOBS.mkdir(parents=True, exist_ok=True)
        self.jobs = {}
        self.lock = threading.RLock()
        self.processes = {}
        self.workers = {}
        self.records = JOBS / "records"
        self.records.mkdir(exist_ok=True)
        self.closed = False
        self.load_warnings = []
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translate")
        for path in self.records.glob("*.json"):
            record = read_json(path)
            try:
                if (record.get("record_version") != RECORD_VERSION
                        or record["id"] != path.stem
                        or not re.fullmatch(r"[a-f0-9]{32}", record["id"])
                        or not re.fullmatch(r"[a-f0-9]{64}", record["fingerprint"])
                        or not isinstance(record["attempts"], list) or not record["attempts"]
                        or any(not isinstance(attempt, dict) for attempt in record["attempts"])
                        or not isinstance(record.get("created_at"), str)):
                    raise ValueError("Invalid job record")
                self.jobs[record["id"]] = record
                self.refresh_usage(record)
                if record["state"] in {"queued", "running", "interrupted"} and self.recover_output(record):
                    continue
                if record["state"] in ACTIVE_STATES:
                    record.update(state="interrupted", stage="任务已中断，请确认后重试",
                                  error="Bridge stopped before this attempt finished")
                    record["attempts"][-1].update(state="interrupted", finished_at=timestamp(),
                                                   error=record["error"])
                    self.persist(record)
            except (KeyError, TypeError, ValueError, OSError, AttributeError) as error:
                self.jobs.pop(path.stem, None)
                message = f"Cannot load job {path.name}: {error}"
                self.load_warnings.append(message)
                warnings.warn(message)

    def recover_output(self, job):
        """Finalize verified local evidence after interruption, without running an engine."""
        if job["state"] not in {"queued", "running", "interrupted"} or job["id"] in self.workers:
            return False
        attempt = job["attempts"][-1]
        folder = self.attempt_folder(job, attempt)
        quality = read_json(folder / "quality.json")
        output = folder / "translated.pdf"
        if quality.get("status") not in USABLE_QUALITIES or not pdf_present(output):
            return False
        manifest = read_json(folder / "manifest.json")
        checksum = attempt.get("output_sha256") or manifest.get("output_sha256")
        if checksum and file_hash(output) != checksum:
            return False
        if manifest.get("job_id", attempt["job_id"]) != attempt["job_id"]:
            return False
        if manifest.get("document_key", job["document_key"]) != job["document_key"]:
            return False
        # Use the normal finalization path; recovery is not a second result system.
        try:
            job["recovered_locally"] = True
            self.finish(job, folder, 0, "", "")
        except OSError as error:
            warnings.warn(f"Recovered PDF remains available, but metadata could not be saved: {error}")
        return job["state"] == "done"

    def recover(self, job_id):
        """Recheck an interrupted attempt's retained PDF on an explicit local request."""
        with self.lock:
            self.recover_output(self.jobs[job_id])
            return self.snapshot(job_id)

    def attempt_folder(self, job, attempt=None):
        """Use short immutable paths for new attempts, retaining the legacy layout."""
        attempt = attempt or job["attempts"][-1]
        # A UUID already identifies the attempt; nesting a SHA-256 exceeds Windows MAX_PATH.
        root = JOBS if attempt.get("layout") == "flat" else JOBS / job["fingerprint"]
        return root / "attempts" / f'{attempt["job_id"]}-{attempt["number"]}'

    def persist(self, job):
        """Atomically commit a credential-free job and its attempt history."""
        job["updated_at"] = timestamp()
        atomic_json(self.records / (job["id"] + ".json"), job)

    def refresh_usage(self, job):
        """Merge observed counters without erasing history after cache cleanup."""
        for attempt in job["attempts"]:
            data = read_json(self.attempt_folder(job, attempt) / "usage.json")
            usage = attempt.setdefault("usage", {})
            for name in USAGE_FIELDS:
                value = data.get(name, 0)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    usage[name] = max(usage.get(name, 0), value)
            for name in USAGE_GAUGES:
                if type(data.get(name)) is int and data[name] >= 0:
                    usage[name] = data[name]
            for name in ("billing_uncertain", "token_totals_are_partial", "cache_usage_complete"):
                if type(data.get(name)) is bool:
                    usage[name] = data[name]
        job["usage"] = {name: sum(attempt["usage"].get(name, 0) for attempt in job["attempts"])
                        for name in (*USAGE_FIELDS, *USAGE_GAUGES)}
        for name in ("billing_uncertain", "token_totals_are_partial"):
            job["usage"][name] = any(attempt["usage"].get(name, False) for attempt in job["attempts"])
        job["usage"]["cache_usage_complete"] = all(
            attempt["usage"].get("cache_usage_complete", False) for attempt in job["attempts"])

    def queue(self, job, key):
        """Publish the source and attempt record before handing work to the serial pool."""
        number = len(job["attempts"]) + 1
        attempt = {"number": number, "job_id": job["id"], "state": "queued", "created_at": timestamp(),
                   "started_at": None, "finished_at": None, "quality": {"status": "unknown"},
                   "output_path": None, "usage": {}, "error": None, "layout": "flat"}
        folder = self.attempt_folder(job, attempt)
        folder.mkdir(parents=True, exist_ok=True)
        # Ownership must survive cancellation and stay independent of engine manifests.
        atomic_json(folder / "identity.json", {name: job[name] for name in ("fingerprint", "document_key")})
        atomic_copy(JOBS / job["fingerprint"] / "source.pdf", folder / "source.pdf")
        job["attempts"].append(attempt)
        job.update(state="queued", progress=0, phase="preparing", counts={}, stage="排队中", error=None,
                   error_code=None, error_hint=None, cached=False)
        self.refresh_usage(job)
        self.persist(job)
        self.jobs[job["id"]] = job
        try:
            self.pool.submit(self.run, job["id"], folder, deepcopy(job["config"]), key)
        except RuntimeError as error:
            message = redact(str(error), key)
            attempt.update(state="failed", error=message, finished_at=timestamp())
            job.update(state="failed", error=message, stage="无法启动任务")
            self.persist(job)

    def submit(self, request):
        """Snapshot the source and share only exact active or verified complete jobs."""
        source = Path(request["source_path"]).resolve()
        if not source.is_file() or source.suffix.lower() != ".pdf":
            raise ValueError("请选择本地 PDF 附件")
        key = request.get("api_key", "")
        if not isinstance(key, str):
            raise ValueError("Invalid API Key")
        key = key.strip()
        if not key:
            raise ValueError("请先设置 API Key")
        settings = configuration(request, key)
        job_id = uuid.uuid4().hex
        snapshot = JOBS / (".source-" + job_id + ".pdf")
        try:
            atomic_copy(source, snapshot)
            if not pdf_present(snapshot):
                raise ValueError("附件不是有效的 PDF 文件")
            # The cache owner supplies the one shared source/config fingerprint algorithm.
            identity = describe({**settings, "source_path": str(snapshot)}, JOBS)
            with self.lock:
                if self.closed:
                    raise ValueError("Bridge is shutting down")
                for existing in self.jobs.values():
                    if (existing["fingerprint"] != identity["fingerprint"]
                            or existing["document_key"] != identity["document_key"]
                            or existing["config"] != settings):
                        continue
                    complete = (existing["state"] == "done"
                                and existing["quality"].get("status") == "complete"
                                and verified_output(existing))
                    if existing["state"] in ACTIVE_STATES or complete:
                        result = self.snapshot(existing["id"])
                        result["cached"] = bool(complete)
                        return result
                folder = JOBS / identity["fingerprint"]
                folder.mkdir(exist_ok=True)
                snapshot.replace(folder / "source.pdf")
                job = {"record_version": RECORD_VERSION, "id": job_id, "root_job_id": job_id,
                       "previous_job_id": None, **identity,
                       "config": settings, "model": settings["model"], "lang_out": settings["lang_out"],
                       "quality": {"status": "unknown"}, "output_path": None, "save_state": None,
                       "attempts": [], "created_at": timestamp(), "retry_warning": RETRY_WARNING}
                self.queue(job, key)
                return self.snapshot(job_id)
        finally:
            snapshot.unlink(missing_ok=True)

    def snapshot(self, job_id):
        """Return a detached public view, including cumulative and per-attempt usage."""
        with self.lock:
            job = self.jobs[job_id]
            self.refresh_usage(job)
            result = deepcopy(job)
            result["output_available"] = bool(job.get("output_path") and pdf_present(Path(job["output_path"])))
            return result

    def list_jobs(self):
        """List durable jobs in submission order for restoring the queue UI."""
        with self.lock:
            return [self.snapshot(job["id"]) for job in
                    sorted(self.jobs.values(), key=lambda item: item["created_at"])]

    def retry(self, job_id, request):
        """Retry only an explicit request with a freshly supplied in-memory credential."""
        key = request.get("api_key", "")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("重试必须重新提供 API Key；" + RETRY_WARNING)
        with self.lock:
            job = self.jobs[job_id]
            if self.closed or job["state"] in ACTIVE_STATES:
                raise ValueError("任务仍在运行或服务正在退出")
            for active in self.jobs.values():
                if (active["state"] in ACTIVE_STATES and active["fingerprint"] == job["fingerprint"]
                        and active["config"] == job["config"]):
                    return self.snapshot(active["id"])
            source = JOBS / job["fingerprint"] / "source.pdf"
            if not pdf_present(source) or file_hash(source) != job["document_key"]:
                raise ValueError("任务源文件快照已清理或损坏，请重新提交附件")
            self.refresh_usage(job)
            retry = deepcopy(job)
            retry.update(id=uuid.uuid4().hex, previous_job_id=job_id, created_at=timestamp())
            self.queue(retry, key.strip())
            return self.snapshot(retry["id"])

    def stop_process(self, process):
        """Bound graceful cancellation and escalate to a forced kill when needed."""
        try:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=STOP_TIMEOUT)
            return True
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                process.wait(timeout=STOP_TIMEOUT)
                return True
            except (OSError, subprocess.TimeoutExpired):
                return False
        except OSError:
            return process.poll() is not None

    def cancel(self, job_id):
        """Cancel queued work immediately and wait a bounded time for a running attempt."""
        persistence_error = None

        def save_cancellation(job):
            """Report disk failures without preventing an already requested engine stop."""
            nonlocal persistence_error
            try:
                self.persist(job)
            except OSError as error:
                persistence_error = "取消已继续，但任务状态无法写入磁盘：" + str(error)
                job["error"] = persistence_error
                job["attempts"][-1]["error"] = persistence_error
                warnings.warn(persistence_error)

        with self.lock:
            job = self.jobs[job_id]
            if job["state"] not in ACTIVE_STATES:
                return self.snapshot(job_id)
            process = self.processes.get(job_id)
            worker = self.workers.get(job_id)
            job.update(state="cancelling", stage="正在取消")
            job["attempts"][-1]["state"] = "cancelling"
            save_cancellation(job)
        stopped = not process or self.stop_process(process)
        settled = not worker or worker.wait(timeout=STOP_TIMEOUT)
        with self.lock:
            if stopped and settled:
                self.refresh_usage(job)
                job.update(state="cancelled", stage="已取消")
                job["attempts"][-1].update(state="cancelled", finished_at=timestamp())
                self.processes.pop(job_id, None)
                if persistence_error:
                    job["error"] = job["attempts"][-1]["error"] = persistence_error
                save_cancellation(job)
            return self.snapshot(job_id)

    def run(self, job_id, folder, settings, key):
        """Run one isolated engine and accept quality evidence, never PDF existence alone."""
        process = None
        diagnostic = ""
        code = None
        readers = []
        try:
            with self.lock:
                job = self.jobs[job_id]
                # A cancelled queue entry may still be delivered by ThreadPoolExecutor.
                if job["state"] != "queued" or folder != self.attempt_folder(job):
                    return
                self.workers[job_id] = threading.Event()
                job.update(state="running", stage="准备内置排版引擎与宋体")
                job["attempts"][-1].update(state="running", started_at=timestamp())
                self.persist(job)
                env = os.environ.copy()
                for name in ("PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "LD_PRELOAD"):
                    env.pop(name, None)
                cache = Path(env.get("PAPERBRIDGE_CACHE_DIR", ROOT / ".cache"))
                env.update(TMPDIR=str(folder / "tmp"), PAPERBRIDGE_JOB_TMP=str(folder / "tmp"),
                           XDG_CACHE_HOME=str(cache), HF_HOME=str(cache / "huggingface"),
                           TORCH_HOME=str(cache / "torch"), MPLCONFIGDIR=str(cache / "matplotlib"))
                (folder / "tmp").mkdir(exist_ok=True)
                process = subprocess.Popen([sys.executable, "-X", "utf8", "-I", "-S", "-B", "-u",
                                            str(ROOT / "backend/launcher.py"), "engine.py"],
                                           cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                           encoding="utf-8", errors="replace")
                self.processes[job_id] = process

            def drain_errors():
                """Bound stderr while retaining only redacted diagnostic text."""
                nonlocal diagnostic
                for line in process.stderr:
                    diagnostic = (diagnostic + redact(line, key))[-ERROR_LIMIT:]

            def drain_progress():
                """Accept progress only; the engine cannot overwrite lifecycle fields."""
                for line in process.stdout:
                    if not line.startswith("PB:"):
                        continue
                    try:
                        event = json.loads(line[3:])
                        if not isinstance(event, dict):
                            continue
                        with self.lock:
                            if job["state"] != "running" or self.processes.get(job_id) is not process:
                                continue
                            if isinstance(event.get("stage"), str):
                                job["stage"] = redact(event["stage"], key)[:ERROR_LIMIT]
                            progress = event.get("progress")
                            if type(progress) in (int, float) and 0 <= progress <= 100:
                                job["progress"] = min(99, progress)
                            if isinstance(event.get("phase"), str) and event["phase"] in PROGRESS_PHASES:
                                job["phase"] = event["phase"]
                            if isinstance(event.get("counts"), dict):
                                job["counts"] = {name: value for name, value in event["counts"].items()
                                                 if name in QUALITY_COUNTS and type(value) is int and value >= 0}
                            self.persist(job)
                    except (ValueError, OSError):
                        continue

            for target in (drain_errors, drain_progress):
                thread = threading.Thread(target=target, daemon=True)
                thread.start()
                readers.append(thread)
            payload = {**settings, "api_key": key, "folder": str(folder),
                       "document_key": job["document_key"], "fingerprint": job["fingerprint"]}
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.close()
            code = process.wait()
        except Exception as error:
            diagnostic = redact(str(error), key)[-ERROR_LIMIT:]
            if process:
                self.stop_process(process)
        finally:
            for thread in readers:
                thread.join(timeout=STOP_TIMEOUT)
            with self.lock:
                # A stale queued call must not finalize a newer retry's attempt.
                if job_id in self.workers and folder == self.attempt_folder(self.jobs[job_id]):
                    job = self.jobs[job_id]
                    try:
                        self.finish(job, folder, code, diagnostic, key)
                    except OSError as error:
                        state = "cancelled" if job["state"] in {"cancelling", "cancelled"} else "failed"
                        job.update(state=state, stage="无法保存任务记录", error=redact(str(error), key))
                        job["attempts"][-1].update(state=state, error=job["error"], finished_at=timestamp())
                        # The manifest directory can fail while the separate record directory still works.
                        try:
                            self.persist(job)
                        except OSError:
                            pass
                        warnings.warn("Could not persist finished job: " + job["error"])
                    finally:
                        self.processes.pop(job_id, None)
                        self.workers.pop(job_id).set()

    def finish(self, job, folder, code, diagnostic, key):
        """Record this attempt while keeping an earlier usable result on failed replacement."""
        attempt = job["attempts"][-1]
        self.refresh_usage(job)
        quality = redact(read_json(folder / "quality.json"), key)
        # Detailed paragraph evidence remains in its sidecar, not every list response.
        quality.pop("paragraphs", None)
        if quality.get("status") not in USABLE_QUALITIES | {"unusable", "unknown"}:
            quality["status"] = "unknown"
        output = folder / "translated.pdf"
        present = pdf_present(output)
        if not present:
            quality = {**quality, "status": "unusable", "reason": "Engine did not produce a PDF"}
        attempt.update(quality=quality, output_path=str(output) if present else None,
                       output_sha256=file_hash(output) if present else None,
                       finished_at=timestamp())
        # The bridge adds provenance when an engine version has no manifest writer.
        if not (folder / "manifest.json").is_file():
            manifest = {"schema_version": RECORD_VERSION, "engine": ENGINE_VERSION,
                        "job_id": job["id"], "attempt": attempt["number"],
                        "fingerprint": job["fingerprint"], "document_key": job["document_key"],
                        "config": job["config"], "quality": quality, "usage": attempt["usage"],
                        "output_sha256": attempt["output_sha256"],
                        "finished_at": attempt["finished_at"]}
            atomic_json(folder / "manifest.json", manifest)
        for name in ("quality", "manifest", "alignment"):
            if (folder / (name + ".json")).is_file():
                attempt[name + "_path"] = str(folder / (name + ".json"))
        if job["state"] == "cancelling":
            state, stage, error = "cancelled", "已取消", None
        elif code == 0 and present and quality["status"] in USABLE_QUALITIES:
            state = "done"
            stage = "翻译完成" if quality["status"] == "complete" else "部分翻译可用，请检查结果"
            error = None
            # Keep the established cache lookup path, but history points to immutable attempts.
            try:
                atomic_copy(output, JOBS / job["fingerprint"] / "translated.pdf")
            except OSError as copy_error:
                warnings.warn(f"Could not publish cache alias; attempt PDF remains usable: {copy_error}")
            job.update(output_path=str(output), quality=quality, output_attempt=attempt["number"],
                       output_sha256=attempt["output_sha256"], save_state="engine_produced", progress=100)
            for name in ("quality_path", "manifest_path", "alignment_path"):
                job[name] = attempt.get(name)
        else:
            state, stage = "failed", "翻译失败或结果质量未确认"
            error = redact(diagnostic, key) or "引擎未确认译文可用；请检查质量记录后决定是否重试"
        if not job.get("output_path"):
            job["quality"] = quality
        guidance = explain_error(error) if error else {"code": None, "hint": None}
        attempt.update(state=state, error=error, error_code=guidance["code"], error_hint=guidance["hint"])
        job.update(state=state, stage=stage, error=error, error_code=guidance["code"],
                   error_hint=guidance["hint"], phase="finished")
        if isinstance(quality.get("counts"), dict):
            job["counts"] = {name: value for name, value in quality["counts"].items()
                             if name in QUALITY_COUNTS and type(value) is int and value >= 0}
        self.persist(job)
        if state == "done":
            try:
                clean_completed_job(folder)
            except OSError as error:
                warnings.warn(f"Could not remove intermediate files: {error}")

    def prune_library(self, request):
        """Cancel removed owners' work before pruning, while protecting live workers."""
        keep = {r["fingerprint"] for r in request["keep"] if r.get("fingerprint")}
        removed = {r["fingerprint"] for r in request["remove"] if r.get("fingerprint")} - keep
        with self.lock:
            cancelled = [job["id"] for job in self.jobs.values()
                         if job["fingerprint"] in removed and job["state"] in ACTIVE_STATES]
        for job_id in cancelled:
            self.cancel(job_id)
        with self.lock:
            for job in self.jobs.values():
                self.refresh_usage(job)
                self.persist(job)
            active = [j for j in self.jobs.values() if j["state"] in ACTIVE_STATES or j["id"] in self.workers]
            keep_refs = [*request["keep"],*({"fingerprint":j["fingerprint"],"document_key":j["document_key"],
                                          "model":j["model"],"lang_out":j["lang_out"]} for j in active)]
            cache = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR", ROOT / ".cache"))
            return prune(cache,JOBS,request["remove"],keep_refs,request.get("sweep",False))

    def shutdown(self):
        """Stop accepting work and bound cancellation without replaying queued attempts."""
        with self.lock:
            self.closed = True
            job_ids = list(self.jobs)
        for job_id in job_ids:
            self.cancel(job_id)
        self.pool.shutdown(wait=False, cancel_futures=True)


class Handler(BaseHTTPRequestHandler):
    # Preserve the existing service identity for local clients.
    server_version = "PaperBridge/" + VERSION

    def log_message(self, *_):
        """Do not log authenticated request metadata."""
        pass

    def respond(self, code, value):
        """Send an uncached JSON response to the authenticated loopback client."""
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit=16384):
        """Read one bounded JSON object, rejecting invalid input without a traceback."""
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= limit:
            raise ValueError("Invalid request size")
        value = json.loads(self.rfile.read(size))
        if not isinstance(value, dict):
            raise ValueError("Request must be a JSON object")
        return value

    def dispatch(self):
        """Route authenticated cache and durable-job operations without enabling CORS."""
        # No CORS. A web page must not control the local filesystem bridge.
        if self.headers.get("Origin") or self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            return self.respond(403, {"error": "Forbidden origin or host"})
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            return self.respond(401, {"error": "Invalid token"})
        path = self.path.split("?")[0]
        try:
            if self.command == "GET" and path == "/health":
                return self.respond(200, {"version": VERSION, "root": str(ROOT), "engine": "BabelDOC 0.6.4", "python":sys.executable,
                    "warning_count": len(getattr(self.server.store, "load_warnings", []))})
            if self.command == "GET" and path == "/jobs":
                return self.respond(200, {"jobs": self.server.store.list_jobs()})
            if self.command == "POST" and path == "/diagnostics":
                from diagnostics import create_bundle
                self.body()
                return self.respond(200, {"path": str(create_bundle(self.server.store, RUNTIME))})
            if self.command == "POST" and path == "/alignment/validate":
                from alignment import load_mapping
                data = self.body()
                # This validates local evidence only; it never submits or retries a model job.
                return self.respond(200, load_mapping(data.get("mapping_path"), data.get("source_path"), data.get("output_path")))
            if self.command == "POST" and path in {"/cache/describe","/cache/prune"}:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024 * 1024:
                    return self.respond(413, {"error":"Invalid cache request size"})
                data = self.body(8 * 1024 * 1024)
                result = describe(data,JOBS) if path.endswith("describe") else self.server.store.prune_library(data)
                return self.respond(200,result)
            if self.command == "POST" and path == "/jobs":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16384:
                    return self.respond(413, {"error": "Invalid request size"})
                return self.respond(202, self.server.store.submit(self.body()))
            match = re.fullmatch(r"/jobs/([a-f0-9]{32})(/cancel|/retry|/recover)?", path)
            if match and self.command == "GET" and not match[2]:
                return self.respond(200, self.server.store.snapshot(match[1]))
            if match and self.command == "POST" and match[2] == "/retry":
                return self.respond(202, self.server.store.retry(match[1], self.body()))
            if match and self.command == "POST" and match[2] == "/cancel":
                return self.respond(200, self.server.store.cancel(match[1]))
            if match and self.command == "POST" and match[2] == "/recover":
                return self.respond(200, self.server.store.recover(match[1]))
            self.respond(404, {"error": "Unknown endpoint"})
        except KeyError:
            self.respond(404, {"error": "Job or field not found"})
        except (ValueError, TypeError, OSError) as error:
            self.respond(400, explain_error(error))

    do_GET = dispatch
    do_POST = dispatch


def serve(port=0, parent_pid=None):
    """Expose the authenticated bridge and stop its workers when the host exits."""
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.token = read_token()
    server.store = JobStore()
    info = RUNTIME / "service.json"
    info.write_text(json.dumps({"port":server.server_port,"pid":os.getpid(),"version":VERSION}))
    def stop_service(_signal, _frame):
        """Exit through normal worker cleanup on a termination signal."""
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_service)
    if parent_pid:
        def watch_parent():
            """Stop the local service after its owning application exits."""
            while True:
                threading.Event().wait(3)
                if not parent_running(parent_pid):
                    server.shutdown()
                    return
        threading.Thread(target=watch_parent,daemon=True).start()
    print(f"PaperBridge {VERSION}: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.store.shutdown()
        server.server_close()
        info.unlink(missing_ok=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=0)
    parser.add_argument("--parent-pid", type=int)
    arguments = parser.parse_args()
    serve(arguments.port, arguments.parent_pid)
