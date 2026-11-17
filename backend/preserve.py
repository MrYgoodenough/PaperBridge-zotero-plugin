"""Preserve source backgrounds, protected vectors and reliable links in native page coordinates."""
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

import pymupdf

if __package__:
    from .fonts import subset_songti
else:
    from fonts import subset_songti

# Layout classes whose content is copied verbatim rather than translated.
PROTECTED = {"figure", "table", "isolate_formula", "isolated_formula", "formula"}
# Match PDF coordinates despite harmless decimal serialization differences.
LINK_COORDINATE_TOLERANCE = 0.01
# Cover detector edges when redacting and restoring original vectors.
REGION_PADDING = (-1, -1, 1, 1)
# Email-backed author/affiliation blocks are bibliographic metadata, not body prose.
AUTHOR_EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", re.I)
# Older TeX PDFs extract the copyright glyph as a c with a combining circle.
COPYRIGHT_NOTICE = re.compile(
    r"(?:©|ª|c\u20dd|copyright)\s*(?:©\s*)?\d{4}\b|^\s*\d{4}\s+(?:the\s+)?authors?\b.*\blicensed\b", re.I)
# Limit the author detector to the paper's opening pages and an explicit abstract.
AUTHOR_PAGE_LIMIT = 2
# Long bold prose cannot be interpreted as an author name.
AUTHOR_NAME_LIMIT = 80
# PyMuPDF font flags identify the original bold names and italic affiliations.
BOLD_FLAG = 16
# Italic affiliation lines provide the second independent author-block signal.
ITALIC_FLAG = 2
# Affiliation markers are ignored only while recognizing names, never in restored source text.
SUPERSCRIPT_FLAG = 1
# Legal notices are preserved only in the footer, never inside a body example.
COPYRIGHT_FOOTER_START = 0.80
# Science places its legal notice in a narrow outer margin rather than the footer.
COPYRIGHT_MARGIN_START = 0.80
# Only recurring outer-page text is page furniture, not a body heading or paragraph.
FURNITURE_EDGE_FRACTION = 0.08
# Independent pages, not repeated occurrences on one page, establish a running header/footer.
FURNITURE_MIN_PAGES = 2
# Ignore tiny PDF box serialization differences, not genuine cropping or rotation.
PAGE_COORDINATE_TOLERANCE = 0.01
# Point-sized redactions remove protected labels without erasing neighboring glyph overhangs.
REDACTION_POINT_RADIUS = 0.01
# Short marginal words are not reliable page furniture; printed integer page numbers are.
FURNITURE_MIN_CHARACTERS = 8
# Abstract and Summary both end frontmatter, including inline or spaced headings.
ABSTRACT_HEADING = re.compile(r"^(?:a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|s\s*u\s*m\s*m\s*a\s*r\s*y)\b", re.I)
# Indexed institutions are an independent signal of author metadata.
AFFILIATION_START = re.compile(
    r"^(?:(?:\d{1,2}|[a-z])\s*)?(?:(?:CAS\s+)?key\s+)?"
    r"(?:department|departamento|school|institute|centre|center|division|university|universidad|laboratory|college)\b", re.I)
# Nearby names, institutions and contact lines form metadata, separate from the research title.
AUTHOR_BLOCK_GAP = 20
# Small bibliographic blocks must not absorb large research titles.
AUTHOR_BLOCK_FONT_LIMIT = 14
# A short list of authors is not an abstract paragraph containing punctuation.
AUTHOR_BLOCK_TEXT_LIMIT = 260
# Standalone names may contain initials and compound surnames, not sentence-length clauses.
AUTHOR_NAME_WORD_LIMIT = 6
# Lowercase surname particles are compatible with otherwise capitalized personal names.
AUTHOR_NAME_PARTICLES = {"al", "bin", "da", "de", "del", "den", "der", "di", "dos", "du", "la", "le", "van", "von"}
# Only opening-page names are candidates when a publisher omits an abstract label.
AUTHOR_OPENING_END = 0.45
# Publisher mastheads must stay in the opening quarter, above the research title/body.
MASTHEAD_END = 0.25
# Publisher paper-type labels must not join and overlap the translated research title.
ARTICLE_TYPE = re.compile(r"^(?:research\s+)?article$", re.I)
# Limit paper-type preservation to opening title areas, including one repository cover.
ARTICLE_TYPE_END = 0.30
# Explicit IEEE publication/editorial frontmatter is metadata, not research prose.
FRONT_METADATA = re.compile(
    r"^(?:date of publication|digital object identifier|this work was supported|the associate editor)\b", re.I)
