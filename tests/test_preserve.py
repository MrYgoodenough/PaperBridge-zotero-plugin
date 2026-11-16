"""Check source-vector preservation without treating bibliographic metadata as body prose."""
import sys
from pathlib import Path

import pymupdf
import pytest

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


@pytest.mark.parametrize("nonzero_origin", [False, True])
def test_inline_abstract_indexed_authors_and_running_furniture(nonzero_origin):
    """Ordinary publisher metadata is preserved without excluding adjacent research prose."""
    with pymupdf.open() as doc:
        for index in range(2):
            page = doc.new_page(width=600, height=800)
            if nonzero_origin:
                page.set_mediabox(pymupdf.Rect(8, 8, 608, 808))
            page.insert_text((40, 24), "www.publisher.test/journal" + ("/" if index else ""), fontsize=8)
            page.insert_text((40, 760), f"Journal 12, 2024 | page {index + 1}", fontsize=8)
            page.insert_text((40, 420), "Research body: contact support@example.org for the experiment.", fontsize=11)
            if index == 0:
                page.insert_text((40, 38), "Contents lists available at Publisher", fontsize=8)
                page.insert_text((40, 51), "Journal homepage: publisher.test", fontsize=8)
                page.insert_text((40, 55), "Date of publication 10 November 2024", fontsize=8)
                page.insert_text((40, 66), "Article", fontsize=8)
                page.insert_text((40, 85), "Scientific research title", fontsize=19)
                page.insert_text((40, 130), "ALICE RESEARCHER, BOB AUTHOR", fontname="hebo", fontsize=11)
                page.insert_text((40, 148), "1Key Laboratory of Physics, Example University", fontsize=9)
                page.insert_text((40, 166), "Corresponding author: Alice (alice@example.org)", fontsize=9)
                page.insert_text((40, 235), "ABSTRACT This research remains translatable.", fontsize=11)
                page.insert_text((40, 725), "2024 The Authors. This work is licensed under Creative Commons.", fontsize=8)
                page.insert_text((40, 738), "For more information, see https://creativecommons.org/licenses/by/4.0/", fontsize=8)
        regions = metadata_regions(doc)
        protected = "\n".join(doc[0].get_text(clip=pymupdf.Rect(box)) for box in regions[0])
        assert "ALICE RESEARCHER" in protected and "1Key Laboratory" in protected
        assert "alice@example.org" in protected and "Creative Commons" in protected
        assert "www.publisher.test/journal" in protected
        assert "Contents lists available" in protected and "Journal homepage" in protected
        assert "Article" in protected
        assert "Date of publication" in protected
        assert "Scientific research title" not in protected and "ABSTRACT" not in protected
        assert "Research body" not in protected and "support@example.org" not in protected
        assert len(regions[1]) == 2, "Only repeated header/footer, never a body email, is preserved"


def test_margin_notice_and_unindexed_affiliation_leave_abstract_translatable():
    """Preserve observed Nature/Science metadata without swallowing the research abstract."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((80, 85), "Research title", fontsize=20)
        page.insert_text((215, 135), "Alice Researcher & Bob Author", fontsize=9)
        page.insert_text((215, 190), "Numerical results, methods and their scientific interpretation.", fontsize=9)
        page.insert_text((40, 710), "Department of Physics, Example University", fontsize=8)
        # Standard test fonts cannot encode a zero-width-space glyph; keep actual email text.
        page.insert_text((40, 724), "e-mail: author@example.org", fontsize=8)
        page.insert_text((492, 65), "Copyright © 2024", fontsize=7)
        page.insert_text((492, 77), "The Authors", fontsize=7)
        page.insert_text((80, 420), "The example mentions © 2024 but remains research body.", fontsize=10)
        regions = metadata_regions(doc)[0]
        protected = "\n".join(page.get_text(clip=pymupdf.Rect(box)) for box in regions)
        assert "Alice Researcher" in protected and "Department of Physics" in protected
        assert "Copyright © 2024" in protected
        assert "Research title" not in protected and "Numerical results" not in protected
        assert "The example" not in protected


def test_preceding_affiliation_requires_names_not_comma_separated_body():
    """Small type and a 17-point affiliation gap do not turn ordinary prose into authors."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 80), "Research title", fontsize=20)
        # Elsevier's genuine names need not carry the bold font flag.
        page.insert_text((40, 130), "Alice Researcher, Bob Author", fontsize=10)
        page.insert_text((40, 160), "Department of Physics, Example University", fontsize=8)
        page.insert_text((40, 174), "e-mail: author@example.org", fontsize=8)
        for y, body in [(230, "The methods use measurements, not author names."),
                        (535, "Ordinary body methods, not author metadata.\n" * 8)]:
            page.insert_text((40, y), body, fontsize=9)
            block = next(block for block in page.get_text("dict")["blocks"]
                         if block.get("lines") and "".join(
                             span["text"] for line in block["lines"] for span in line["spans"]).startswith(body.splitlines()[0]))
            # Reproduce the Science/wheat gap using measured source bounds, not a target box.
            baseline = block["bbox"][3] + pymupdf.Font("helv").ascender * 8 + 17
            page.insert_text((40, baseline), "Department of Chemistry, Example University", fontsize=8)
            page.insert_text((40, baseline + 14), "e-mail: other@example.org", fontsize=8)
        protected = "\n".join(page.get_text(clip=pymupdf.Rect(box)) for box in metadata_regions(doc)[0])
        assert "Alice Researcher, Bob Author" in protected and "Department of Physics" in protected
        assert "The methods" not in protected and "Ordinary body" not in protected


