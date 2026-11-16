"""Correct source paragraph grouping and retain BabelDOC's batch/placeholder handling.

The process_page flow follows BabelDOC 0.6.4 (AGPL-3.0), with a 1200-token /
12-paragraph threshold in place of its 200-token / 6-paragraph threshold.
"""
import re
from types import SimpleNamespace

from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import (
    BatchParagraph, ILTranslatorLLMOnly, is_cid_paragraph,
    is_placeholder_only_paragraph, is_pure_numeric_paragraph,
)
from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator, RichTextPlaceholder, FormulaPlaceholder
from babeldoc.format.pdf.document_il.midend import paragraph_finder
from babeldoc.format.pdf.document_il.utils.layout_helper import (
    Layout, box_to_tuple, get_character_layout as original_character_layout,
)
from deepseek import placeholder_tokens

# Keep the existing batching and executor priority policy.
BATCH_TOKENS = 1200
# Bound the number of independently validated paragraphs in a single request.
BATCH_PARAGRAPHS = 12
# Match the pinned engine's descending token-based scheduling priority.
PRIORITY_BASE = 1048576
# Only ordinary prose boxes can disprove a title's incidental glyph-edge overlap.
BODY_LAYOUTS = {"plain text", "text", "content", "paragraph"}
# A hyphen joining Latin words is punctuation, not a mathematical subtraction operator.
WORD_HYPHENS = {"-", "\u00ad", "\u2010", "\u2011"}


def source_character_layout(char, layout_index, layout_map, layout_priority=None, _bbox_mode="auto"):
    """Keep body glyphs together despite detector edges, without changing real title/formula priority."""
    selected = original_character_layout(char, layout_index, layout_map, layout_priority, _bbox_mode)
    if selected is None:
        return selected
    glyph = char.visual_bbox.box
    if selected.name == "fallback_line":
        line = next(layout for layout in layout_map.values() if layout.id == selected.id)
        center_x, center_y = (line.box.x + line.box.x2) / 2, (line.box.y + line.box.y2) / 2
        bodies = [layout_map[index] for index in layout_index.intersection(box_to_tuple(line.box))
                  if layout_map[index].class_name in BODY_LAYOUTS
                  and layout_map[index].box.y <= center_y <= layout_map[index].box.y2]
        if len(bodies) == 1 and bodies[0].box.x <= center_x <= bodies[0].box.x2:
            # A measured source line belongs to one body block; its final letters may exceed YOLO's edge.
            return Layout(bodies[0].id, bodies[0].class_name)
        return selected
    if selected.name != "title":
        return selected
    candidates = list(layout_index.intersection(box_to_tuple(glyph)))
    title = next(layout_map[index] for index in candidates if layout_map[index].id == selected.id)
    center_x, center_y = (glyph.x + glyph.x2) / 2, (glyph.y + glyph.y2) / 2
    if title.box.x <= center_x <= title.box.x2 and title.box.y <= center_y <= title.box.y2:
        return selected
    body_ids = [index for index in candidates if layout_map[index].class_name in BODY_LAYOUTS
                and layout_map[index].box.x <= glyph.x and glyph.x2 <= layout_map[index].box.x2
                and layout_map[index].box.y <= glyph.y and glyph.y2 <= layout_map[index].box.y2]
    if not body_ids:
        return selected
    # Reuse pinned priority/IoU tie-breaking; only the false title candidate is ruled out.
    body_index = SimpleNamespace(intersection=lambda bounds: body_ids)
    return original_character_layout(char, body_index, layout_map, layout_priority, _bbox_mode)


def install_source_layout_selection():
    """Correct the existing grouping lookup before formulas/styles and translation run."""
    paragraph_finder.get_character_layout = source_character_layout


# The engine imports batching before parsing; repair its existing lookup at that boundary.
install_source_layout_selection()


