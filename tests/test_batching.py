"""Core source ownership and line-break regressions using BabelDOC 0.6.4 IL."""

import sys
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import engine
engine.localize_cache()
from babeldoc.format.pdf.document_il import Box, Page, PageLayout, PdfCharacter, PdfParagraph, PdfStyle, VisualBbox
from babeldoc.format.pdf.document_il.midend import paragraph_finder
from babeldoc.format.pdf.document_il.midend.typesetting import Typesetting, TypesettingUnit
from babeldoc.format.pdf.document_il.utils.layout_helper import build_layout_index
from batching import source_character_layout


def character(text, box, visual=None):
    """Build one source glyph without translating or synthesizing provider results."""
    return PdfCharacter(char_unicode=text, pdf_character_id=ord(text), xobj_id=0,
                        pdf_style=PdfStyle(font_id="body", font_size=8), box=Box(*box),
                        visual_bbox=VisualBbox(Box(*(visual or box))))


def grouped(page):
    """Use the pinned grouping method and the import-installed source selector."""
    index, mapping = build_layout_index(page)
    finder = paragraph_finder.ParagraphFinder.__new__(paragraph_finder.ParagraphFinder)
    return finder._group_characters_into_paragraphs(page, index, mapping)


def test_nested_caption_boxes_keep_the_word_tail_and_next_line_together():
    """Dropout's nested Figure 7 detections must not make fied an independent short paragraph."""
    glyphs = [character(text, (x, y, x + 3, y + 7))
              for text, x, y in (("F", 90, 250), ("r", 503, 250), ("f", 509, 250),
                                  ("i", 513, 250), ("e", 516, 250), ("d", 519, 250), ("l", 138, 235))]
    page = Page(pdf_character=glyphs.copy(), page_layout=[
        PageLayout(box=Box(138, 234, 511, 260), id=9, class_name="figure_caption"),
        PageLayout(box=Box(87, 233, 524, 260), id=10, class_name="figure_caption"),
        PageLayout(box=Box(150, 234, 523, 260), id=11, class_name="figure_caption")])
    paragraphs = grouped(page)
    assert len(paragraphs) == 1 and paragraphs[0].layout_id == 10
    assert [c.pdf_character for c in paragraphs[0].pdf_paragraph_composition] == glyphs
    assert not page.pdf_character


def test_measured_doi_line_keeps_punctuation_across_a_title_edge():
    """eLife p12's real full-source boxes put a DOI dot above the body detector's upper edge."""
    glyphs = [character("i", (467.8749, 561.4351, 469.7949, 569.4351),
                        (468.4749, 561.4351, 469.1949, 566.9551)),
              character(".", (469.7949, 561.4351, 471.8749, 569.4351)),
              character("o", (471.8749, 561.4351, 476.6269, 569.4351),
                        (472.3069, 561.3391, 476.1949, 565.2271))]
    page = Page(pdf_character=glyphs.copy(), page_layout=[
        PageLayout(box=Box(375, 539, 575, 568), id=8, class_name="plain text"),
        PageLayout(box=Box(375, 568, 516, 579), id=17, class_name="title"),
        PageLayout(box=Box(378.3709, 559.5151, 569.2661, 569.4351), id=57, class_name="fallback_line")])
    paragraphs = grouped(page)
    assert len(paragraphs) == 1 and paragraphs[0].layout_id == 8
    assert [c.pdf_character for c in paragraphs[0].pdf_paragraph_composition] == glyphs


@pytest.mark.parametrize("other_class", ["title", "isolate_formula"])
def test_real_title_or_formula_is_not_reassigned_by_a_body_line(other_class):
    """A real title line or higher-priority formula keeps its original owner."""
    glyph = character("x", (430, 569, 433, 577))
    page = Page(page_layout=[PageLayout(box=Box(375, 539, 575, 578), id=8, class_name="plain text"),
                            PageLayout(box=Box(375, 568, 516, 579), id=17, class_name=other_class),
                            PageLayout(box=Box(378, 569, 514, 577), id=55, class_name="fallback_line")])
    index, mapping = build_layout_index(page)
    assert source_character_layout(glyph, index, mapping).name == other_class


def layout_text(text, width):
    """Run the pinned layout loop on real font metrics without any provider or output PDF."""
    font = pymupdf.Font("helv")
    style = PdfStyle(font_id="base", font_size=10)
    units = [TypesettingUnit(unicode=char, font=font, font_size=10, style=style, xobj_id=0)
             for char in text]
    typesetter = Typesetting.__new__(Typesetting)
    typesetter.font_mapper = SimpleNamespace(base_font=font)
    placed, fits = typesetter._layout_typesetting_units(
        units, Box(0, 0, width, 100), 1, 1.2, PdfParagraph(first_line_indent=False))
    assert fits
    lines = {}
    for unit in placed:
        lines.setdefault(unit.y, []).append(unit.try_get_unicode())
    return ["".join(chars) for chars in lines.values()]


def test_word_lookahead_does_not_count_the_current_glyph_twice():
    """BART's m is wider than a; repeated lookahead must not split a word that fits."""
    # The small remaining margin fits the whole word but not a second copy of its last glyph.
    width = pymupdf.Font("helv").text_length("We aim", fontsize=10) + 6
    assert layout_text("We aim", width) == ["We aim"]


def test_url_punctuation_breaks_without_making_latin_word_joiners_breakable():
    """The NIH URL wraps horizontally while normal hyphens, apostrophes and middle dots stay joined."""
    url = "https://orwh.od.nih.gov/sex-gender/nih-policy-sex-biological-variable"
    assert layout_text(url, 190) == ["https://orwh.od.nih.gov/sex-gender/",
                                    "nih-policy-sex-biological-variable"]
    font = pymupdf.Font("helv")
    style = PdfStyle(font_id="base", font_size=10)
    for char in ":/.,-'·":
        unit = TypesettingUnit(unicode=char, font=font, font_size=10, style=style, xobj_id=0)
        assert unit.can_break_line is (char in ":/.,")
