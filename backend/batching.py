"""Larger paragraph batches, retaining BabelDOC's cross-page and placeholder handling.

The process_page flow follows BabelDOC 0.6.4 (AGPL-3.0), with a 1200-token /
12-paragraph threshold in place of its 200-token / 6-paragraph threshold.
"""
from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import (
    BatchParagraph, ILTranslatorLLMOnly, is_cid_paragraph,
    is_placeholder_only_paragraph, is_pure_numeric_paragraph,
)


class CostAwareILTranslator(ILTranslatorLLMOnly):
    def process_page(self, page, executor, pbar=None, tracker=None, executor2=None, translated_ids=None):
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
            self.mid += 1
            executor.submit(self.translate_paragraph,
                BatchParagraph(paragraphs,[page]*len(paragraphs),tracker), pbar,
                page_font_map,page_xobj_font_map,
                self.translation_config.shared_context_cross_split_part.first_paragraph,
                self.translation_config.shared_context_cross_split_part.recent_title_paragraph,
                executor2,priority=1048576-tokens,paragraph_token_count=tokens,mp_id=self.mid)

        for paragraph in page.pdf_paragraph:
            if id(paragraph) in translated_ids or paragraph.debug_id is None or paragraph.unicode is None:
                continue
            if (is_cid_paragraph(paragraph) or is_pure_numeric_paragraph(paragraph)
                    or is_placeholder_only_paragraph(paragraph)
                    or len(paragraph.unicode)<self.translation_config.min_text_length):
                if pbar:
                    pbar.advance(1)
                continue
            tokens += self.calc_token_count(paragraph.unicode)
            paragraphs.append(paragraph)
            translated_ids.add(id(paragraph))
            if paragraph.layout_label == "title":
                self.shared_context_cross_split_part.recent_title_paragraph = (
                    self.shared_context_cross_split_part.snapshot_title_paragraph(paragraph))
            if tokens >= 1200 or len(paragraphs) >= 12:
                submit()
                paragraphs = []
                tokens = 0
        if paragraphs:
            submit()