# Match complete DOI/date histories, including wrapped date continuations, not research sentences.
PUBLICATION_HISTORY = re.compile(
    r"(?:(?:(?:https?://(?:dx\.)?doi\.org/|doi\s*:?\s*)10\.\d{4,9}/\S+|"
    r"(?:received(?:\s+in\s+revised\s+form)?|revised|accepted)\s*:?\s*"
    r"(?:\d{1,2}\s+[a-z]+\s+\d{4}|[a-z]+\s+\d{1,2},?\s+\d{4}))\s*[;,]?\s*)+", re.I)
# Publication histories are short frontmatter/footer metadata, not arbitrary DOI-bearing prose.
PUBLICATION_HISTORY_TEXT_LIMIT = 400


def unrotated_full_page(page):
    """Allow nonzero MediaBox origins; PyMuPDF expresses CropBox y in a different space."""
    return (not page.rotation
            and abs(page.cropbox.width - page.mediabox.width) <= PAGE_COORDINATE_TOLERANCE
            and abs(page.cropbox.height - page.mediabox.height) <= PAGE_COORDINATE_TOLERANCE)


def _unrotated_transform(page):
    """Map PDF coordinates to the native unrotated page view, including its crop origin."""
    rotation = page.rotation
    try:
        page.set_rotation(0)
        return pymupdf.Matrix(page.transformation_matrix)
    finally:
        page.set_rotation(rotation)


def repeated_furniture(document):
    """Locate recurring literal headers/footers, including their changing page numbers."""
    candidates, occurrences = {}, Counter()
    for index, page in enumerate(document):
        if not unrotated_full_page(page):
            continue
        entries = []
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                text = "".join(span["text"] for span in line["spans"]).strip()
                edge = "header" if line["bbox"][3] <= page.rect.height * FURNITURE_EDGE_FRACTION else (
                    "footer" if line["bbox"][1] >= page.rect.height * (1 - FURNITURE_EDGE_FRACTION) else None)
                if edge is None or not text:
                    continue
                normalized = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
                if normalized.startswith(("https://", "http://", "www.")) and " " not in normalized:
                    normalized = normalized.rstrip("/")
                if len(normalized) < FURNITURE_MIN_CHARACTERS and not normalized.isdecimal():
                    continue
                signature = (edge, re.sub(r"\d+", "#", normalized))
                entries.append((signature, tuple(line["bbox"])))
        candidates[index] = entries
        occurrences.update({signature for signature, _ in entries})
    return {index: [box for signature, box in entries if occurrences[signature] >= FURNITURE_MIN_PAGES]
            for index, entries in candidates.items()}


def _bounded_author_names(block, text, front_end):
    """Require a short opening list of personal names, without relying on bold styling."""
    author_text = " ".join(text[id(line)] for line in block["lines"])
    if (block["bbox"][3] >= front_end or len(author_text) > AUTHOR_BLOCK_TEXT_LIMIT
            or max(span["size"] for line in block["lines"] for span in line["spans"]) > AUTHOR_BLOCK_FONT_LIMIT):
        return False
    # Superscript indices can contain commas; they are not independent author-name separators.
    plain = " ".join("".join(span["text"] for span in line["spans"]
                             if not span["flags"] & SUPERSCRIPT_FLAG) for line in block["lines"])
    names = [name.strip(" ,*&†‡∗") for name in re.split(
        r",|&|\band\b", unicodedata.normalize("NFKC", plain), flags=re.I)]
    names = [name for name in names if name]
    return len(names) > 1 and all(
        len(name.split()) <= AUTHOR_NAME_WORD_LIMIT
        and all(word[0].isupper() or word.casefold() in AUTHOR_NAME_PARTICLES for word in name.split())
        for name in names)


