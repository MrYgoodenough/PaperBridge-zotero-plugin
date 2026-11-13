/** Verify an actual XPI upgrade in one explicitly isolated profile without model jobs. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, PAPERBRIDGE_UPGRADE_TEST */
(async () => {
  // The helper supplies an exact disposable profile/data pair for both process phases.
  const config = PAPERBRIDGE_UPGRADE_TEST;
  // This synthetic credential is persisted only in the isolated native login manager.
  const fixtureKey = "paperbridge-isolated-upgrade-fixture";
  const report = { ok: false, phase: config.phase, providerCalls: 0, checks: [] };
  // Close only readers opened by this helper through Zotero's normal tab lifecycle.
  const sampleReaders = new Set();
  let isolated = false, bridge;

  /** Reject any accidental use of the user's normal profile or library. */
  function samePath(left, right) {
    const normalize = value => Zotero.isWin ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
    return !!left && !!right && normalize(left) === normalize(right);
  }

  /** Record only checks that really passed in the native application. */
  function check(condition, name) {
    if (!condition) throw new Error(name);
    report.checks.push(name);
  }

  /** Keep an incomplete native run distinguishable from a finished passing report. */
  async function checkpoint(stage) {
    report.stage = stage;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Await real reader/UI work without treating timeout as success. */
  async function until(predicate, message) {
    // Native PDF decoding, text layers and internal navigation can take several seconds.
    const timeoutMilliseconds = 45000;
    const deadline = Date.now() + timeoutMilliseconds;
    do {
      const result = await predicate();
      if (result) return result;
      await Zotero.Promise.delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Bind preservation checks to the actual attachment bytes across the upgrade. */
  async function sha256(path) {
    const bytes = await IOUtils.read(path);
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  /** Exercise the real settings button and read the generated allowlisted ZIP. */
  async function diagnostics() {
    const dialog = Zotero.getMainWindow().openDialog("chrome://paperbridge/content/settings.xhtml",
      "paperbridge-upgrade-settings", "chrome,centerscreen,resizable", { bridge });
    try {
      // Native dialog loading and local ZIP generation can take longer on first extraction.
      const timeoutMilliseconds = 30000;
      const deadline = Date.now() + timeoutMilliseconds;
      while (dialog.document.readyState !== "complete" || !dialog.document.getElementById("diagnostics-export")) {
        if (Date.now() > deadline) throw new Error("New settings diagnostic control did not load");
        await Zotero.Promise.delay(100);
      }
      dialog.document.getElementById("diagnostics-export").click();
      while (!dialog.document.getElementById("diagnostics-path").textContent) {
        if (Date.now() > deadline) throw new Error("Settings diagnostic export did not complete");
        await Zotero.Promise.delay(100);
      }
      const path = dialog.document.getElementById("diagnostics-path").textContent;
      const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
      zip.open(bridge.runtime.file(path));
      try {
        zip.test(null);
        const names = [], entries = zip.findEntries("*");
        while (entries.hasMore()) names.push(entries.getNext());
        check(names.length === 1 && names[0] === "diagnostics.json", "Settings exports a real allowlisted diagnostic ZIP");
        const stream = zip.getInputStream("diagnostics.json");
        const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
        reader.init(stream);
        const text = reader.read(reader.available());
        reader.close();
        check(!text.includes(fixtureKey) && !text.includes(config.expectedDataDirectory),
          "Native diagnostic export contains neither the test credential nor library paths");
      } finally { zip.close(); }
      report.diagnosticsPath = path;
    } finally { dialog.close(); }
  }

  /** Open an explicitly supplied output in Zotero's actual native PDF reader. */
  async function openPDF(path, pageNumber) {
    const attachment = await Zotero.Attachments.importFromFile({ file: path, libraryID: Zotero.Libraries.userLibraryID });
    const native = await Zotero.Reader.open(attachment.id);
    sampleReaders.add(native);
    await native._initPromise;
    const view = bridge.readerView(native);
    // Reader initialization can precede the primary PDF iframe becoming available.
    await view.initializedPromise;
    // Keep the reader's existing wrapper; an Xray hides its PDF.js JavaScript globals.
    const frame = view._iframeWindow;
    const app = frame.PDFViewerApplication;
    app.pdfViewer.currentPageNumber = pageNumber;
    // PDF.js RenderingStates.FINISHED is 3; placeholder viewports are not acceptance.
    const renderingFinished = 3;
    const page = await until(() => {
      const view = app.pdfViewer.getPageView(pageNumber - 1);
      return view?.renderingState === renderingFinished && view.div.querySelector(".textLayer span") && view;
    }, "Explicit native PDF sample did not render");
    return { native, view, frame, app, page };
  }

  /** Smoke-check only native rendering, not bilingual semantic acceptance. */
  async function readerSamples() {
    for (const sample of config.readerPDFs || []) {
      const { page } = await openPDF(sample.path, sample.page);
      const text = [...page.div.querySelectorAll(".textLayer span")].map(span => span.textContent).join("");
      check(/[\u3400-\u9fff\uf900-\ufaff]/.test(text), "Real translated sample page " + sample.page + " renders selectable Chinese in Zotero");
    }
    report.nativeTranslatedSamples = (config.readerPDFs || []).length;
  }

  /** Click the decoded native PDF link hotspot, never guessing body coordinates. */
  async function internalLink() {
    if (!config.linkPDF) return;
    const { native, view, frame, app } = await openPDF(config.linkPDF, 2);
    // Zotero handles original PDF links in its decoded overlays, not PDF.js anchor elements.
    const overlay = await until(() => view._pdfPages[1]?.overlays.find(link => link.type === "internal-link"),
      "Native reader did not decode the restored internal link");
    check(overlay.destinationPosition.pageIndex === 0, "Native reader decodes the restored PDF link destination");
    await until(() => app.pdfViewer.currentPageNumber === 2, "Native link control did not start on page two");
    const nativeFrame = Components.utils.unwaiveXrays(frame);
    const main = Zotero.getMainWindow();
    main.focus();
    Services.focus.activeWindow = main;
    main.Zotero_Tabs.select(native.tabID);
    nativeFrame.focus();
    app.pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: 2 }, frame));
    // A rendered page may still be scrolling or inactive after a Windows dialog closes.
    const box = await until(() => {
      const rect = view.getClientRect(overlay.position.rects[0], 1);
      return !view._scrolling && frame.document.hasFocus() && rect[0] >= 0 && rect[1] >= 0
        && rect[2] < frame.innerWidth && rect[3] < frame.innerHeight && rect;
    }, "Native PDF link did not settle inside the focused viewport");
    const events = [];
    report.nativeLinkInput = { box: Array.from(box), documentFocused: frame.document.hasFocus(),
      viewport: { width: frame.innerWidth, height: frame.innerHeight }, events };
    /** Keep trusted input evidence without retaining iframe objects past reader close. */
    function observe(event) {
      events.push({ type: event.type, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
        target: event.target.localName, className: event.target.getAttribute?.("class") });
    }
    const types = ["mousemove", "mousedown", "mouseup", "click"];
    for (const type of types) frame.document.addEventListener(type, observe, { capture: true, passive: true });
    const utilities = nativeFrame.windowUtils || nativeFrame.docShell.domWindowUtils;
    const x = (box[0] + box[2]) / 2, y = (box[1] + box[3]) / 2;
    // Native link hover is throttled; real clicks include a preceding pointer movement.
    const hoverMilliseconds = 100;
    try {
      utilities.sendMouseEvent("mousemove", x, y, 0, 0, 0);
      await Zotero.Promise.delay(hoverMilliseconds);
      utilities.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      utilities.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      await until(() => app.pdfViewer.currentPageNumber === 1, "Restored internal citation did not navigate to page one");
    } finally {
      for (const type of types) frame.document.removeEventListener(type, observe, true);
    }
    check(app.pdfViewer.currentPageNumber === 1, "Trusted native click follows the restored page-level internal PDF citation");
    report.nativeInternalLink = { targetPage: 1, scaleValue: app.pdfViewer.currentScaleValue,
      source: "real BabelDOC pipeline with simulated provider response", preciseBodyAlignment: false };
  }

  try {
    isolated = config.isolated === true
      && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory);
    if (!isolated) throw new Error("Refusing upgrade checks outside the explicit isolated profile/data pair");
    await checkpoint("native-engine-start");
    bridge = Zotero.PaperBridge;
    await bridge.ready;
    report.zoteroVersion = Zotero.version;
    report.health = await bridge.request("/health");
    check(bridge.runtime.version === config.expectedVersion && report.health.version === config.expectedVersion,
      "Installed addon and actual native engine match the selected XPI version");
    const jobs = await bridge.request("/jobs");
    check((Array.isArray(jobs) ? jobs : jobs.jobs).length === 0, "Upgrade verification never submits a model job");
    const installed = await IOUtils.readJSON(PathUtils.join(bridge.runtime.home, "installed.json"));
    const stateSentinel = PathUtils.join(bridge.runtime.state, "upgrade-fixture.json");
    const cacheSentinel = PathUtils.join(bridge.runtime.cache, "upgrade-fixture.json");
    if (config.phase === "create") {
      bridge.setPref("profile", "compatible");
      bridge.setPref("compatibleModel", "isolated-upgrade-model");
      await bridge.saveKey(fixtureKey, "compatible");
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", "PaperBridge synthetic upgrade fixture");
      await parent.saveTx();
      const source = await Zotero.Attachments.importFromFile({ file: config.sourcePDF, parentItemID: parent.id });
      const translated = await Zotero.Attachments.importFromFile({ file: config.translatedPDF, parentItemID: parent.id });
      const annotationKey = Zotero.DataObjectUtilities.generateKey();
      await Zotero.Annotations.saveFromJSON(translated, { key: annotationKey, type: "note", color: "#ffd400",
        comment: "Synthetic native upgrade note", pageLabel: "1", sortIndex: "00000|000000|00000",
        position: { pageIndex: 0, rects: [[48, 200, 70, 222]] } });
      const sourcePath = await source.getFilePathAsync();
      const record = await bridge.library.put(source, translated, bridge.configuration(),
        { state: "done", quality: { status: "unknown" } }, await IOUtils.stat(sourcePath));
      await IOUtils.writeUTF8(stateSentinel, '{"synthetic":"retained job-state area"}');
      await IOUtils.writeUTF8(cacheSentinel, '{"synthetic":"retained cache area"}');
      await IOUtils.writeUTF8(config.statePath, JSON.stringify({ libraryID: source.libraryID,
        sourceKey: source.key, translatedKey: translated.key, annotationKey, recordID: record.recordID,
        previousBuildId: installed.buildId, previousVersion: installed.version,
        sourceHash: await sha256(sourcePath), translatedHash: await sha256(await translated.getFilePathAsync()) }, null, 2));
      check(translated.getAnnotations().length === 1, "Baseline stores a native annotation on the translated fixture");
      check(bridge.library.records.some(value => value.recordID === record.recordID), "Baseline persists a real translation ownership record");
    } else if (config.phase === "reopen") {
      const saved = await IOUtils.readJSON(config.statePath);
      check(installed.version === config.expectedVersion && installed.buildId !== saved.previousBuildId,
        "Restart replaces the old engine build rather than reusing its installation marker");
      const source = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.sourceKey);
      const translated = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.translatedKey);
      check(source?.isPDFAttachment() && translated?.isPDFAttachment(), "Upgrade preserves both native PDF attachments");
      check(await sha256(await source.getFilePathAsync()) === saved.sourceHash
        && await sha256(await translated.getFilePathAsync()) === saved.translatedHash,
      "Source and translated attachment SHA-256 values remain unchanged");
      check(translated.getAnnotations().some(item => item.key === saved.annotationKey), "Native translated annotation survives the process upgrade");
      check(bridge.library.records.some(value => value.recordID === saved.recordID
        && value.attachmentKey === translated.key), "Translation ownership survives the upgrade");
      check(bridge.pref("compatibleModel") === "isolated-upgrade-model" && bridge.getKey("compatible") === fixtureKey,
        "Provider settings and native login-manager credential survive the restart");
      check((await IOUtils.readJSON(stateSentinel)).synthetic === "retained job-state area"
        && (await IOUtils.readJSON(cacheSentinel)).synthetic === "retained cache area",
      "Engine replacement leaves task-state and cache directories intact");
      await checkpoint("settings-diagnostics");
      await diagnostics();
      await checkpoint("native-translated-samples");
      await readerSamples();
      await checkpoint("native-internal-link");
      await internalLink();
      report.previousVersion = saved.previousVersion;
    } else throw new Error("Expected create or reopen phase");
    report.installed = installed;
    report.stage = "complete";
    report.ok = true;
  } catch (error) {
    report.error = String(error);
    report.stack = error.stack;
    Zotero.logError(error);
  } finally {
    if (isolated) {
      try {
        for (const native of sampleReaders) native.close();
        if (sampleReaders.size) {
          await until(() => [...sampleReaders].every(native => !Zotero.Reader._readers.includes(native)),
            "Test-created native reader tabs did not close");
          check(true, "Test-created readers close through the normal native lifecycle");
        }
      } catch (error) {
        report.ok = false;
        report.cleanupError = String(error);
      }
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
