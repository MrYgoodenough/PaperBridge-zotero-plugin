"""Check source-vector preservation without treating bibliographic metadata as body prose."""
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from preserve import restore_regions, exclude_protected_characters, metadata_regions
from types import SimpleNamespace


def test_graphic_labels_are_excluded_before_translation():
    """Remove only protected graphic characters from the translator's input."""
    def char(x, y):
        """Represent a small IL character without initializing the full engine."""
        return SimpleNamespace(box=SimpleNamespace(x=x, y=y, x2=x+4, y2=y+4))
    figure, body = char(100, 350), char(100, 100)
    page = SimpleNamespace(pdf_character=[figure, body])
    assert exclude_protected_characters(page, 500, [(50,80,350,210)]) == 1
    assert page.pdf_character == [body]


def test_original_vector_labels_restored_without_changing_body(tmp_path):
    """Restore exact source vectors without overwriting translated body text."""
    original, translated, output = [tmp_path / name for name in ["source.pdf", "translated.pdf", "protected.pdf"]]
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=500)
    page.draw_rect((50, 80, 350, 210), fill=(0.9, 0.95, 1))
    page.insert_text((80, 130), "E = mc2 | Accuracy = 97.8%", fontsize=14)
    page.insert_text((60, 330), "Original body", fontsize=14)
    doc.save(original)
    doc.close()
    with pymupdf.open(original) as doc:
        page = doc[0]
        page.add_redact_annot((40, 70, 360, 220))
        page.add_redact_annot((40, 300, 360, 350))
        page.apply_redactions()
        page.insert_text((80, 130), "Garbled figure label", fontsize=14)
        page.insert_text((60, 330), "Translated body", fontsize=14)
        doc.save(translated)
    assert restore_regions(original, translated, output, {0:[(50,80,350,210)]}) == 1
    with pymupdf.open(original) as source, pymupdf.open(output) as target:
        clip = pymupdf.Rect(52, 82, 348, 208)
        assert source[0].get_pixmap(clip=clip).samples == target[0].get_pixmap(clip=clip).samples
        text = target[0].get_text()
        assert "Translated body" in text and "E = mc2" in text
        assert "Garbled figure label" not in text
        assert target[0].rect == source[0].rect


def test_bibliographic_metadata_does_not_protect_title_or_body():
    """Require paired email/bold names and italic affiliations before an explicit abstract."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((80, 80), "Scientific title", fontname="hebo", fontsize=16)
        page.insert_text((80, 125), "Alice Researcher", fontname="hebo", fontsize=11)
        page.insert_text((350, 125), "alice@example.org", fontsize=10)
        page.insert_text((80, 145), "Institute of Science, France", fontname="heit", fontsize=10)
        page.insert_text((80, 220), "Abstract", fontname="hebo", fontsize=12)
        page.insert_text((80, 250), "Body claims must remain translatable.", fontsize=11)
        page.insert_text((80, 740), "© 2026 Alice Researcher", fontsize=8)
        boxes = metadata_regions(doc)[0]
        texts = [page.get_text(clip=pymupdf.Rect(box)).strip() for box in boxes]
        assert len(boxes) == 2
        assert any("Alice Researcher" in text and "Institute of Science" in text for text in texts)
        assert any("© 2026" in text for text in texts)
        assert all("Scientific title" not in text and "Body claims" not in text for text in texts)
        # A body email without the opening author style is not a preservation signal.
        page.insert_text((80, 275), "Contact support@example.org for data.", fontsize=11)
        assert metadata_regions(doc)[0] == boxes
