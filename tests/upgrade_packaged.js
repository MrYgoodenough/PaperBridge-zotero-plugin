/** Verify an actual XPI upgrade in one explicitly isolated profile without model jobs. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils, PAPERBRIDGE_UPGRADE_TEST, PAPERBRIDGE_WINDOWS_SUPPLEMENT */
var PAPERBRIDGE_UPGRADE_TEST_PROMISE = (async () => {
  // The helper supplies an exact disposable profile/data pair for both process phases.
  const config = PAPERBRIDGE_UPGRADE_TEST;
  // This synthetic credential is persisted only in the isolated native login manager.
  const fixtureKey = "paperbridge-isolated-upgrade-fixture";
  // The second realm is equally synthetic and must survive every compatible-profile action.
  const otherKey = fixtureKey + "-other-profile";
  // Preserve meaningful annotation fields, excluding transient serializer bookkeeping.
  const annotationFields = ["type", "text", "comment", "pageLabel", "color", "position"];
  // Released pointer moves must not extend an earlier native text selection.
  const mouseInputSource = 1, releasedMouseButtons = 0;
  // Report observations separately from unperformed public-update or network verification.
  const report = { ok: false, phase: config.phase, providerCalls: 0, checks: [], processID: Services.appinfo.processID,
    automaticUpdateVerified: false };
  // Close only readers opened by this helper through Zotero's normal tab lifecycle.
  const sampleReaders = new Set();
  let isolated = false, bridge;

  /** Reject any accidental use of the user's normal profile or library. */
  function samePath(left, right) {
    const normalize = value => Zotero.isWin ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
    return !!left && !!right && normalize(left) === normalize(right);
  }

  /** Preserve a failed native assertion as well as the completed checks. */
  function check(condition, name, details) {
    if (!condition) report.failedCheck = { name, details };
    if (!condition) throw new Error(name);
    report.checks.push(name);
  }

  /** Keep an incomplete native run distinguishable from a finished passing report. */
  async function checkpoint(stage) {
    report.stage = stage;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Await real reader/UI work without treating timeout as success. */
  async function until(predicate, message, timeoutOverride) {
    // Native PDF decoding, text layers and internal navigation can take several seconds.
    const timeoutMilliseconds = timeoutOverride ?? 45000;
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
    return digest(await IOUtils.read(path));
  }

  /** Hash fixture bytes without exposing document or credential content. */
  function digest(bytes) {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  /** Bind native fixture note/annotation preservation to its actual UTF-8 content. */
  function textDigest(text) {
    return digest(new (Zotero.getMainWindow().TextEncoder)().encode(text));
  }

  /** Compare only persisted native annotation fields across versions and restarts. */
  async function annotationDigest(item) {
    await item.loadAllData();
    const json = await Zotero.Annotations.toJSON(item);
    return textDigest(JSON.stringify(annotationFields.map(field => json[field] || "")));
  }

  /** Inspect only known synthetic realms, recording identity but never passwords. */
  function credentialIdentities() {
    return Object.fromEntries(["OpenAI-compatible", "DeepSeek"].map(realm => {
      const logins = Services.logins.findLogins("chrome://paperbridge", null, realm);
      const meta = logins[0]?.QueryInterface(Ci.nsILoginMetaInfo);
      return [realm, { count: logins.length, guid: meta?.guid, timeCreated: meta?.timeCreated,
        username: logins[0]?.username }];
    }));
  }

  /** Exercise native replacement, native validation rejection and explicit realm clearing. */
  async function nativeCredentialUpdate() {
    const original = Services.logins.findLogins("chrome://paperbridge", null, "OpenAI-compatible")[0];
    const guid = original.QueryInterface(Ci.nsILoginMetaInfo).guid;
    const replacement = fixtureKey + "-replacement";
    const otherIdentity = credentialIdentities().DeepSeek;
    await bridge.saveKey(replacement, "compatible");
    const changed = Services.logins.findLogins("chrome://paperbridge", null, "OpenAI-compatible");
    check(changed.length === 1 && changed[0].QueryInterface(Ci.nsILoginMetaInfo).guid === guid
      && bridge.getKey("compatible") === replacement && bridge.getKey("deepseek") === otherKey
      && JSON.stringify(credentialIdentities().DeepSeek) === JSON.stringify(otherIdentity),
    "Native nonempty credential replacement retains the login identity and other profile");
    let rejected = false;
    // LoginHelper rejects NUL-containing credentials; this is real native validation, not a mock.
    try { await bridge.saveKey(replacement + "\0-rejected", "compatible"); }
    catch (_) { rejected = true; }
    check(rejected && bridge.getKey("compatible") === replacement
      && credentialIdentities()["OpenAI-compatible"].guid === guid
      && bridge.getKey("deepseek") === otherKey
      && JSON.stringify(credentialIdentities().DeepSeek) === JSON.stringify(otherIdentity),
    "Native rejected credential write leaves both synthetic realms and the old identity intact");
    await bridge.saveKey("", "compatible");
    check(!bridge.getKey("compatible") && bridge.getKey("deepseek") === otherKey,
      "Native explicit clearing removes only the selected credential realm");
    // Restore the established fixture value before subsequent configuration checks.
    await bridge.saveKey(fixtureKey, "compatible");
    report.credentials = { nativeReplacement: true, nativeValidationRejected: true,
      explicitRealmClearing: true, otherRealmIdentityUnchanged: true,
      scope: "Two synthetic PaperBridge realms in the isolated login manager; no sync API key access" };
  }

  /** Activate only a visible native dialog control with trusted Gecko mouse input. */
  async function clickControl(window, element) {
    window.focus();
    Services.focus.activeWindow = window;
    await until(() => window.document.hasFocus(), "Native diagnostic dialog did not receive focus");
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = window.document.elementFromPoint(x, y);
    check(box.width > 0 && box.height > 0 && x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight
      && (hit === element || element.contains(hit)), "Native diagnostic control is visible and hit-testable");
    let trusted = false;
    /** Observe the actual dialog click without intercepting production behavior. */
    function observe(event) { trusted = event.isTrusted; }
    element.addEventListener("click", observe, { once: true });
    const utilities = window.windowUtils || window.docShell.domWindowUtils;
    utilities.sendMouseEvent("mousedown", x, y, 0, 1, 0);
    utilities.sendMouseEvent("mouseup", x, y, 0, 1, 0);
    check(trusted, "Native diagnostic control receives trusted mouse input");
  }

  /** Exercise the real settings button and read the generated allowlisted ZIP. */
  async function diagnostics(addonOnly = false, scenario = "backend") {
    // Exercise a realistically narrow native dialog without a strict screenshot/pixel gate.
    const narrowWidth = 380, narrowHeight = 620, layoutTolerance = 2, settleMilliseconds = 250;
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
      const disclosure = dialog.document.getElementById("diagnostics");
      if (disclosure && !disclosure.open) await clickControl(dialog, disclosure.querySelector("summary"));
      await clickControl(dialog, dialog.document.getElementById("diagnostics-export"));
      while (!dialog.document.getElementById("diagnostics-path").textContent) {
        if (Date.now() > deadline) throw new Error("Settings diagnostic export did not complete");
        await Zotero.Promise.delay(100);
      }
      const path = dialog.document.getElementById("diagnostics-path").textContent;
      dialog.resizeTo(narrowWidth, narrowHeight);
      await Zotero.Promise.delay(settleMilliseconds);
      const body = dialog.document.querySelector("body");
      check(body.scrollWidth <= body.clientWidth + layoutTolerance, "Native settings remain within a narrow window after export");
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
        const summary = JSON.parse(text);
        check(summary.schema_version === 2 && Array.isArray(summary.events?.startup)
          && Array.isArray(summary.events?.jobs), "Native diagnostic export includes safe lifecycle timelines");
        check(summary.runtime_status.export_source === (addonOnly ? "addon_only" : "backend"),
          "Native ZIP identifies whether the backend was actually available");
        const roots = ["schema_version", "versions", "platform", "tasks", "events", "runtime_status", "safety"];
        check(JSON.stringify(Object.keys(summary).sort()) === JSON.stringify(roots.sort())
          && summary.safety.export_scope === "allowlist_only"
          && ["credentials_included", "document_content_included", "user_paths_included", "raw_logs_included"]
            .every(key => summary.safety[key] === false), "Native diagnostic ZIP uses only the declared privacy schema");
        const strings = [];
        /** Inspect decoded strings so escaped Windows paths cannot evade the privacy check. */
        function collect(value) {
          if (typeof value === "string") strings.push(value);
          else if (value && typeof value === "object") Object.values(value).forEach(collect);
        }
        collect(summary);
        const forbidden = [fixtureKey, "secret-fixture", "PEDREGOSA", "PaperBridge synthetic upgrade fixture",
          config.expectedDataDirectory, config.expectedProfileDirectory, config.sourcePDF, config.translatedPDF].filter(Boolean);
        check(strings.every(value => !forbidden.some(secret => value.toLowerCase().includes(secret.toLowerCase()))
          && !/(?:[a-z]:\\|\/home\/|\/Users\/)/i.test(value)),
        "Decoded native diagnostics omit fixture credentials, document markers, raw faults and user paths");
        const copy = PathUtils.join(PathUtils.parent(config.reportPath),
          PathUtils.filename(config.reportPath).replace(/\.json$/, "") + "-diagnostics-" + scenario + ".zip");
        check(!await IOUtils.exists(copy), "Diagnostic evidence never overwrites a prior ZIP");
        await IOUtils.copy(path, copy);
        (report.diagnosticEvidence ||= []).push({ scenario, path: copy, sha256: await sha256(copy),
          entries: names, exportSource: summary.runtime_status.export_source,
          versions: summary.versions, safety: summary.safety, decodedPrivacyChecked: true });
      } finally { zip.close(); }
      report.diagnosticsPath = path;
      return { path, summary: JSON.parse(await readZip(path)) };
    } finally { dialog.close(); }
  }

  /** Decode one native diagnostic entry without reading any other file or preference. */
  async function readZip(path) {
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(bridge.runtime.file(path));
    try {
      const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      stream.init(zip.getInputStream("diagnostics.json"));
      try { return stream.read(stream.available()); }
      finally { stream.close(); }
    } finally { zip.close(); }
  }

  /** Exercise real startup failure and native ZIP/temp fallback only in the isolated extracted engine. */
  async function startupDiagnostics() {
    const runtime = bridge.runtime;
    check(samePath(runtime.home, PathUtils.join(config.expectedDataDirectory, "paperbridge", "engine")),
      "Startup fault injection targets only this isolated extracted engine");
    const serverPath = PathUtils.join(runtime.home, "backend", "server.py");
    const original = await IOUtils.read(serverPath);
    const statePath = runtime.state;
    const badState = PathUtils.join(config.expectedDataDirectory, "diagnostics-state-file");
    await runtime.stop();
    try {
      // Fault injection changes only this disposable extracted copy, not source or installed XPI.
      await IOUtils.writeUTF8(serverPath, 'raise RuntimeError("tokenizer resource missing secret-fixture")\n');
      let failure;
      try { await bridge.request("/health"); } catch (error) { failure = error; }
      check(failure?.code === "resource", "Native startup failure receives the production resource classification");
      const first = await diagnostics(true, "resource-failed");
      check(first.summary.runtime_status.engine_ready === false
        && first.summary.versions.babeldoc === "unknown"
        && first.summary.events.startup.some(event => event.stage === "failed" && event.code === "resource"),
      "Startup-failed export keeps safe failure stages without claiming a backend version");
      await IOUtils.writeUTF8(badState, "isolated non-directory state path");
      runtime.state = badState;
      const temporary = await diagnostics(true, "temp-fallback");
      check(temporary.path.startsWith(PathUtils.tempDir), "Native diagnostic ZIP falls back to the OS temp directory");
      report.startupDiagnostics = { resourceFailure: true, nativeZip: true, tempFallback: true,
        scope: "Injected startup exception and non-directory state in the isolated extracted engine; not a physical missing-resource or disk-permission claim" };
      await IOUtils.remove(temporary.path);
    } finally {
      runtime.state = statePath;
      await runtime.stop();
      await IOUtils.write(serverPath, original);
      await IOUtils.remove(badState, { ignoreAbsent: true });
    }
    check((await bridge.request("/health")).version === config.expectedVersion,
      "Restoring the isolated engine recovers local readiness without any translation request");
  }

  /** Install an exact local candidate with AddonManager; a file copy is not an upgrade. */
  async function installCandidate() {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    check(await sha256(config.upgradeXpi) === config.upgradeSha256, "Native candidate input matches its actual XPI hash");
    const install = await AddonManager.getInstallForFile(bridge.runtime.file(config.upgradeXpi));
    let ended = false, failure;
    const listener = {
      /** Observe a completed native installation rather than assuming install() returned success. */
      onInstallEnded(_install, addon) { ended = addon.id === "paperbridge@local.dev" && addon.version === config.upgradeVersion; },
      /** Retain a native installation failure instead of substituting file replacement. */
      onInstallFailed(value) { failure = new Error("Native candidate install failed: " + value.error); },
      /** Native user cancellation is not successful installation. */
      onInstallCancelled() { failure = new Error("Native candidate install cancelled"); }
    };
    install.addListener(listener);
    try {
      Promise.resolve(install.install()).catch(error => { failure = error; });
      await until(() => { if (failure) throw failure; return ended; }, "Native candidate installation did not finish");
      const addon = await AddonManager.getAddonByID("paperbridge@local.dev");
      check(addon.version === config.upgradeVersion, "AddonManager reports the installed newer candidate");
      report.nativeFileInstall = { version: addon.version, xpiSha256: config.upgradeSha256 };
    } finally { install.removeListener(listener); }
  }

  /** Open an explicitly supplied output in Zotero's actual native PDF reader. */
  async function openPDF(path, pageNumber) {
    const attachment = await Zotero.Attachments.importFromFile({ file: path, libraryID: Zotero.Libraries.userLibraryID });
    const opened = await Zotero.Reader.open(attachment.id);
    const native = opened || await until(() => Zotero.Reader._readers.find(value => value.itemID === attachment.id),
      "Native sample reader did not become available");
    sampleReaders.add(native);
    await native._initPromise;
    const view = bridge.readerView(native);
    // Reader initialization can precede the primary PDF iframe becoming available.
    await view.initializedPromise;
    // Keep the reader's existing wrapper; an Xray hides its PDF.js JavaScript globals.
    const frame = view._iframeWindow;
    const app = frame.PDFViewerApplication;
    // A restored/background tab can initialize without painting; make only this owned sample visible first.
    const main = Zotero.getMainWindow();
    main.focus();
    Services.focus.activeWindow = main;
    main.Zotero_Tabs.select(native.tabID);
    Components.utils.unwaiveXrays(frame).focus();
    app.pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber }, frame));
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
      const { page, native, frame, app } = await openPDF(sample.path, sample.page);
      const text = [...page.div.querySelectorAll(".textLayer span")].map(span => span.textContent).join("");
      check(/[\u3400-\u9fff\uf900-\ufaff]/.test(text), "Real translated sample page " + sample.page + " renders selectable Chinese in Zotero");
      check(!/[\uf900-\ufaff\u00ad]/.test(text), "New translated text does not copy compatibility ideographs or soft-hyphen aliases");
      await copyAndSearch(native, frame, app, page, sample.searchTerm || "摘要");
    }
    report.nativeTranslatedSamples = (config.readerPDFs || []).length;
  }

  /** Drag a real text-layer word and run the reader's find controller, without injecting a Selection. */
  async function copyAndSearch(native, frame, app, page, term) {
    // Stable page text and focused native input are required before a selection can be measured.
    const moveSteps = 6, movementDelay = 60, selectionTolerance = 2;
    const main = Zotero.getMainWindow();
    main.focus();
    Services.focus.activeWindow = main;
    main.Zotero_Tabs.select(native.tabID);
    const nativeFrame = Components.utils.unwaiveXrays(frame);
    nativeFrame.focus();
    app.pdfViewer.currentScaleValue = "page-width";
    await until(() => page.renderingState === 3 && page.scale === app.pdfViewer.currentScale,
      "Native copy page did not finish width-fit rendering");
    const span = [...page.div.querySelectorAll(".textLayer span")].find(node => node.textContent.includes(term));
    check(!!span, "Native text layer contains the exact searchable term " + term);
    const node = span.firstChild, offset = node.textContent.indexOf(term);
    const range = frame.document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + term.length);
    const initial = range.getBoundingClientRect();
    // A PDF.js span can cover many lines; center the chosen glyph range, not the whole span.
    app.pdfViewer.container.scrollTop += (initial.top + initial.bottom) / 2 - frame.innerHeight / 2;
    // Await real scroll/layout before reading hit coordinates, not a fixed focus assumption.
    let last, stable = 0;
    await until(() => {
      const box = range.getBoundingClientRect();
      const current = JSON.stringify([box.left, box.top, box.right, box.bottom]);
      stable = current === last ? stable + 1 : 0;
      last = current;
      return stable >= 3;
    }, "Native copy text layer did not settle");
    const box = range.getBoundingClientRect();
    const y = (box.top + box.bottom) / 2, x = box.left + 0.5, end = box.right + selectionTolerance;
    report.copyProbe = { term, page: app.pdfViewer.currentPageNumber, scale: app.pdfViewer.currentScale,
      box: [box.left, box.top, box.right, box.bottom], viewport: [frame.innerWidth, frame.innerHeight],
      selectedTab: main.Zotero_Tabs.selectedID, tabID: native.tabID, focus: frame.document.hasFocus(),
      startElement: frame.document.elementFromPoint(x, y)?.localName };
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
    check(x > 0 && end < frame.innerWidth && y > 0 && y < frame.innerHeight,
      "Native copy term is actually inside the target viewport");
    const utilities = nativeFrame.windowUtils || nativeFrame.docShell.domWindowUtils;
    const events = [];
    /** Record actual Gecko-delivered events instead of trusting a focus request. */
    function observe(event) { events.push({ type: event.type, trusted: event.isTrusted }); }
    for (const type of ["mousedown", "mouseup"]) frame.document.addEventListener(type, observe, { once: true, capture: true });
    utilities.sendMouseEvent("mousemove", x, y, 0, 0, 0,
      false, 0, mouseInputSource, true, false, releasedMouseButtons);
    utilities.sendMouseEvent("mousedown", x, y, 0, 1, 0);
    for (let step = 1; step <= moveSteps; step++) {
      utilities.sendMouseEvent("mousemove", x + (end - x) * step / moveSteps, y, 0, 0, 0,
        false, 0, 1, true, false, 1);
      await Zotero.Promise.delay(movementDelay);
    }
    utilities.sendMouseEvent("mouseup", end, y, 0, 1, 0);
    report.copyProbe.actualSelection = frame.document.getSelection()?.toString();
    report.copyProbe.input = events;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
    check(events.some(event => event.type === "mousedown" && event.trusted)
      && events.some(event => event.type === "mouseup" && event.trusted), "Native selection drag delivers trusted mouse input");
    await until(() => frame.document.getSelection()?.toString().includes(term), "Trusted drag did not select the exact target term");
    const selected = frame.document.getSelection().toString();
    check(selected.includes(term) && !/[\uf900-\ufaff\u00ad]/.test(selected), "Real native selection keeps canonical copy text " + term);
    app.eventBus.dispatch("find", Components.utils.cloneInto({ source: null, type: "", query: term,
      phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: false, findPrevious: false }, frame));
    await until(() => app.findController.pageMatches.some(matches => matches.length > 0), "Native find did not locate the canonical term");
    check(app.findController.pageMatches.some(matches => matches.length > 0), "Native reader search finds " + term);
    (report.nativeCopySearch ||= []).push({ term, selected, findMatchCount: app.findController.pageMatches.reduce((n, matches) => n + matches.length, 0) });
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
      utilities.sendMouseEvent("mousemove", x, y, 0, 0, 0,
        false, 0, mouseInputSource, true, false, releasedMouseButtons);
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

  /** Recheck the original stopped baseline, without rewriting items, settings or credentials. */
  async function preservation(saved) {
    check(saved.processID !== report.processID, "Upgrade acceptance uses a genuinely new native process");
    const source = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.sourceKey);
    const translated = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.translatedKey);
    check(source?.isPDFAttachment() && translated?.isPDFAttachment(), "Upgrade preserves both native PDF attachments");
    check(await sha256(await source.getFilePathAsync()) === saved.sourceHash
      && await sha256(await translated.getFilePathAsync()) === saved.translatedHash,
    "Source and translated attachment SHA-256 values remain unchanged");
    const annotation = translated.getAnnotations().find(item => item.key === saved.annotationKey);
    check(annotation && (!saved.annotationSha256 || await annotationDigest(annotation) === saved.annotationSha256),
      "Native translated annotation key and persisted content survive the process upgrade");
    if (saved.noteKey) {
      const note = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.noteKey);
      check(note?.isNote() && note.parentID === source.parentID && textDigest(note.getNote()) === saved.noteSha256,
        "Baseline independent native note preserves its key, parent and HTML checksum");
    }
    check(bridge.library.records.some(value => value.recordID === saved.recordID
      && value.attachmentKey === translated.key), "Translation ownership survives the upgrade");
    check(bridge.pref("compatibleModel") === "isolated-upgrade-model" && bridge.getKey("compatible") === fixtureKey,
      "Provider settings and native login-manager credential survive the restart");
    if (saved.credentialIdentities) {
      check(bridge.getKey("deepseek") === otherKey && JSON.stringify(credentialIdentities())
        === JSON.stringify(saved.postExerciseCredentialIdentities || saved.credentialIdentities),
      "Both synthetic credential realms retain exact native GUID, creation metadata and logical values");
    }
    if (saved.stoppedCredentialFileHashes && config.supplementPhase !== "reopen") {
      const files = [];
      for (const [name, expected] of Object.entries(saved.stoppedCredentialFileHashes)) {
        const actual = await sha256(PathUtils.join(config.expectedProfileDirectory, name));
        files.push({ name, baselineSha256: expected, actualSha256: actual, unchanged: expected === actual });
      }
      // NSS can rewrite storage during normal startup; retain any false byte flags rather than hiding them.
      report.credentialStoragePreservation = { files, exactFilesUnchanged: files.every(file => file.unchanged),
        nativeLoginIdentitiesUnchanged: true, scope: "Before this helper's explicit replacement/clear exercises" };
    }
    const stateSentinel = PathUtils.join(bridge.runtime.state, "upgrade-fixture.json");
    const cacheSentinel = PathUtils.join(bridge.runtime.cache, "upgrade-fixture.json");
    check((await IOUtils.readJSON(stateSentinel)).synthetic === "retained job-state area"
      && (await IOUtils.readJSON(cacheSentinel)).synthetic === "retained cache area",
    "Engine replacement leaves task-state and cache directories intact");
    if (saved.paragraphCacheSha256) check(await sha256(PathUtils.join(bridge.runtime.cache, "paragraphs.sqlite"))
      === saved.paragraphCacheSha256, "Upgrade preserves the exact baseline paragraph cache database");
    report.preservation = { sourceKey: source.key, translatedKey: translated.key,
      sourceSha256: saved.sourceHash, translatedSha256: saved.translatedHash,
      annotationKey: saved.annotationKey, annotationSha256: saved.annotationSha256,
      noteKey: saved.noteKey, noteSha256: saved.noteSha256,
      credentialIdentities: credentialIdentities(), paragraphCacheSha256: saved.paragraphCacheSha256 };
  }

  try {
    isolated = config.isolated === true
      && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory);
    if (!isolated) throw new Error("Refusing upgrade checks outside the explicit isolated profile/data pair");
    await checkpoint("native-engine-start");
    bridge = Zotero.PaperBridge;
    // Fresh-profile hydration can be slow, but a stuck startup must still report and quit normally.
    const startupWaitMilliseconds = 180000;
    let bridgeReady = false, startupError;
    Promise.resolve(bridge.ready).then(() => { bridgeReady = true; }, error => {
      startupError = error || new Error("Native addon rejected startup");
    });
    await until(() => { if (startupError) throw startupError; return bridgeReady; },
      "Native addon initialization did not finish", startupWaitMilliseconds);
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("paperbridge@local.dev");
    check(addon?.isActive && addon.version === config.expectedVersion,
      "Native AddonManager registers and activates the exact selected addon version");
    report.nativeAddon = { id: addon.id, version: addon.version, active: addon.isActive };
    report.zoteroVersion = Zotero.version;
    report.health = await bridge.request("/health");
    check(bridge.runtime.version === config.expectedVersion && report.health.version === config.expectedVersion,
      "Installed addon and actual native engine match the selected XPI version");
    report.installedXpiSha256 = await sha256(PathUtils.join(config.expectedProfileDirectory, "extensions", "paperbridge@local.dev.xpi"));
    if (config.expectedXpiSha256) check(report.installedXpiSha256 === config.expectedXpiSha256,
      "Cold native installation matches the exact selected XPI hash");
    const jobs = await bridge.request("/jobs");
    check((Array.isArray(jobs) ? jobs : jobs.jobs).length === 0, "Upgrade verification never submits a model job");
    report.providerObservation = { nativeBackendJobsBefore: 0,
      scope: "No provider-submit command in this helper; native jobs checked, not a packet capture" };
    const installed = await IOUtils.readJSON(PathUtils.join(bridge.runtime.home, "installed.json"));
    const stateSentinel = PathUtils.join(bridge.runtime.state, "upgrade-fixture.json");
    const cacheSentinel = PathUtils.join(bridge.runtime.cache, "upgrade-fixture.json");
    if (config.phase === "create") {
      bridge.setPref("profile", "compatible");
      bridge.setPref("compatibleModel", "isolated-upgrade-model");
      await bridge.saveKey(fixtureKey, "compatible");
      await bridge.saveKey(otherKey, "deepseek");
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", "PaperBridge synthetic upgrade fixture");
      await parent.saveTx();
      const source = await Zotero.Attachments.importFromFile({ file: config.sourcePDF, parentItemID: parent.id });
      const translated = await Zotero.Attachments.importFromFile({ file: config.translatedPDF, parentItemID: parent.id });
      const annotationKey = Zotero.DataObjectUtilities.generateKey();
      await Zotero.Annotations.saveFromJSON(translated, { key: annotationKey, type: "note", color: "#ffd400",
        comment: "Synthetic native upgrade note", pageLabel: "1", sortIndex: "00000|000000|00000",
        position: { pageIndex: 0, rects: [[48, 200, 70, 222]] } });
      const oldNote = new Zotero.Item("note");
      oldNote.parentID = parent.id;
      oldNote.setNote("<p>Isolated native upgrade baseline note.</p>");
      await oldNote.saveTx();
      const sourcePath = await source.getFilePathAsync();
      const record = await bridge.library.put(source, translated, bridge.configuration(),
        { state: "done", quality: { status: "unknown" } }, await IOUtils.stat(sourcePath));
      await IOUtils.writeUTF8(stateSentinel, '{"synthetic":"retained job-state area"}');
      await IOUtils.writeUTF8(cacheSentinel, '{"synthetic":"retained cache area"}');
      const paragraphPath = PathUtils.join(bridge.runtime.cache, "paragraphs.sqlite");
      if (config.paragraphCachePath) await IOUtils.copy(config.paragraphCachePath, paragraphPath);
      await IOUtils.writeUTF8(config.statePath, JSON.stringify({ libraryID: source.libraryID,
        sourceKey: source.key, translatedKey: translated.key, annotationKey, recordID: record.recordID,
        annotationSha256: await annotationDigest(translated.getAnnotations()[0]),
        noteKey: oldNote.key, noteSha256: textDigest(oldNote.getNote()),
        credentialIdentities: credentialIdentities(), pageIndex: config.notePageIndex ?? 0,
        previousBuildId: installed.buildId, previousVersion: installed.version,
        sourceHash: await sha256(sourcePath), translatedHash: await sha256(await translated.getFilePathAsync()),
        processID: report.processID, paragraphCacheSha256: config.paragraphCachePath ? await sha256(paragraphPath) : null }, null, 2));
      check(translated.getAnnotations().length === 1, "Baseline stores a native annotation on the translated fixture");
      check(bridge.library.records.some(value => value.recordID === record.recordID), "Baseline persists a real translation ownership record");
      if (config.upgradeXpi) {
        await checkpoint("native-file-install");
        await installCandidate();
      }
    } else if (config.phase === "install") {
      const saved = await IOUtils.readJSON(config.statePath);
      check(installed.version === saved.previousVersion && installed.buildId === saved.previousBuildId,
        "Stopped-backup install phase still runs the original baseline engine");
      await preservation(saved);
      await checkpoint("native-file-install");
      await installCandidate();
      report.previousVersion = saved.previousVersion;
    } else if (config.phase === "reopen") {
      const saved = await IOUtils.readJSON(config.statePath);
      check(installed.version === config.expectedVersion && installed.buildId !== saved.previousBuildId,
        "Restart replaces the old engine build rather than reusing its installation marker");
      await preservation(saved);
      if (!["reopen", "notes", "views"].includes(config.supplementPhase)) {
        await checkpoint("native-credential-replacement");
        await nativeCredentialUpdate();
        saved.postExerciseCredentialIdentities = credentialIdentities();
        saved.nativeExerciseReport = config.reportPath;
        await IOUtils.writeUTF8(config.statePath, JSON.stringify(saved, null, 2));
        await checkpoint("settings-diagnostics");
        await diagnostics();
        await checkpoint("startup-failed-diagnostics");
        await startupDiagnostics();
        await checkpoint("native-translated-samples");
        await readerSamples();
        await checkpoint("native-internal-link");
        await internalLink();
      } else report.previousNativeExerciseReport = saved.nativeExerciseReport;
      if (config.supplementPhase) {
        check(typeof PAPERBRIDGE_WINDOWS_SUPPLEMENT === "function", "Windows native supplement is loaded by the existing helper");
        const main = Zotero.getMainWindow();
        // Notes use an ordinary native window; the narrow split toolbar can overlap at small widths.
        const noteWidth = 1700, noteHeight = 1000;
        const previousWindow = { x: main.screenX, y: main.screenY, width: main.outerWidth,
          height: main.outerHeight, state: main.windowState };
        report.noteWindow = { previous: previousWindow, method: "Native test-owned window resize; OS scale unchanged" };
        try {
          main.restore();
          main.resizeTo(Math.min(noteWidth, main.screen.availWidth), Math.min(noteHeight, main.screen.availHeight));
          main.moveTo(main.screen.availLeft, main.screen.availTop);
          await until(() => main.outerWidth >= Math.min(noteWidth, main.screen.availWidth),
            "Owned native note window did not reach its ordinary width");
          report.noteWindow.actual = { width: main.outerWidth, height: main.outerHeight,
            devicePixelRatio: main.devicePixelRatio };
          await PAPERBRIDGE_WINDOWS_SUPPLEMENT({ bridge, config, check, checkpoint, until, report, state: saved });
        } finally {
          main.resizeTo(previousWindow.width, previousWindow.height);
          main.moveTo(previousWindow.x, previousWindow.y);
          if (previousWindow.state === main.STATE_MAXIMIZED) main.maximize();
          report.noteWindow.restoreRequested = true;
        }
      }
      report.previousVersion = saved.previousVersion;
    } else throw new Error("Expected create, install or reopen phase");
    report.installed = installed;
    if (config.phase !== "install" && !(config.phase === "create" && config.upgradeXpi)) {
      const finalJobs = await bridge.request("/jobs");
      check((Array.isArray(finalJobs) ? finalJobs : finalJobs.jobs).length === 0,
        "Native upgrade and note exercises finish without creating any backend model job");
      report.providerObservation.nativeBackendJobsAfter = 0;
    } else {
      // AddonManager may already have shut down this old bridge; never restart it after replacement.
      report.providerObservation.afterInstall = "Old bridge not queried after replacement; new engine verified on cold reopen";
    }
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
