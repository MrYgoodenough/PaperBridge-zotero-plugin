var chromeHandle;
var scope;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  const registration = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = registration.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "paperbridge", "content/"]
  ]);
  scope = { Zotero, Services, Cc, Ci, Components, ChromeUtils, IOUtils, PathUtils, rootURI, version, fetch };
  Services.scriptloader.loadSubScript(rootURI + "content/runtime.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/library.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/paperbridge.js", scope);
  scope.PaperBridge.runtime = new scope.BundledRuntime(rootURI, version);
  scope.PaperBridge.library = new scope.TranslationLibrary(scope.PaperBridge);
  Zotero.PaperBridge = scope.PaperBridge;
  Zotero.PaperBridge.ready = Zotero.PaperBridge.start(id);
  await Zotero.PaperBridge.ready;
}

function onMainWindowLoad({ window }) {
  Zotero.PaperBridge?.addMenus(window);
}

function onMainWindowUnload({ window }) {
  Zotero.PaperBridge?.removeMenus(window);
}

async function shutdown() {
  await Zotero.PaperBridge?.stop();
  delete Zotero.PaperBridge;
  chromeHandle?.destruct();
  scope = null;
}
