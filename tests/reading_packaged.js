/** Verify real-paper/column hover and persisted mappings in a genuinely restarted Zotero. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils, PAPERBRIDGE_READING_TEST */
(async () => {
  // Only explicit disposable profiles may receive imports, annotations or quit requests.
  const config = PAPERBRIDGE_READING_TEST;
  // Native rendering and disk writes have a generous bounded wait on both operating systems.
  const waitMS = 60000;
  // Poll native work without issuing repeated geometry changes.
  const pollMS = 100;
  // Native line boxes may extend slightly beyond the actual glyph geometry.
  const rangeTolerance = 2;
  // CSS registry identity is shared with the production controller, not another painter.
  const highlightName = "paperbridge-paragraph-hover";
  // The schema has one independently verified page location on each side.
  const sides = ["source", "target"];
  const report = { ok: false, phase: config.phase, stage: "isolation", checks: [], cases: [], errors: [],
    rendererErrors: [], jobsPostAttempts: 0, validationCalls: 0,
    processID: Services.appinfo.processID, platform: Services.appinfo.OS, zoteroVersion: Zotero.version,
    scope: { sentenceWordAlignment: false, translationRequests: 0, fullPaperSemanticAcceptance: false,
      crossPageFragmentPolicy: "Untraceable multi-page/moved fragments are excluded, not guessed" } };
  let isolated = false, bridge, originalRequest, guardedRequest, split;
  const opened = new Set();

  /** Preserve unexpected native quit provenance before asynchronous report writes are stopped. */
  function lifecycle(subject, topic) {
    const entry = { topic, stage: report.stage, waiting: report.waiting, stack: new Error().stack,
      harnessQuit: report.quitRequestedByHarness === true };
    (report.lifecycle ||= []).push(entry);
    // Small synchronous task-only evidence survives closing the last native window.
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(config.reportPath.replace(/\.json$/, "-lifecycle.json"));
    const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    // Write/create/truncate flags target only the explicit isolated report path.
    const writeFlags = 0x02 | 0x08 | 0x20;
    stream.init(file, writeFlags, 0o600, 0);
    try { const text = JSON.stringify(report.lifecycle); stream.write(text, text.length); }
    finally { stream.close(); }
  }

  /** Retain progress and failure evidence independently of native teardown. */
  async function write() {
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Record each real assertion before stopping on failure. */
  function check(value, name, details = {}) {
    report.checks.push({ name, pass: !!value, details });
    if (!value) throw new Error(name + ": " + JSON.stringify(details));
  }

  /** Await observed native state without substituting renderer or storage implementations. */
  async function until(predicate, name) {
    report.waiting = name;
    await write();
    const deadline = Date.now() + waitMS;
    do {
      const value = await predicate();
      if (value) { delete report.waiting; return value; }
      await Zotero.Promise.delay(pollMS);
    } while (Date.now() < deadline);
    throw new Error(name);
  }

  /** Bound a native promise while preserving its original rejection. */
  async function ready(promise, name) {
    let done = false, failure;
    Promise.resolve(promise).then(() => { done = true; }, error => { failure = error; done = true; });
    await until(() => { if (failure) throw failure; return done; }, name);
  }

  /** Compare real profile paths with the host's case sensitivity. */
  function samePath(left, right) {
    const a = PathUtils.normalize(left), b = PathUtils.normalize(right);
    return Zotero.isWin ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** Convert portable manifest separators before Gecko validates a Windows file path. */
  function nativePath(path) {
    return PathUtils.normalize(Zotero.isWin ? path.replaceAll("/", "\\") : path);
  }

  /** Bind cold-restart assertions to exact on-disk bytes, not filenames or versions alone. */
  async function sha256(path) {
    const bytes = await IOUtils.read(path);
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  /** Snapshot only nonsecret user preferences used by the normal integration. */
  function preferences() {
    return Object.fromEntries(["pythonPath", "profile", "model", "language", "pages"].map(key => [key, bridge.pref(key)]));
  }

  /** Preserve actual annotation identity, content and PDF coordinates across process exits. */
  function annotations(source, target) {
    return [source, target].map(item => item.getAnnotations().map(annotation => ({ key: annotation.key,
      parentID: annotation.parentID, type: annotation.annotationType, text: annotation.annotationText,
      comment: annotation.annotationComment, color: annotation.annotationColor,
      position: annotation.annotationPosition, dateModified: annotation.dateModified,
      tags: annotation.getTags() })).sort((a, b) => a.key.localeCompare(b.key)));
  }

  /** Send trusted passive hover/click input through Gecko's public mouse API. */
  function mouse(frame, type, x, y, buttons = type === "mousedown" ? 1 : 0) {
    const window = Components.utils.unwaiveXrays(frame);
    const utilities = window.windowUtils || window.docShell?.domWindowUtils;
    if (!utilities?.sendMouseEvent) throw new Error("Native mouse input unavailable");
    utilities.sendMouseEvent(type, x, y, 0, type === "mousemove" ? 0 : 1, 0,
      false, 0, 1, true, false, buttons);
  }

  /** Click the actual independent toolbar control instead of calling its controller method. */
  async function click(button) {
    const main = Zotero.getMainWindow();
    main.focus();
    Services.focus.activeWindow = main;
    const box = button.getBoundingClientRect(), frame = button.ownerDocument.defaultView;
    Components.utils.unwaiveXrays(frame).focus();
    mouse(frame, "mousedown", box.left + box.width / 2, box.top + box.height / 2);
    mouse(frame, "mouseup", box.left + box.width / 2, box.top + box.height / 2);
    await Zotero.Promise.delay(pollMS);
  }

  /** Wait for the specified real page and text layer after a single native page change. */
  async function page(index, number) {
    return until(() => {
      const viewer = split.apps[index].pdfViewer, view = viewer.getPageView(number);
      return view?.renderingState === 3 && view.div?.isConnected && view.scale === viewer.currentScale
        && view.viewport.rotation === viewer.pagesRotation && view.div.querySelector(".textLayer span") && view;
    }, "Render " + sides[index] + " page " + (number + 1));
  }

  /** Snapshot visible positions so cosmetic hover cannot silently navigate either pane. */
  function positions() {
    return split.apps.map(app => ({ page: app.pdfViewer.currentPageNumber, scale: app.pdfViewer.currentScale,
      top: app.pdfViewer.container.scrollTop, left: app.pdfViewer.container.scrollLeft }));
  }

  /** Let actual scroll/layout callbacks settle before recording hover invariants. */
  async function settle() {
    let previous, repeats = 0;
    await until(() => {
      const current = JSON.stringify(positions());
      repeats = current === previous ? repeats + 1 : 0;
      previous = current;
      return repeats >= 3;
    }, "Both native panes settle");
  }

  /** Detect controls outside the target PDF iframe before issuing native input. */
  function coveredByControls(index, x, y) {
    if (index !== 1) return false;
    const element = Components.utils.unwaiveXrays(split.frames[index]).frameElement;
    if (!element?.ownerDocument?.isSameNode(split.alignment.control.ownerDocument)) return false;
    const outer = element.getBoundingClientRect();
    const hit = element.ownerDocument.elementFromPoint(outer.left + x * outer.width / split.frames[index].innerWidth,
      outer.top + y * outer.height / split.frames[index].innerHeight);
    return !!hit?.closest(".paperbridge-split-controls");
  }

  /** Choose a visible native glyph with an unambiguous verified request identity. */
  function pointFor(index, location, rectangle, unitID = null) {
    const view = split.apps[index].pdfViewer.getPageView(location.page);
    const bounds = view.div.getBoundingClientRect();
    for (const span of view.div.querySelectorAll(".textLayer span")) {
      if (span.childElementCount || !span.textContent.trim()) continue;
      const range = span.ownerDocument.createRange();
      range.selectNodeContents(span);
      for (const rect of range.getClientRects()) {
        // The real floating toolbar can cover a line midpoint; never hover through that UI.
        for (const fraction of [0.5, 0.2, 0.8]) for (const vertical of [0.5, 0.2, 0.8]) {
          // Gecko mouse input uses integer CSS coordinates; validate the point it will receive.
          const x = Math.round(rect.left + rect.width * fraction), y = Math.round(rect.top + rect.height * vertical);
          if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0
            || x >= split.frames[index].innerWidth || y >= split.frames[index].innerHeight) continue;
          const hit = span.ownerDocument.elementFromPoint(x, y);
          if (hit?.closest(".page") !== view.div || hit.closest(".paperbridge-split-controls, button, input, textarea")) continue;
          if (coveredByControls(index, x, y)) continue;
          const localX = ((x - bounds.left) * view.div.offsetWidth / bounds.width - view.div.clientLeft)
            * view.viewport.width / view.div.clientWidth;
          const localY = ((y - bounds.top) * view.div.offsetHeight / bounds.height - view.div.clientTop)
            * view.viewport.height / view.div.clientHeight;
          // Native viewport arrays belong to an iframe that is destroyed when its reader closes.
          const pdf = Array.from(view.viewport.convertToPdfPoint(localX, localY));
          if (!(pdf[0] >= rectangle[0] && pdf[0] <= rectangle[2]
            && pdf[1] >= rectangle[1] && pdf[1] <= rectangle[3])) continue;
          if (unitID) {
            // Tall accents can overlap another request's box; production correctly ignores ambiguity.
            const side = sides[index];
            const hits = split.alignment.mapping.units.filter(unit => unit[side].page === location.page
              && unit[side].rects.some(box => pdf[0] >= box[0] && pdf[0] <= box[2]
                && pdf[1] >= box[1] && pdf[1] <= box[3]));
            if (hits.length !== 1 || hits[0].id !== unitID) continue;
          }
          return { x, y, pdf, text: span.textContent };
        }
      }
    }
    return null;
  }

  /** Inspect real CSS ranges against independently projected PDF geometry on both sides. */
  function paint(unit) {
    return sides.map((side, index) => {
      const view = split.apps[index].pdfViewer.getPageView(unit[side].page), frame = split.frames[index];
      const overlay = split.alignment.hoverHighlights[index], bounds = view.div.getBoundingClientRect();
      const expected = unit[side].rects.map(rect => {
        const box = Array.from(view.viewport.convertToViewportRectangle(Components.utils.cloneInto(rect, frame)));
        return [Math.min(box[0], box[2]) * view.div.clientWidth / view.viewport.width,
          Math.min(box[1], box[3]) * view.div.clientHeight / view.viewport.height,
          Math.abs(box[2] - box[0]) * view.div.clientWidth / view.viewport.width,
          Math.abs(box[3] - box[1]) * view.div.clientHeight / view.viewport.height];
      });
      const actual = overlay?.ranges.flatMap(range => [...range.getClientRects()].map(rect => [
        (rect.left - bounds.left) * view.div.offsetWidth / bounds.width - view.div.clientLeft,
        (rect.top - bounds.top) * view.div.offsetHeight / bounds.height - view.div.clientTop,
        rect.width * view.div.offsetWidth / bounds.width, rect.height * view.div.offsetHeight / bounds.height])) || [];
      const geometry = actual.length > 0 && actual.every(rect => expected.some(box =>
        rect[0] >= box[0] - rangeTolerance && rect[1] >= box[1] - rangeTolerance
        && rect[0] + rect[2] <= box[0] + box[2] + rangeTolerance
        && rect[1] + rect[3] <= box[1] + box[3] + rangeTolerance));
      return { side, page: unit[side].page, rangeCount: actual.length, expected, actual,
        pass: geometry && overlay?.unitID === unit.id && overlay.page === unit[side].page
          && overlay.highlight.priority === -1 && frame.CSS.highlights.get(highlightName) === overlay.highlight
          && !view.div.querySelector(".paperbridge-paragraph-highlight") };
    });
  }

  /** Read native canvas pixels without adding, modifying or replacing any painter. */
  function canvases(unit) {
    return sides.map((side, index) => [...split.apps[index].pdfViewer.getPageView(unit[side].page)
      .div.querySelectorAll(".canvasWrapper canvas")].map(canvas => ({ canvas, width: canvas.width,
        height: canvas.height, style: canvas.getAttribute("style"), pixels: canvas.toDataURL("image/png") })));
  }

  /** Hover an actual native glyph and require bilateral paint with unchanged canvas and records. */
  async function hover(index, unit, rectangle, source, target, label) {
    let point = pointFor(index, unit[sides[index]], rectangle, unit.id);
    if (!point) {
      // Explicit native navigation exposes text hidden by the toolbar; hover itself still cannot navigate.
      const topMarginPoints = 80;
      split.apps[index].pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: unit[sides[index]].page + 1,
        destArray: [null, { name: "XYZ" }, rectangle[0], rectangle[3] + topMarginPoints, null] }, split.frames[index]));
      await page(index, unit[sides[index]].page);
      await settle();
      point = pointFor(index, unit[sides[index]], rectangle, unit.id);
    }
    check(point, "A native glyph is present in " + label, { unit: unit.id, rectangle });
    const before = positions(), pixels = canvases(unit), records = JSON.stringify(annotations(source, target));
    const events = [], doc = split.frames[index].document;
    /** Observe native trust/prevention without cancelling or changing propagation. */
    function observe(event) { events.push({ trusted: event.isTrusted, buttons: event.buttons, prevented: event.defaultPrevented,
      targetClass: event.target?.getAttribute?.("class"), page: event.target?.closest?.(".page")?.getAttribute("data-page-number") }); }
    doc.addEventListener("pointermove", observe, { capture: true, passive: true });
    try { mouse(split.frames[index], "mousemove", point.x, point.y); }
    finally { doc.removeEventListener("pointermove", observe, true); }
    await until(() => {
      report.hoverProbe = { label, input: { x: point.x, y: point.y, pdf: point.pdf, text: point.text },
        events, activeUnit: split.alignment.hoverUnit?.id, pointer: split.alignment.hoverPointer, paint: paint(unit),
        outerFrame: { available: !!split.frames[index].frameElement,
          sameControlDocument: !!split.frames[index].frameElement?.ownerDocument?.isSameNode(split.alignment.control.ownerDocument) } };
      return split.alignment.hoverUnit?.id === unit.id && report.hoverProbe.paint.every(item => item.pass);
    },
      "Bilateral native paint: " + label);
    check(events.some(event => event.trusted && event.buttons === 0) && events.every(event => !event.prevented)
      && JSON.stringify(before) === JSON.stringify(positions()), "Trusted hover does not navigate: " + label, { events });
    const after = canvases(unit);
    check(pixels.every((list, pane) => list.length === after[pane].length && list.every((item, number) =>
      item.canvas === after[pane][number].canvas && item.width === after[pane][number].width
      && item.height === after[pane][number].height && item.style === after[pane][number].style
      && item.pixels === after[pane][number].pixels)) && records === JSON.stringify(annotations(source, target)),
    "Hover preserves PDF pixels and annotation records: " + label);
    return { side: sides[index], unit: unit.id, input: { pdf: point.pdf, text: point.text }, paint: paint(unit) };
  }

  /** Save the real Gecko window composition for visual QA, including native annotation layers. */
  async function screenshot(id) {
    const main = Zotero.getMainWindow();
    const global = main.browsingContext?.currentWindowGlobal || main.windowGlobalChild?.parentActor;
    if (typeof global?.drawSnapshot !== "function") throw new Error("Native window snapshot API unavailable");
    const bitmap = await global.drawSnapshot(null, main.devicePixelRatio || 1, "rgb(255,255,255)");
    try {
      const canvas = main.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const path = config.reportPath.replace(/\.json$/, "-" + id + ".png");
      await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
      return { path, method: "WindowGlobalParent.drawSnapshot", width: bitmap.width, height: bitmap.height };
    } finally { bitmap.close(); }
  }

  /** Close this suite's split and wait for its real annotation writes before the next case. */
  async function close() {
    if (!split) return;
    const current = split;
    bridge.closeSplit(current.reader.tabID);
    await ready(current.annotationSave, "Native annotation save after split closure");
    await ready(Promise.all(bridge.annotationWrites.values()), "All suite annotation writes settle");
    current.reader.close();
    await until(() => !Zotero.Reader._readers.includes(current.reader), "Suite source reader closes");
    split = null;
  }

  try {
    check(config.isolated === true && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path,
      config.expectedProfileDirectory) && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory),
    "The actual native process uses the explicit disposable profile/data pair");
    isolated = true;
    for (const topic of ["quit-application-requested", "quit-application-granted", "quit-application"])
      Services.obs.addObserver(lifecycle, topic);
    bridge = Zotero.PaperBridge;
    check(bridge, "The packaged production add-on started");
    await ready(bridge.ready, "Production backend startup finishes");
    await ready(Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad("item"), "Native items load");
    originalRequest = bridge.request;
    /** Keep the real backend while forbidding any paid-job entry point in this acceptance. */
    guardedRequest = async function request(path, method, data) {
      if ((method || "GET").toUpperCase() === "POST" && /^\/(jobs|translate)(?:[/?]|$)/.test(path)) {
        report.jobsPostAttempts++;
        throw new Error("Reading acceptance forbids translation submission");
      }
      if (path.split("?")[0] === "/alignment/validate") report.validationCalls++;
      return originalRequest.call(this, path, method, data);
    };
    bridge.request = guardedRequest;
    const installed = PathUtils.join(config.expectedProfileDirectory, "extensions", "paperbridge@local.dev.xpi");
    check(await sha256(installed) === (config.expectedXpiSha256 || config.baselineXpiSha256),
      "Installed XPI matches the exact accepted package");
    const manifest = JSON.parse(await IOUtils.readUTF8(config.caseManifest));
    check(manifest.cases?.length > 0, "Explicit representative/geometry cases are present");
    for (const entry of manifest.cases) {
      for (const key of ["source_pdf", "translated_pdf", "alignment_path"]) entry[key] = nativePath(entry[key]);
    }
    let saved;
    if (config.phase === "reopen") {
      saved = JSON.parse(await IOUtils.readUTF8(config.statePath));
      check(saved.processID !== report.processID, "This is a cold process restart, not a reader reopen",
        { before: saved.processID, after: report.processID });
      check(JSON.stringify(saved.preferences) === JSON.stringify(preferences()), "Nonsecret settings persist across cold restart");
    } else {
      bridge.setPref("pages", "1-2");
      saved = { processID: report.processID, preferences: preferences(), cases: [] };
    }
    for (const entry of manifest.cases) {
      report.stage = entry.id;
      await write();
      let source, target, record, prior;
      if (config.phase === "create") {
        report.waiting = "Import native attachments: " + entry.id;
        await write();
        const parent = new Zotero.Item("journalArticle");
        parent.setField("title", "Isolated PaperBridge mapping acceptance: " + entry.id);
        await parent.saveTx();
        source = await Zotero.Attachments.importFromFile({ file: entry.source_pdf, parentItemID: parent.id });
        target = await Zotero.Attachments.importFromFile({ file: entry.translated_pdf, parentItemID: parent.id });
        report.waiting = "Record imported translation: " + entry.id;
        await write();
        record = await bridge.library.put(source, null, bridge.configuration(),
          { state: "done", output_path: await target.getFilePathAsync(), quality: { status: "unknown" } },
          await IOUtils.stat(await source.getFilePathAsync()));
        await bridge.library.attach(record, target);
        await bridge.library.update(record, { alignment_path: entry.alignment_path });
        await bridge.library.settled();
      } else {
        prior = saved.cases.find(item => item.id === entry.id);
        check(prior, "A persisted case exists: " + entry.id);
        source = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, prior.sourceKey);
        target = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, prior.targetKey);
        record = bridge.library.records.find(item => item.attachmentKey === prior.targetKey && item.sourceKey === prior.sourceKey);
        check(source?.isAttachment() && target?.isAttachment() && record?.alignmentPath === entry.alignment_path,
          "Attachment ownership and mapping path persist: " + entry.id);
        check(JSON.stringify(prior.annotations) === JSON.stringify(annotations(source, target)),
          "Native annotation records persist unchanged: " + entry.id);
      }
      const sourcePath = await source.getFilePathAsync(), outputPath = await target.getFilePathAsync();
      const validated = await bridge.request("/alignment/validate", "POST",
        { mapping_path: entry.alignment_path, source_path: sourcePath, output_path: outputPath });
      check(validated.available && validated.mapping?.units?.length > 0,
        "Production endpoint validates actual attachment bytes: " + entry.id, { reason: validated.reason });
      const mapping = validated.mapping;
      const hashes = { source: await sha256(sourcePath), target: await sha256(outputPath),
        alignment: await sha256(entry.alignment_path) };
      if (prior) check(JSON.stringify(hashes) === JSON.stringify(prior.hashes), "PDF/sidecar bytes survive cold restart: " + entry.id);
      else {
        for (const [index, item] of [source, target].entries()) {
          await Zotero.Annotations.saveFromJSON(item, { key: Zotero.DataObjectUtilities.generateKey(), type: "highlight",
            color: "#ffd400", text: "", comment: "Isolated native overlay compatibility seed", pageLabel: String(mapping.units[0][sides[index]].page + 1),
            sortIndex: "00000|000000|00000", position: { pageIndex: mapping.units[0][sides[index]].page,
              rects: [mapping.units[0][sides[index]].rects[0]] } });
        }
      }
      const beforeAnnotations = JSON.stringify(annotations(source, target));
      await ready(bridge.split(source, target), "Open actual integrated split: " + entry.id);
      const reader = Zotero.Reader._readers.find(item => item.itemID === source.id);
      opened.add(reader);
      split = bridge.splits.get(reader.tabID);
      await until(() => split.alignment?.mapping && !split.alignment.hoverButton.disabled, "Integrated mapping is ready");
      split.frames.forEach(frame => frame.addEventListener("error", event => {
        report.rendererErrors.push({ message: event.message || String(event.error) });
      }, { passive: true }));
      for (const [index, side] of sides.entries()) {
        split.apps[index].pdfViewer.currentScaleValue = "page-width";
        // A cold reopen can restore page two; do not wait for an offscreen first page to render.
        split.apps[index].pdfViewer.currentPageNumber = mapping.units[0][side].page + 1;
        await page(index, mapping.units[0][side].page);
      }
      await settle();
      check(!split.alignment.hoverEnabled, "Independent switch starts off after process/split creation: " + entry.id);
      if (split.sync) {
        const sync = split.browser.contentWindow.document.querySelector(".paperbridge-split-controls > button");
        await click(sync);
        check(!split.sync, "Reading probes use actual independent panes: " + entry.id);
      }
      await click(split.alignment.hoverButton);
      check(split.alignment.hoverEnabled, "The real switch enables paragraph hover: " + entry.id);
      const evidence = { id: entry.id, kind: entry.kind || "real-paper", units: [], pages: [], screenshots: [] };
      let previousPage = -1;
      for (const unit of mapping.units) {
        if (unit.source.page !== previousPage) {
          // Each actual page change finishes before the next one; no synchronous render burst.
          split.apps[0].pdfViewer.currentPageNumber = unit.source.page + 1;
          await page(0, unit.source.page);
          split.apps[1].pdfViewer.currentPageNumber = unit.target.page + 1;
          await page(1, unit.target.page);
          await settle();
          previousPage = unit.source.page;
          evidence.pages.push(unit.source.page + 1);
        }
        // Prepare a real, unobscured reading position before testing non-navigating hover.
        // Page-width matches ordinary split reading; lower paragraphs otherwise lie below controls.
        const readingMarginPoints = 80;
        for (const [index, side] of sides.entries()) {
          const location = unit[side];
          const left = Math.min(...location.rects.map(rect => rect[0]));
          const top = Math.max(...location.rects.map(rect => rect[3]));
          split.apps[index].pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: location.page + 1,
            destArray: [null, { name: "XYZ" }, left, top + readingMarginPoints, null] }, split.frames[index]));
          await page(index, location.page);
          await settle();
        }
        const probes = [];
        for (const [index, side] of sides.entries()) {
          for (const [number, rectangle] of unit[side].rects.entries()) {
            probes.push(await hover(index, unit, rectangle, source, target, entry.id + "/" + unit.id + "/" + side + "/" + number));
          }
        }
        evidence.units.push({ id: unit.id, sourcePage: unit.source.page, targetPage: unit.target.page, probes });
        const captured = entry.units?.find(item => item.id === unit.id)?.captured_source_text || "";
        const proseCapture = captured.length > 100 && !evidence.proseScreenshot;
        if (evidence.screenshots.length < 2 || proseCapture) {
          const capture = await screenshot(entry.id + "-" + evidence.screenshots.length);
          evidence.screenshots.push(capture);
          if (proseCapture) evidence.proseScreenshot = capture.path;
        }
      }
      if (entry.ignored_points?.length) {
        for (const ignored of entry.ignored_points) {
          const index = ignored.side === "target" ? 1 : 0;
          split.apps[index].pdfViewer.currentPageNumber = ignored.page + 1;
          await page(index, ignored.page);
          // Exclusion must be exercised over a visible native glyph, not outside the viewport.
          const excludedMarginPoints = 80;
          const focus = ignored.point || [ignored.rect[0], ignored.rect[3]];
          split.apps[index].pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: ignored.page + 1,
            destArray: [null, { name: "XYZ" }, focus[0], focus[1] + excludedMarginPoints, null] }, split.frames[index]));
          const view = await page(index, ignored.page);
          await settle();
          let point;
          if (ignored.point) {
            const bounds = view.div.getBoundingClientRect();
            const local = view.viewport.convertToViewportPoint(ignored.point[0], ignored.point[1]);
            point = { x: Math.round(bounds.left + (local[0] * view.div.clientWidth / view.viewport.width + view.div.clientLeft)
              * bounds.width / view.div.offsetWidth),
            y: Math.round(bounds.top + (local[1] * view.div.clientHeight / view.viewport.height + view.div.clientTop)
              * bounds.height / view.div.offsetHeight) };
          } else point = pointFor(index, { page: ignored.page }, ignored.rect);
          const frame = split.frames[index], doc = frame.document;
          const hit = point && doc.elementFromPoint(point.x, point.y);
          const glyph = point && [...view.div.querySelectorAll(".textLayer span")].find(span => {
            if (span.childElementCount || !span.textContent.trim()) return false;
            const range = doc.createRange();
            range.selectNodeContents(span);
            return [...range.getClientRects()].some(rect => point.x >= rect.left && point.x <= rect.right
              && point.y >= rect.top && point.y <= rect.bottom);
          });
          check(point && point.x >= 0 && point.y >= 0 && point.x < frame.innerWidth && point.y < frame.innerHeight
            && hit?.closest(".page")?.isSameNode(view.div) && glyph && !coveredByControls(index, point.x, point.y),
          "Excluded-region native glyph is visible: " + ignored.reason, { side: ignored.side, page: ignored.page,
            point, text: glyph?.textContent });
          const before = positions(), events = [];
          /** Observe passive native input without injecting or cancelling pointer events. */
          function observeIgnored(event) { events.push({ trusted: event.isTrusted, prevented: event.defaultPrevented }); }
          doc.addEventListener("pointermove", observeIgnored, { capture: true, passive: true });
          mouse(split.frames[index], "mousemove", point.x, point.y);
          doc.removeEventListener("pointermove", observeIgnored, true);
          await until(() => !split.alignment.hoverUnit && split.alignment.hoverHighlights.every(item => !item),
            "Untraceable region is ignored: " + ignored.reason);
          check(events.some(event => event.trusted) && events.every(event => !event.prevented)
            && JSON.stringify(before) === JSON.stringify(positions()) && view.renderingState === 3,
          "Ignoring untraceable region leaves native input, position and rendering intact");
        }
      }
      check(beforeAnnotations === JSON.stringify(annotations(source, target)), "Hover preserves all native annotation records: " + entry.id);
      report.cases.push(evidence);
      await close();
      if (!prior) saved.cases.push({ id: entry.id, sourceKey: source.key, targetKey: target.key,
        hashes, annotations: annotations(source, target) });
    }
    await bridge.library.settled();
    if (config.phase === "create") await IOUtils.writeUTF8(config.statePath, JSON.stringify(saved, null, 2));
    check(report.jobsPostAttempts === 0 && report.rendererErrors.length === 0,
      "No translation submissions or observed renderer exceptions", { jobsPostAttempts: report.jobsPostAttempts, errors: report.rendererErrors });
    report.stage = "complete";
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || "" });
    Zotero.logError(error);
    // Teardown itself may fail; persist the original cause before attempting any reader cleanup.
    try { await write(); } catch (writeError) { Zotero.logError(writeError); }
  } finally {
    try {
      if (isolated) {
        await close();
        await ready(Promise.all(bridge?.annotationWrites.values() || []), "Pending annotation writes finish before quit");
        for (const reader of opened) if (reader && Zotero.Reader._readers.includes(reader)) reader.close();
        await bridge?.library.settled();
      }
    } catch (error) {
      report.ok = false;
      report.errors.push({ message: "Cleanup: " + String(error) });
    }
    if (bridge?.request === guardedRequest) bridge.request = originalRequest;
    report.quitRequestedByHarness = isolated;
    try { await write(); }
    finally { if (isolated) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); }
  }
})();
