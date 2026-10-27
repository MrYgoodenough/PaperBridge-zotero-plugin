import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from preserve import restore_regions, exclude_protected_characters
from types import SimpleNamespace


def test_graphic_labels_are_excluded_before_translation():
    def char(x, y):
        return SimpleNamespace(box=SimpleNamespace(x=x, y=y, x2=x+4, y2=y+4))
    figure, body = char(100, 350), char(100, 100)
    page = SimpleNamespace(pdf_character=[figure, body])
    assert exclude_protected_characters(page, 500, [(50,80,350,210)]) == 1
    assert page.pdf_character == [body]


def test_original_vector_labels_restored_without_changing_body(tmp_path):
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
