"""Validate captured translation-unit pairs without engines, workers, or PDF writes.

Only normalized literal text is evidence; this module never infers semantic pairs.
"""

import hashlib
import json
import math
import os
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path

import pymupdf

# Version of newly produced captured-pair sidecars; rectangle-only v1 remains readable.
SCHEMA_VERSION = 2
# Identify the pinned producer independently of the sidecar schema.
GENERATOR_VERSION = "fragment-trace-2"
# Rectangles and cyclic TL/TR/BR/BL quads use unrotated PDF user coordinates.
COORDINATE_SPACE = "pdf-user-space"
# Allow only floating-point noise at page and glyph boundaries, in points.
_GEOMETRY_EPSILON = 0.0001
# PyMuPDF 1.26 raw spans mark filled and stroked text with these bits.
_PAINTED_TEXT_FLAGS = 16 | 32
# Match glyph origins between PyMuPDF's raw text and paint trace APIs.
_ORIGIN_DIGITS = 3
# Fonts may encode the same printed hyphen differently; mathematical and long dashes are distinct.
_LAYOUT_HYPHENS = str.maketrans({"\u2010": "-", "\u2011": "-"})


def _normalize_text(text):
    """Normalize Unicode compatibility forms and whitespace, preserving case."""
    return " ".join(unicodedata.normalize("NFKC", text).split())


def _layout_text(text):
    """Compare captured printed glyphs despite extractor spacing and font hyphen encoding."""
    # The producer and PDF extractor add/remove word and line spaces independently.
    # Preserve NUL gaps so this cannot join hidden, clipped or unrelated character runs.
    return "".join(_normalize_text(text).translate(_LAYOUT_HYPHENS).split())


def _open_pdf(content):
    """Open the exact hashed bytes; reject unreadable or encrypted documents."""
    document = pymupdf.open(stream=content, filetype="pdf")
    if not document.is_pdf or document.needs_pass or not document.page_count:
        document.close()
        raise ValueError("pdf_unavailable")
    return document


def _coordinates(value, length):
    """Copy finite JSON coordinates without accepting booleans or repairing values."""
    if (not isinstance(value, (list, tuple)) or len(value) != length
            or any(type(number) not in (int, float) for number in value)):
        raise ValueError("invalid_geometry")
    try:
        coordinates = [float(number) for number in value]
    except OverflowError as error:
        raise ValueError("invalid_geometry") from error
    if not all(math.isfinite(number) for number in coordinates):
        raise ValueError("invalid_geometry")
    return coordinates


def _quad_rectangle(quad):
    """Require a strictly convex clockwise quad in PDF user space and return its bounds."""
    points = list(zip(quad[::2], quad[1::2]))
    for index, (x, y) in enumerate(points):
        next_x, next_y = points[(index + 1) % len(points)]
        last_x, last_y = points[(index + 2) % len(points)]
        cross = (next_x - x) * (last_y - next_y) - (next_y - y) * (last_x - next_x)
        # PDF y increases upward: TL/TR/BR/BL is clockwise, unlike MuPDF's quad storage.
        if not math.isfinite(cross) or cross >= 0:
            raise ValueError("invalid_geometry")
    return [min(quad[::2]), min(quad[1::2]), max(quad[::2]), max(quad[1::2])]


