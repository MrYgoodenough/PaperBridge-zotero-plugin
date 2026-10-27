"""One isolated BabelDOC process per job; API keys enter through stdin only."""
import asyncio
import importlib.util
import json
import hashlib
import os
import sys
import types
from pathlib import Path

os.environ["ORT_DISABLE_TELEMETRY"] = "1"
ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR", ROOT / ".cache"))


def localize_cache():
    # BabelDOC 0.6.4 hardcodes Path.home(), ignoring XDG_CACHE_HOME.
    # Load its constants with only that assignment redirected before other modules import it.
    spec = importlib.util.find_spec("babeldoc.const")
    source = Path(spec.origin).read_text()
    original = 'CACHE_FOLDER = Path.home() / ".cache" / "babeldoc"'
    if original not in source:
        raise RuntimeError("BabelDOC cache interface changed; install the pinned version")
    source = source.replace(original, f"CACHE_FOLDER = Path({str(CACHE / 'babeldoc')!r})", 1)
    module = types.ModuleType("babeldoc.const")
    module.__file__ = spec.origin
    module.__spec__ = spec
    sys.modules["babeldoc.const"] = module
    exec(compile(source, spec.origin, "exec"), module.__dict__)
    import babeldoc
    babeldoc.const = module


def emit(**event):
    print("PB:" + json.dumps(event, ensure_ascii=False), flush=True)


async def translate(request):
    localize_cache()
    from babeldoc.assets import assets
    async def no_asset_download(*args, **kwargs):
        raise RuntimeError("安装包缺少所需排版资源。请重新安装 XPI；PaperBridge 不会自动下载资源。")
    assets.download_file = no_asset_download
    assets.get_fastest_upstream_for_font = no_asset_download
    assets.get_fastest_upstream_for_model = no_asset_download
    import tiktoken.load
    def no_tokenizer_download(path):
        raise RuntimeError("安装包的 tokenizer 资源缺失或损坏。请重新安装 XPI；PaperBridge 不会自动下载资源。")
    tiktoken.load.read_file = no_tokenizer_download
    from fonts import install_songti
    install_songti(assets)
    from babeldoc.format.pdf import high_level
    from batching import CostAwareILTranslator
    high_level.ILTranslatorLLMOnly = CostAwareILTranslator
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from deepseek import DeepSeekTranslator
    from babeldoc.docvision.doclayout import DocLayoutModel
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    from preserve import ProtectedLayoutModel, restore_regions
    from references import reference_regions
    import pymupdf

    folder = Path(request["folder"])
    source = folder / "source.pdf"
    document_key = request.get("document_key") or hashlib.sha256(source.read_bytes()).hexdigest()
    with pymupdf.open(source) as document:
        blocks = document[0].get_text("dict")["blocks"]
        titles = [(max(span["size"] for line in block["lines"] for span in line["spans"]),
                   " ".join(span["text"] for line in block["lines"] for span in line["spans"]))
                  for block in blocks if block.get("lines") and any(line["spans"] for line in block["lines"])]
        title = max(titles,key=lambda item:item[0])[1][:300] if titles else ""
        if document.is_repaired:
            emit(stage="修复 PDF 交叉引用", progress=0)
            repaired = folder / "repaired.pdf"
            document.save(repaired, garbage=4, deflate=True)
            source = repaired
    translator = DeepSeekTranslator(document_title=title,
                                  document_key=document_key,
                                  paragraph_cache=CACHE / "paragraphs.sqlite",
                                  usage_path=folder / "usage.json", lang_in="en", lang_out=request["lang_out"],
                                  model=request["model"], base_url=request["base_url"],
                                  api_key=request["api_key"], thinking="disabled",
                                  enable_json_mode_if_requested=True)
    with pymupdf.open(source) as document:
        references = reference_regions(document)
    layout_model = ProtectedLayoutModel(DocLayoutModel.load_available(),references)
    config = TranslationConfig(
        translator=translator, input_file=source, lang_in="en",
        lang_out=request["lang_out"], doc_layout_model=layout_model, pages=request["pages"] or None,
        output_dir=folder / "output", working_dir=folder / "work", no_dual=True,
        qps=2, pool_max_workers=2, auto_extract_glossary=False,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        add_formula_placehold_hint=True, primary_font_family="serif",
        disable_same_text_fallback=True,
    )
    async for event in high_level.async_translate(config):
        kind = event["type"]
        if kind == "error":
            raise RuntimeError(str(event.get("error", event)))
        if kind in {"progress_start", "progress_update", "progress_end"}:
            progress = float(event.get("overall_progress", 0))
            emit(stage=event.get("stage", "翻译与排版"), progress=min(99, progress))
        if kind == "finish":
            result = event["translate_result"]
            output = result.mono_pdf_path
            if not output:
                raise RuntimeError("BabelDOC 未返回译文 PDF")
            temporary = folder / "translated.tmp.pdf"
            emit(stage="恢复原始图表与公式", progress=99)
            restore_regions(source, output, temporary, layout_model.regions)
            temporary.replace(folder / "translated.pdf")
            translator.write_usage(excluded_graphic_characters=layout_model.excluded_characters,
                                   excluded_reference_characters=layout_model.excluded_reference_characters)
            emit(progress=100, stage="翻译完成")
            return
    raise RuntimeError("BabelDOC 提前结束，未生成译文")


if __name__ == "__main__":
    request = json.loads(sys.stdin.readline())
    try:
        asyncio.run(translate(request))
    except Exception as error:
        # Keep provider errors useful while never writing the API key to logs.
        print(str(error).replace(request["api_key"], "[REDACTED]"), file=sys.stderr)
        sys.exit(1)
