"""Create synthetic two-page hover geometry evidence, never provider/quality evidence.

Keep the production trace unchanged; separately validate disjoint glyph rectangles.
All PDFs, mappings, PNGs and checks belong to a new isolated output directory.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pymupdf
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

# Resolve backend imports without creating bytecode in production directories.
ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "backend"))
from alignment import _page_space, build_mapping, load_mapping, write_mapping  # noqa: E402
from babeldoc.format.pdf.document_il import il_version_1 as il  # noqa: E402
from fragment_trace import FragmentTrace  # noqa: E402
from usage import ResultQuality  # noqa: E402

# Limit default output to this task's isolated fixture directory.
DEFAULT_OUTPUT = ROOT / "agent/codex/nonmac-finish-20261114-201038/geometry"
# Standard PDF points keep the native reader fixture free of crop/rotation ambiguity.
PAGE_SIZE = (612, 792)
# Standard PDF base-font Latin text avoids font preparation or plugin caches.
BODY_FONT = "Helvetica"
# Small research-layout text remains comfortably readable at normal native zoom.
BODY_SIZE = 11
# PNG evidence is rendered independently by Poppler when available.
RENDER_DPI = 120


def specifications():
    """Define manual English/Spanish text and independently painted request islands."""
    return [
        {"name": "two-column-request", "case": "stable",
         "source": [(0, 48, 610, "Request A starts in the left column. "),
                    (0, 326, 535, "The same request ends on the right. ")],
         "target": [(0, 50, 596, "La solicitud A inicia a la izquierda. "),
                    (0, 328, 525, "La misma solicitud acaba a la derecha. ")]},
        {"name": "second-page-request", "case": "stable",
         "source": [(1, 64, 590, "Request B stays on the second page. ")],
         "target": [(1, 316, 558, "La solicitud B sigue en la segunda pagina. ")]},
        {"name": "cross-page-request", "case": "cross_page",
         "source": [(0, 48, 310, "One request begins on page one; "),
                    (1, 48, 700, "it really continues on page two. ")],
         "target": [(0, 326, 292, "Una solicitud empieza en la pagina uno; "),
                    (1, 326, 682, "continua en la pagina dos. ")]},
        {"name": "moved-request", "case": "moved",
         "source": [(0, 326, 235, "This request originally belongs to page one. ")],
         "target": [(1, 64, 380, "Esta solicitud se movio a la pagina dos. ")]},
        {"name": "merge-c-request", "case": "merged",
         "source": [(0, 48, 176, "Merge C is one independent request. ")],
         "target": [(0, 48, 152, "C y D se combinan despues del diseno. ")]},
        {"name": "merge-d-request", "case": "merged",
         "source": [(0, 48, 112, "Merge D is another independent request. ")],
         "target": [(0, 48, 134, "Las identidades originales ya no existen. ")]},
    ]


def write_pdf(path, units, side):
    """Paint actual selectable PDF text; the target is a manual synthetic translation."""
    document = canvas.Canvas(str(path), pagesize=PAGE_SIZE, invariant=1, pageCompression=1)
    document.setTitle(f"PaperBridge GEOMETRY TEST - {side}")
    document.setAuthor("PaperBridge synthetic geometry fixture")
    document.setSubject("Manual fixture; not a real paper, provider result, or quality benchmark")
    for number in range(2):
        document.setFont("Helvetica-Bold", 13)
        document.drawString(48, 755, f"GEOMETRY TEST / {side.upper()} / PAGE {number + 1}")
        document.setFont("Helvetica", 8)
        document.drawString(48, 738, "Synthetic manual EN/ES fixture. No provider, network or production translation.")
        document.setStrokeColorRGB(0.75, 0.79, 0.84)
        document.line(306, 90, 306, 720)
        document.setFont("Helvetica-Bold", 9)
        document.drawString(48, 648, "STABLE A: ONE REQUEST / TWO ISLANDS" if number == 0
                            else "STABLE B: SECOND-PAGE REQUEST")
        document.drawString(48, 348 if number == 0 else 420,
                            "EXCLUDED REQUESTS: CROSS-PAGE / MOVED / MERGED")
        document.setFont(BODY_FONT, BODY_SIZE)
        for unit in units:
            for page, x, y, text in unit[side]:
                if page == number:
                    assert pdfmetrics.stringWidth(text, BODY_FONT, BODY_SIZE) < PAGE_SIZE[0] - x - 35
                    document.drawString(x, y, text)
        document.setFont("Helvetica", 8)
        document.drawString(48, 44, "Only stable same-page identities map. This is not a linguistic acceptance sample.")
        document.showPage()
    document.save()


def union(characters):
    """Use the extents of real extracted glyphs, not estimated authoring coordinates."""
    rectangle = pymupdf.Rect()
    for _, box in characters:
        rectangle |= pymupdf.Rect(box)
    return list(rectangle)


def extract(path, units, side):
    """Read exact authored literal lines and unrotated PDF-user glyph boxes."""
    result = {}
    with pymupdf.open(path) as document:
        assert document.page_count == 2
        lines = {}
        for page in document:
            matrix, bounds = _page_space(page, {})
            for block in page.get_text("rawdict", clip=bounds)["blocks"]:
                for line in block.get("lines", []):
                    raw = [char for span in line["spans"] for char in span["chars"]]
                    text = "".join(char["c"] for char in raw)
                    lines[(page.number, text)] = [(char["c"], list(pymupdf.Rect(char["bbox"]) * ~matrix))
                                                   for char in raw]
        for unit in units:
            islands = []
            for page, _, _, text in unit[side]:
                characters = lines[(page, text)]
                assert characters[-1][0] == " "  # Preserve a real space between composed islands.
                islands.append({"page": page, "characters": characters, "rect": union(characters)})
            result[unit["name"]] = islands
    return result


def il_box(rectangle):
    """Populate the pinned engine's own IL geometry type."""
    return il.Box(**dict(zip(("x", "y", "x2", "y2"), rectangle)))


