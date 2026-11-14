"""Exercise one explicit provider check with no external requests or real credentials."""
import json
from copy import deepcopy
from types import SimpleNamespace

from backend.provider_check import check_provider


def profile(name="compatible"):
    """Supply only a synthetic frozen profile with explicit request capabilities."""
    return {"profile": name, "base_url": "https://example.invalid/v1", "model": "fixture-model",
            "lang_out": "zh-CN", "capabilities": {"json_mode": True,
            "thinking_disabled": name == "deepseek", "max_tokens": 8192}}


def client_factory(calls, error=None, content=None):
    """Create a tiny SDK-shaped client that cannot resolve or connect to any address."""
    def create(**options):
        """Record one SDK dispatch or expose a controlled original provider failure."""
        calls.append(options)
        if error:
            raise error
        text = content if content is not None else '{"translations":[{"id":0,"text":"公开测试译文"}]}'
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
                               usage=SimpleNamespace(prompt_tokens=12, completion_tokens=9))

    def factory(**options):
        """Assert retry/timeout policy without persisting the supplied test credential."""
        assert options["max_retries"] == 0 and options["timeout"] == 30
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
                               close=lambda: calls.append("closed"))
    return factory


def test_one_bounded_check_uses_profile_capabilities_without_mutation():
    """Keep compatible requests separate and leave the user's normal output limit unchanged."""
    settings, calls = profile(), []
    original = deepcopy(settings)
    result = check_provider(settings, "fixture-only-key", client_factory(calls))
    request = calls[0]
    assert result["ok"] and result["request_invocations"] == 1
    assert request["max_tokens"] == 512 and "extra_body" not in request
    assert request["response_format"] == {"type": "json_object"}
    assert settings == original and calls[-1] == "closed"
    assert result["billing"] == "unknown" and result["semantic_quality"] == "not_verified"


def test_failure_is_redacted_and_never_retried_or_fallen_back():
    """Do not turn a service rejection into a second request or leak its body."""
    calls = []
    error = RuntimeError("API Key sk-private-fixture /home/private/paper.pdf 论文正文")
    error.status_code = 401
    result = check_provider(profile("deepseek"), "fixture-only-key", client_factory(calls, error))
    assert not result["ok"] and result["request_invocations"] == 1
    assert calls[0]["extra_body"] == {"thinking": {"type": "disabled"}}
    assert len(calls) == 2 and calls[-1] == "closed"
    assert result["code"] == "provider" and result["http_status"] == 401
    assert "sk-private" not in json.dumps(result) and "论文正文" not in json.dumps(result, ensure_ascii=False)


def test_http_success_with_invalid_json_is_not_compatibility_success():
    """Reject an unusable response while preserving its single-call billing uncertainty."""
    calls = []
    result = check_provider(profile(), "fixture-only-key", client_factory(calls, content="raw private text"))
    assert result["http_accepted"] and not result["ok"]
    assert result["code"] == "provider_format" and result["request_invocations"] == 1
    assert "raw private" not in json.dumps(result)