def metadata_regions(document):
    """Identify narrow legal notices and email-backed author metadata, leaving body text translatable."""
    result = {}
    furniture = repeated_furniture(document)
    for index, page in enumerate(document):
        # Optional metadata protection must not guess across rotated/cropped coordinate systems.
        if not unrotated_full_page(page):
            continue
        blocks = [block for block in page.get_text("dict")["blocks"] if block.get("lines")]
        lines = [line for block in blocks for line in block.get("lines", [])
                 if line.get("spans")]
        text = {id(line): "".join(span["text"] for span in line["spans"]).replace("\u200b", "").strip()
                for line in lines}
        boxes = list(furniture.get(index, []))
        if index < AUTHOR_PAGE_LIMIT:
            boxes.extend(tuple(line["bbox"]) for line in lines
                         if line["bbox"][3] < page.rect.height * ARTICLE_TYPE_END
                         and ARTICLE_TYPE.fullmatch(text[id(line)]))
        for block in blocks:
            block_text = " ".join(text[id(line)] for line in block["lines"])
            if ((block["bbox"][1] >= page.rect.height * COPYRIGHT_FOOTER_START
                 or block["bbox"][0] >= page.rect.width * COPYRIGHT_MARGIN_START)
                    and COPYRIGHT_NOTICE.search(block_text)):
                # Preserve the complete short notice, including its following license URL.
                boxes.append(tuple(block["bbox"]))
            if (index < AUTHOR_PAGE_LIMIT and len(block_text) <= PUBLICATION_HISTORY_TEXT_LIMIT
                    and max(span["size"] for line in block["lines"] for span in line["spans"]) <= AUTHOR_BLOCK_FONT_LIMIT
                    and PUBLICATION_HISTORY.fullmatch(block_text)):
                # Use the actual complete source block, including its revised/accepted continuation.
                boxes.append(tuple(block["bbox"]))
        abstracts = [line["bbox"][1] for line in lines if ABSTRACT_HEADING.match(text[id(line)])]
        # Standalone names must precede both the abstract and the opening-page cutoff.
        author_end = min([page.rect.height * AUTHOR_OPENING_END, *abstracts])
        if index < AUTHOR_PAGE_LIMIT and abstracts:
            boxes.extend(tuple(block["bbox"]) for block in blocks
                         if block["bbox"][3] < min(abstracts)
                         and max(span["size"] for line in block["lines"] for span in line["spans"]) <= AUTHOR_BLOCK_FONT_LIMIT
                         and FRONT_METADATA.match(" ".join(text[id(line)] for line in block["lines"])))
        if index < AUTHOR_PAGE_LIMIT and abstracts:
            front = [line for line in lines if line["bbox"][3] < min(abstracts)]
            emails = [line for line in front if AUTHOR_EMAIL.search(text[id(line)])]
            names = [line for line in front if len(text[id(line)]) <= AUTHOR_NAME_LIMIT
                     and "@" not in text[id(line)] and any(span["flags"] & BOLD_FLAG for span in line["spans"])
                     and any(line["bbox"][2] <= email["bbox"][0]
                             and line["bbox"][1] < email["bbox"][3]
                             and email["bbox"][1] < line["bbox"][3] for email in emails)]
            if names:
                start = min(line["bbox"][1] for line in names)
                affiliations = [line for line in front if line["bbox"][1] >= start
                                and all(span["flags"] & ITALIC_FLAG for span in line["spans"] if span["text"].strip())]
                members = [*names, *emails, *affiliations]
                if affiliations:
                    rectangle = pymupdf.Rect(members[0]["bbox"])
                    for line in members[1:]:
                        rectangle |= pymupdf.Rect(line["bbox"])
                    # Ambiguous intervening prose is not protected merely because an email exists.
                    intervening = [line for line in front if pymupdf.Rect(line["bbox"]).intersects(rectangle)]
                    if all(any(line is member for member in members) for line in intervening):
                        boxes.append(tuple(rectangle))
        if index < AUTHOR_PAGE_LIMIT and any(AUTHOR_EMAIL.search(value) for value in text.values()):
            # An institution word inside prose is not the start of an affiliation block.
            emails = [line for line in lines if AUTHOR_EMAIL.search(text[id(line)])]
            affiliations = [block for block in blocks
                            if AFFILIATION_START.match(" ".join(text[id(line)] for line in block["lines"]))
                            and (block["bbox"][3] < min(abstracts, default=page.rect.height * AUTHOR_OPENING_END)
                                 or AUTHOR_EMAIL.search(" ".join(text[id(line)] for line in block["lines"]))
                                 or any(0 <= email["bbox"][1] - block["bbox"][3] <= AUTHOR_BLOCK_GAP
                                        and block["bbox"][0] <= email["bbox"][0] < block["bbox"][2]
                                        for email in emails))]
            for block in affiliations:
                boxes.append(tuple(block["bbox"]))
                # Names may share the institution block, or immediately precede it.
                for names in blocks:
                    if (0 <= block["bbox"][1] - names["bbox"][3] <= AUTHOR_BLOCK_GAP
                            and _bounded_author_names(names, text, author_end)):
                        boxes.append(tuple(names["bbox"]))
            for block in blocks:
                if (block["bbox"][3] < min(abstracts, default=page.rect.height * AUTHOR_OPENING_END)
                        and AUTHOR_EMAIL.search(" ".join(text[id(line)] for line in block["lines"]))):
                    boxes.append(tuple(block["bbox"]))
                author_text = " ".join(text[id(line)] for line in block["lines"])
                if (affiliations and block["bbox"][3] < page.rect.height * AUTHOR_OPENING_END
                        and len(author_text) <= AUTHOR_BLOCK_TEXT_LIMIT
                        and ("&" in author_text or author_text.count(",") >= 2)
                        and max(span["size"] for line in block["lines"] for span in line["spans"]) <= AUTHOR_BLOCK_FONT_LIMIT
                        and (any(span["flags"] & BOLD_FLAG for line in block["lines"] for span in line["spans"])
                             or (len(block["lines"]) == 1 and "&" in author_text))):
                    boxes.append(tuple(block["bbox"]))
        masthead = [line for line in lines if line["bbox"][3] < page.rect.height * MASTHEAD_END]
        starts = [line["bbox"][1] for line in masthead if text[id(line)].casefold().startswith("contents lists available at")]
        ends = [line["bbox"][3] for line in masthead if text[id(line)].casefold().startswith("journal homepage:")]
        if starts and ends and min(starts) < max(ends):
            # This explicit publisher band must not absorb the research title below it.
            band = [line for line in masthead
                    if line["bbox"][1] >= min(starts) and line["bbox"][3] <= max(ends)]
            if band:
                # Protect the intervening band too, so reflow cannot leave stray translated letters.
                rectangle = pymupdf.Rect(band[0]["bbox"])
                for line in band[1:]:
                    rectangle |= pymupdf.Rect(line["bbox"])
                boxes.append(tuple(rectangle))
        if boxes:
            unique = list(dict.fromkeys(boxes))
            result[index] = [box for box in unique if not any(
                box != other and pymupdf.Rect(other).contains(pymupdf.Rect(box)) for other in unique)]
    return result


