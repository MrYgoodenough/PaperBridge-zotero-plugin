"""Prepare local Songti faces, correct implicit Symbol decoding, and subset only new PDF fonts."""
from pathlib import Path
import hashlib
import io
import os
import re
import subprocess
import sys
import unicodedata
import warnings

# Keep generated font faces in the project's or plugin's own cache.
ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = Path(os.environ.get("PAPERBRIDGE_CACHE_DIR",ROOT / ".cache")) / "fonts"
# The engine's FontMapper only accepts a font whose file name contains "serif" when the
# primary family is serif, and pairs bold text with a font whose header sets the bold bit.
NAMES = {"regular": "SongtiSerif-Regular.ttf", "bold": "SongtiSerif-Bold.ttf"}
# MuPDF reverse maps shared glyph IDs; these aliases must not replace ordinary copied text.
TEXT_ALIASES = {0x00A0: 0x0020, 0x00AD: 0x002D, 0x2011: 0x002D}
# CJK compatibility ideographs normalize to the unified characters used by translation text.
CJK_COMPATIBILITY_RANGES = ((0xF900, 0xFAFF), (0x2F800, 0x2FA1F))


def _normalize_cmap(font):
    """Remove same-glyph compatibility aliases so PDF ToUnicode keeps ordinary text searchable."""
    removed = 0
    for table in font["cmap"].tables:
        if not table.isUnicode():
            continue
        for code, glyph in list(table.cmap.items()):
            canonical = TEXT_ALIASES.get(code)
            if any(first <= code <= last for first, last in CJK_COMPATIBILITY_RANGES):
                normalized = unicodedata.normalize("NFKC", chr(code))
                canonical = ord(normalized) if len(normalized) == 1 else None
            if canonical is not None and canonical != code and table.cmap.get(canonical) == glyph:
                del table.cmap[code]
                removed += 1
    return removed


def _normalize_cached_font(path):
    """Repair an existing cache face atomically without modifying or redistributing its system source."""
    from fontTools.ttLib import TTFont, TTLibError

    temporary = path.with_suffix(".unicode.tmp")
    try:
        changed = False
        with TTFont(path) as font:
            if _normalize_cmap(font):
                font.save(temporary)
                changed = True
        # Windows cannot replace a font cache while its original handle is still open.
        if changed:
            temporary.replace(path)
    except (OSError, TTLibError) as error:
        # Keep readable existing fonts even if a cache copy cannot be normalized.
        warnings.warn(f"Cached font Unicode normalization was unavailable; copy/search may be affected: {error}")
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _bold(font):
    """Read the font's bold style flags."""
    head = font.get("head")
    os2 = font.get("OS/2")
    return bool((head and head.macStyle & 1) or (os2 and os2.fsSelection & 1 << 5))


def _mark_bold(font):
    """Mark an instantiated heavy face as bold for the engine mapper."""
    font["head"].macStyle |= 1
    if "OS/2" in font:
        font["OS/2"].fsSelection |= 1 << 5
    return font


def _from_collection(path, name=None):
    """Select the requested regional face from a font collection."""
    from fontTools.ttLib import TTCollection

    collection = TTCollection(path, lazy=True)
    for font in collection.fonts:
        if name is not None and font["name"].getDebugName(6) != name:
            continue
        return font, collection
    collection.close()
    raise LookupError(f"{path} 中未找到所需字面")


def _from_variable(path, weight):
    """Load a standalone face and instantiate variable weight if present."""
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    font = TTFont(path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight})
    return (_mark_bold(font) if weight >= 600 else font), None


def _macos_sources(bold):
    """Use the system Simplified Chinese Songti face."""
    return [("/System/Library/Fonts/Supplemental/Songti.ttc",
             "STSongti-SC-Bold" if bold else "STSongti-SC-Regular")]


def _windows_sources(bold):
    """Prefer Songti, then installed Chinese fallback faces."""
    fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    if bold:
        return [(fonts / "NotoSerifSC-VF.ttf", 700), (fonts / "msyhbd.ttc", "MicrosoftYaHei-Bold"),
                (fonts / "msyhbd.ttc", "MicrosoftYaHeiUI-Bold")]
    return [(fonts / "simsun.ttc", "SimSun"), (fonts / "STSONG.TTF", "STSong"),
            (fonts / "NotoSerifSC-VF.ttf", 400), (fonts / "msyh.ttc", "MicrosoftYaHei"),
            (fonts / "msyh.ttc", "MicrosoftYaHeiUI")]


