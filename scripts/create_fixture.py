"""Generate two vector research-PDF fixtures for reader integration tests."""
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor, black
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".runtime/fixtures"
OUT.mkdir(exist_ok=True)
sys.path[:0] = [str(ROOT / "backend")]
from fonts import FONT_DIR, NAMES, prepare_songti  # noqa: E402

prepare_songti()
pdfmetrics.registerFont(TTFont("FixtureChinese", str(FONT_DIR / NAMES["regular"])))


def text(c, value, box, chinese=False, size=10):
    x, top, width = box
    style = ParagraphStyle("body", fontName="FixtureChinese" if chinese else "Times-Roman",
                           fontSize=size, leading=size * 1.45, alignment=4)
    p = Paragraph(value, style)
    _, height = p.wrap(width, 700)
    p.drawOn(c, x, top - height)
    return top - height


def draw(chinese=False):
    path = OUT / ("translated-fixture.pdf" if chinese else "source-fixture.pdf")
    c = canvas.Canvas(str(path), pagesize=(612, 792))
    for page in range(1, 3):
        c.setTitle("PaperBridge research layout fixture")
        c.setFont("Helvetica", 8)
        c.setFillColor(HexColor("#72777f"))
        c.drawString(48, 763, "PAPERBRIDGE  /  READER INTEGRATION FIXTURE")
        c.setFillColor(black)
        title = "Layout-Preserving Translation for Scientific Documents" if not chinese else "保留科学文献排版结构的论文翻译"
        text(c, title, (55, 730, 502), chinese, 22)
        c.setFont("Times-Roman", 10)
        c.drawCentredString(306, 652, "PaperBridge Research  |  October 2026")
        c.setStrokeColor(HexColor("#9ba9b9"))
        c.setFillColor(HexColor("#edf4fc"))
        for x, label in [(58, "Source PDF"), (232, "Layout + DeepSeek"), (406, "Translated PDF")]:
            c.roundRect(x, 520, 148, 85, 5, fill=1)
            c.setFillColor(black)
            c.setFont("Helvetica", 12)
            c.drawCentredString(x + 74, 558, label)
            c.setFillColor(HexColor("#edf4fc"))
        c.setFillColor(black)
        c.setLineWidth(1.2)
        for x in [206, 380]:
            c.line(x + 2, 562, x + 23, 562)
            c.line(x + 19, 565, x + 23, 562)
            c.line(x + 19, 559, x + 23, 562)
        caption = "Figure 1. Text is translated while vector graphics and document geometry are preserved." if not chinese else "图 1. 翻译正文，同时保留矢量图形与文档几何结构。"
        text(c, caption, (50, 505, 512), chinese, 9)
        en = "Scientific papers combine natural language with mathematical notation, figures and tables. A useful translation must preserve the structure of the original document. This fixture checks that the original and translated PDFs remain readable side by side. Each page keeps its original dimensions, column boundaries and vector graphics."
        zh = "科学论文将自然语言与数学符号、图片和表格结合在一起。实用的翻译需要保留原始文档的结构。本样例检查原文与译文能否并排阅读。每一页都保持相同的页面尺寸、分栏边界以及矢量图形。此中文文件仅为阅读器测试样例，并非 DeepSeek 实译结果。"
        text(c, "<b>Abstract</b>  " + en if not chinese else "<b>摘要</b>  " + zh, (50, 465, 244), chinese, 10)
        text(c, "<b>1. Structure and preservation</b><br/>" + en if not chinese else "<b>1. 结构与保留</b><br/>" + zh, (318, 465, 244), chinese, 10)
        c.setFont("Times-Italic", 14)
        c.drawCentredString(172, 245, "E = mc")
        c.setFont("Times-Roman", 8)
        c.drawString(199, 252, "2")
        c.setFont("Times-Italic", 14)
        c.drawString(220, 245, "(1)")
        c.setFont("Times-Roman", 10)
        c.drawString(323, 263, "Table 1. Evaluation results")
        rows = [("Method", "Accuracy", "Pages"), ("Baseline", "91.2%", "17"), ("PaperBridge", "97.8%", "17")]
        for index, row in enumerate(rows):
            y = 243 - index * 22
            c.line(318, y + 15, 562, y + 15)
            for x, value in zip([323, 425, 507], row):
                c.drawString(x, y, value)
        c.line(318, 192, 562, 192)
        text(c, en if not chinese else zh, (50, 185, 244), chinese, 10)
        c.setFillColor(HexColor("#777777"))
        c.setFont("Helvetica", 8)
        c.drawCentredString(306, 35, str(page))
        c.showPage()
    c.save()
    print(path)


if __name__ == "__main__":
    draw()
    draw(True)
