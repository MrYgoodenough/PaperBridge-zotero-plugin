"""Verify reference exclusion at the actual LLM boundary, with no network."""
import asyncio
import json
import os
from pathlib import Path
import re
import socket
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT / ".runtime/packaged-data/paperbridge/engine"
sys.path[:0]=[str(ENGINE/"backend"),str(ENGINE/"python/lib/python3.12/site-packages")]
os.environ["PAPERBRIDGE_CACHE_DIR"]=str(ENGINE.parent/"cache")
temporary=ROOT/".runtime/reference-tmp";temporary.mkdir(exist_ok=True)
os.environ["TMPDIR"]=str(temporary)
from engine import localize_cache,translate
localize_cache()
from deepseek import DeepSeekTranslator
from references import reference_regions
import pymupdf
from PIL import Image,ImageChops,ImageStat


def main():
    folder=ROOT/".runtime/reference-offline-0.3.1";folder.mkdir(exist_ok=True)
    source=ROOT/".cache/references/pi0-v3.pdf"
    (folder/"source.pdf").write_bytes(source.read_bytes())
    captured=[];network=[]
    def completion(messages):
        paragraphs=json.loads(messages[1]["content"])["paragraphs"]
        captured.extend(p["text"] for p in paragraphs)
        content=json.dumps({"translations":[{"id":p["id"],"text":p["text"]} for p in paragraphs]})
        return SimpleNamespace(usage=None,choices=[SimpleNamespace(message=SimpleNamespace(content=content))])
    def blocked(_socket,address):
        network.append(str(address));raise OSError("Network disabled")
    request={"folder":str(folder),"api_key":"offline-only","model":"offline-reference-0.3.1",
             "base_url":"http://127.0.0.1:1","lang_out":"zh-CN","pages":"12,14-15"}
    with patch.object(DeepSeekTranslator,"request_completion",side_effect=completion),patch.object(socket.socket,"connect",blocked):
        asyncio.run(translate(request))
    errors=[];text_equal=[];entries=[]
    wire=re.sub(r"\s+"," "," ".join(captured))
    with pymupdf.open(source) as original,pymupdf.open(folder/"translated.pdf") as translated:
        boxes=reference_regions(original)
        for page_number in [11,13,14]:
            for box in boxes[page_number]:
                clip=(pymupdf.Rect(box)+(2,2,-2,-2)) & original[page_number].rect
                a=original[page_number].get_pixmap(clip=clip);b=translated[page_number].get_pixmap(clip=clip)
                diff=ImageChops.difference(Image.frombytes("RGB",[a.width,a.height],a.samples),Image.frombytes("RGB",[b.width,b.height],b.samples))
                errors.append(sum(ImageStat.Stat(diff).mean)/3)
                text=original[page_number].get_text(clip=clip)
                text_equal.append(text==translated[page_number].get_text(clip=clip))
                entries.extend(re.sub(r"\s+"," ",line).strip() for line in text.splitlines() if re.match(r"^\s*\[\d+\]",line) and len(line)>35)
            if page_number in [11,14]:
                translated[page_number].get_pixmap(matrix=pymupdf.Matrix(1.4,1.4)).save(ROOT/f"docs/references-0.3.1-page-{page_number+1}.png")
    assert captured and not network
    assert entries and all(entry not in wire for entry in entries),"A bibliography entry reached the LLM"
    assert all(text_equal) and max(errors)<1,(text_equal,errors)
    assert "APPENDIX" in re.sub(r"\s+","",wire).upper(),"Appendix was incorrectly excluded"
    usage=json.loads((folder/"usage.json").read_text())
    report={"pages":[12,14,15],"provider_api_calls":usage["api_requests"],"network_attempts":len(network),
            "reference_entries_checked":len(entries),"reference_entries_sent_to_llm":0,
            "reference_texts_match":all(text_equal),"reference_pixel_errors":errors,
            "body_and_appendix_still_reach_translator":True,"excluded_reference_characters":usage["excluded_reference_characters"]}
    (ROOT/"docs/references-0.3.1.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__=="__main__":
    main()
