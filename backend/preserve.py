"""Restore original protected vectors and reliable links in the final PDF writeout."""
import json
from pathlib import Path

import pymupdf

# Layout classes whose content is copied verbatim rather than translated.
PROTECTED = {"figure", "table", "isolate_formula", "isolated_formula", "formula"}
# Match PDF coordinates despite harmless decimal serialization differences.
LINK_COORDINATE_TOLERANCE = 0.01
# Cover detector edges when redacting and restoring original vectors.
REGION_PADDING = (-1, -1, 1, 1)


def regions_from_layout(layout):
    """Extract protected detector rectangles in page coordinates."""
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


class ProtectedLayoutModel:
    """Record every translated page, including pages with no protected regions."""

    def __init__(self, model, references=None):
        """Wrap the detector and collect regions needed for final restoration."""
        self.model = model
        self.regions = {}
        self.excluded_characters = 0
        self.references = references or {}
        self.excluded_reference_characters = 0

    @property
    def stride(self):
        """Expose the wrapped detector's image stride."""
        return self.model.stride

    def handle_document(self, pages, document, config, save_debug_image):
        """Exclude protected labels and record the translated page indices."""
        for page, layout in self.model.handle_document(pages, document, config, save_debug_image):
            reference_boxes = self.references.get(page.page_number,[])
            self.excluded_reference_characters += exclude_protected_characters(
                page,document[page.page_number].mediabox.height,reference_boxes)
            self.regions[page.page_number] = [*regions_from_layout(layout),*reference_boxes]
            self.excluded_characters += exclude_protected_characters(
                page, document[page.page_number].mediabox.height, self.regions[page.page_number])
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


def _restore_links(source, translated, original_links, rectangles):
    """Recover reliable source anchors and validate inherited internal destinations."""
    for page_index, links in enumerate(original_links):
        page = translated[page_index]
        existing = page.get_links()
        for link in links:
            anchor = link["from"] * source[page_index].derotation_matrix
            if page_index in rectangles and not _inside_region(anchor, rectangles[page_index]):
                continue
            if any(_same_anchor(link, current) for current in existing):
                continue
            copied = {key: value for key, value in link.items() if key not in {"xref", "id"}}
            # get_links exposes rotated coordinates; insert_link expects unrotated ones.
            copied["from"] = anchor
            target = _goto_page(link)
            if target is not None:
                if not 0 <= target < len(translated):
                    continue
                copied.update(kind=pymupdf.LINK_GOTO, page=target)
            before = {entry[0] for entry in page.annot_xrefs()}
            page.insert_link(copied)
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
            existing.append(link)

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


def restore_regions(source_path, translated_path, output_path, regions):
    """Restore vectors and links before the existing final PDF save."""
    count = 0
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as translated:
        original_links = [page.get_links() for page in source]
        rectangles = {
            index: [(pymupdf.Rect(box) + REGION_PADDING) & translated[index].rect for box in boxes]
            for index, boxes in regions.items()
        }
        for page_index in regions:
            page = translated[page_index]
            for link in page.get_links():
                if (any(_same_anchor(link, original) for original in original_links[page_index])
                        or any((link["from"] * page.derotation_matrix).intersects(rectangle)
                               for rectangle in rectangles[page_index])):
                    page.delete_link(link)
            for rectangle in rectangles[page_index]:
                page.add_redact_annot(rectangle, fill=(1, 1, 1))
            if rectangles[page_index]:
                page.apply_redactions(images=0, graphics=0)
            for rectangle in rectangles[page_index]:
                page.show_pdf_page(rectangle, source, page_index, clip=rectangle, overlay=True)
                count += 1
        # reload_page requires the vector-restoration caller to release its page reference.
        page = None
        _restore_links(source, translated, original_links, rectangles)
        translated.subset_fonts()
        translated.save(output_path, garbage=4, deflate=True)
    Path(output_path).with_suffix(".regions.json").write_text(json.dumps(regions))
    return count
