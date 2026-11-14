"""Build private ZIP summaries from an explicit allowlist, never from log folders."""
import json
import os
import platform
import re
import sys
import tempfile
import tomllib
import zipfile
from collections.abc import Mapping
from importlib import metadata
from pathlib import Path

# Only these public states may be copied into aggregate counters.
_JOB_STATES = ("queued", "running", "cancelling", "done", "failed", "cancelled", "interrupted", "unknown")
# Quality is structural evidence, not a claim about semantic translation accuracy.
_QUALITY_STATES = ("complete", "partial", "unusable", "unknown")
# Fixed lifecycle values may appear in an anonymous timeline, never raw messages.
_STARTUP_STAGES = ("starting", "unpacking", "selecting_python", "launching", "waiting", "ready", "failed")
# These phases come from the existing engine progress protocol.
_JOB_PHASES = ("preparing", "parsing", "translating", "typesetting", "restoring", "finished")
# Stable public error codes contain no provider response or document content.
_ERROR_CODES = ("startup", "resource", "long_path", "file_busy", "provider", "provider_format", "general")
# Keep recent useful transitions, not every percentage update or unbounded logs.
_STARTUP_EVENT_LIMIT = 32
# A retry retains a small shared history in the existing job record.
_JOB_EVENT_LIMIT = 64
# Only UTC ISO timestamps may leave local records.
_TIME_PATTERN = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)")
# Version strings must be numeric release identifiers, never arbitrary metadata text.
_VERSION_PATTERN = re.compile(r"\d+(?:\.\d+){1,3}(?:(?:a|b|rc)\d+)?")
# The code root contains only the explicitly selected version metadata below.
_ROOT = Path(__file__).resolve().parents[1]


def _safe_version(value):
    """Accept a release version only; discard paths or injected metadata."""
    return value if isinstance(value, str) and _VERSION_PATTERN.fullmatch(value) else "unknown"


def _versions():
    """Read only app release metadata and installed distribution versions."""
    app_version = "unknown"
    try:
        # Packaged runtimes have this marker; source checkouts have pyproject.toml.
        if (_ROOT / "installed.json").is_file():
            app_version = _safe_version(json.loads((_ROOT / "installed.json").read_text(encoding="utf-8")).get("version"))
        else:
            with (_ROOT / "pyproject.toml").open("rb") as stream:
                app_version = _safe_version(tomllib.load(stream).get("project", {}).get("version"))
    except (OSError, ValueError, AttributeError):
        pass
    result = {"paperbridge": app_version, "python": ".".join(map(str, sys.version_info[:3]))}
    for name in ("babeldoc", "pymupdf"):
        try:
            result[name] = _safe_version(metadata.version(name))
        except metadata.PackageNotFoundError:
            result[name] = "unknown"
    return result


def _jobs(store_or_jobs):
    """Accept a store or public job list without reading job files ourselves."""
    if callable(getattr(store_or_jobs, "list_jobs", None)):
        return store_or_jobs.list_jobs()
    if callable(getattr(store_or_jobs, "list", None)):
        return store_or_jobs.list()
    if isinstance(store_or_jobs, Mapping):
        store_or_jobs = store_or_jobs.get("jobs")
    if not isinstance(store_or_jobs, (list, tuple)):
        raise TypeError("Diagnostics requires a public job list or job store")
    return store_or_jobs


def _warning_count(store_or_jobs):
    """Count preserved record warnings without reading their text or paths."""
    if isinstance(store_or_jobs, Mapping):
        count = store_or_jobs.get("warning_count")
        return count if type(count) is int and count >= 0 else None
    warnings = getattr(store_or_jobs, "load_warnings", None)
    return len(warnings) if isinstance(warnings, (list, tuple)) else None


def _timeline(events, startup=False):
    """Copy only fixed states, numeric attempts and UTC timestamps from recent events."""
    limit = _STARTUP_EVENT_LIMIT if startup else _JOB_EVENT_LIMIT
    result = []
    for event in (events if isinstance(events, (list, tuple)) else ())[-limit:]:
        if not isinstance(event, Mapping):
            continue
        at = event.get("at")
        name = "stage" if startup else "state"
        states = _STARTUP_STAGES if startup else _JOB_STATES
        if not isinstance(at, str) or not _TIME_PATTERN.fullmatch(at) or event.get(name) not in states:
            continue
        code = event.get("code")
        entry = {"at": at, name: event[name], "code": code if code in _ERROR_CODES else None}
        if not startup:
            phase = event.get("phase")
            attempt = event.get("attempt")
            entry.update(phase=phase if phase in _JOB_PHASES else None,
                         attempt=attempt if type(attempt) is int and attempt > 0 else None)
        result.append(entry)
    return result


def _summary(store_or_jobs, startup=None):
    """Count states and anonymize timelines without copying identifiers, errors or config."""
    tasks = {"total": 0, "states": dict.fromkeys(_JOB_STATES, 0), "quality": dict.fromkeys(_QUALITY_STATES, 0)}
    job_events = []
    for job in _jobs(store_or_jobs):
        tasks["total"] += 1
        job = job if isinstance(job, Mapping) else {}
        state = job.get("state")
        state = state if isinstance(state, str) and state in _JOB_STATES else "unknown"
        quality = job.get("quality")
        quality = quality.get("status") if isinstance(quality, Mapping) else None
        quality = quality if isinstance(quality, str) and quality in _QUALITY_STATES else "unknown"
        tasks["states"][state] += 1
        tasks["quality"][quality] += 1
        job_events.append({"task": tasks["total"], "events": _timeline(job.get("events"))})
    # Do not include hostnames, OS builds, executable paths, or environment variables.
    system = {"linux": "linux", "win32": "windows", "darwin": "macos"}.get(sys.platform, "other")
    machine = platform.machine().lower()
    architecture = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, "other")
    return {"schema_version": 2, "versions": _versions(), "platform": {"system": system, "architecture": architecture},
            "tasks": tasks, "events": {"startup": _timeline(startup, startup=True), "jobs": job_events},
            "runtime_status": {"engine_ready": True, "export_source": "backend"},
            "safety": {"export_scope": "allowlist_only", "warning_count": _warning_count(store_or_jobs), "credentials_included": False,
            "document_content_included": False, "user_paths_included": False, "raw_logs_included": False}}


def create_bundle(store_or_jobs, state_root, startup=None):
    """Return a new ZIP Path under state_root/diagnostics; never overwrite a bundle."""
    # Build the safe payload before creating files; no directory contents are scanned.
    payload = json.dumps(_summary(store_or_jobs, startup), ensure_ascii=False, indent=2).encode("utf-8")
    destination = Path(state_root) / "diagnostics"
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix="PaperBridge-diagnostics-", suffix=".zip", dir=destination)
    path = Path(filename)
    try:
        # mkstemp reserves a unique private file; ZIP entries are constructed in memory.
        with os.fdopen(descriptor, "wb") as stream, zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("diagnostics.json", payload)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path
