"""Exercise the packaged engine on a formula page, making no provider calls."""
import asyncio
import json
import sys
import os
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT / "addon/manifest.json").read_text())["version"]
ENGINE = ROOT / ".runtime/packaged-data/paperbridge/engine"
os.environ["PAPERBRIDGE_CACHE_DIR"]=str(ENGINE.parent / "cache")
sys.path.insert(0, str(ENGINE / "backend"))
sys.path.insert(0, str(ENGINE / "python/lib/python3.12/site-packages"))
temporary = ROOT / ".runtime/formula-tmp"
temporary.mkdir(exist_ok=True)
os.environ["TMPDIR"] = str(temporary)
from engine import localize_cache, translate
localize_cache()
from deepseek import DeepSeekTranslator


def offline(messages):
    inputs=json.loads(messages[1]["content"])["paragraphs"]
    content=json.dumps({"translations":[{"id":p["id"],"text":p["text"]} for p in inputs]})
    return SimpleNamespace(usage=None,choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def main():
    import pymupdf
    from PIL import Image, ImageChops, ImageStat
    folder = ROOT / f".runtime/formula-offline-{VERSION}"
    folder.mkdir(exist_ok=True)
    source = ROOT / ".cache/references/pi0-v3.pdf"
    (folder / "source.pdf").write_bytes(source.read_bytes())
    request={"folder":str(folder),"api_key":"offline-no-provider-call","model":"offline-formula-test",
             "base_url":"http://127.0.0.1:1","lang_out":"zh-CN","pages":"5"}
    with patch.object(DeepSeekTranslator,"request_completion",side_effect=offline):
        asyncio.run(translate(request))
    regions=json.loads((folder / "translated.tmp.regions.json").read_text())
    errors=[]
    text_matches=[]
    with pymupdf.open(source) as original, pymupdf.open(folder / "translated.pdf") as translated:
        for box in regions.get("4",[]):
            clip=(pymupdf.Rect(box)+(2,2,-2,-2)) & original[4].rect
            a=original[4].get_pixmap(clip=clip); b=translated[4].get_pixmap(clip=clip)
            diff=ImageChops.difference(Image.frombytes('RGB',[a.width,a.height],a.samples),
                                     Image.frombytes('RGB',[b.width,b.height],b.samples))
            errors.append(sum(ImageStat.Stat(diff).mean)/3)
            text_matches.append(original[4].get_text(clip=clip)==translated[4].get_text(clip=clip))
        translated[4].get_pixmap(matrix=pymupdf.Matrix(1.5,1.5)).save(ROOT / f"docs/formula-{VERSION}-offline.png")
    usage=json.loads((folder / "usage.json").read_text())
    assert usage["api_requests"]==0 and len(errors)>=2 and max(errors)<1 and all(text_matches),errors
    report={"page":5,"provider_api_calls":0,"protected_regions":len(errors),
            "formula_texts_match":all(text_matches),"mean_pixel_errors_0_to_255":errors}
    (ROOT / f"docs/formula-{VERSION}-verification.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
