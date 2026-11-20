"""Probe explicit PDF pages with the real offline BabelDOC CPU formula detector."""
import sys

# Imported backend/runtime files must remain read-only, including bytecode caches.
sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

# Defaults are checkout-relative; explicit paths also support staged/bundled Python.
ROOT = Path(__file__).resolve().parents[1]
# This probe measures the existing engine baseline, not an engine migration.
BABELDOC_VERSION = "0.6.4"
# Block Python TCP, UDP and DNS operations, including socket.connect_ex.
NETWORK_EVENTS = {
    "socket.connect", "socket.getaddrinfo", "socket.gethostbyname",
    "socket.gethostbyaddr", "socket.getnameinfo", "socket.sendto", "socket.sendmsg",
}
# Detection output is evidence, not a formula transcription or acceptance verdict.
LIMITS = [
    "Local display-formula detection on explicitly selected zero-based pages only.",
    "No providers, translation, LaTeX conversion, OCR, recall score or semantic acceptance.",
    "The backend omits regions without extractable PDF glyphs; zero is not proof of no formulas.",
    "Region and glyph rects are original PDF user-space coordinates in points, not image pixels.",
    "Python outbound socket/DNS operations are blocked; ONNX telemetry is disabled, not OS-sandboxed.",
]


def install_network_guard():
    """Disable runtime telemetry/downloads and reject outbound Python socket operations."""
    os.environ.update(ORT_DISABLE_TELEMETRY="1", HF_HUB_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")

    def guard(event, arguments):
        """Stop connections and DNS before Python can contact any endpoint."""
        if event in NETWORK_EVENTS:
            raise RuntimeError("Outbound network is disabled for the formula probe")

    sys.addaudithook(guard)


def sha256(path):
    """Hash the actual file bytes without modifying the input."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main(argv=None):
    """Validate bounded inputs, run real CPU inference, and save a new evidence JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdfs", nargs="+", type=Path, help="Existing digital PDFs (read-only)")
    parser.add_argument("--pages", nargs="+", type=int, required=True,
                        help="Explicit zero-based indexes, applied to each PDF; no all-pages default")
    parser.add_argument("--output", type=Path, required=True, help="New JSON file; never overwritten")
    parser.add_argument("--backend-dir", type=Path, default=ROOT / "backend",
                        help="Directory containing the actual formula_regions.py and engine.py")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".cache",
                        help="Read-only cache root containing babeldoc/models/; no downloads")
    args = parser.parse_args(argv)
    pages = list(dict.fromkeys(args.pages))
    if any(index < 0 for index in pages):
        parser.error("--pages must contain nonnegative zero-based indexes")
    backend = args.backend_dir.expanduser().resolve()
    source_cache = args.cache_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".json" or output.exists():
        parser.error("--output must be a new .json file; existing files are never overwritten")
    # Even an explicit output must not write into the source cache or runtime libraries.
    protected = (backend, source_cache, Path(sys.prefix).resolve(), Path(sys.base_prefix).resolve())
    if any(output.is_relative_to(path) for path in protected):
        parser.error("--output must be outside the backend, source cache and Python libraries")
    if not all((backend / name).is_file() for name in ("formula_regions.py", "engine.py")):
        parser.error("--backend-dir must contain formula_regions.py and engine.py")

    install_network_guard()
    sys.path.insert(0, str(backend))
    try:
        import formula_regions
        import pymupdf

        model_source = source_cache / formula_regions.MODEL_RELATIVE_PATH
        if not model_source.is_file():
            raise ValueError(f"Existing CPU model is missing: {model_source}; downloads are disabled")
        inputs = []
        for path in dict.fromkeys(pdf.expanduser().resolve() for pdf in args.pdfs):
            if path.suffix.lower() != ".pdf" or not path.is_file():
                raise ValueError(f"PDF is unavailable: {path}")
            with pymupdf.open(path) as document:
                page_count = len(document)
                if any(index >= page_count for index in pages):
                    raise ValueError(f"Selected page is out of range for {path} ({page_count} pages)")
            inputs.append({"path": str(path), "sha256": sha256(path),
                           "page_count": page_count, "selected_page_indexes": pages, "pages": []})

        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".formula-probe-", dir=output.parent) as temporary:
            cache = Path(temporary)
            model_copy = cache / formula_regions.MODEL_RELATIVE_PATH
            model_copy.parent.mkdir(parents=True)
            # BabelDOC creates cache directories on import; only this private copy is mutable.
            shutil.copyfile(model_source, model_copy)
            os.environ.update(PAPERBRIDGE_CACHE_DIR=str(cache), XDG_CACHE_HOME=str(cache),
                              HOME=str(cache), USERPROFILE=str(cache),
                              HF_HOME=str(cache / "huggingface"), MPLCONFIGDIR=str(cache / "matplotlib"))
            from engine import localize_cache
            localize_cache()
            import babeldoc.const

            # Bundled runtimes may omit dist-info, so read the real localized engine constant.
            installed_version = babeldoc.const.__version__
            if installed_version != BABELDOC_VERSION:
                raise ValueError(f"BabelDOC {BABELDOC_VERSION} is required; found {installed_version}")
            import onnxruntime
            onnxruntime.disable_telemetry_events()

            error_count = 0
            region_count = 0
            for item in inputs:
                for index in pages:
                    page_result = {"page_index": index}
                    try:
                        result = formula_regions.detect({"source_path": item["path"], "page_index": index})
                        count = len(result["regions"])
                        page_result.update(status="ok", region_count=count, **result)
                        region_count += count
                    except Exception as error:
                        # A failed page must not masquerade as a successful zero-region detection.
                        page_result.update(status="error", error=f"{type(error).__name__}: {error}")
                        error_count += 1
                    item["pages"].append(page_result)

            model = formula_regions._MODEL
            report = {
                "schema_version": 1,
                "status": "error" if error_count else "ok",
                "limits": LIMITS,
                "runtime": {
                    "python": sys.executable, "python_version": sys.version.split()[0],
                    "babeldoc_version": installed_version, "pymupdf_version": pymupdf.VersionBind,
                    "onnxruntime_version": onnxruntime.__version__,
                    "backend_path": str(Path(formula_regions.__file__).resolve()),
                    "backend_sha256": sha256(Path(formula_regions.__file__)),
                    "execution_providers": model.model.get_providers() if model is not None else [],
                    "onnx_telemetry_disabled": True,
                },
                "model": {"source_path": str(model_source), "sha256": sha256(model_copy),
                          "temporary_cache_copy": True},
                "inputs": inputs,
                "summary": {"selected_page_count": len(inputs) * len(pages),
                            "region_count": region_count, "error_page_count": error_count},
            }
            serialized = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
            with output.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(serialized + "\n")
        print(f"{region_count} regions; {error_count} failed pages; evidence: {output}")
        return 1 if error_count else 0
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"Formula probe failed: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
