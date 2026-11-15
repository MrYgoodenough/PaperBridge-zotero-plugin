"""Exercise literal line-quad evidence and v1/v2 sidecar isolation with real PDFs."""

import copy
import hashlib
import json

import pymupdf
import pytest

from backend.alignment import _layout_text, _page_space, _visible_text, build_mapping, load_mapping, write_mapping


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
    assert mapping["schema_version"] == 2
    assert mapping["generator_version"] == "fragment-trace-2"
    assert mapping["coordinate_space"] == "pdf-user-space"
    assert mapping["source_sha256"] == hashlib.sha256(originals[0]).hexdigest()
    assert mapping["output_sha256"] == hashlib.sha256(originals[1]).hexdigest()
    assert len(mapping["units"]) == 1
    unit = mapping["units"][0]
    assert unit["id"] == "unit-1" and unit["status"] == "verified"
    for side, text in (("source", "Original phrase"), ("target", "Translated phrase")):
        location = unit[side]
        assert set(location) == {"page", "rects", "quads"} and location["page"] == 0
        assert len(location["rects"]) == len(location["quads"]) == 1
        x0, y0, x1, y1 = location["rects"][0]
        assert x0 == pytest.approx(100)
        assert x1 == pytest.approx(100 + pymupdf.get_text_length(text, fontsize=12))
        assert 335 < y0 < y1 < 370
        assert location["quads"][0] == pytest.approx([x0, y1, x1, y1, x1, y0, x0, y0])
    assert mapping["metadata"] == {"candidate_count": 1, "verified_count": 1,
                                   "excluded_count": 0, "exclusion_reasons": {}}
    assert "Original phrase" not in json.dumps(mapping)
    assert "Translated phrase" not in json.dumps(mapping)
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output) == {"available": True, "mapping": mapping}
    assert (source.read_bytes(), output.read_bytes()) == originals
    assert list(tmp_path.glob("*.tmp")) == []


def test_schema1_rectangles_still_load_without_generator(tmp_path):
    """Read legacy rectangle-only files unchanged, including cropped and rotated PDFs."""
    source, output, candidate = _pair(tmp_path, crop=True, rotation=90, user_unit=2)
    originals = source.read_bytes(), output.read_bytes()
    legacy = {"schema_version": 1, "coordinate_space": "pdf-user-space",
              "source_sha256": hashlib.sha256(originals[0]).hexdigest(),
              "output_sha256": hashlib.sha256(originals[1]).hexdigest(),
              "units": [{"id": candidate["id"], "status": "verified",
                         "source": candidate["source"], "target": candidate["target"]}]}
    sidecar = tmp_path / "legacy.json"
    write_mapping(sidecar, legacy)
    saved = sidecar.read_bytes()
    assert load_mapping(sidecar, source, output) == {"available": True, "mapping": legacy}
    assert sidecar.read_bytes() == saved and b"generator_version" not in saved and b"quads" not in saved
    assert (source.read_bytes(), output.read_bytes()) == originals


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
    # Paint bounds normalize Helvetica's ascender/descender to the inserted 12-point em.
    font = pymupdf.Font("helv")
    top = 350 + 12 * font.ascender / (font.ascender - font.descender)
    for side in ("source", "target"):
        rectangle = mapping["units"][0][side]["rects"][0]
        assert rectangle == pytest.approx([100, top - 12,
                                          100 + pymupdf.get_text_length(candidate[f"{side}_text"], fontsize=12),
                                          top], abs=0.0001)
        with pymupdf.open(source if side == "source" else output) as document:
            page = document[0]
            matrix, bounds = _page_space(page, {})
            assert _visible_text(page, [pymupdf.Rect(rectangle) * matrix], bounds, {}) == candidate[f"{side}_text"]
    sidecar = tmp_path / "mapping.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output)["available"] is True
    assert (source.read_bytes(), output.read_bytes()) == originals
    with pymupdf.open(source) as document:
        assert document[0].rotation == rotation


def test_each_document_has_its_own_matrix(tmp_path):
    """Same-page pairs may link different sizes, crop boxes, and rotations."""
    source, output, candidate = _pair(tmp_path, crop=True, rotation=90)
    with pymupdf.open() as document:
        page = document.new_page(width=500, height=700)
        page.insert_text((100, 150), candidate["target_text"], fontsize=12)
        page.set_cropbox(pymupdf.Rect(40, 50, 450, 600))
        page.set_rotation(270)
        document.new_page().insert_text((100, 150), "Not the captured page")
        document.save(output)
    candidate["target"] = {"page": 0, "rects": [[95, 535, 300, 570]]}
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


