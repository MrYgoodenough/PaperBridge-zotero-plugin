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
from alignment import _page_space, load_mapping
from fragment_trace import FragmentTrace


def _box(values):
    """Represent a small IL box without importing or altering BabelDOC."""
    return SimpleNamespace(**dict(zip(("x", "y", "x2", "y2"), values)))


def _pdf(path, texts, *, crop=False, rotation=0, user_unit=1, width=400, height=600):
    """Write independently painted units and read their exact unrotated PDF glyph boxes."""
    with pymupdf.open() as document:
        page = document.new_page(width=width, height=height)
        for index, text in enumerate(texts):
            page.insert_text((100, 140 + index * 45), text, fontsize=12)
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
    assert mapping["metadata"]["verified_count"] == 2, mapping
    assert mapping["source_sha256"] == hashlib.sha256(original_bytes).hexdigest()
    assert mapping["output_sha256"] == hashlib.sha256(output_bytes).hexdigest()
    for index, unit in enumerate(mapping["units"]):
        assert unit["id"] == f"p0-u{index}"
        assert unit["source"]["rects"][0] == pytest.approx(_union(original[index]))
        assert unit["target"]["rects"][0] == pytest.approx(_union(translated[index]))
    assert load_mapping(sidecar, source, output)["available"] is True
    assert (source.read_bytes(), output.read_bytes()) == (original_bytes, output_bytes)
    assert not any("fragment" in value for value in json.dumps(mapping).split('"'))
    assert trace.rows == {} and trace.document is None
    assert set(path.name for path in tmp_path.iterdir()) == {"source.pdf", "translated.pdf", "alignment.json"}


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
