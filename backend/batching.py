"""Larger paragraph batches, retaining BabelDOC's cross-page and placeholder handling.

The process_page flow follows BabelDOC 0.6.4 (AGPL-3.0), with a 1200-token /
12-paragraph threshold in place of its 200-token / 6-paragraph threshold.
"""
from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import (
    BatchParagraph, ILTranslatorLLMOnly, is_cid_paragraph,
    is_placeholder_only_paragraph, is_pure_numeric_paragraph,
)
from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator

# Keep the existing batching and executor priority policy.
BATCH_TOKENS = 1200
# Bound the number of independently validated paragraphs in a single request.
BATCH_PARAGRAPHS = 12
# Match the pinned engine's descending token-based scheduling priority.
PRIORITY_BASE = 1048576


class ObservedILTranslator(ILTranslator):
    """Observe real paragraph application and make upstream fallback cache-only."""

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
