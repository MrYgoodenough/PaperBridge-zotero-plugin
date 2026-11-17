"""Keep complete source expressions in one BabelDOC formula before translation and typesetting."""

from dataclasses import replace
import re

# Tokenize only source mathematical notation; unmatched punctuation terminates a candidate.
TOKENS = re.compile(
    r"(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|[^\W\d_]\w*|<=|>=|!=|:="
    r"|[=≠≈∝<>≤≥+\-−–±*/⁄×÷^√∈()[\]{},]"
)
# Explicit relations also distinguish named variables from ordinary hyphenated prose.
RELATIONS = {"=", "≠", "≈", "∝", "<", ">", "≤", "≥", "<=", ">=", "!=", ":=", "∈"}
# These operators require a mathematical operand signal rather than two ordinary words.
OPERATORS = RELATIONS | {"+", "-", "−", "–", "±", "*", "/", "⁄", "×", "÷", "^", "√"}
# Source parentheses/brackets retain their original nesting and physical glyph positions.
CLOSING = {"(": ")", "[": "]", "{": "}"}
# URI/DOI slash paths are opaque identifiers, not mathematical divisions.
LITERALS = re.compile(r"https?://[^\s<>]+|10\.\d{4,9}/[^\s<>]+", re.I)
# A real source word space is wider than glyph kerning; synthetic parser spaces are never painted.
WORD_SPACE_FRACTION = 0.15
# A leftward reset with this baseline change marks a wrapped source line, not a superscript.
LINE_CHANGE_FRACTION = 0.25
# Superscripts alone do not make a second source row; stacked/wrapped expressions exceed this height.
MULTILINE_HEIGHT_FACTOR = 1.6


def formula_spans(text):
    """Find complete expressions, stopping before prose and keeping wrapped decimals/exponents."""
    tokens = list(TOKENS.finditer(text))
    literals = [match.span() for match in LITERALS.finditer(text)]
    spans, index = [], 0
    while index < len(tokens):
        first = tokens[index]
        if not first.group()[0].isalnum():
            index += 1
            continue
        stack, previous, previous_end = [], None, first.start()
        relation = numeric = greek = single_letter = roman_word = operation = False
        operands, operations = [], []
        balanced_end = None
        cursor = index
        while cursor < len(tokens):
            token = tokens[cursor]
            value = token.group()
            gap = text[previous_end:token.start()]
            if gap and not gap.isspace():
                break
            operand = value[0].isalnum() or value.startswith(".")
            if operand:
                # Adjacent source superscripts are allowed; separate prose words are not products.
                if previous == "operand" and gap:
                    break
                numeric |= value[0].isdigit() or value.startswith(".")
                greek |= bool(re.search(r"[Α-Ωα-ω]", value))
                single_letter |= len(value) == 1 and value.isalpha()
                # A number alone cannot declare an ordinary Roman word as a named variable.
                roman_word |= value.isascii() and value.isalpha() and len(value) > 1
                operands.append(value)
                previous = "operand"
            elif value in CLOSING:
                stack.append(CLOSING[value])
                previous = "operator"
            elif value in CLOSING.values():
                if not stack or value != stack.pop() or previous != "operand":
                    break
                previous = "operand"
            elif value == ",":
                if not stack or previous != "operand":
                    break
                previous = "operator"
            elif value in OPERATORS:
                if previous != "operand" and value not in {"+", "-", "−", "±", "√"}:
                    break
                relation |= value in RELATIONS
                operation = True
                operations.append(value)
                previous = "operator"
            else:
                break
            previous_end = token.end()
            if not stack and previous == "operand" and operation and (relation or not roman_word):
                balanced_end = token.end()
            cursor += 1
        # Counts in "10-fold" do not turn the accompanying prose into a formula either.
        word_hyphen = (operations and all(value in {"-", "−", "–"} for value in operations)
                       and all(value.isascii() and value.isalnum() for value in operands)
                       and any(value.isalpha() and len(value) > 1 for value in operands))
        if (balanced_end and operation and not word_hyphen and (relation or numeric or greek or single_letter)
                and not any(low < balanced_end and first.start() < high for low, high in literals)):
            spans.append((first.start(), balanced_end))
            while index < len(tokens) and tokens[index].end() <= balanced_end:
                index += 1
        else:
            index += 1
    return spans


