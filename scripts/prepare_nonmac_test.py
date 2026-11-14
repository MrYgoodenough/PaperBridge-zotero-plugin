"""Prepare isolated reading/update checks without replacing installed add-ons on reopen."""

import argparse
import hashlib
import json
import platform
import shutil
import sys
import zipfile
from pathlib import Path

# All profiles, configuration and reports belong to this checkout, not the daily library.
ROOT = Path(__file__).resolve().parents[1]
# The real extension identity remains identical across platform-specific update channels.
ADDON_ID = "paperbridge@local.dev"
# The helper is never included in a shipped XPI or installed in a daily profile.
HELPER_ID = "paperbridge-tests@local.dev"


def platform_id():
    """Select only native Linux/Windows artifacts for this acceptance task."""
    if sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"}:
        return "windows-x64"
    if sys.platform == "linux" and platform.machine().lower() in {"amd64", "x86_64"}:
        return "linux-x64"
    raise ValueError("This acceptance helper supports native Linux/Windows only")


def prepare(options):
    """Install once; subsequent phases only update the external helper configuration."""
    if not options.run_id or len(options.run_id) > 32 or not options.run_id.replace("-", "").isalnum():
        raise ValueError("Use a short alphanumeric/hyphen run ID")
    name = options.suite + "-" + options.run_id
    profile, data = (ROOT / ".runtime" / (name + suffix) for suffix in ("-profile", "-data"))
    extensions = profile / "extensions"
    addon = extensions / (ADDON_ID + ".xpi")
    helper = extensions / (HELPER_ID + ".xpi")
    source_manifest = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))
    suffix = "-local-python" if options.local_python else ""
    package = options.xpi or ROOT / "dist" / f"paperbridge-{source_manifest['version']}-{platform_id()}{suffix}.xpi"
    config_path = ROOT / ".runtime" / (name + "-options.json")
    report_path = ROOT / ".runtime" / (name + "-" + options.phase + ".json")
    if report_path.exists():
        raise ValueError("This phase already has evidence; choose a new run ID")
    if options.phase == "create":
        if profile.exists() or data.exists():
            raise ValueError("A create phase requires a new isolated profile/data pair")
        extensions.mkdir(parents=True)
        data.mkdir()
        shutil.copyfile(package, addon)
    elif not all(path.exists() for path in (profile, data, addon, helper, config_path)):
        raise ValueError("Reopen requires the retained create profile, data and installed add-ons")
    with zipfile.ZipFile(addon) as archive:
        installed = json.loads(archive.read("manifest.json"))
    config = {"isolated": True, "phase": options.phase,
              "expectedProfileDirectory": str(profile), "expectedDataDirectory": str(data),
              "reportPath": str(report_path), "statePath": str(ROOT / ".runtime" / (name + "-state.json")),
              "expectedVersion": options.expected_version or installed["version"],
              "pythonPath": options.local_python, "quit": True}
    if options.phase == "create":
        config["baselineVersion"] = installed["version"]
        with addon.open("rb") as stream:
            config["baselineXpiSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    else:
        previous = json.loads(config_path.read_text(encoding="utf-8"))
        config.update({key: previous[key] for key in ("baselineVersion", "baselineXpiSha256")})
    if options.case_manifest:
        config["caseManifest"] = str(options.case_manifest.resolve())
    if options.expected_xpi:
        config["expectedXpiPath"] = str(options.expected_xpi.resolve())
        with options.expected_xpi.open("rb") as stream:
            config["expectedXpiSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    if options.phase == "create":
        # Reading external options at startup keeps the installed helper unchanged across cold restarts.
        bootstrap = """/** Run isolated native acceptance without blocking the real add-on's startup. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils */
/** The helper owns no persistent production state. */
function install() {}
/** Keep acceptance evidence when removing the helper. */
function uninstall() {}
/** The native test owns its explicit save/quit sequence. */
function shutdown() {}
/** Dispatch after other add-ons finish their startup callbacks. */
function startup() {
  runTests().catch(error => Zotero.logError(error));
}
/** Load the caller-owned configuration after native startup. */
async function runTests() {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const config = JSON.parse(await IOUtils.readUTF8(CONFIG_PATH));
  for (let attempt = 0; attempt < 300 && !Zotero.PaperBridge; attempt++) await Zotero.Promise.delay(100);
  Services.scriptloader.loadSubScript(TEST_URI,
    {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils,
      PAPERBRIDGE_TEST_ROOT: ROOT_PATH, TEST_GLOBAL: config});
}
"""
        script = "reading_packaged.js" if options.suite == "reading" else "update_packaged.js"
        global_name = "PAPERBRIDGE_READING_TEST" if options.suite == "reading" else "PAPERBRIDGE_UPDATE_TEST"
        for key, value in {"CONFIG_PATH": json.dumps(str(config_path)),
                           "TEST_URI": json.dumps((ROOT / "tests" / script).as_uri()),
                           "ROOT_PATH": json.dumps(str(ROOT)), "TEST_GLOBAL": global_name}.items():
            bootstrap = bootstrap.replace(key, value)
        compatibility = source_manifest["applications"]["zotero"]
        manifest = {"manifest_version": 2, "name": "PaperBridge isolated non-macOS acceptance", "version": "1.0",
                    "applications": {"zotero": {"id": HELPER_ID,
                        "strict_min_version": compatibility["strict_min_version"],
                        "strict_max_version": compatibility["strict_max_version"],
                        "update_url": "https://example.invalid/paperbridge-tests.json"}}}
        with zipfile.ZipFile(helper, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("bootstrap.js", bootstrap)
        prefs = {"extensions.zotero.dataDir": str(data), "extensions.zotero.useDataDir": True,
                 "extensions.paperbridge.pythonPath": options.local_python,
                 "extensions.zotero.firstRun2": False, "extensions.autoDisableScopes": 0,
                 "extensions.enabledScopes": 15, "extensions.startupScanScopes": 15,
                 "xpinstall.signatures.required": False, "browser.shell.checkDefaultBrowser": False}
        (profile / "user.js").write_text("\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()), encoding="utf-8")
    return {"profile": str(profile), "data": str(data), "report": str(report_path), "config": str(config_path)}


def main():
    """Expose explicit artifacts and cold phases without guessing or modifying public feeds."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("reading", "update"), required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--phase", choices=("create", "reopen"), default="create")
    parser.add_argument("--xpi", type=Path, help="Exact baseline/test XPI, installed only during create")
    parser.add_argument("--local-python", default="")
    parser.add_argument("--case-manifest", type=Path)
    parser.add_argument("--expected-version", default="")
    parser.add_argument("--expected-xpi", type=Path)
    print(json.dumps(prepare(parser.parse_args()), ensure_ascii=False))


if __name__ == "__main__":
    main()
