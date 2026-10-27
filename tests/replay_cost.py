"""Audit the new batching/wire format using recorded translations, with zero API calls."""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / "backend"))
from engine import localize_cache,translate
localize_cache()
from deepseek import DeepSeekTranslator
import tiktoken


def main():
    baseline=ROOT / ".runtime/packaged-data/paperbridge/0.2.0/.runtime/jobs"
    tracking=next(baseline.glob("*/work/*/translate_tracking.json"))
    old=json.loads(tracking.read_text())
    known={p["input"]:p["output"] for group in ["page","cross_page","cross_column"]
           for page in old[group] for p in page["paragraph"] if p["input"] and p["output"]}
    calls=[];missing=[]
    def completion(messages):
        calls.append(messages)
        inputs=json.loads(messages[1]["content"])["paragraphs"]
        items=[]
        for p in inputs:
            output=known.get(p["text"])
            if output is None:
                missing.append(p["text"])
                output=p["text"]
            items.append({"id":p["id"],"text":output})
        return SimpleNamespace(usage=None,choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps({"translations":items},ensure_ascii=False)))])
    folder=ROOT / ".runtime/cost-replay-0.2.1"
    folder.mkdir(exist_ok=True)
    (folder / "source.pdf").write_bytes((ROOT / ".cache/references/pi0-v3.pdf").read_bytes())
    request={"folder":str(folder),"api_key":"offline-only","model":"offline-compact-v1",
        "base_url":"http://127.0.0.1:1","lang_out":"zh-CN","pages":"2-4"}
    with patch.object(DeepSeekTranslator,"request_completion",side_effect=completion):
        asyncio.run(translate(request))
    encoding=tiktoken.get_encoding("o200k_base")
    tokens=sum(len(encoding.encode(m["content"]))+4 for c in calls for m in c)
    report={"provider_api_calls":0,"baseline_actual_requests":12,"new_offline_batches":len(calls),
        "new_estimated_input_tokens":tokens,"unmapped_paragraphs":len(missing),
        "stable_system_prefixes":len({c[0]["content"] for c in calls})}
    (ROOT / "docs/cost-replay-0.2.1.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__=="__main__":
    main()
