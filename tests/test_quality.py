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
from batching import BatchParagraph, CostAwareILTranslator, ObservedILTranslator
from deepseek import DeepSeekTranslator
from usage import ResultQuality


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
