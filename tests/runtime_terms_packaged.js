/** Verify native Windows runtime consent and Linux exemption in disposable profiles. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils,
          PAPERBRIDGE_TEST_ROOT, PAPERBRIDGE_RUNTIME_TERMS_TEST */
var PAPERBRIDGE_RUNTIME_TERMS_TEST_PROMISE = (async () => {
  // Only this suite's external configuration authorizes native actions and evidence writes.
  const config = PAPERBRIDGE_RUNTIME_TERMS_TEST;
  // Production package and agreement identities are deliberately independent of addon version.
  const addonID = "paperbridge@local.dev";
  const agreementID = "msvc-community-2026-v1";
  const agreementPref = "extensions.paperbridge.microsoftRuntimeTerms";
  const agreementPath = "licenses/supplemental/msvc/Microsoft-Runtime-Terms.txt";
  // First extraction of a bundled runtime may take several minutes on Windows.
  const timeoutMS = 300000;
  const pollMS = 100;
  // Two painted frames plus a short compositor/input settling period precede actual input.
  const paintDelayMS = 250;
  const quietMS = 750;
  // MOZ_SOURCE_MOUSE is 1; Gecko 140 no longer exposes nsIDOMMouseEvent in Ci.
  const mouseInputSource = 1;
  // DOM MouseEvent.buttons uses bit 1 for the held primary button.
  const primaryMouseButtons = 1;
  // PDF.js RenderingStates.FINISHED, not an initialized placeholder viewport.
  const renderingFinished = 3;
  // Track only windows/readers created by this suite, never arbitrary Zotero UI.
  const ownedWindows = new Set();
  const ownedReaders = new Set();
  const report = { suite: "runtime-terms", phase: config.phase, ok: false,
    processID: Services.appinfo.processID, os: Services.appinfo.OS, checks: [], errors: [],
    snapshots: [], nativeInput: [], requests: [], termsWindowOpens: 0, forbiddenRequests: 0,
    scope: "Exact candidate native installation, runtime consent/exemption, local health and optional synthetic PDF only",
    exclusions: ["No translation/provider requests or account sync", "No prior reading/notes reacceptance",
      "No simulated Windows result on Linux", "Host must confirm normal process exit and review screenshots"] };
  let isolated = false, ownsReport = false, bridge, manager, originalRequest, observer, saved, candidate;
  let stage = "isolation", packagedText = "", termsBytesSha256;

  /** Normalize existing native paths, respecting Windows case-insensitive equality. */
  function normalized(path) {
    let ancestor = path, result;
    const suffix = [];
    for (;;) {
      try { result = PathUtils.normalize(ancestor); break; }
      catch (error) {
        // Fresh state/output/engine names have no inode; resolve their surviving parent.
        if (!String(error).includes("NS_ERROR_FILE_NOT_FOUND")) throw error;
        const parent = PathUtils.parent(ancestor), name = PathUtils.filename(ancestor);
        if (parent === ancestor || [".", ".."].includes(name)) throw error;
        suffix.unshift(name);
        ancestor = parent;
      }
    }
    result = PathUtils.join(result, ...suffix);
    return Services.appinfo.OS === "WINNT" ? result.toLowerCase() : result;
  }

  /** Refuse every operation unless profile, data and all output paths belong to this suite. */
  function guard() {
    const base = "runtime-terms-" + config.runID;
    const root = PathUtils.join(PAPERBRIDGE_TEST_ROOT, ".runtime");
    const expectedProfile = PathUtils.join(root, base + "-profile");
    const expectedData = PathUtils.join(root, base + "-data");
    // Canonical parents plus literal suite names reject symlinks into a daily profile/data pair.
    const suiteName = Services.appinfo.OS === "WINNT" ? base.toLowerCase() : base;
    if (config.isolated !== true || config.suite !== "runtime-terms"
        || !/^[a-z0-9-]{1,32}$/i.test(config.runID) || !["create", "reopen"].includes(config.phase)
        || normalized(expectedProfile) !== PathUtils.join(normalized(root), suiteName + "-profile")
        || normalized(expectedData) !== PathUtils.join(normalized(root), suiteName + "-data")
        || normalized(config.expectedProfileDirectory) !== normalized(expectedProfile)
        || normalized(config.expectedDataDirectory) !== normalized(expectedData)
        || normalized(Services.dirsvc.get("ProfD", Ci.nsIFile).path) !== normalized(expectedProfile)
        || normalized(Zotero.DataDirectory.dir) !== normalized(expectedData)
        || normalized(PathUtils.parent(config.reportPath)) !== normalized(root)
        || !new RegExp("^" + base + "-" + config.phase + "(?:-[a-z0-9-]{1,32})?\\.json$", "i")
          .test(PathUtils.filename(config.reportPath))
        || normalized(config.statePath) !== normalized(PathUtils.join(root, base + "-state.json"))) {
      throw new Error("Refusing runtime-terms actions outside its exact isolated profile/data/output paths");
    }
  }

  /** Keep assertion failures scoped to this phase rather than implying broader acceptance. */
  function check(ok, message, details) {
    report.checks.push({ ok: !!ok, stage, scope: "runtime-terms/" + config.phase, message,
      ...(details === undefined ? {} : { details }) });
    if (!ok) throw new Error(message);
  }

  /** Update only this phase's owned report after rechecking isolation. */
  async function checkpoint(nextStage) {
    guard();
    stage = report.stage = nextStage;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Poll real native state without reissuing operations or assuming a timeout passed. */
  async function until(predicate, message) {
    const deadline = Date.now() + timeoutMS;
    do {
      guard();
      const result = await predicate();
      if (result) return result;
      await Zotero.Promise.delay(pollMS);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Bound native promises while preserving their original rejection and result. */
  async function bounded(promise, message) {
    guard();
    const main = Zotero.getMainWindow();
    let timer;
    try {
      return await Promise.race([promise, new Promise(function deadline(_resolve, reject) {
        timer = main.setTimeout(function timedOut() { reject(new Error(message)); }, timeoutMS);
      })]);
    } finally { main.clearTimeout(timer); }
  }

  /** Stream large on-disk archives instead of loading a bundled XPI into memory. */
  function fileSha256(path) {
    guard();
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    // Read-only file input and the nsICryptoHash entire-stream sentinel.
    const readOnly = 0x01;
    const entireStream = 0xffffffff;
    stream.init(file, readOnly, 0, 0);
    try {
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, entireStream);
      return Array.from(hash.finish(false), function hex(byte) {
        return byte.charCodeAt(0).toString(16).padStart(2, "0");
      }).join("");
    } finally { stream.close(); }
  }

  /** Hash complete UTF-8 text separately from original packaged byte identity. */
  function bytesSha256(bytes) {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), function hex(byte) {
      return byte.charCodeAt(0).toString(16).padStart(2, "0");
    }).join("");
  }

  /** Read only candidate metadata and the complete offline agreement via Gecko ZIP APIs. */
  function archive(path) {
    guard();
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(file);
    /** Decode one explicit UTF-8 archive entry, preserving all agreement bytes. */
    function entry(name) {
      const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      stream.init(zip.getInputStream(name));
      try {
        const raw = stream.read(stream.available());
        const bytes = Uint8Array.from(raw, function byte(value) { return value.charCodeAt(0); });
        return { text: new (Zotero.getMainWindow().TextDecoder)("utf-8", { fatal: true }).decode(bytes),
          sha256: bytesSha256(bytes) };
      } finally { stream.close(); }
    }
    try {
      const manifest = JSON.parse(entry("manifest.json").text);
      const build = JSON.parse(entry("runtime/" + config.expectedPlatform + "/runtime.json").text);
      const terms = entry(agreementPath);
      return { path, sha256: fileSha256(path), addonID: manifest.applications.zotero.id,
        version: manifest.version, platform: build.platform, mode: build.pythonMode,
        buildId: build.buildId, terms };
    } finally { zip.close(); }
  }

  /** Attest the actual active AddonManager resource, never the selected input as installed. */
  async function installedIdentity() {
    guard();
    const addon = await manager.getAddonByID(addonID);
    check(addon?.isActive && addon.version === config.expectedVersion, "AddonManager has the exact active candidate");
    const uri = addon.getResourceURI("manifest.json");
    check(uri.scheme === "jar", "Active candidate has a hashable installed XPI resource");
    const path = uri.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file.path;
    check(normalized(PathUtils.parent(path)) === normalized(PathUtils.join(config.expectedProfileDirectory, "extensions")),
      "Installed candidate is inside this suite's isolated extensions directory");
    const actual = archive(path);
    check(actual.sha256 === config.candidateSha256 && actual.version === config.expectedVersion
      && actual.mode === config.expectedMode && actual.buildId === config.expectedBuildId
      && actual.platform === config.expectedPlatform && actual.addonID === addonID,
    "Final on-disk XPI hash/version/mode/platform/build match the precise candidate",
    { ...actual, terms: { sha256: actual.terms.sha256, characters: actual.terms.text.length } });
    return actual;
  }

  /** Install the actual fresh candidate using native AddonManager events, never file copying. */
  async function installCandidate() {
    guard();
    check(!await manager.getAddonByID(addonID), "Fresh suite has no preinstalled PaperBridge candidate");
    check(!await IOUtils.exists(config.statePath), "Fresh create never replaces a previous state identity");
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(config.candidateXpi);
    const install = await manager.getInstallForFile(file);
    let completed = false, failure;
    report.nativeInstall = { method: "AddonManager.getInstallForFile/install", events: [] };
    const listener = {
      /** Record completion from the native installer rather than install()'s return. */
      onInstallEnded(value, addon) {
        report.nativeInstall.events.push({ event: "onInstallEnded", state: value.state,
          id: addon.id, version: addon.version });
        completed = addon.id === addonID && addon.version === config.expectedVersion;
        if (!completed) failure = new Error("Native installation ended with the wrong addon identity");
      },
      /** Preserve native installation failure without replacing the candidate by hand. */
      onInstallFailed(value) { failure = new Error("Native installation failed: " + value.error); },
      /** Do not treat user cancellation as an installed candidate. */
      onInstallCancelled() { failure = new Error("Native installation cancelled"); },
      /** Retain file-install download-stage failure if Gecko reports one. */
      onDownloadFailed(value) { failure = new Error("Native file download failed: " + value.error); },
      /** Retain cancellation before the install stage. */
      onDownloadCancelled() { failure = new Error("Native file download cancelled"); }
    };
    install.addListener(listener);
    try {
      Promise.resolve(install.install()).catch(function rejected(error) { failure = error; });
      await until(function ended() { if (failure) throw failure; return completed; }, "Native file install did not finish");
    } finally { install.removeListener(listener); }
  }

  /** Count real terms windows, including any unexpected background prompt. */
  function termsWindows() {
    const result = [];
    const windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      const window = windows.getNext();
      if (!window.closed && window.document?.documentURI === "chrome://paperbridge/content/runtime-terms.xhtml") result.push(window);
    }
    return result;
  }

  /** Observe real bridge calls and block fee-bearing endpoints without mocking local responses. */
  function observeRequests() {
    guard();
    originalRequest = bridge.request;
    /** Forward the original options unchanged so background consent gating remains production code. */
    bridge.request = async function observedRequest(path, method = "GET", data, options) {
      guard();
      const request = { path, method, interactive: options?.interactive, at: new Date().toISOString() };
      report.requests.push(request);
      if (/^\/(?:providers|translate)(?:[/?]|$)/.test(path)
          || method.toUpperCase() !== "GET" && /^\/jobs(?:[/?]|$)/.test(path)) {
        report.forbiddenRequests++;
        throw new Error("Runtime-terms suite forbids provider/translation/job mutation requests");
      }
      try {
        const result = await originalRequest.call(this, path, method, data, options);
        request.result = "resolved";
        return result;
      } catch (error) {
        request.result = "rejected";
        request.paperbridgeTerms = error.paperbridgeTerms === true;
        throw error;
      }
    };
  }

  /** Focus, fit and paint a real top-level window before native screen coordinates are measured. */
  async function painted(window, requireFocus = true) {
    guard();
    check(window === Zotero.getMainWindow() || ownedWindows.has(window), "Only suite-owned UI is focused or resized");
    await until(function loaded() { return !window.closed && window.document.readyState === "complete"; }, "UI document did not load");
    window.focus();
    Services.focus.activeWindow = window;
    const screen = window.screen;
    if (window.outerWidth > screen.availWidth || window.outerHeight > screen.availHeight) {
      window.resizeTo(Math.min(window.outerWidth, screen.availWidth), Math.min(window.outerHeight, screen.availHeight));
    }
    window.moveTo(Math.max(screen.availLeft, Math.min(window.screenX, screen.availLeft + screen.availWidth - window.outerWidth)),
      Math.max(screen.availTop, Math.min(window.screenY, screen.availTop + screen.availHeight - window.outerHeight)));
    // Foreground focus is mandatory for OS input, not for composited read-only snapshots.
    if (requireFocus) await until(function focused() { return window.document.hasFocus(); }, "Native foreground window focus unavailable");
    await bounded(new Promise(function frames(resolve) {
      window.requestAnimationFrame(function firstFrame() { window.requestAnimationFrame(function secondFrame() { resolve(); }); });
    }), "Visible UI did not paint two animation frames");
    await Zotero.Promise.delay(paintDelayMS);
  }

  /** Exercise the real button through trusted Gecko input, never .click() or a preference write. */
  async function nativeClick(element) {
    guard();
    check(Services.appinfo.OS === "WINNT", "Native Windows input is not simulated on another platform");
    const window = element.ownerDocument.defaultView;
    await painted(window);
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    await painted(window);
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = element.ownerDocument.elementFromPoint(x, y);
    const screenX = window.mozInnerScreenX + x, screenY = window.mozInnerScreenY + y;
    const screen = window.screen;
    const input = { id: element.id, method: "windowUtils.sendMouseEvent", trusted: false, events: [],
      scope: "Trusted native Gecko input in the real UI; external OS mouse injection is not claimed",
      devicePixelRatio: window.devicePixelRatio, cssPoint: { x, y }, screenCSS: { x: screenX, y: screenY },
      screenPhysical: { x: Math.round(screenX * window.devicePixelRatio), y: Math.round(screenY * window.devicePixelRatio) },
      bounds: { left: box.left, top: box.top, width: box.width, height: box.height },
      availableScreen: { left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight } };
    report.nativeInput.push(input);
    check(box.width > 0 && box.height > 0 && !element.hidden && !element.disabled
      && x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight
      && (hit === element || element.contains(hit))
      && screenX >= screen.availLeft && screenX < screen.availLeft + screen.availWidth
      && screenY >= screen.availTop && screenY < screen.availTop + screen.availHeight,
    "Painted button is hit-testable and inside the actual available screen", input);
    const native = Components.utils.unwaiveXrays(window);
    const utilities = native.windowUtils || native.docShell.domWindowUtils;
    check(typeof utilities.sendMouseEvent === "function", "Gecko trusted mouse input API is available");
    /** Capture passive trusted input before the actual production handler closes its window. */
    function observed(event) {
      input.events.push({ type: event.type, trusted: event.isTrusted, target: event.target.id,
        clientX: event.clientX, clientY: event.clientY });
      if (event.type === "click" && event.isTrusted) input.trusted = true;
    }
    const types = ["mousedown", "mouseup", "click"];
    for (const type of types) element.addEventListener(type, observed, { capture: true, passive: true });
    try {
      utilities.sendMouseEvent("mousemove", x, y, 0, 0, 0, false, 0, mouseInputSource, true, false, 0);
      utilities.sendMouseEvent("mousedown", x, y, 0, 1, 0, false, 0, mouseInputSource, true, false, primaryMouseButtons);
      utilities.sendMouseEvent("mouseup", x, y, 0, 1, 0, false, 0, mouseInputSource, true, false, 0);
      await until(function clicked() { return input.trusted; }, "Button did not receive a trusted native mouse click: " + element.id);
      check(types.every(function trusted(type) { return input.events.some(function received(event) {
        return event.type === type && event.trusted && event.target === element.id;
      }); }), "Production button received trusted down/up/click from native Gecko input", input);
    } finally { for (const type of types) element.removeEventListener(type, observed, true); }
  }

  /** Save composited Gecko pixels under a unique phase-report-derived name. */
  async function snapshot(window, label) {
    guard();
    await painted(window, false);
    const path = config.reportPath.replace(/\.json$/, "-" + label + ".png");
    check(!await IOUtils.exists(path), "Screenshot never overwrites earlier evidence");
    const global = window.browsingContext?.currentWindowGlobal || window.windowGlobalChild?.parentActor;
    check(typeof global?.drawSnapshot === "function", "Native composited snapshot API is available");
    const bitmap = await bounded(global.drawSnapshot(null, window.devicePixelRatio, "rgb(255,255,255)"), "Native snapshot timed out");
    try {
      check(bitmap.width > 0 && bitmap.height > 0, "Screenshot contains actual native rendered pixels");
      const canvas = window.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await bounded(new Promise(function encode(resolve) { canvas.toBlob(resolve, "image/png"); }), "PNG encoding timed out");
      check(!!blob, "Native PNG encoding succeeded");
      await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()), { noOverwrite: true });
      report.snapshots.push({ path, label, width: bitmap.width, height: bitmap.height,
        devicePixelRatio: window.devicePixelRatio, method: "WindowGlobalParent.drawSnapshot",
        scope: "Gecko viewport; excludes OS decorations/cursor", visualQA: "pending host review" });
    } finally { bitmap.close(); }
  }

  /** Read the complete displayed agreement and prove equality with the installed offline bytes. */
  async function termsWindow(startupFailure = null) {
    guard();
    const window = await until(function opened() {
      // Surface an early startup rejection instead of waiting for a window that cannot open.
      const error = startupFailure?.();
      if (error) throw error;
      return bridge.runtime.terms.window;
    }, "Production terms window did not open");
    ownedWindows.add(window);
    await painted(window);
    const text = await until(function textLoaded() { return window.document.getElementById("terms-text")?.textContent; }, "Offline agreement text did not load");
    check(text === packagedText && text.length > 0, "Real terms window displays the entire installed offline agreement");
    report.offlineTerms = { identity: agreementID, path: agreementPath, text,
      characters: text.length, packagedBytesSha256: termsBytesSha256,
      displayedTextSha256: bytesSha256(new (Zotero.getMainWindow().TextEncoder)().encode(text)), completeTextEqual: true };
    return window;
  }

  /** Assert absence of consent, an extracted engine and background/duplicate terms windows. */
  async function stillBlocked(message) {
    guard();
    await Zotero.Promise.delay(quietMS);
    check(!Services.prefs.prefHasUserValue(agreementPref) && !bridge.runtime.terms.accepted()
      && !await IOUtils.exists(bridge.runtime.home) && !bridge.runtime.connection && !bridge.runtime.process
      && termsWindows().length === 0 && !bridge.runtime.terms.window, message,
    { preferenceHasUserValue: Services.prefs.prefHasUserValue(agreementPref), windows: report.termsWindowOpens });
  }

  /** Run the actual blocked health request and retain the production error marker. */
  async function blockedHealth(options, label) {
    guard();
    let error;
    try { await bounded(bridge.request("/health", "GET", undefined, options), "Blocked health did not finish"); }
    catch (value) { error = value; }
    check(error?.paperbridgeTerms === true, "Actual " + label + " health is rejected with paperbridgeTerms", { error: String(error) });
  }

  /** Open only an explicitly supplied synthetic PDF and close its real rendered reader normally. */
  async function optionalPDF() {
    guard();
    if (!config.sourcePDF) {
      report.pdf = { exercised: false, scope: "No synthetic --source-pdf supplied; basic PDF reading not claimed" };
      return;
    }
    const inputHash = fileSha256(config.sourcePDF);
    const attachment = await Zotero.Attachments.importFromFile({ file: config.sourcePDF, libraryID: Zotero.Libraries.userLibraryID });
    const opened = await Zotero.Reader.open(attachment.id);
    const reader = opened || await until(function readerOpened() {
      return Zotero.Reader._readers.find(function own(value) { return value.itemID === attachment.id; });
    }, "Synthetic native reader did not open");
    ownedReaders.add(reader);
    try {
      await bounded(reader._initPromise, "Native reader initialization timed out");
      const view = bridge.readerView(reader);
      await bounded(view.initializedPromise, "Actual PDF view initialization timed out");
      const frame = view._iframeWindow;
      const app = await until(function appReady() { return frame.PDFViewerApplication?.pdfDocument && frame.PDFViewerApplication; }, "Native PDF document did not load");
      const main = Zotero.getMainWindow();
      main.Zotero_Tabs.select(reader.tabID);
      // A rendered PDF and its composited pixels do not require an OS pointer/foreground event.
      await painted(main, false);
      app.pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: 1 }, frame));
      const page = await until(function rendered() {
        const value = app.pdfViewer.getPageView(0);
        const canvas = value?.div.querySelector("canvas");
        return value?.renderingState === renderingFinished && canvas?.width > 0 && canvas.height > 0 && value;
      }, "Synthetic native PDF page did not paint");
      check(fileSha256(await attachment.getFilePathAsync()) === inputHash, "Imported synthetic PDF has exact supplied bytes");
      await snapshot(main, "synthetic-pdf");
      report.pdf = { exercised: true, input: config.sourcePDF, sha256: inputHash, attachmentKey: attachment.key,
        pages: app.pdfDocument.numPages, renderingState: page.renderingState,
        scope: "Only this explicit synthetic PDF rendered; not prior reading/notes acceptance" };
      if (Services.appinfo.OS === "WINNT") await stillBlocked("Synthetic native PDF reads after refusal without an engine or consent");
    } finally {
      guard();
      reader.close();
      await until(function closed() { return !Zotero.Reader._readers.includes(reader); }, "Synthetic reader did not close normally");
      ownedReaders.delete(reader);
    }
  }

  /** Open actual production settings, not a fabricated test dialog or provider-check action. */
  async function settingsWindow() {
    guard();
    bridge.settings();
    const window = await until(function opened() {
      const windows = Services.wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const value = windows.getNext();
        if (!value.closed && value.document?.documentURI === "chrome://paperbridge/content/settings.xhtml") return value;
      }
      return null;
    }, "Production settings window did not open");
    ownedWindows.add(window);
    await painted(window);
    await until(function ready() { return window.document.getElementById("runtime-terms-status")?.textContent; }, "Settings terms status did not initialize");
    check(!window.document.getElementById("runtime-terms").hidden, "Windows production settings expose the runtime terms controls");
    return window;
  }

  /** Start the real local engine and bind health/installation metadata to this candidate. */
  async function health() {
    guard();
    const opens = report.termsWindowOpens;
    report.health = await bounded(bridge.request("/health"), "Real local health timed out");
    const marker = await IOUtils.readJSON(PathUtils.join(bridge.runtime.home, "installed.json"));
    report.engineMarker = marker;
    check(report.health.version === config.expectedVersion && report.health.engine === "BabelDOC 0.6.4"
      && marker.version === config.expectedVersion && marker.pythonMode === config.expectedMode
      && marker.platform === config.expectedPlatform && marker.buildId === config.expectedBuildId,
    "Actual local health and extracted runtime match version/mode/build/platform with BabelDOC 0.6.4");
    const jobs = await bounded(bridge.request("/jobs", "GET", undefined, { interactive: false }), "Native job observation timed out");
    check(Array.isArray(jobs.jobs) && jobs.jobs.length === 0 && report.forbiddenRequests === 0,
      "Real isolated job store is empty and no provider/translation request was attempted");
    await Zotero.Promise.delay(quietMS);
    check(report.termsWindowOpens === opens && termsWindows().length === 0, "Accepted/exempt health never opens a terms window");
  }

  /** Exercise refusal, same-session suppression and explicit settings acceptance through native input. */
  async function windowsCreate() {
    check(bridge.runtime.terms.required(), "Windows requires the Microsoft runtime agreement");
    await stillBlocked("Fresh Windows profile has no agreement preference, terms window or engine");
    const initialOpens = report.termsWindowOpens;
    await blockedHealth({ interactive: false }, "background");
    await stillBlocked("Background health neither prompts nor extracts an engine");
    check(report.termsWindowOpens === initialOpens, "No background terms window opened even transiently");
    await checkpoint("native-first-use-window");
    // Attach a rejection observer immediately; the real request remains pending until native refusal.
    let startupFailure = null;
    const active = bridge.request("/health").then(function unexpected(value) { return { value }; }, function declined(error) {
      startupFailure = error;
      return { error };
    });
    const window = await termsWindow(function rejectedBeforeWindow() { return startupFailure; });
    check(report.termsWindowOpens === initialOpens + 1, "First active health opens exactly one real terms window");
    check(!await IOUtils.exists(bridge.runtime.home) && !Services.prefs.prefHasUserValue(agreementPref),
      "Visible first-use terms window has not extracted an engine or saved agreement");
    await snapshot(window, "terms-decline");
    await nativeClick(window.document.getElementById("terms-decline"));
    await checkpoint("native-decline");
    const result = await bounded(active, "Active request did not finish after native decline");
    check(result.error?.paperbridgeTerms === true, "Native decline rejects the pending active health request");
    await stillBlocked("Native refusal leaves consent unset and runtime unextracted");
    const refusedOpens = report.termsWindowOpens;
    await blockedHealth(undefined, "same-session active retry");
    await stillBlocked("Same-session active retry stays blocked without a second automatic window");
    check(report.termsWindowOpens === refusedOpens, "Declined session never automatically reopens the terms window");
    await checkpoint("native-pdf-after-decline");
    await optionalPDF();
    const settings = await settingsWindow();
    const beforeStatus = settings.document.getElementById("runtime-terms-status").textContent;
    await snapshot(settings, "settings-unaccepted");
    await nativeClick(settings.document.getElementById("runtime-terms-view"));
    const review = await termsWindow();
    await snapshot(review, "terms-accept");
    const requestStart = report.requests.length;
    await nativeClick(review.document.getElementById("terms-accept"));
    await checkpoint("native-accept");
    await until(function accepted() { return bridge.runtime.terms.accepted() && !bridge.runtime.terms.window; }, "Native acceptance did not persist production consent");
    check(Services.prefs.getStringPref(agreementPref, "") === agreementID, "Only the real accept button saved the current agreement identity");
    Services.prefs.savePrefFile(null);
    const afterStatus = await until(function updated() {
      const text = settings.document.getElementById("runtime-terms-status").textContent;
      return text !== beforeStatus && text.includes("已同意") && text;
    }, "Production settings did not update after native acceptance");
    report.settingsStatus = { before: beforeStatus, after: afterStatus };
    // A fresh library needs no engine merely to accept from settings; do not seed paid jobs.
    await Zotero.Promise.delay(quietMS);
    check(!bridge.runtime.process && !bridge.runtime.connection && !await IOUtils.exists(bridge.runtime.home),
      "Fresh settings acceptance does not start or unpack an unneeded engine");
    check(!report.requests.slice(requestStart).some(function unnecessary(request) { return request.path === "/jobs"; }),
      "Fresh consent does not create an unnecessary job polling loop");
    report.acceptCallbackScope = "Fresh library remains lazy after consent; pre-existing job reconciliation was not seeded or claimed tested";
    await snapshot(settings, "settings-accepted");
    settings.close();
    await checkpoint("native-engine-after-accept");
    await health();
  }

  /** Verify persisted acceptance and read-only review in a different native process. */
  async function reopen() {
    saved = await IOUtils.readJSON(config.statePath);
    check(saved.complete === true && saved.suite === "runtime-terms" && saved.processID !== report.processID,
      "Cold reopen uses this completed suite state in a genuinely different PID");
    check(saved.nativeInstall?.method === "AddonManager.getInstallForFile/install"
      && saved.nativeInstall.events.some(function completed(event) {
        return event.event === "onInstallEnded" && event.id === addonID && event.version === report.installed.version;
      }), "Cold reopen retains actual native file-install evidence, not just a copied XPI identity");
    check(normalized(saved.profile) === normalized(config.expectedProfileDirectory)
      && normalized(saved.data) === normalized(config.expectedDataDirectory)
      && saved.installed.sha256 === report.installed.sha256 && saved.installed.mode === report.installed.mode
      && saved.installed.version === report.installed.version && saved.installed.buildId === report.installed.buildId
      && saved.termsTextSha256 === bytesSha256(new (Zotero.getMainWindow().TextEncoder)().encode(packagedText))
      && saved.termsBytesSha256 === termsBytesSha256 && saved.platform === config.expectedPlatform,
    "Cold reopen retains the same actual installed package/profile/data/agreement text identity");
    report.createState = { path: config.statePath, processID: saved.processID, installed: saved.installed,
      nativeInstall: saved.nativeInstall };
    if (Services.appinfo.OS === "WINNT") {
      check(saved.nativeInput?.some(function accepted(input) {
        return input.id === "terms-accept" && input.trusted === true && input.method === "windowUtils.sendMouseEvent";
      }), "Retained acceptance came from the actual trusted native accept-button input");
      check(saved.acceptanceIdentity === agreementID && Services.prefs.getStringPref(agreementPref, "") === agreementID
        && bridge.runtime.terms.accepted(), "Windows native acceptance survives cold process restart");
      await health();
      const settings = await settingsWindow();
      await nativeClick(settings.document.getElementById("runtime-terms-view"));
      const window = await termsWindow();
      check(window.document.getElementById("terms-accept").hidden, "Already accepted agreement review hides the accept button");
      await snapshot(window, "accepted-review");
      await nativeClick(window.document.getElementById("terms-decline"));
      await until(function closed() { return !bridge.runtime.terms.window; }, "Accepted terms review did not close");
      check(bridge.runtime.terms.accepted() && Services.prefs.getStringPref(agreementPref, "") === agreementID,
        "Closing accepted review does not clear native consent");
      await snapshot(settings, "settings-persisted");
      settings.close();
      await health();
    } else {
      check(!bridge.runtime.terms.required() && saved.acceptanceIdentity === null,
        "Linux cold reopen remains exempt; no Windows acceptance is claimed");
      check(!Services.prefs.prefHasUserValue(agreementPref), "Linux cold reopen has no persisted Windows acceptance preference");
      await health();
      await snapshot(Zotero.getMainWindow(), "linux-reopen");
    }
  }

  try {
    guard();
    isolated = true;
    if (await IOUtils.exists(config.reportPath)) {
      const prior = await IOUtils.readJSON(config.reportPath);
      check(prior.processID === report.processID && /^helper-/.test(prior.stage) && prior.checks?.length === 0,
        "Only this launch's helper checkpoint can be replaced; earlier phase evidence is retained");
    }
    ownsReport = true;
    check(["WINNT", "Linux"].includes(Services.appinfo.OS), "Suite runs only on actual native Windows or Linux");
    check(config.expectedPlatform === (Services.appinfo.OS === "WINNT" ? "windows-x64" : "linux-x64"),
      "Configured candidate platform matches the real host OS");
    check(!Services.prefs.getBoolPref("extensions.zotero.sync.autoSync", true), "Isolated suite has account auto-sync disabled");
    await checkpoint("candidate-inspection");
    candidate = archive(config.candidateXpi);
    check(candidate.sha256 === config.candidateSha256 && candidate.addonID === addonID
      && candidate.version === config.expectedVersion && candidate.mode === config.expectedMode
      && candidate.platform === config.expectedPlatform && candidate.buildId === config.expectedBuildId,
    "Selected actual candidate has the exact configured hash/version/mode/platform/build");
    manager = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
    observer = { /** Count every newly loaded real terms window, including short-lived prompts. */
      observe(subject) {
        /** Observe the actual document after native chrome-window creation. */
        function loaded() {
          if (subject.document?.documentURI === "chrome://paperbridge/content/runtime-terms.xhtml") {
            report.termsWindowOpens++;
            ownedWindows.add(subject);
          }
        }
        subject.addEventListener("load", loaded, { once: true });
      }
    };
    Services.obs.addObserver(observer, "domwindowopened");
    check(termsWindows().length === 0, "No terms window predates this phase's observation");
    if (config.phase === "create") {
      check(!Services.prefs.prefHasUserValue(agreementPref), "Fresh profile starts without any user consent preference");
      await checkpoint("native-file-install");
      await installCandidate();
    }
    bridge = await until(function started() { return Zotero.PaperBridge?.runtime?.terms && Zotero.PaperBridge; }, "Installed production bridge did not start");
    observeRequests();
    await bounded(bridge.ready, "Production bridge startup did not settle");
    report.installed = await installedIdentity();
    packagedText = report.installed.terms.text;
    termsBytesSha256 = report.installed.terms.sha256;
    // Keep complete text once in the report, not in every identity/state copy.
    delete report.installed.terms;
    check(normalized(bridge.runtime.home) === normalized(PathUtils.join(config.expectedDataDirectory, "paperbridge", "engine")),
      "Production engine path belongs to this suite's isolated data directory");
    await checkpoint("native-consent-" + config.phase);
    if (config.phase === "reopen") await reopen();
    else if (Services.appinfo.OS === "WINNT") await windowsCreate();
    else {
      check(!bridge.runtime.terms.required() && bridge.runtime.terms.accepted(), "Actual Linux runtime is exempt from Microsoft terms");
      check(!Services.prefs.prefHasUserValue(agreementPref), "Linux exemption does not write a Windows agreement preference");
      await optionalPDF();
      await health();
      check(report.termsWindowOpens === 0, "Linux native create opened no terms windows");
      await snapshot(Zotero.getMainWindow(), "linux-create");
    }
    check(report.forbiddenRequests === 0, "No fee-bearing request was attempted during this phase");
    Services.prefs.savePrefFile(null);
    report.acceptanceIdentity = Services.prefs.getStringPref(agreementPref, "") || null;
    report.termsTextSha256 = bytesSha256(new (Zotero.getMainWindow().TextEncoder)().encode(packagedText));
    report.termsBytesSha256 = termsBytesSha256;
    if (config.phase === "create") {
      guard();
      await IOUtils.writeUTF8(config.statePath, JSON.stringify({ suite: "runtime-terms", complete: true,
        processID: report.processID, profile: config.expectedProfileDirectory, data: config.expectedDataDirectory,
        installed: report.installed, platform: config.expectedPlatform, acceptanceIdentity: report.acceptanceIdentity,
        nativeInstall: report.nativeInstall, nativeInput: report.nativeInput,
        termsTextSha256: report.termsTextSha256, termsBytesSha256, createReport: config.reportPath }, null, 2), { noOverwrite: true });
    }
    report.ok = true;
  } catch (error) {
    report.errors.push({ scope: "runtime-terms/" + config.phase, stage, message: String(error), stack: error.stack || "" });
    Zotero.logError(error);
    if (isolated && ownsReport) {
      try {
        const window = [...ownedWindows].find(function visible(value) { return !value.closed; }) || Zotero.getMainWindow();
        await snapshot(window, "failure");
      } catch (failure) { report.errors.push({ scope: "failure-snapshot", stage, message: String(failure) }); }
    }
  } finally {
    if (isolated && ownsReport) {
      guard();
      if (observer) Services.obs.removeObserver(observer, "domwindowopened");
      for (const reader of ownedReaders) reader.close();
      for (const window of ownedWindows) if (!window.closed) window.close();
      if (originalRequest && bridge) bridge.request = originalRequest;
      report.quit = { method: "Services.startup.quit(eAttemptQuit)", requested: config.quit === true,
        scope: "Normal quit requested, not proof of process exit; host must confirm before reopen" };
      await checkpoint(report.ok ? "complete" : "failed");
      if (config.quit) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
