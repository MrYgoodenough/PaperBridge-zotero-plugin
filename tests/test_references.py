import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from references import heading_kind, reference_regions


@pytest.mark.parametrize("heading",["References","R EFERENCES","VII. References","7 References","Bibliography","L ITERATURE CITED","参考文献"])
def test_reference_headings(heading):
    assert heading_kind(heading)=="start"


def test_body_mentions_are_not_reference_headings():
    assert heading_kind("See References for details") is None
    assert heading_kind("Appendix A provides the full result") is None
    assert heading_kind("A. Smith and B. Jones, Learning from Images, 2024.") is None


def test_single_column_references_stop_at_appendix():
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
    source=Path(__file__).resolve().parents[1] / ".cache/references/pi0-v3.pdf"
    if not source.exists():
        pytest.skip("Reference PDF not present")
    with pymupdf.open(source) as doc:
        boxes=reference_regions(doc)
        assert set(boxes)=={11,12,13,14}
        assert len(boxes[11])==2 and boxes[11][0][1]>480 and boxes[11][1][1]==0
        assert all(box[1]==0 and box[3]==doc[12].rect.height for box in boxes[12])
        assert len(boxes[14])==1 and boxes[14][0][3]<294
