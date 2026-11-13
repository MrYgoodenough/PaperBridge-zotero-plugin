/** Register the addon chrome and its isolated runtime/UI modules. */
// Registration and script scope live until addon shutdown.
var chromeHandle;
var scope;

/** No profile migration is required during installation. */
function install() {}
/** Keep saved user artifacts when the addon is removed. */
function uninstall() {}

/** Load module dependencies before starting the bridge. */
async function startup({ id, version, rootURI }) {
  const registration = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = registration.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "paperbridge", "content/"]
  ]);
  scope = { Zotero, Services, Cc, Ci, Components, ChromeUtils, IOUtils, PathUtils, rootURI, version, fetch };
  Services.scriptloader.loadSubScript(rootURI + "content/runtime.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/library.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/tasks.js", scope);
  Services.scriptloader.loadSubScript(rootURI + "content/paperbridge.js", scope);
  scope.PaperBridge.runtime = new scope.BundledRuntime(rootURI, version);
  scope.PaperBridge.library = new scope.TranslationLibrary(scope.PaperBridge);
  Zotero.PaperBridge = scope.PaperBridge;
  Zotero.PaperBridge.ready = Zotero.PaperBridge.start(id);
  await Zotero.PaperBridge.ready;
}

/** Add commands to newly opened main windows. */
function onMainWindowLoad({ window }) {
  Zotero.PaperBridge?.addMenus(window);
}

/** Remove commands before their document closes. */
function onMainWindowUnload({ window }) {
  Zotero.PaperBridge?.removeMenus(window);
}

/** Stop workers and release addon registrations. */
async function shutdown() {
  await Zotero.PaperBridge?.stop();
  delete Zotero.PaperBridge;
  chromeHandle?.destruct();
  scope = null;
}
