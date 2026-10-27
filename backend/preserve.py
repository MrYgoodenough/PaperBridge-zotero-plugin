"""Copy detected figures, tables and display equations as original PDF vectors."""
import json
from pathlib import Path

import pymupdf

PROTECTED = {"figure", "table", "isolate_formula", "isolated_formula", "formula"}


def regions_from_layout(layout):
    return [tuple(float(v) for v in box.xyxy) for box in layout.boxes
            if layout.names[int(box.cls)] in PROTECTED]


def exclude_protected_characters(page, height, boxes):
    """Protected graphics are copied verbatim later, so their labels need no LLM input."""
    def inside(character):
        box = character.box
        x = (box.x + box.x2) / 2
        y = height - (box.y + box.y2) / 2
        return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes)
    original_count = len(page.pdf_character)
    page.pdf_character = [character for character in page.pdf_character if not inside(character)]
    return original_count - len(page.pdf_character)


class ProtectedLayoutModel:
    def __init__(self, model, references=None):
        self.model = model
        self.regions = {}
        self.excluded_characters = 0
        self.references = references or {}
        self.excluded_reference_characters = 0

    @property
    def stride(self):
        return self.model.stride

    def handle_document(self, pages, document, config, save_debug_image):
        for page, layout in self.model.handle_document(pages, document, config, save_debug_image):
            reference_boxes = self.references.get(page.page_number,[])
            self.excluded_reference_characters += exclude_protected_characters(
                page,document[page.page_number].mediabox.height,reference_boxes)
            self.regions[page.page_number] = [*regions_from_layout(layout),*reference_boxes]
            self.excluded_characters += exclude_protected_characters(
                page, document[page.page_number].mediabox.height, self.regions[page.page_number])
            yield page, layout


def restore_regions(source_path, translated_path, output_path, regions):
    count = 0
    with pymupdf.open(source_path) as source, pymupdf.open(translated_path) as translated:
        for page_index, boxes in regions.items():
            page = translated[page_index]
            rectangles = [(pymupdf.Rect(box) + (-1, -1, 1, 1)) & page.rect for box in boxes]
            for rectangle in rectangles:
                page.add_redact_annot(rectangle, fill=(1, 1, 1))
            if rectangles:
                page.apply_redactions(images=0, graphics=0)
            for rectangle in rectangles:
                page.show_pdf_page(rectangle, source, page_index, clip=rectangle, overlay=True)
                count += 1
        translated.subset_fonts()
        translated.save(output_path, garbage=4, deflate=True)
    Path(output_path).with_suffix(".regions.json").write_text(json.dumps(regions))
    return count
