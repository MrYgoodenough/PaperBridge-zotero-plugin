"""Keep bibliography sections as original PDF regions, before LLM batching."""
from bisect import bisect_right
import re
from statistics import median

# Long mixed prose and citation entries are not reliable section headings.
MAX_STOP_HEADING_CHARACTERS = 140
# Substantial repeated lines distinguish text columns from headings and page furniture.
MIN_COLUMN_LINE_WIDTH = 100
# A handful of lines is enough for a column, without mistaking isolated labels for one.
MIN_COLUMN_LINES = 5
# Paragraph and bibliography indents belong to the same column origin.
COLUMN_INDENT_GAP = 24
# Include the heading itself without reaching the preceding line.
HEADING_PADDING = 1


def heading_kind(text, bold=False):
    """Classify literal bibliography boundaries, including methods after a reference list."""
    text = text.strip()
    title = re.sub(r"^(?:(?:[IVXLCDM]+|\d+(?:\.\d+)*)[.)]\s*|(?:[IVXLCDM]+|\d+(?:\.\d+)*)\s+)", "", text, flags=re.I)
    compact = re.sub(r"\s+", "", title).strip(":：").lower()
    original = re.sub(r"\s+", "", text).strip(":：").lower()
    if {original,compact} & {"references","bibliography","literaturecited","参考文献","參考文獻"}:
        return "start"
    if (compact in {"appendix","appendices","supplementarymaterial","supplementaryinformation",
                    "acknowledgments","acknowledgements","authorcontributions","dataavailability",
                    "funding","conflictsofinterest","competinginterests",
                    "starmethods","star+methods","keyresourcestable","methoddetails",
                    "materialsandmethods","experimentalmodelandsubjectdetails",
                    "quantificationandstatisticalanalysis"}
            or re.fullmatch(r"appendix[a-z0-9](?:[.:].*)?",compact)):
        return "stop"
    if len(text)<MAX_STOP_HEADING_CHARACTERS and re.match(r"^(?:[A-Z]|[IVXLCDM]+)[.)]\s+",text) and (text.isupper() or bold):
        return "stop"
    return None


def _column_edges(page, lines):
    """Find actual text gutters, including three columns and right-shifted layouts."""
    groups = []
    for line in sorted(lines, key=lambda item: item["bbox"][0]):
        x0, _, x1, _ = line["bbox"]
        if x1 - x0 < MIN_COLUMN_LINE_WIDTH:
            continue
        if groups and x0 - groups[-1][-1][0] <= COLUMN_INDENT_GAP:
            groups[-1].append((x0, x1))
        else:
            groups.append([(x0, x1)])

    columns = []
    for group in groups:
        if len(group) < MIN_COLUMN_LINES:
            continue
        # Overlapping extents are hanging indents or mixed-width single-column prose.
        # The median ignores occasional spanning titles/footers on genuine columns.
        if columns and median(x1 for _, x1 in columns[-1]) >= group[0][0]:
            columns[-1].extend(group)
        else:
            columns.append(group)

    gutters = []
    for left, right in zip(columns, columns[1:]):
        right_start = right[0][0]
        left_end = max(x1 for _, x1 in left if x1 <= right_start)
        gutters.append((left_end + right_start) / 2)
    return [page.rect.x0, *gutters, page.rect.x1]


def reference_regions(document):
    """Track reference spans in column reading order without protecting later scientific sections."""
    regions = {}
    active = False
    for page_number,page in enumerate(document):
        lines = [line for block in page.get_text("dict")["blocks"] for line in block.get("lines",[])]
        edges = _column_edges(page, lines)
        columns = len(edges) - 1
        height = page.rect.height
        events = []
        for line in lines:
            text = " ".join(span["text"] for span in line["spans"])
            kind = heading_kind(text,any("bold" in span["font"].lower() for span in line["spans"]))
            if not kind:
                continue
            x0,y0,x1,_ = line["bbox"]
            full = columns > 1 and x0 < edges[1] and x1 > edges[-2]
            column = bisect_right(edges[1:-1], x0)
            y = max(0, y0 - page.rect.y0 - HEADING_PADDING)
            events.append((column*height+y,kind,full,y))
        events.sort()
        start = 0 if active else None
        floor, ceiling = 0,height
        spans = []
        for position,kind,full,y in events:
            if kind=="start" and not active:
                active = True
                start = position
                if full:
                    floor = max(0,y)
            elif kind=="stop" and active:
                if full:
                    ceiling = max(0,y)
                    position = columns*height
                spans.append((start,position))
                start = None
                active = False
        if active:
            spans.append((start,columns*height))
        boxes = []
        for beginning,end in spans:
            for column in range(columns):
                top = max(beginning-column*height,floor,0)
                bottom = min(end-column*height,ceiling,height)
                if bottom<=top:
                    continue
                boxes.append((edges[column],page.rect.y0+top,edges[column+1],page.rect.y0+bottom))
        if boxes:
            regions[page_number] = boxes
    return regions
