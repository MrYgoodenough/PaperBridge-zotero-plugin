"""Core review contracts use synthetic PDFs only, never paid translations or semantic scores."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pymupdf
import pytest

# Import the standalone entry point without invoking its command-line interface.
ROOT = Path(__file__).resolve().parents[1]
# Minimal two-page fixture metadata is not a public-paper acceptance result.
CASE = {
    "id": "synthetic-unit-test", "expected_source_pages": 2, "selected_pages": [1],
    "manual_checks": [
        {"id": "accuracy", "category": "semantic", "page": 1, "focus": "Fixture meaning"},
        {"id": "layout", "category": "layout", "page": 1, "focus": "Fixture appearance"},
    ],
}
# Module loading avoids modifying the service or engine import paths.
SPEC = importlib.util.spec_from_file_location("quality_review", ROOT / "scripts/review_quality.py")
# Shared module exposes report helpers for focused, offline tests.
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)


def make_pdf(path, body="Source fixture text", reference="Reference unchanged", equation="E = mc2"):
    """Build tiny explicitly synthetic PDFs with a protected equation and a real link annotation."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=300, height=300)
        page.insert_text((30, 50), body)
        page.insert_text((30, 140), equation)
        page = doc.new_page(width=300, height=300)
        page.insert_text((30, 50), reference)
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(30, 60, 100, 80),
                          "uri": "https://example.org/reference"})
        doc.save(path)
    return path


def test_missing_output_still_inspects_source_and_stays_unaccepted(tmp_path):
    """Missing real translations must not prevent independent structural inspection."""
    source = make_pdf(tmp_path / "source.pdf")
    report = REVIEW.build_report(CASE, source, tmp_path / "missing.pdf")
    assert report["source"]["status"] == "inspected"
    assert report["source"]["page_count"] == 2
    assert report["output"]["status"] == "not_evaluated"
    assert report["automatic"]["status"] == "partial"
    assert report["human"]["semantic"] == "not_evaluated"
    assert report["acceptance"] == "not_accepted"


def test_protection_and_unselected_text_are_real_comparisons(tmp_path):
    """Compare actual extracted text, fonts, link targets and rendered protection pixels."""
    source = make_pdf(tmp_path / "source.pdf")
    output = make_pdf(tmp_path / "output.pdf", body="Changed fixture, not a real translation")
    regions = [{"page": 1, "bbox": [20, 120, 150, 150], "label": "equation"}]
    report = REVIEW.build_report(CASE, source, output, regions=regions)
    checks = {row["check"]: row for row in report["automatic"]["checks"]}
    assert checks["page_count"]["status"] == "pass"
    assert checks["unselected_text_preserved"]["status"] == "pass"
    assert checks["source_link_targets_preserved"]["status"] == "pass"
    assert checks["selected_text_changed"]["status"] == "pass"
    assert checks["protected_regions"]["details"][0]["pixels_equal"]
    assert report["output"]["pages"][0]["fonts"]
    assert report["human"]["semantic"] == "not_evaluated"
    changed = make_pdf(tmp_path / "changed.pdf", reference="Changed bibliography", equation="E = wrong")
    report = REVIEW.build_report(CASE, source, changed, regions=regions)
    checks = {row["check"]: row for row in report["automatic"]["checks"]}
    assert checks["unselected_text_preserved"]["status"] == "needs_review"
    assert checks["protected_regions"]["details"][0]["status"] == "needs_review"


def test_human_evidence_is_hash_bound_and_mock_cannot_pass(tmp_path):
    """Exercise judgement bookkeeping, not semantic accuracy of the synthetic fixture."""
    source = REVIEW.inspect_pdf(make_pdf(tmp_path / "source.pdf"))
    output = REVIEW.inspect_pdf(make_pdf(tmp_path / "output.pdf", body="Different fixture"))
    evidence = REVIEW.review_template(source, output, CASE)
    evidence.update(reviewer="Fixture reviewer", reviewed_at="2026-11-14T00:00:00Z")
    evidence["provenance"].update(kind="mock", provider="fixture", model="not-a-model",
                                  prompt_source="unit-test fixture only")
    for item in evidence["items"]:
        item.update(verdict="pass", source_locator="page 1, first line",
                    output_locator="page 1, first line", notes="Bookkeeping fixture only")
    assert REVIEW.human_review(source, output, CASE, evidence)["semantic"] == "not_evaluated"
    # This declared-real branch tests validation only, not the truth of the declaration.
    evidence["provenance"]["kind"] = "real_translation"
    assert REVIEW.human_review(source, output, CASE, evidence)["semantic"] == "pass"
    evidence["items"][0]["verdict"] = "fail"
    assert REVIEW.human_review(source, output, CASE, evidence)["semantic"] == "fail"
    evidence["output_sha256"] = "wrong-artifact"
    assert REVIEW.human_review(source, output, CASE, evidence)["semantic"] == "not_evaluated"


