"""Check bounded live engine events without provider calls or a second result tracker."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import engine
engine.localize_cache()
from usage import ResultQuality


def events_from(capsys):
    """Decode only bridge frames, ignoring unrelated upstream logging."""
    return [json.loads(line[3:]) for line in capsys.readouterr().out.splitlines()
            if line.startswith("PB:")]


def test_upstream_percentages_are_finite_monotonic_and_not_fractions(tmp_path, capsys):
    """A half percent stays a half percent, even across missing or malformed updates."""
    quality = ResultQuality(tmp_path / "quality.json")
    progress = engine.EngineProgress(quality)
    progress.report()
    assert events_from(capsys)[0]["phase"] == "preparing"
    progress.upstream({"stage": "Parse PDF", "overall_progress": 0.5})
    event = events_from(capsys)[0]
    assert event["progress"] == 0.5 and event["phase"] == "parsing"
    for value in (None, "50", True, float("nan"), float("inf"), -float("inf"), -10, 0):
        progress.upstream({"stage": "Translate Paragraphs", "overall_progress": value})
        assert events_from(capsys)[0]["progress"] == 0.5
    progress.upstream({"stage": "Translate Paragraphs", "overall_progress": 65.25})
    progress.upstream({"stage": "Typesetting"})
    progress.upstream({})
    events = events_from(capsys)
    assert [event["progress"] for event in events] == [65.25] * 3
    assert [event["phase"] for event in events] == ["translating", "typesetting", "typesetting"]
    for stage in ("Add Fonts", "Generate drawing instructions", "Save PDF"):
        progress.upstream({"stage": stage, "overall_progress": 1000})
        event = events_from(capsys)[0]
        assert event["phase"] == "typesetting" and event["progress"] == 99
        assert event["counts"] == quality.report()["counts"]
    progress.restoring()
    assert events_from(capsys)[0]["phase"] == "restoring"


def test_quality_changes_emit_live_applied_failed_and_cache_counts(tmp_path, capsys):
    """Validated responses and cache hits remain unresolved until application succeeds."""
    quality = ResultQuality(tmp_path / "quality.json")
    progress = engine.EngineProgress(quality)
    progress.upstream({"stage": "Translate Paragraphs", "overall_progress": 40})
    quality.register("fresh", "Source text")
    quality.register("cached", "Cached source")
    quality.register("failed", "Other source")
    quality.write(inventory_observed=True)
    events_from(capsys)
    for key, action, reason in (("fresh", "attempt", None), ("fresh", "validated", None),
                                ("fresh", "success", None), ("cached", "cache", None),
                                ("cached", "success", None),
                                ("failed", "failure", "provider_request_failed")):
        previous = quality.report()["counts"]
        quality.record(key, action, reason)
        counts = quality.report()["counts"]
        events = events_from(capsys)
        if previous != counts:
            assert len(events) == 1 and events[0]["counts"] == counts
            assert events[0]["phase"] == "translating" and events[0]["progress"] == 40
        else:
            assert not events
        if action == "cache":
            assert counts["cache_hits"] == 1 and counts["cache"] == 0
            assert counts["unresolved"] == 2
    assert counts["success"] == counts["cache"] == counts["failed"] == 1
    assert counts["unresolved"] == 0
    assert quality.report()["status"] == "unknown"


@pytest.mark.parametrize("outcomes,error,expected", [
    (["success", "cache"], None, "complete"),
    (["success", "failure"], None, "partial"),
    (["failure"], None, "unusable"),
    ([], None, "unknown"),
    (["success"], "layout", "unusable"),
    (["success"], "usage", "partial"),
])
def test_engine_final_progress_uses_persisted_quality(tmp_path, monkeypatch, capsys,
                                                    outcomes, error, expected):
    """Exercise the real engine event loop and restoration with an offline PDF producer."""
    import pymupdf
    import deepseek
    import fonts
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.format.pdf import high_level, translation_config

    with pymupdf.open() as document:
        document.new_page().insert_text((72, 72), "Offline progress sample")
        document.save(tmp_path / "source.pdf")
    monkeypatch.setattr(fonts, "install_songti", lambda assets: None)
    monkeypatch.setattr(DocLayoutModel, "load_available", lambda: object())
    monkeypatch.setattr(translation_config, "TranslationConfig", lambda **fields: SimpleNamespace(**fields))

    def write_usage(**extra):
        """Optionally fail after restoration to retain a partial artifact without claiming 100%."""
        if error == "usage" and extra:
            raise RuntimeError("simulated usage failure")

    monkeypatch.setattr(deepseek, "DeepSeekTranslator",
                        lambda **fields: SimpleNamespace(write_usage=write_usage))

    async def produce(config):
        """Supply application evidence before the upstream finish event, without any API."""
        yield {"type": "progress_update", "stage": "Translate Paragraphs", "overall_progress": 0.5}
        quality = config.translator.quality
        for index, outcome in enumerate(outcomes):
            quality.register(index, "Source text")
            quality.record(index, outcome)
            if outcome == "cache":
                quality.record(index, "success")
        quality.write(inventory_observed=True, stage_completed=True)
        if error == "layout":
            yield {"type": "error", "error": "simulated layout failure"}
            return
        yield {"type": "progress_end", "stage": "Save PDF", "overall_progress": 100}
        yield {"type": "finish", "translate_result": SimpleNamespace(mono_pdf_path=config.input_file)}

    monkeypatch.setattr(high_level, "async_translate", produce)
    request = {"folder": str(tmp_path), "pages": "", "api_key": "never-sent"}
    if error:
        with pytest.raises(RuntimeError, match=f"simulated {error} failure"):
            asyncio.run(engine.translate(request))
    else:
        asyncio.run(engine.translate(request))
    events = events_from(capsys)
    report = json.loads((tmp_path / "quality.json").read_text())
    assert events[0]["phase"] == "preparing"
    assert events[-1]["phase"] == "finished"
    assert events[-1]["quality_status"] == report["status"] == expected
    assert events[-1]["counts"] == report["counts"]
    assert all(0 <= event["progress"] <= 99 for event in events[:-1])
    assert (events[-1]["progress"] == 100) == (expected in {"complete", "partial"} and not error)
    assert all(set(event["counts"]) == set(report["counts"]) for event in events)
    assert all(event["phase"] in {"preparing", "parsing", "translating", "typesetting",
                                  "restoring", "finished"} for event in events)
    assert "never-sent" not in json.dumps(events)
    if outcomes:
        assert any(event["phase"] == "translating" and event["counts"]["total"]
                   for event in events)


def test_concurrent_quality_and_upstream_events_are_consistent(tmp_path, capsys):
    """Worker callbacks and upstream updates share ordered snapshots without deadlocks."""
    quality = ResultQuality(tmp_path / "quality.json")
    progress = engine.EngineProgress(quality)

    def settle(index):
        """Resolve one independent paragraph while other workers publish updates."""
        quality.register(index, "Source text")
        quality.record(index, "attempt")
        quality.record(index, "success")

    def advance():
        """Publish upstream percentages concurrently with paragraph evidence."""
        for value in range(20):
            progress.upstream({"stage": "Translate Paragraphs", "overall_progress": value})

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(advance)]
        futures.extend(executor.submit(settle, index) for index in range(12))
        for future in futures:
            future.result(timeout=10)
    events = events_from(capsys)
    assert len(events) == 20 + 12 * 3
    assert events[-1]["counts"] == quality.report()["counts"]
    assert events[-1]["counts"]["success"] == 12
    assert [event["progress"] for event in events] == sorted(event["progress"] for event in events)
    for event in events:
        counts = event["counts"]
        assert counts["total"] == counts["success"] + counts["unresolved"]
    for field in ("total", "attempts", "success"):
        values = [event["counts"][field] for event in events]
        assert values == sorted(values)


def test_progress_failures_do_not_interrupt_quality_or_engine(tmp_path, monkeypatch, caplog):
    """Broken observers and broken stdout cannot discard application or final evidence."""
    quality = ResultQuality(tmp_path / "quality.json")

    def fail(*args):
        """Simulate a disconnected progress consumer without affecting filesystem writes."""
        raise BrokenPipeError("reader disconnected")

    quality.on_change = fail
    quality.register("p", "Source text")
    progress = engine.EngineProgress(quality)
    with monkeypatch.context() as patch:
        patch.setattr(engine.sys, "stdout", SimpleNamespace(write=fail, flush=lambda: None))
        progress.upstream({"stage": "Translate Paragraphs", "overall_progress": 20})
        quality.record("p", "success")
        quality.write(artifact_exists=True, inventory_observed=True, stage_completed=True, finalized=True)
    assert json.loads(quality.path.read_text())["status"] == "complete"
    assert progress.progress == 100
    assert "Unable to report paragraph progress" in caplog.text
    assert "Unable to emit engine progress" in caplog.text
