"""Exercise captured-pair evidence and sidecar failure isolation with real PDFs."""

import copy
import hashlib
import json

import pymupdf
import pytest

from backend.alignment import _layout_text, build_mapping, load_mapping, write_mapping


def _pdf(path, text, *, crop=False, rotation=0, hidden=False, overlay=False, user_unit=1, opacity=1):
    """Write one synthetic PDF and return independently known PDF-user geometry."""
    with pymupdf.open() as document:
        page = document.new_page(width=400, height=500)
        page.insert_text((100, 150), text, fontsize=12, render_mode=3 if hidden else 0,
                         fill_opacity=opacity)
        if overlay:
            page.draw_rect(pymupdf.Rect(95, 130, 300, 160), color=None, fill=(1, 1, 1))
        if crop:
            page.set_cropbox(pymupdf.Rect(50, 80, 350, 450))
        if user_unit != 1:
            document.xref_set_key(page.xref, "UserUnit", str(user_unit))
        page.set_rotation(rotation)
        document.save(path)
    # Inserted baseline y=150 on a height-500 PDF: PDF-user y is 350.
    return {"page": 0, "rects": [[95, 335, 300, 370]]}


def _pair(tmp_path, **options):
    """Create independent source/output files and their captured candidate."""
    source = tmp_path / "source.pdf"
    output = tmp_path / "output.pdf"
    candidate = {"id": "unit-1", "applied": True, "source_text": "Original phrase",
                 "target_text": "Translated phrase"}
    candidate["source"] = _pdf(source, candidate["source_text"], **options)
    candidate["target"] = _pdf(output, candidate["target_text"], **options)
    return source, output, candidate