def test_cli_missing_inputs_writes_unassessed_report(tmp_path):
    """The fixed-corpus entry point works with no samples and never reports semantic approval."""
    report_path = tmp_path / "report.json"
    template_path = tmp_path / "review.json"
    command = [sys.executable, str(ROOT / "scripts/review_quality.py"), "--case", "liblinear-2008",
               "--report", str(report_path), "--write-review-template", str(template_path)]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text())
    assert report["automatic"]["status"] == "not_evaluated"
    assert report["acceptance"] == "not_accepted"
    assert all(item["verdict"] == "not_evaluated" for item in json.loads(template_path.read_text())["items"])
    result = subprocess.run(command[:-2] + ["--require-acceptance"], capture_output=True, text=True, check=False)
    assert result.returncode == 1


def test_missing_page_is_not_reported_as_preserved(tmp_path):
    """A shorter output cannot pass unselected text or link preservation by truncating comparison."""
    source = make_pdf(tmp_path / "source.pdf")
    output = tmp_path / "short.pdf"
    with pymupdf.open(source) as doc:
        doc.delete_page(1)
        doc.save(output)
    report = REVIEW.build_report(CASE, source, output)
    checks = {row["check"]: row for row in report["automatic"]["checks"]}
    assert checks["page_count"]["status"] == "needs_review"
    assert checks["unselected_text_preserved"]["details"]["changed_pages"] == [2]
    assert checks["source_link_targets_preserved"]["status"] == "needs_review"


def test_bounded_page_override_keeps_corpus_scope_and_human_review_unassessed(tmp_path):
    """A one-page smoke result must not be mislabeled as the default multi-page corpus run."""
    source = make_pdf(tmp_path / "source.pdf")
    output = make_pdf(tmp_path / "output.pdf", body="Changed fixture, not a real translation")
    case = {**CASE, "selected_pages": [1, 2]}
    report = REVIEW.build_report(case, source, output, selected=[1])
    assert report["selected_pages"] == report["scope"]["translated_pages"] == [1]
    assert report["scope"]["corpus_default_translated_pages"] == [1, 2]
    assert report["scope"]["kind"] == "selected_pages_only"
    assert not report["scope"]["matches_corpus_default"]
    assert not report["scope"]["whole_paper_semantic_acceptance"]
    assert report["human"]["semantic"] == "not_evaluated"
    assert report["acceptance"] == "not_accepted"


def test_malformed_human_fields_remain_unassessed(tmp_path):
    """Bad provenance/items cannot hide available PDF inspection or become approval."""
    source = make_pdf(tmp_path / "source.pdf")
    output = make_pdf(tmp_path / "output.pdf")
    report = REVIEW.build_report(CASE, source, output, review={"provenance": [], "items": [None]})
    assert report["source"]["status"] == "inspected"
    assert report["output"]["status"] == "inspected"
    assert report["human"]["semantic"] == "not_evaluated"
    assert report["acceptance"] == "not_accepted"


@pytest.mark.parametrize("pages,expected", [("1,3-4", [1, 3, 4]), ("2,2", [2])])
def test_page_selection(pages, expected):
    """Page selection is one-based, deterministic and deduplicated."""
    assert REVIEW.parse_pages(pages) == expected


@pytest.mark.parametrize("pages", ["0", "4-2", "x"])
def test_invalid_page_selection(pages):
    """Invalid page selections cannot silently expand or target another page."""
    with pytest.raises(ValueError):
        REVIEW.parse_pages(pages)
