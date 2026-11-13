"""Offline contracts for controlled provider requests and paragraph cache isolation."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from engine import localize_cache
localize_cache()
from deepseek import DeepSeekTranslator


def translator(tmp_path, **options):
    """Create an offline translator with optional profile overrides."""
    return DeepSeekTranslator(document_title="Stable paper title",document_key="same-document",
        paragraph_cache=tmp_path / "paragraphs.sqlite",usage_path=tmp_path / "usage.json",
        lang_in="en",lang_out="zh-CN",model="deepseek-flash",api_key="never-sent",
        base_url=options.pop("base_url", "http://127.0.0.1:1"), **options)


def response(items):
    """Return a provider-shaped response without making network requests."""
    usage=SimpleNamespace(total_tokens=100,prompt_tokens=70,completion_tokens=30,
                          prompt_cache_hit_tokens=10,prompt_cache_miss_tokens=60)
    return SimpleNamespace(usage=usage,choices=[SimpleNamespace(message=SimpleNamespace(
        content=json.dumps({"translations":items})))])


def test_fixed_prefix_and_compact_request(tmp_path):
    """Avoid repeating verbose layout instructions for every batch."""
    engine=translator(tmp_path)
    a=engine.messages([{"id":0,"input":"First paragraph"}])
    b=engine.messages([{"id":0,"input":"A different paragraph"}])
    assert a[0]==b[0] and a[0]["role"]=="system"
    assert a[1]["content"].startswith('{"title":"Stable paper title","paragraphs":')
    assert "layout_label" not in a[1]["content"] and "Structure Rules" not in a[0]["content"]


def test_cache_survives_new_batch_order_and_restart(tmp_path,monkeypatch):
    """Reuse paragraph results despite changing batch order and local IDs."""
    engine=translator(tmp_path);calls=[]
    def completion(messages):
        """Record the sole simulated provider call."""
        calls.append(messages)
        return response([{"id":0,"text":"第一段"},{"id":1,"text":"第二段"}])
    monkeypatch.setattr(engine,"request_completion",completion)
    first=engine.translate_items([{"id":0,"input":"First paragraph"},{"id":1,"input":"Second paragraph"}])
    assert first[0]["output"]=="第一段" and len(calls)==1
    restarted=translator(tmp_path)
    def unexpected(_):
        """Reject any request when all paragraphs were already cached."""
        raise AssertionError("Cached paragraphs must not call the API")
    monkeypatch.setattr(restarted,"request_completion",unexpected)
    reordered=restarted.translate_items([{"id":7,"input":"Second paragraph"},{"id":9,"input":"First paragraph"}])
    assert reordered==[{"id":7,"output":"第二段"},{"id":9,"output":"第一段"}]
    assert restarted.paragraph_cache_hits==2


def test_broken_placeholders_are_not_cached(tmp_path,monkeypatch):
    """Reject output that loses protected formula placeholders."""
    engine=translator(tmp_path)
    monkeypatch.setattr(engine,"request_completion",lambda _:response([{"id":0,"text":"公式丢失"}]))
    with pytest.raises(ValueError,match="占位符"):
        engine.translate_items([{"id":0,"input":"Formula {v0}"}])
    assert engine.paragraph_cache.get("Formula {v0}") is None


def test_numeric_string_ids_do_not_trigger_a_retry(tmp_path,monkeypatch):
    """Accept lossless numeric-string IDs without another API request."""
    engine=translator(tmp_path)
    monkeypatch.setattr(engine,"request_completion",lambda _:response([{"id":"0","text":"中文"}]))
    assert engine.translate_items([{"id":0,"input":"English"}])==[{"id":0,"output":"中文"}]


@pytest.mark.parametrize("profile,capabilities,extras", [
    ("deepseek", None, {"response_format": {"type": "json_object"}, "extra_body": {"thinking": {"type": "disabled"}}}),
    ("compatible", None, {}),
    ("compatible", {"json_mode": True, "thinking_disabled": False, "max_tokens": 1200},
     {"response_format": {"type": "json_object"}}),
])
def test_profiles_control_exact_request_shape(tmp_path, monkeypatch, profile, capabilities, extras):
    """Compatible defaults omit provider-specific fields and the SDK never retries."""
    engine = translator(tmp_path, profile=profile, capabilities=capabilities)
    calls = []
    monkeypatch.setattr(engine.client.chat.completions, "create", lambda **options: calls.append(options))
    engine.request_completion([])
    assert calls == [{"model": "deepseek-flash", "messages": [], "temperature": 0,
                      "max_tokens": 1200 if capabilities else 8192, **extras}]
    assert engine.client.max_retries == 0


def test_cache_isolates_profile_endpoint_and_capabilities(tmp_path):
    """A model name alone never permits reuse across endpoints or request capabilities."""
    engine = translator(tmp_path, base_url="https://API.DeepSeek.com:443/v1/")
    engine.paragraph_cache.put("English", "中文")
    assert translator(tmp_path, base_url="https://api.deepseek.com").paragraph_cache.get("English") == "中文"
    assert translator(tmp_path, base_url="https://example.org").paragraph_cache.get("English") is None
    assert translator(tmp_path, base_url="https://api.deepseek.com", profile="compatible").paragraph_cache.get("English") is None
    assert translator(tmp_path, base_url="https://api.deepseek.com",
                      capabilities={"max_tokens": 1000}).paragraph_cache.get("English") is None


def test_default_legacy_cache_is_not_assumed_to_be_deepseek(tmp_path):
    """Retain legacy rows but do not trust hashes that omitted provider identity."""
    engine = translator(tmp_path, base_url="https://api.deepseek.com")
    namespace = json.dumps(["paperbridge-compact-v1", "deepseek-flash", "zh-CN", "same-document"], separators=(",", ":"))
    key = hashlib.sha256((namespace + "\0English").encode()).hexdigest()
    with sqlite3.connect(engine.paragraph_cache.path) as db:
        db.execute("INSERT INTO paragraphs VALUES (?,?,?)", (key, "legacy", "same-document"))
    assert engine.paragraph_cache.get("English") is None
    with sqlite3.connect(engine.paragraph_cache.path) as db:
        assert db.execute("SELECT translation FROM paragraphs WHERE key=?", (key,)).fetchone() == ("legacy",)


def test_lost_response_is_unknown_billing_and_fallback_never_resends(tmp_path, monkeypatch):
    """Persist uncertain dispatch before failure and suppress implicit billed retries."""
    engine = translator(tmp_path)
    calls = []

    def timeout(messages):
        """Inspect the durable in-flight record before simulating a lost response."""
        calls.append(messages)
        record = json.loads(engine.usage_path.read_text())
        assert record["in_flight_requests"] == 1 and record["billing_uncertain"]
        raise TimeoutError("never-sent must not be logged or persisted")

    monkeypatch.setattr(engine, "request_completion", timeout)
    with pytest.raises(RuntimeError, match="billing unknown") as caught:
        engine.translate_items([{"id": 0, "input": "English"}])
    assert "never-sent" not in str(caught.value)
    engine.request_context.cache_only = True
    with pytest.raises(RuntimeError, match="suppressed"):
        engine.translate_items([{"id": 0, "input": "English"}])
    record = json.loads(engine.usage_path.read_text())
    assert len(calls) == record["api_requests"] == record["failed_requests"] == 1
    assert record["requests"][0]["prompt_tokens"] is None
    assert record["input_tokens"] == 0 and record["token_totals_are_partial"]
    assert "never-sent" not in engine.usage_path.read_text()


def test_partial_validation_preserves_good_cache_and_actual_usage(tmp_path, monkeypatch):
    """Cache usable members of a failed batch without fabricating its successful coverage."""
    engine = translator(tmp_path)
    monkeypatch.setattr(engine, "request_completion", lambda _: response([
        {"id": 0, "text": "有效译文"}, {"id": 1, "text": "missing formula"}]))
    with pytest.raises(ValueError, match="占位符"):
        engine.translate_items([{"id": 0, "input": "English"}, {"id": 1, "input": "Formula {v0}"}])
    assert engine.paragraph_cache.get("English") == "有效译文"
    assert engine.paragraph_cache.get("Formula {v0}") is None
    assert json.loads(engine.usage_path.read_text())["input_tokens"] == 70
    assert engine.quality.report()["counts"]["success"] == 0


def test_truncated_response_keeps_usage_but_is_not_cached(tmp_path, monkeypatch):
    """Even parseable JSON cannot certify success after the output token limit was reached."""
    engine = translator(tmp_path)
    result = response([{"id": 0, "text": "中文"}])
    result.choices[0].finish_reason = "length"
    monkeypatch.setattr(engine, "request_completion", lambda _: result)
    with pytest.raises(ValueError, match="truncated"):
        engine.translate_items([{"id": 0, "input": "English"}])
    assert engine.paragraph_cache.get("English") is None
    record = json.loads(engine.usage_path.read_text())
    assert record["output_tokens"] == 30 and not record["billing_uncertain"]
