"""Install the actual XPI plus a separate test harness into a disposable profile."""
import json
import platform
import shutil
import sys
import zipfile
import argparse
from pathlib import Path

# Keep generated integration-test files inside this checkout.
ROOT = Path(__file__).resolve().parents[1]


def build_platform():
    """Use the same platform IDs as the released XPI runtime."""
    machine = platform.machine().lower()
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64"
    if sys.platform == "linux" and machine in {"amd64", "x86_64"}:
        return "linux-x64"
    raise SystemExit(f"Unsupported test platform: {sys.platform} {platform.machine()}")


# The helper add-on must support exactly the same Zotero versions as the real add-on.
addon_manifest=json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))
version=addon_manifest["version"]
parser = argparse.ArgumentParser()
parser.add_argument("--local-python", default="", help="Existing Python 3.12 interpreter to test")
parser.add_argument("--suite", choices=["packaged", "queue", "alignment", "annotations", "upgrade"], default="packaged",
                    help="Queue/alignment/annotations/upgrade smoke uses isolated profiles")
parser.add_argument("--phase", choices=["create", "reopen"], default="create", help="Annotation persistence phase")
parser.add_argument("--run-id", default="", help="Optional isolated profile suffix, retained across restart phases")
parser.add_argument("--xpi", type=Path, help="Explicit historical XPI for an isolated upgrade baseline")
parser.add_argument("--reader-pdf", action="append", nargs=2, default=[], metavar=("PDF", "PAGE"),
                    help="Optional translated PDF and one-based page to open during upgrade reopen")
parser.add_argument("--link-pdf", type=Path, help="Optional two-page synthetic PDF for a native internal-link click")
options = parser.parse_args()
if options.run_id and (not options.run_id.replace("-", "").replace("_", "").isalnum() or len(options.run_id) > 64):
    parser.error("run-id must contain only letters, numbers, '-' or '_'")
if any(not page.isdigit() or int(page) < 1 for _, page in options.reader_pdf):
    parser.error("reader-pdf PAGE must be a positive one-based page number")
# A named run does not overwrite an earlier suite's profile or cached test credentials.
run_name = options.suite + ("-" + options.run_id if options.run_id else "")
# Each suite owns its profile and data, never the user's normal Zotero library.
PROFILE = ROOT / f".runtime/{run_name}-profile"
DATA = ROOT / f".runtime/{run_name}-data"
PROFILE.mkdir(parents=True, exist_ok=True)
extensions = PROFILE / "extensions"
extensions.mkdir(exist_ok=True)
suffix = "-local-python" if options.local_python else ""
# Explicit old packages can seed an upgrade test without changing source version metadata.
package = options.xpi or ROOT / f"dist/paperbridge-{version}-{build_platform()}{suffix}.xpi"
with zipfile.ZipFile(package) as archive:
    package_version = json.loads(archive.read("manifest.json"))["version"]
shutil.copyfile(package, extensions / "paperbridge@local.dev.xpi")
(ROOT / ".runtime/packaged-options.json").write_text(json.dumps({"pythonPath":options.local_python}))
manifest = {"manifest_version":2,"name":"PaperBridge isolated integration tests","version":version,
    "applications":{"zotero":{"id":"paperbridge-tests@local.dev",
    "strict_min_version":addon_manifest["applications"]["zotero"]["strict_min_version"],
    "strict_max_version":addon_manifest["applications"]["zotero"]["strict_max_version"],
    "update_url":"https://example.invalid/tests.json"}}}
