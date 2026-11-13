"""Exercise link annotations in the existing vector-restoration writeout path."""
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from preserve import restore_regions

# Use one protected figure and a separate body anchor on a small legal page.
FIGURE = (40, 40, 260, 130)
FIGURE_ANCHOR = (55, 65, 135, 85)
BODY_ANCHOR = (55, 175, 135, 195)
# A moved body link represents an annotation already mapped by the PDF producer.
MOVED_ANCHOR = (55, 225, 135, 245)


def create_source(path):
    """Create two pages with URI and internal links, without external resources."""
    with pymupdf.open() as document:
        for index in range(2):
            page = document.new_page(width=300, height=300)
            page.insert_text((55, 80), f"Figure {index}")
            page.insert_text((55, 190), f"Original body {index}")
        for index in range(2):
            page = document[index]
            page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(FIGURE_ANCHOR),
                              "uri": f"https://example.org/figure/{index}"})
            page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(BODY_ANCHOR),
                              "uri": f"https://example.org/body/{index}"})
        document[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(150, 65, 230, 85),
                                 "page": 1, "to": pymupdf.Point(55, 70), "zoom": 1.5})
        document[1].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(150, 175, 230, 195),
                                 "page": 0, "to": pymupdf.Point(55, 180)})
        document.save(path)


def create_translation(source, path, strip_links=False):
    """Move selected body text, optionally simulating stripped upstream annotations."""
    with pymupdf.open(source) as document:
        if strip_links:
            for page in document:
                for link in page.get_links():
                    page.delete_link(link)
        page = document[0]
        page.add_redact_annot((40, 170, 250, 205))
        page.apply_redactions()
        # Recreate the inherited annotation removed by this fixture's text redaction.
        if not strip_links:
            page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(BODY_ANCHOR),
                              "uri": "https://example.org/body/0"})
        page.insert_text((55, 240), "Reflowed translated body")
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(MOVED_ANCHOR),
                          "uri": "https://example.org/body/0"})
        document.save(path)


@pytest.mark.parametrize("strip_links", [False, True])
def test_preserved_and_unselected_links_survive_without_stale_body_hotspots(tmp_path, strip_links):
    """Recover protected/untouched links but retain the producer's moved body link."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    create_translation(source, translated, strip_links)
    restore_regions(source, translated, output, {0: [FIGURE]})
    with pymupdf.open(output) as document:
        links = document[0].get_links()
        assert len(links) == 3
        assert {(link.get("uri"), tuple(link["from"])) for link in links if link["kind"] == pymupdf.LINK_URI} == {
            ("https://example.org/figure/0", FIGURE_ANCHOR),
            ("https://example.org/body/0", MOVED_ANCHOR),
        }
        internal = next(link for link in links if link["kind"] == pymupdf.LINK_GOTO)
        assert internal["page"] == 1
        assert internal["to"] == pymupdf.Point(55, 70)
        # PyMuPDF 1.26.7's get_links reports zoom=0 even when the actual XYZ view has a zoom.
        assert document.xref_get_key(internal["xref"], "A/D") == (
            "array", f"[{document.page_xref(1)} 0 R/XYZ 55 230 1.5]")
        assert len(document[1].get_links()) == 3
        assert "Reflowed translated body" in document[0].get_text()


def test_selected_page_without_protected_regions_still_drops_old_anchor(tmp_path):
    """An empty region list means translated, not an untouched page."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    create_translation(source, translated)
    restore_regions(source, translated, output, {0: []})
    with pymupdf.open(output) as document:
        assert len(document[0].get_links()) == 1
        assert tuple(document[0].get_links()[0]["from"]) == MOVED_ANCHOR


def test_internal_target_in_reflowed_body_is_page_only(tmp_path):
    """A reliable page number must not retain a fabricated exact body destination."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    create_translation(source, translated)
    restore_regions(source, translated, output, {0: [FIGURE]})
    with pymupdf.open(output) as document:
        internal = next(link for link in document[1].get_links() if "view" in link)
        assert internal["page"] == "1" and internal["view"] == "Fit"
        assert document.xref_get_key(internal["xref"], "A/D") == (
            "array", f"[{document.page_xref(0)} 0 R/Fit]")


def test_internal_target_in_restored_region_keeps_exact_destination(tmp_path):
    """A protected destination remains exact even on a selected target page."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    create_translation(source, translated, strip_links=True)
    restore_regions(source, translated, output, {0: [FIGURE], 1: [FIGURE]})
    with pymupdf.open(output) as document:
        internal = next(link for link in document[0].get_links() if link["kind"] == pymupdf.LINK_GOTO)
        assert internal["page"] == 1 and internal["to"] == pymupdf.Point(55, 70)
        assert len(document[1].get_links()) == 1


def test_producer_mapped_destination_is_not_replaced_by_an_old_target(tmp_path):
    """Keep a producer's new destination while degrading a separate inherited one."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    create_translation(source, translated)
    with pymupdf.open(translated) as document:
        document[1].insert_link({"kind": pymupdf.LINK_GOTO,
                                 "from": pymupdf.Rect(150, 225, 230, 245),
                                 "page": 0, "to": pymupdf.Point(55, 230)})
        document.saveIncr()
    restore_regions(source, translated, output, {0: [FIGURE]})
    with pymupdf.open(output) as document:
        links = document[1].get_links()
        mapped = next(link for link in links if tuple(link["from"]) == (150, 225, 230, 245))
        assert mapped["page"] == 0 and mapped["to"] == pymupdf.Point(55, 230)
        assert any(link.get("view") == "Fit" for link in links)


def test_partial_protection_and_overlapping_regions_do_not_create_false_or_duplicate_links(tmp_path):
    """Reject a boundary-straddling hotspot and copy overlapping regions' links once."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    with pymupdf.open(source) as document:
        document[0].insert_link({"kind": pymupdf.LINK_URI,
                                 "from": pymupdf.Rect(55, 120, 135, 150),
                                 "uri": "https://example.org/partial"})
        document.saveIncr()
    create_translation(source, translated, strip_links=True)
    restore_regions(source, translated, output, {0: [FIGURE, (45, 45, 255, 125)]})
    with pymupdf.open(output) as document:
        links = document[0].get_links()
        assert len(links) == 3
        assert all(link.get("uri") != "https://example.org/partial" for link in links)


@pytest.mark.parametrize("rotation", [0, 90])
def test_untouched_page_keeps_original_fit_view_and_rotated_hotspot(tmp_path, rotation):
    """Restore stripped links without inventing XYZ coordinates or rotating hotspots twice."""
    source, translated, output = [tmp_path / name for name in ("source.pdf", "translated.pdf", "output.pdf")]
    create_source(source)
    with pymupdf.open(source) as document:
        document[1].set_rotation(rotation)
        page = document[1]
        internal = next(link for link in page.get_links() if link["kind"] == pymupdf.LINK_GOTO)
        document.xref_set_key(internal["xref"], "A/D", f"[{document.page_xref(0)} 0 R/Fit]")
        document.saveIncr()
    create_translation(source, translated, strip_links=True)
    restore_regions(source, translated, output, {0: [FIGURE]})
    with pymupdf.open(source) as original, pymupdf.open(output) as document:
        before, after = original[1].get_links(), document[1].get_links()
        assert {tuple(link["from"]) for link in before} == {tuple(link["from"]) for link in after}
        internal = next(link for link in after if "view" in link)
        assert document.xref_get_key(internal["xref"], "A/D") == (
            "array", f"[{document.page_xref(0)} 0 R/Fit]")
