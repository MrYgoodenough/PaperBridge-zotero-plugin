"""Verify optional production fragment capture with real PDFs and mutable IL references."""

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import fragment_trace
from alignment import _page_space, _visible_text, load_mapping
from fragment_trace import FragmentTrace


def _box(values):
    """Represent a small IL box without importing or altering BabelDOC."""
    return SimpleNamespace(**dict(zip(("x", "y", "x2", "y2"), values)))


def _pdf(path, texts, *, crop=False, rotation=0, user_unit=1, width=400, height=600,
         fontsize=12, fontname="helv", leading=45):
    """Write independently painted units and read their exact unrotated PDF glyph boxes."""
    with pymupdf.open() as document:
        page = document.new_page(width=width, height=height)
        for index, text in enumerate(texts):
            page.insert_text((100, 140 + index * leading), text, fontsize=fontsize, fontname=fontname)
        if crop:
            page.set_cropbox(pymupdf.Rect(50, 80, 350, 550))
        if user_unit != 1:
            document.xref_set_key(page.xref, "UserUnit", str(user_unit))
        page.set_rotation(rotation)
        document.save(path)
    units = []
    with pymupdf.open(path) as document:
        page = document[0]
        matrix, bounds = _page_space(page, {})
        for block in page.get_text("rawdict", clip=bounds)["blocks"]:
            for line in block.get("lines", []):
                characters = [character for span in line["spans"] for character in span["chars"]]
                units.append([(character["c"], list(pymupdf.Rect(character["bbox"]) * ~matrix))
                              for character in characters])
    assert len(units) == len(texts)
    return units


def _painted_lines(path):
    """Read independent actual paint boxes for these one-span-per-line PDF fixtures."""
    with pymupdf.open(path) as document:
        page = document[0]
        matrix, _ = _page_space(page, {})
        return [[(chr(codepoint), list(pymupdf.Rect(box) * ~matrix))
                 for codepoint, _, _, box in span["chars"] if not chr(codepoint).isspace()]
                for span in page.get_texttrace() if span["type"] == 0 and span["opacity"] > 0]


def _union(characters):
    """Return independent known glyph extents for exact geometry assertions."""
    boxes = [box for _, box in characters]
    return [min(box[0] for box in boxes), min(box[1] for box in boxes),
            max(box[2] for box in boxes), max(box[3] for box in boxes)]


def _case(tmp_path, count=2, **options):
    """Provide two actual PDFs, before-images, and the references later used for application."""
    source, output = tmp_path / "source.pdf", tmp_path / "translated.pdf"
    original_texts = [f"Original fragment {index}" for index in range(count)]
    target_texts = [f"Translated fragment {index}" for index in range(count)]
    original = _pdf(source, original_texts, **options)
    translated = _pdf(output, target_texts, **options)
    # A nonzero working origin proves that neither screen nor original crop offsets are guessed.
    offset = (17, 29)
    paragraphs = []
    for text, characters in zip(original_texts, original):
        rectangle = _union(characters)
        rectangle = [rectangle[0] - offset[0], rectangle[1] - offset[1] + 1,
                     rectangle[2] - offset[0], rectangle[3] - offset[1] - 1]
        paragraphs.append(SimpleNamespace(unicode=text, box=_box(rectangle), vertical=False,
                                          xobj_id=0, pdf_paragraph_composition=[]))
    page = SimpleNamespace(page_number=0, pdf_paragraph=paragraphs,
                           cropbox=SimpleNamespace(box=_box([17, 29, 417, 629])))
    docs = SimpleNamespace(page=[page])
    quality = SimpleNamespace(paragraphs={id(paragraph): {"applied": False, "status": "pending"}
                                         for paragraph in paragraphs})
    return source, output, docs, quality, original, translated, target_texts


