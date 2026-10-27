"""Reflow real pages with the installed slim engine and cached translations only."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--engine", type=Path, required=True)
parser.add_argument("--label", default="bundled")
options = parser.parse_args()
engine = options.engine.resolve()
sys.path[:0] = [str(engine / "backend"), str(engine / "python/lib/python3.12/site-packages")]
sys.dont_write_bytecode = True
os.environ["PAPERBRIDGE_CACHE_DIR"] = str(ROOT / ".runtime/packaged-data/paperbridge/cache")
temporary = ROOT / ".runtime/slim-tmp"
temporary.mkdir(exist_ok=True)
os.environ["TMPDIR"] = str(temporary)
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
from engine import translate, localize_cache
localize_cache()
from deepseek import DeepSeekTranslator
import pymupdf
from PIL import Image, ImageChops, ImageStat

network_attempts = []
cache_misses = []


def forbidden_network(_socket, address):
    network_attempts.append(str(address))
    raise OSError("Network disabled for packaged reflow verification")


def forbidden_completion(messages):
    cache_misses.append(len(json.loads(messages[1]["content"])["paragraphs"]))
    raise AssertionError("Reflow must use the recorded paragraph translations")


async def main():
    folder = ROOT / f".runtime/slim-reflow-{options.label}"
    folder.mkdir(exist_ok=True)
    source = ROOT / ".cache/references/pi0-v3.pdf"
    (folder / "source.pdf").write_bytes(source.read_bytes())
    request = {"folder":str(folder), "api_key":"offline-only", "model":"deepseek-flash",
               "base_url":"http://127.0.0.1:1", "lang_out":"zh-CN", "pages":"2-4"}
    with patch.object(socket.socket, "connect", forbidden_network), patch.object(DeepSeekTranslator, "request_completion", forbidden_completion):
        await translate(request)
    usage = json.loads((folder / "usage.json").read_text())
    assert not cache_misses and not network_attempts, (cache_misses, network_attempts)
    baseline_info = json.loads((ROOT / "docs/zotero-packaged-0.2.1.json").read_text())
    baseline = Path(baseline_info["translatedAttachment"])
    errors, chinese, fonts = [], [], []
    with pymupdf.open(source) as original, pymupdf.open(baseline) as old, pymupdf.open(folder / "translated.pdf") as translated:
        for page_number in [1, 2, 3]:
            a, b = old[page_number].get_pixmap(), translated[page_number].get_pixmap()
            diff = ImageChops.difference(Image.frombytes("RGB", [a.width,a.height],a.samples),
                                         Image.frombytes("RGB", [b.width,b.height],b.samples))
            errors.append(sum(ImageStat.Stat(diff).mean)/3)
            text = translated[page_number].get_text()
            chinese.append(sum("\u4e00" <= char <= "\u9fff" for char in text))
            fonts.append(any("Songti" in font[3] for font in translated[page_number].get_fonts()))
            assert translated[page_number].rect == original[page_number].rect
            if options.label == "bundled":
                a = original[page_number].get_pixmap(matrix=pymupdf.Matrix(1.2,1.2))
                b = translated[page_number].get_pixmap(matrix=pymupdf.Matrix(1.2,1.2))
                preview = Image.new("RGB", (a.width+b.width+16,max(a.height,b.height)), "#dddddd")
                preview.paste(Image.frombytes("RGB",[a.width,a.height],a.samples),(0,0))
                preview.paste(Image.frombytes("RGB",[b.width,b.height],b.samples),(a.width+16,0))
                preview.save(ROOT / f"docs/slim-0.3.0-page-{page_number+1}.png")
    assert all(count > 100 for count in chinese) and all(fonts), (chinese,fonts)
    assert max(errors) < 1, errors
    excluded = [name for name in ["scipy","sklearn","skimage","huggingface_hub"]
                if (engine / "python/lib/python3.12/site-packages" / name).exists()]
    assert not excluded
    report = {"mode":options.label,"pages":[2,3,4],"actual_reflow":True,"provider_api_calls":usage["api_requests"],
              "resource_download_attempts":len(network_attempts), "paragraph_cache_hits":usage["paragraph_cache_hits"],
              "chinese_characters":chinese,"songti_embedded":all(fonts), "mean_pixel_error_against_0_2_1":errors,
              "excluded_toolkits_absent":True,"python":sys.executable}
    (ROOT / f"docs/slim-reflow-{options.label}-0.3.0.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    asyncio.run(main())
