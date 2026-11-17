"""Check selected-formula validation and provider response handling without network calls."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from formulas import convert, normalize_latex, selection_payload


@pytest.mark.parametrize("value", [r"\frac{x^2}{y_i}", r"$\frac{x^2}{y_i}$", r"$$\frac{x^2}{y_i}$$", r"\[\frac{x^2}{y_i}\]"])
def test_formula_delimiters_are_normalized(value):
    """Preserve the formula while stripping supported outer math delimiters."""
    assert normalize_latex(value) == r"\frac{x^2}{y_i}"


@pytest.mark.parametrize("value", ["", "```latex\nx^2\n```", r"\frac{x}{", "x}"])
def test_rejects_empty_malformed_or_truncated_formula(value):
    """Reject empty, fenced, or brace-truncated provider output."""
    with pytest.raises(ValueError):
        normalize_latex(value)


@pytest.mark.parametrize("payload", [[], {"text": ""}, {"text": "x" * 6001},
    {"text": "x", "glyphs": [{"c": "x", "rect": [0, 0, float("nan"), 1]}]},
    {"text": "x", "glyphs": [None]}])
def test_rejects_invalid_selections_before_provider_call(payload):
    """Reject invalid selection data without constructing a provider client."""
    with pytest.raises(ValueError):
        selection_payload(payload)


def test_converts_only_selected_text_and_layout_and_fixes_dollar_wrappers():
    """Send only selected glyphs and normalize the successful mock response."""
    calls = []
    class Client:
        """Record options without creating any network resources."""

        def __init__(self, **options):
            """Expose the completion API and retain constructor arguments."""
            self.chat = SimpleNamespace(completions=self)
            calls.append(options)

        def __enter__(self):
            """Match the provider SDK context-manager interface."""
            return self

        def __exit__(self, *_):
            """The mock holds no sockets or other resources."""
            pass

        def create(self, **options):
            """Return one complete formula response and retain request arguments."""
            calls.append(options)
            return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(
                content=json.dumps({"latex": r"$$x^2+y_i=\frac{1}{2}$$", "error": ""})))])
    result = convert({"text": "x2+yi=1/2", "glyphs": [{"c": "2", "rect": [1, 20, 5, 24]}],
                      "api_key": "fixture-key", "source_path": "private-whole-document.pdf"}, Client)
    assert result["latex"] == r"x^2+y_i=\frac{1}{2}"
    prompt = calls[1]["messages"][1]["content"]
    assert "rect" in prompt and "private-whole-document" not in prompt and "fixture-key" not in prompt


def test_provider_errors_do_not_expose_api_key():
    """Redact the configured credential from a provider exception."""
    def bad_client(**_):
        """Simulate a provider exception containing its Authorization value."""
        raise RuntimeError("Authorization: Bearer secret-fixture")
    with pytest.raises(ValueError) as error:
        convert({"text": "x", "api_key": "secret-fixture"}, bad_client)
    assert "secret-fixture" not in str(error.value)


def test_formula_requires_https():
    """Keep the existing HTTPS-only provider endpoint requirement."""
    with pytest.raises(ValueError, match="HTTPS"):
        convert({"text": "x", "api_key": "fixture", "base_url": "http://example.com"})


def test_provider_error_rejects_partial_latex():
    """Do not return a cacheable success when the provider marks its formula incomplete."""
    client = MagicMock()
    client.__enter__.return_value = client
    client.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(
        finish_reason="stop", message=SimpleNamespace(content=json.dumps(
            {"latex": "x^2", "error": "selected formula is incomplete"})),
    )])
    with pytest.raises(ValueError, match="未能识别公式"):
        convert({"text": "x2", "api_key": "fixture-key"}, MagicMock(return_value=client))
    client.chat.completions.create.assert_called_once()