def _linux_sources(bold):
    """Find installed Chinese serif fonts through distribution-neutral fontconfig."""
    sources = []
    style = "Bold" if bold else "Regular"
    for family in ("Noto Serif CJK SC", "Source Han Serif SC", "Noto Serif SC", "AR PL UMing CN"):
        try:
            result = subprocess.run(
                ["fc-match", "-f", "%{file}\n%{postscriptname}\n%{family}\n", f"{family}:style={style}"],
                capture_output=True, text=True, check=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        lines = result.stdout.splitlines()
        # fontconfig silently substitutes unrelated fonts when a family is missing.
        if len(lines) < 3 or family.lower() not in lines[2].lower():
            continue
        path, name = lines[:2]
        sources.append((path, name) if Path(path).suffix.lower() in {".ttc", ".otc"}
                       else (path, 700 if bold else 400))
    return sources


def _sources(bold):
    """Select installed fonts for the current operating system."""
    if sys.platform == "win32":
        return _windows_sources(bold)
    if sys.platform == "linux":
        return _linux_sources(bold)
    return _macos_sources(bold)


def _load(source):
    """Return (font, owner) for a (path, name) or (path, weight) candidate."""
    path, *options = source
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    if options and isinstance(options[0], int):
        return _from_variable(path, options[0])
    if path.suffix.lower() in {".ttc", ".otc"}:
        return _from_collection(path, options[0] if options else None)
    return _from_variable(path, 400)


def _save(font, target, owner):
    """Export one face and release the source collection or font."""
    try:
        _normalize_cmap(font)
        font.save(target)
    finally:
        if owner is not None:
            owner.close()
        else:
            font.close()


def prepare_songti():
    """Extract installed Chinese serif faces without redistributing system fonts."""
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    regular, bold = FONT_DIR / NAMES["regular"], FONT_DIR / NAMES["bold"]
    errors = []
    for kind, target in (("regular", regular), ("bold", bold)):
        if target.exists():
            _normalize_cached_font(target)
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
                hint = "Linux 可安装 fonts-noto-cjk 或同类思源宋体字体包。" if sys.platform == "linux" else ""
                raise RuntimeError("未找到可用的宋体。" + hint + "请将合法的宋体 TTF 放入 "
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
        """Route Chinese text to the locally extracted serif faces."""
        if language.lower().startswith("zh"):
            return {"normal": names, "script": [], "fallback": names, "base": [names[0]]}
        return original_family(language)

    def metadata(name):
        """Return metrics for a local face or delegate other font requests."""
        if name not in names:
            return original_metadata(name)
        path = FONT_DIR / name
        with TTFont(path, lazy=True) as font:
            scale = 1000 / font["head"].unitsPerEm
            return path, {"ascent": round(font["hhea"].ascent * scale),
                          "descent": round(font["hhea"].descent * scale), "encoding_length": 2}

    assets.get_font_family = family
    assets.get_font_and_metadata = metadata


def normalize_symbol_encoding(document):
    """Make implicit base-14 Symbol encoding explicit in a working copy for the pinned parser."""
    import pymupdf
    from fontTools.cffLib import CFFFontSet

    xrefs = {font[0] for page in document for font in page.get_fonts(full=True)
             if font[1] == "n/a" and font[2] == "Type1" and font[3] == "Symbol"
             and document.xref_get_key(font[0], "Encoding")[0] == "null"
             and document.xref_get_key(font[0], "ToUnicode")[0] == "null"}
    if not xrefs:
        return 0
    # The parser assumes StandardEncoding here: Lambda becomes ASCII L with zero advance.
    # MuPDF's bundled Symbol face provides the PDF standard's built-in glyph encoding.
    collection = CFFFontSet()
    collection.decompile(io.BytesIO(pymupdf.Font("symb").buffer), None)
    encoding = collection[collection.fontNames[0]].Encoding
    differences = []
    previous = None
    for code, glyph in enumerate(encoding):
        if glyph == ".notdef":
            continue
        if previous is None or code != previous + 1:
            differences.append(str(code))
        differences.append("/" + glyph)
        previous = code
    value = "<</Type/Encoding/Differences[" + " ".join(differences) + "]>>"
    for xref in xrefs:
        document.xref_set_key(xref, "Encoding", value)
    return len(xrefs)


def _font_objects(document, font_xref):
    """Locate the pinned mapper's indirect CID font descriptor and embedded program."""
    kind, value = document.xref_get_key(font_xref, "DescendantFonts")
    descendants = re.findall(r"\b(\d+)\s+0\s+R\b", value) if kind == "array" else []
    if len(descendants) != 1:
        return None
    descendant = int(descendants[0])
    kind, value = document.xref_get_key(descendant, "FontDescriptor")
    if kind != "xref":
        return None
    descriptor = int(value.split()[0])
    for key in ("FontFile2", "FontFile3"):
        kind, value = document.xref_get_key(descriptor, key)
        if kind == "xref":
            return descendant, descriptor, int(value.split()[0])
    return None


def _subset_pdf_name(prefix, name):
    """Encode a deterministic subset name without changing the font's PDF encoding."""
    value = prefix + "+" + name
    return "/" + "".join(chr(byte) if 33 <= byte <= 126 and chr(byte) not in "#%()/<>[]{}"
                         else f"#{byte:02X}" for byte in value.encode("utf-8"))


def subset_songti(document, source):
    """Shrink only locally embedded Songti programs; preserve source fonts and all encoding tables."""
    import pymupdf

    cached = {hashlib.sha256(path.read_bytes()).digest()
              for name in NAMES.values() if (path := FONT_DIR / name).is_file()}
    if not cached:
        return 0
    # A source may itself use our full face; never shrink a publisher-owned shared program.
    source_fonts = {font[0] for page in source for font in page.get_fonts(full=True) if font[1] in {"ttf", "otf"}}
    original = {hashlib.sha256(source.extract_font(xref)[-1]).digest() for xref in source_fonts}
    programs = {}
    seen = set()
    for page in document:
        for font in page.get_fonts(full=True):
            xref, extension, kind, basename, resource, encoding = font[:6]
            if xref in seen or resource not in NAMES.values() or kind != "Type0" or encoding != "Identity-H":
                continue
            seen.add(xref)
            if extension not in {"ttf", "otf"} or not (objects := _font_objects(document, xref)):
                continue
            buffer = document.extract_font(xref)[-1]
            digest = hashlib.sha256(buffer).digest()
            if digest not in cached or digest in original:
                continue
            program = programs.setdefault(digest, {"buffer": buffer, "names": set(), "objects": [],
                                                   "gids": set(), "unicodes": set()})
            program["objects"].append((xref, *objects))
            program["names"].update((basename, pymupdf.Font(fontbuffer=buffer).name,
                                     document.xref_get_key(objects[0], "BaseFont")[1][1:]))
    if not programs:
        return 0
    from fontTools import subset
    from fontTools.ttLib import TTFont

    for page in document:
        for span in page.get_texttrace():
            for program in programs.values():
                if span["font"] not in program["names"]:
                    continue
                for unicode, glyph, *_ in span["chars"]:
                    program["gids"].add(glyph)
                    program["unicodes"].add(unicode)
    saved = 0
    for program in programs.values():
        if not program["gids"]:
            continue
        try:
            options = subset.Options()
            # PDF content uses existing glyph IDs, not the subsetter's compacted numbering.
            options.retain_gids = True
            options.layout_features = ["*"]
            options.passthrough_tables = True
            options.ignore_missing_glyphs = True
            options.ignore_missing_unicodes = True
            options.symbol_cmap = True
            with TTFont(io.BytesIO(program["buffer"]), recalcTimestamp=False) as font:
                subsetter = subset.Subsetter(options=options)
                subsetter.populate(gids=program["gids"], unicodes=program["unicodes"])
                subsetter.subset(font)
                output = io.BytesIO()
                font.save(output)
            buffer = output.getvalue()
        except Exception as error:
            # Shrinking is optional: retain a readable larger PDF when a local face is unsupported.
            warnings.warn(f"Songti font subsetting was unavailable; original font retained: {error}")
            continue
        if len(buffer) >= len(program["buffer"]):
            continue
        # Six alphabetic characters are the PDF subset prefix; stable bytes give stable names.
        prefix = "".join(chr(ord("A") + byte % 26) for byte in hashlib.sha256(buffer).digest()[:6])
        streams = set()
        for font, descendant, descriptor, stream in program["objects"]:
            if stream not in streams:
                document.update_stream(stream, buffer)
                document.xref_set_key(stream, "Length1", str(len(buffer)))
                streams.add(stream)
            for xref, key in ((font, "BaseFont"), (descendant, "BaseFont"), (descriptor, "FontName")):
                kind, name = document.xref_get_key(xref, key)
                if kind == "name":
                    document.xref_set_key(xref, key, _subset_pdf_name(prefix, name[1:]))
        saved += (len(program["buffer"]) - len(buffer)) * len(streams)
    return saved


if __name__ == "__main__":
    prepare_songti()
    print(f"宋体已准备：{FONT_DIR}")
