"""Keep bibliography sections as original PDF regions, before LLM batching."""
import re


def heading_kind(text, bold=False):
    text = text.strip()
    title = re.sub(r"^(?:(?:[IVXLCDM]+|\d+(?:\.\d+)*)[.)]\s*|(?:[IVXLCDM]+|\d+(?:\.\d+)*)\s+)", "", text, flags=re.I)
    compact = re.sub(r"\s+", "", title).strip(":：").lower()
    original = re.sub(r"\s+", "", text).strip(":：").lower()
    if {original,compact} & {"references","bibliography","literaturecited","参考文献","參考文獻"}:
        return "start"
    if (compact in {"appendix","appendices","supplementarymaterial","supplementaryinformation",
                    "acknowledgments","acknowledgements","authorcontributions","dataavailability",
                    "funding","conflictsofinterest","competinginterests"}
            or re.fullmatch(r"appendix[a-z0-9](?:[.:].*)?",compact)):
        return "stop"
    if len(text)<140 and re.match(r"^(?:[A-Z]|[IVXLCDM]+)[.)]\s+",text) and (text.isupper() or bold):
        return "stop"
    return None


def reference_regions(document):
    regions = {}
    active = False
    for page_number,page in enumerate(document):
        lines = [line for block in page.get_text("dict")["blocks"] for line in block.get("lines",[])]
        middle = page.rect.x0 + page.rect.width / 2
        left = sum(line["bbox"][2] < middle+5 and line["bbox"][2]-line["bbox"][0] > 100 for line in lines)
        right = sum(line["bbox"][0] > middle-5 and line["bbox"][2]-line["bbox"][0] > 100 for line in lines)
        columns = 2 if left>=5 and right>=5 else 1
        height = page.rect.height
        events = []
        for line in lines:
            text = " ".join(span["text"] for span in line["spans"])
            kind = heading_kind(text,any("bold" in span["font"].lower() for span in line["spans"]))
            if not kind:
                continue
            x0,y0,x1,_ = line["bbox"]
            full = columns==2 and x0 < middle < x1
            column = 1 if columns==2 and x0>=middle else 0
            events.append((column*height+max(0,y0-1),kind,full,y0-1))
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
                x0 = page.rect.x0 if column==0 else middle
                x1 = page.rect.x1 if columns==1 or column==1 else middle
                boxes.append((x0,page.rect.y0+top,x1,page.rect.y0+bottom))
        if boxes:
            regions[page_number] = boxes
    return regions
