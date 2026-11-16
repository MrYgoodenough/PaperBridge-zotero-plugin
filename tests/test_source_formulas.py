"""Check complete mathematical source spans without importing the full PDF engine."""

from types import SimpleNamespace

from backend.source_formulas import formula_spans, multiline_offset


def expressions(text):
    """Expose the exact matched source substring rather than a normalized invented formula."""
    return [text[start:end] for start, end in formula_spans(text)]


def test_assignment_keeps_roman_variable_and_decimal():
    """A plain-font variable belongs to its assignment, not to translatable prose."""
    assert expressions("when setting nvar = 5000. As seen") == ["nvar = 5000"]
    assert expressions("unless 1 − β < 0.05. This is shown") == ["1 − β < 0.05"]
    assert expressions("p < .05; nvar = ") == ["p < .05"]


def test_wrapped_ppv_scaffold_is_one_expression():
    """Preserve every actual variable, bracket and superscript across a source line break."""
    formula = "PPV = R(1 − βn)⁄(R + 1 − [1 −\nα]n − Rβn)"
    assert expressions("Table 3: " + formula + " (not considering bias).") == [formula]


def test_prose_hyphens_citations_and_counts_are_not_expressions():
    """Ordinary words and parenthetical citation years do not become math placeholders."""
    assert expressions("high-order, t-test, concurrent selec- tion, and/or methods (Smith, 2020)") == []
    assert expressions("10-fold, 20-year-old and CD4-positive cells") == []


def test_independent_expressions_keep_their_boundaries():
    """Never transfer a separate expression or following prose into the first formula."""
    assert expressions("n = 10, then p < 0.05 and i = 1 to n.") == ["n = 10", "p < 0.05", "i = 1"]


def test_uri_and_doi_paths_do_not_become_partial_fractions():
    """Opaque publication identifiers must not be fragmented by mathematical grouping."""
    assert expressions("https://doi.org/10.7554/eLife.22194.003 and DOI 10.7554/eLife.16586.sa1; nvar = 5.") == ["nvar = 5"]


def test_multiline_math_top_anchor_keeps_single_line_and_original_formulas_unchanged():
    """A two-row source block must fit below the preceding line; ordinary math keeps its old offset."""
    formula = SimpleNamespace(box=SimpleNamespace(y=0, y2=20), pdf_character=[
        SimpleNamespace(formula_layout_id=-1, pdf_style=SimpleNamespace(font_size=9))])
    assert multiline_offset(formula, 9) == -11
    formula.box.y2 = 12
    assert multiline_offset(formula, 9) is None
    formula.box.y2 = 20
    formula.pdf_character[0].formula_layout_id = 1
    assert multiline_offset(formula, 9) is None