@pytest.mark.parametrize("malformed", ["length", "nonfinite", "crossed", "concave", "degenerate",
                                       "counterclockwise", "count", "bounds", "outside"])
def test_schema2_requires_convex_cyclic_quads_and_actual_bounds(tmp_path, malformed):
    """Reject malformed quads, mismatched bounding rectangles, and real-page overflow."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()
    mapping = build_mapping(source, output, [candidate])
    location = mapping["units"][0]["target"]
    quad = location["quads"][0]
    x0, y0, x1, y1 = location["rects"][0]
    if malformed == "length":
        quad.pop()
    elif malformed == "nonfinite":
        quad[0] = float("nan")
    elif malformed == "crossed":
        location["quads"][0] = quad[:4] + quad[6:8] + quad[4:6]
    elif malformed == "concave":
        quad[4:6] = [x0 + (x1 - x0) / 4, y0 + 3 * (y1 - y0) / 4]
    elif malformed == "degenerate":
        quad[4:6] = quad[2:4]
    elif malformed == "counterclockwise":
        location["quads"][0] = quad[:2] + quad[6:8] + quad[4:6] + quad[2:4]
    elif malformed == "count":
        location["quads"].append(quad[:])
    elif malformed == "bounds":
        location["rects"][0][2] += 1
    elif malformed == "outside":
        quad[::2] = [x + 500 for x in quad[::2]]
        location["rects"][0][0] += 500
        location["rects"][0][2] += 500
    sidecar = tmp_path / "invalid.json"
    sidecar.write_text(json.dumps(mapping), encoding="utf-8")
    result = load_mapping(sidecar, source, output)
    assert result["available"] is False and "invalid_geometry" in result["reason"]
    assert (source.read_bytes(), output.read_bytes()) == originals


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


@pytest.mark.parametrize("failure", ["missing", "corrupt", "version", "generator", "space", "missing_pdf"])
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
        mapping["schema_version"] = 3
        expected = "schema_version_mismatch"
    elif failure == "generator":
        mapping.pop("generator_version")
        expected = "generator_version_mismatch"
    elif failure == "space":
        mapping["coordinate_space"] = "screen-pixels"
        expected = "unsupported_coordinate_space"
    elif failure == "missing_pdf":
        expected = "source_pdf_unavailable"
    if failure in {"version", "generator", "space", "missing_pdf"}:
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


def test_matched_run_excludes_neighbor_words_and_edge_spaces(tmp_path):
    """Literal substring geometry must not include the rest of the extracted line."""
    source, output, candidate = _pair(tmp_path)
    _pdf(output, "Before Translated phrase After")
    candidate["target_text"] = "  Translated phrase\n "
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    rectangle = mapping["units"][0]["target"]["rects"][0]
    first_x = 100 + pymupdf.get_text_length("Before ", fontsize=12)
    assert rectangle[0] == pytest.approx(first_x)
    assert rectangle[2] == pytest.approx(first_x + pymupdf.get_text_length("Translated phrase", fontsize=12))


def test_paint_clips_do_not_weaken_raw_proof_or_partial_glyph_checks(tmp_path):
    """Tight paint clips work for inspection, but cannot replace full raw producer evidence."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()
    mapping = build_mapping(source, output, [candidate])
    rectangle = mapping["units"][0]["source"]["rects"][0]
    with pymupdf.open(source) as document:
        page = document[0]
        matrix, bounds = _page_space(page, {})
        clip = pymupdf.Rect(rectangle) * matrix
        assert _visible_text(page, [clip], bounds, {}) == candidate["source_text"]
        clip.x0 += 1
        assert _layout_text(candidate["source_text"]) not in _layout_text(_visible_text(page, [clip], bounds, {}))
    candidate["source"]["rects"] = [rectangle]
    rejected = build_mapping(source, output, [candidate])
    assert rejected["units"] == []
    assert rejected["metadata"]["exclusion_reasons"] == {"source_text_not_found": 1}
    assert (source.read_bytes(), output.read_bytes()) == originals


