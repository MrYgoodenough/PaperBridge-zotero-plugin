"""Capture bounded, applied request fragments through the existing IL adapter.

Only verified geometry and PDF hashes are persisted; captured text stays in memory.
"""

import hashlib
import logging
import math
from collections import Counter
from pathlib import Path

import pymupdf

from alignment import _page_space, _page_text, build_mapping, write_mapping

# Limit retained identities independently of translation size or provider settings.
MAX_TRACE_UNITS = 4096
# Bound retained before-images without limiting the translation itself.
MAX_TRACE_CHARACTERS = 1_000_000
# Exclude unsupported giant fragments without changing the translation request itself.
MAX_UNIT_CHARACTERS = 32768
# Pinned BabelDOC uses 0 for page text; positive IDs identify actual form XObjects.
PAGE_TEXT_XOBJECT_IDS = (None, -1, 0)
# Trace failures are advisory and never include paragraph text or credentials.
LOGGER = logging.getLogger(__name__)


def _digest(path):
    """Hash the original input snapshot without retaining its bytes in the trace."""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _box(box):
    """Copy a finite, nonempty IL box rather than keeping mutable source geometry."""
    values = [float(getattr(box, name)) for name in ("x", "y", "x2", "y2")]
    if (not all(math.isfinite(value) for value in values)
            or values[0] >= values[2] or values[1] >= values[3]):
        raise ValueError("unsupported_box")
    return values


def _offset(page):
    """Read the IL crop origin used by the pinned parser and final PDF writer."""
    # The upstream preprocessor removes PDF crop boxes. Do not substitute the
    # original PDF's crop origin for this captured working-page origin.
    crop = _box(page.cropbox.box)
    return crop[0], crop[1]


def _translate_box(box, offset):
    """Restore the working-page origin to obtain unrotated PDF user coordinates."""
    x, y = offset
    return [box[0] + x, box[1] + y, box[2] + x, box[3] + y]


def _painted_rectangle(document, page_number, captured, cache):
    """Expand visual bounds to actual visible glyph extents, without text matching."""
    page = document[page_number]
    matrix, bounds = _page_space(page, cache["spaces"])
    region = pymupdf.Rect(captured) * matrix
    # Keep only one page's glyph cache per side; source and target use their own matrices.
    if cache.get("page") != page_number:
        cache["texts"].clear()
        cache["page"] = page_number
    union = pymupdf.Rect()
    for line in _page_text(page, bounds, cache["texts"]):
        for _, box, visible in line:
            if visible and region.contains((box.tl + box.br) / 2):
                union |= box
    if union.is_empty:
        raise ValueError("no_visible_glyphs")
    # _page_space handles crop, rotation and UserUnit using the same contract as validation.
    return list(union * ~matrix)