def regions_from_layout(layout):
    """Extract protected rectangles in the detector's normalized page coordinates."""
    return [tuple(float(v) for v in box.xyxy) for box in layout.boxes
            if layout.names[int(box.cls)] in PROTECTED]


def exclude_protected_characters(page, height, boxes):
    """Protected graphics are copied verbatim later, so their labels need no LLM input."""
    def inside(character):
        """Test the character center against the protected rectangles."""
        box = character.box
        x = (box.x + box.x2) / 2
        y = height - (box.y + box.y2) / 2
        return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes)
    original_count = len(page.pdf_character)
    page.pdf_character = [character for character in page.pdf_character if not inside(character)]
    return original_count - len(page.pdf_character)


def exclude_clipped_characters(page):
    """Discard glyphs wholly outside their transformed Form BBox; they cannot paint in the source."""
    clips = {}
    for form in getattr(page, "pdf_xobject", []):
        box = getattr(form, "box", None)
        if box is None or not getattr(form, "xobj_id", None):
            continue
        coordinates = [getattr(box, key) for key in ("x", "y", "x2", "y2")]
        if not all(value is not None and math.isfinite(value) for value in coordinates):
            continue
        rectangle = pymupdf.Rect(coordinates)
        if not rectangle.is_empty:
            clips[form.xobj_id] = rectangle
    if not clips:
        return 0

    def visible(character):
        """Keep partial edge glyphs and unknown owners; only a proven outside Form is excluded."""
        clip = clips.get(getattr(character, "xobj_id", None))
        if clip is None:
            return True
        visual = getattr(character, "visual_bbox", None)
        box = getattr(visual, "box", None) or character.box
        coordinates = [getattr(box, key) for key in ("x", "y", "x2", "y2")]
        if not all(value is not None and math.isfinite(value) for value in coordinates):
            return True
        rectangle = pymupdf.Rect(coordinates)
        return rectangle.is_empty or clip.intersects(rectangle)

    original_count = len(page.pdf_character)
    page.pdf_character = [character for character in page.pdf_character if visible(character)]
    return original_count - len(page.pdf_character)


