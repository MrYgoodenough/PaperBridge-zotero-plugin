"""Inspect supplied PDFs offline; keep structural evidence separate from human quality review."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

import pymupdf

# Fixed metadata contains public sources, selected pages and required human checks.
CORPUS = Path(__file__).resolve().parents[1] / "docs" / "quality-corpus.json"
# Allow harmless coordinate serialization differences, measured in PDF points.
GEOMETRY_TOLERANCE = 0.5
# Render manually supplied protection boxes at 144 dpi for exact pixel comparison.
PROTECTION_SCALE = 2
# Keep text excerpts short; full-text hashes still cover each entire page.
EXCERPT_LENGTH = 600


def digest(data):
    """Return a reproducible SHA-256 for file, text or rendered evidence."""
    return hashlib.sha256(data).hexdigest()


def normalized_text(text):
    """Ignore extraction whitespace, not wording, for preservation comparisons."""
    return re.sub(r"\s+", "", text)


def read_json(path):
    """Read only an explicitly supplied JSON file, never credentials or engine settings."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def inspect_pdf(path):
    """Read available PDFs independently so one missing input does not hide other evidence."""
    result = {"path": str(Path(path).resolve()) if path else None, "status": "not_evaluated"}
    if not path:
        result["reason"] = "PDF not supplied"
        return result
    try:
        data = Path(path).read_bytes()
        result["sha256"] = digest(data)
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            if doc.needs_pass:
                raise ValueError("Password-protected PDF; no password or credentials are read")
            pages = []
            for page in doc:
                text = page.get_text()
                # Text coordinates are unrotated and relative to the visible crop area.
                bounds = pymupdf.Rect(0, 0, page.cropbox.width, page.cropbox.height)
                spans = [span for block in page.get_text("dict")["blocks"]
                         for line in block.get("lines", []) for span in line["spans"]]
                fonts = []
                for xref, ext, kind, name, resource, *_ in page.get_fonts(full=True):
                    font_data = doc.extract_font(xref)[3] if xref else b""
                    fonts.append({"name": name, "type": kind, "extension": ext,
                                  "resource": resource, "embedded": bool(font_data)})
                links = [{key: link[key] for key in ("kind", "uri", "page", "file", "nameddest")
                          if key in link} for link in page.get_links()]
                pages.append({
                    "page": page.number + 1, "size_points": [page.rect.width, page.rect.height],
                    "mediabox": list(page.mediabox), "cropbox": list(page.cropbox),
                    "rotation": page.rotation, "text_characters": len(text),
                    "normalized_text_sha256": digest(normalized_text(text).encode()),
                    "text_excerpt": text[:EXCERPT_LENGTH],
                    "cjk_characters": sum("\u4e00" <= char <= "\u9fff" for char in text),
                    "replacement_characters": text.count("\ufffd"),
                    "out_of_bounds_spans": sum(
                        not (bounds + (-GEOMETRY_TOLERANCE, -GEOMETRY_TOLERANCE,
                                       GEOMETRY_TOLERANCE, GEOMETRY_TOLERANCE)).contains(
                            pymupdf.Rect(span["bbox"])) for span in spans),
                    "fonts": fonts, "links": links,
                })
            result.update(status="inspected", page_count=len(doc), pages=pages)
    except (OSError, ValueError, RuntimeError) as error:
        result.update(status="not_evaluated", reason=f"{type(error).__name__}: {error}")
    return result


def parse_pages(value):
    """Parse positive, one-based page numbers and inclusive ranges."""
    pages = set()
    for token in value.split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", token)
        if not match:
            raise ValueError("Pages must look like 1,2-4")
        start = int(match[1])
        end = int(match[2] or start)
        if start < 1 or end < start:
            raise ValueError("Pages must be positive and ranges ascending")
        pages.update(range(start, end + 1))
    return sorted(pages)