def test_publication_history_preserves_complete_source_block_not_body():
    """DOI/date continuations are metadata; prose mentioning received samples is not."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 420), "Received 26 July 2024 samples, accepted according to the protocol.", fontsize=9)
        history = ("https://doi.org/10.1016/j.csbj.2024.11.032\n"
                   "Received 26 July 2024; Received in revised form 20 November 2024;\n"
                   "Accepted 20 November 2024")
        page.insert_text((40, 695), history, fontsize=8)
        page.insert_text((40, 745), "Copyright © 2024 The Authors. Licensed under Creative Commons.", fontsize=8)
        source_box = next(tuple(block["bbox"]) for block in page.get_text("dict")["blocks"]
                          if block.get("lines") and "https://doi.org/" in "".join(
                              span["text"] for line in block["lines"] for span in line["spans"]))
        boxes = metadata_regions(doc)[0]
        assert source_box in boxes, "Preserve the full measured block, not just its DOI or first date"
        protected = "\n".join(page.get_text(clip=pymupdf.Rect(box)) for box in boxes)
        assert "Accepted 20 November 2024" in protected and "Creative Commons" in protected
        assert "samples" not in protected


def test_adjacent_history_and_legal_restored_once_without_clipped_letters(tmp_path):
    """Overlapping padded source clips must not repaint a neighboring date's glyph edges."""
    original, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "protected.pdf")]
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 690), "https://doi.org/10.1016/j.example\nReceived 26 July 2024; Accepted 20 November 2024", fontsize=8)
        history_box = tuple(page.get_text("dict")["blocks"][0]["bbox"])
        # Elsevier-05 has only 0.237 pt between these source blocks; keep the same close shape.
        legal_baseline = history_box[3] + pymupdf.Font("helv").ascender * 8 + 0.25
        page.insert_text((40, legal_baseline), "Copyright © 2024 The Authors, licensed by Example.\nhttps://creativecommons.org/licenses/by/4.0/", fontsize=8)
        legal_lines = [line for block in page.get_text("dict")["blocks"] for line in block["lines"]
                       if "".join(span["text"] for span in line["spans"]).startswith(("Copyright", "https://creativecommons"))]
        legal_rectangle = pymupdf.Rect(legal_lines[0]["bbox"]) | pymupdf.Rect(legal_lines[1]["bbox"])
        legal_box = tuple(legal_rectangle)
        page.insert_text((40, 420), "Original body", fontsize=11)
        doc.save(original)
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 420), "Translated body", fontsize=11)
        doc.save(translated)
    assert restore_regions(original, translated, output, {0: [history_box, legal_box]}) == 1
    with pymupdf.open(original) as source, pymupdf.open(output) as target:
        clip = (pymupdf.Rect(history_box) | pymupdf.Rect(legal_box)) + (-1, -1, 1, 1)
        matrix = pymupdf.Matrix(2, 2)
        assert source[0].get_pixmap(matrix=matrix, clip=clip).samples == target[0].get_pixmap(matrix=matrix, clip=clip).samples
        assert "Accepted 20 November 2024" in target[0].get_text(clip=clip)
        assert "Translated body" in target[0].get_text() and "Original body" not in target[0].get_text()


def test_touching_reference_columns_do_not_restore_unprotected_acknowledgments(tmp_path):
    """Elsevier's L-shaped bibliography must not absorb the translated top-left body."""
    original, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "protected.pdf")]
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 70), "Original acknowledgments", fontsize=11)
        page.insert_text((310, 100), "Original right bibliography", fontsize=9)
        page.insert_text((40, 300), "Original left bibliography", fontsize=9)
        page.insert_text((380, 40), "Original running header", fontsize=8)
        doc.save(original)
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((40, 70), "Translated acknowledgments", fontsize=11)
        doc.save(translated)
    regions = {0: [(0, 162.5, 300, 800), (300, 0, 600, 800), (368, 33, 558, 44)]}
    assert restore_regions(original, translated, output, regions) == 2
    with pymupdf.open(output) as doc:
        text = doc[0].get_text()
        assert "Translated acknowledgments" in text and "Original acknowledgments" not in text
        assert "Original right bibliography" in text and "Original left bibliography" in text
