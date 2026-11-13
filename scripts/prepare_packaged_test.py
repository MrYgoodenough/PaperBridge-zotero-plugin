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
parser.add_argument("--suite", choices=["packaged", "queue", "alignment"], default="packaged",
                    help="Queue/alignment smoke uses separate profiles and no provider calls")
options = parser.parse_args()
# Each suite owns its profile and data, never the user's normal Zotero library.
PROFILE = ROOT / f".runtime/{options.suite}-profile"
PROFILE.mkdir(parents=True, exist_ok=True)
extensions = PROFILE / "extensions"
extensions.mkdir(exist_ok=True)
suffix = "-local-python" if options.local_python else ""
shutil.copyfile(ROOT / f"dist/paperbridge-{version}-{build_platform()}{suffix}.xpi", extensions / "paperbridge@local.dev.xpi")
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
    "alignment": "alignment_packaged.js"}[options.suite])).as_uri())).replace("PROJECT_ROOT_LITERAL",json.dumps(str(ROOT)))
if options.suite != "packaged":
    bootstrap = bootstrap.replace("packaged-test.json", options.suite + "-test.json")
with zipfile.ZipFile(extensions / "paperbridge-tests@local.dev.xpi","w") as z:
    z.writestr("manifest.json",json.dumps(manifest))
    z.writestr("bootstrap.js",bootstrap)
prefs = {"extensions.zotero.dataDir":str(ROOT / f".runtime/{options.suite}-data"),"extensions.zotero.useDataDir":True,
    "extensions.paperbridge.pythonPath": options.local_python,
    "extensions.autoDisableScopes":0,"extensions.enabledScopes":15,"extensions.startupScanScopes":15,
    "xpinstall.signatures.required":False,"browser.shell.checkDefaultBrowser":False}
(ROOT / f".runtime/{options.suite}-data").mkdir(exist_ok=True)
(PROFILE / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k,v in prefs.items()))
for name in ["addonStartup.json.lz4","extensions.json"]:
    (PROFILE / name).unlink(missing_ok=True)
shutil.rmtree(PROFILE / "startupCache",ignore_errors=True)
print(PROFILE)