def compare_regions(source, output, regions):
    """Compare explicit unrotated crop-relative protection boxes; do not infer formula safety."""
    results = []
    if not regions or source["status"] != "inspected" or output["status"] != "inspected":
        return results
    with pymupdf.open(source["path"]) as original, pymupdf.open(output["path"]) as translated:
        for region in regions:
            row = {"definition": region, "status": "not_evaluated"}
            try:
                page_number = region["page"]
                if type(page_number) is not int or not 1 <= page_number <= min(len(original), len(translated)):
                    raise ValueError("Protection page is outside the PDFs")
                box = pymupdf.Rect(region["bbox"])
                if box.is_empty or box.is_infinite:
                    raise ValueError("Protection box must have a finite, positive area")
                texts, pixels, sizes = [], [], []
                for doc in (original, translated):
                    page = doc[page_number - 1]
                    bounds = pymupdf.Rect(0, 0, page.cropbox.width, page.cropbox.height)
                    if not bounds.contains(box):
                        raise ValueError("Protection box lies outside the visible crop area")
                    texts.append(normalized_text(page.get_text(clip=box)))
                    # Pixmap clipping uses rotated page coordinates, unlike text extraction.
                    pix = page.get_pixmap(matrix=pymupdf.Matrix(PROTECTION_SCALE, PROTECTION_SCALE),
                                          clip=box * page.rotation_matrix, alpha=False)
                    pixels.append(pix.samples)
                    sizes.append([pix.width, pix.height, pix.n])
                same_text = texts[0] == texts[1]
                same_pixels = sizes[0] == sizes[1] and pixels[0] == pixels[1]
                row.update(status="pass" if same_text and same_pixels else "needs_review",
                           text_equal=same_text, pixels_equal=same_pixels,
                           pixel_sha256=[digest(pixel) for pixel in pixels], pixel_sizes=sizes)
            except (KeyError, TypeError, ValueError, RuntimeError) as error:
                row["reason"] = str(error)
            results.append(row)
    return results


def automatic_checks(source, output, selected, regions, case):
    """Report structural comparisons, never semantic scores or inferred human approval."""
    checks = []

    def record(name, okay, details):
        """Append a reproducible result without making warnings fatal to other checks."""
        checks.append({"check": name, "status": "pass" if okay else "needs_review", "details": details})

    if source["status"] == "inspected":
        record("corpus_source_page_count", source["page_count"] == case["expected_source_pages"],
               {"expected": case["expected_source_pages"], "actual": source["page_count"]})
        if case.get("source_sha256"):
            record("corpus_source_identity", source["sha256"] == case["source_sha256"],
                   {"expected_sha256": case["source_sha256"], "actual_sha256": source["sha256"]})
    if output["status"] == "inspected":
        suspicious = [page["page"] for page in output["pages"]
                      if page["out_of_bounds_spans"] or page["replacement_characters"]]
        record("text_extraction_bounds", not suspicious, {"pages_to_inspect": suspicious})
        unembedded = [{"page": page["page"], "font": font["name"]}
                      for page in output["pages"] for font in page["fonts"] if not font["embedded"]]
        record("font_embedding", not unembedded, {"unembedded": unembedded,
               "note": "Base-14 fonts may be legitimate; embedding does not prove glyph visibility."})
        empty = [number for number in selected if number > output["page_count"]
                 or not output["pages"][number - 1]["text_characters"]]
        record("selected_page_text_present", not empty, {"empty_or_missing": empty})
    if source["status"] == output["status"] == "inspected":
        record("page_count", source["page_count"] == output["page_count"],
               {"source": source["page_count"], "output": output["page_count"]})
        invalid = [number for number in selected if number > source["page_count"]]
        record("selected_pages_in_source", not invalid, {"invalid_pages": invalid})
        geometry, unchanged_selected = [], []
        # Missing output pages cannot be reported as preserved merely because zip ends early.
        missing = source["pages"][output["page_count"]:]
        changed_unselected = [page["page"] for page in missing if page["page"] not in selected]
        links = [page["page"] for page in missing if page["links"]]
        for original, translated in zip(source["pages"], output["pages"]):
            number = original["page"]
            equal = all(abs(a - b) <= GEOMETRY_TOLERANCE
                        for key in ("size_points", "mediabox", "cropbox")
                        for a, b in zip(original[key], translated[key]))
            if not equal or original["rotation"] != translated["rotation"]:
                geometry.append(number)
            text_equal = original["normalized_text_sha256"] == translated["normalized_text_sha256"]
            if number not in selected and not text_equal:
                changed_unselected.append(number)
            if number in selected and text_equal:
                unchanged_selected.append(number)
            old_links = Counter(json.dumps(link, sort_keys=True) for link in original["links"])
            new_links = Counter(json.dumps(link, sort_keys=True) for link in translated["links"])
            if old_links - new_links:
                links.append(number)
        record("page_geometry", not geometry, {"changed_pages": geometry, "tolerance_points": GEOMETRY_TOLERANCE})
        record("unselected_text_preserved", not changed_unselected, {"changed_pages": changed_unselected})
        record("selected_text_changed", not unchanged_selected, {"unchanged_pages": unchanged_selected,
               "note": "Changed text is not proof of a real translation or semantic accuracy."})
        record("source_link_targets_preserved", not links, {"pages_with_missing_targets": links,
               "note": "Link hitboxes and click behavior still require visual/manual review."})
    protection = compare_regions(source, output, regions)
    checks.append({"check": "protected_regions", "status": (
        "not_evaluated" if not protection else
        "pass" if all(row["status"] == "pass" for row in protection) else "needs_review"
    ), "details": protection})
    available = source["status"] == output["status"] == "inspected"
    status = "not_evaluated" if not checks[:-1] else "partial" if not available else (
        "needs_review" if any(row["status"] == "needs_review" for row in checks) else "pass")
    return {"status": status, "checks": checks, "note": "Structural pass is not semantic or visual acceptance."}


