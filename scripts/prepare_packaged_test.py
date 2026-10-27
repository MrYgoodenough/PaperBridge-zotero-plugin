"""Install the actual XPI plus a separate test harness into a disposable profile."""
import json
import shutil
import zipfile
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT / ".runtime/packaged-profile"
PROFILE.mkdir(exist_ok=True)
extensions = PROFILE / "extensions"
extensions.mkdir(exist_ok=True)
version=json.loads((ROOT / "addon/manifest.json").read_text())["version"]
parser = argparse.ArgumentParser()
parser.add_argument("--local-python", default="", help="Existing arm64 Python 3.12 interpreter to test")
options = parser.parse_args()
suffix = "-local-python" if options.local_python else ""
shutil.copyfile(ROOT / f"dist/paperbridge-{version}-macos-arm64{suffix}.xpi", extensions / "paperbridge@local.dev.xpi")
(ROOT / ".runtime/packaged-options.json").write_text(json.dumps({"pythonPath":options.local_python}))
manifest = {"manifest_version":2,"name":"PaperBridge isolated integration tests","version":version,
    "applications":{"zotero":{"id":"paperbridge-tests@local.dev","strict_min_version":"9.0",
    "strict_max_version":"9.*","update_url":"https://example.invalid/tests.json"}}}
bootstrap = '''function install(){} function uninstall(){} function shutdown(){}
async function startup(){
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  for(let i=0;i<100&&!Zotero.PaperBridge;i++) await Zotero.Promise.delay(100);
  Services.scriptloader.loadSubScript(TEST_URI, {Zotero,Services,IOUtils,PathUtils,Cc,Ci,Components,ChromeUtils,PAPERBRIDGE_TEST_ROOT:PROJECT_ROOT_LITERAL});
}'''.replace("TEST_URI",json.dumps((ROOT / "tests/packaged.js").as_uri())).replace("PROJECT_ROOT_LITERAL",json.dumps(str(ROOT)))
with zipfile.ZipFile(extensions / "paperbridge-tests@local.dev.xpi","w") as z:
    z.writestr("manifest.json",json.dumps(manifest))
    z.writestr("bootstrap.js",bootstrap)
prefs = {"extensions.zotero.dataDir":str(ROOT / ".runtime/packaged-data"),"extensions.zotero.useDataDir":True,
    "extensions.paperbridge.pythonPath": options.local_python,
    "extensions.autoDisableScopes":0,"extensions.enabledScopes":15,"extensions.startupScanScopes":15,
    "xpinstall.signatures.required":False,"browser.shell.checkDefaultBrowser":False}
(ROOT / ".runtime/packaged-data").mkdir(exist_ok=True)
(PROFILE / "user.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k,v in prefs.items()))
for name in ["addonStartup.json.lz4","extensions.json"]:
    (PROFILE / name).unlink(missing_ok=True)
shutil.rmtree(PROFILE / "startupCache",ignore_errors=True)
print(PROFILE)