def _order_text_backgrounds(page, source_page, layout, protected_boxes):
    """Keep original white line fills behind their entire text block before reflow."""
    curves = [curve for curve in getattr(page, "pdf_curve", [])
              if curve.xobj_id == 0 and curve.fill_background and not curve.stroke_path
              and curve.render_order is not None]
    if not curves:
        return
    from babeldoc.format.pdf.document_il.utils.layout_helper import Layout, is_text_layout

    height = source_page.mediabox.height
    # Page-level objects have native coordinates; Form clips/transforms are not guessed.
    characters = [(char.render_order, pymupdf.Point(
        (char.box.x + char.box.x2) / 2, height - (char.box.y + char.box.y2) / 2))
        for char in page.pdf_character
        if char.xobj_id == 0 and char.char_unicode and char.char_unicode.strip()
        and char.render_order is not None]
    text_blocks = []
    for box in layout.boxes:
        if not is_text_layout(Layout(int(box.cls), layout.names[int(box.cls)])):
            continue
        rectangle = pymupdf.Rect(tuple(float(value) for value in box.xyxy))
        orders = [order for order, center in characters if center in rectangle]
        if orders:
            text_blocks.append((rectangle, min(orders)))
    white_fills = [draw["rect"] for draw in source_page.get_drawings(extended=True)
                   if draw.get("level") == 0 and draw.get("type") == "f"
                   and draw.get("fill") == (1, 1, 1) and draw.get("fill_opacity") == 1
                   and len(draw["items"]) == 1 and draw["items"][0][0] == "re"]
    for curve in curves:
        box = curve.box
        rectangle = pymupdf.Rect(box.x, height - box.y2, box.x2, height - box.y)
        if (any(rectangle.intersects(pymupdf.Rect(protected)) for protected in protected_boxes)
                or not any(_same_coordinates(rectangle, fill) for fill in white_fills)):
            continue
        covered = [(order, center) for order, center in characters if center in rectangle]
        # A fill originally after its covered text is a whiteout, not a prose background.
        if not covered or min(order for order, _ in covered) <= curve.render_order:
            continue
        orders = [order for block, order in text_blocks if any(center in block for _, center in covered)]
        if orders:
            # BabelDOC moves all translated glyphs to the block's first source paint order.
            curve.render_order = min(curve.render_order, min(orders) - 1)