class ObservedILTranslator(ILTranslator):
    """Observe real paragraph application and make upstream fallback cache-only."""

    def get_translate_input(self, paragraph, page_font_map=None, disable_rich_text_translate=None):
        """Keep actual styles/formulas without false constraints on spaces or word hyphens."""
        prepared = super().get_translate_input(paragraph, page_font_map, disable_rich_text_translate)
        if prepared is None:
            return None
        original = prepared.unicode
        removed = []
        for placeholder in list(prepared.placeholders):
            if isinstance(placeholder, FormulaPlaceholder):
                formula = placeholder.formula
                content = "".join(character.char_unicode or "" for character in formula.pdf_character)
                pattern = re.escape(placeholder.placeholder)
                if (content not in WORD_HYPHENS or formula.pdf_curve or formula.pdf_form
                        or not re.search(r"(?<=[A-Za-z])" + pattern + r"(?=[A-Za-z])", prepared.unicode)):
                    continue
                # The detector marks some ordinary font hyphens as formulas inside real prose.
                normalized, count = re.subn(pattern, lambda match: content, prepared.unicode)
            elif isinstance(placeholder, RichTextPlaceholder):
                # The upstream unicode helper strips whitespace; inspect the actual composition.
                content = "".join(character if isinstance(character, str) else (character.char_unicode or "")
                                  for character in placeholder.composition.pdf_character)
                if not content or not content.isspace():
                    continue
                pattern = re.escape(placeholder.left_placeholder) + r"(\s*)" + re.escape(placeholder.right_placeholder)
                normalized, count = re.subn(pattern, lambda match: match[1] or content, prepared.unicode)
            else:
                continue
            if count == 1:
                prepared.unicode = normalized
                prepared.placeholders.remove(placeholder)
                removed.append((pattern, content))
        if not removed:
            return prepared
        cached = self.translate_engine.paragraph_cache.get(original)
        if isinstance(cached, str) and placeholder_tokens(cached) == placeholder_tokens(original):
            for pattern, content in removed:
                cached, count = re.subn(pattern, lambda match: (match[1] or content) if match.lastindex else content, cached)
                if count != 1:
                    break
            else:
                # Only previously validated literal punctuation/spacing can avoid another charge.
                if cached.strip() and placeholder_tokens(cached) == placeholder_tokens(prepared.unicode):
                    self.translate_engine.paragraph_cache.put(prepared.unicode, cached)
        return prepared

    def pre_translate_paragraph(self, paragraph, tracker, page_font_map, xobj_font_map):
        """Link prepared wire inputs to their source paragraph, including preprocessing skips."""
        quality = self.translate_engine.quality
        key = quality.register(id(paragraph), paragraph.unicode)
        try:
            result = super().pre_translate_paragraph(paragraph, tracker, page_font_map, xobj_font_map)
        except Exception:
            quality.record(key, "failure", "upstream_preprocess_failed")
            raise
        if result[0] is None:
            quality.record(key, "skip", "vertical_text" if paragraph.vertical else "preprocessing_skip")
        else:
            self.translate_engine.request_context.paragraph_keys.append(key)
        return result

    def post_translate_paragraph(self, paragraph, tracker, translate_input, translated_text):
        """Count success only after the pinned engine actually applies translated content."""
        quality = self.translate_engine.quality
        key = id(paragraph)
        try:
            applied = super().post_translate_paragraph(paragraph, tracker, translate_input, translated_text)
        except Exception:
            quality.record(key, "failure", "upstream_postprocess_failed")
            raise
        if applied:
            quality.record(key, "success")
        else:
            quality.record(key, "failure", "upstream_did_not_apply")
        return applied

    def translate_paragraph(self, paragraph, *args, **kwargs):
        """Record swallowed fallback errors without automatically making another paid call."""
        engine = self.translate_engine
        key = engine.quality.register(id(paragraph), paragraph.unicode)
        engine.quality.record(key, "failure", "upstream_fallback")
        engine.quality.record(key, "fallback")
        engine.request_context.paragraph_keys = []
        engine.request_context.cache_only = True
        try:
            return super().translate_paragraph(paragraph, *args, **kwargs)
        finally:
            engine.quality.finish_pending([key])
            engine.quality.write()
            engine.request_context.paragraph_keys = []
            engine.request_context.cache_only = False


