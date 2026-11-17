"""Find display equations locally with the model already shipped in the XPI."""
import os
import threading
from pathlib import Path

# Reuse the layout model already bundled for BabelDOC 0.6.4.
MODEL_RELATIVE_PATH = Path("babeldoc/models/doclayout_yolo_docstructbench_imgsz1024.onnx")
# Limit raster resolution while retaining small equation glyphs.
MAX_RENDER_SCALE = 1.5
# Cap the longest rendered page edge in pixels.
MAX_RENDER_PIXELS = 1600
# Preserve glyphs at the detected region's boundary, in page points.
REGION_PADDING_POINTS = 2
# Keep the existing PDF coordinate serialization precision.
PDF_COORDINATE_DIGITS = 2
# Accept the equation class names used by compatible bundled layout models.
FORMULA_CLASSES = {"isolate_formula", "isolated_formula", "formula"}
# Publish only a fully initialized model; failed loads remain retriable.
_MODEL = None
# Serialize lazy initialization and occasional page-local inference.
_LOCK = threading.Lock()


def detect(request):
    """Detect local equation regions and expose readable dependency/inference errors."""
    try:
        return _detect(request)
    except (ValueError, OSError):
        raise
    except Exception as error:
        raise ValueError("本地长公式识别失败：" + str(error)) from None


def _detect(request):
    """Render one PDF page and return selected glyphs in original PDF user space."""
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
            model_path = cache / MODEL_RELATIVE_PATH
            if not model_path.exists():
                raise ValueError("内置公式区域识别模型缺失，请重新安装 XPI")
            # Detection is occasional and page-local. CPU avoids CoreML compilation
            # and its filesystem side effects in a long-lived reader service.
            import ast
            import onnxruntime
            onnxruntime.disable_telemetry_events()
            model = OnnxModel.__new__(OnnxModel)
            model.model = onnxruntime.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
            metadata = model.model.get_modelmeta().custom_metadata_map
            model._stride = ast.literal_eval(metadata["stride"])
            model._names = ast.literal_eval(metadata["names"])
            model.lock = threading.Lock()
            _MODEL = model
        with pymupdf.open(path) as document:
            if index >= len(document):
                raise ValueError("PDF 页码超出范围")
            page = document[index]
            # Rotated PyMuPDF transforms omit CropBox/MediaBox offsets. Read the
            # unrotated transform in memory, then restore rotation before rendering.
            rotation = page.rotation
            page.set_rotation(0)
            try:
                page_to_pdf = ~page.transformation_matrix
            finally:
                page.set_rotation(rotation)
            import numpy as np
            scale = min(MAX_RENDER_SCALE, MAX_RENDER_PIXELS / max(page.rect.width, page.rect.height))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False, colorspace=pymupdf.csRGB)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)[:, :, ::-1]
            layout = _MODEL.predict(image)[0]
            sx, sy = page.rect.width / pix.width, page.rect.height / pix.height
            regions = []
            for box in layout.boxes:
                if layout.names[int(box.cls)] not in FORMULA_CLASSES:
                    continue
                x1, y1, x2, y2 = [float(n) for n in box.xyxy]
                rectangle = (pymupdf.Rect(x1*sx-REGION_PADDING_POINTS, y1*sy-REGION_PADDING_POINTS,
                                         x2*sx+REGION_PADDING_POINTS, y2*sy+REGION_PADDING_POINTS) & page.rect)
                glyphs, lines = [], []
                for block in page.get_text("rawdict", clip=rectangle * page.derotation_matrix)["blocks"]:
                    for line in block.get("lines", []):
                        text = ""
                        for span in line["spans"]:
                            for char in span["chars"]:
                                text += char["c"]
                                # PyMuPDF uses unrotated top-down page coordinates.
                                r = pymupdf.Rect(char["bbox"]) * page_to_pdf
                                glyphs.append({"c": char["c"],
                                               "rect": [round(v, PDF_COORDINATE_DIGITS) for v in r],
                                               "page": index})
                        lines.append(text)
                if not glyphs:
                    continue  # No image-to-LaTeX OCR is bundled.
                pdf_rect = rectangle * page.derotation_matrix * page_to_pdf
                regions.append({"rect": [round(v, PDF_COORDINATE_DIGITS) for v in pdf_rect],
                                "selection": {"text": "\n".join(lines).strip(), "glyphs": glyphs}})
            return {"regions":regions}
