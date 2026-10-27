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
from library_cache import ENGINE_VERSION, describe, prune
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("PAPERBRIDGE_STATE_DIR",ROOT / ".runtime"))
JOBS = RUNTIME / "jobs"
VERSION = "0.3.1"


def clean_completed_job(folder):
    """Keep one result and its usage record, not intermediate PDF copies."""
    for path in folder.iterdir():
        if path.name in {"translated.pdf", "usage.json"}:
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def parent_running(pid):
    """Report whether the host process is still alive.

    os.kill(pid, 0) checks liveness on POSIX, but on Windows any signal other than the
    console events terminates the target process, so the host must be queried instead.
    """
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
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    path = RUNTIME / "token"
    if not path.exists():
        with open(path, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
            stream.write(secrets.token_urlsafe(32))
    return path.read_text().strip()


class JobStore:
    def __init__(self):
        JOBS.mkdir(parents=True, exist_ok=True)
        for folder in JOBS.iterdir():
            if folder.is_dir() and (folder / "translated.pdf").exists():
                clean_completed_job(folder)
        self.jobs = {}
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="translate")

    def submit(self, request):
        source = Path(request["source_path"]).resolve()
        if not source.is_file() or source.suffix.lower() != ".pdf":
            raise ValueError("请选择本地 PDF 附件")
        with source.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise ValueError("附件不是有效的 PDF 文件")
        key = request.pop("api_key", "").strip()
        if not key:
            raise ValueError("请先设置 DeepSeek API Key")
        pages = request.get("pages", "").strip()
        if pages and not re.fullmatch(r"\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*", pages):
            raise ValueError("页码格式示例：1-3,5")
        settings = {"model": request.get("model", "deepseek-flash"),
                    "base_url": request.get("base_url", "https://api.deepseek.com"),
                    "lang_out": request.get("lang_out", "zh-CN"), "pages": pages,
                    "font": "songti-sc-v1", "engine": ENGINE_VERSION}
        if not settings["base_url"].startswith("https://"):
            raise ValueError("DeepSeek API 地址必须使用 HTTPS")
        digest = hashlib.sha256(source.read_bytes() + json.dumps(settings, sort_keys=True).encode()).hexdigest()
        folder = JOBS / digest
        folder.mkdir(exist_ok=True)
        result = folder / "translated.pdf"
        job_id = uuid.uuid4().hex
        with self.lock:
            active = next((j for j in self.jobs.values() if j.get("fingerprint") == digest
                           and j["state"] in {"queued", "running"}), None)
            if active:
                return self.snapshot(active["id"])
            job = {"id": job_id, "state": "done" if result.exists() else "queued",
                   "progress": 100 if result.exists() else 0, "stage": "已缓存" if result.exists() else "排队中",
                   "output_path": str(result) if result.exists() else None,
                   "cached": result.exists(), "error": None, "cancelled": False, "fingerprint": digest,
                   "document_key":hashlib.sha256(source.read_bytes()).hexdigest(),
                   "model":settings["model"],"lang_out":settings["lang_out"]}
            self.jobs[job_id] = job
            if not result.exists():
                # Copy before queueing so changes to the Zotero attachment cannot change this job.
                (folder / "source.pdf").write_bytes(source.read_bytes())
                self.pool.submit(self.run, job_id, folder, settings, key)
        return self.snapshot(job_id)

    def snapshot(self, job_id):
        with self.lock:
            job=self.jobs[job_id]
            result={k:v for k,v in job.items() if k not in {"process","cancelled"}}
            usage=JOBS / job["fingerprint"] / "usage.json"
            if usage.exists():
                data=json.loads(usage.read_text())
                result["usage"]={k:data.get(k,0) for k in ["api_requests","input_tokens","cached_input_tokens",
                    "uncached_input_tokens","output_tokens","local_cache_hits","paragraph_cache_hits"]}
            return result

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs[job_id]
            if job["state"] in {"done", "failed", "cancelled"}:
                return self.snapshot(job_id)
            job.update(cancelled=True, state="cancelled", stage="已取消")
            if "process" in job and job["process"].poll() is None:
                job["process"].terminate()
        return self.snapshot(job_id)

    def run(self, job_id, folder, settings, key):
        with self.lock:
            job = self.jobs[job_id]
            if job["cancelled"]:
                return
            env = os.environ.copy()
            cache = Path(env.get("PAPERBRIDGE_CACHE_DIR",ROOT / ".cache"))
            env.update(TMPDIR=str(folder / "tmp"), PAPERBRIDGE_JOB_TMP=str(folder / "tmp"), XDG_CACHE_HOME=str(cache),
                       HF_HOME=str(cache / "huggingface"),TORCH_HOME=str(cache / "torch"),
                       MPLCONFIGDIR=str(cache / "matplotlib"))
            (folder / "tmp").mkdir(exist_ok=True)
            process = subprocess.Popen([sys.executable, "-X", "utf8", "-I", "-S", "-B", "-u",
                                        str(ROOT / "backend/launcher.py"), "engine.py"],
                                       cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                       encoding="utf-8", errors="replace")
            job.update(process=process, state="running", stage="准备内置排版引擎与宋体")
        try:
            payload = {**settings, "api_key": key, "folder": str(folder), "document_key":job["document_key"]}
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.close()
            # Drain stderr concurrently so verbose engine logs cannot block stdout.
            logs = []
            def drain():
                for line in process.stderr:
                    logs.append(line.replace(key, "[REDACTED]"))
                    if len(logs) > 60:
                        del logs[0]
            thread = threading.Thread(target=drain, daemon=True)
            thread.start()
            for line in process.stdout:
                if not line.startswith("PB:"):
                    continue
                event = json.loads(line[3:])
                with self.lock:
                    if not job["cancelled"]:
                        job.update(event)
            code = process.wait()
            thread.join(timeout=2)
            with self.lock:
                if job["cancelled"]:
                    job.update(state="cancelled", stage="已取消", output_path=None)
                elif code == 0 and (folder / "translated.pdf").exists():
                    clean_completed_job(folder)
                    job.update(state="done", progress=100, stage="翻译完成", output_path=str(folder / "translated.pdf"))
                else:
                    job.update(state="failed", stage="翻译失败", error="".join(logs)[-4000:] or "翻译引擎未生成 PDF")
        except Exception as error:
            with self.lock:
                job.update(state="failed", stage="翻译失败", error=str(error).replace(key, "[REDACTED]"))
        finally:
            with self.lock:
                job.pop("process", None)

    def prune_library(self, request):
        keep = {r["fingerprint"] for r in request["keep"] if r.get("fingerprint")}
        removed = {r["fingerprint"] for r in request["remove"] if r.get("fingerprint")} - keep
        with self.lock:
            for job in list(self.jobs.values()):
                if job["fingerprint"] in removed and job["state"] in {"queued","running"}:
                    self.cancel(job["id"])
                    process = job.get("process")
                    if process:
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
            active = [j for j in self.jobs.values() if j["state"] in {"queued","running"}]
            keep_refs = [*request["keep"],*({"fingerprint":j["fingerprint"],"document_key":j["document_key"],
                                          "model":j["model"],"lang_out":j["lang_out"]} for j in active)]
            cache = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR", ROOT / ".cache"))
            return prune(cache,JOBS,request["remove"],keep_refs,request.get("sweep",False))


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperBridge/" + VERSION

    def log_message(self, *_):
        pass

    def respond(self, code, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def dispatch(self):
        # No CORS. A web page must not control the local filesystem bridge.
        if self.headers.get("Origin") or self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            return self.respond(403, {"error": "Forbidden origin or host"})
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            return self.respond(401, {"error": "Invalid token"})
        path = self.path.split("?")[0]
        try:
            if self.command == "GET" and path == "/health":
                return self.respond(200, {"version": VERSION, "root": str(ROOT), "engine": "BabelDOC 0.6.4", "python":sys.executable})
            if self.command == "POST" and path in {"/cache/describe","/cache/prune"}:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024 * 1024:
                    return self.respond(413, {"error":"Invalid cache request size"})
                data = json.loads(self.rfile.read(size))
                result = describe(data,JOBS) if path.endswith("describe") else self.server.store.prune_library(data)
                return self.respond(200,result)
            if self.command == "POST" and path == "/jobs":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16384:
                    return self.respond(413, {"error": "Invalid request size"})
                return self.respond(202, self.server.store.submit(json.loads(self.rfile.read(size))))
            match = re.fullmatch(r"/jobs/([a-f0-9]{32})(/cancel)?", path)
            if match and self.command == "GET" and not match[2]:
                return self.respond(200, self.server.store.snapshot(match[1]))
            if match and self.command == "POST" and match[2]:
                return self.respond(200, self.server.store.cancel(match[1]))
            self.respond(404, {"error": "Unknown endpoint"})
        except KeyError:
            self.respond(404, {"error": "Job or field not found"})
        except (ValueError, OSError) as error:
            self.respond(400, {"error": str(error)})

    do_GET = dispatch
    do_POST = dispatch


def serve(port=0, parent_pid=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.token = read_token()
    server.store = JobStore()
    info = RUNTIME / "service.json"
    info.write_text(json.dumps({"port":server.server_port,"pid":os.getpid(),"version":VERSION}))
    def stop_service(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_service)
    if parent_pid:
        def watch_parent():
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
        for job_id in list(server.store.jobs):
            server.store.cancel(job_id)
        server.server_close()
        server.store.pool.shutdown(wait=True, cancel_futures=True)
        info.unlink(missing_ok=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=0)
    parser.add_argument("--parent-pid", type=int)
    arguments = parser.parse_args()
    serve(arguments.port, arguments.parent_pid)
