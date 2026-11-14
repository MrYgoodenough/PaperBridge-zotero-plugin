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

# Version of the captured-pair sidecar contract.
SCHEMA_VERSION = 1
# Rectangles use unrotated PDF user coordinates, not screen pixels.
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


def _location(value):
    """Validate and copy the JSON location shape without repairing coordinates."""
    if not isinstance(value, dict) or set(value) != {"page", "rects"}:
        raise ValueError("invalid_geometry")
    page_number = value["page"]
    rectangles = value["rects"]
    if type(page_number) is not int or page_number < 0:
        raise ValueError("invalid_geometry")
    if not isinstance(rectangles, list) or not rectangles:
        raise ValueError("invalid_geometry")
    normalized = []
    for rectangle in rectangles:
        if not isinstance(rectangle, (list, tuple)) or len(rectangle) != 4:
            raise ValueError("invalid_geometry")
        if any(type(number) not in (int, float) for number in rectangle):
            raise ValueError("invalid_geometry")
        try:
            coordinates = [float(number) for number in rectangle]
        except OverflowError as error:
            raise ValueError("invalid_geometry") from error
        x0, y0, x1, y1 = coordinates
        if not all(math.isfinite(number) for number in coordinates) or x0 >= x1 or y0 >= y1:
            raise ValueError("invalid_geometry")
        normalized.append(coordinates)
    return {"page": page_number, "rects": normalized}


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
    """Convert captured PDF-user rectangles to valid unrotated PyMuPDF clips."""
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


def _page_text(page, bounds, cache):
    """Cache text and paint evidence, excluding hidden or overpainted glyphs."""
    if page.number not in cache:
        raw = page.get_text("rawdict", clip=bounds,
                            flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
        painted = {}
        for span in page.get_texttrace():
            if span["type"] not in (0, 1) or span["opacity"] <= 0:
                continue
            for codepoint, _, origin, _ in span["chars"]:
                key = _glyph_key(chr(codepoint), origin)
                painted.setdefault(key, []).append(span["seqno"])
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
                        # Positioned words may have extractor-generated spaces
                        # without a painted space glyph; whitespace is still literal.
                        uncovered = character["c"].isspace() or any(
                            not any(later > sequence and overlay.intersects(box)
                                    for later, overlay in overlays)
                            for sequence in sequences)
                        characters.append((character["c"], box, visible and uncovered))
                lines.append(characters)
        cache[page.number] = lines
    return cache[page.number]


def _visible_text(page, clips, bounds, cache):
    """Extract painted text in captured rectangle order, without fuzzy matching."""
    lines = _page_text(page, bounds, cache)
    fragments = []
    for clip in clips:
        for line in lines:
            characters = []
            included = False
            for character, box, visible in line:
                if visible and _contains(clip, box):
                    characters.append(character)
                    included = True
                else:
                    # A gap must not join unrelated visible character runs.
                    characters.append("\0")
            if included:
                fragments.append("".join(characters).strip("\0"))
    return _normalize_text("\n".join(fragments))


def _candidate(candidate, documents, spaces, texts, seen):
    """Validate one applied pair and return only its public mapping fields."""
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
    for side, document in documents.items():
        try:
            location = _location(candidate.get(side))
            page, clips = _clips(document, location, spaces[side])
        except ValueError as error:
            raise ValueError(f"{side}_{error}") from error
        expected = candidate.get(f"{side}_text")
        if not isinstance(expected, str) or not _normalize_text(expected) or "\0" in expected:
            raise ValueError(f"{side}_invalid_text")
        _, bounds = _page_space(page, spaces[side])
        try:
            observed = _visible_text(page, clips, bounds, texts[side])
        except Exception as error:
            # Extraction failure disables this candidate, not translation or PDFs.
            raise ValueError(f"{side}_text_unavailable") from error
        if _layout_text(expected) not in _layout_text(observed):
            raise ValueError(f"{side}_text_not_found")
        unit[side] = location
    return unit


def build_mapping(source_path, output_path, candidates):
    """Build schema v1 from captured pairs; candidate failures become reason counts.

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
    return {"schema_version": SCHEMA_VERSION, "coordinate_space": COORDINATE_SPACE,
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "output_sha256": hashlib.sha256(output).hexdigest(), "units": units,
            "metadata": {"candidate_count": candidate_count, "verified_count": len(units),
                         "excluded_count": sum(reasons.values()), "exclusion_reasons": dict(reasons)}}


def _validate_mapping(mapping):
    """Reject invalid sidecar structure before saving or consulting PDF geometry."""
    required = {"schema_version", "coordinate_space", "source_sha256", "output_sha256", "units"}
    if not isinstance(mapping, dict) or not required <= set(mapping) or set(mapping) - required - {"metadata"}:
        raise ValueError("invalid_mapping")
    if type(mapping["schema_version"]) is not int or mapping["schema_version"] != SCHEMA_VERSION:
        raise ValueError("schema_version_mismatch")
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
            _location(unit[side])
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
                        _clips(document, _location(unit[side]), spaces[side])
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
