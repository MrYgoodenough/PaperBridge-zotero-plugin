"""Prepare isolated native suites; upgrade installs and cold reopens stay separate."""

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
    runtime_terms = options.suite == "runtime-terms"
    if runtime_terms and options.phase not in {"create", "reopen"}:
        raise ValueError("Runtime terms support only create and cold reopen")
    if runtime_terms and (options.case_manifest or options.upgrade_xpi or options.paragraph_cache):
        raise ValueError("Runtime terms use only their exact candidate and optional synthetic --source-pdf")
    source_pdf = getattr(options, "source_pdf", None)
    if source_pdf and not runtime_terms:
        raise ValueError("--source-pdf is reserved for the isolated runtime-terms suite")
    if options.phase == "install" and (options.suite != "upgrade" or not options.upgrade_xpi):
        raise ValueError("The install phase requires the upgrade suite and an exact candidate XPI")
    if options.windows_supplement and (options.suite != "upgrade" or options.phase != "reopen"
                                      or sys.platform != "win32"):
        raise ValueError("Windows notes require the native Windows upgrade reopen phase")
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
    if runtime_terms:
        # Inspect the candidate before creating directories; the native helper performs installation.
        if options.phase == "reopen":
            retained = json.loads((ROOT / ".runtime" / (name + "-options.json")).read_text(encoding="utf-8"))
            package = options.xpi or Path(retained["candidateXpi"])
        with zipfile.ZipFile(package) as archive:
            candidate = json.loads(archive.read("manifest.json"))
            build = json.loads(archive.read(f"runtime/{platform_id()}/runtime.json"))
        if candidate["applications"]["zotero"]["id"] != ADDON_ID or build["platform"] != platform_id():
            raise ValueError("Runtime terms need the actual native PaperBridge candidate")
        if build["pythonMode"] not in {"bundled", "local"}:
            raise ValueError("Unknown candidate Python mode")
        if options.expected_version and options.expected_version != candidate["version"]:
            raise ValueError("Expected version does not match the selected candidate")
        if source_pdf:
            with source_pdf.open("rb") as stream:
                if stream.read(5) != b"%PDF-":
                    raise ValueError("--source-pdf must be an explicitly supplied synthetic PDF")
    config_path = ROOT / ".runtime" / (name + "-options.json")
    if options.report_label and (len(options.report_label) > 32 or not options.report_label.replace("-", "").isalnum()):
        raise ValueError("Use a short alphanumeric/hyphen report label")
    label = "-" + options.report_label if options.report_label else ""
    report_path = ROOT / ".runtime" / (name + "-" + options.phase + label + ".json")
    if report_path.exists():
        raise ValueError("This phase already has evidence; choose a new run ID or report label")
    create_profile = options.phase == "create" or options.phase == "receive"
    if create_profile:
        if profile.exists() or data.exists():
            raise ValueError("A create phase requires a new isolated profile/data pair")
        extensions.mkdir(parents=True)
        data.mkdir()
        if not runtime_terms:
            shutil.copyfile(package, addon)
    elif not all(path.exists() for path in (profile, data, addon, helper, config_path)):
        raise ValueError("Reopen requires the retained create profile, data and installed add-ons")
    with zipfile.ZipFile(package if runtime_terms else addon) as archive:
        installed = json.loads(archive.read("manifest.json"))
    config = {"isolated": True, "phase": options.phase,
              "expectedProfileDirectory": str(profile), "expectedDataDirectory": str(data),
              "reportPath": str(report_path), "statePath": str(ROOT / ".runtime" / (name + "-state.json")),
              "expectedVersion": options.expected_version or installed["version"],
              "pythonPath": options.local_python, "quit": True}
    if create_profile:
        config["baselineVersion"] = installed["version"]
        with (package if runtime_terms else addon).open("rb") as stream:
            config["baselineXpiSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    else:
        previous = json.loads(config_path.read_text(encoding="utf-8"))
        config.update({key: previous[key] for key in ("baselineVersion", "baselineXpiSha256")})
    if runtime_terms:
        candidate_hash = config["baselineXpiSha256"]
        if not create_profile:
            with package.open("rb") as stream:
                candidate_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if not create_profile and (previous.get("suite") != "runtime-terms"
                                   or previous.get("candidateSha256") != candidate_hash):
            raise ValueError("Cold runtime-terms reopen must retain the same exact candidate")
        config.update(suite="runtime-terms", runID=options.run_id,
                      candidateXpi=str(package.resolve()), candidateSha256=candidate_hash,
                      expectedPlatform=platform_id(), expectedMode=build["pythonMode"],
                      expectedBuildId=build["buildId"])
        if source_pdf:
            config["sourcePDF"] = str(source_pdf.resolve())
        elif not create_profile and previous.get("sourcePDF"):
            config["sourcePDF"] = previous["sourcePDF"]
    if options.case_manifest:
        config["caseManifest"] = str(options.case_manifest.resolve())
        if options.suite == "upgrade":
            cases = json.loads(options.case_manifest.read_text(encoding="utf-8"))["cases"]
            config.update(sourcePDF=cases[0]["source_pdf"], translatedPDF=cases[0]["translated_pdf"],
                          notePageIndex=cases[0]["selected_pages_one_based"][0] - 1,
                          notePaperTitle=cases[0].get("title"),
                          noteSelectionText=cases[0].get("selection_text"),
                          readerPDFs=[{"path": case["translated_pdf"], "page": page,
                                       "searchTerm": "机器学习" if case["id"] == "scikit-learn-2011" else "600,000"}
                                      for case in cases for page in case["selected_pages_one_based"]])
    if options.suite == "upgrade" and not options.case_manifest:
        raise ValueError("An upgrade test needs an explicit real case manifest")
    if options.upgrade_xpi:
        with zipfile.ZipFile(options.upgrade_xpi) as archive:
            candidate = json.loads(archive.read("manifest.json"))
        config.update(upgradeXpi=str(options.upgrade_xpi.resolve()), upgradeVersion=candidate["version"],
                      upgradeSha256=hashlib.sha256(options.upgrade_xpi.read_bytes()).hexdigest())
    if options.paragraph_cache:
        config["paragraphCachePath"] = str(options.paragraph_cache.resolve())
    if options.expected_xpi:
        config["expectedXpiPath"] = str(options.expected_xpi.resolve())
        with options.expected_xpi.open("rb") as stream:
            config["expectedXpiSha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    if options.windows_supplement:
        # Independent view runs must not discard the note identity needed by a later cold reopen.
        supplement_state = (previous.get("supplementStatePath")
                            if options.windows_supplement in {"reopen", "views"} else None)
        if not supplement_state and options.windows_supplement != "reopen":
            supplement_state = str(ROOT / ".runtime" / (name + "-windows-notes" + label + ".json"))
        if not supplement_state:
            raise ValueError("Cold Windows notes need the previous exercise's explicit state path")
        config.update(supplementPhase=options.windows_supplement,
                      supplementStatePath=supplement_state)
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    if create_profile:
        # Reading external options at startup keeps the installed helper unchanged across cold restarts.
        bootstrap = """/** Run isolated native acceptance without blocking the real add-on's startup. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils */
// Keep launch failures observable even when the acceptance script cannot load.
var testConfig;
/** The helper owns no persistent production state. */
function install() {}
/** Keep acceptance evidence when removing the helper. */
function uninstall() {}
/** The native test owns its explicit save/quit sequence. */
function shutdown() {}
/** Dispatch after other add-ons finish their startup callbacks. */
function startup() {
  runTests().catch(failed);
}
/** Report helper failures only inside the explicitly prepared test profile. */
async function failed(error) {
  Zotero.logError(error);
  if (testConfig?.suite === "runtime-terms" && !testConfig.runtimeTermsHelperSafe) return;
  if (!testConfig?.isolated || PathUtils.normalize(Services.dirsvc.get("ProfD", Ci.nsIFile).path)
      !== PathUtils.normalize(testConfig.expectedProfileDirectory)) return;
  const report = {ok: false, phase: testConfig.phase, stage: "helper-error", checks: [],
    processID: Services.appinfo.processID, errors: [{message: String(error), stack: error.stack || ""}]};
  try { await IOUtils.writeUTF8(testConfig.reportPath, JSON.stringify(report, null, 2)); }
  finally { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); }
}
/** Load the caller-owned configuration after native startup. */
async function runTests() {
  const config = testConfig = JSON.parse(await IOUtils.readUTF8(CONFIG_PATH));
  if (config.suite === "runtime-terms") {
    // No report writes, native installation or quit outside this exact disposable suite.
    await Zotero.initializationPromise;
    /** Resolve new report/state names through their existing native parent directory. */
    const normalize = path => {
      let result;
      try { result = PathUtils.normalize(path); }
      catch (error) {
        if (!String(error).includes("NS_ERROR_FILE_NOT_FOUND")) throw error;
        result = PathUtils.join(PathUtils.normalize(PathUtils.parent(path)), PathUtils.filename(path));
      }
      return Services.appinfo.OS === "WINNT" ? result.toLowerCase() : result;
    };
    const base = "runtime-terms-" + config.runID;
    const directory = PathUtils.join(ROOT_PATH, ".runtime");
    // Compare canonical parents plus literal suite names; symlinked daily profiles are not allowed.
    const suiteName = Services.appinfo.OS === "WINNT" ? base.toLowerCase() : base;
    if (!config.isolated || !/^[a-z0-9-]{1,32}$/i.test(config.runID)
        || normalize(config.expectedProfileDirectory) !== PathUtils.join(normalize(directory), suiteName + "-profile")
        || normalize(config.expectedDataDirectory) !== PathUtils.join(normalize(directory), suiteName + "-data")
        || normalize(Services.dirsvc.get("ProfD", Ci.nsIFile).path) !== normalize(config.expectedProfileDirectory)
        || normalize(Zotero.DataDirectory.dir) !== normalize(config.expectedDataDirectory)
        || normalize(PathUtils.parent(config.reportPath)) !== normalize(directory)
        || !new RegExp("^" + base + "-" + config.phase + "(?:-[a-z0-9-]{1,32})?\\\\.json$", "i")
          .test(PathUtils.filename(config.reportPath))
        || normalize(config.statePath) !== normalize(PathUtils.join(directory, base + "-state.json"))
        || await IOUtils.exists(config.reportPath)) throw new Error("Unsafe runtime-terms profile/data or existing evidence");
    config.runtimeTermsHelperSafe = true;
  }
  await helperCheckpoint("helper-initialization");
  await Zotero.initializationPromise;
  await helperCheckpoint("helper-ui-ready");
  await Zotero.uiReadyPromise;
  await helperCheckpoint("helper-script-loading");
  if (!(config.suite === "runtime-terms" && config.phase === "create")) {
    for (let attempt = 0; attempt < 300 && !Zotero.PaperBridge; attempt++) await Zotero.Promise.delay(100);
  }
  const scope = {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils,
    PAPERBRIDGE_TEST_ROOT: ROOT_PATH, TEST_GLOBAL: config};
  if (config.supplementPhase) {
    Services.scriptloader.loadSubScript(SUPPLEMENT_URI, scope);
  }
  Services.scriptloader.loadSubScript(TEST_URI, scope);
  if (scope.PAPERBRIDGE_UPDATE_TEST_PROMISE) await scope.PAPERBRIDGE_UPDATE_TEST_PROMISE;
  if (scope.PAPERBRIDGE_UPGRADE_TEST_PROMISE) await scope.PAPERBRIDGE_UPGRADE_TEST_PROMISE;
  if (scope.PAPERBRIDGE_ASSETS_TEST_PROMISE) await scope.PAPERBRIDGE_ASSETS_TEST_PROMISE;
  if (scope.PAPERBRIDGE_RUNTIME_TERMS_TEST_PROMISE) await scope.PAPERBRIDGE_RUNTIME_TERMS_TEST_PROMISE;
}
/** Retain actual helper progress before the acceptance script owns its own report. */
async function helperCheckpoint(stage) {
  await IOUtils.writeUTF8(testConfig.reportPath, JSON.stringify({ok: false, phase: testConfig.phase,
    stage, processID: Services.appinfo.processID, checks: []}, null, 2));
}
"""
        script, global_name = {
            "reading": ("reading_packaged.js", "PAPERBRIDGE_READING_TEST"),
            "update": ("update_packaged.js", "PAPERBRIDGE_UPDATE_TEST"),
            "alignment": ("alignment_packaged.js", "PAPERBRIDGE_ALIGNMENT_TEST"),
            "upgrade": ("upgrade_packaged.js", "PAPERBRIDGE_UPGRADE_TEST"),
            "assets": ("assets_packaged.js", "PAPERBRIDGE_ASSETS_TEST"),
            "runtime-terms": ("runtime_terms_packaged.js", "PAPERBRIDGE_RUNTIME_TERMS_TEST"),
        }[options.suite]
        for key, value in {"CONFIG_PATH": json.dumps(str(config_path)),
                           "SUPPLEMENT_URI": json.dumps((ROOT / "tests/windows_supplement_packaged.js").as_uri()),
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
        if runtime_terms:
            # This fresh profile must never attempt account sync during the consent exercise.
            prefs["extensions.zotero.sync.autoSync"] = False
        (profile / "user.js").write_text("\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()), encoding="utf-8")
    return {"profile": str(profile), "data": str(data), "report": str(report_path), "config": str(config_path)}


def main():
    """Expose explicit artifacts and cold phases without guessing or modifying public feeds."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("reading", "update", "alignment", "upgrade", "assets", "runtime-terms"), required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--phase", choices=("create", "install", "reopen", "receive"), default="create")
    parser.add_argument("--xpi", type=Path, help="Exact baseline/test XPI, installed only during create")
    parser.add_argument("--local-python", default="")
    parser.add_argument("--source-pdf", type=Path,
                        help="Runtime-terms only: explicit synthetic PDF fixture, never a user library/cache")
    parser.add_argument("--case-manifest", type=Path)
    parser.add_argument("--expected-version", default="")
    parser.add_argument("--expected-xpi", type=Path)
    parser.add_argument("--upgrade-xpi", type=Path, help="Native file-install candidate, never a public update claim")
    parser.add_argument("--paragraph-cache", type=Path, help="Explicit cache database for byte-preservation checks")
    parser.add_argument("--windows-supplement", choices=("exercise", "notes", "reopen", "views"),
                        help="Full native exercise, note-only exercise, cold notes, or independent DPI views")
    parser.add_argument("--report-label", default="", help="Retain a failed phase report while retrying the same isolated profile")
    print(json.dumps(prepare(parser.parse_args()), ensure_ascii=False))


if __name__ == "__main__":
    main()
