"""Install the release XPI in a project-local, disposable Zotero profile."""
import argparse
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument("--restart-check",action="store_true")
options=parser.parse_args()
marker=ROOT / ".runtime/zotero042-restart-check"
if options.restart_check:
    marker.parent.mkdir(parents=True,exist_ok=True)
    marker.write_text("restart and engine upgrade verification")
else:
    marker.unlink(missing_ok=True)
PROFILE = ROOT / ".runtime/zotero042-profile"
DATA = ROOT / ".runtime/zotero042-data"
EXTENSIONS = PROFILE / "extensions"
EXTENSIONS.mkdir(parents=True, exist_ok=True)
DATA.mkdir(parents=True, exist_ok=True)
version = json.loads((ROOT / "addon/manifest.json").read_text())["version"]
shutil.copyfile(ROOT / f"dist/paperbridge-{version}-macos-arm64.xpi", EXTENSIONS / "paperbridge@local.dev.xpi")
manifest = {"manifest_version": 2, "name": "PaperBridge Zotero 10 isolated tests", "version": version,
            "applications": {"zotero": {"id": "paperbridge-tests@local.dev", "strict_min_version": "9.0",
                                         "strict_max_version": "10.*", "update_url": "https://example.invalid/paperbridge-tests.json"}}}
bootstrap = '''function install(){} function uninstall(){} function shutdown(){}
async function startup(){
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  for(let i=0;i<200&&!Zotero.PaperBridge;i++) await Zotero.Promise.delay(100);
  const uri=await IOUtils.exists(RESTART_MARKER) ? RESTART_URI : TEST_URI;
  Services.scriptloader.loadSubScriptWithOptions(uri, {ignoreCache:true,target:{Zotero,Services,IOUtils,PathUtils,Cc,Ci,Components,ChromeUtils,PAPERBRIDGE_TEST_ROOT:ROOT}});
}'''.replace("TEST_URI", json.dumps((ROOT / "tests/zotero_10.js").as_uri())).replace("ROOT}});", json.dumps(str(ROOT)) + "}});")
bootstrap=bootstrap.replace("RESTART_MARKER",json.dumps(str(marker))).replace("RESTART_URI",json.dumps((ROOT / "tests/zotero_042_restart.js").as_uri()))
with zipfile.ZipFile(EXTENSIONS / "paperbridge-tests@local.dev.xpi", "w") as archive:
    archive.writestr("manifest.json", json.dumps(manifest))
    archive.writestr("bootstrap.js", bootstrap)
prefs = {"extensions.zotero.dataDir": str(DATA), "extensions.zotero.useDataDir": True,
         "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15, "extensions.startupScanScopes": 15,
         "xpinstall.signatures.required": False, "browser.shell.checkDefaultBrowser": False,
         "app.update.auto": False, "app.update.enabled": False, "extensions.zotero.firstRun": False}
(PROFILE / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()))
for name in ["addonStartup.json.lz4", "extensions.json"]:
    (PROFILE / name).unlink(missing_ok=True)
shutil.rmtree(PROFILE / "startupCache", ignore_errors=True)
print(PROFILE)
