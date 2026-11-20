#!/usr/bin/env bash
# Run real backend and synthetic annotation/rendering suites in an official, isolated macOS Zotero.
set -euo pipefail
# Resolve only this checkout; neither /Applications nor daily profiles are used.
root="$(cd "$(dirname "$0")/.." && pwd)"
# Optional explicit candidates otherwise use the workflow's standard dist names.
bundled_xpi=""; local_xpi=""

# Describe the two already-built package inputs without starting native tools.
usage() {
  printf 'Usage: bash %s [--bundled-xpi PATH] [--local-xpi PATH]\n' "$0"
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --bundled-xpi|--local-xpi)
      [[ $# -ge 2 && "$2" != --* ]] || { usage >&2; exit 2; }
      if [[ "$1" == --bundled-xpi ]]; then bundled_xpi="$2"; else local_xpi="$2"; fi
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$(uname -s):$(uname -m)" == Darwin:arm64 ]] || { echo 'Native macOS arm64 is required.' >&2; exit 1; }
# Discard host Python/loader injection, retaining the runner's GUI environment.
for name in PYTHONPATH PYTHONHOME ${!LD_@} ${!DYLD_@}; do unset "$name"; done
# Both preparation and the local variant use this exact project interpreter.
python="$root/.venv/bin/python"
[[ -x "$python" ]] || { echo 'Project .venv/bin/python is unavailable.' >&2; exit 1; }
# Only native acceptance evidence and a private official client installation are created.
artifact="$root/dist/candidate-native-zotero"
mkdir -p "$artifact" "$root/.tools"
tools="$(mktemp -d "$root/.tools/zotero-native-macos.XXXXXX")"
# Detach only this unique mount, never force-unmount or alter an application signature.
trap 'hdiutil detach "$tools/mount" >> "$artifact/install-${tools##*/}.log" 2>&1 || true' EXIT
"$python" -I -B - "$root" "$tools" "$bundled_xpi" "$local_xpi" <<'PY'
"""Retain actual native results and normal process exits, including explicit failures."""
import hashlib
import json
import os
import platform
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Pin the same official client used for Linux/Windows native acceptance.
ZOTERO_VERSION = "10.0.8"
# Use only the fixed official DMG URL, never an unsigned mirror or moving channel.
OFFICIAL_URL = "https://www.zotero.org/download/client/dl?channel=release&version=10.0.8&platform=mac"
# Allow ten minutes per real GUI phase; timeout must never kill Zotero.
PHASE_TIMEOUT = 600
# Public installer/preparation commands get five minutes, separate from native UI work.
INSTALL_TIMEOUT = 300
# Keep client, mount and all reports inside the calling checkout.
root, tools = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
artifact = root / "dist/candidate-native-zotero"
# Fresh suite IDs include the actual GitHub run identity and package variant.
token = f"macos-{os.environ.get('GITHUB_RUN_ID', 'local')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}-{time.time_ns()}"
# Fresh native profiles cannot inherit provider credentials or host loader paths.
env = {key: value for key, value in os.environ.items()
       if not re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I)}
env.update(ORT_DISABLE_TELEMETRY="1", HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")


def logged(command, path):
    """Capture bounded installer/preparation output without hiding failures."""
    with path.open("a", encoding="utf-8") as log:
        log.write(shlex.join(command) + "\n")
        log.flush()
        subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                       timeout=INSTALL_TIMEOUT, check=True)


def configure_gui(profile):
    """Apply hosted-runner rendering and update preferences only to this disposable profile."""
    with (profile / "user.js").open("a", encoding="utf-8") as prefs:
        for key in ("extensions.zotero.firstRun2", "app.update.enabled", "extensions.update.enabled"):
            prefs.write(f"\nuser_pref({json.dumps(key)}, false);\n")
        # Hosted Mac VMs use Gecko's supported software renderer, not a simulated GUI.
        for key in ("gfx.webrender.software", "layers.acceleration.disabled"):
            prefs.write(f"\nuser_pref({json.dumps(key)}, true);\n")


def launch_native(profile, prefix, report, result, suite):
    """Retain actual launcher/native identities and receipts; never kill a timed-out client."""
    command = ["open", "-W", "-n", str(app), "--args", "-no-remote", "-profile", str(profile)]
    with Path(str(prefix) + "-launch.log").open("w", encoding="utf-8") as log:
        log.write(shlex.join(command) + "\n")
        log.flush()
        process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        result["pid"] = process.pid
        try:
            result["exitCode"] = process.wait(timeout=PHASE_TIMEOUT)
        except subprocess.TimeoutExpired:
            result["error"] = "Zotero did not exit normally; left running without kill or profile/lock changes"
    result["pidExited"] = process.poll() is not None
    native = {}
    if report.exists():
        shutil.copyfile(report, Path(str(prefix) + ".json"))
        native = json.loads(report.read_text())
    helper_error = root / f".runtime/{suite}-test.json"
    if not native and helper_error.is_file():
        shutil.copyfile(helper_error, Path(str(prefix) + "-helper-error.json"))
    result.update(nativePID=native.get("processID"), nativePIDExited=False)
    if isinstance(result["nativePID"], int) and result["nativePID"] > 0:
        try:
            os.kill(result["nativePID"], 0)
        except ProcessLookupError:
            result["nativePIDExited"] = True
    return native


# Missing native reports remain unknown, never fabricated provider/check successes.
summary = {"ok": False, "status": "error", "sourceCommit": None, "zoteroVersion": None,
           "officialURL": OFFICIAL_URL, "providerCalls": None, "physicalInput": False, "inputMethod": "Gecko trusted only",
           "semanticAcceptance": False, "publicUpdateAcceptance": False, "variants": [], "errors": []}
try:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("The project interpreter must also be native macOS arm64")
    summary["sourceCommit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    version = json.loads((root / "addon/manifest.json").read_text())["version"]
    for variant, supplied in zip(("bundled", "local"), sys.argv[3:5]):
        suffix = "-local-python" if variant == "local" else ""
        xpi = (Path(supplied) if supplied else root / f"dist/paperbridge-{version}-macos-arm64{suffix}.xpi").resolve()
        with xpi.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        summary["variants"].append({"variant": variant, "xpi": str(xpi), "actualSHA256": digest,
                                    "runID": f"{token}-{variant}", "phases": []})
    install_log = artifact / f"install-{tools.name}.log"
    dmg, mount, app = tools / "Zotero.dmg", tools / "mount", tools / "Zotero.app"
    mount.mkdir()
    logged(["curl", "--fail", "--location", "--max-time", str(INSTALL_TIMEOUT), OFFICIAL_URL, "--output", str(dmg)], install_log)
    logged(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(dmg)], install_log)
    logged(["ditto", str(mount / "Zotero.app"), str(app)], install_log)
    with (app / "Contents/Info.plist").open("rb") as stream:
        summary["zoteroVersion"] = plistlib.load(stream)["CFBundleShortVersionString"]
    if summary["zoteroVersion"] != ZOTERO_VERSION:
        raise RuntimeError("Downloaded official app has an unexpected Zotero version")
    import pymupdf
    fixture = root / ".runtime/annotations-fixture"
    fixture.mkdir(parents=True, exist_ok=True)
    for kind in ("source", "translated"):
        with pymupdf.open() as document:
            page = document.new_page(width=612, height=792)
            lines = [f"Synthetic {kind} annotation fixture", "Select this separate line for native underline.",
                     "Synthetic fixture, not a model translation."]
            for index, text in enumerate(lines):
                # Use 12-point text, a 72-point inset and 34-point spacing; lower-left stays blank.
                page.insert_text((72, 72 + index * 34), text, fontsize=12)
            # Page two probes native tab/rendering recovery, not semantic translation acceptance.
            page = document.new_page(width=612, height=792)
            page.insert_text((72, 72), f"Synthetic {kind} second-page rendering fixture", fontsize=12)
            document.save(fixture / f"{kind}.pdf")
    for variant in summary["variants"]:
        run_id = variant["runID"]
        profile = root / f".runtime/annotations-{run_id}-profile"
        data = root / f".runtime/annotations-{run_id}-data"
        if profile.exists() or data.exists():
            raise RuntimeError("Create requires a fresh isolated profile/data pair")
        variant.update(profile=str(profile), data=str(data))
        previous_pid = None
        for phase, expected in (("create", 29), ("reopen", 12)):
            prefix = artifact / f"{run_id}-{phase}"
            result = {"phase": phase, "ok": False, "expectedChecks": expected, "actualChecks": None,
                      "pid": None, "pidExited": False, "previousPID": previous_pid, "exitCode": None}
            variant["phases"].append(result)
            command = [str(root / ".venv/bin/python"), "-I", "-B", "scripts/prepare_packaged_test.py",
                       "--suite", "annotations", "--phase", phase, "--run-id", run_id, "--xpi", variant["xpi"]]
            if variant["variant"] == "local":
                command.extend(["--local-python", str(root / ".venv/bin/python")])
            logged(command, Path(str(prefix) + "-prepare.log"))
            configure_gui(profile)
            report = root / f".runtime/annotations-{run_id}-{phase}.json"
            native = launch_native(profile, prefix, report, result, "annotations")
            checks = native.get("checks", [])
            result.update(actualChecks=len(checks) if native else None,
                          providerCalls=native.get("providerCalls"), zoteroVersion=native.get("zoteroVersion"))
            result["ok"] = (result["exitCode"] == 0 and result["pidExited"] and result["nativePIDExited"]
                            and result["nativePID"] != previous_pid
                            and native.get("ok") is True and native.get("stage") == "complete"
                            and bool(checks) and all(check.get("pass") is True for check in checks)
                            and not native.get("errors") and native.get("providerCalls") == 0
                            and native.get("nativeUI") is True and native.get("zoteroVersion") == ZOTERO_VERSION)
            if not result["pidExited"]:
                raise RuntimeError(result["error"])
            if not result["ok"]:
                summary["errors"].append(f"{run_id} {phase} failed; see retained native report/launch log")
                break
            previous_pid = result["nativePID"]
    for variant in summary["variants"]:
        # Short suite IDs retain native run/variant uniqueness without exceeding the existing guard.
        run_id = "mac-engine-" + hashlib.sha256(variant["runID"].encode()).hexdigest()[:12]
        profile = root / f".runtime/runtime-terms-{run_id}-profile"
        if profile.exists() or (root / f".runtime/runtime-terms-{run_id}-data").exists():
            raise RuntimeError("Backend acceptance requires fresh disposable directories")
        variant["enginePhases"] = []
        previous_pid = None
        for phase in ("create", "reopen"):
            prefix = artifact / f"{run_id}-{phase}"
            result = {"phase": phase, "ok": False, "previousPID": previous_pid, "exitCode": None}
            variant["enginePhases"].append(result)
            command = [str(root / ".venv/bin/python"), "-I", "-B", "scripts/prepare_nonmac_test.py",
                       "--suite", "runtime-terms", "--run-id", run_id, "--phase", phase,
                       "--xpi", variant["xpi"], "--expected-version", version]
            if variant["variant"] == "local":
                command.extend(["--local-python", str(root / ".venv/bin/python")])
            logged(command, Path(str(prefix) + "-prepare.log"))
            configure_gui(profile)
            report = root / f".runtime/runtime-terms-{run_id}-{phase}.json"
            native = launch_native(profile, prefix, report, result, "runtime-terms")
            checks = native.get("checks", [])
            result.update(actualChecks=len(checks) if native else None, health=native.get("health"),
                          forbiddenRequests=native.get("forbiddenRequests"))
            result["ok"] = (result["exitCode"] == 0 and result["pidExited"] and result["nativePIDExited"]
                            and result["nativePID"] != previous_pid and native.get("os") == "Darwin"
                            and native.get("ok") is True and native.get("stage") == "complete"
                            and bool(checks) and all(check.get("ok") is True for check in checks)
                            and not native.get("errors") and native.get("forbiddenRequests") == 0
                            and native.get("health", {}).get("version") == version)
            # The suite blocks fee-bearing routes and verifies an empty real job store before success.
            result["providerCalls"] = 0 if result["ok"] else None
            if not result["pidExited"]:
                raise RuntimeError(result["error"])
            if not result["ok"]:
                summary["errors"].append(f"{run_id} {phase} backend failed; see retained native report")
                break
            previous_pid = result["nativePID"]
    phases = [phase for variant in summary["variants"] for phase in variant["phases"]]
    engines = [phase for variant in summary["variants"] for phase in variant["enginePhases"]]
    summary["nativeBackendStartup"] = len(engines) == 4 and all(phase["ok"] for phase in engines)
    observations = phases + engines
    summary["providerCalls"] = sum(phase["providerCalls"] for phase in observations) if all(
        phase.get("providerCalls") is not None for phase in observations) else None
    summary["ok"] = (len(phases) == 4 and all(phase["ok"] for phase in phases)
                     and summary["nativeBackendStartup"] and not summary["errors"])
    summary["status"] = "ok" if summary["ok"] else "error"
except Exception as error:
    summary["errors"].append(f"{type(error).__name__}: {error}")
finally:
    output = artifact / f"summary-{token}.json"
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(output)
sys.exit(0 if summary["ok"] else 1)
PY
