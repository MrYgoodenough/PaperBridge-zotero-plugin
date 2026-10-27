"""Prepare only the layout model, tokenizer and local Songti fonts."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
os.environ["XDG_CACHE_HOME"] = str(ROOT / ".cache")
os.environ["HF_HOME"] = str(ROOT / ".cache/huggingface")
os.environ["TORCH_HOME"] = str(ROOT / ".cache/torch")
os.environ["MPLCONFIGDIR"] = str(ROOT / ".cache/matplotlib")
from engine import localize_cache
from fonts import prepare_songti

localize_cache()
prepare_songti()
from babeldoc.assets.assets import get_doclayout_onnx_model_path
from tiktoken import encoding_for_model

print("准备 tokenizer…", flush=True)
encoding_for_model("gpt-4o")
print("准备论文版面识别模型…", flush=True)
print(get_doclayout_onnx_model_path(), flush=True)
print("本地翻译资源就绪。", flush=True)