def _apply(docs, quality, translated, texts):
    """Mutate the original paragraph objects as final layout does, including a cache application."""
    origin = docs.page[0].cropbox.box
    for index, (paragraph, characters, text) in enumerate(zip(docs.page[0].pdf_paragraph, translated, texts)):
        parts = []
        for character, box in characters:
            rectangle = [box[0] - origin.x, box[1] - origin.y,
                         box[2] - origin.x, box[3] - origin.y]
            visual = [rectangle[0], rectangle[1] + 1, rectangle[2], rectangle[3] - 1]
            parts.append(SimpleNamespace(pdf_character=SimpleNamespace(
                char_unicode=character, box=_box(rectangle), visual_bbox=SimpleNamespace(box=_box(visual)))))
        paragraph.unicode = text
        paragraph.box = _box([1, 1, 2, 2])  # Source geometry must remain a copied before-image.
        paragraph.pdf_paragraph_composition = parts
        quality.paragraphs[id(paragraph)].update(applied=True, status="cache" if index else "success",
                                                  cache_hits=int(index > 0))


@pytest.mark.parametrize("options", [{}, {"crop": True, "rotation": 90, "user_unit": 2},
                                      {"crop": True, "rotation": 270}])
def test_same_refs_and_applied_cache_generate_verified_original_hash(tmp_path, options):
    """Both new and cached applications validate against actual glyphs, crop, rotation and scale."""
    source, output, docs, quality, original, translated, texts = _case(tmp_path, **options)
    original_bytes, output_bytes = source.read_bytes(), output.read_bytes()
    trace = FragmentTrace(source)
    trace.inventory(docs)
    _apply(docs, quality, translated, texts)
    sidecar = tmp_path / "alignment.json"
    mapping = trace.write(output, sidecar, quality)
    assert mapping["schema_version"] == 2 and mapping["generator_version"] == "fragment-trace-2"
    assert mapping["metadata"]["verified_count"] == 2, mapping
    assert mapping["source_sha256"] == hashlib.sha256(original_bytes).hexdigest()
    assert mapping["output_sha256"] == hashlib.sha256(output_bytes).hexdigest()
    source_paint, target_paint = _painted_lines(source), _painted_lines(output)
    for index, unit in enumerate(mapping["units"]):
        assert unit["id"] == f"p0-u{index}"
        assert unit["source"]["rects"][0] == pytest.approx(_union(source_paint[index]))
        assert unit["target"]["rects"][0] == pytest.approx(_union(target_paint[index]))
        for side in ("source", "target"):
            x0, y0, x1, y1 = unit[side]["rects"][0]
            assert unit[side]["quads"] == [[x0, y1, x1, y1, x1, y0, x0, y0]]
    assert load_mapping(sidecar, source, output)["available"] is True
    assert (source.read_bytes(), output.read_bytes()) == (original_bytes, output_bytes)
    assert "Original fragment" not in json.dumps(mapping)
    assert "Translated fragment" not in json.dumps(mapping)
    assert trace.rows == {} and trace.document is None
    assert set(path.name for path in tmp_path.iterdir()) == {"source.pdf", "translated.pdf", "alignment.json"}


