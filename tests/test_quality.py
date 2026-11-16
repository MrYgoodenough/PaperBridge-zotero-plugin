"""Bounded offline checks of quality classification and pinned BabelDOC failure swallowing."""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import engine as engine_module
engine_module.localize_cache()
from babeldoc.format.pdf.document_il.midend import il_translator as il_module
from batching import BatchParagraph, CostAwareILTranslator, ObservedILTranslator, source_character_layout
from deepseek import DeepSeekTranslator
from usage import ResultQuality


def test_title_edge_does_not_split_a_uniform_body_line(monkeypatch):
    """Exercise actual pinned grouping: a tall body glyph cannot join the preceding title."""
    from babeldoc.format.pdf.document_il import Box, Page, PageLayout, PdfCharacter, PdfStyle, VisualBbox
    from babeldoc.format.pdf.document_il.midend import paragraph_finder
    from babeldoc.format.pdf.document_il.utils.layout_helper import build_layout_index, get_character_layout

    style = PdfStyle(font_id="body", font_size=9)
    characters = [PdfCharacter(char_unicode=text, pdf_character_id=ord(text), xobj_id=0,
                              pdf_style=style, box=Box(x, 551.642, x + 2, 560.642),
                              visual_bbox=VisualBbox(Box(x, 551.642, x + 2, top)))
                  for text, x, top in (("a", 190, 555.683), ("l", 192, 558.050), ("g", 194, 555.683))]
    page = Page(pdf_character=characters, page_layout=[
        PageLayout(box=Box(153, 428, 555, 560), id=1, class_name="plain text"),
        PageLayout(box=Box(154, 558, 367, 571), id=16, class_name="title")])
    layout_index, layout_map = build_layout_index(page)
    finder = paragraph_finder.ParagraphFinder.__new__(paragraph_finder.ParagraphFinder)
    # Reproduce the unmodified pinned lookup before checking the import-installed correction.
    monkeypatch.setattr(paragraph_finder, "get_character_layout", get_character_layout)
    original = finder._group_characters_into_paragraphs(page, layout_index, layout_map)
    assert [paragraph.layout_label for paragraph in original] == ["plain text", "title", "plain text"]
    page.pdf_character = characters
    monkeypatch.setattr(paragraph_finder, "get_character_layout", source_character_layout)
    fixed = finder._group_characters_into_paragraphs(page, layout_index, layout_map)
    assert len(fixed) == 1 and fixed[0].layout_label == "plain text"
    assert [composition.pdf_character.char_unicode for composition in fixed[0].pdf_paragraph_composition] == list("alg")
    assert all(composition.pdf_character.pdf_style is style for composition in fixed[0].pdf_paragraph_composition)


@pytest.mark.parametrize("title_box,body_box,other_label,expected", [
    ((154, 558, 367, 571), (153, 428, 555, 560), None, "plain text"),
    ((154, 551, 367, 571), (153, 428, 555, 560), None, "title"),
    ((154, 558, 367, 571), (153, 428, 555, 555), None, "title"),
    ((154, 558, 367, 571), (153, 428, 555, 560), "isolate_formula", "isolate_formula"),
])
def test_layout_correction_preserves_real_titles_formulas_and_ambiguous_edges(title_box, body_box, other_label, expected):
    """Reject only disproven title-edge matches; genuine titles and formulas retain priority."""
    from babeldoc.format.pdf.document_il import Box, Page, PageLayout, PdfCharacter, VisualBbox
    from babeldoc.format.pdf.document_il.utils.layout_helper import build_layout_index

    glyph = PdfCharacter(char_unicode="l", visual_bbox=VisualBbox(Box(195, 551.642, 197, 558.050)))
    layouts = [PageLayout(box=Box(*body_box), id=1, class_name="plain text"),
               PageLayout(box=Box(*title_box), id=16, class_name="title")]
    if other_label:
        layouts.append(PageLayout(box=Box(194, 551, 198, 559), id=17, class_name=other_label))
    layout_index, layout_map = build_layout_index(Page(page_layout=layouts))
    assert source_character_layout(glyph, layout_index, layout_map).name == expected