class ProtectedLayoutModel:
    """Record every translated page, including pages with no protected regions."""

    def __init__(self, model, references=None, metadata=None):
        """Wrap the detector and collect regions needed for final restoration."""
        self.model = model
        self.regions = {}
        self.excluded_characters = 0
        self.excluded_clipped_characters = 0
        self.references = references or {}
        self.excluded_reference_characters = 0
        self.metadata = metadata or {}
        self.excluded_metadata_characters = 0

    @property
    def stride(self):
        """Expose the wrapped detector's image stride."""
        return self.model.stride

    def handle_document(self, pages, document, config, save_debug_image):
        """Exclude protected labels and record the translated page indices."""
        original_transforms = {}
        source_path = getattr(config, "input_file", None)
        if source_path:
            with pymupdf.open(source_path) as source:
                original_transforms = {index: _unrotated_transform(page) for index, page in enumerate(source)}
        for page, layout in self.model.handle_document(pages, document, config, save_debug_image):
            # Cropped figure Forms can retain unrelated full-page text in their content streams.
            self.excluded_clipped_characters += exclude_clipped_characters(page)
            # BabelDOC normalizes MediaBox/CropBox before detection, then restores them on output.
            working_transform = _unrotated_transform(document[page.page_number])
            original_transform = original_transforms.get(page.page_number, working_transform)
            to_original = ~working_transform * original_transform
            to_working = ~to_original
            reference_boxes = self.references.get(page.page_number,[])
            working_references = [tuple(pymupdf.Rect(box) * to_working) for box in reference_boxes]
            self.excluded_reference_characters += exclude_protected_characters(
                page,document[page.page_number].mediabox.height,working_references)
            metadata_boxes = self.metadata.get(page.page_number, [])
            working_metadata = [tuple(pymupdf.Rect(box) * to_working) for box in metadata_boxes]
            self.excluded_metadata_characters += exclude_protected_characters(
                page, document[page.page_number].mediabox.height, working_metadata)
            working_graphics = regions_from_layout(layout)
            self.regions[page.page_number] = [
                *(tuple(pymupdf.Rect(box) * to_original) for box in working_graphics),
                *reference_boxes, *metadata_boxes]
            self.excluded_characters += exclude_protected_characters(
                page, document[page.page_number].mediabox.height, working_graphics)
            _order_text_backgrounds(page, document[page.page_number], layout,
                                    [*working_graphics, *working_references, *working_metadata])
            yield page, layout


def _same_coordinates(left, right):
    """Compare points or rectangles with PDF serialization tolerance."""
    if isinstance(left, str) or isinstance(right, str) or left is None or right is None:
        return left == right
    return len(left) == len(right) and all(
        abs(a - b) <= LINK_COORDINATE_TOLERANCE for a, b in zip(left, right))


def _same_anchor(left, right):
    """Recognize an inherited hotspot independently of its exact GoTo destination."""
    return (_same_coordinates(left["from"], right["from"])
            and all(left.get(key) == right.get(key)
                    for key in ("kind", "uri", "page", "file", "name", "nameddest")))


def _goto_page(link):
    """Read internal pages, including PyMuPDF's one-based Fit-view representation."""
    if link["kind"] == pymupdf.LINK_GOTO:
        return link.get("page", -1)
    if link["kind"] == pymupdf.LINK_NAMED and "view" in link and "page" in link:
        return int(link["page"]) - 1
    return None


def _same_destination(left, right):
    """Recognize an inherited internal destination even when its hotspot moved."""
    return (_goto_page(left) is not None and _goto_page(left) == _goto_page(right)
            and left.get("view") == right.get("view")
            and _same_coordinates(left.get("to"), right.get("to")))


def _inside_region(rectangle, regions):
    """Require the entire hotspot to lie in one reliably restored rectangle."""
    return not rectangle.is_empty and any(rectangle in region for region in regions)