def review_template(source, output, case):
    """Create unassessed human items bound to the current PDF bytes, not fake passing scores."""
    return {
        "case_id": case["id"], "source_sha256": source.get("sha256"),
        "output_sha256": output.get("sha256"), "reviewer": "", "reviewed_at": "",
        "provenance": {"kind": "unknown", "provider": "", "model": "", "prompt_source": ""},
        "items": [{**item, "verdict": "not_evaluated", "source_locator": "",
                   "output_locator": "", "notes": ""} for item in case["manual_checks"]],
    }


def human_review(source, output, case, review):
    """Accept only complete, hash-bound human evidence for declared real translation artifacts."""
    template = review_template(source, output, case)
    supplied = review or template
    raw_provenance = supplied.get("provenance", {})
    provenance = {}
    if isinstance(raw_provenance, dict):
        provenance = {key: raw_provenance.get(key)
                      for key in ("kind", "provider", "model", "prompt_source")}
    identity_matches = (
        source["status"] == output["status"] == "inspected"
        and supplied.get("case_id") == case["id"]
        and supplied.get("source_sha256") == source.get("sha256")
        and supplied.get("output_sha256") == output.get("sha256")
        and (not case.get("source_sha256") or source.get("sha256") == case["source_sha256"])
    )
    evidence_complete = identity_matches and all(
        isinstance(value, str) and value.strip() for value in (
            supplied.get("reviewer"), supplied.get("reviewed_at"),
            provenance.get("provider"), provenance.get("model"), provenance.get("prompt_source"),
        )
    ) and provenance.get("kind") == "real_translation"
    raw_items = supplied.get("items", [])
    supplied_items = []
    if isinstance(raw_items, list):
        supplied_items = [item for item in raw_items if isinstance(item, dict)]
    items = []
    for expected in template["items"]:
        matches = [item for item in supplied_items if item.get("id") == expected["id"]]
        item = matches[0] if len(matches) == 1 else expected
        valid = evidence_complete and item.get("page") == expected["page"] and all(
            isinstance(item.get(key), str) and item[key].strip()
            for key in ("source_locator", "output_locator", "notes")
        )
        verdict = item.get("verdict", "not_evaluated")
        effective = verdict if valid and isinstance(verdict, str) and verdict in {"pass", "fail"} else "not_evaluated"
        # Categories and focuses are fixed by the corpus, not user-overridable approvals.
        recorded = {key: item.get(key) for key in ("page", "verdict", "source_locator", "output_locator", "notes")}
        items.append({**recorded, "id": expected["id"], "category": expected["category"],
                      "focus": expected["focus"], "effective_verdict": effective})
    statuses = {}
    for category in ("semantic", "layout"):
        verdicts = [item["effective_verdict"] for item in items if item["category"] == category]
        statuses[category] = ("fail" if "fail" in verdicts else
                              "pass" if verdicts and all(value == "pass" for value in verdicts)
                              else "not_evaluated")
    return {**statuses, "artifact_identity_matches": identity_matches,
            "evidence_complete": bool(evidence_complete), "reviewer": supplied.get("reviewer"),
            "reviewed_at": supplied.get("reviewed_at"), "provenance": provenance, "items": items,
            "note": "User-recorded human judgement, not an automated semantic evaluation."}