@pytest.mark.parametrize("space_unicode", ["", " \t"])
def test_space_styles_normalized_before_validation_and_valid_cache_reused(tmp_path, monkeypatch, space_unicode):
    """Whitespace is not a rich-text constraint; meaningful styles and formulas remain exact."""
    space = il_module.RichTextPlaceholder(1, SimpleNamespace(pdf_character=[" ", "\t"]),
                                         "<style id='1'>", "</style>")
    bold = il_module.RichTextPlaceholder(4, SimpleNamespace(pdf_character=["bold"]),
                                        "<style id='4'>", "</style>")
    formula = il_module.FormulaPlaceholder(3, SimpleNamespace(pdf_character=[]), "{v3}", r"\{v3\}")
    original = f"A<style id='1'>{space_unicode}</style>B {{v3}} <style id='4'>bold</style>"
    translated = f"甲<style id='1'>{space_unicode}</style>乙 {{v3}} <style id='4'>粗体</style>"
    prepared = il_module.ILTranslator.TranslateInput(original, [space, formula, bold])
    cache = {original: translated}
    observed = ObservedILTranslator.__new__(ObservedILTranslator)
    observed.translate_engine = SimpleNamespace(paragraph_cache=SimpleNamespace(
        get=cache.get, put=lambda source, output: cache.update({source: output})))
    monkeypatch.setattr(il_module.ILTranslator, "get_translate_input", lambda *args: prepared)
    result = observed.get_translate_input(SimpleNamespace())
    # BabelDOC strips the inner style text; recover actual spaces, not a joined word.
    normalized_space = space_unicode or " \t"
    normalized = f"A{normalized_space}B {{v3}} <style id='4'>bold</style>"
    assert result.unicode == normalized
    assert result.placeholders == [formula, bold]
    assert cache[result.unicode] == f"甲{normalized_space}乙 {{v3}} <style id='4'>粗体</style>"
    assert cache[original] == translated, "Old paid cache data remains intact"
    # A formerly empty style containing real text cannot be migrated by dropping that text.
    prepared.unicode, prepared.placeholders = original, [space, formula, bold]
    cache[original] = translated.replace(space_unicode + "</style>", "新增内容</style>", 1)
    cache.pop(normalized)
    observed.get_translate_input(SimpleNamespace())
    assert normalized not in cache


class DeferredExecutor:
    """Run submitted upstream fallbacks deterministically after the batch returns."""

    def __init__(self):
        """Retain callbacks, not threads, for this narrow upstream integration check."""
        self.calls = []

    def submit(self, callback, *args, **kwargs):
        """Match the pinned executor's priority argument without scheduling work yet."""
        kwargs.pop("priority", None)
        self.calls.append((callback, args, kwargs))

    def run(self):
        """Drain fallbacks through the real pinned IL translate_paragraph method."""
        for callback, args, kwargs in self.calls:
            callback(*args, **kwargs)


def pinned_batch(tmp_path, monkeypatch, texts, postprocess_error=False):
    """Use actual pinned batch/fallback control flow with only font preprocessing stubbed."""
    translator = DeepSeekTranslator(document_title="Test", document_key="test", lang_in="en", lang_out="zh-CN",
        model="offline", base_url="http://127.0.0.1:1", api_key="never-sent",
        paragraph_cache=tmp_path / "paragraphs.sqlite", usage_path=tmp_path / "usage.json")
    paragraphs = [SimpleNamespace(unicode=text, vertical=False, debug_id=str(index), layout_label="text")
                  for index, text in enumerate(texts)]
    sources = {id(paragraph): paragraph.unicode for paragraph in paragraphs}

    def prepare(self, paragraph, tracker, *args):
        """Supply a stable prepared source without loading font or PDF layout assets."""
        text = sources[id(paragraph)]
        return text, SimpleNamespace(unicode=text, get_placeholders_hint=lambda: [])

    def apply(self, paragraph, tracker, translate_input, translated_text):
        """Simulate the pinned postprocessing boundary, including an exception after response."""
        if postprocess_error:
            raise ValueError("simulated layout failure")
        paragraph.unicode = translated_text
        return True

    monkeypatch.setattr(il_module.ILTranslator, "pre_translate_paragraph", prepare)
    monkeypatch.setattr(il_module.ILTranslator, "post_translate_paragraph", apply)
    monkeypatch.setattr(il_module, "get_paragraph_unicode", lambda paragraph: sources[id(paragraph)])
    config = SimpleNamespace(raise_if_cancelled=lambda: None, add_formula_placehold_hint=True,
                             disable_same_text_fallback=True)
    observed = ObservedILTranslator.__new__(ObservedILTranslator)
    observed.translate_engine, observed.translation_config = translator, config
    observed.use_as_fallback = observed.support_llm_translate = True
    observed.generate_prompt_for_llm = lambda text, *args: "Now translate the following text:\n\n" + text
    batcher = CostAwareILTranslator.__new__(CostAwareILTranslator)
    batcher.translate_engine, batcher.translation_config, batcher.il_translator = translator, config, observed
    batcher.total_count = batcher.ok_count = batcher.fallback_count = 0
    batcher.calc_token_count = lambda text: 10
    batcher._build_llm_prompt = lambda json_input_str, **kwargs: "## Here is the input:\n\n" + json_input_str
    tracker = il_module.DocumentTranslateTracker().new_page()
    batch = BatchParagraph(paragraphs, [SimpleNamespace()] * len(paragraphs), tracker)
    for paragraph in paragraphs:
        translator.quality.register(id(paragraph), paragraph.unicode, 1)
    translator.quality.write(inventory_observed=True)
    return translator, batcher, batch