def test_production_multiline_quads_leave_gaps_short_ends_and_neighbors_clear(tmp_path):
    """Overlapping raw ascender boxes must still leave actual painted interline gaps clear."""
    source, output, docs, quality, _, _, _ = _case(tmp_path, count=1)
    source_lines = ["  An ordinary paragraph begins with a fairly long line.  ",
                    "The next source line has separate glyph geometry.  ", " Short end.      "]
    target_lines = ["  A translated paragraph has its own fairly long first line. ",
                    "Another translated line remains visibly separate. ", " Brief end.      "]
    # Times at 9.96 points has 13.29-point raw boxes, but only 9.96-point paint boxes.
    source_leading, target_leading = 11.96, 14
    original = _pdf(source, source_lines, fontsize=9.96, fontname="tiro", leading=source_leading)
    translated = _pdf(output, target_lines, leading=target_leading)
    # The unrelated last-line island lies inside the broad captured paragraph extents.
    for path, leading in ((source, source_leading), (output, target_leading)):
        with pymupdf.open(path) as document:
            document[0].insert_text((280, 140 + 2 * leading), "NEXT", fontsize=12)
            document.saveIncr()
    original_bytes, output_bytes = source.read_bytes(), output.read_bytes()
    paragraph = docs.page[0].pdf_paragraph[0]
    paragraph.unicode = "\n".join(source_lines)
    origin = docs.page[0].cropbox.box
    rectangle = _union([glyph for line in original for glyph in line])
    paragraph.box = _box([rectangle[0] - origin.x, rectangle[1] - origin.y + 1,
                          rectangle[2] - origin.x, rectangle[3] - origin.y - 1])
    trace = FragmentTrace(source)
    trace.inventory(docs)
    _apply(docs, quality, [[glyph for line in translated for glyph in line]], ["\n".join(target_lines)])
    sidecar = tmp_path / "alignment.json"
    mapping = trace.write(output, sidecar, quality)
    assert len(mapping["units"]) == 1, mapping
    for side, path, raw_lines in (("source", source, original), ("target", output, translated)):
        lines = _painted_lines(path)[:3]
        location = mapping["units"][0][side]
        assert len(location["rects"]) == len(location["quads"]) == 3
        if side == "source":
            raw_rectangle = _union(raw_lines[0])
            assert raw_rectangle[3] - raw_rectangle[1] == pytest.approx(13.29, abs=0.01)
            assert location["rects"][0][3] - location["rects"][0][1] == pytest.approx(9.96, abs=0.0001)
        for index, line in enumerate(lines):
            expected = _union(line)
            assert location["rects"][index] == pytest.approx(expected)
            x0, y0, x1, y1 = expected
            assert location["quads"][index] == pytest.approx([x0, y1, x1, y1, x1, y0, x0, y0])
        for index in range(2):
            assert _union(raw_lines[index + 1])[3] > _union(raw_lines[index])[1]
            assert location["rects"][index][1] - location["rects"][index + 1][3] == pytest.approx(2, abs=0.0001)
        assert location["rects"][2][2] < 280 < location["rects"][0][2]
        with pymupdf.open(path) as document:
            page = document[0]
            matrix, bounds = _page_space(page, {})
            clips = [pymupdf.Rect(rectangle) * matrix for rectangle in location["rects"]]
            assert _visible_text(page, clips, bounds, {}) == " ".join(text.strip() for text in
                                                                     (source_lines if side == "source" else target_lines))
    assert mapping["source_sha256"] == hashlib.sha256(original_bytes).hexdigest()
    assert mapping["output_sha256"] == hashlib.sha256(output_bytes).hexdigest()
    assert load_mapping(sidecar, source, output)["available"]
    assert (source.read_bytes(), output.read_bytes()) == (original_bytes, output_bytes)
    assert all(text not in json.dumps(mapping) for text in source_lines + target_lines)


def test_skips_inventory_only_unresolved_and_moved_units_are_excluded(tmp_path):
    """Visible text alone cannot turn skipped, protected, merged or cross-page units into pairs."""
    source, output, docs, quality, _, translated, texts = _case(tmp_path, count=6)
    trace = FragmentTrace(source)
    trace.inventory(docs)
    _apply(docs, quality, translated, texts)
    paragraphs = list(docs.page[0].pdf_paragraph)
    for index, status in ((1, "skipped"), (2, "protected"), (3, "pending")):
        quality.paragraphs[id(paragraphs[index])].update(applied=False, status=status)
    paragraphs[4].pdf_paragraph_composition = [SimpleNamespace(pdf_character=None)]
    docs.page[0].pdf_paragraph.pop()
    docs.page.append(SimpleNamespace(page_number=1, pdf_paragraph=[paragraphs[5]]))
    mapping = trace.write(output, tmp_path / "alignment.json", quality)
    assert [unit["id"] for unit in mapping["units"]] == ["p0-u0"]
    assert trace.excluded == {"unapplied": 3, "unsupported_final_geometry": 1, "moved_or_merged": 1}