def merge_formula_groups(paragraph):
    """Reuse actual source glyphs/curves, merging fragmented expressions without inventing text."""
    from babeldoc.format.pdf.document_il import Box, PdfFormula, PdfParagraphComposition
    from babeldoc.format.pdf.document_il.utils.formular_helper import update_formula_data
    compositions = paragraph.pdf_paragraph_composition
    chunks, characters, starts, ends, text = [], [], {}, {}, ""
    for composition in compositions:
        kind = next((name for name in ("pdf_line", "pdf_same_style_characters", "pdf_formula")
                     if getattr(composition, name)), None)
        if kind is None:
            return False
        value = getattr(composition, kind)
        start = len(characters)
        for character in value.pdf_character:
            if characters and text and not text[-1].isspace() and not (character.char_unicode or " ").isspace():
                previous = characters[-1]
                old, current = previous.box, character.box
                size = min(previous.pdf_style.font_size, character.pdf_style.font_size)
                word_space = current.x - old.x2 > size * WORD_SPACE_FRACTION
                wrapped = (current.x < old.x and
                           abs((current.y + current.y2 - old.y - old.y2) / 2) > size * LINE_CHANGE_FRACTION)
                if word_space or wrapped:
                    # Source streams often encode word/line gaps only with positioning, not a space glyph.
                    text += " "
            starts[len(text)] = len(characters)
            text += character.char_unicode or " "
            characters.append(character)
            ends[len(text)] = len(characters)
        chunks.append((start, len(characters), composition, kind))
    intervals = []
    for left, right in formula_spans(text):
        if left not in starts or right not in ends:
            continue
        start, end = starts[left], ends[right]
        # Curves/forms already assigned to a formula cannot be cut into separate owners.
        for low, high, _, kind in chunks:
            if kind == "pdf_formula" and low < end and start < high:
                start, end = min(start, low), max(end, high)
        if intervals and start <= intervals[-1][1]:
            intervals[-1] = (intervals[-1][0], max(end, intervals[-1][1]))
        else:
            intervals.append((start, end))
    intervals = [(start, end) for start, end in intervals if not any(
        low == start and high == end and kind == "pdf_formula" for low, high, _, kind in chunks)]
    if not intervals:
        return False
    output, cursor, chunk_index, interval_index = [], 0, 0, 0
    while cursor < len(characters):
        if interval_index < len(intervals) and cursor == intervals[interval_index][0]:
            start, end = intervals[interval_index]
            old = [composition.pdf_formula for low, high, composition, kind in chunks
                   if kind == "pdf_formula" and start <= low and high <= end]
            formula = PdfFormula(pdf_character=characters[start:end],
                                 pdf_curve=[curve for value in old for curve in value.pdf_curve],
                                 pdf_form=[form for value in old for form in value.pdf_form])
            # Negative virtual owners cannot collide with detector IDs or be split at formula commas.
            for character in formula.pdf_character:
                character.formula_layout_id = -start - 1
            update_formula_data(formula)
            output.append(PdfParagraphComposition(pdf_formula=formula))
            cursor = end
            interval_index += 1
            continue
        while chunks[chunk_index][1] <= cursor:
            chunk_index += 1
        low, high, composition, kind = chunks[chunk_index]
        end = min(high, intervals[interval_index][0]) if interval_index < len(intervals) else high
        if cursor == low and end == high:
            output.append(composition)
        else:
            value = replace(getattr(composition, kind), pdf_character=characters[cursor:end])
            # The upstream style/offset phases run next and use these actual source bounds.
            boxes = [character.visual_bbox.box for character in value.pdf_character]
            value.box = Box(min(box.x for box in boxes), min(box.y for box in boxes),
                            max(box.x2 for box in boxes), max(box.y2 for box in boxes))
            output.append(PdfParagraphComposition(**{kind: value}))
        cursor = end
    paragraph.pdf_paragraph_composition = output
    return True


def multiline_offset(formula, line_em):
    """Anchor complete multi-row math at the line's top, not above the preceding prose baseline."""
    ids = {character.formula_layout_id for character in formula.pdf_character}
    if len(ids) != 1 or not all(isinstance(value, int) and value < 0 for value in ids):
        return None
    size = max((character.pdf_style.font_size or 0 for character in formula.pdf_character), default=0)
    height = formula.box.y2 - formula.box.y
    if not size or not line_em or height <= size * MULTILINE_HEIGHT_FACTOR:
        return None
    return min(0, line_em - height)


def install_formula_groups():
    """Repair the existing BabelDOC formula phase before its normal style/offset/translation flow."""
    from babeldoc.format.pdf.document_il.midend.styles_and_formulas import StylesAndFormulas
    original = StylesAndFormulas.process_page_formulas
    if getattr(original, "paperbridge_complete_formulas", False):
        return

    def complete_formulas(self, page):
        """Run the original classifier, then restore complete source expression ownership."""
        original(self, page)
        for paragraph in page.pdf_paragraph:
            merge_formula_groups(paragraph)

    complete_formulas.paperbridge_complete_formulas = True
    StylesAndFormulas.process_page_formulas = complete_formulas
    original_page = StylesAndFormulas.process_page

    def complete_offsets(self, page):
        """Fix the original formula offset object after its normal styles and baseline heuristics."""
        original_page(self, page)
        for paragraph in page.pdf_paragraph:
            if not paragraph.pdf_style:
                continue
            for composition in paragraph.pdf_paragraph_composition:
                if composition.pdf_formula:
                    offset = multiline_offset(composition.pdf_formula, paragraph.pdf_style.font_size)
                    if offset is not None:
                        composition.pdf_formula.y_offset = offset

    StylesAndFormulas.process_page = complete_offsets