def build_report(case, source_path=None, output_path=None, selected=None, regions=None, review=None):
    """Combine independently readable artifacts, structural checks and explicit human decisions."""
    source, output = inspect_pdf(source_path), inspect_pdf(output_path)
    selected = case["selected_pages"] if selected is None else selected
    automatic = automatic_checks(source, output, selected, regions or [], case)
    human = human_review(source, output, case, review)
    return {
        "schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
        "case": case, "selected_pages": selected, "source": source, "output": output,
        "scope": {
            "kind": "corpus_default_selection" if selected == case["selected_pages"] else "selected_pages_only",
            "translated_pages": selected, "corpus_default_translated_pages": case["selected_pages"],
            "matches_corpus_default": selected == case["selected_pages"],
            "whole_paper_semantic_acceptance": False,
        },
        "automatic": automatic, "human": human,
        "acceptance": "accepted" if automatic["status"] == human["semantic"] == human["layout"] == "pass"
                      and all(check["status"] == "pass" for check in automatic["checks"])
                      else "not_accepted",
        "limitations": ["No API calls, OCR, credential access or automatic semantic scoring.",
                        "A page override describes only that selection, not the default multi-page corpus run.",
                        "Single-language mono output only; dual-page output needs separate review.",
                        "Protection is checked only for explicitly supplied boxes; absence is unassessed.",
                        "Extraction and embedding do not prove reading order, glyph visibility or visual fidelity."],
    }


def main():
    """Write a reviewable JSON report even when translation artifacts are missing."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--pages", help="Override translated pages, e.g. 1,2-4")
    parser.add_argument("--regions", type=Path, help="JSON list of page/bbox protection definitions")
    parser.add_argument("--review", type=Path, help="Explicit human evidence JSON; no engine manifest is read")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--write-review-template", type=Path)
    parser.add_argument("--require-acceptance", action="store_true", help="Opt-in exit 1 for unaccepted reports")
    args = parser.parse_args()
    try:
        case = next(case for case in read_json(CORPUS)["cases"] if case["id"] == args.case)
        selected = parse_pages(args.pages) if args.pages else None
        regions = read_json(args.regions) if args.regions else []
        review = read_json(args.review) if args.review else None
        if not isinstance(regions, list) or (review is not None and not isinstance(review, dict)):
            raise ValueError("Regions must be a list and review must be an object")
        inputs = {path.resolve() for path in (args.source, args.output, args.review, args.regions, CORPUS) if path}
        outputs = [path.resolve() for path in (args.report, args.write_review_template) if path]
        if any(path in inputs for path in outputs) or len(outputs) != len(set(outputs)):
            raise ValueError("Report/template destinations must not overwrite inputs or each other")
        report = build_report(case, args.source, args.output, selected, regions, review)
        if args.write_review_template:
            args.write_review_template.parent.mkdir(parents=True, exist_ok=True)
            # Refuse to overwrite existing human work when refreshing artifact hashes.
            with args.write_review_template.open("x", encoding="utf-8") as stream:
                json.dump(review_template(report["source"], report["output"], case), stream, ensure_ascii=False, indent=2)
                stream.write("\n")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (StopIteration, OSError, ValueError, TypeError) as error:
        parser.error(f"Invalid case or review input: {error}")
    print(f"Report: {args.report.resolve()}; structural={report['automatic']['status']}; "
          f"semantic={report['human']['semantic']}; acceptance={report['acceptance']}")
    return int(args.require_acceptance and report["acceptance"] != "accepted")


if __name__ == "__main__":
    raise SystemExit(main())