def _literal_link_anchors(source_page, translated_page, link, source_anchor):
    """Relocate an exact visible URL or unique unchanged label, including internal citations."""
    uri = link.get("uri", "")
    if link["kind"] == pymupdf.LINK_URI and uri:
        source_matches = source_page.search_for(uri)
        target_matches = translated_page.search_for(uri)
        if target_matches and any(match.intersects(source_anchor) for match in source_matches):
            # A wrapped or repeated literal destination can safely keep that exact URI on each line.
            return target_matches
    label = source_page.get_textbox(source_anchor).strip()
    if not label:
        return []
    source_matches = source_page.search_for(label)
    target_matches = translated_page.search_for(label)
    if (len(source_matches) == len(target_matches) == 1
            and source_matches[0].intersects(source_anchor)):
        return target_matches
    return []


def _restore_links(source, translated, original_links, rectangles):
    """Recover reliable source anchors and validate inherited internal destinations."""
    for page_index, links in enumerate(original_links):
        page = translated[page_index]
        existing = [{**link, "from": link["from"] * page.derotation_matrix} for link in page.get_links()]
        for link in links:
            anchor = link["from"] * source[page_index].derotation_matrix
            if page_index in rectangles and not _inside_region(anchor, rectangles[page_index]):
                anchors = _literal_link_anchors(source[page_index], page, link, anchor)
            else:
                anchors = [anchor]
            target = _goto_page(link)
            if target is not None and not 0 <= target < len(translated):
                continue
            for anchor in anchors:
                copied = {key: value for key, value in link.items() if key not in {"xref", "id"}}
                # get_links exposes rotated coordinates; insert_link expects unrotated ones.
                copied["from"] = anchor
                if target is not None:
                    copied.update(kind=pymupdf.LINK_GOTO, page=target)
                if any(_same_anchor(copied, current) for current in existing):
                    continue
                before = {entry[0] for entry in page.annot_xrefs()}
                rotation = page.rotation
                try:
                    # Rotated transformation_matrix loses CropBox offsets during insertion.
                    page.set_rotation(0)
                    page.insert_link(copied)
                finally:
                    page.set_rotation(rotation)
                # insert_link emits XYZ even for original Fit destinations: keep the actual view mode.
                if target is not None:
                    for key in ("A/D", "Dest"):
                        kind, destination = source.xref_get_key(link["xref"], key)
                        prefix = f"[{source.page_xref(target)} 0 R"
                        if kind == "array" and destination.startswith(prefix):
                            xref = next(entry[0] for entry in page.annot_xrefs() if entry[0] not in before)
                            destination = f"[{translated.page_xref(target)} 0 R" + destination[len(prefix):]
                            translated.xref_set_key(xref, "A/D", destination)
                            break
                existing.append(copied)

        page = translated.reload_page(page)
        for link in page.get_links():
            target = _goto_page(link)
            if target is None:
                continue
            if not 0 <= target < len(translated):
                page.delete_link(link)
                continue
            if target not in rectangles:
                continue
            if not any(_same_destination(link, original) for original in links):
                continue  # A producer-supplied new destination is not an inherited coordinate.
            point = link.get("to")
            if isinstance(point, pymupdf.Point) and any(
                    point * translated[target].derotation_matrix in region for region in rectangles[target]):
                continue
            # Only the page is known after body reflow; /Fit must not masquerade as an XYZ point.
            translated.xref_set_key(link["xref"], "Dest", "null")
            translated.xref_set_key(link["xref"], "A", f"<</S/GoTo/D[{translated.page_xref(target)} 0 R/Fit]>>")


def _restoration_rectangles(boxes, page_bounds):
    """Coalesce contained or adjacent same-column clips without covering neighboring prose."""
    rectangles = []
    # Padding on both source blocks explains their small vertical overlap.
    padding = max(abs(value) for value in REGION_PADDING)
    for box in boxes:
        rectangle = (pymupdf.Rect(box) + REGION_PADDING) & page_bounds
        index = 0
        while index < len(rectangles):
            previous = rectangles[index]
            intersection = rectangle & previous
            same_column = abs(rectangle.x0 - previous.x0) <= padding
            # Touching bibliography columns form an L, not permission to restore the whole page.
            merge = rectangle.contains(previous) or previous.contains(rectangle) or (
                same_column and intersection.height <= padding + padding)
            if rectangle.intersects(previous) and merge:
                rectangle |= rectangles.pop(index)
                # A larger source union can also touch an earlier rectangle.
                index = 0
            else:
                index += 1
        rectangles.append(rectangle)
    return rectangles