def characters(islands):
    """Retain the same order as one independently applied request, including spaces."""
    return [character for island in islands for character in island["characters"]]


def composition(islands):
    """Build final character composition from actual target PDF glyphs, not guessed text."""
    return [il.PdfParagraphComposition(pdf_character=il.PdfCharacter(
        char_unicode=text, box=il_box(box), visual_bbox=il.VisualBbox(box=il_box(box))))
        for text, box in characters(islands)]


def location(islands):
    """Expose actual glyph rectangles only for a stable single-page request."""
    assert len({island["page"] for island in islands}) == 1
    return {"page": islands[0]["page"], "rects": [island["rect"] for island in islands]}


def points(islands):
    """Provide native-hover centers of real non-whitespace glyphs in each island."""
    result = []
    for index, island in enumerate(islands):
        text, box = next(character for character in island["characters"][2:] if not character[0].isspace())
        x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        result.append({"page": island["page"], "page_number": island["page"] + 1,
                       "island": index, "character": text, "pdf_user": [x, y],
                       "unrotated_top_left": [x, PAGE_SIZE[1] - y]})
    return result


def render(directory, source, target, poppler):
    """Render all four actual PDF pages without a reader or a daily Zotero profile."""
    warnings = []
    for side, path in (("source", source), ("translated", target)):
        with pymupdf.open(path) as document:
            for number in range(2):
                base = directory / f"{side}-page-{number + 1}"
                if poppler:
                    result = subprocess.run([poppler, "-png", "-r", str(RENDER_DPI), "-singlefile",
                                             "-f", str(number + 1), "-l", str(number + 1), str(path), str(base)],
                                            check=True, text=True, capture_output=True)
                    if result.stderr.strip():
                        warnings.append(result.stderr.strip())
                else:
                    document[number].get_pixmap(dpi=RENDER_DPI).save(base.with_suffix(".png"))
    if warnings:
        (directory / "render-warnings.txt").write_text("\n".join(warnings) + "\n", encoding="utf-8")
    return {"name": "poppler" if poppler else "pymupdf", "executable": poppler,
            "dpi": RENDER_DPI, "warnings": len(warnings)}


