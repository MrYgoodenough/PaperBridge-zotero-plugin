"""One isolated BabelDOC process with quality-backed progress and stdin-only API keys."""
import asyncio
import importlib.util
import json
import hashlib
import logging
import math
import os
import sys
import threading
import types
from pathlib import Path

os.environ["ORT_DISABLE_TELEMETRY"] = "1"
# Resolve resources relative to the project or packaged runtime, never the shell cwd.
ROOT = Path(__file__).resolve().parents[1]
# Keep all mutable BabelDOC assets inside the plugin-managed cache.
CACHE = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR", ROOT / ".cache"))
# Bound orphaned-engine activity without interfering with normal shutdown.
PARENT_CHECK_INTERVAL = 3
# Only finalized usable quality evidence may advance beyond this working limit.
ENGINE_PROGRESS_LIMIT = 99
# Paragraph workers and the asynchronous engine loop share one PB event stream.
EMIT_LOCK = threading.Lock()
# Progress is advisory and must not interrupt translation or quality persistence.
LOGGER = logging.getLogger(__name__)


def watch_parent(parent_pid, is_running, exit_engine, wait):
    """Stop only this engine after its original parent dies; callbacks keep tests harmless."""
    while True:
        wait(PARENT_CHECK_INTERVAL)
        if not is_running(parent_pid):
            # A hard exit also stops translation workers and any pending provider dispatch.
            exit_engine(1)
            return


def localize_cache():
    """Redirect the pinned engine's hardcoded cache before importing its consumers."""
    # BabelDOC 0.6.4 hardcodes Path.home(), ignoring XDG_CACHE_HOME.
    # Load its constants with only that assignment redirected before other modules import it.
    spec = importlib.util.find_spec("babeldoc.const")
    source = Path(spec.origin).read_text(encoding="utf-8")
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
    """Send one intact PB event; a disconnected progress reader is nonfatal."""
    try:
        with EMIT_LOCK:
            print("PB:" + json.dumps(event, ensure_ascii=False, allow_nan=False), flush=True)
    except Exception:
        LOGGER.warning("Unable to emit engine progress; translation continues")


class EngineProgress:
    """Combine upstream percentages with snapshots of the existing quality evidence."""

    def __init__(self, quality):
        """Subscribe before parsing without creating another paragraph outcome ledger."""
        self.lock = threading.RLock()
        self.progress = 0.0
        self.phase = "preparing"
        self.stage = "准备翻译引擎与字体"
        self.counts = quality.report()["counts"]
        self.quality_status = None
        # Lock order is quality -> progress -> stdout; progress never reads quality back.
        quality.on_change = self.quality_changed

    def report(self):
        """Publish a consistent snapshot without exposing paragraph data or credentials."""
        with self.lock:
            fields = {"quality_status": self.quality_status} if self.quality_status else {}
            emit(progress=self.progress, phase=self.phase, stage=self.stage,
                 counts=dict(self.counts), **fields)

    def quality_changed(self, report):
        """Show applied, failed and cache counts immediately, using only quality truth."""
        with self.lock:
            if self.counts == report["counts"] and not report["finalized"]:
                return
            self.counts = dict(report["counts"])
            if report["finalized"]:
                self.phase = "finished"
                self.quality_status = report["status"]
                # These labels describe quality, not the server's persisted job lifecycle.
                stages = {"complete": "翻译完成", "partial": "译文部分可用",
                          "unusable": "译文不可用", "unknown": "译文已生成，质量未知"}
                self.stage = stages[self.quality_status]
                # A retained artifact after an engine error is not confirmed engine completion.
                usable = (report["artifact_exists"] and not report["engine_error"]
                          and self.quality_status in {"complete", "partial"})
                self.progress = 100 if usable else min(self.progress, ENGINE_PROGRESS_LIMIT)
            elif self.counts["total"] and self.phase in {"preparing", "parsing"}:
                self.phase, self.stage = "translating", "翻译段落"
            self.report()

    def upstream(self, event):
        """Keep BabelDOC's 0–100 scale, ignoring missing or invalid percentages."""
        with self.lock:
            if self.phase == "finished":
                return
            stage = event.get("stage")
            if isinstance(stage, str) and stage:
                self.stage = stage
                lowered = stage.lower()
                if "translate" in lowered or "extract terms" in lowered:
                    self.phase = "translating"
                elif any(word in lowered for word in ("typeset", "font", "drawing", "save pdf")):
                    self.phase = "typesetting"
                else:
                    self.phase = "parsing"
            value = event.get("overall_progress")
            if type(value) is int or (type(value) is float and math.isfinite(value)):
                self.progress = max(self.progress, min(ENGINE_PROGRESS_LIMIT, max(0.0, value)))
            self.report()

    def restoring(self):
        """Keep original-region restoration below the usable completion boundary."""
        with self.lock:
            if self.phase == "finished":
                return
            self.phase, self.stage = "restoring", "恢复原始图表与公式"
            self.progress = ENGINE_PROGRESS_LIMIT
            self.report()


