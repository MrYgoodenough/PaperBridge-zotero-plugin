"""Prepare real-paper hover fixtures through the production cache-only pipeline.

Existing real translations are reused, never replaced by simulated responses.
The manifest and rendered pages are local QA inputs, not semantic acceptance.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
from contextlib import closing
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

# Locate the unchanged production modules independently of the caller's directory.
ROOT = Path(__file__).resolve().parents[1]
# Do not inherit unrelated Python or native-library paths into the test workers.
CLEARED_ENVIRONMENT = ("PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "LD_PRELOAD")
# Stop Python network/DNS operations before any connection can be established.
NETWORK_EVENTS = {"socket.connect", "socket.sendto", "socket.sendmsg", "socket.getaddrinfo",
                  "socket.gethostbyname", "socket.gethostbyname_ex", "socket.gethostbyaddr"}
# Match the previous real-paper preservation evidence without changing the PDFs.
RENDER_DPI = 144
# Use PDF points when converting the selected pages to raster images.
POINTS_PER_INCH = 72
# Bound only this preparation subprocess; a timeout is recorded as failure.
WORKER_TIMEOUT = 300


def write_json(path, value):
    """Write local UTF-8 evidence without hiding unknown or failed results."""
    Path(path).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
                          encoding="utf-8")


def read_json(path):
    """Read an explicitly supplied local evidence file."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    """Hash the exact bytes used by production or native QA."""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def file_snapshot(paths):
    """Record inputs so preparation cannot silently mutate the historical evidence."""
    return {str(path): digest(path) for path in sorted(paths) if path.is_file()}


def install_network_guard(events):
    """Reject audited Python socket operations; HTTP and provider guards run in workers."""
    def audit(event, arguments):
        """Record a forbidden operation before refusing it, including DNS lookups."""
        if event in NETWORK_EVENTS:
            events.append({"event": event})
            raise RuntimeError("Network access forbidden during cache-only preparation")
    sys.addaudithook(audit)


def cache_inventory(path):
    """Inspect the task-local database, never opening the historical database for writes."""
    with closing(sqlite3.connect(path)) as database:
        return {"integrity": database.execute("PRAGMA integrity_check").fetchone()[0],
                "rows_by_document": dict(database.execute(
                    "SELECT document_key, COUNT(*) FROM paragraphs GROUP BY document_key"))}


async def run_production(request, observations):
    """Delegate to engine.translate with cache-only availability and pass-through trace observers."""
    sys.path.insert(0, str(ROOT / "backend"))
    import engine
    original_pipeline = engine._translate

    async def cache_only_pipeline(normalized, quality):
        """Keep production parsing, application, preservation and mapping validation unchanged."""
        import deepseek
        import fragment_trace
        import httpx
        original_items = deepseek.DeepSeekTranslator.translate_items
        original_get = deepseek.ParagraphCache.get
        original_write = fragment_trace.FragmentTrace.write
        original_candidates = fragment_trace.FragmentTrace._candidates
        lock = threading.Lock()
        candidates = {}

        def cache_only_items(translator, paragraphs):
            """Suppress missing inputs before production can begin or meter a provider request."""
            previous = getattr(translator.request_context, "cache_only", False)
            translator.request_context.cache_only = True
            try:
                return original_items(translator, paragraphs)
            finally:
                translator.request_context.cache_only = previous

        def observed_get(cache, text):
            """Observe the normal cache lookup without fabricating or modifying its return value."""
            value = original_get(cache, text)
            valid = (isinstance(value, str) and bool(value.strip())
                     and deepseek.placeholder_tokens(value) == deepseek.placeholder_tokens(text))
            with lock:
                observations["cache_lookups"].append({
                    "key": cache.key(text), "document_key": cache.document_key,
                    "hit": valid, "input_excerpt": text[:160],
                    "translation_excerpt": value[:160] if isinstance(value, str) else None,
                    "input_sha256": hashlib.sha256(text.encode()).hexdigest(),
                    "translation_sha256": hashlib.sha256(value.encode()).hexdigest() if valid else None})
            return value

        def forbidden_provider(translator, messages):
            """Fail loudly if cache-only suppression ever reaches the SDK dispatch boundary."""
            observations["provider_dispatch_attempts"] += 1
            raise RuntimeError("Provider dispatch forbidden; no simulated translation is available")

        def forbidden_http(client, *arguments, **options):
            """Reject synchronous HTTP before the transport can resolve or connect."""
            observations["http_attempts"] += 1
            raise RuntimeError("HTTP forbidden during cache-only preparation")

        async def forbidden_async_http(client, *arguments, **options):
            """Reject asynchronous HTTP before the transport can resolve or connect."""
            return forbidden_http(client, *arguments, **options)

        def observed_candidates(trace, source, target, result_quality):
            """Observe candidates verbatim; the production validator still accepts or rejects them."""
            for candidate in original_candidates(trace, source, target, result_quality):
                candidates[candidate["id"]] = candidate
                yield candidate

        def observed_write(trace, output_path, mapping_path, result_quality):
            """Retain QA evidence while the unchanged production hook decides every verified unit."""
            snapshots = {}
            for key, row in trace.rows.items():
                if row is None:
                    continue
                paragraph = row["paragraph"]
                characters = [part.pdf_character for part in paragraph.pdf_paragraph_composition]
                target_text = ("".join(character.char_unicode or "" for character in characters)
                               if characters and all(character is not None for character in characters)
                               else None)
                snapshots[row["id"]] = {"captured_source_text": row["source_text"],
                                        "captured_target_text": target_text,
                                        "quality": dict(result_quality.paragraphs.get(key, {}))}
            mapping = original_write(trace, output_path, mapping_path, result_quality)
            observations["production_trace_hook_completed"] = mapping is not None
            observations["trace_exclusions"] = dict(trace.excluded)
            observations["verified_trace_units"] = {
                unit["id"]: snapshots[unit["id"]] for unit in (mapping or {}).get("units", [])}
            observations["excluded_trace_units"] = [
                {"id": identifier, **snapshot}
                for identifier, snapshot in snapshots.items()
                if identifier not in observations["verified_trace_units"]]
            observations["candidate_literal_evidence"] = []
            if mapping is not None:
                import pymupdf
                from alignment import _clips, _layout_text, _normalize_text, _page_space, _visible_text
                observations["mapping_authority"] = "actual production FragmentTrace.write verified IDs"
                observations["diagnostic_comparator"] = "alignment._layout_text; literal_found is legacy spacing evidence only"
                with pymupdf.open(trace.source_path) as source, pymupdf.open(output_path) as target:
                    caches = {side: {} for side in ("source", "target")}
                    for identifier, candidate in candidates.items():
                        evidence = {"id": identifier, "production_verified": identifier in
                                    observations["verified_trace_units"]}
                        for side, document in (("source", source), ("target", target)):
                            page, clips = _clips(document, candidate[side], {})
                            _, bounds = _page_space(page, {})
                            expected = _normalize_text(candidate[f"{side}_text"])
                            observed = _visible_text(page, clips, bounds, caches[side])
                            evidence[side] = {**candidate[side], "expected": expected,
                                              "observed": observed, "literal_found": expected in observed,
                                              "layout_glyph_found": _layout_text(expected) in _layout_text(observed)}
                        observations["candidate_literal_evidence"].append(evidence)
            return mapping

        # These changes exist only in this worker; no production module is edited.
        deepseek.DeepSeekTranslator.translate_items = cache_only_items
        deepseek.DeepSeekTranslator.request_completion = forbidden_provider
        deepseek.ParagraphCache.get = observed_get
        fragment_trace.FragmentTrace.write = observed_write
        fragment_trace.FragmentTrace._candidates = observed_candidates
        httpx.Client.send = forbidden_http
        httpx.AsyncClient.send = forbidden_async_http
        await original_pipeline(normalized, quality)

    engine._translate = cache_only_pipeline
    await engine.translate(request)


def worker(folder, network_events):
    """Run one real document in the isolated cache, recording failures without substitute responses."""
    observations = {"kind": "real_paragraph_cache_reapplication", "provider_dispatch_attempts": 0,
                    "http_attempts": 0, "cache_lookups": [], "engine_error": None,
                    "production_trace_hook_completed": False}
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run_production(read_json(folder / "request.json"), observations))
    except Exception as error:
        observations["engine_error"] = {"type": type(error).__name__, "message": str(error)}
        logging.exception("Cache-only production preparation failed")
    finally:
        observations["network_attempts"] = network_events
        write_json(folder / "pipeline-observations.json", observations)
    return int(bool(observations["engine_error"] or observations["provider_dispatch_attempts"]
                    or observations["http_attempts"] or network_events))


def location_evidence(document, unit, side, units):
    """Extract actual visible PDF text and a glyph midpoint with unambiguous native ownership."""
    import pymupdf
    from alignment import _clips, _contains, _normalize_text, _page_space, _page_text, _visible_text
    location = unit[side]
    page, clips = _clips(document, location, {})
    matrix, bounds = _page_space(page, {})
    text_cache = {}
    text = _visible_text(page, clips, bounds, text_cache)
    hit = None
    for line in _page_text(page, bounds, text_cache):
        for character, box, visible in line:
            if not visible or character.isspace() or not any(_contains(clip, box) for clip in clips):
                continue
            point = ((box.tl + box.br) / 2) * ~matrix
            owners = [candidate["id"] for candidate in units
                      if candidate[side]["page"] == location["page"] and any(
                          pymupdf.Rect(rectangle).contains(point) for rectangle in candidate[side]["rects"])]
            if owners == [unit["id"]]:
                hit = {"point": list(point), "glyph": character,
                       "line_text": _normalize_text("".join(char for char, _, painted in line if painted))}
                break
        if hit is not None:
            break
    return {**location, "page_one_based": location["page"] + 1, "text": text,
            "hit_point": hit["point"] if hit else None, "hit_text": hit["line_text"] if hit else None,
            "hit_glyph": hit["glyph"] if hit else None}


def inspect_case(folder, case, selected_pages):
    """Check the hook output and render the real selected pages for the native QA owner."""
    import pymupdf
    sys.path.insert(0, str(ROOT / "backend"))
    from alignment import load_mapping
    paths = {"source_pdf": folder / "source.pdf", "translated_pdf": folder / "translated.pdf",
             "alignment_path": folder / "alignment.json", "quality_path": folder / "quality.json",
             "usage_path": folder / "usage.json", "observations_path": folder / "pipeline-observations.json"}
    result = {"id": case["id"], "title": case["title"], **{key: str(path) for key, path in paths.items()},
              "selected_pages_one_based": selected_pages, "source_pages": 0, "target_pages": 0,
              "unit_count": 0, "units": [], "renders": [], "failures": []}
    observations = read_json(paths["observations_path"])
    result["network_guard"] = {key: observations[key] for key in (
        "provider_dispatch_attempts", "http_attempts", "network_attempts", "engine_error")}
    result["cache_lookup_hits"] = sum(item["hit"] for item in observations["cache_lookups"])
    result["cache_lookup_misses"] = sum(not item["hit"] for item in observations["cache_lookups"])
    result["production_trace_hook_completed"] = observations["production_trace_hook_completed"]
    result["trace_exclusions"] = observations.get("trace_exclusions", {})
    if not paths["translated_pdf"].is_file():
        result["failures"].append("production_output_missing")
        return result
    quality = read_json(paths["quality_path"])
    result["quality_status"], result["quality_counts"] = quality["status"], quality["counts"]
    result["usage"] = read_json(paths["usage_path"])
    loaded = load_mapping(paths["alignment_path"], paths["source_pdf"], paths["translated_pdf"])
    result["mapping_available"] = loaded["available"]
    mapping = loaded.get("mapping", {"units": []})
    if not loaded["available"]:
        result["failures"].append(loaded["reason"])
    result["mapping_metadata"] = mapping.get("metadata")
    result["artifacts_sha256"] = {key: digest(path) for key, path in paths.items() if path.is_file()}
    with pymupdf.open(paths["source_pdf"]) as source, pymupdf.open(paths["translated_pdf"]) as target:
        result["source_pages"], result["target_pages"] = source.page_count, target.page_count
        for unit in mapping["units"]:
            trace = observations["verified_trace_units"][unit["id"]]
            result["units"].append({"id": unit["id"], "status": unit["status"], **trace,
                                    "source": location_evidence(source, unit, "source", mapping["units"]),
                                    "target": location_evidence(target, unit, "target", mapping["units"])})
        for page_number in selected_pages:
            images = {"page_one_based": page_number, "dpi": RENDER_DPI, "renderer": "PyMuPDF"}
            for side, document in (("source", source), ("target", target)):
                image = folder / f"{side}-p{page_number}.png"
                document[page_number - 1].get_pixmap(
                    matrix=pymupdf.Matrix(RENDER_DPI / POINTS_PER_INCH, RENDER_DPI / POINTS_PER_INCH),
                    colorspace=pymupdf.csRGB, alpha=False).save(image)
                images[f"{side}_png"] = str(image)
                images[f"{side}_png_sha256"] = digest(image)
            result["renders"].append(images)
        result["unselected_page_preservation"] = []
        for index in range(source.page_count):
            if index + 1 in selected_pages:
                continue
            matrix = pymupdf.Matrix(RENDER_DPI / POINTS_PER_INCH, RENDER_DPI / POINTS_PER_INCH)
            result["unselected_page_preservation"].append({"page_one_based": index + 1,
                "text_equal": source[index].get_text() == target[index].get_text(),
                "pixels_equal": source[index].get_pixmap(matrix=matrix).samples
                                == target[index].get_pixmap(matrix=matrix).samples})
    result["unit_count"] = len(result["units"])
    result["mapped_pages_one_based"] = sorted({unit["source"]["page_one_based"] for unit in result["units"]})
    result["recommended_native_unit_ids"] = [unit["id"] for unit in result["units"]
        if not unit["quality"]["unchanged"] and all(unit[side]["hit_point"] for side in ("source", "target"))]
    result["unchanged_verified_unit_ids"] = [unit["id"] for unit in result["units"] if unit["quality"]["unchanged"]]
    if quality["counts"]["failed"]:
        result["failures"].append("uncached_or_unapplied_regions_excluded_from_mapping")
    return result


def prepare(evidence, output, corpus, network_events):
    """Prepare both cached selections without overwriting an earlier fixture directory."""
    cases = read_json(corpus)["cases"]
    output.mkdir(parents=True, exist_ok=True)
    originals = list((evidence / "cache").rglob("*"))
    for case in cases:
        originals.extend((evidence / case["id"]).glob("*.json"))
        originals.append(evidence / case["id"] / "source.pdf")
    before = file_snapshot(originals)
    # Copy resources and SQLite companions; only the clone may be touched by BabelDOC.
    cache = output / "cache"
    shutil.copytree(evidence / "cache", cache)
    temporary = output / "tmp"
    temporary.mkdir()
    environment = {key: value for key, value in os.environ.items() if key not in CLEARED_ENVIRONMENT}
    environment.update(PAPERBRIDGE_CACHE_DIR=str(cache), TIKTOKEN_CACHE_DIR=str(cache / "babeldoc/tiktoken"),
                       PYTHONDONTWRITEBYTECODE="1", ORT_DISABLE_TELEMETRY="1", TMPDIR=str(temporary),
                       TMP=str(temporary), TEMP=str(temporary), XDG_CACHE_HOME=str(output / "xdg-cache"))
    manifest = {"schema_version": 1, "kind": "production_verified_real_cache_hover_preparation",
                "created_at": datetime.now(timezone.utc).isoformat(), "status": "preparing", "cases": [],
                "entrypoint": "backend/engine.py::translate", "script": str(Path(__file__).resolve()),
                "evidence_root": str(evidence), "cache_copy": str(cache), "corpus_path": str(corpus),
                "cache_before": cache_inventory(cache / "paragraphs.sqlite"),
                "versions": {name: version(name) for name in ("babeldoc", "pymupdf", "onnxruntime", "openai")},
                "source_code_sha256": {name: digest(ROOT / "backend" / name) for name in (
                    "engine.py", "batching.py", "fragment_trace.py", "alignment.py", "deepseek.py", "usage.py")},
                "limits": ["Only historical selected pages are reapplied; no full-paper translation.",
                           "Verified means applied identity plus final text/geometry, not semantic correctness.",
                           "No cross-column/cross-page or native Zotero acceptance is performed here.",
                           "Unknown unchanged author/email entries retain their production quality status.",
                           "Historical affiliation wrapping and copyright reconstruction defects may remain.",
                           "Local PDFs/derivatives are QA inputs, not licensed release attachments."],
                "network_guard_scope": "Python socket/DNS audit, HTTP send guard, cache-only before provider dispatch; ONNX telemetry disabled"}
    manifest_path = output / "manifest.json"
    write_json(manifest_path, manifest)
    for case in cases:
        folder = output / case["id"]
        folder.mkdir()
        generation = read_json(evidence / case["id"] / "generation.json")
        source = evidence / case["id"] / "source.pdf"
        if generation["kind"] != "real_translation" or digest(source) != case["source_sha256"]:
            raise ValueError(f"Unverified historical real translation: {case['id']}")
        shutil.copy2(source, folder / "source.pdf")
        request = {**generation["settings"], "folder": str(folder),
                   "document_key": generation["identity"]["document_key"],
                   "api_key": "offline-cache-only-no-credential"}
        write_json(folder / "request.json", request)
        with (folder / "worker.stdout.log").open("w") as stdout, (folder / "worker.stderr.log").open("w") as stderr:
            process = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--worker", str(folder)],
                                     cwd=ROOT, env=environment, stdout=stdout, stderr=stderr, timeout=WORKER_TIMEOUT)
        result = inspect_case(folder, case, generation["selected_pages"])
        result["engine_exit_code"] = process.returncode
        result["historical_generation_path"] = str(evidence / case["id"] / "generation.json")
        result["historical_provider_evidence_path"] = str(evidence / case["id"] / "provider-evidence.json")
        write_json(folder / "manifest.json", result)
        manifest["cases"].append(result)
        write_json(manifest_path, manifest)
        print(json.dumps({"id": result["id"], "unit_count": result["unit_count"],
                          "quality": result.get("quality_status"), "cache_hits": result["cache_lookup_hits"],
                          "cache_misses": result["cache_lookup_misses"], "manifest": str(manifest_path)}), flush=True)
    manifest["cache_after"] = cache_inventory(cache / "paragraphs.sqlite")
    manifest["historical_inputs_unchanged"] = before == file_snapshot(originals)
    manifest["parent_network_attempts"] = network_events
    manifest["status"] = "prepared" if all(
        item["engine_exit_code"] == 0 and item.get("mapping_available") and item["recommended_native_unit_ids"]
        and item["usage"]["api_requests"] == 0 for item in manifest["cases"]) else "incomplete"
    if not manifest["historical_inputs_unchanged"] or network_events:
        manifest["status"] = "incomplete"
    write_json(output / "historical-input-hashes.json", before)
    write_json(manifest_path, manifest)
    return int(manifest["status"] != "prepared")


def main():
    """Accept explicit local evidence/output roots; never provide an online mode."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, default=ROOT / ".runtime/quality-p1-20261114")
    parser.add_argument("--corpus", type=Path, default=ROOT / "docs/quality-corpus.json")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    network_events = []
    install_network_guard(network_events)
    if arguments.worker:
        return worker(arguments.worker.resolve(), network_events)
    if not arguments.output_dir:
        parser.error("--output-dir is required and must not contain an earlier cache/fixture")
    return prepare(arguments.evidence_dir.resolve(), arguments.output_dir.resolve(),
                   arguments.corpus.resolve(), network_events)


if __name__ == "__main__":
    sys.exit(main())