def test_verified_pair_and_atomic_roundtrip(tmp_path):
    """Save only paired geometry and exact byte hashes, never captured text."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()
    candidate["source_text"] = "Ｏｒｉｇｉｎａｌ\u00a0\nphrase"
    mapping = build_mapping(source, output, [candidate])
    assert mapping["schema_version"] == 1
    assert mapping["coordinate_space"] == "pdf-user-space"
    assert mapping["source_sha256"] == hashlib.sha256(originals[0]).hexdigest()
    assert mapping["output_sha256"] == hashlib.sha256(originals[1]).hexdigest()
    assert mapping["units"] == [{"id": "unit-1", "status": "verified",
                                 "source": candidate["source"], "target": candidate["target"]}]
    assert mapping["metadata"] == {"candidate_count": 1, "verified_count": 1,
                                   "excluded_count": 0, "exclusion_reasons": {}}
    assert "Original phrase" not in json.dumps(mapping)
    assert "Translated phrase" not in json.dumps(mapping)
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output) == {"available": True, "mapping": mapping}
    assert (source.read_bytes(), output.read_bytes()) == originals
    assert list(tmp_path.glob("*.tmp")) == []


@pytest.mark.parametrize("crop,rotation,user_unit", [
    (False, 90, 1), (False, 270, 1), (True, 0, 1),
    (True, 90, 1), (True, 180, 1), (True, 270, 1), (True, 90, 2),
])
def test_actual_crop_rotation_and_scaling(tmp_path, crop, rotation, user_unit):
    """Known PDF-user rectangles remain correct through crop, rotation, and scale."""
    source, output, candidate = _pair(tmp_path, crop=crop, rotation=rotation, user_unit=user_unit)
    originals = source.read_bytes(), output.read_bytes()
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output)["available"] is True
    assert (source.read_bytes(), output.read_bytes()) == originals
    with pymupdf.open(source) as document:
        assert document[0].rotation == rotation


def test_each_document_and_page_has_its_own_matrix(tmp_path):
    """Pairs may link different page numbers, sizes, crop boxes, and rotations."""
    source, output, candidate = _pair(tmp_path, crop=True, rotation=90)
    with pymupdf.open() as document:
        document.new_page().insert_text((100, 150), "Not the captured page")
        page = document.new_page(width=500, height=700)
        page.insert_text((100, 150), candidate["target_text"], fontsize=12)
        page.set_cropbox(pymupdf.Rect(40, 50, 450, 600))
        page.set_rotation(270)
        document.save(output)
    candidate["target"] = {"page": 1, "rects": [[95, 535, 300, 570]]}
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output)["available"] is True


@pytest.mark.parametrize("side", ["source", "output"])
def test_changed_hash_disables_only_mapping(tmp_path, side):
    """Edited real PDFs remain intact and readable when their sidecar is stale."""
    source, output, candidate = _pair(tmp_path)
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, build_mapping(source, output, [candidate]))
    changed = source if side == "source" else output
    with pymupdf.open(changed) as document:
        document[0].insert_text((100, 200), "Edited")
        document.saveIncr()
    edited = changed.read_bytes()
    assert load_mapping(sidecar, source, output) == {"available": False, "reason": f"{side}_hash_changed"}
    assert changed.read_bytes() == edited
    with pymupdf.open(changed) as document:
        assert "Edited" in document[0].get_text()


@pytest.mark.parametrize("location", [
    {"page": -1, "rects": [[95, 335, 300, 370]]},
    {"page": 1, "rects": [[95, 335, 300, 370]]},
    {"page": True, "rects": [[95, 335, 300, 370]]},
    {"page": 0, "rects": []},
    {"page": 0, "rects": [[300, 335, 95, 370]]},
    {"page": 0, "rects": [[95, 335, 95, 370]]},
    {"page": 0, "rects": [[95, 335, 300]]},
    {"page": 0, "rects": [[95, 335, float("nan"), 370]]},
    {"page": 0, "rects": [[95, 335, float("inf"), 370]]},
    {"page": 0, "rects": [[95, 335, "300", 370]]},
    {"page": 0, "rects": [[95, 335, 450, 370]]},
])
def test_malformed_geometry_is_excluded_and_disables_sidecar(tmp_path, location):
    """Malformed coordinates cannot enter a build or be trusted on reload."""
    source, output, candidate = _pair(tmp_path)
    valid = build_mapping(source, output, [candidate])
    candidate["target"] = location
    rejected = build_mapping(source, output, [candidate])
    assert rejected["units"] == []
    assert rejected["metadata"]["exclusion_reasons"] == {"target_invalid_geometry": 1}
    valid["units"][0]["target"] = location
    sidecar = tmp_path / "mapping.json"
    sidecar.write_text(json.dumps(valid), encoding="utf-8")
    result = load_mapping(sidecar, source, output)
    assert result["available"] is False
    assert "invalid_geometry" in result["reason"]
    assert source.exists() and output.exists()


def test_unchanged_unapplied_and_missing_text_are_not_verified(tmp_path):
    """Unchanged output is not evidence of application, even when text matches."""
    source, output, candidate = _pair(tmp_path)
    output.write_bytes(source.read_bytes())
    candidate["target_text"] = candidate["source_text"]
    candidate["applied"] = False
    unapplied = build_mapping(source, output, [candidate])
    assert unapplied["units"] == []
    assert unapplied["metadata"]["exclusion_reasons"] == {"unapplied": 1}
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, unapplied)
    assert load_mapping(sidecar, source, output) == {"available": False, "reason": "no_verified_units"}
    candidate["applied"] = True
    candidate["target_text"] = "Translated phrase"
    assert build_mapping(source, output, [candidate])["metadata"]["exclusion_reasons"] == {"target_text_not_found": 1}


@pytest.mark.parametrize("failure", ["missing", "corrupt", "version", "space", "missing_pdf"])
def test_loading_failures_are_mapping_only(tmp_path, failure):
    """Missing and incompatible sidecars never modify any existing PDF."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()
    sidecar = tmp_path / "mapping.json"
    mapping = build_mapping(source, output, [candidate])
    expected = "missing_mapping"
    if failure == "corrupt":
        sidecar.write_text("{broken", encoding="utf-8")
        expected = "corrupt_mapping"
    elif failure == "version":
        mapping["schema_version"] = 2
        expected = "schema_version_mismatch"
    elif failure == "space":
        mapping["coordinate_space"] = "screen-pixels"
        expected = "unsupported_coordinate_space"
    elif failure == "missing_pdf":
        expected = "source_pdf_unavailable"
    if failure in {"version", "space", "missing_pdf"}:
        sidecar.write_text(json.dumps(mapping), encoding="utf-8")
    result = load_mapping(sidecar, tmp_path / "absent.pdf" if failure == "missing_pdf" else source, output)
    assert result == {"available": False, "reason": expected}
    assert (source.read_bytes(), output.read_bytes()) == originals


