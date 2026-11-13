"""Inspect provider inputs or explicitly send one bounded translation per ready profile.

Credentials come only from environment, --env-file, or .runtime/deepseek.key.
This checks direct API compatibility, not the PDF/mapping pipeline or invoice costs.
"""
import argparse
import json
import logging
import os
import re
import shlex
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, quote_plus

# Resolve configuration and evidence relative to this checkout on every platform.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from library_cache import normalize_config

# Bound both output and elapsed network waiting without retrying rejected fields.
MAX_OUTPUT_TOKENS = 512
REQUEST_TIMEOUT_SECONDS = 30
# A single small paragraph exercises the existing JSON translation contract.
PROBE_TEXT = "The sample contains 3 particles."
# Generic OpenAI inputs belong only to compatible; legacy key inputs remain DeepSeek-only.
INPUT_FIELDS = {
    "deepseek": {
        "api_key": ("DEEPSEEK_API_KEY", "API_KEY", "key"),
        "base_url": ("DEEPSEEK_BASE_URL",),
        "model": ("DEEPSEEK_MODEL",),
        "json_mode": ("DEEPSEEK_JSON_MODE",),
        "thinking_disabled": ("DEEPSEEK_THINKING_DISABLED",),
    },
    "compatible": {
        "api_key": ("COMPATIBLE_API_KEY", "OPENAI_API_KEY"),
        "base_url": ("COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"),
        "model": ("COMPATIBLE_MODEL", "OPENAI_MODEL"),
        "json_mode": ("COMPATIBLE_JSON_MODE",),
        "thinking_disabled": ("COMPATIBLE_THINKING_DISABLED",),
    },
}


def parser():
    """Expose nonsecret overrides and require an explicit paid-call opt-in."""
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--run", action="store_true", help="At most one API request per ready profile")
    result.add_argument("--env-file", type=Path, help="Explicit .env input; environment takes precedence")
    result.add_argument("--report", type=Path, help="New JSON path under .runtime or agent/codex")
    result.add_argument("--max-tokens", type=int, default=MAX_OUTPUT_TOKENS,
                        choices=range(1, MAX_OUTPUT_TOKENS + 1), metavar="1..512")
    for profile in INPUT_FIELDS:
        result.add_argument(f"--{profile}-base-url", help=f"{profile} endpoint override")
        result.add_argument(f"--{profile}-model", help=f"{profile} model override")
        for capability in ("json-mode", "thinking-disabled"):
            result.add_argument(f"--{profile}-{capability}", action=argparse.BooleanOptionalAction,
                                default=None, help="Override the existing profile capability")
    result.epilog = ("Inputs: DEEPSEEK_API_KEY/BASE_URL/MODEL; COMPATIBLE_API_KEY/BASE_URL/MODEL "
                     "(OPENAI_* aliases). Optional *_JSON_MODE and *_THINKING_DISABLED booleans. "
                     "Legacy API_KEY/key and .runtime/deepseek.key are DeepSeek-only. "
                     "No automatic .env discovery, credential arguments, model discovery, or fallback.")
    return result


def placeholder(value):
    """Reject obvious examples without imposing a provider-specific key format."""
    text = value.strip().lower()
    return (not text or text in {"none", "null", "key", "test", "dummy", "fake", "never-sent"}
            or bool(re.search(r"placeholder|your[-_ ]|replace[-_ ]?me|change[-_ ]?me|example[-_ ]?key", text))
            or bool(re.fullmatch(r"(?:sk[-_])?(?:x+|test(?:[-_].*)?|dummy|fake)", text))
            or text.startswith(("<", "${")))


def load_inputs(env_file, root=ROOT, environ=None):
    """Read only named inputs and the known plaintext key, never credential databases."""
    names = {name for fields in INPUT_FIELDS.values() for aliases in fields.values() for name in aliases}
    environment = os.environ if environ is None else environ
    env = {name: environment[name].strip() for name in names if name in environment}
    values, warnings = {}, []
    if env_file is not None:
        try:
            for number, line in enumerate(env_file.read_text(encoding="utf-8-sig").splitlines(), 1):
                name, separator, value = line.strip().removeprefix("export ").partition("=")
                if separator and name.strip() in names:
                    try:
                        values[name.strip()] = " ".join(shlex.split(value, comments=True))
                    except ValueError:
                        warnings.append(f"env_file line {number}: invalid quoting (value omitted)")
        except (OSError, UnicodeError) as error:
            warnings.append(f"env_file: {type(error).__name__} (input unavailable)")
    key = ""
    key_path = root / ".runtime/deepseek.key"
    try:
        if key_path.is_file():
            key = key_path.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError) as error:
        warnings.append(f".runtime/deepseek.key: {type(error).__name__} (input unavailable)")
    # Include unused aliases in redaction in case a provider echoes another supplied key.
    key_names = {name for fields in INPUT_FIELDS.values() for name in fields["api_key"]}
    secrets = [source[name] for source in (env, values) for name in key_names if source.get(name)]
    if key:
        secrets.append(key)
    return env, values, key, secrets, warnings


