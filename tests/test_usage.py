import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from engine import localize_cache
localize_cache()
from usage import MeteredTranslator


def test_records_actual_cache_hit_and_miss_tokens(tmp_path):
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