class FragmentTrace:
    """Retain before-images and the same mutable objects until final PDF preservation."""

    def __init__(self, source_path):
        """Bind to the ORIGINAL snapshot, even if the engine later uses repaired.pdf."""
        self.source_path = Path(source_path)
        self.rows = {}
        self.characters = 0
        self.excluded = Counter()
        self.document = None
        self.disabled = False
        try:
            self.source_sha256 = _digest(self.source_path)
        except Exception as error:
            self._disable(error)

    def _disable(self, error):
        """Release retained objects after capture failure without affecting translation."""
        self.disabled = True
        self.rows.clear()
        self.document = None
        LOGGER.warning("Paragraph hover trace unavailable (%s); translation continues",
                       type(error).__name__)

    def inventory(self, docs):
        """Snapshot before workers run; malformed or oversized units are only excluded."""
        if self.disabled:
            return
        try:
            self.document = docs
            for page in docs.page:
                for index, paragraph in enumerate(page.pdf_paragraph):
                    try:
                        self._capture(page, paragraph, index)
                    except (ValueError, AttributeError, TypeError, OverflowError):
                        self.excluded["unsupported_source"] += 1
        except Exception as error:
            self._disable(error)

    def _capture(self, page, paragraph, index):
        """Retain one independently applied paragraph identity, not a batch-level guess."""
        text = paragraph.unicode
        if not isinstance(text, str) or not text.strip():
            self.excluded["missing_text"] += 1
            return
        if (len(self.rows) >= MAX_TRACE_UNITS or len(text) > MAX_UNIT_CHARACTERS
                or self.characters + len(text) > MAX_TRACE_CHARACTERS):
            self.excluded["capture_limit"] += 1
            return
        number = page.page_number
        if (type(number) is not int or number < 0 or paragraph.vertical
                or getattr(paragraph, "xobj_id", None) not in PAGE_TEXT_XOBJECT_IDS):
            raise ValueError("unsupported_source")
        key = id(paragraph)
        if key in self.rows:
            # The same identity on multiple pages has no schema-v1 location.
            self.rows[key] = None
            self.excluded["duplicate_identity"] += 1
            return
        rectangle = _translate_box(_box(paragraph.box), _offset(page))
        self.rows[key] = {"id": f"p{number}-u{index}", "page": number,
                          "source_rect": rectangle, "source_text": text,
                          "paragraph": paragraph}
        self.characters += len(text)

    def _candidates(self, source, output, quality):
        """Yield only applied same-page identities still present after final typesetting."""
        locations = {}
        for page in self.document.page:
            for paragraph in page.pdf_paragraph:
                key = id(paragraph)
                if key in self.rows:
                    locations.setdefault(key, []).append(page)
        caches = {side: {"spaces": {}, "texts": {}} for side in ("source", "target")}
        target_characters = 0
        for key, row in self.rows.items():
            if row is None:
                continue
            if not quality.paragraphs.get(key, {}).get("applied", False):
                self.excluded["unapplied"] += 1
                continue
            pages = locations.get(key, [])
            if len(pages) != 1 or pages[0].page_number != row["page"]:
                self.excluded["moved_or_merged"] += 1
                continue
            try:
                paragraph = row["paragraph"]
                parts = paragraph.pdf_paragraph_composition
                if not parts or len(parts) > MAX_UNIT_CHARACTERS:
                    raise ValueError("unsupported_target")
                characters = [part.pdf_character for part in parts]
                if any(character is None for character in characters):
                    # Unresolved formulas/style runs are not a smaller request fragment.
                    raise ValueError("unsupported_target")
                text = "".join(character.char_unicode or "" for character in characters)
                if (not text.strip() or len(text) > MAX_UNIT_CHARACTERS
                        or target_characters + len(text) > MAX_TRACE_CHARACTERS):
                    raise ValueError("unsupported_target")
                boxes = [_box(character.visual_bbox.box if character.visual_bbox else character.box)
                         for character in characters]
                rectangle = [min(box[0] for box in boxes), min(box[1] for box in boxes),
                             max(box[2] for box in boxes), max(box[3] for box in boxes)]
                rectangle = _translate_box(rectangle, _offset(pages[0]))
                number = row["page"]
                source_rect = _painted_rectangle(source, number, row["source_rect"], caches["source"])
                target_rect = _painted_rectangle(output, number, rectangle, caches["target"])
                target_characters += len(text)
                yield {"id": row["id"], "applied": True,
                       "source": {"page": number, "rects": [source_rect]},
                       "target": {"page": number, "rects": [target_rect]},
                       "source_text": row["source_text"], "target_text": text}
            except (ValueError, AttributeError, TypeError, IndexError, OverflowError):
                self.excluded["unsupported_final_geometry"] += 1

    def write(self, output_path, mapping_path, quality):
        """Validate after preservation and atomically write verified units; failures are advisory."""
        if self.disabled:
            return None
        try:
            if _digest(self.source_path) != self.source_sha256:
                raise ValueError("original_snapshot_changed")
            if self.document is None:
                raise ValueError("inventory_unavailable")
            with pymupdf.open(self.source_path) as source, pymupdf.open(output_path) as output:
                mapping = build_mapping(self.source_path, output_path,
                                        self._candidates(source, output, quality))
            if mapping["source_sha256"] != self.source_sha256:
                raise ValueError("original_snapshot_changed")
            write_mapping(mapping_path, mapping)
            exclusions = self.excluded + Counter(mapping["metadata"]["exclusion_reasons"])
            LOGGER.info("Paragraph hover trace: %d verified units", len(mapping["units"]))
            if exclusions:
                LOGGER.warning("Paragraph hover trace excluded units: %s", dict(exclusions))
            return mapping
        except Exception as error:
            self._disable(error)
            return None
        finally:
            # Paragraph and full text before-images are never a persistent sidecar.
            self.rows.clear()
            self.document = None