def _redact_region_text(page, rectangles, *, keep_inside=False):
    """Remove protected labels or wholly outside source glyphs without clipping edge overhangs."""
    runs, retained = [], []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            run = []
            for span in line["spans"]:
                for character in span["chars"]:
                    bounds = pymupdf.Rect(character["bbox"])
                    center = (bounds.tl + bounds.br) / 2
                    remove = (not any(rectangle.intersects(bounds) for rectangle in rectangles)
                              if keep_inside else any(rectangle.contains(center) for rectangle in rectangles))
                    if remove:
                        radius = REDACTION_POINT_RADIUS
                        point = pymupdf.Rect(center.x - radius, center.y - radius,
                                            center.x + radius, center.y + radius)
                        if keep_inside:
                            run.append(point)
                        else:
                            runs.append([point])
                    elif keep_inside:
                        retained.append(bounds)
                        if run:
                            runs.append(run)
                            run = []
            if run:
                runs.append(run)
    has_redactions = False
    for run in runs:
        area = pymupdf.Rect(run[0])
        for point in run[1:]:
            area |= point
        # Thousands of individual source redactions are quadratic; safe line runs need one each.
        candidates = run if keep_inside and any(area.intersects(box) for box in retained) else [area]
        for point in candidates:
            if keep_inside and any(point.intersects(box) for box in retained):
                continue  # An edge glyph's overlapping font box must remain intact.
            # Outside-clip removal must not paint fills that geometry readers mistake for body occlusion.
            fill = None if keep_inside else (1, 1, 1)
            page.add_redact_annot(point, fill=fill)
            has_redactions = True
    if has_redactions:
        page.apply_redactions(images=0, graphics=0)


def restore_regions(source_path, translated_path, output_path, regions):
    """Restore vectors and links before the existing final PDF save."""
    count = 0
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as translated:
        original_links = [page.get_links() for page in source]
        rectangles = {
            index: _restoration_rectangles(boxes, translated[index].rect * translated[index].derotation_matrix)
            for index, boxes in regions.items()
        }
        for page_index in regions:
            page = translated[page_index]
            for link in page.get_links():
                if (any(_same_anchor(link, original) for original in original_links[page_index])
                        or any((link["from"] * page.derotation_matrix).intersects(rectangle)
                               for rectangle in rectangles[page_index])):
                    page.delete_link(link)
            source_page = source[page_index]
            rotation, source_rotation = page.rotation, source_page.rotation
            try:
                # show_pdf_page intersects the clip with source.rect; both must be unrotated.
                page.set_rotation(0)
                source_page.set_rotation(0)
                # Whole-region redaction erases prose when only its font bbox touches the clip.
                _redact_region_text(page, rectangles[page_index])
                for rectangle in rectangles[page_index]:
                    page.draw_rect(rectangle, color=None, fill=(1, 1, 1), overlay=True)
                    # Form clipping hides pixels but can leave a whole source page in copy/search text.
                    # Prune only outside text on a disposable copy; original fonts, vectors and PDF stay intact.
                    with pymupdf.open() as clipped:
                        clipped.insert_pdf(source, from_page=page_index, to_page=page_index)
                        _redact_region_text(clipped[0], [rectangle], keep_inside=True)
                        page.show_pdf_page(rectangle, clipped, 0, clip=rectangle, overlay=True)
                    count += 1
            finally:
                page.set_rotation(rotation)
                source_page.set_rotation(source_rotation)
        # reload_page requires the vector-restoration caller to release its page reference.
        page = None
        _restore_links(source, translated, original_links, rectangles)
        # Global fallback subsetting replaces publisher encodings; only shrink our new font streams.
        subset_songti(translated, source)
        translated.save(output_path, garbage=4, deflate=True)
    Path(output_path).with_suffix(".regions.json").write_text(json.dumps(regions))
    return count