def profiles(options, inputs):
    """Resolve separate profiles without inventing compatible endpoint/model defaults."""
    env, values, runtime_key, _, _ = inputs
    resolved = []
    for profile, fields in INPUT_FIELDS.items():
        config = {"profile": profile, "capabilities": {"max_tokens": options.max_tokens}}
        sources, missing, errors = {}, [], []
        credential = ""
        credential_status = "missing"
        for field, aliases in fields.items():
            value = getattr(options, f"{profile}_{field}", None)
            source = f"--{profile}-{field.replace('_', '-')}"
            if value is None:
                source, value = "", None
                for label, supplied in (("environment", env), ("env_file", values)):
                    match = next((name for name in aliases if supplied.get(name)), None)
                    if match:
                        source, value = f"{label}:{match}", supplied[match]
                        break
            if field == "api_key":
                if value is None and profile == "deepseek" and runtime_key:
                    source, value = ".runtime/deepseek.key", runtime_key
                credential = value or ""
                credential_status = "missing" if not credential else (
                    "placeholder" if placeholder(credential) else "provided")
                if placeholder(credential):
                    missing.append(f"{aliases[0]} ({credential_status})")
            elif field in {"json_mode", "thinking_disabled"}:
                if isinstance(value, str):
                    if value.lower() not in {"true", "false", "1", "0"}:
                        errors.append(f"{aliases[0]} must be true/false or 1/0")
                        continue
                    value = value.lower() in {"true", "1"}
                if value is not None:
                    config["capabilities"][field] = value
            elif value is not None:
                config[field] = value
            elif profile == "compatible":
                missing.append(aliases[0])
            defaulted = field != "api_key" and not (profile == "compatible" and field in {"base_url", "model"})
            sources[field] = source or ("existing_profile_default" if defaulted else "absent")
        settings = None
        if not any(name in missing for name in ("COMPATIBLE_BASE_URL", "COMPATIBLE_MODEL")):
            try:
                settings = normalize_config(config)
            except ValueError as error:
                errors.append(str(error))
        resolved.append({"profile": profile, "credential": credential, "settings": settings,
                         "credential_status": credential_status,
                         "input_sources": sources, "missing_inputs": missing, "config_errors": errors,
                         "available": not missing and not errors})
    return resolved


def sanitize(value, secrets):
    """Redact supplied credentials, including URL/JSON-escaped echoes, recursively."""
    if isinstance(value, dict):
        return {sanitize(str(key), secrets): sanitize(item, secrets) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [sanitize(item, secrets) for item in value]
    if isinstance(value, str):
        variants = {variant for secret in secrets if secret for variant in (
            secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret)[1:-1])}
        for secret in sorted(variants, key=len, reverse=True):
            value = value.replace(secret, "[REDACTED]")
        return value
    return value


