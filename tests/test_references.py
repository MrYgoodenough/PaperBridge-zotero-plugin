"""Verify bibliography boundaries without suppressing later methods or appendix prose."""
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from references import heading_kind, reference_regions


@pytest.mark.parametrize("heading",["References","R EFERENCES","VII. References","7 References","Bibliography","L ITERATURE CITED","参考文献"])
def test_reference_headings(heading):
    """Accept conventional literal bibliography headings, not body mentions."""
    assert heading_kind(heading)=="start"


def test_body_mentions_are_not_reference_headings():
    """Do not reinterpret citations or ordinary references in sentences as headings."""
    assert heading_kind("See References for details") is None
    assert heading_kind("Appendix A provides the full result") is None
    assert heading_kind("A. Smith and B. Jones, Learning from Images, 2024.") is None


def test_single_column_references_stop_at_appendix():
    """Protect only the bibliography preceding the subsequent appendix."""
    with pymupdf.open() as doc:
        page=doc.new_page()
        page.insert_text((50,80),"Main text")
        page.insert_text((50,220),"References")
        page.insert_text((50,250),"[1] Smith. Example reference. 2024.")
        second=doc.new_page()
        second.insert_text((50,80),"[2] Jones. Another reference. 2025.")
        second.insert_text((50,220),"Appendix")
        second.insert_text((50,250),"Additional results must still be translated.")
        boxes=reference_regions(doc)
        assert boxes[0][0][1]>190 and boxes[0][0][3]==doc[0].rect.height
        assert boxes[1][0][1]==0 and boxes[1][0][3]<220


def test_real_two_column_section_and_appendix():
    """Retain the existing two-column real-PDF boundary contract when available."""
    source=Path(__file__).resolve().parents[1] / ".cache/references/pi0-v3.pdf"
    if not source.exists():
        pytest.skip("Reference PDF not present")
    with pymupdf.open(source) as doc:
        boxes=reference_regions(doc)
        assert set(boxes)=={11,12,13,14}
        assert len(boxes[11])==2 and boxes[11][0][1]>480 and boxes[11][1][1]==0
        assert all(box[1]==0 and box[3]==doc[12].rect.height for box in boxes[12])
        assert len(boxes[14])==1 and boxes[14][0][3]<294


@pytest.mark.parametrize("heading", ["STAR+METHODS", "STAR METHODS", "METHOD DETAILS", "KEY RESOURCES TABLE"])
def test_methods_after_references_remain_translatable(heading):
    """Cell/Elsevier methods following references must not inherit bibliography protection."""
    with pymupdf.open() as document:
        first = document.new_page()
        first.insert_text((50, 80), "References")
        first.insert_text((50, 120), "[1] Example reference, 2024.")
        second = document.new_page()
        second.insert_text((50, 80), "[2] Another reference, 2025.")
        second.insert_text((50, 220), heading)
        second.insert_text((50, 260), "Experimental methods must be translated.")
        last = document.new_page()
        last.insert_text((50, 80), "Continuation of the scientific methods.")
        regions = reference_regions(document)
        assert set(regions) == {0, 1}
        assert regions[1][0][3] < 220
