"""Find display equations locally with the model already shipped in the XPI."""
import os
import threading
from pathlib import Path

_MODEL = None
_LOCK = threading.Lock()


def detect(request):
    try:
        return _detect(request)
    except (ValueError, OSError):
        raise
    except Exception as error:
        raise ValueError("本地长公式识别失败：" + str(error)) from None


def _detect(request):
    if not isinstance(request, dict) or not isinstance(request.get("source_path"), str):
        raise ValueError("PDF 请求格式无效")
    index = request.get("page_index")
    if not isinstance(index, int) or index < 0:
        raise ValueError("PDF 页码无效")
    import pymupdf
    path = Path(request["source_path"])
    if path.suffix.lower() != ".pdf" or not path.is_file():
        raise ValueError("PDF 文件不可用")
    with _LOCK:
        global _MODEL
        if _MODEL is None:
            from engine import localize_cache
            localize_cache()
            from babeldoc.docvision.doclayout import OnnxModel
            cache = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR", Path(__file__).resolve().parents[1] / ".cache"))
            model_path = cache / "babeldoc/models/doclayout_yolo_docstructbench_imgsz1024.onnx"
            if not model_path.exists():
                raise ValueError("内置公式区域识别模型缺失，请重新安装 XPI")
            # Detection is occasional and page-local. CPU avoids CoreML compilation
            # and its filesystem side effects in a long-lived reader service.
            import ast
            import onnxruntime
            onnxruntime.disable_telemetry_events()
            _MODEL = OnnxModel.__new__(OnnxModel)
            _MODEL.model = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
            metadata = _MODEL.model.get_modelmeta().custom_metadata_map
            _MODEL._stride = ast.literal_eval(metadata["stride"])
            _MODEL._names = ast.literal_eval(metadata["names"])
            _MODEL.lock = threading.Lock()
        with pymupdf.open(path) as document:
            if index >= len(document):
                raise ValueError("PDF 页码超出范围")
            page = document[index]
            import numpy as np
            scale = min(1.5, 1600 / max(page.rect.width, page.rect.height))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False, colorspace=pymupdf.csRGB)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)[:, :, ::-1]
            layout = _MODEL.predict(image)[0]
            sx, sy = page.rect.width / pix.width, page.rect.height / pix.height
            regions = []
            for box in layout.boxes:
                if layout.names[int(box.cls)] not in {"isolate_formula", "isolated_formula", "formula"}:
                    continue
                x1, y1, x2, y2 = [float(n) for n in box.xyxy]
                rectangle = (pymupdf.Rect(x1*sx-2, y1*sy-2, x2*sx+2, y2*sy+2) & page.rect)
                glyphs, lines = [], []
                for block in page.get_text("rawdict", clip=rectangle * page.derotation_matrix)["blocks"]:
                    for line in block.get("lines", []):
                        text = ""
                        for span in line["spans"]:
                            for char in span["chars"]:
                                text += char["c"]
                                # PyMuPDF uses unrotated top-down page coordinates.
                                r = pymupdf.Rect(char["bbox"]) * ~page.transformation_matrix
                                glyphs.append({"c":char["c"], "rect":[round(v,2) for v in r], "page":index})
                        lines.append(text)
                if not glyphs:
                    continue  # No image-to-LaTeX OCR is bundled.
                pdf_rect = rectangle * page.derotation_matrix * ~page.transformation_matrix
                regions.append({"rect":[round(v,2) for v in pdf_rect],
                                "selection":{"text":"\n".join(lines).strip(), "glyphs":glyphs}})
            return {"regions":regions}
