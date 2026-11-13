"""Verify reported token totals and explicit uncertainty without provider traffic."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from engine import localize_cache
localize_cache()
from usage import MeteredTranslator


def test_records_actual_cache_hit_and_miss_tokens(tmp_path):
    """Preserve explicit provider hit and miss token counts."""
    meter = MeteredTranslator(usage_path=tmp_path / "usage.json", lang_in="en", lang_out="zh-CN",
        model="offline-usage-test", base_url="http://127.0.0.1:1", api_key="never-sent")
    usage = SimpleNamespace(total_tokens=100, prompt_tokens=80, completion_tokens=20,
                            prompt_cache_hit_tokens=50, prompt_cache_miss_tokens=30)
    meter.update_token_count(SimpleNamespace(usage=usage))
    data = json.loads(meter.usage_path.read_text())
    assert data["api_requests"] == 1
    assert data["input_tokens"] == 80
    assert data["cached_input_tokens"] == 50
    assert data["uncached_input_tokens"] == 30
    assert "never-sent" not in meter.usage_path.read_text()


def test_missing_usage_and_cache_split_stay_unknown(tmp_path):
    """Known totals are not silently converted into invented cache misses or lost usage."""
    meter = MeteredTranslator(usage_path=tmp_path / "usage.json", lang_in="en", lang_out="zh-CN",
        model="offline-usage-test", base_url="http://127.0.0.1:1", api_key="never-sent")
    meter.update_token_count(SimpleNamespace(usage=SimpleNamespace(
        total_tokens=12, prompt_tokens=10, completion_tokens=2)))
    meter.update_token_count(SimpleNamespace(usage=None))
    data = json.loads(meter.usage_path.read_text())
    assert data["api_requests"] == 2 and data["unknown_usage_requests"] == 1
    assert data["input_tokens"] == 10 and data["output_tokens"] == 2
    assert data["requests"][0]["prompt_cache_hit_tokens"] is None
    assert data["requests"][0]["prompt_cache_miss_tokens"] is None
    assert data["requests"][1]["prompt_tokens"] is None
    assert data["billing_uncertain"] and data["token_totals_are_partial"]
    assert not data["cache_usage_complete"]
