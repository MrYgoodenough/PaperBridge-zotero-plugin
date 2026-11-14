"""Check the font alias cause of incorrect Chinese copy/search without a system-font fixture."""
from types import SimpleNamespace

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
