"""Probe released BabelDOC interfaces offline without upgrading the production engine.

The pinned-version mapping capture is research instrumentation, not a new runtime adapter.
Only completion responses are simulated; parsing, layout, fonts and PDF writing are real.
"""
import argparse
import asyncio
import hashlib
from contextlib import redirect_stdout
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import uuid

# Reuse existing isolated fixture and network guards instead of a second test harness.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from offline_quality_pipeline import blocked_network, configure_paths, create_source, inspect_pdf

# A changed prefix makes simulated application visible without linguistic claims.
MARKER = "离线验证"


def coordinates(box):
    """Read engine PDF-space rectangles without applying a browser coordinate guess."""
    return [float(getattr(box, key)) for key in ("x", "y", "x2", "y2")]


def painted_rectangle(path, page_number, captured):
    """Bound actual PDF glyphs geometrically inside the captured unit, without text matching."""
    import pymupdf

    with pymupdf.open(path) as document:
        page = document[page_number]
        region = pymupdf.Rect(captured) * page.transformation_matrix
        boxes = []
        for block in page.get_text("rawdict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    for character in span["chars"]:
                        box = pymupdf.Rect(character["bbox"])
                        if region.contains((box.tl + box.br) / 2):
                            boxes.append(box)
        if not boxes:
            return captured
        union = boxes[0]
        for box in boxes[1:]:
            union |= box
        # Engine visual boxes may exclude font ascenders; retain the actual extractor bounds.
        return list(union * ~page.transformation_matrix)


def current_capture(folder, request, report):
    """Capture the same pinned-engine objects before translation and after final writing."""
    import batching
    from engine import translate

    observed = []

    class CapturedTranslator(batching.CostAwareILTranslator):
        """Retain before-images only in this disposable research process."""

        def translate(self, docs):
            """Snapshot input identity while keeping final mutable paragraph references."""
            for page in docs.page:
                for index, paragraph in enumerate(page.pdf_paragraph):
                    observed.append({"id": f"p{page.page_number}-u{index}", "page": page.page_number,
                                     "source_rect": coordinates(paragraph.box),
                                     "source_text": paragraph.unicode or "", "paragraph": paragraph,
                                     "quality": self.translate_engine.quality})
            return super().translate(docs)

    # This narrow research hook does not modify the shipped engine or enable debug overlays.
    with patch.object(batching, "CostAwareILTranslator", CapturedTranslator):
        asyncio.run(translate(request))
    candidates = []
    for row in observed:
        paragraph = row["paragraph"]
        characters = [part.pdf_character for part in paragraph.pdf_paragraph_composition if part.pdf_character]
        if not characters:
            continue
        boxes = [coordinates(char.visual_bbox.box if char.visual_bbox else char.box) for char in characters]
        target = [min(box[0] for box in boxes), min(box[1] for box in boxes),
                  max(box[2] for box in boxes), max(box[3] for box in boxes)]
        evidence = row["quality"].paragraphs.get(id(paragraph), {})
        source_rect = painted_rectangle(folder / "source.pdf", row["page"], row["source_rect"])
        target_rect = painted_rectangle(folder / "translated.pdf", row["page"], target)
        candidates.append({"id": row["id"], "source": {"page": row["page"], "rects": [source_rect]},
                           "target": {"page": row["page"], "rects": [target_rect]},
                           "source_text": row["source_text"],
                           "target_text": "".join(char.char_unicode or "" for char in characters),
                           "applied": evidence.get("applied", False)})
    (folder / "captured-candidates.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=2))
    report["captured_same_unit_candidates"] = len(candidates)
    from alignment import build_mapping, write_mapping
    mapping = build_mapping(folder / "source.pdf", folder / "translated.pdf", candidates)
    write_mapping(folder / "alignment.json", mapping)
    report["mapping"] = mapping["metadata"]
    return folder / "translated.pdf"


async def public_translate(folder, translator, protected=False, official_fonts=False):
    """Exercise the released entry point without replacing removed internal stages."""
    from babeldoc.assets import assets
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.format.pdf import high_level
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from fonts import install_songti

    if not official_fonts:
        install_songti(assets)
        from babeldoc.assets import embedding_assets_metadata
        local_family = assets.get_font_family("zh-CN")
        original_family = embedding_assets_metadata.get_font_family
        original_metadata = assets.get_font_and_metadata
        # Research-only compatibility: Rust uses the metadata family and actual face hash.
        embedding_assets_metadata.get_font_family = lambda language: local_family if language.lower().startswith("zh") else original_family(language)
        def native_metadata(name):
            """Supply the checksum required by the released Rust font mapper."""
            path, metadata = original_metadata(name)
            with Path(path).open("rb") as stream:
                return path, {**metadata, "sha3_256": hashlib.file_digest(stream, "sha3_256").hexdigest()}
        assets.get_font_and_metadata = native_metadata
    layout = DocLayoutModel.load_available()
    if protected:
        from preserve import ProtectedLayoutModel
        layout = ProtectedLayoutModel(layout)
    config = TranslationConfig(translator=translator, input_file=folder / "source.pdf", lang_in="en", lang_out="zh-CN",
                               doc_layout_model=layout, output_dir=folder / "output", working_dir=folder / "work",
                               no_dual=True, qps=1, pool_max_workers=1, auto_extract_glossary=False,
                               watermark_output_mode=WatermarkOutputMode.NoWatermark, primary_font_family="serif",
                               disable_same_text_fallback=True, debug=False)
    async for event in high_level.async_translate(config):
        if event["type"] == "error":
            raise RuntimeError(str(event.get("error", "Engine error")))
        if event["type"] == "finish":
            return Path(event["translate_result"].mono_pdf_path)
    raise RuntimeError("Released entry point finished without an output")


def main():
    """Write exact interface and real-layout evidence while recording blocked network attempts."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".runtime/engine-interface-probe")
    parser.add_argument("--official-fonts", action="store_true", help="Prepare official serif faces before the offline Rust probe")
    args = parser.parse_args()
    folder = args.output.resolve() / (version("babeldoc") + "-" + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True)
    configure_paths(ROOT, folder)
    # Both examined releases ignore XDG_CACHE_HOME; reuse the project's existing cache boundary.
    from engine import localize_cache
    localize_cache()
    from deepseek import DeepSeekTranslator

    report = {"babeldoc": version("babeldoc"), "paid_provider_calls": 0, "responses": "simulated",
              "production_dependency_changed": False, "font_mode": "official" if args.official_fonts else "system",
              "cases": [], "network_attempts": []}
    if args.official_fonts and report["babeldoc"] != "0.6.4":
        from babeldoc.assets import assets, embedding_assets_metadata
        # These known upstream faces let the probe distinguish font-profile failures from parser failures.
        names = ["SourceHanSerifCN-Regular.ttf", "SourceHanSerifCN-Bold.ttf"]
        family = {"normal": names, "script": [], "fallback": [names[0]], "base": [names[0]]}
        try:
            for name in names:
                assets.get_font_and_metadata(name)
            embedding_assets_metadata.get_font_family = lambda language: family
            report["official_fonts_prepared"] = names
        except Exception as error:
            report["official_font_preparation_error"] = f"{type(error).__name__}: {error}"
    try:
        from babeldoc import _rust_il
        report["formal_wheel_stage_capture"] = _rust_il.stage_capture_enabled()
    except ImportError:
        report["formal_wheel_stage_capture"] = None

    def completion(translator, messages):
        """Mock only the provider boundary, preserving the project's actual wire contract."""
        case["completion_calls"] += 1
        inputs = json.loads(messages[1]["content"])["paragraphs"]
        content = json.dumps({"translations": [{"id": row["id"], "text": MARKER + "：" + row["text"]}
                                                for row in inputs]}, ensure_ascii=False)
        return SimpleNamespace(id="offline", usage=None, choices=[SimpleNamespace(
            finish_reason="stop", message=SimpleNamespace(content=content))])

    modes = ("pinned_capture",) if report["babeldoc"] == "0.6.4" else ("public", "existing_protection_adapter")
    for mode in modes:
        case_folder = folder / mode
        case_folder.mkdir()
        create_source(case_folder / "source.pdf")
        case = {"mode": mode, "completion_calls": 0, "ok": False}
        request = {"folder": str(case_folder), "api_key": "offline-only", "profile": "compatible",
                   "model": folder.name + mode, "base_url": "https://example.invalid/v1", "lang_out": "zh-CN", "pages": ""}
        try:
            with (folder / (mode + ".log")).open("w") as log, redirect_stdout(log), \
                    blocked_network(report["network_attempts"]), patch.object(DeepSeekTranslator, "request_completion", completion):
                if mode == "pinned_capture":
                    output = current_capture(case_folder, request, case)
                else:
                    translator = DeepSeekTranslator(document_title="Offline probe", document_key=folder.name,
                        paragraph_cache=case_folder / "paragraphs.sqlite", usage_path=case_folder / "usage.json",
                        api_key="offline-only", model=request["model"], base_url=request["base_url"],
                        profile="compatible", lang_in="en", lang_out="zh-CN")
                    output = asyncio.run(public_translate(case_folder, translator, mode != "public", args.official_fonts))
                case["pdf"] = inspect_pdf(output)
                case["ok"] = case["pdf"]["marker_present"]
                case["output_path"] = str(output)
        except Exception as error:
            case["error"] = f"{type(error).__name__}: {error}"
        report["cases"].append(case)
    report_path = folder / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(report_path)
    print(json.dumps({"babeldoc": report["babeldoc"], "stage_capture": report["formal_wheel_stage_capture"],
                      "cases": [{key: value for key, value in case.items() if key != "pdf"} for case in report["cases"]],
                      "network_attempts": report["network_attempts"]}, ensure_ascii=False, indent=2))
    return 0 if all(case["ok"] for case in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
