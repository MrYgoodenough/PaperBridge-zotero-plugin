"""Use the user's installed Songti-style fonts; never distribute system font files."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR",ROOT / ".cache")) / "fonts"
# The engine's FontMapper only accepts a font whose file name contains "serif" when the
# primary family is serif, and pairs bold text with a font whose header sets the bold bit.
NAMES = {"regular": "SongtiSerif-Regular.ttf", "bold": "SongtiSerif-Bold.ttf"}


def _bold(font):
    head = font.get("head")
    os2 = font.get("OS/2")
    return bool((head and head.macStyle & 1) or (os2 and os2.fsSelection & 1 << 5))


def _mark_bold(font):
    font["head"].macStyle |= 1
    if "OS/2" in font:
        font["OS/2"].fsSelection |= 1 << 5
    return font


def _from_collection(path, name=None):
    from fontTools.ttLib import TTCollection

    collection = TTCollection(path, lazy=True)
    for font in collection.fonts:
        if name is not None and font["name"].getDebugName(6) != name:
            continue
        return font, collection
    collection.close()
    raise LookupError(f"{path} 中未找到所需字面")


def _from_variable(path, weight):
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    font = TTFont(path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight})
    return (_mark_bold(font) if weight >= 600 else font), None


def _macos_sources(bold):
    return [("/System/Library/Fonts/Supplemental/Songti.ttc",
             "STSongti-SC-Bold" if bold else "STSongti-SC-Regular")]


def _windows_sources(bold):
    fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    if bold:
        return [(fonts / "NotoSerifSC-VF.ttf", 700), (fonts / "msyhbd.ttc", "MicrosoftYaHei-Bold"),
                (fonts / "msyhbd.ttc", "MicrosoftYaHeiUI-Bold")]
    return [(fonts / "simsun.ttc", "SimSun"), (fonts / "STSONG.TTF", "STSong"),
            (fonts / "NotoSerifSC-VF.ttf", 400), (fonts / "msyh.ttc", "MicrosoftYaHei"),
            (fonts / "msyh.ttc", "MicrosoftYaHeiUI")]


def _sources(bold):
    return _windows_sources(bold) if sys.platform == "win32" else _macos_sources(bold)


def _load(source):
    """Return (font, owner) for a (path, name) or (path, weight) candidate."""
    path, *options = source
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    if options and isinstance(options[0], int):
        return _from_variable(path, options[0])
    return _from_collection(path, options[0] if options else None)


def _save(font, target, owner):
    font.save(target)
    if owner is not None:
        owner.close()


def prepare_songti():
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    regular, bold = FONT_DIR / NAMES["regular"], FONT_DIR / NAMES["bold"]
    if regular.exists() and bold.exists():
        return
    errors = []
    for kind, target in (("regular", regular), ("bold", bold)):
        if target.exists():
            continue
        for source in _sources(kind == "bold"):
            try:
                font, owner = _load(source)
            except (OSError, LookupError, ImportError) as error:
                errors.append(f"{source[0]}: {error}")
                continue
            _save(font, target, owner)
            break
        else:
            if kind == "regular":
                raise RuntimeError("未找到可用的宋体。请将合法的宋体 TTF 放入 "
                                   f"{FONT_DIR}，命名为 {NAMES['regular']} 和 {NAMES['bold']}。\n" + "\n".join(errors))
            # A serif bold face is optional: bold runs then use the regular face.
            target.unlink(missing_ok=True)


def install_songti(assets):
    """Override the pinned engine's font resolver before its FontMapper is created."""
    from fontTools.ttLib import TTFont

    prepare_songti()
    original_family = assets.get_font_family
    original_metadata = assets.get_font_and_metadata
    names = [name for name in [NAMES["regular"], NAMES["bold"]] if (FONT_DIR / name).exists()]

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