@pytest.mark.parametrize("hidden,overlay,opacity", [(True, False, 1), (False, True, 1), (False, False, 0)])
def test_nonvisible_text_is_not_evidence(tmp_path, hidden, overlay, opacity):
    """Hidden, transparent, and overpainted text cannot verify a captured pair."""
    source, output, candidate = _pair(tmp_path)
    _pdf(output, candidate["target_text"], hidden=hidden, overlay=overlay, opacity=opacity)
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"] == {"target_text_not_found": 1}


def test_no_similarity_or_text_outside_captured_rectangles(tmp_path):
    """Near matches and exact text elsewhere on the page are insufficient."""
    source, output, candidate = _pair(tmp_path)
    candidate["target_text"] = "translated phrase"
    assert build_mapping(source, output, [candidate])["units"] == []
    candidate["target_text"] = "Translated phrase"
    candidate["target"]["rects"] = [[95, 235, 300, 270]]
    assert build_mapping(source, output, [candidate])["units"] == []


def test_multiple_captured_rectangles(tmp_path):
    """A captured multiline unit is checked literally in its rectangle order."""
    source, output, candidate = _pair(tmp_path)
    with pymupdf.open(output) as document:
        document[0].insert_text((100, 200), "Second line", fontsize=12)
        document.saveIncr()
    candidate["target"]["rects"].append([95, 285, 300, 320])
    candidate["target_text"] = "Translated phrase\nSecond line"
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]


def test_positioned_words_allow_extracted_whitespace(tmp_path):
    """Whitespace between independently drawn words need not have a paint glyph."""
    source, output, candidate = _pair(tmp_path)
    with pymupdf.open() as document:
        page = document.new_page(width=400, height=500)
        page.insert_text((100, 150), "Original", fontsize=12)
        next_x = 100 + pymupdf.get_text_length("Original ", fontsize=12)
        page.insert_text((next_x, 150), "phrase", fontsize=12)
        document.save(source)
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]


def test_layout_glyphs_allow_only_spacing_and_printed_hyphen_variants(tmp_path):
    """Real glyph sequences survive producer/extractor spaces without fuzzy content matching."""
    source, output, candidate = _pair(tmp_path)
    candidate["source_text"] = "Originalphrase"
    candidate["target_text"] = "Trans lated\nphrase"
    assert len(build_mapping(source, output, [candidate])["units"]) == 1
    assert _layout_text("Scikit\u2010learn \u2011 Python") == _layout_text("Scikit-learn- Python")
    assert _layout_text("a\0b") != _layout_text("a b")
    assert _layout_text("x\u2212y") != _layout_text("x-y")
    assert _layout_text("x\u2013y") != _layout_text("x-y")
    candidate["target_text"] = "Translated phraze"
    assert build_mapping(source, output, [candidate])["units"] == []


def test_failed_atomic_replace_preserves_previous_sidecar(tmp_path, monkeypatch):
    """An interrupted sidecar replacement cannot alter PDFs or the old mapping."""
    source, output, candidate = _pair(tmp_path)
    mapping = build_mapping(source, output, [candidate])
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    before = sidecar.read_bytes()

    def fail_replace(*args):
        """Simulate an OS failure after the temporary file was flushed."""
        raise OSError("replacement failed")

    monkeypatch.setattr("backend.alignment.os.replace", fail_replace)
    with pytest.raises(OSError, match="replacement failed"):
        write_mapping(sidecar, copy.deepcopy(mapping))
    assert sidecar.read_bytes() == before
    assert list(tmp_path.glob("*.tmp")) == []
    with pytest.raises(ValueError, match="mapping_path_must_not_be_pdf"):
        write_mapping(source, mapping)


def test_separately_painted_neighboring_glyphs_are_not_occlusion(tmp_path):
    """Normal glyph-by-glyph PDF output may overlap adjacent font-metric boxes."""
    source, output, candidate = _pair(tmp_path)
    with pymupdf.open() as document:
        page = document.new_page(width=400, height=500)
        x = 100
        for character in candidate["target_text"]:
            page.insert_text((x, 150), character, fontsize=12)
            x += pymupdf.get_text_length(character, fontsize=12)
        document.save(output)
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
