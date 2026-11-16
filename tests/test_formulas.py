import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from formulas import convert, normalize_latex, selection_payload


@pytest.mark.parametrize("value", [r"\frac{x^2}{y_i}", r"$\frac{x^2}{y_i}$", r"$$\frac{x^2}{y_i}$$", r"\[\frac{x^2}{y_i}\]"])
def test_formula_delimiters_are_normalized(value):
    assert normalize_latex(value) == r"\frac{x^2}{y_i}"


@pytest.mark.parametrize("value", ["", "```latex\nx^2\n```", r"\frac{x}{", "x}"])
def test_rejects_empty_malformed_or_truncated_formula(value):
    with pytest.raises(ValueError):
        normalize_latex(value)


@pytest.mark.parametrize("payload", [[], {"text": ""}, {"text": "x" * 6001},
    {"text": "x", "glyphs": [{"c": "x", "rect": [0, 0, float("nan"), 1]}]},
    {"text": "x", "glyphs": [None]}])
def test_rejects_invalid_selections_before_provider_call(payload):
    with pytest.raises(ValueError):
        selection_payload(payload)


def test_converts_only_selected_text_and_layout_and_fixes_dollar_wrappers():
    calls = []
    class Client:
        def __init__(self, **options):
            self.chat = SimpleNamespace(completions=self)
            calls.append(options)
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def create(self, **options):
            calls.append(options)
            return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(
                content=json.dumps({"latex": r"$$x^2+y_i=\frac{1}{2}$$", "error": ""})))])
    result = convert({"text": "x2+yi=1/2", "glyphs": [{"c": "2", "rect": [1, 20, 5, 24]}],
                      "api_key": "fixture-key", "source_path": "private-whole-document.pdf"}, Client)
    assert result["latex"] == r"x^2+y_i=\frac{1}{2}"
    prompt = calls[1]["messages"][1]["content"]
    assert "rect" in prompt and "private-whole-document" not in prompt and "fixture-key" not in prompt


def test_provider_errors_do_not_expose_api_key():
    def bad_client(**_): raise RuntimeError("Authorization: Bearer secret-fixture")
    with pytest.raises(ValueError) as error:
        convert({"text": "x", "api_key": "secret-fixture"}, bad_client)
    assert "secret-fixture" not in str(error.value)


def test_formula_requires_https():
    with pytest.raises(ValueError, match="HTTPS"):
        convert({"text": "x", "api_key": "fixture", "base_url": "http://example.com"})
