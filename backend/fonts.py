"""Use the user's installed Songti fonts; never distribute system font files."""
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR",ROOT / ".cache")) / "fonts"


def prepare_songti():
    from fontTools.ttLib import TTCollection

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    regular = FONT_DIR / "SongtiSerif-Regular.ttf"
    bold = FONT_DIR / "SongtiSerif-Bold.ttf"
    if regular.exists() and bold.exists():
        return
    source = Path("/System/Library/Fonts/Supplemental/Songti.ttc")
    if not source.exists():
        raise RuntimeError("未找到系统宋体。请将合法的宋体 TTF 放入 .cache/fonts，命名为 SongtiSerif-Regular.ttf 和 SongtiSerif-Bold.ttf。")
    collection = TTCollection(source, lazy=True)
    by_name = {font["name"].getDebugName(6): font for font in collection.fonts}
    by_name["STSongti-SC-Regular"].save(regular)
    by_name["STSongti-SC-Bold"].save(bold)
    collection.close()


def install_songti(assets):
    """Override the pinned engine's font resolver before its FontMapper is created."""
    from fontTools.ttLib import TTFont

    prepare_songti()
    original_family = assets.get_font_family
    original_metadata = assets.get_font_and_metadata
    names = ["SongtiSerif-Regular.ttf", "SongtiSerif-Bold.ttf"]

    def family(language):
        if language.lower().startswith("zh"):
            return {"normal": names, "script": [], "fallback": names, "base": [names[0]]}
        return original_family(language)

    def metadata(name):
        if name not in names:
            return original_metadata(name)
        path = FONT_DIR / name
        with TTFont(path, lazy=True) as font:
            scale = 1000 / font["head"].unitsPerEm
            return path, {"ascent": round(font["hhea"].ascent * scale),
                          "descent": round(font["hhea"].descent * scale), "encoding_length": 2}

    assets.get_font_family = family
    assets.get_font_and_metadata = metadata


if __name__ == "__main__":
    prepare_songti()
    print(f"宋体已准备：{FONT_DIR}")
