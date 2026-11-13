"""Verify real BabelDOC layout with synthetic input and simulated provider responses.

Use the project Python and pre-provisioned assets in <output-root>/.cache.
No downloads or real provider calls are allowed; this is not a linguistic quality test.
Artifacts and the UTF-8 JSON report stay in <output-root>/.runtime.
"""
import argparse
import asyncio
from contextlib import ExitStack, contextmanager, redirect_stdout
from functools import partial
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
from types import SimpleNamespace
from unittest.mock import patch

# Infer the checkout independently of the caller's working directory.
ROOT = Path(__file__).resolve().parents[1]
# Distinguish applied simulated translations from unchanged source text.
CJK_MARKER = "离线验证"
# Keep the synthetic title stable for checking the failed translation's retained PDF.
SOURCE_TITLE = "Offline Integration Study"


def configure_paths(output_root, run_root):
    """Localize caches and temporary files before importing any backend dependencies."""
    cache = output_root / ".cache"
    temporary = run_root / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "PAPERBRIDGE_CACHE_DIR": str(cache),
        "XDG_CACHE_HOME": str(cache),
        "HF_HOME": str(cache / "huggingface"),
        "TORCH_HOME": str(cache / "torch"),
        "MPLCONFIGDIR": str(cache / "matplotlib"),
        "TIKTOKEN_CACHE_DIR": str(cache / "babeldoc" / "tiktoken"),
        "DATA_GYM_CACHE_DIR": str(cache / "babeldoc" / "tiktoken"),
        "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary),
        "ORT_DISABLE_TELEMETRY": "1",
    })
    # tempfile may already have cached the OS temporary directory on Windows.
    tempfile.tempdir = str(temporary)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT / "backend"))


@contextmanager
def blocked_network(attempts):
    """Reject Python socket networking, including DNS, but retain asyncio's internal IPC."""
    original_connect = socket.socket.connect
    original_socketpair = socket.socketpair
    internal = threading.local()

    def reject(operation, *args, **kwargs):
        """Record attempted network I/O without performing it or exposing request content."""
        attempts.append({"operation": operation})
        raise OSError(f"Network disabled for offline verification: {operation}")

    def connect(sock, address):
        """Allow loopback only while the standard library constructs a socket pair."""
        if (getattr(internal, "socketpair", False) and isinstance(address, tuple)
                and address[0] in {"127.0.0.1", "::1"}):
            return original_connect(sock, address)
        return reject("connect")

    def socketpair(*args, **kwargs):
        """Preserve Windows asyncio self-pipes without permitting arbitrary loopback HTTP."""
        # BabelDOC also creates event loops in asset-worker threads on Windows.
        internal.socketpair = True
        try:
            return original_socketpair(*args, **kwargs)
        finally:
            internal.socketpair = False

    with ExitStack() as stack:
        stack.enter_context(patch.object(socket.socket, "connect", connect))
        stack.enter_context(patch.object(socket, "socketpair", socketpair))
        for name in ("connect_ex", "sendto", "sendmsg"):
            if hasattr(socket.socket, name):
                stack.enter_context(patch.object(socket.socket, name, partial(reject, name)))
        for name in ("create_connection", "getaddrinfo", "gethostbyname", "gethostbyname_ex", "gethostbyaddr"):
            stack.enter_context(patch.object(socket, name, partial(reject, name)))
        yield


def create_source(path):
    """Generate one small English page without external sample files or fonts."""
    import pymupdf

    with pymupdf.open() as document:
        page = document.new_page()
        # A title and short body remain below the real pipeline's single-batch limits.
        page.insert_text((50, 80), SOURCE_TITLE, fontsize=17)
        remaining = page.insert_textbox(
            (50, 120, 530, 300),
            "This synthetic paper checks task quality accounting in the real layout pipeline. "
            "It is not a test of linguistic translation quality. All provider responses are simulated.",
            fontsize=12,
        )
        assert remaining >= 0, "Synthetic body did not fit on the page"
        document.save(path)


def inspect_pdf(path):
    """Read extracted text and embedded font metadata without assuming OS-specific names."""
    import pymupdf

    fonts = {}
    with pymupdf.open(path) as document:
        text = "".join(page.get_text() for page in document)
        for page in document:
            for xref, extension, kind, name, *_ in page.get_fonts(full=True):
                if xref in fonts:
                    continue
                content = document.extract_font(xref)[3] if xref else b""
                fonts[xref] = {"xref": xref, "name": name, "type": kind,
                               "extension": extension, "embedded": bool(content),
                               "embedded_bytes": len(content)}
        return {"path": str(path), "pages": len(document),
                "cjk_present": any("\u3400" <= character <= "\u9fff" for character in text),
                "marker_present": CJK_MARKER in "".join(text.split()),
                "source_title_present": "".join(SOURCE_TITLE.split()) in "".join(text.split()),
                "fonts": list(fonts.values())}