bootstrap = '''function install(){} function uninstall(){} function shutdown(){}
function startup(){
  // Zotero awaits each add-on's startup; do not block the real add-on's startup.
  runTests().catch(async error => {
    Zotero.logError(error);
    await IOUtils.writeUTF8(PathUtils.join(PROJECT_ROOT_LITERAL, ".runtime", "packaged-test.json"),
      JSON.stringify({ok:false,error:String(error),stack:error.stack},null,2));
  });
}
async function runTests(){
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  for(let i=0;i<100&&!Zotero.PaperBridge;i++) await Zotero.Promise.delay(100);
  if(!Zotero.PaperBridge) throw new Error("PaperBridge did not start within 10 seconds");
  Services.scriptloader.loadSubScript(TEST_URI, {Zotero,Services,IOUtils,PathUtils,Cc,Ci,Components,ChromeUtils,PAPERBRIDGE_TEST_ROOT:PROJECT_ROOT_LITERAL});
}'''.replace("TEST_URI",json.dumps((ROOT / ("tests/" + {"packaged": "packaged.js", "queue": "queue_packaged.js",
    "alignment": "alignment_packaged.js", "annotations": "annotations_packaged.js",
    "upgrade": "upgrade_packaged.js"}[options.suite])).as_uri())).replace("PROJECT_ROOT_LITERAL",json.dumps(str(ROOT)))
if options.suite != "packaged":
    bootstrap = bootstrap.replace("packaged-test.json", options.suite + "-test.json")
if options.suite == "annotations":
    annotation_options = {"isolated": True, "expectedProfileDirectory": str(PROFILE),
        "expectedDataDirectory": str(DATA), "phase": options.phase,
        "sourcePDF": str(ROOT / ".runtime/annotations-fixture/source.pdf"),
        "translatedPDF": str(ROOT / ".runtime/annotations-fixture/translated.pdf"),
        "statePath": str(ROOT / f".runtime/{run_name}-state.json"),
        "reportPath": str(ROOT / f".runtime/{run_name}-{options.phase}.json"), "quit": True}
    bootstrap = bootstrap.replace("PAPERBRIDGE_TEST_ROOT:" + json.dumps(str(ROOT)),
        "PAPERBRIDGE_ANNOTATIONS_TEST:" + json.dumps(annotation_options) + ",PAPERBRIDGE_TEST_ROOT:" + json.dumps(str(ROOT)))
elif options.suite == "upgrade":
    upgrade_options = {"isolated": True, "expectedProfileDirectory": str(PROFILE),
        "expectedDataDirectory": str(DATA), "phase": options.phase, "expectedVersion": package_version,
        "sourcePDF": str(ROOT / ".runtime/annotations-fixture/source.pdf"),
        "translatedPDF": str(ROOT / ".runtime/annotations-fixture/translated.pdf"),
        "statePath": str(ROOT / f".runtime/{run_name}-state.json"),
        "reportPath": str(ROOT / f".runtime/{run_name}-{options.phase}.json"),
        "readerPDFs": [{"path": str(Path(path).resolve()), "page": int(page)} for path, page in options.reader_pdf],
        "linkPDF": str(options.link_pdf.resolve()) if options.link_pdf else None}
    bootstrap = bootstrap.replace("PAPERBRIDGE_TEST_ROOT:" + json.dumps(str(ROOT)),
        "PAPERBRIDGE_UPGRADE_TEST:" + json.dumps(upgrade_options) + ",PAPERBRIDGE_TEST_ROOT:" + json.dumps(str(ROOT)))
with zipfile.ZipFile(extensions / "paperbridge-tests@local.dev.xpi","w") as z:
    z.writestr("manifest.json",json.dumps(manifest))
    z.writestr("bootstrap.js",bootstrap)
prefs = {"extensions.zotero.dataDir":str(DATA),"extensions.zotero.useDataDir":True,
    "extensions.paperbridge.pythonPath": options.local_python,
    "extensions.autoDisableScopes":0,"extensions.enabledScopes":15,"extensions.startupScanScopes":15,
    "xpinstall.signatures.required":False,"browser.shell.checkDefaultBrowser":False}
DATA.mkdir(exist_ok=True)
(PROFILE / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k,v in prefs.items()))
for name in ["addonStartup.json.lz4","extensions.json"]:
    (PROFILE / name).unlink(missing_ok=True)
shutil.rmtree(PROFILE / "startupCache",ignore_errors=True)
print(PROFILE)