def test_pinned_page_text_identity_is_not_a_form_xobject(tmp_path):
    """Use actual pinned IL types and their real page-text sentinel, not a mocked -1 default."""
    il = pytest.importorskip("babeldoc.format.pdf.document_il.il_version_1")
    source, output, docs, quality, original, translated, texts = _case(tmp_path, width=595, height=842)
    paragraphs = [il.PdfParagraph(
        unicode=paragraph.unicode, box=il.Box(**dict(zip(("x", "y", "x2", "y2"), _union(original[index])))),
        vertical=False,
        xobj_id=0 if index == 0 else 1)
        for index, paragraph in enumerate(docs.page[0].pdf_paragraph)]
    # These are the exact page shape and page-text sentinel observed in the real smoke.
    page = il.Page(page_number=0, pdf_paragraph=paragraphs,
                   cropbox=il.Cropbox(box=il.Box(x=0, y=0, x2=595, y2=842)))
    docs = il.Document(page=[page])
    quality.paragraphs = {id(paragraph): {"applied": False} for paragraph in paragraphs}
    trace = FragmentTrace(source)
    trace.inventory(docs)
    assert list(trace.rows) == [id(paragraphs[0])]
    assert trace.excluded == {"unsupported_source": 1}
    _apply(docs, quality, translated, texts)
    for paragraph in paragraphs:
        paragraph.pdf_paragraph_composition = [il.PdfParagraphComposition(pdf_character=il.PdfCharacter(
            char_unicode=part.pdf_character.char_unicode,
            box=il.Box(**vars(part.pdf_character.box)),
            visual_bbox=il.VisualBbox(box=il.Box(**vars(part.pdf_character.visual_bbox.box)))))
            for part in paragraph.pdf_paragraph_composition]
    mapping = trace.write(output, tmp_path / "alignment.json", quality)
    assert [unit["id"] for unit in mapping["units"]] == ["p0-u0"]
    assert load_mapping(tmp_path / "alignment.json", source, output)["available"]


def test_invalid_source_or_changed_final_pdf_cannot_manufacture_pairs(tmp_path):
    """Validation checks literal source evidence and binds a saved mapping to the final bytes."""
    source, output, docs, quality, _, translated, texts = _case(tmp_path)
    trace = FragmentTrace(source)
    trace.inventory(docs)
    _apply(docs, quality, translated, texts)
    sidecar = tmp_path / "alignment.json"
    assert len(trace.write(output, sidecar, quality)["units"]) == 2
    _pdf(output, ["Unrelated final text 0", "Unrelated final text 1"])
    assert load_mapping(sidecar, source, output)["reason"] == "output_hash_changed"
    trace = FragmentTrace(source)
    for paragraph in docs.page[0].pdf_paragraph:
        paragraph.unicode = "Invented source text that was not in the PDF"
        paragraph.box = _box([80, 410, 250, 475])
    trace.inventory(docs)
    _apply(docs, quality, translated, texts)
    mapping = trace.write(output, tmp_path / "invalid.json", quality)
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"].get("source_text_not_found", 0) > 0


def test_capture_limits_and_optional_failures_leave_pdfs_and_application_intact(tmp_path, monkeypatch, caplog):
    """Trace-only capacity, inventory or write failures never refuse translation or quality."""
    source, output, docs, quality, _, translated, texts = _case(tmp_path)
    monkeypatch.setattr(fragment_trace, "MAX_TRACE_UNITS", 1)
    trace = FragmentTrace(source)
    trace.inventory(docs)
    assert len(trace.rows) == 1 and len(docs.page[0].pdf_paragraph) == 2
    _apply(docs, quality, translated, texts)
    assert len(trace.write(output, tmp_path / "bounded.json", quality)["units"]) == 1
    before = output.read_bytes(), dict(quality.paragraphs)
    trace = FragmentTrace(source)

    def fail(*args):
        """Simulate an unexpected failure in our own optional capture, not BabelDOC."""
        raise RuntimeError("trace failure")

    monkeypatch.setattr(trace, "_capture", fail)
    trace.inventory(docs)
    assert trace.disabled and trace.write(output, tmp_path / "absent.json", quality) is None
    assert (output.read_bytes(), quality.paragraphs) == before
    assert not (tmp_path / "absent.json").exists()
    assert "translation continues" in caplog.text


def test_changed_original_snapshot_never_uses_repaired_hash(tmp_path, caplog):
    """The trace's initial source hash cannot be rebound to a later working/repaired file."""
    source, output, docs, quality, _, translated, texts = _case(tmp_path)
    repaired = tmp_path / "repaired.pdf"
    _pdf(repaired, ["Working repair text 0", "Working repair text 1"])
    trace = FragmentTrace(source)
    assert trace.source_path == source
    assert trace.source_sha256 != hashlib.sha256(repaired.read_bytes()).hexdigest()
    trace.inventory(docs)
    _apply(docs, quality, translated, texts)
    _pdf(source, ["Different original 0", "Different original 1"])
    assert trace.write(output, tmp_path / "alignment.json", quality) is None
    assert not (tmp_path / "alignment.json").exists()
    assert "translation continues" in caplog.text