async def translate(request):
    """Always finalize result evidence; a generated PDF alone cannot certify completeness."""
    localize_cache()
    from library_cache import normalize_config
    from usage import ResultQuality
    quality = ResultQuality(Path(request["folder"]) / "quality.json")
    quality.write()
    try:
        await _translate({**request, **normalize_config(request)}, quality)
    except BaseException as error:
        quality.write(finalized=True, engine_error=type(error).__name__)
        raise
    quality.write(finalized=True)


async def _translate(request, quality):
    """Run BabelDOC 0.6.4 with observed paragraphs and explicit provider capabilities."""
    progress = EngineProgress(quality)
    progress.report()
    from babeldoc.assets import assets
    async def no_asset_download(*args, **kwargs):
        """Require packaged layout resources rather than downloading at job runtime."""
        raise RuntimeError("安装包缺少所需排版资源。请重新安装 XPI；PaperBridge 不会自动下载资源。")
    assets.download_file = no_asset_download
    assets.get_fastest_upstream_for_font = no_asset_download
    assets.get_fastest_upstream_for_model = no_asset_download
    import tiktoken.load
    def no_tokenizer_download(path):
        """Keep tokenizer loading offline and report missing packaged resources."""
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
    from fragment_trace import FragmentTrace
    from references import reference_regions
    import pymupdf

    folder = Path(request["folder"])
    source = folder / "source.pdf"
    # Mapping always hashes the original snapshot, never the optional repaired working input.
    original_source = source
    document_key = request.get("document_key") or hashlib.sha256(source.read_bytes()).hexdigest()
    with pymupdf.open(source) as document:
        blocks = document[0].get_text("dict")["blocks"]
        titles = [(max(span["size"] for line in block["lines"] for span in line["spans"]),
                   " ".join(span["text"] for line in block["lines"] for span in line["spans"]))
                  for block in blocks if block.get("lines") and any(line["spans"] for line in block["lines"])]
        title = max(titles,key=lambda item:item[0])[1][:300] if titles else ""
        if document.is_repaired:
            progress.upstream({"stage": "修复 PDF 交叉引用"})
            repaired = folder / "repaired.pdf"
            document.save(repaired, garbage=4, deflate=True)
            source = repaired
    translator = DeepSeekTranslator(document_title=title,
                                  document_key=document_key,
                                  paragraph_cache=CACHE / "paragraphs.sqlite",
                                  usage_path=folder / "usage.json", lang_in="en", lang_out=request["lang_out"],
                                  model=request["model"], base_url=request["base_url"],
                                  api_key=request["api_key"], profile=request["profile"],
                                  capabilities=request["capabilities"])
    translator.quality = quality
    translator.fragment_trace = FragmentTrace(original_source)
    translator.write_usage()
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
            progress.upstream(event)
        if kind == "finish":
            result = event["translate_result"]
            output = result.mono_pdf_path
            if not output:
                raise RuntimeError("BabelDOC 未返回译文 PDF")
            temporary = folder / "translated.tmp.pdf"
            progress.restoring()
            restore_regions(source, output, temporary, layout_model.regions)
            temporary.replace(folder / "translated.pdf")
            translator.fragment_trace.write(folder / "translated.pdf", folder / "alignment.json", quality)
            quality.write(artifact_exists=True)
            translator.write_usage(excluded_graphic_characters=layout_model.excluded_characters,
                                   excluded_reference_characters=layout_model.excluded_reference_characters)
            return
    raise RuntimeError("BabelDOC 提前结束，未生成译文")


if __name__ == "__main__":
    # Capture the original parent once; never follow a replacement parent after reparenting.
    parent_pid = os.getppid()
    from server import parent_running
    threading.Thread(target=watch_parent,
                     args=(parent_pid, parent_running, os._exit, threading.Event().wait),
                     daemon=True, name="paperbridge-engine-parent").start()
    request = json.loads(sys.stdin.readline())
    try:
        asyncio.run(translate(request))
    except Exception as error:
        # Keep provider errors useful while never writing the API key to logs.
        print(str(error).replace(request["api_key"], "[REDACTED]"), file=sys.stderr)
        sys.exit(1)
