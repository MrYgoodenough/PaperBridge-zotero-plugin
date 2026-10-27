import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "backend"))
from engine import localize_cache
localize_cache()
from deepseek import DeepSeekTranslator


def translator(tmp_path):
    return DeepSeekTranslator(document_title="Stable paper title",document_key="same-document",
        paragraph_cache=tmp_path / "paragraphs.sqlite",usage_path=tmp_path / "usage.json",
        lang_in="en",lang_out="zh-CN",model="deepseek-flash",api_key="never-sent",
        base_url="http://127.0.0.1:1")


def response(items):
    usage=SimpleNamespace(total_tokens=100,prompt_tokens=70,completion_tokens=30,
                          prompt_cache_hit_tokens=10,prompt_cache_miss_tokens=60)
    return SimpleNamespace(usage=usage,choices=[SimpleNamespace(message=SimpleNamespace(
        content=json.dumps({"translations":items})))])


def test_fixed_prefix_and_compact_request(tmp_path):
    engine=translator(tmp_path)
    a=engine.messages([{"id":0,"input":"First paragraph"}])
    b=engine.messages([{"id":0,"input":"A different paragraph"}])
    assert a[0]==b[0] and a[0]["role"]=="system"
    assert a[1]["content"].startswith('{"title":"Stable paper title","paragraphs":')
    assert "layout_label" not in a[1]["content"] and "Structure Rules" not in a[0]["content"]


def test_cache_survives_new_batch_order_and_restart(tmp_path,monkeypatch):
    engine=translator(tmp_path);calls=[]
    def completion(messages):
        calls.append(messages)
        return response([{"id":0,"text":"第一段"},{"id":1,"text":"第二段"}])
    monkeypatch.setattr(engine,"request_completion",completion)
    first=engine.translate_items([{"id":0,"input":"First paragraph"},{"id":1,"input":"Second paragraph"}])
    assert first[0]["output"]=="第一段" and len(calls)==1
    restarted=translator(tmp_path)
    def unexpected(_):
        raise AssertionError("Cached paragraphs must not call the API")
    monkeypatch.setattr(restarted,"request_completion",unexpected)
    reordered=restarted.translate_items([{"id":7,"input":"Second paragraph"},{"id":9,"input":"First paragraph"}])
    assert reordered==[{"id":7,"output":"第二段"},{"id":9,"output":"第一段"}]
    assert restarted.paragraph_cache_hits==2


def test_broken_placeholders_are_not_cached(tmp_path,monkeypatch):
    engine=translator(tmp_path)
    monkeypatch.setattr(engine,"request_completion",lambda _:response([{"id":0,"text":"公式丢失"}]))
    with pytest.raises(ValueError,match="占位符"):
        engine.translate_items([{"id":0,"input":"Formula {v0}"}])
    assert engine.paragraph_cache.get("Formula {v0}") is None


def test_numeric_string_ids_do_not_trigger_a_retry(tmp_path,monkeypatch):
    engine=translator(tmp_path)
    monkeypatch.setattr(engine,"request_completion",lambda _:response([{"id":"0","text":"中文"}]))
    assert engine.translate_items([{"id":0,"input":"English"}])==[{"id":0,"output":"中文"}]
