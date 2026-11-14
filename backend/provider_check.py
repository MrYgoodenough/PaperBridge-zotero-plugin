"""Share request shaping with one explicit, bounded provider compatibility check."""
import json

# A check is not a translation job and cannot inherit a large user output limit.
CHECK_OUTPUT_TOKENS = 512
# Slow compatible services still get a reasonable window, with SDK retries disabled.
CHECK_TIMEOUT_SECONDS = 30
# Keep the sample public, short and independent of user papers or metadata.
CHECK_TEXT = "A scientific paper reports a reproducible experiment."


def request_completion(client, model, capabilities, messages):
    """Send one completion with the same explicitly declared production capabilities."""
    options = {"model": model, "messages": messages, "temperature": 0,
               "max_tokens": capabilities["max_tokens"]}
    if capabilities["json_mode"]:
        options["response_format"] = {"type": "json_object"}
    if capabilities["thinking_disabled"]:
        options["extra_body"] = {"thinking": {"type": "disabled"}}
    return client.chat.completions.create(**options)


def check_provider(settings, credential, client_factory=None):
    """Check one frozen profile; return safe evidence without caching, retries or raw output."""
    if not isinstance(credential, str) or not credential.strip():
        raise ValueError("请填写当前配置的 API Key；检查服务不会借用另一套密钥。")
    if any(character.isspace() for character in credential):
        raise ValueError("API Key 不能包含空白字符。")
    if client_factory is None:
        from openai import OpenAI
        client_factory = OpenAI
    # Preserve the profile's JSON/thinking support while bounding only this request.
    capabilities = {**settings["capabilities"], "max_tokens": CHECK_OUTPUT_TOKENS}
    messages = [
        {"role": "system", "content": f"Translate the public sample into {settings['lang_out']}. "
         'Return only JSON {"translations":[{"id":0,"text":"translation"}]}, with one nonempty result.'},
        {"role": "user", "content": json.dumps({"paragraphs": [{"id": 0, "text": CHECK_TEXT}]})},
    ]
    result = {"ok": False, "request_invocations": 0, "sdk_retries": 0,
              "max_output_tokens": CHECK_OUTPUT_TOKENS, "billing": "not_called",
              "semantic_quality": "not_verified"}
    client = None
    try:
        client = client_factory(api_key=credential, base_url=settings["base_url"],
                                max_retries=0, timeout=CHECK_TIMEOUT_SECONDS)
        result.update(request_invocations=1, billing="unknown")
        response = request_completion(client, settings["model"], capabilities, messages)
        result["http_accepted"] = True
        try:
            parsed = json.loads(response.choices[0].message.content)
            rows = parsed.get("translations") if isinstance(parsed, dict) else None
            valid = (isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict)
                     and type(rows[0].get("id")) is int and rows[0]["id"] == 0
                     and isinstance(rows[0].get("text"), str) and bool(rows[0]["text"].strip()))
        except (ValueError, TypeError, AttributeError, IndexError):
            valid = False
        result.update(ok=valid, translation_json_valid=valid)
        if not valid:
            result.update(code="provider_format", error="服务已响应，但返回格式不符合翻译接口要求。",
                          hint="请核对模型及 JSON 模式能力；检查不会自动重发，也未验证真实论文质量。")
        usage = getattr(response, "usage", None)
        result["usage"] = {name: getattr(usage, field, None) for name, field in (
            ("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens"))}
        # Only numeric totals are public evidence; actual charges remain unknown.
        result["usage"] = {name: value if type(value) is int and value >= 0 else None
                           for name, value in result["usage"].items()}
    except Exception as error:
        # Both package imports and the standalone launcher can use this module.
        if __package__:
            from .errors import explain_error
        else:
            from errors import explain_error
        result.update(explain_error(error))
        status = getattr(error, "status_code", None)
        result["http_status"] = status if type(status) is int and 100 <= status <= 599 else None
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                # Cleanup cannot erase already observed request/format evidence.
                pass
    return result