def test_paint_advance_can_extend_beyond_raw_metrics(tmp_path, monkeypatch):
    """Declared PDF widths must not crop valid origin-matched painted glyph bounds."""
    source, output, candidate = _pair(tmp_path)
    candidate["source_text"], candidate["target_text"] = "J", "W"
    candidate["source"] = _pdf(source, candidate["source_text"])
    candidate["target"] = _pdf(output, candidate["target_text"])
    originals = source.read_bytes(), output.read_bytes()
    get_trace = pymupdf.Page.get_texttrace

    def wider_trace(page):
        """Reproduce a one-font-unit advance mismatch without changing glyph identity."""
        spans = get_trace(page)
        for span in spans:
            chars = []
            for codepoint, glyph, origin, bbox in span["chars"]:
                box = list(bbox)
                # PDF font widths use thousandths of an em; real Times advances differ by one.
                box[2] += span["size"] / 1000
                chars.append((codepoint, glyph, origin, tuple(box)))
            span["chars"] = tuple(chars)
        return spans

    monkeypatch.setattr(pymupdf.Page, "get_texttrace", wider_trace)
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    for side, path in (("source", source), ("target", output)):
        with pymupdf.open(path) as document:
            page = document[0]
            matrix, bounds = _page_space(page, {})
            paint = pymupdf.Rect(page.get_texttrace()[0]["chars"][0][3])
            raw = page.get_text("rawdict")["blocks"][0]["lines"][0]["spans"][0]["chars"][0]
            assert paint.x1 > raw["bbox"][2] + 0.01
            rectangle = list(paint * ~matrix)
            location = mapping["units"][0][side]
            assert len(location["rects"]) == 1
            assert location["rects"][0] == pytest.approx(rectangle)
            x0, y0, x1, y1 = rectangle
            assert location["quads"][0] == pytest.approx([x0, y1, x1, y1, x1, y0, x0, y0])
            assert _visible_text(page, [paint], bounds, {}) == candidate[f"{side}_text"]
    assert (source.read_bytes(), output.read_bytes()) == originals


@pytest.mark.parametrize("failure", ["nonfinite", "unanchored", "conflicting", "outside_page"])
def test_unreliable_paint_geometry_has_no_broad_box_fallback(tmp_path, monkeypatch, failure):
    """Valid raw literals cannot authorize invalid or conflicting active paint boxes."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()
    get_trace = pymupdf.Page.get_texttrace

    def unreliable_trace(page):
        """Alter paint geometry only, retaining the original codepoint and origin evidence."""
        spans = get_trace(page)
        span = spans[0] if failure != "conflicting" else copy.deepcopy(spans[0])
        chars = list(span["chars"])
        codepoint, glyph, origin, bbox = chars[0]
        box = list(bbox)
        if failure == "nonfinite":
            box[0] = float("nan")
        elif failure == "outside_page":
            box[2] = page.rect.width + 1
        else:
            offset = 20 if failure == "unanchored" else 0.25
            box[1] += offset
            box[3] += offset
        chars[0] = (codepoint, glyph, origin, tuple(box))
        span["chars"] = tuple(chars)
        if failure == "conflicting":
            span["seqno"] += 1
            spans.append(span)
        return spans

    monkeypatch.setattr(pymupdf.Page, "get_texttrace", unreliable_trace)
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    reason = "source_invalid_geometry" if failure == "outside_page" else "source_geometry_unavailable"
    assert mapping["metadata"]["exclusion_reasons"] == {reason: 1}
    assert (source.read_bytes(), output.read_bytes()) == originals


def test_geometry_uses_the_uncovered_paint_sequence(tmp_path):
    """An earlier overpainted glyph's larger trace box cannot inflate the visible final run."""
    source, output, candidate = _pair(tmp_path)
    with pymupdf.open() as document:
        page = document.new_page(width=400, height=500)
        page.insert_text((100, 150), candidate["source_text"], fontsize=12)
        page.draw_rect(pymupdf.Rect(95, 130, 300, 160), color=None, fill=(1, 1, 1))
        page.insert_text((100, 150), candidate["source_text"], fontsize=10)
        trace = page.get_texttrace()
        assert trace[0]["seqno"] < trace[-1]["seqno"]
        expected = list(pymupdf.Rect(trace[-1]["bbox"]) * ~page.transformation_matrix)
        document.save(source)
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    rectangle = mapping["units"][0]["source"]["rects"][0]
    assert rectangle == pytest.approx(expected)
    assert rectangle[3] - rectangle[1] == pytest.approx(10)