def _location(value, schema_version=1):
    """Validate captured/v1 rectangles or v2 paired rectangles and cyclic quads."""
    fields = {"page", "rects", "quads"} if schema_version == 2 else {"page", "rects"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("invalid_geometry")
    page_number = value["page"]
    rectangles = value["rects"]
    if type(page_number) is not int or page_number < 0:
        raise ValueError("invalid_geometry")
    if not isinstance(rectangles, list) or not rectangles:
        raise ValueError("invalid_geometry")
    normalized = []
    for rectangle in rectangles:
        coordinates = _coordinates(rectangle, 4)
        x0, y0, x1, y1 = coordinates
        if x0 >= x1 or y0 >= y1:
            raise ValueError("invalid_geometry")
        normalized.append(coordinates)
    location = {"page": page_number, "rects": normalized}
    if schema_version == 2:
        quads = value["quads"]
        if not isinstance(quads, list) or len(quads) != len(normalized):
            raise ValueError("invalid_geometry")
        location["quads"] = []
        for rectangle, quad in zip(normalized, quads):
            coordinates = _coordinates(quad, 8)
            if any(abs(a - b) > _GEOMETRY_EPSILON
                   for a, b in zip(rectangle, _quad_rectangle(coordinates))):
                raise ValueError("invalid_geometry")
            location["quads"].append(coordinates)
    return location


def _contains(outer, inner):
    """Check full containment rather than accepting partially clipped glyphs."""
    return (outer.x0 - _GEOMETRY_EPSILON <= inner.x0
            and outer.y0 - _GEOMETRY_EPSILON <= inner.y0
            and outer.x1 + _GEOMETRY_EPSILON >= inner.x1
            and outer.y1 + _GEOMETRY_EPSILON >= inner.y1)


def _page_space(page, cache):
    """Read the real unrotated page matrix, including crop offsets and UserUnit."""
    if page.number not in cache:
        rotation = page.rotation
        try:
            # 1.26.7 omits crop offsets in the matrix while /Rotate is nonzero.
            # Only the in-memory document changes; callers never save these PDFs.
            if rotation:
                page.set_rotation(0)
            matrix = page.transformation_matrix
            bounds = page.rect
        finally:
            if rotation:
                page.set_rotation(rotation)
        if (not all(math.isfinite(value) for value in matrix)
                or matrix.a <= 0 or matrix.d >= 0
                or abs(matrix.b) > _GEOMETRY_EPSILON
                or abs(matrix.c) > _GEOMETRY_EPSILON
                or bounds.is_empty or bounds.is_infinite):
            raise ValueError("unsupported_transformation")
        cache[page.number] = (matrix, bounds)
    return cache[page.number]


def _clips(document, location, cache):
    """Check actual page bounds; paired rectangle bounds also constrain every v2 vertex."""
    if location["page"] >= document.page_count:
        raise ValueError("invalid_geometry")
    page = document[location["page"]]
    matrix, bounds = _page_space(page, cache)
    clips = []
    for rectangle in location["rects"]:
        clip = pymupdf.Rect(rectangle) * matrix
        if (clip.is_empty or clip.is_infinite
                or not all(math.isfinite(value) for value in clip)
                or not _contains(bounds, clip)):
            raise ValueError("invalid_geometry")
        clips.append(clip)
    return page, clips


def _glyph_key(character, origin):
    """Identify an extracted glyph across the text and paint APIs."""
    return character, tuple(round(value, _ORIGIN_DIGITS) for value in origin)


def _active_paint_box(origin, active):
    """Use only valid, agreeing geometry from the already unoccluded paint sequences."""
    if not active:
        return None
    # Declared widths and font advances may differ; anchor rather than crop actual paint bounds.
    point = pymupdf.Point(origin)
    anchor = pymupdf.Rect(point, point)
    first = active[0][1]
    for _, box in active:
        if (box.is_empty or box.is_infinite or not all(math.isfinite(value) for value in box)
                or not _contains(box, anchor)
                or any(abs(a - b) > _GEOMETRY_EPSILON for a, b in zip(first, box))):
            return None
    # Filled-and-stroked text may report the same glyph twice with identical bounds.
    return pymupdf.Rect(first)


def _trace_compounds(span):
    """Identify adjacent ToUnicode continuations without treating them as painted glyphs."""
    chars = span["chars"]
    for index, (codepoint, glyph, origin, bbox) in enumerate(chars):
        if glyph < 0:
            continue
        end = index + 1
        while end < len(chars) and chars[end][1] == -1:
            end += 1
        if end == index + 1:
            continue
        members = chars[index:end]
        # Invalid compound evidence must not fall back to accepting its lead alone.
        valid = (span.get("dir") == (1.0, 0.0) and span.get("wmode") == 0
                 and all(member[2] == origin
                         and member[3] == (origin[0], bbox[1], origin[0], bbox[3])
                         for member in members[1:]))
        literal = tuple(chr(member[0]) for member in members) if valid else None
        yield _glyph_key(chr(codepoint), origin), literal, span["seqno"], pymupdf.Rect(bbox)


def _compound_indices(line, index, paints):
    """Pair a trace compound with consecutive raw continuations on one baseline."""
    literal = paints[0][0]
    if (literal is None or any(paint[0] != literal for paint in paints)
            or any(text == "\0" or text.isspace() for text in literal)
            or line["direction"] != (1.0, 0.0) or line["writing_mode"] != 0):
        return None
    glyphs = line["characters"][index:index + len(literal)]
    if tuple(glyph["text"] for glyph in glyphs) != literal:
        return None
    lead = glyphs[0]
    box, origin = lead["box"], lead["raw"]["origin"]
    if box.is_empty or box.is_infinite or not all(math.isfinite(value) for value in box):
        return None
    for glyph in glyphs[1:]:
        raw_box, raw_origin = glyph["box"], glyph["raw"]["origin"]
        if (glyph["span"] is not lead["span"] or raw_box.x1 < raw_box.x0
                or not all(math.isfinite(value) for value in (*raw_box, *raw_origin))
                or any(abs(a - b) > _GEOMETRY_EPSILON for a, b in
                       zip((raw_box.x0, raw_box.y0, raw_box.y1), (box.x1, box.y0, box.y1)))
                or any(abs(a - b) > _GEOMETRY_EPSILON for a, b in
                       zip(raw_origin, (box.x1, origin[1])))):
            return None
        # A following real glyph can share the tail's literal/origin (for example, "fll").
        # Its paint lookup is not evidence against the preceding ToUnicode continuation.
        # Some embedded fonts also give the virtual tail a metric width; trace paint is real.
    return tuple(range(index, index + len(literal)))


def _page_text(page, bounds, cache):
    """Keep raw literal evidence and active paint bounds; emit quads only after matching."""
    if page.number not in cache:
        raw = page.get_text("rawdict", clip=bounds,
                            flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
        painted, compounds = {}, {}
        for span in page.get_texttrace():
            if span["type"] not in (0, 1) or span["opacity"] <= 0:
                continue
            for key, literal, sequence, box in _trace_compounds(span):
                compounds.setdefault(key, []).append((literal, sequence, box))
            for codepoint, glyph, origin, box in span["chars"]:
                if glyph < 0:
                    continue
                key = _glyph_key(chr(codepoint), origin)
                painted.setdefault(key, []).append((span["seqno"], pymupdf.Rect(box)))
        # Nontext painting may cover text. Neighboring glyphs commonly have overlapping
        # metric boxes, so later text painting alone is not evidence of occlusion.
        overlays = [(sequence, pymupdf.Rect(box))
                    for sequence, (kind, box) in enumerate(page.get_bboxlog())
                    if kind in {"fill-path", "stroke-path", "fill-image", "fill-shade"}]
        lines = []
        for block in raw["blocks"]:
            for line in block.get("lines", []):
                characters = []
                for span in line["spans"]:
                    visible = (span.get("alpha", 0) > 0
                               and bool(span.get("char_flags", 0) & _PAINTED_TEXT_FLAGS))
                    for character in span["chars"]:
                        box = pymupdf.Rect(character["bbox"])
                        sequences = painted.get(_glyph_key(character["c"], character["origin"]), [])
                        active = [(sequence, paint_box) for sequence, paint_box in sequences
                                  if not any(later > sequence and overlay.intersects(box)
                                             for later, overlay in overlays)]
                        # Positioned words may have extractor-generated spaces
                        # without a painted space glyph; whitespace is still literal.
                        uncovered = character["c"].isspace() or bool(active)
                        characters.append({"text": character["c"], "box": box,
                                           "visible": visible and uncovered,
                                           "paint_box": (_active_paint_box(character["origin"], active)
                                                         if visible else None),
                                           "raw": character, "span": span})
                extracted = {"direction": line.get("dir"), "writing_mode": line.get("wmode"),
                             "characters": characters}
                for index, character in enumerate(characters):
                    if character.get("compound") is not None:
                        continue
                    key = _glyph_key(character["text"], character["raw"]["origin"])
                    if key not in compounds:
                        continue
                    paints = compounds[key]
                    indices = _compound_indices(extracted, index, paints)
                    if indices is None:
                        character["visible"], character["paint_box"] = False, None
                        continue
                    # Every literal member is painted by the lead, including any covered tail.
                    members = [characters[member] for member in indices]
                    active = [(sequence, paint_box) for _, sequence, paint_box in paints
                              if not any(later > sequence and (overlay.intersects(paint_box)
                                         or any(overlay.intersects(member["box"]) for member in members))
                                         for later, overlay in overlays)]
                    paint_box = _active_paint_box(character["raw"]["origin"], active)
                    visible = (paint_box is not None and all(
                        member["span"].get("alpha", 0) > 0
                        and bool(member["span"].get("char_flags", 0) & _PAINTED_TEXT_FLAGS)
                        for member in members))
                    for member in members:
                        member.update(compound=indices, visible=visible, paint_box=paint_box)
                lines.append(extracted)
        cache[page.number] = lines
    return cache[page.number]


def _visible_text(page, clips, bounds, cache):
    """Inspect raw literal glyphs through fully contained raw or active painted clips."""
    fragments = []
    for clip in clips:
        for line in _page_text(page, bounds, cache):
            glyphs = line["characters"]
            selected = [glyph["visible"] and (
                        (not glyph.get("compound") and _contains(clip, glyph["box"]))
                        or (glyph["paint_box"] is not None and _contains(clip, glyph["paint_box"])))
                        for glyph in glyphs]
            included = [index for index, inside in enumerate(selected) if inside]
            if included:
                # Extractor-generated spaces have no paint bounds. Retain only visible
                # whitespace between contained glyphs; nonspace gaps remain NUL barriers.
                characters = []
                for index in range(included[0], included[-1] + 1):
                    glyph = glyphs[index]
                    if selected[index] or (glyph["visible"] and glyph["text"].isspace()):
                        characters.append(glyph["text"])
                    else:
                        characters.append("\0")
                fragments.append("".join(characters))
    return _normalize_text("\n".join(fragments))


def _matched_characters(lines, clips, expected):
    """Locate one literal occurrence and retain only complete glyphs belonging to it."""
    fragments, references = [], []
    for clip_number, clip in enumerate(clips):
        for line_number, line in enumerate(lines):
            selected = [(clip_number, line_number, index)
                        if glyph["visible"] and (
                            (not glyph.get("compound") and _contains(clip, glyph["box"]))
                            or (glyph.get("compound") and glyph["paint_box"] is not None
                                and _contains(clip, glyph["paint_box"]))) else None
                        for index, glyph in enumerate(line["characters"])]
            included = [index for index, reference in enumerate(selected) if reference is not None]
            if included:
                selected = selected[included[0]:included[-1] + 1]
                fragments.append("".join("\0" if reference is None else
                                         line["characters"][reference[2]]["text"]
                                         for reference in selected))
                references.extend(selected)
    observed = _layout_text("\n".join(fragments))
    literal = _layout_text(expected)
    start = observed.find(literal)
    if start < 0:
        raise ValueError("text_not_found")
    if observed.find(literal, start + 1) >= 0:
        raise ValueError("ambiguous_text")

    glyph_text, offsets = [], []
    for reference in references:
        text = ("\0" if reference is None else
                lines[reference[1]]["characters"][reference[2]]["text"])
        normalized = _layout_text(text)
        glyph_text.append(normalized)
        offsets.extend([reference] * len(normalized))
    # Cross-glyph Unicode composition needs a different offset map, not guessed boxes.
    if "".join(glyph_text) != observed:
        raise ValueError("unsupported_text_geometry")
    end = start + len(literal)
    if ((start and offsets[start - 1] == offsets[start])
            or (end < len(offsets) and offsets[end - 1] == offsets[end])):
        raise ValueError("unsupported_text_geometry")
    matched = []
    seen = set()
    for reference in offsets[start:end]:
        if matched and matched[-1] == reference:
            continue
        identity = reference[1:]
        if identity in seen:
            raise ValueError("ambiguous_text")
        seen.add(identity)
        matched.append(reference)
    selected = set(matched)
    for clip_number, line_number, index in matched:
        compound = lines[line_number]["characters"][index].get("compound", ())
        # Offset matching must not split a multi-character ToUnicode paint operation.
        if any((clip_number, line_number, member) not in selected for member in compound):
            raise ValueError("unsupported_text_geometry")
    return matched


def _line_quad(line, indices, matrix):
    """Envelope only matched nonspace glyphs along a confidently extracted line direction."""
    direction = line["direction"]
    if (line["writing_mode"] != 0 or not isinstance(direction, (list, tuple))
            or len(direction) != 2 or not all(math.isfinite(value) for value in direction)):
        raise ValueError("unsupported_direction")
    dx, dy = direction
    length = math.hypot(dx, dy)
    if abs(length - 1) > _GEOMETRY_EPSILON:
        raise ValueError("unsupported_direction")
    dx, dy = dx / length, dy / length
    glyphs = [line["characters"][index] for index in indices]
    if dx == 1 and dy == 0:
        rectangle = pymupdf.Rect()
        for glyph in glyphs:
            # Ascender boxes can overlap adjacent lines; use the same visible paint evidence.
            if glyph["paint_box"] is None:
                raise ValueError("geometry_unavailable")
            rectangle |= glyph["paint_box"]
        points = (rectangle.tl, rectangle.tr, rectangle.br, rectangle.bl)
    else:
        points = []
        for glyph in glyphs:
            try:
                quad = pymupdf.recover_char_quad(direction, glyph["span"], glyph["raw"])
            except Exception as error:
                raise ValueError("geometry_unavailable") from error
            if not quad.is_convex or not _contains(glyph["box"], quad.rect):
                raise ValueError("unsupported_direction")
            points.extend((quad.ul, quad.ur, quad.lr, quad.ll))
        # Project actual recovered corners onto the line and its perpendicular, not page axes.
        along = [point.x * dx + point.y * dy for point in points]
        across = [-point.x * dy + point.y * dx for point in points]
        left, right, top, bottom = min(along), max(along), min(across), max(across)
        points = [pymupdf.Point(dx * u - dy * v, dy * u + dx * v)
                  for u, v in ((left, top), (right, top), (right, bottom), (left, bottom))]
    return [coordinate for point in points for coordinate in point * ~matrix]


def _matched_location(page_number, lines, matched, matrix):
    """Emit per-line glyph envelopes, keeping distinct captured islands separate."""
    groups = []
    for clip_number, line_number, index in matched:
        if groups and groups[-1][:2] == (clip_number, line_number):
            groups[-1][2].append(index)
        else:
            groups.append((clip_number, line_number, [index]))
    quads = [_line_quad(lines[line_number], indices, matrix)
             for _, line_number, indices in groups]
    return _location({"page": page_number, "rects": [_quad_rectangle(quad) for quad in quads],
                      "quads": quads}, SCHEMA_VERSION)


def _candidate(candidate, documents, spaces, texts, seen):
    """Verify both literal sides before deriving any public line geometry."""
    if not isinstance(candidate, dict) or type(candidate.get("applied")) is not bool:
        raise ValueError("invalid_candidate")
    if not candidate["applied"]:
        raise ValueError("unapplied")
    identifier = candidate.get("id")
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError("invalid_id")
    if identifier in seen:
        raise ValueError("duplicate_id")
    seen.add(identifier)
    unit = {"id": identifier, "status": "verified"}
    evidence = {}
    for side, document in documents.items():
        try:
            location = _location(candidate.get(side))
            page, clips = _clips(document, location, spaces[side])
        except ValueError as error:
            raise ValueError(f"{side}_{error}") from error
        if side == "target" and location["page"] != evidence["source"][0]:
            raise ValueError("cross_page")
        expected = candidate.get(f"{side}_text")
        if not isinstance(expected, str) or not _normalize_text(expected) or "\0" in expected:
            raise ValueError(f"{side}_invalid_text")
        matrix, bounds = _page_space(page, spaces[side])
        try:
            lines = _page_text(page, bounds, texts[side])
        except Exception as error:
            # Extraction failure disables this candidate, not translation or PDFs.
            raise ValueError(f"{side}_text_unavailable") from error
        try:
            matched = _matched_characters(lines, clips, expected)
        except ValueError as error:
            raise ValueError(f"{side}_{error}") from error
        evidence[side] = (location["page"], lines, matched, matrix)
    for side, document in documents.items():
        try:
            location = _matched_location(*evidence[side])
            _clips(document, location, spaces[side])
        except ValueError as error:
            raise ValueError(f"{side}_{error}") from error
        except Exception as error:
            raise ValueError(f"{side}_geometry_unavailable") from error
        unit[side] = location
    return unit


def build_mapping(source_path, output_path, candidates):
    """Build schema v2 from captured pairs; candidate failures become reason counts.

    Unreadable/encrypted PDFs raise an exception; no files are written here.
    """
    source = Path(source_path).read_bytes()
    output = Path(output_path).read_bytes()
    units, reasons, seen = [], Counter(), set()
    candidate_count = 0
    with _open_pdf(source) as source_document, _open_pdf(output) as output_document:
        documents = {"source": source_document, "target": output_document}
        spaces = {"source": {}, "target": {}}
        texts = {"source": {}, "target": {}}
        for candidate in candidates:
            candidate_count += 1
            try:
                units.append(_candidate(candidate, documents, spaces, texts, seen))
            except ValueError as error:
                reasons[str(error)] += 1
    return {"schema_version": SCHEMA_VERSION, "generator_version": GENERATOR_VERSION,
            "coordinate_space": COORDINATE_SPACE,
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "output_sha256": hashlib.sha256(output).hexdigest(), "units": units,
            "metadata": {"candidate_count": candidate_count, "verified_count": len(units),
                         "excluded_count": sum(reasons.values()), "exclusion_reasons": dict(reasons)}}


def _validate_mapping(mapping):
    """Reject invalid sidecar structure before saving or consulting PDF geometry."""
    required = {"schema_version", "coordinate_space", "source_sha256", "output_sha256", "units"}
    if not isinstance(mapping, dict) or not required <= set(mapping):
        raise ValueError("invalid_mapping")
    version = mapping["schema_version"]
    if type(version) is not int or version not in (1, SCHEMA_VERSION):
        raise ValueError("schema_version_mismatch")
    if version == 2:
        required.add("generator_version")
        if mapping.get("generator_version") != GENERATOR_VERSION:
            raise ValueError("generator_version_mismatch")
    if not required <= set(mapping) or set(mapping) - required - {"metadata"}:
        raise ValueError("invalid_mapping")
    if mapping["coordinate_space"] != COORDINATE_SPACE:
        raise ValueError("unsupported_coordinate_space")
    for field in ("source_sha256", "output_sha256"):
        digest = mapping[field]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("invalid_mapping")
    if not isinstance(mapping["units"], list):
        raise ValueError("invalid_mapping")
    seen = set()
    for unit in mapping["units"]:
        if not isinstance(unit, dict) or set(unit) != {"id", "status", "source", "target"}:
            raise ValueError("invalid_mapping")
        identifier = unit["id"]
        if (not isinstance(identifier, str) or not identifier.strip()
                or identifier in seen or unit["status"] != "verified"):
            raise ValueError("invalid_mapping")
        seen.add(identifier)
        for side in ("source", "target"):
            _location(unit[side], version)
    if "metadata" in mapping:
        metadata = mapping["metadata"]
        if (not isinstance(metadata, dict)
                or set(metadata) != {"candidate_count", "verified_count", "excluded_count", "exclusion_reasons"}):
            raise ValueError("invalid_metadata")
        for field in ("candidate_count", "verified_count", "excluded_count"):
            if type(metadata[field]) is not int or metadata[field] < 0:
                raise ValueError("invalid_metadata")
        reasons = metadata["exclusion_reasons"]
        if not isinstance(reasons, dict) or any(not isinstance(key, str) or not key
                                               or type(count) is not int or count < 1
                                               for key, count in reasons.items()):
            raise ValueError("invalid_metadata")
        if (metadata["verified_count"] != len(mapping["units"])
                or metadata["excluded_count"] != sum(reasons.values())
                or metadata["candidate_count"] != metadata["verified_count"] + metadata["excluded_count"]):
            raise ValueError("invalid_metadata")


def write_mapping(path, mapping):
    """Atomically replace a sidecar in an existing directory; never write a PDF."""
    _validate_mapping(mapping)
    destination = Path(path)
    if destination.suffix.lower() == ".pdf":
        raise ValueError("mapping_path_must_not_be_pdf")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=f".{destination.name}.", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(mapping, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_mapping(mapping_path, source_path, output_path):
    """Return availability after schema, byte-hash, and actual PDF geometry checks.

    Failure disables only mapping; this function never writes or translates.
    """
    try:
        mapping = json.loads(Path(mapping_path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"available": False, "reason": "missing_mapping"}
    except (UnicodeError, json.JSONDecodeError):
        return {"available": False, "reason": "corrupt_mapping"}
    except OSError:
        return {"available": False, "reason": "unreadable_mapping"}
    try:
        _validate_mapping(mapping)
        contents = {}
        for side, path in (("source", source_path), ("output", output_path)):
            try:
                contents[side] = Path(path).read_bytes()
            except OSError:
                return {"available": False, "reason": f"{side}_pdf_unavailable"}
            if hashlib.sha256(contents[side]).hexdigest() != mapping[f"{side}_sha256"]:
                return {"available": False, "reason": f"{side}_hash_changed"}
        with _open_pdf(contents["source"]) as source, _open_pdf(contents["output"]) as output:
            documents = {"source": source, "target": output}
            spaces = {"source": {}, "target": {}}
            for unit in mapping["units"]:
                for side, document in documents.items():
                    try:
                        _clips(document, _location(unit[side], mapping["schema_version"]), spaces[side])
                    except ValueError as error:
                        return {"available": False, "reason": f"{side}_{error}"}
        if not mapping["units"]:
            return {"available": False, "reason": "no_verified_units"}
        return {"available": True, "mapping": mapping}
    except ValueError as error:
        return {"available": False, "reason": str(error)}
    except Exception:
        # Corrupt PDF internals or extraction APIs must not block basic reading.
        return {"available": False, "reason": "pdf_unavailable"}
