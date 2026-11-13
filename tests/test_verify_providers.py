"""Offline checks for bounded dispatch, explicit inputs, and secret-free provider evidence."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

# Load the standalone CLI without executing its main entry point.
SPEC = importlib.util.spec_from_file_location(
    "verify_providers", Path(__file__).resolve().parents[1] / "scripts/verify_providers.py")
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


def inputs(tmp_path, values=None):
    """Supply named local inputs without inheriting real credentials from the test host."""
    return VERIFY.load_inputs(None, root=tmp_path, environ=values or {})


def test_explicit_env_runtime_and_independent_profiles(tmp_path):
    """Keep environment precedence, legacy keys, and compatible defaults independent."""
    (tmp_path / ".runtime").mkdir()
    (tmp_path / ".runtime/deepseek.key").write_text("local-real-looking-secret")
    env_file = tmp_path / ".env"
    env_file.write_text('export COMPATIBLE_API_KEY="compatible-secret" # local\n'
                        'COMPATIBLE_BASE_URL=https://example.org/v1\nCOMPATIBLE_MODEL=chosen-model\n'
                        'COMPATIBLE_JSON_MODE=true\nIGNORED_SECRET=must-not-load\n')
    supplied = VERIFY.load_inputs(env_file, root=tmp_path, environ={"COMPATIBLE_MODEL": "override"})
    deepseek, compatible = VERIFY.profiles(VERIFY.parser().parse_args([]), supplied)
    assert deepseek["available"] and compatible["available"]
    assert deepseek["input_sources"]["api_key"] == ".runtime/deepseek.key"
    assert compatible["settings"]["model"] == "override"
    assert compatible["settings"]["base_url"] == "https://example.org/v1"
    assert compatible["settings"]["capabilities"] == {
        "max_tokens": 512, "json_mode": True, "thinking_disabled": False}
    assert "IGNORED_SECRET" not in supplied[1]
    missing = VERIFY.profiles(VERIFY.parser().parse_args([]), inputs(tmp_path))[1]
    assert missing["missing_inputs"] == ["COMPATIBLE_API_KEY (missing)",
                                         "COMPATIBLE_BASE_URL", "COMPATIBLE_MODEL"]


@pytest.mark.parametrize("key", ["your-key-here", "sk-xxxxx", "changeme", "${API_KEY}", "never-sent"])
def test_placeholders_and_output_limit(tmp_path, key):
    """Do not dispatch example keys or allow the output bound to be increased."""
    deepseek, _ = VERIFY.profiles(VERIFY.parser().parse_args([]), inputs(tmp_path, {"DEEPSEEK_API_KEY": key}))
    assert not deepseek["available"]
    with pytest.raises(SystemExit):
        VERIFY.parser().parse_args(["--max-tokens", "513"])


def test_inspect_never_constructs_client(tmp_path, monkeypatch, capsys):
    """Default inspection writes only redacted configuration with zero request invocations."""
    supplied = inputs(tmp_path, {"DEEPSEEK_API_KEY": "inspection-secret"})
    monkeypatch.setattr(VERIFY, "ROOT", tmp_path)
    monkeypatch.setattr(VERIFY, "load_inputs", lambda _: supplied)

    def forbidden(*args):
        """Reject even client construction during inspection."""
        pytest.fail("inspect must not construct a provider client")

    monkeypatch.setattr(VERIFY, "make_translator", forbidden)
    report = tmp_path / ".runtime/inspect.json"
    assert VERIFY.main(["--report", str(report)]) == 0
    evidence = report.read_text()
    assert "inspection-secret" not in evidence + capsys.readouterr().out
    assert json.loads(evidence)["request_invocations"] == 0
    assert json.loads(evidence)["profiles"][0]["available"]
    with pytest.raises(SystemExit):
        VERIFY.main(["--report", str(report)])
    with pytest.raises(SystemExit):
        VERIFY.main(["--report", str(tmp_path / "not-runtime.json")])


def test_one_request_each_and_original_error_sanitized(tmp_path, monkeypatch, capsys):
    """Use real SDK request shaping offline; a rejected profile never retries or falls back."""
    supplied = inputs(tmp_path, {"DEEPSEEK_API_KEY": "deep-secret",
                                "COMPATIBLE_API_KEY": "compat-secret",
                                "COMPATIBLE_BASE_URL": "https://example.org/v1",
                                "COMPATIBLE_MODEL": "chosen-model"})
    monkeypatch.setattr(VERIFY, "ROOT", tmp_path)
    monkeypatch.setattr(VERIFY, "load_inputs", lambda _: supplied)
    report = tmp_path / ".runtime/run.json"
    original_factory = VERIFY.make_translator
    requests = []

    def factory(settings, credential, scratch):
        """Replace only the SDK transport, retaining the existing translator and request method."""
        translator = original_factory(settings, credential, scratch)

        def handle(request):
            """Observe durable unknown billing before returning a simulated provider result."""
            requests.append((settings["profile"], json.loads(request.content)))
            ledger = json.loads(report.read_text())
            row = next(row for row in ledger["profiles"] if row["profile"] == settings["profile"])
            assert row["request_invocations"] == 1 and row["billing"] == "unknown"
            assert translator.client.max_retries == 0
            assert translator.client.timeout == 30
            if settings["profile"] == "compatible":
                return httpx.Response(400, json={"error": {
                    "message": "Unsupported max_tokens; compat-secret and deep-secret", "type": "invalid_request_error"}},
                    headers={"x-request-id": "rejected-1"})
            return httpx.Response(200, json={"id": "probe-1", "model": settings["model"],
                "choices": [{"index": 0, "finish_reason": "stop", "message": {
                    "role": "assistant", "content": '{"translations":[{"id":0,"text":"样品含有3个粒子。"}]}'}}],
                "usage": {"prompt_tokens": 80, "completion_tokens": 24, "total_tokens": 104,
                          "prompt_cache_hit_tokens": 20, "prompt_cache_miss_tokens": 60}})

        old_client = translator.client
        translator.client = old_client.with_options(http_client=httpx.Client(transport=httpx.MockTransport(handle)))
        old_client.close()
        return translator

    monkeypatch.setattr(VERIFY, "make_translator", factory)
    assert VERIFY.main(["--run", "--report", str(report)]) == 1
    evidence = report.read_text()
    assert all(secret not in evidence + capsys.readouterr().out for secret in supplied[3])
    ledger = json.loads(evidence)
    assert ledger["request_invocations"] == len(requests) == 2
    deepseek, compatible = ledger["profiles"]
    assert deepseek["outcome"] == "validated_translation" and deepseek["billing"] == "unknown"
    assert deepseek["response"]["usage"]["completion_tokens"] == 24
    assert compatible["outcome"] == "provider_error" and compatible["usage_status"] == "unknown"
    assert compatible["error"]["type"] == "BadRequestError"
    assert compatible["error"]["status_code"] == 400
    assert "Unsupported max_tokens" in compatible["error"]["message"]
    assert compatible["error"]["request_id"] == "rejected-1"
    assert requests[0][1]["max_tokens"] == requests[1][1]["max_tokens"] == 512
    assert requests[0][1]["thinking"] == {"type": "disabled"}
    assert requests[0][1]["response_format"] == {"type": "json_object"}
    assert "thinking" not in requests[1][1] and "response_format" not in requests[1][1]


def test_run_without_real_inputs_stays_offline(tmp_path, monkeypatch):
    """Explicit run still skips every unavailable profile and reports the missing fields."""
    supplied = inputs(tmp_path, {"DEEPSEEK_API_KEY": "your-key-here"})
    monkeypatch.setattr(VERIFY, "ROOT", tmp_path)
    monkeypatch.setattr(VERIFY, "load_inputs", lambda _: supplied)

    def forbidden(*args):
        """Fail if an unavailable profile reaches the client factory."""
        pytest.fail("unavailable profiles must not construct clients")

    monkeypatch.setattr(VERIFY, "make_translator", forbidden)
    report = tmp_path / "agent/codex/missing.json"
    assert VERIFY.main(["--run", "--report", str(report)]) == 1
    ledger = json.loads(report.read_text())
    assert ledger["request_invocations"] == 0
    assert ledger["profiles"][0]["credential_status"] == "placeholder"
    assert ledger["profiles"][0]["missing_inputs"] == ["DEEPSEEK_API_KEY (placeholder)"]


def test_lost_response_unknown_usage_and_escaped_redaction(tmp_path, monkeypatch):
    """A lost response remains unknown and credential echoes are removed in nested values."""
    profile = VERIFY.profiles(VERIFY.parser().parse_args([]), inputs(tmp_path, {
        "DEEPSEEK_API_KEY": 'secret/with+"quote'}))[0]
    row = {"request_invocations": 0, "billing": "not_called"}
    calls = []

    def lost(messages):
        """Simulate a response loss after the sole dispatch."""
        calls.append(messages)
        raise TimeoutError('Connection lost secret/with+"quote')

    translator = SimpleNamespace(messages=lambda _: [], request_completion=lost,
                                 client=SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(VERIFY, "make_translator", lambda *args: translator)
    VERIFY.verify_profile(profile, row, lambda: None, tmp_path)
    assert len(calls) == row["request_invocations"] == 1
    assert row["billing"] == row["usage_status"] == "unknown"
    assert row["error"]["type"] == "TimeoutError"
    sanitized = VERIFY.sanitize({"raw": row, "encoded": "secret%2Fwith%2B%22quote"}, [profile["credential"]])
    assert "Connection lost [REDACTED]" == sanitized["raw"]["error"]["message"]
    assert sanitized["encoded"] == "[REDACTED]"


@pytest.mark.parametrize("content,finish,valid", [
    ('{"translations":[{"id":0,"text":"中文"}]}', "length", False),
    ('{"translations":[{"id":true,"text":"中文"}]}', "stop", False),
    ("not json", "stop", False),
    ('{"translations":[{"id":"0","text":"中文"}]}', "stop", True),
])
def test_response_shape_and_unknown_usage(content, finish, valid):
    """API acceptance alone is not valid translation or reported billing evidence."""
    response = SimpleNamespace(usage=None, choices=[SimpleNamespace(
        finish_reason=finish, message=SimpleNamespace(content=content))])
    evidence = VERIFY.response_evidence(response)
    assert evidence["compatibility"]["chat_completion_responded"]
    assert evidence["compatibility"]["translation_json_valid"] is valid
    assert evidence["usage_status"] == "unknown" and evidence["response"]["usage"] is None
