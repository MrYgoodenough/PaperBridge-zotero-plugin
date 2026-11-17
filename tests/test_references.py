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


def test_three_column_references_do_not_protect_left_body():
    """A middle-column bibliography must not absorb the preceding scientific column."""
    with pymupdf.open() as document:
        page = document.new_page(width=594, height=783)
        for x in (45, 219, 393):
            for y in range(60, 361, 30):
                page.insert_text((x, y), "Ordinary body text stays translatable.", fontsize=9)
        page.insert_text((219, 200), "References", fontsize=9)
        regions = reference_regions(document)
        assert len(regions[0]) == 2
        assert not any(pymupdf.Point(100, 300) in pymupdf.Rect(box) for box in regions[0])
        assert any(pymupdf.Point(250, 250) in pymupdf.Rect(box) for box in regions[0])
        assert any(pymupdf.Point(450, 100) in pymupdf.Rect(box) for box in regions[0])


def test_shifted_columns_keep_later_right_references_active():
    """Left acknowledgements precede right references even when their y position is lower."""
    with pymupdf.open() as document:
        first = document.new_page(width=612, height=792)
        for x in (168, 378):
            for y in range(60, 631, 30):
                first.insert_text((x, y), "Ordinary body text stays translatable.", fontsize=9)
        first.insert_text((168, 420), "Acknowledgements", fontsize=9)
        first.insert_text((378, 100), "Funding", fontsize=9)
        first.insert_text((378, 330), "Data availability", fontsize=9)
        first.insert_text((378, 366), "References", fontsize=9)
        second = document.new_page(width=612, height=792)
        for x in (168, 378):
            for y in range(60, 631, 30):
                second.insert_text((x, y), "Continuing reference entry, 2025.", fontsize=9)
        regions = reference_regions(document)
        assert set(regions) == {0, 1}
        assert len(regions[0]) == 1 and regions[0][0][0] > 316
        assert not any(pymupdf.Point(210, 390) in pymupdf.Rect(box) for box in regions[0])
        assert not any(pymupdf.Point(420, 100) in pymupdf.Rect(box) for box in regions[0])
        assert any(pymupdf.Point(420, 400) in pymupdf.Rect(box) for box in regions[0])
        assert len(regions[1]) == 2 and all(box[1] == 0 for box in regions[1])


def test_references_below_both_columns_do_not_absorb_earlier_endmatter():
    """A shared lower bibliography band follows, rather than precedes, right-column prose."""
    with pymupdf.open() as document:
        first = document.new_page(width=612, height=792)
        for x in (50, 320):
            for y in range(80, 651, 30):
                first.insert_text((x, y), "Scientific results remain translatable.", fontsize=9)
            for y in (710, 740, 770):
                first.insert_text((x, y), "Author et al. Reference entry, 2025.", fontsize=9)
        first.insert_text((320, 200), "Data availability", fontsize=9)
        first.insert_text((320, 290), "Author contributions", fontsize=9)
        first.insert_text((320, 380), "Funding", fontsize=9)
        first.insert_text((50, 680), "References", fontsize=9)
        second = document.new_page(width=612, height=792)
        for x in (50, 320):
            for y in range(80, 651, 30):
                second.insert_text((x, y), "Author et al. Continuing reference, 2025.", fontsize=9)
        regions = reference_regions(document)
        assert set(regions) == {0, 1}
        assert len(regions[0]) == 2 and all(box[1] > 660 for box in regions[0])
        assert not any(pymupdf.Point(400, 250) in pymupdf.Rect(box) for box in regions[0])
        assert all(any(pymupdf.Point(x, 750) in pymupdf.Rect(box) for box in regions[0])
                   for x in (100, 400))
        assert len(regions[1]) == 2 and all(box[1] == 0 for box in regions[1])


def test_right_column_methods_still_stop_left_column_references():
    """Earlier y does not move a later-column Methods section before continuous references."""
    with pymupdf.open() as document:
        first = document.new_page(width=612, height=792)
        for y in range(80, 441, 30):
            first.insert_text((50, y), "Scientific results remain translatable.", fontsize=9)
        first.insert_text((50, 470), "References", fontsize=9)
        for y in range(500, 771, 30):
            first.insert_text((50, y), "Author et al. Reference entry, 2025.", fontsize=9)
        for y in (80, 110, 140):
            first.insert_text((320, y), "Author et al. Continuing reference, 2025.", fontsize=9)
        first.insert_text((320, 200), "STAR+METHODS", fontsize=9)
        for y in range(230, 771, 30):
            first.insert_text((320, y), "Scientific methods remain translatable.", fontsize=9)
        second = document.new_page(width=612, height=792)
        second.insert_text((50, 80), "Continuation of scientific methods.", fontsize=9)
        regions = reference_regions(document)
        assert set(regions) == {0}
        assert any(pymupdf.Point(400, 100) in pymupdf.Rect(box) for box in regions[0])
        assert not any(pymupdf.Point(400, 300) in pymupdf.Rect(box) for box in regions[0])


def test_single_column_hanging_indents_do_not_create_columns():
    """Different left indents with overlapping text widths remain one reading column."""
    with pymupdf.open() as document:
        page = document.new_page()
        for y in range(60, 211, 30):
            page.insert_text((168, y), "Long scientific prose occupies the same wide text column.", fontsize=9)
        page.insert_text((36, 280), "References", fontsize=9)
        for y in range(310, 581, 30):
            page.insert_text((56, y), "Reference entry with authors and a long journal title, 2024.", fontsize=9)
        regions = reference_regions(document)
        assert len(regions[0]) == 1
        assert regions[0][0][0] == 0 and regions[0][0][2] == page.rect.width


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
