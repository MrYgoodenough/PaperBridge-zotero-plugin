"""Check the font alias cause of incorrect Chinese copy/search without a system-font fixture."""
from types import SimpleNamespace
import io

import pymupdf

from backend import fonts
from backend.fonts import _normalize_cmap


def test_same_glyph_aliases_do_not_override_canonical_unicode():
    """Drop duplicate compatibility aliases but preserve genuinely distinct regional glyphs."""
    cmap = {0x20: "space", 0xA0: "space", 0x2D: "hyphen", 0xAD: "hyphen", 0x2011: "hyphen",
            0x5668: "vessel", 0xFA38: "vessel", 0x4E0D: "not", 0xF967: "regional-not"}
    table = SimpleNamespace(cmap=cmap, isUnicode=lambda: True)
    font = {"cmap": SimpleNamespace(tables=[table])}
    assert _normalize_cmap(font) == 4
    assert cmap == {0x20: "space", 0x2D: "hyphen", 0x5668: "vessel", 0x4E0D: "not", 0xF967: "regional-not"}
    assert _normalize_cmap(font) == 0


def test_subset_local_program_keeps_publisher_encoding_and_visible_glyphs(tmp_path, monkeypatch):
    """Only the locally named full font shrinks; publisher dictionaries and all glyphs stay exact."""
    monkeypatch.setattr(fonts, "FONT_DIR", tmp_path)
    local = pymupdf.Font("china-s").buffer
    (tmp_path / fonts.NAMES["regular"]).write_bytes(local)
    with pymupdf.open() as source, pymupdf.open() as target:
        source.new_page().insert_text((40, 40), "Publisher header")
        page = target.new_page()
        page.insert_font(fontname="Publisher", fontbuffer=pymupdf.Font("helv").buffer)
        page.insert_text((40, 40), "Publisher header", fontname="Publisher")
        page.insert_font(fontname=fonts.NAMES["regular"], fontbuffer=local)
        page.insert_text((40, 80), "Chinese text: 中文翻译", fontname=fonts.NAMES["regular"])
        publisher = next(font[0] for font in page.get_fonts() if font[4] == "Publisher")
        original_object = target.xref_object(publisher)
        original_program = target.extract_font(publisher)[-1]
        original_text = page.get_text()
        original_pixels = page.get_pixmap().samples
        assert fonts.subset_songti(target, source) > 0
        assert target.xref_object(publisher) == original_object
        assert target.extract_font(publisher)[-1] == original_program
        target.save(tmp_path / "subset.pdf", garbage=4, deflate=True)
    with pymupdf.open(tmp_path / "subset.pdf") as result:
        assert result[0].get_text() == original_text
        assert result[0].get_pixmap().samples == original_pixels
        assert result[0].search_for("中文翻译")


def test_full_font_already_owned_by_source_is_not_subset(tmp_path, monkeypatch):
    """A matching source font program remains untouched even if our resource reuses that face."""
    monkeypatch.setattr(fonts, "FONT_DIR", tmp_path)
    local = pymupdf.Font("china-s").buffer
    (tmp_path / fonts.NAMES["regular"]).write_bytes(local)
    with pymupdf.open() as source, pymupdf.open() as target:
        page = source.new_page()
        page.insert_font(fontname="Original", fontbuffer=local)
        page.insert_text((40, 40), "Original source 中文", fontname="Original")
        page = target.new_page()
        page.insert_font(fontname=fonts.NAMES["regular"], fontbuffer=local)
        page.insert_text((40, 40), "Translated 中文", fontname=fonts.NAMES["regular"])
        xref = page.get_fonts()[0][0]
        before = target.xref_object(xref)
        assert fonts.subset_songti(target, source) == 0
        assert target.extract_font(xref)[-1] == local
        assert target.xref_object(xref) == before


def test_implicit_symbol_font_keeps_rendering_and_repairs_source_parsing():
    """Standard Symbol glyphs retain their pixels but no longer decode as zero-width Latin letters."""
    from babeldoc.pdfminer.pdfdocument import PDFDocument
    from babeldoc.pdfminer.pdfinterp import PDFResourceManager
    from babeldoc.pdfminer.pdfpage import PDFPage
    from babeldoc.pdfminer.pdfparser import PDFParser
    from babeldoc.pdfminer.pdftypes import dict_value

    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((40, 40), "Lls", fontname="symb")
        # The real JMLR producer omits Encoding; MuPDF's synthetic producer writes it explicitly.
        xref = page.get_fonts()[0][0]
        document.xref_set_key(xref, "Encoding", "null")
        before_text = page.get_text()
        before_pixels = page.get_pixmap().samples
        assert fonts.normalize_symbol_encoding(document) == 1
        assert fonts.normalize_symbol_encoding(document) == 0
        assert page.get_text() == before_text
        assert page.get_pixmap().samples == before_pixels
        parsed = PDFDocument(PDFParser(io.BytesIO(document.tobytes())))
        pdf_page = next(PDFPage.create_pages(parsed))
        resource = next(iter(dict_value(pdf_page.resources["Font"]).values()))
        font = PDFResourceManager().get_font(resource.objid, dict_value(resource))
        assert [font.to_unichr(code) for code in (76, 108, 115)] == ["Λ", "λ", "σ"]
        assert all(font.char_width(code) > 0 for code in (76, 108, 115))