def save_report(path, report, secrets):
    """Persist only sanitized evidence; a pre-dispatch record survives a lost response."""
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(sanitize(report, secrets), ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    temporary.replace(path)


def make_translator(settings, credential, scratch):
    """Use the existing translator and keep upstream mutable assets in runtime scratch."""
    if "babeldoc.const" not in sys.modules:
        import engine
        previous_cache = engine.CACHE
        try:
            engine.CACHE = scratch / "cache"
            engine.localize_cache()
        finally:
            engine.CACHE = previous_cache
    from deepseek import DeepSeekTranslator
    translator = DeepSeekTranslator(document_title="Provider compatibility probe",
                                   document_key="provider-compatibility-probe",
                                   paragraph_cache=scratch / "paragraphs.sqlite",
                                   usage_path=scratch / "usage.json", lang_in="en",
                                   api_key=credential,
                                   **{key: value for key, value in settings.items() if key != "pages"})
    translator.client.max_retries = 0
    translator.client.timeout = REQUEST_TIMEOUT_SECONDS
    return translator


def error_evidence(error):
    """Preserve original provider type/message/status/body rather than a generic wrapper."""
    return {"type": type(error).__name__, "message": str(error),
            "status_code": getattr(error, "status_code", None),
            "body": getattr(error, "body", None), "request_id": getattr(error, "request_id", None)}


def response_evidence(response):
    """Retain exact reported usage and distinguish API acceptance from valid translation."""
    usage = getattr(response, "usage", None)
    reported = usage.model_dump() if usage is not None else None
    choices = getattr(response, "choices", None) or []
    choice = choices[0] if choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    finish = getattr(choice, "finish_reason", None)
    valid, changed, validation_error = False, None, None
    try:
        if finish in {"length", "content_filter"}:
            raise ValueError("Provider output was truncated or filtered")
        items = json.loads(content)["translations"]
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            raise ValueError("Expected exactly one translation item")
        item = items[0]
        if not (type(item.get("id")) is int and item["id"] == 0 or item.get("id") == "0"):
            raise ValueError("Expected paragraph ID 0")
        if not isinstance(item.get("text"), str) or not item["text"].strip():
            raise ValueError("Expected nonempty translation text")
        valid, changed = True, item["text"].strip() != PROBE_TEXT
    except (ValueError, TypeError, KeyError) as error:
        validation_error = str(error)
    usage_known = (reported is not None and all(type(reported.get(field)) is int and reported[field] >= 0
                   for field in ("prompt_tokens", "completion_tokens")))
    return {"outcome": "validated_translation" if valid and changed else "invalid_or_unchanged_translation",
            "response": {"id": getattr(response, "id", None), "model": getattr(response, "model", None),
                         "finish_reason": finish, "content": content, "usage": reported},
            "compatibility": {"chat_completion_responded": True, "translation_json_valid": valid,
                              "translation_changed": changed, "validation_error": validation_error,
                              "semantic_quality": "not_verified"},
            "usage_status": "reported" if usage_known else "unknown"}


def verify_profile(profile, row, checkpoint, scratch):
    """Invoke the existing direct request once; never retry or call a fallback service."""
    translator = None
    try:
        translator = make_translator(profile["settings"], profile["credential"], scratch)
        messages = translator.messages([{"id": 0, "input": PROBE_TEXT}])
        row.update(outcome="in_flight", request_invocations=1, usage_status="unknown", billing="unknown")
        checkpoint()
        # Avoid translate_items: it wraps original errors and includes paragraph-cache handling.
        response = translator.request_completion(messages)
        row.update(response_evidence(response))
    except (Exception, KeyboardInterrupt) as error:
        row.update(outcome="provider_error" if row["request_invocations"] else "initialization_error",
                   error=error_evidence(error))
        row["compatibility"] = {"http_status": getattr(error, "status_code", None),
                                "translation_json_valid": None, "semantic_quality": "not_verified"}
        if isinstance(error, KeyboardInterrupt):
            raise
    finally:
        checkpoint()
        if translator is not None:
            translator.client.close()


def main(argv=None):
    """Write a new report, defaulting to inspection with zero network requests."""
    options = parser().parse_args(argv)
    inputs = load_inputs(options.env_file)
    resolved = profiles(options, inputs)
    secrets = inputs[3]
    path = options.report or ROOT / ".runtime" / (
        "provider-verification-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
    path = path.resolve()
    if not any(path.is_relative_to((ROOT / folder).resolve()) for folder in (".runtime", "agent/codex")):
        parser().error("--report must be under project .runtime or agent/codex")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8"):
            pass
    except FileExistsError:
        parser().error("--report already exists; choose a new evidence path")
    report = {"schema_version": 1, "mode": "run" if options.run else "inspect",
              "created_at": datetime.now(timezone.utc).isoformat(), "scope": "direct_provider_only",
              "limits": {"requests_per_profile": 1, "max_output_tokens": options.max_tokens,
                         "sdk_retries": 0, "timeout_seconds": REQUEST_TIMEOUT_SECONDS, "fallback": False},
              "billing_note": "No invoice or price lookup; monetary billing remains unknown after any dispatch.",
              "warnings": inputs[4], "profiles": []}
    for profile in resolved:
        report["profiles"].append({key: value for key, value in profile.items() if key != "credential"})
        report["profiles"][-1].update(outcome="not_called", request_invocations=0, usage_status="not_called",
                                      billing="not_called")

    def checkpoint():
        """Keep the total and sanitized durable outcomes synchronized."""
        report["request_invocations"] = sum(row["request_invocations"] for row in report["profiles"])
        save_report(path, report, secrets)

    checkpoint()
    interrupted = False
    if options.run:
        # Third-party debug logging can include headers; only sanitized evidence reaches output.
        previous_logging = logging.root.manager.disable
        logging.disable(logging.CRITICAL)
        try:
            (ROOT / ".runtime").mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="provider-probe-", dir=ROOT / ".runtime") as scratch:
                for profile, row in zip(resolved, report["profiles"]):
                    if profile["available"]:
                        verify_profile(profile, row, checkpoint, Path(scratch) / profile["profile"])
        except KeyboardInterrupt:
            interrupted = True
        finally:
            logging.disable(previous_logging)
    print(sanitize(f"Report: {path}", secrets))
    print(f"Request invocations: {report['request_invocations']} (SDK retries: 0; fallback: none)")
    for row in sanitize(report["profiles"], secrets):
        print(f"{row['profile']}: {row['outcome']}")
        for reason in row["missing_inputs"] + row["config_errors"]:
            print(f"  {reason}")
    if interrupted:
        return 130
    return int(options.run and any(row["outcome"] != "validated_translation" for row in report["profiles"]))


if __name__ == "__main__":
    raise SystemExit(main())