@pytest.mark.parametrize("failure", ["source_repeat", "target_repeat", "cross_page"])
def test_repeated_or_cross_page_captures_are_excluded(tmp_path, failure):
    """Repeated visible literal occurrences or moved page pairs cannot supply precise geometry."""
    source, output, candidate = _pair(tmp_path)
    if failure == "cross_page":
        with pymupdf.open() as document:
            document.new_page(width=400, height=500).insert_text((100, 150), "Other page")
            document.new_page(width=400, height=500).insert_text((100, 150), candidate["target_text"], fontsize=12)
            document.save(output)
        candidate["target"]["page"] = 1
        reason = "cross_page"
    else:
        side = failure.split("_")[0]
        with pymupdf.open(source if side == "source" else output) as document:
            document[0].insert_text((100, 200), candidate[f"{side}_text"], fontsize=12)
            document.saveIncr()
        candidate[side]["rects"] = [[95, 280, 300, 370]]
        reason = f"{side}_ambiguous_text"
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"] == {reason: 1}


def test_text_unavailable_disables_only_the_candidate(tmp_path, monkeypatch):
    """Extraction API failure leaves PDFs intact without manufacturing fallback geometry."""
    source, output, candidate = _pair(tmp_path)
    originals = source.read_bytes(), output.read_bytes()

    def fail_trace(*args):
        """Simulate unavailable paint evidence without invoking an engine or provider."""
        raise RuntimeError("text trace unavailable")

    monkeypatch.setattr(pymupdf.Page, "get_texttrace", fail_trace)
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"] == {"source_text_unavailable": 1}
    assert (source.read_bytes(), output.read_bytes()) == originals


def test_both_literals_are_verified_before_quad_derivation(tmp_path, monkeypatch):
    """A missing FINAL target literal must stop the pair before any quad is derived."""
    source, output, candidate = _pair(tmp_path)
    candidate["target_text"] = "Absent final phrase"

    def unexpected_quad(*args):
        """Fail if geometry is derived before both sides provide literal evidence."""
        raise AssertionError("quad before final verification")

    monkeypatch.setattr("backend.alignment._line_quad", unexpected_quad)
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"] == {"target_text_not_found": 1}


def test_rotated_line_quad_uses_actual_glyph_direction(tmp_path):
    """A confidently recovered tilted text line keeps its four rotated corners."""
    source, output, candidate = _pair(tmp_path)
    with pymupdf.open() as document:
        page = document.new_page(width=400, height=500)
        page.insert_text((160, 220), candidate["target_text"], fontsize=12,
                         morph=(pymupdf.Point(160, 220), pymupdf.Matrix(30)))
        line = page.get_text("rawdict")["blocks"][0]["lines"][0]
        actual = pymupdf.recover_line_quad(line)
        inverse = ~page.transformation_matrix
        expected = [coordinate for point in (actual.ul, actual.ur, actual.lr, actual.ll)
                    for coordinate in point * inverse]
        candidate["target"]["rects"] = [list(actual.rect * inverse)]
        document.save(output)
    mapping = build_mapping(source, output, [candidate])
    assert len(mapping["units"]) == 1, mapping["metadata"]
    quad = mapping["units"][0]["target"]["quads"][0]
    assert quad == pytest.approx(expected, abs=0.0001)
    assert quad[1] != pytest.approx(quad[3])
    sidecar = tmp_path / "rotated.json"
    write_mapping(sidecar, mapping)
    assert load_mapping(sidecar, source, output)["available"]


def test_unhandled_line_direction_is_excluded(tmp_path, monkeypatch):
    """Malformed extracted direction cannot be replaced with an axis-aligned guess."""
    source, output, candidate = _pair(tmp_path)
    get_text = pymupdf.Page.get_text

    def unsupported_text(page, *args, **kwargs):
        """Preserve literal glyphs while making their line direction unavailable."""
        raw = get_text(page, *args, **kwargs)
        for block in raw["blocks"]:
            for line in block.get("lines", []):
                line["dir"] = (0.0, 0.0)
        return raw

    monkeypatch.setattr(pymupdf.Page, "get_text", unsupported_text)
    mapping = build_mapping(source, output, [candidate])
    assert mapping["units"] == []
    assert mapping["metadata"]["exclusion_reasons"] == {"source_unsupported_direction": 1}


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
    assert len(mapping["units"][0]["target"]["quads"]) == 2


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
    with pymupdf.open(source) as document:
        page = document[0]
        matrix, bounds = _page_space(page, {})
        clips = [pymupdf.Rect(rectangle) * matrix for rectangle in mapping["units"][0]["source"]["rects"]]
        assert _visible_text(page, clips, bounds, {}) == "Original phrase"


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
