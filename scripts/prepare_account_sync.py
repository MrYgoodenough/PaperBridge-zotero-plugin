"""Prepare an opt-in native account-sync helper without copying credentials or library databases."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

# Test artifacts and options remain in the checkout, never in a release XPI.
ROOT = Path(__file__).resolve().parents[1]
# This helper is separate from both the real plugin and isolated acceptance helpers.
HELPER_ID = "paperbridge-account-acceptance@local.dev"


def prepare(options):
    """Bind every phase to explicit real profile, data directory, account and immutable evidence paths."""
    if not options.run_id.replace("-", "").isalnum() or len(options.run_id) > 32:
        raise ValueError("Use a short alphanumeric/hyphen run ID")
    profile, data = options.profile.resolve(), options.data.resolve()
    if not profile.is_dir() or not (data / "zotero.sqlite").is_file():
        raise ValueError("Supply the already signed-in profile and its existing Zotero data directory")
    if options.phase == "produce" and not options.allow_library_file_sync:
        raise ValueError("PDF production uploads library files; explicit file-sync authorization is required")
    directory = options.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    label = options.phase + ("-" + options.label if options.label else "")
    if not label.replace("-", "").isalnum():
        raise ValueError("Use an alphanumeric/hyphen report label")
    report = directory / f"account-{options.run_id}-{label}.json"
    if report.exists():
        raise ValueError("Evidence already exists; choose a new report label")
    config_path = directory / f"account-{options.run_id}-options.json"
    config = {
        "allowRealAccount": True, "phase": options.phase, "runID": options.run_id,
        "expectedAccount": options.account, "expectedProfileDirectory": str(profile),
        "expectedDataDirectory": str(data), "reportPath": str(report),
        "statePath": str(directory / f"account-{options.run_id}-state.json"),
        "expectedVersion": options.version, "quit": not options.keep_open,
        "allowLibraryFileSync": options.allow_library_file_sync,
    }
    for argument, field in (("cases", "caseManifest"), ("index", "producerIndex"), ("xpi", "candidateXpi")):
        path = getattr(options, argument)
        if path:
            config[field] = str(path.resolve())
    if options.xpi:
        with options.xpi.open("rb") as stream:
            config["candidateSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    helper = directory / f"account-{options.run_id}-helper.xpi"
    manifest = {"manifest_version": 2, "name": "PaperBridge authorized account acceptance", "version": "1.0",
                "applications": {"zotero": {"id": HELPER_ID, "strict_min_version": "10.0",
                                           "strict_max_version": "10.*"}}}
    bootstrap = """/** Run only the explicitly authorized account phase without exporting any credential. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils */
/** The helper never installs or changes the real plugin during its own installation. */
function install() {}
/** Removing the helper leaves the account and all reading assets intact. */
function uninstall() {}
/** The phase owns normal reader cleanup; preferences are restored before quit. */
function shutdown() {}
/** Dispatch after Zotero and the production plugin finish startup. */
function startup() { run().catch(error => Zotero.logError(error)); }
/** Read non-secret external options; no auth/NSS or database is copied. */
async function run() {
  const config = JSON.parse(await IOUtils.readUTF8(CONFIG_PATH));
  // Never replay a completed or interrupted account mutation on an ordinary daily launch.
  if (await IOUtils.exists(config.reportPath)) return;
  const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
  const normalize = value => Services.appinfo.OS === "WINNT"
    ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
  if (config.allowRealAccount !== true || normalize(profile) !== normalize(config.expectedProfileDirectory)) return;
  // Stop startup/background sync before it can schedule a whole-library attachment upload.
  const preference = "extensions.zotero.sync.autoSync";
  // A stopped-state launcher may suppress startup sync before the helper is first installed.
  const beforeLaunch = config.autoSyncPreferenceBeforeLaunch;
  const hadPreference = beforeLaunch ? beforeLaunch.hadUserValue : Services.prefs.prefHasUserValue(preference);
  const previous = beforeLaunch ? beforeLaunch.value : Services.prefs.getBoolPref(preference, true);
  Services.prefs.setBoolPref(preference, false);
  config.startupSyncSuppressed = true;
  // The outer helper restores preferences and evidence before requesting normal shutdown.
  const shouldQuit = config.quit;
  config.quit = false;
  try {
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify({ok:false, phase:config.phase,
      stage:"helper-initialization", processID:Services.appinfo.processID, checks:[]}));
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    const scope = {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils,
      PAPERBRIDGE_ACCOUNT_SYNC_TEST: config};
    Services.scriptloader.loadSubScript(TEST_URI, scope);
    await scope.PAPERBRIDGE_ACCOUNT_SYNC_PROMISE;
  } catch (error) {
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify({ok:false, phase:config.phase,
      stage:"helper-error", processID:Services.appinfo.processID, checks:[],
      error:{name:error.name || "Error", message:"Account helper initialization failed; see the native Zotero error"}}));
    Zotero.logError(error);
  } finally {
    const report = JSON.parse(await IOUtils.readUTF8(config.reportPath));
    if (hadPreference) Services.prefs.setBoolPref(preference, previous);
    else Services.prefs.clearUserPref(preference);
    report.automaticSyncPreferenceRestored = Services.prefs.getBoolPref(preference, true) === previous
      && Services.prefs.prefHasUserValue(preference) === hadPreference;
    // Do not yield to background sync between preference restoration and normal quit.
    Zotero.File.putContents(Zotero.File.pathToFile(config.reportPath), JSON.stringify(report, null, 2));
    if (shouldQuit) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}
"""
    bootstrap = bootstrap.replace("CONFIG_PATH", json.dumps(str(config_path)))
    bootstrap = bootstrap.replace("TEST_URI", json.dumps((ROOT / "tests/account_sync_packaged.js").as_uri()))
    with zipfile.ZipFile(helper, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("bootstrap.js", bootstrap)
    # Existing daily profiles may not scan sideloaded files; use Zotero's native plugin installer.
    return {"profile": str(profile), "data": str(data), "report": str(report), "helper": str(helper),
            "config": str(config_path), "helper_id": HELPER_ID,
            "helper_installation": "Install the helper XPI through Zotero AddonManager, not a profile file copy"}


def main():
    """Require explicit opt-in paths rather than discovering or seeding an account profile."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--phase", choices=("inspect", "install", "produce", "receive", "download", "reopen",
                                            "metadata-produce", "metadata-receive", "metadata-reopen"), required=True)
    parser.add_argument("--version", default="0.3.6")
    parser.add_argument("--cases", type=Path)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--xpi", type=Path)
    parser.add_argument("--label", default="")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "agent/codex/account-acceptance")
    parser.add_argument("--allow-library-file-sync", action="store_true",
                        help="Only with separate user authorization; native upload can include all library files")
    parser.add_argument("--keep-open", action="store_true")
    print(json.dumps(prepare(parser.parse_args()), ensure_ascii=False))


if __name__ == "__main__":
    main()