class CostAwareILTranslator(ILTranslatorLLMOnly):
    """Retain pinned cross-page processing while observing every paragraph outcome."""

    def __init__(self, translate_engine, translation_config, tokenizer=None):
        """Use an observed IL adapter for both batch application and upstream fallback."""
        super().__init__(translate_engine, translation_config, tokenizer)
        self.il_translator = ObservedILTranslator(translate_engine, translation_config, self.tokenizer)
        self.il_translator.use_as_fallback = True

    def translate(self, docs):
        """Inventory selected-page paragraphs before workers run and retain stage coverage."""
        quality = self.translate_engine.quality
        for page in docs.page:
            for paragraph in page.pdf_paragraph:
                quality.register(id(paragraph), paragraph.unicode, page.page_number + 1)
        quality.write(inventory_observed=True)
        trace = getattr(self.translate_engine, "fragment_trace", None)
        if trace is not None:
            trace.inventory(docs)
        try:
            super().translate(docs)
        except Exception:
            quality.write(stage_completed=False)
            raise
        quality.write(stage_completed=True)

    def translate_paragraph(self, batch_paragraph, *args, **kwargs):
        """Keep thread-local input identity across the existing batch and cross-page paths."""
        engine = self.translate_engine
        keys = [engine.quality.register(id(paragraph), paragraph.unicode)
                for paragraph in batch_paragraph.paragraphs]
        engine.request_context.paragraph_keys = []
        engine.request_context.cache_only = False
        try:
            return super().translate_paragraph(batch_paragraph, *args, **kwargs)
        finally:
            engine.quality.finish_pending(keys)
            engine.quality.write()
            engine.request_context.paragraph_keys = []

    def process_page(self, page, executor, pbar=None, tracker=None, executor2=None, translated_ids=None):
        """Batch eligible paragraphs and explicitly account for content exclusions."""
        self.translation_config.raise_if_cancelled()
        page_font_map = {font.font_id:font for font in page.pdf_font}
        page_xobj_font_map = {}
        for xobj in page.pdf_xobject:
            fonts = page_font_map.copy()
            fonts.update({font.font_id:font for font in xobj.pdf_font})
            page_xobj_font_map[xobj.xobj_id] = fonts
        translated_ids = translated_ids if translated_ids is not None else set()
        paragraphs = []
        tokens = 0

        def submit():
            """Schedule one bounded batch through the observed translation path."""
            self.mid += 1
            executor.submit(self.translate_paragraph,
                BatchParagraph(paragraphs,[page]*len(paragraphs),tracker), pbar,
                page_font_map,page_xobj_font_map,
                self.translation_config.shared_context_cross_split_part.first_paragraph,
                self.translation_config.shared_context_cross_split_part.recent_title_paragraph,
                executor2,priority=PRIORITY_BASE-tokens,paragraph_token_count=tokens,mp_id=self.mid)

        for paragraph in page.pdf_paragraph:
            if id(paragraph) in translated_ids:
                continue
            key = self.translate_engine.quality.register(id(paragraph), paragraph.unicode, page.page_number + 1)
            if paragraph.debug_id is None or paragraph.unicode is None:
                self.translate_engine.quality.record(key, "skip", "missing_text_metadata")
                continue
            reason = None
            if is_cid_paragraph(paragraph):
                reason = "unrecognized_cid"
            elif is_pure_numeric_paragraph(paragraph):
                reason = "numeric"
            elif is_placeholder_only_paragraph(paragraph):
                reason = "placeholder_only"
            elif len(paragraph.unicode) < self.translation_config.min_text_length:
                reason = "short_text"
            if reason:
                self.translate_engine.quality.record(key, "skip", reason)
                if pbar:
                    pbar.advance(1)
                continue
            tokens += self.calc_token_count(paragraph.unicode)
            paragraphs.append(paragraph)
            translated_ids.add(id(paragraph))
            if paragraph.layout_label == "title":
                self.shared_context_cross_split_part.recent_title_paragraph = (
                    self.shared_context_cross_split_part.snapshot_title_paragraph(paragraph))
            if tokens >= BATCH_TOKENS or len(paragraphs) >= BATCH_PARAGRAPHS:
                submit()
                paragraphs = []
                tokens = 0
        if paragraphs:
            submit()
