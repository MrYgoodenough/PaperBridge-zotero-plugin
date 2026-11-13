"""Persist observed usage and paragraph outcomes, never prompts or credentials."""
import hashlib
import json
import logging
import threading
from pathlib import Path

from babeldoc.translator.translator import OpenAITranslator

# These skips are deliberate exclusions, not evidence of translation failure.
EXPECTED_SKIPS = {"numeric", "placeholder_only", "short_text"}
# Progress observers must never change the quality or provider outcome.
LOGGER = logging.getLogger(__name__)


def write_json(path, report):
    """Atomically replace a UTF-8 sidecar; callers serialize concurrent writes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def token_value(value):
    """Accept only reported nonnegative token counts; absence remains unknown."""
    return value if type(value) is int and value >= 0 else None


class ResultQuality:
    """Track pinned-engine evidence separately from PDF production and API usage."""

    def __init__(self, path):
        """Start with unknown coverage until the IL translation stage is observed."""
        self.path = Path(path)
        self.lock = threading.RLock()
        self.paragraphs = {}
        self.inventory_observed = False
        self.stage_completed = False
        self.artifact_exists = False
        self.finalized = False
        self.engine_error = None
        self.on_change = None

    def _notify(self, report=None):
        """Deliver ordered snapshots under the quality lock; observer failures are advisory."""
        with self.lock:
            if self.on_change is not None:
                try:
                    self.on_change(self.report() if report is None else report)
                except Exception:
                    LOGGER.warning("Unable to report paragraph progress; quality tracking continues")

    def register(self, key, text, page=None):
        """Assign a local evidence ID without persisting paragraph text."""
        with self.lock:
            if key not in self.paragraphs:
                source = text if isinstance(text, str) else ""
                self.paragraphs[key] = {
                    "id": len(self.paragraphs) + 1, "page": page,
                    "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                    "source_characters": len(source), "status": "pending", "attempts": 0,
                    "cache_hits": 0, "validated": False, "applied": False,
                    "fallbacks": 0, "failures": [], "skip_reason": None, "unchanged": False,
                }
                self._notify()
            return key

    def record(self, key, event, reason=None):
        """Record bounded evidence while retaining failures even after a recovery."""
        with self.lock:
            row = self.paragraphs[key]
            if event == "attempt":
                row["attempts"] += 1
                row["status"] = "attempted"
            elif event == "cache":
                row["cache_hits"] += 1
                row["validated"] = True
                row["status"] = "validated"
            elif event == "validated":
                row["validated"] = True
                row["status"] = "validated"
            elif event == "unchanged":
                row["unchanged"] = True
            elif event == "success":
                row["applied"] = True
                row["status"] = "unknown" if row["unchanged"] else (
                    "cache" if row["cache_hits"] else "success")
            elif event == "skip":
                row["status"], row["skip_reason"] = "skipped", reason
            elif event == "failure":
                row["status"] = "failed"
                if reason not in row["failures"]:
                    row["failures"].append(reason)
            elif event == "fallback":
                row["fallbacks"] += 1
            self._notify()

    def finish_pending(self, keys):
        """Expose upstream returns that neither applied nor explicitly skipped text."""
        with self.lock:
            for key in keys:
                if self.paragraphs[key]["status"] in {"pending", "attempted", "validated"}:
                    self.record(key, "failure", "upstream_did_not_apply")

    def report(self):
        """Classify observable coverage, not linguistic correctness or PDF existence alone."""
        with self.lock:
            rows = [dict(row, failures=list(row["failures"])) for row in self.paragraphs.values()]
            if self.finalized:
                for row in rows:
                    if row["status"] in {"pending", "attempted", "validated"}:
                        row["status"] = "unknown"
            counts = {name: sum(row["status"] == name for row in rows)
                      for name in ("success", "cache", "skipped", "failed", "unknown")}
            unresolved = sum(row["status"] in {"pending", "attempted", "validated", "unknown"}
                             or (row["status"] == "skipped" and row["skip_reason"] not in EXPECTED_SKIPS)
                             for row in rows)
            good = counts["success"] + counts["cache"]
            status = "unknown"
            if self.finalized and not self.artifact_exists:
                status = "unusable"
            elif self.artifact_exists:
                if good and self.finalized and self.inventory_observed and self.stage_completed and not (
                        counts["failed"] or unresolved or self.engine_error):
                    status = "complete"
                elif good:
                    status = "partial"
                elif counts["failed"]:
                    status = "unusable"
            return {"schema_version": 1, "status": status, "scope": "selected_pages",
                    "basis": "paragraph_application_evidence_not_linguistic_verification",
                    "artifact_exists": self.artifact_exists, "finalized": self.finalized,
                    "inventory_observed": self.inventory_observed,
                    "translation_stage_completed": self.stage_completed, "engine_error": self.engine_error,
                    "counts": {"total": len(rows), **counts, "unresolved": unresolved,
                               "attempts": sum(row["attempts"] for row in rows),
                               "cache_hits": sum(row["cache_hits"] for row in rows),
                               "fallbacks": sum(row["fallbacks"] for row in rows),
                               "failure_events": sum(len(row["failures"]) for row in rows)},
                    "paragraphs": [dict(row, failures=list(row["failures"])) for row in rows]}

    def write(self, **state):
        """Persist a snapshot, including on failure or before a potentially lost request."""
        with self.lock:
            for name, value in state.items():
                setattr(self, name, value)
            report = self.report()
            write_json(self.path, report)
            self._notify(report)
            return report


class MeteredTranslator(OpenAITranslator):
    """Count physical requests and reported tokens independently of their outcomes."""

    def __init__(self, usage_path, **kwargs):
        """Disable SDK retries and create an empty, thread-safe request ledger."""
        super().__init__(**kwargs)
        self.client.max_retries = 0
        self.usage_path = Path(usage_path)
        self.usage_lock = threading.RLock()
        self.requests = []
        self.paragraph_cache_hits = 0
        self.request_context = threading.local()
        self.usage_extra = {}

    def begin_request(self):
        """Write unknown billing before sending, so process loss stays visible."""
        with self.usage_lock:
            row = {"status": "in_flight", "billing": "unknown", "prompt_tokens": None,
                   "prompt_cache_hit_tokens": None, "prompt_cache_miss_tokens": None,
                   "completion_tokens": None, "request_id": None,
                   **getattr(self.request_context, "metadata", {})}
            self.requests.append(row)
            self.request_context.request_index = len(self.requests) - 1
            self.write_usage()

    def fail_request(self, error):
        """Keep failed or lost responses billable-unknown without persisting error bodies."""
        with self.usage_lock:
            index = getattr(self.request_context, "request_index", None)
            if index is not None:
                self.requests[index].update(status="failed", billing="unknown", error_type=type(error).__name__)
                self.request_context.request_index = None
                self.write_usage()

    def update_token_count(self, response):
        """Record actual provider counts; missing usage or cache splits remain unknown."""
        super().update_token_count(response)
        usage = getattr(response, "usage", None)
        prompt = token_value(getattr(usage, "prompt_tokens", None))
        completion = token_value(getattr(usage, "completion_tokens", None))
        hit = token_value(getattr(usage, "prompt_cache_hit_tokens", None))
        if hit is None:
            hit = token_value(getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", None))
        miss = token_value(getattr(usage, "prompt_cache_miss_tokens", None))
        # A reported total and one reported split allow exact arithmetic, not an estimate.
        if miss is None and prompt is not None and hit is not None and hit <= prompt:
            miss = prompt - hit
        with self.usage_lock:
            index = getattr(self.request_context, "request_index", None)
            if index is None:
                self.begin_request()
                index = self.request_context.request_index
            self.requests[index].update(
                status="responded", billing="reported" if prompt is not None and completion is not None else "unknown",
                prompt_tokens=prompt, prompt_cache_hit_tokens=hit, prompt_cache_miss_tokens=miss,
                completion_tokens=completion, request_id=getattr(response, "id", None))
            self.request_context.request_index = None
            self.write_usage()

    def write_usage(self, **extra):
        """Persist observed sums with explicit uncertainty; never estimate lost tokens or money."""
        with self.usage_lock:
            self.usage_extra.update(extra)
            unknown = sum(row["billing"] == "unknown" for row in self.requests)
            report = {"schema_version": 2, "model": self.model, "api_requests": len(self.requests),
                      "failed_requests": sum(row["status"] == "failed" for row in self.requests),
                      "in_flight_requests": sum(row["status"] == "in_flight" for row in self.requests),
                      "unknown_usage_requests": unknown, "billing_uncertain": bool(unknown),
                      "token_totals_are_partial": bool(unknown),
                      "cache_usage_complete": all(row["prompt_cache_hit_tokens"] is not None
                                                  and row["prompt_cache_miss_tokens"] is not None
                                                  for row in self.requests),
                      "local_cache_hits": self.translate_cache_call_count,
                      "paragraph_cache_hits": self.paragraph_cache_hits, "requests": self.requests,
                      **self.usage_extra}
            for output, field in (("input_tokens", "prompt_tokens"), ("cached_input_tokens", "prompt_cache_hit_tokens"),
                                  ("uncached_input_tokens", "prompt_cache_miss_tokens"),
                                  ("output_tokens", "completion_tokens")):
                report[output] = sum(row[field] for row in self.requests if row[field] is not None)
            write_json(self.usage_path, report)