def completion(items):
    """Build a provider reply with known usage and no network dependency."""
    return SimpleNamespace(usage=SimpleNamespace(total_tokens=20, prompt_tokens=12, completion_tokens=8),
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"translations": items})))])


@pytest.mark.parametrize("postprocess_error", [False, True])
def test_pinned_upstream_applied_vs_swallowed_failure(tmp_path, monkeypatch, postprocess_error):
    """A successful provider response does not hide swallowed postprocessing failures."""
    translator, batcher, batch = pinned_batch(tmp_path, monkeypatch, ["English text"], postprocess_error)
    calls = []

    def request(messages):
        """Record the single provider reply for both batch and cache-only fallback paths."""
        calls.append(messages)
        return completion([{"id": 0, "text": "中文内容"}])

    monkeypatch.setattr(translator, "request_completion", request)
    executor = DeferredExecutor()
    batcher.translate_paragraph(batch, SimpleNamespace(advance=lambda *args: None), {}, {}, executor=executor)
    executor.run()
    report = translator.quality.write(artifact_exists=True, finalized=True, stage_completed=True)
    assert len(calls) == 1
    assert report["status"] == ("unusable" if postprocess_error else "complete")
    row = report["paragraphs"][0]
    if postprocess_error:
        assert row["fallbacks"] == 1 and row["cache_hits"] == 1
        assert "upstream_postprocess_failed" in row["failures"]
        assert row["status"] == "failed"
    else:
        assert row["applied"] and row["status"] == "success"


def test_pinned_batch_failure_recovers_only_cached_members(tmp_path, monkeypatch):
    """Partial validation survives swallowed failure without reissuing missing paragraphs."""
    translator, batcher, batch = pinned_batch(tmp_path, monkeypatch, ["English text", "Formula {v0}"])
    calls = []

    def request(messages):
        """Return one usable paragraph and one broken placeholder response."""
        calls.append(messages)
        return completion([{"id": 0, "text": "有效译文"}, {"id": 1, "text": "broken"}])

    monkeypatch.setattr(translator, "request_completion", request)
    executor = DeferredExecutor()
    batcher.translate_paragraph(batch, SimpleNamespace(advance=lambda *args: None), {}, {}, executor=executor)
    executor.run()
    report = translator.quality.write(artifact_exists=True, finalized=True, stage_completed=True)
    assert report["status"] == "partial" and len(calls) == 1
    assert report["counts"]["cache"] == report["counts"]["failed"] == 1
    assert report["counts"]["fallbacks"] == 2
    assert "fallback_request_suppressed" in report["paragraphs"][1]["failures"]


def test_pdf_and_unapplied_or_unchanged_text_never_mean_complete(tmp_path):
    """No evidence, unapplied output, unchanged text, and unsupported skips remain uncertain."""
    quality = ResultQuality(tmp_path / "quality.json")
    assert quality.write(artifact_exists=True, finalized=True)["status"] == "unknown"
    quality.register("p", "English", 1)
    quality.record("p", "validated")
    assert quality.write(inventory_observed=True, stage_completed=True)["status"] == "unknown"
    quality.record("p", "unchanged")
    quality.record("p", "success")
    assert quality.report()["status"] == "unknown"
    quality.register("good", "Other text", 1)
    quality.record("good", "success")
    assert quality.report()["status"] == "partial"
    quality.record("p", "skip", "numeric")
    assert quality.report()["status"] == "complete"
    quality.record("p", "skip", "unrecognized_cid")
    assert quality.report()["status"] == "partial"


def test_engine_finalizes_quality_when_layout_fails(tmp_path, monkeypatch):
    """The engine retains quality evidence even if it fails before producing a PDF."""
    async def fail(request, quality):
        """Simulate an engine exception before any artifact exists."""
        quality.register("p", "Text", 1)
        quality.record("p", "failure", "upstream_postprocess_failed")
        raise RuntimeError("layout failed")

    monkeypatch.setattr(engine_module, "_translate", fail)
    with pytest.raises(RuntimeError, match="layout failed"):
        asyncio.run(engine_module.translate({"folder": str(tmp_path)}))
    data = json.loads((tmp_path / "quality.json").read_text())
    assert data["status"] == "unusable" and data["finalized"]
    assert data["engine_error"] == "RuntimeError" and data["counts"]["failed"] == 1


def test_engine_parent_watchdog_exits_only_after_original_parent_is_lost():
    """Use callbacks rather than threads or os._exit so the test process cannot be killed."""
    states = iter([True, True, False])
    checked, waits, exits = [], [], []

    def is_running(pid):
        """Keep the original parent alive for two checks before simulating its loss."""
        checked.append(pid)
        return next(states)

    engine_module.watch_parent(1234, is_running, exits.append, waits.append)
    assert checked == [1234, 1234, 1234]
    assert waits == [3, 3, 3]
    assert exits == [1]
