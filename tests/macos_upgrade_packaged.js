/** Exercise the real 0.4.2 macOS XPI and verify its data after a native file upgrade. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, ChromeUtils, PAPERBRIDGE_MACOS_UPGRADE_TEST */
var PAPERBRIDGE_MACOS_UPGRADE_TEST_PROMISE = (async () => {
  const config = PAPERBRIDGE_MACOS_UPGRADE_TEST;
  const addonID = "paperbridge@local.dev";
  const syntheticKey = "paperbridge-isolated-macos-upgrade";
  const selection = { text: "E = mc2", glyphs: [] };
  const latex = "E = mc^2";
  const report = { phase: config.phase, ok: false, zoteroVersion: Zotero.version, checks: [], providerRequestsBlocked: 0 };
  let isolated = false;

  function check(condition, name) {
    report.checks.push({ name, pass: !!condition });
    if (!condition) throw new Error(name);
  }

  function digest(bytes) {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  async function fileHash(path) { return digest(await IOUtils.read(path)); }

  async function until(predicate, message) {
    const deadline = Date.now() + 60000;
    do {
      const value = await predicate();
      if (value) return value;
      await Zotero.Promise.delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  function loginGUID() {
    const [login] = Services.logins.findLogins("chrome://paperbridge", null, "DeepSeek");
    return login?.QueryInterface(Ci.nsILoginMetaInfo).guid;
  }

  async function saveFixture(bridge) {
    await bridge.saveKey(syntheticKey);
    const owner = new Zotero.Item("journalArticle");
    owner.setField("title", "PaperBridge isolated macOS upgrade fixture");
    await owner.saveTx();
    const source = await Zotero.Attachments.importFromFile({ file: config.sourcePDF, parentItemID: owner.id });
    const translated = await Zotero.Attachments.importFromFile({ file: config.translatedPDF, parentItemID: owner.id });
    const annotationKey = Zotero.DataObjectUtilities.generateKey();
    await Zotero.Annotations.saveFromJSON(translated, { key: annotationKey, type: "note", color: "#ffd400",
      comment: "Synthetic macOS upgrade annotation", pageLabel: "1", sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [[48, 200, 70, 222]] } });
    const note = new Zotero.Item("note");
    note.parentID = owner.id;
    note.setNote("<p>Synthetic macOS upgrade note.</p>");
    await note.saveTx();

    const sourcePath = await source.getFilePathAsync();
    const sourceHash = await fileHash(sourcePath);
    const preferences = Object.fromEntries(["language", "model", "baseURL", "pages"].map(key => [key, bridge.pref(key)]));
    const record = await bridge.library.put(source, null, preferences,
      { document_key: sourceHash, fingerprint: sourceHash }, await IOUtils.stat(sourcePath));
    translated.setField("title", `译文 · ${preferences.language} · ${record.title}`);
    translated.addRelation("dc:relation", record.sourceURI);
    await translated.saveTx();
    await bridge.library.attach(record, translated);
    await bridge.formulaCache.link(source, translated);
    const cache = await bridge.formulaCache.context({ itemID: source.id });
    const formulaKey = bridge.formulaCache.key(selection);
    await bridge.formulaCache.store(cache, formulaKey, selection, latex);
    await bridge.library.settled();
    check(bridge.getKey() === syntheticKey && loginGUID(), "0.4.2 stored the synthetic login in Zotero");
    check((await IOUtils.readJSON(bridge.library.path)).version === 1, "0.4.2 saved the legacy index through its own API");
    check(await bridge.formulaCache.lookup(cache, formulaKey) === latex, "0.4.2 stored a local formula result");
    return { libraryID: owner.libraryID, ownerKey: owner.key, sourceKey: source.key, translatedKey: translated.key,
      sourceHash, translatedHash: await fileHash(await translated.getFilePathAsync()), annotationKey,
      noteKey: note.key, noteHTML: note.getNote(), formulaKey, formulaID: cache.id, loginGUID: loginGUID(),
      previousPID: report.processID };
  }

  async function verifyFixture(bridge, fixture) {
    const item = key => Zotero.Items.getByLibraryAndKeyAsync(fixture.libraryID, key);
    const [owner, source, translated, annotation, note] = await Promise.all(
      [fixture.ownerKey, fixture.sourceKey, fixture.translatedKey, fixture.annotationKey, fixture.noteKey].map(item));
    check(owner && source?.parentID === owner.id && translated?.parentID === owner.id, "PDF ownership survives the upgrade");
    await bridge.library.settled();
    const index = await IOUtils.readJSON(bridge.library.path);
    check(index.version === 2 && index.records.some(record => record.attachmentKey === translated.key && record.recordID),
      "The current index persists a stable record for the migrated attachment");
    check(await fileHash(await source.getFilePathAsync()) === fixture.sourceHash &&
      await fileHash(await translated.getFilePathAsync()) === fixture.translatedHash, "Both PDF byte hashes survive");
    check(annotation?.parentID === translated.id && annotation.annotationComment === "Synthetic macOS upgrade annotation",
      "Native annotation remains attached to the translated PDF");
    check(note?.parentID === owner.id && note.getNote() === fixture.noteHTML, "Native note and its HTML survive");
    check(bridge.getKey("deepseek") === syntheticKey && loginGUID() === fixture.loginGUID, "DeepSeek login and GUID survive");
    const cache = await bridge.formulaCache.context({ itemID: translated.id });
    check(cache.id === fixture.formulaID && await bridge.formulaCache.lookup(cache, fixture.formulaKey) === latex,
      "The translated attachment can still read the 0.4.2 formula cache");
    const opened = await bridge.openExisting({ itemID: source.id });
    check(opened?.id === translated.id, "Open Existing resolves the old translation through the normal entry point");
    const reader = await until(() => Zotero.Reader._readers.find(value => value.itemID === source.id), "Missing source reader");
    await until(() => bridge.splits.get(reader.tabID)?.apps?.[1]?.pdfViewer?.pagesCount > 0, "Missing translated renderer");
    check(true, "An old translation opens in the native split reader after cold restart");
    await bridge.closeSplit(reader.tabID);
  }

  async function verifySettings(bridge) {
    bridge.settings();
    const window = await until(() => {
      const windows = Services.wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const value = windows.getNext();
        if (value.document?.documentURI === "chrome://paperbridge/content/settings.xhtml" &&
            value.document.readyState === "complete") return value;
      }
      return null;
    }, "The production settings dialog did not open");
    try {
      const doc = window.document;
      const element = id => doc.getElementById(id);
      const main = doc.querySelector(".settings-content");
      const save = element("save");
      check(element("key").value === syntheticKey && element("runtime-terms").hidden,
        "macOS settings display the saved fixture and hide Windows runtime terms");
      const fits = () => {
        const box = save.getBoundingClientRect();
        return box.width > 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
          && main.scrollWidth <= main.clientWidth + 1;
      };
      check(fits(), "Settings content and Save button fit the standard window");
      element("advanced-settings").open = true;
      element("support-settings").open = true;
      window.resizeTo(460, 480);
      await until(() => window.matchMedia("(max-width: 480px)").matches, "The settings dialog did not reach its narrow layout");
      check(fits() && main.scrollHeight > main.clientHeight, "Narrow settings scroll vertically and keep Save visible");
      element("test").click();
      await until(() => !element("engine-details").hidden || element("status").classList.contains("error"),
        "The local engine check did not complete in settings");
      check(!element("engine-details").hidden && element("engine-info").textContent.includes(config.expectedVersion),
        "The settings check reports the real installed engine version");
    } finally { window.close(); }
  }

  try {
    const samePath = (a, b) => PathUtils.normalize(a) === PathUtils.normalize(b);
    isolated = config.isolated === true && Services.appinfo.OS === "Darwin"
      && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory);
    if (!isolated) throw new Error("Refusing to run outside the prepared macOS test profile");
    report.processID = Services.appinfo.processID;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const bridge = Zotero.PaperBridge;
    const request = bridge.request;
    bridge.request = function(path, method, ...args) {
      if (path === "/formulas/latex" || path === "/providers/check" || (path === "/jobs" && method === "POST")) {
        report.providerRequestsBlocked++;
        throw new Error("Unexpected provider request in the isolated upgrade suite");
      }
      return request.call(this, path, method, ...args);
    };
    await bridge.ready;
    await until(() => bridge.formulaCache && bridge.library, "PaperBridge did not initialize its data stores");
    await bridge.formulaCache.settled();
    const addon = await AddonManager.getAddonByID(addonID);
    check(addon?.isActive && addon.version === config.expectedVersion, "Expected PaperBridge version is active");
    report.xpiSha256 = await fileHash(PathUtils.join(config.expectedProfileDirectory, "extensions", addonID + ".xpi"));
    check(report.xpiSha256 === (config.phase === "create" ? config.baselineXpiSha256 : config.upgradeSha256),
      "Installed XPI matches the exact input hash");
    report.engineVersion = (await bridge.request("/health")).version;
    check(report.engineVersion === addon.version, "The actual bundled engine reports the installed version");
    if (config.phase === "create") {
      check(addon.version === "0.4.2", "The baseline is the independent macOS 0.4.2 version");
      const fixture = await saveFixture(bridge);
      await IOUtils.writeUTF8(config.statePath, JSON.stringify(fixture));
      check(await fileHash(config.upgradeXpi) === config.upgradeSha256, "Native upgrade input matches the candidate hash");
      const install = await AddonManager.getInstallForFile(bridge.runtime.file(config.upgradeXpi));
      const installed = await install.install();
      check(installed?.id === addonID && installed.version === config.upgradeVersion, "AddonManager installed the candidate XPI");
    } else {
      const fixture = await IOUtils.readJSON(config.statePath);
      check(report.processID !== fixture.previousPID, "Reopened in a different native Zotero process");
      await verifyFixture(bridge, fixture);
      await verifySettings(bridge);
    }
    check(report.providerRequestsBlocked === 0, "No provider job requested");
    report.ok = true;
  } catch (error) {
    report.error = String(error);
    report.stack = error.stack;
    Zotero.logError(error);
  } finally {
    if (isolated) {
      try { await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2)); }
      finally { Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); }
    }
  }
})();