def frontend_check(directory, manifest, node):
    """Exercise the shipped hitTest for every island, excluded point and gutter."""
    program = r"""
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const [source, mappingPath] = process.argv.slice(1), ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(source, 'utf8'), ctx);
const controller = ctx.FragmentAlignment, mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(0, 'utf8'));
assert(controller.checkMapping(mapping).mapping);
let positive = 0, negative = 0;
for (const unit of manifest.included) for (const side of ['source', 'target']) {
  for (const point of unit[side].hover_points) {
    const hit = controller.hitTest(mapping, point.page, point.pdf_user, side, true);
    assert.equal(hit.status, 'unique'); assert.equal(hit.unit.id, unit.id);
    assert.equal(hit.unit, mapping.units.find(candidate => candidate.id === unit.id));
    assert.equal(hit.unit.source.rects.length, unit.source.rects.length);
    assert.equal(hit.unit.target.rects.length, unit.target.rects.length); positive++;
  }
}
for (const unit of manifest.excluded) for (const side of ['source', 'target']) {
  for (const point of unit[side].hover_points) {
    assert.equal(controller.hitTest(mapping, point.page, point.pdf_user, side, true).status, 'miss'); negative++;
  }
}
for (const point of manifest.gutter_points) {
  assert.equal(controller.hitTest(mapping, point.page, point.pdf_user, point.side, true).status, 'miss'); negative++;
}
console.log(JSON.stringify({passed: true, positive_points: positive, negative_points: negative}));
"""
    result = subprocess.run([node, "-e", program, str(ROOT / "addon/content/alignment.js"),
                             str(directory / "alignment.json")], input=json.dumps(manifest),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def generate(directory, node, poppler):
    """Capture real IL identities, simulate final application, and validate both maps."""
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise FileExistsError("Use an empty isolated output directory; existing PDFs/cache are never overwritten")
    units = specifications()
    source, target = directory / "source.pdf", directory / "translated.pdf"
    write_pdf(source, units, "source")
    write_pdf(target, units, "target")
    before, after = extract(source, units, "source"), extract(target, units, "target")
    pages = [il.Page(page_number=number, cropbox=il.Cropbox(box=il_box([0, 0, *PAGE_SIZE])))
             for number in range(2)]
    docs, refs = il.Document(page=pages), {}
    quality = ResultQuality(directory / "quality.json")
    for unit in units:
        islands = before[unit["name"]]
        paragraph = il.PdfParagraph(unicode="".join(text for text, _ in characters(islands)),
                                    box=il_box(union(characters([islands[0]]))), vertical=False, xobj_id=0)
        if unit["case"] == "stable":
            paragraph.box = il_box(union(characters(islands)))
        refs[unit["name"]] = paragraph
        for number in sorted({island["page"] for island in islands}):
            pages[number].pdf_paragraph.append(paragraph)
        quality.register(id(paragraph), paragraph.unicode, islands[0]["page"] + 1)
    trace = FragmentTrace(source)
    trace.inventory(docs)
    captured = {name: trace.rows[id(paragraph)] for name, paragraph in refs.items()}
    assert captured["cross-page-request"] is None
    for unit in units:
        paragraph = refs[unit["name"]]
        paragraph.pdf_paragraph_composition = composition(after[unit["name"]])
        paragraph.unicode = "".join(text for text, _ in characters(after[unit["name"]]))
        quality.record(id(paragraph), "validated")
        quality.record(id(paragraph), "success")
    moved = refs["moved-request"]
    pages[0].pdf_paragraph.remove(moved)
    pages[1].pdf_paragraph.append(moved)
    merged_names = ["merge-c-request", "merge-d-request"]
    for name in merged_names:
        pages[0].pdf_paragraph.remove(refs[name])
    # A real new IL identity replaces both original requests, as final merging can do.
    merged_islands = [island for name in merged_names for island in after[name]]
    pages[0].pdf_paragraph.append(il.PdfParagraph(
        unicode="".join(text for text, _ in characters(merged_islands)),
        box=il_box(union(characters(merged_islands))), vertical=False, xobj_id=0,
        pdf_paragraph_composition=composition(merged_islands)))
    original_hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (source, target)]
    production = trace.write(target, directory / "alignment-production.json", quality)
    assert production is not None and [unit["id"] for unit in production["units"]] == ["p0-u0", "p1-u0"]
    assert dict(trace.excluded) == {"duplicate_identity": 1, "moved_or_merged": 3}
    assert all(row["applied"] and row["attempts"] == 0 for row in quality.paragraphs.values())
    candidates, included, excluded = [], [], []
    for unit in units:
        name = unit["name"]
        evidence = {"name": name, "applied": quality.paragraphs[id(refs[name])]["applied"],
                    "final_same_identity_pages": [page.page_number for page in pages
                                                  if any(item is refs[name] for item in page.pdf_paragraph)]}
        for side, glyphs in (("source", before[name]), ("target", after[name])):
            evidence[side] = {"pages": sorted({island["page"] for island in glyphs}),
                              "hover_points": points(glyphs)}
        if unit["case"] == "stable":
            row = captured[name]
            candidate = {"id": row["id"], "applied": evidence["applied"],
                         "source": location(before[name]), "target": location(after[name]),
                         "source_text": row["source_text"], "target_text": refs[name].unicode}
            candidates.append(candidate)
            assert row["id"] in {verified["id"] for verified in production["units"]}
            evidence["id"] = row["id"]
            for side in ("source", "target"):
                evidence[side].update(candidate[side])
            included.append(evidence)
        else:
            evidence["reason"] = "duplicate_identity" if unit["case"] == "cross_page" else "moved_or_merged"
            evidence["case"] = unit["case"]
            evidence["captured_id"] = captured[name]["id"] if captured[name] else None
            excluded.append(evidence)
    # Fixture-only decomposition: the unchanged production trace currently emits one bounding rect.
    mapping = build_mapping(source, target, candidates)
    assert [unit["id"] for unit in mapping["units"]] == ["p0-u0", "p1-u0"]
    assert mapping["metadata"]["excluded_count"] == 0
    for side in ("source", "target"):
        rectangles = mapping["units"][0][side]["rects"]
        assert len(rectangles) == 2 and not pymupdf.Rect(rectangles[0]).intersects(pymupdf.Rect(rectangles[1]))
    write_mapping(directory / "alignment.json", mapping)
    for name in ("alignment.json", "alignment-production.json"):
        assert load_mapping(directory / name, source, target)["available"]
    assert original_hashes == [hashlib.sha256(path.read_bytes()).hexdigest() for path in (source, target)]
    manifest = {"schema_version": 1, "fixture_kind": "geometry-test", "real_paper": False,
                "provider_requests": 0, "network_requests": 0, "languages": {"source": "en", "target": "es"},
                "application_basis": "Synthetic local IL mutation; ResultQuality uses the same paragraph identity",
                "adapters": {"trace": "fragment_trace.FragmentTrace", "quality": "usage.ResultQuality",
                             "il": "babeldoc.format.pdf.document_il.il_version_1",
                             "sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                        for path in (Path(__file__), ROOT / "backend/fragment_trace.py",
                                                     ROOT / "backend/alignment.py", ROOT / "backend/usage.py",
                                                     ROOT / "addon/content/alignment.js")}},
                "files": {"source": "source.pdf", "target": "translated.pdf",
                          "native_geometry_mapping": "alignment.json", "production_mapping": "alignment-production.json"},
                "mapping_boundary": "Production FragmentTrace emits one bounding rect per side. The fixture-only "
                                    "disjoint glyph adapter retains only its verified IDs and calls build_mapping/write_mapping.",
                "page_indexing": "page/pages: zero-based; page_number: one-based", "page_size_points": PAGE_SIZE,
                "included": included, "excluded": excluded, "production_exclusion_reasons": dict(trace.excluded),
                "production_metadata": production["metadata"], "geometry_metadata": mapping["metadata"],
                "gutter_points": [{"page": 0, "side": side, "pdf_user": [306, 560]} for side in ("source", "target")],
                "checks": {"backend_trace_and_literal_pdf_validation": {"passed": True, "included": 2, "excluded": 4}}}
    manifest["checks"]["shipped_frontend_whole_unit_hit_test"] = frontend_check(directory, manifest, node)
    manifest["renderer"] = render(directory, source, target, poppler)
    manifest["sha256"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in sorted(directory.iterdir()) if path.is_file()}
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    """Require existing dependencies and leave any other agent's files untouched."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--poppler", default=shutil.which("pdftoppm"), help="Existing pdftoppm executable; no installation")
    args = parser.parse_args()
    if not args.node:
        parser.error("Existing Node is required for the shipped frontend hit test; no dependency is installed")
    manifest = generate(args.output.resolve(), args.node, args.poppler)
    print(json.dumps({"output": str(args.output.resolve()), "checks": manifest["checks"]}, indent=2))


if __name__ == "__main__":
    main()
