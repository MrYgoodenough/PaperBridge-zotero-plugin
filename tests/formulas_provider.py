"""Opt-in real provider smoke test, with two public-paper formulas and one fraction."""
import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from formulas import convert


def main():
    env = (ROOT / ".env").read_text()
    match = re.search(r"^(?:DEEPSEEK_API_KEY|key)\s*=\s*(.+)$", env, re.M)
    if not match:
        raise RuntimeError("Missing test provider key")
    key = match[1].strip().strip("\"'")
    cases = []
    with pymupdf.open(ROOT / ".cache/references/pi0-v3.pdf") as document:
        page = document[4]
        for block in page.get_text("rawdict")["blocks"]:
            if not (260 < block["bbox"][1] < 275 or 510 < block["bbox"][1] < 525):
                continue
            glyphs = [{"c": c["c"], "rect": [round(c["bbox"][0], 2), round(page.rect.height - c["bbox"][3], 2),
                       round(c["bbox"][2], 2), round(page.rect.height - c["bbox"][1], 2)], "page": 4}
                      for line in block["lines"] for span in line["spans"] for c in span["chars"]]
            cases.append({"text": "".join(c["c"] for c in glyphs), "glyphs": glyphs})
    # PDF coordinates explicitly distinguish superscripts, subscripts and a stacked fraction.
    cases.append({"text": "x2+yi=12", "glyphs": [
        {"c": c, "rect": r} for c, r in [
            ("x", [0, 10, 6, 20]), ("2", [6, 17, 10, 23]), ("+", [12, 10, 18, 20]),
            ("y", [20, 10, 26, 20]), ("i", [26, 7, 29, 13]), ("=", [31, 10, 37, 20]),
            ("1", [42, 17, 48, 27]), ("2", [42, 3, 48, 13])]]})
    report = {"model": "deepseek-flash", "api_requests": 0, "cases": []}
    for case in cases:
        report["api_requests"] += 1
        try:
            result = convert({**case, "api_key": key})
        except ValueError as error:
            report["error"] = str(error).replace(key, "[REDACTED]")
            break
        report["cases"].append({"input": case["text"], "latex": result["latex"], "glyphs": len(case["glyphs"])})
    last = report["cases"][-1]["latex"].replace(" ", "") if report["cases"] else ""
    report["fractionAndScripts"] = all(token in last for token in ["^", "_", r"\frac{1}{2}"])
    report["ok"] = report["fractionAndScripts"] and len(report["cases"]) == 3
    (ROOT / "docs/formulas-0.4.1-provider.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