def run_scenario(mode, folder, report):
    """Exercise the unchanged backend pipeline, mocking only the completion boundary."""
    from deepseek import DeepSeekTranslator
    from engine import translate

    folder.mkdir(parents=True)
    create_source(folder / "source.pdf")
    calls = report["completion_calls"] = []

    def completion(translator, messages):
        """Return changed text without usage, or simulate a lost response without waiting."""
        calls.append({"sdk_max_retries": translator.client.max_retries})
        if mode == "timeout":
            raise TimeoutError("simulated lost response")
        inputs = json.loads(messages[1]["content"])["paragraphs"]
        content = json.dumps({"translations": [
            {"id": row["id"], "text": CJK_MARKER + "：" + row["text"]} for row in inputs
        ]}, ensure_ascii=False)
        return SimpleNamespace(id="offline", usage=None, choices=[SimpleNamespace(
            finish_reason="stop", message=SimpleNamespace(content=content))])

    request = {"folder": str(folder), "api_key": "offline-only", "profile": "compatible",
               # A fresh model namespace prevents old successful cache rows masking a run.
               "model": f"{folder.parent.name}-{mode}", "base_url": "https://example.invalid/v1",
               "lang_out": "zh-CN", "pages": ""}
    with patch.object(DeepSeekTranslator, "request_completion", completion):
        asyncio.run(translate(request))

    quality = json.loads((folder / "quality.json").read_text(encoding="utf-8"))
    usage = json.loads((folder / "usage.json").read_text(encoding="utf-8"))
    report.update(quality=quality["status"], counts=quality["counts"], usage=usage)
    # Opening the PDF is mandatory even on timeout: its existence is not success.
    pdf = report["pdf"] = inspect_pdf(folder / "translated.pdf")
    assert quality["status"] == ("complete" if mode == "success" else "unusable"), quality
    assert quality["finalized"] and quality["artifact_exists"], quality
    assert quality["inventory_observed"] and quality["translation_stage_completed"], quality
    assert quality["engine_error"] is None, quality
    assert len(calls) == 1, f"Expected one completion, observed {len(calls)}: {mode}"
    assert calls[0]["sdk_max_retries"] == 0, calls
    assert all(row["attempts"] <= 1 for row in quality["paragraphs"]), quality
    assert usage["api_requests"] == 1 and len(usage["requests"]) == 1, usage
    assert usage["paragraph_cache_hits"] == 0 and usage["local_cache_hits"] == 0, usage
    assert usage["billing_uncertain"] and usage["token_totals_are_partial"], usage
    assert usage["unknown_usage_requests"] == 1 and usage["in_flight_requests"] == 0, usage
    assert usage["failed_requests"] == int(mode == "timeout"), usage
    entry = usage["requests"][0]
    assert entry["billing"] == "unknown", entry
    assert entry["status"] == ("responded" if mode == "success" else "failed"), entry
    assert all(entry[field] is None for field in (
        "prompt_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "completion_tokens"
    )), entry
    if mode == "success":
        assert pdf["cjk_present"] and pdf["marker_present"], pdf
        assert any(font["embedded"] for font in pdf["fonts"]), pdf
    else:
        assert entry["error_type"] == "TimeoutError", entry
        assert quality["counts"]["failed"] > 0 and quality["counts"]["fallbacks"] > 0, quality
        assert pdf["source_title_present"] and not pdf["marker_present"], pdf
    report["ok"] = True


def main():
    """Run both cases and emit JSON evidence with a nonzero exit code on any failure."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT,
                        help="Test root containing pre-provisioned .cache and generated .runtime (default: checkout)")
    arguments = parser.parse_args()
    if not __debug__:
        parser.error("Run without -O so verification assertions remain enabled.")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    output_root = arguments.output_root.expanduser().resolve()
    runtime = output_root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    run_root = Path(tempfile.mkdtemp(prefix="offline-quality-", dir=runtime))
    report_path = runtime / "offline-quality-report.json"
    result = {"ok": False, "actual_provider_calls": 0, "network_attempts": [], "scenarios": [],
              "provider_responses": "simulated", "linguistic_quality_verified": False,
              "platform": sys.platform, "python": sys.version, "python_executable": sys.executable,
              "output_root": str(output_root), "artifacts_root": str(run_root),
              "cache_root": str(output_root / ".cache"), "report_path": str(report_path)}
    try:
        configure_paths(output_root, run_root)
        # Keep progress off stdout and guard imports as well as the actual pipeline.
        with redirect_stdout(sys.stderr), blocked_network(result["network_attempts"]):
            from engine import localize_cache

            localize_cache()
            for mode in ("success", "timeout"):
                folder = run_root / mode
                scenario = {"scenario": mode, "ok": False, "folder": str(folder)}
                result["scenarios"].append(scenario)
                try:
                    run_scenario(mode, folder, scenario)
                except Exception as error:
                    scenario["error"] = f"{type(error).__name__}: {error}"
        result["ok"] = all(scenario["ok"] for scenario in result["scenarios"]) and not result["network_attempts"]
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
