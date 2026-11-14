/** Accept paragraph hover and native annotations using a traced fixture in an isolated Zotero. */
/* global Zotero, Services, IOUtils, PathUtils, Ci, Components, PAPERBRIDGE_TEST_ROOT, PAPERBRIDGE_HOVER_TEST */
(async () => {
  // Only the caller's disposable profile/data pair may receive fixture items or quit requests.
  const config = typeof PAPERBRIDGE_HOVER_TEST === "undefined" ? {} : PAPERBRIDGE_HOVER_TEST;
  // Native rendering and annotation persistence can take longer on Windows.
  const waitMS = 60000;
  // Native text-selection moves are throttled; this also avoids tight readiness polling.
  const pollMS = 100;
  // PDF.js RenderingStates.FINISHED is 3.
  const renderingFinished = 3;
  // Allow subpixel viewport/CSS rounding, not approximate paragraph bounding boxes.
  const rectangleTolerance = 1;
  // Native selection line boxes can extend beyond actual PDF glyph bounds by a CSS pixel.
  const textRangeTolerance = 2;
  // Hover is a pale background, not an opaque replacement for native PDF rendering.
  const maximumHoverAlpha = 0.4;
  // Native drag endpoints must remain outside Zotero's auto-scroll edge zone.
  const edgeMargin = 24;
  // Gecko MouseEvent.MOZ_SOURCE_MOUSE identifies actual mouse input rather than touch.
  const mouseInputSource = 1;
  // The sendMouseEvent aButtons bitmask is held only for down/drag, never hover or release.
  const primaryMouseButtons = 1;
  // Supplementary contract probes never replace the backend-validated native fixture.
  const sides = ["source", "target"];
  // These tabs are created only after the isolation check succeeds.
  const nativeReaders = new Set();
  const report = { ok: false, stage: "isolation", checks: [], errors: [], inputs: [],
    environment: { zoteroVersion: Zotero.version, platform: Services.appinfo.OS,
      processID: Services.appinfo.processID },
    scope: { fixture: "pinned-pipeline trace; two translation-request units on one synthetic page",
      modelCallsThisRun: 0, fullPaperQualityAcceptance: false, sentenceOrWordMapping: false,
      unverifiedRegionFixture: false, processRestartAcceptance: false },
    annotatedInputEvidence: [], jobsPostAttempts: 0, validationCalls: 0, rendererErrors: [], focusEvents: [] };
  let isolated = false, bridge, originalRequest, guardedRequest, state, source, translated, record;
  let mapping, initialSidecar, seededSnapshot;

  /** Preserve the last stage and all assertion evidence, including failures. */
  async function writeReport() {
    if (config.reportPath) await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Optionally encode Gecko's real main-window snapshot; failure never counts as a UI pass. */
  async function captureNativeWindow(testWindow, label = "") {
    // Bound this optional capture independently of native test readiness waits.
    const timeoutMS = 5000;
    const evidence = { captured: false, method: "WindowGlobalParent.drawSnapshot",
      path: config.reportPath.replace(/(?:-result)?\.json$/i, "") + "-native-window" + (label ? "-" + label : "") + ".png", timeoutMS,
      region: "Gecko main-window viewport with reader iframe subtree; excludes OS decorations/cursor",
      visualQA: "pending" };
    (report.nativeScreenshots ||= []).push(evidence);
    if (!label) report.nativeScreenshot = evidence;
    if (config.nativeScreenshot === false) { evidence.skipped = true; return; }
    let expired = false;
    try {
      if (!isolated || testWindow !== Zotero.getMainWindow()) throw new Error("Not the isolated test main window");
      const global = testWindow.browsingContext?.currentWindowGlobal || testWindow.windowGlobalChild?.parentActor;
      if (typeof global?.drawSnapshot !== "function") throw new Error("Public Gecko drawSnapshot API unavailable");
      // Null rect captures the visible view, including fixed DOM layers and local/remote iframes.
      // Contract: mozilla-firefox/firefox dom/chrome-webidl/WindowGlobalActors.webidl.
      const scale = testWindow.devicePixelRatio || 1;
      evidence.scale = scale;
      evidence.cssViewport = { width: testWindow.innerWidth, height: testWindow.innerHeight };
      await writeReport();
      /** Encode only the returned bitmap, never a reconstructed PDF or reader composition. */
      async function snapshot() {
        const bitmap = await global.drawSnapshot(null, scale, "rgb(255,255,255)");
        try {
          if (expired) return;
          if (!(bitmap.width > 0 && bitmap.height > 0)) throw new Error("Gecko returned an empty snapshot");
          const canvas = testWindow.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("Native snapshot PNG encoding failed");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (expired) return;
          await IOUtils.write(evidence.path, bytes);
          return { width: bitmap.width, height: bitmap.height, bytes: bytes.length };
        } finally { bitmap.close(); }
      }
      const dimensions = await Promise.race([snapshot(), Zotero.Promise.delay(timeoutMS).then(() => {
        expired = true;
        throw new Error("Optional native snapshot timed out after " + timeoutMS + " ms");
      })]);
      if (!dimensions) throw new Error("Native snapshot did not finish before its deadline");
      Object.assign(evidence, dimensions, { captured: true });
    } catch (error) {
      evidence.error = String(error);
    } finally { expired = true; }
  }

  /** Record an assertion before throwing so native failures remain diagnosable. */
  function check(condition, name, details = {}) {
    report.checks.push({ name, pass: !!condition, details });
    if (!condition) throw new Error(name + ": " + JSON.stringify(details));
  }

  /** Poll actual native state, preserving the current wait in the report. */
  async function until(predicate, message) {
    report.waiting = message;
    await writeReport();
    const deadline = Date.now() + waitMS;
    do {
      const value = await predicate();
      if (value) { delete report.waiting; return value; }
      await Zotero.Promise.delay(pollMS);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Bound real initialization/save promises without replacing their implementations. */
  async function ready(promise, message) {
    let done = false, failure;
    Promise.resolve(promise).then(() => { done = true; }, error => { failure = error; done = true; });
    await until(() => { if (failure) throw failure; return done; }, message);
  }

  /** Compare native paths with Windows case normalization. */
  function samePath(left, right) {
    if (!left || !right) return false;
    const a = PathUtils.normalize(left), b = PathUtils.normalize(right);
    return Zotero.isWin ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** Snapshot physical viewer positions independently of the alignment controller. */
  function positions(split) {
    return split.apps.map(app => ({ page: app.pdfViewer.currentPageNumber,
      scale: app.pdfViewer.currentScale, rotation: app.pdfViewer.pagesRotation,
      top: app.pdfViewer.container.scrollTop, left: app.pdfViewer.container.scrollLeft }));
  }

  /** Wait for native layout/scroll processing to stop before comparing hover effects. */
  async function settle(split) {
    let previous, repeats = 0;
    await until(() => {
      const value = JSON.stringify(positions(split));
      repeats = value === previous ? repeats + 1 : 0;
      previous = value;
      return repeats >= 3;
    }, "Both PDF viewers settle");
  }

  /** Await this page's real rendered viewport and text layer, including rotation changes. */
  async function rendered(split, index, pageIndex = 0) {
    return until(() => {
      const viewer = split.apps[index].pdfViewer, page = viewer.getPageView(pageIndex);
      return page?.renderingState === renderingFinished && page.div?.isConnected
        && page.scale === viewer.currentScale
        && page.viewport?.rotation === viewer.pagesRotation
        && page.div.querySelector(".textLayer span") && page;
    }, "Rendered native " + sides[index] + " page " + pageIndex);
  }

  /** Independently project each PDF rectangle through its own native page viewport. */
  function projected(split, index, side) {
    const page = split.apps[index].pdfViewer.getPageView(side.page);
    return side.rects.map(rect => {
      const box = Array.from(page.viewport.convertToViewportRectangle(
        Components.utils.cloneInto(rect, split.frames[index])));
      const sx = page.div.clientWidth / page.viewport.width;
      const sy = page.div.clientHeight / page.viewport.height;
      return [Math.min(box[0], box[2]) * sx, Math.min(box[1], box[3]) * sy,
        Math.abs(box[2] - box[0]) * sx, Math.abs(box[3] - box[1]) * sy];
    });
  }

  /** Convert a PDF point to border-aware iframe client coordinates. */
  function screenPoint(split, index, pageIndex, point) {
    const page = split.apps[index].pdfViewer.getPageView(pageIndex);
    const box = page.div.getBoundingClientRect();
    const converted = page.viewport.convertToViewportPoint(point[0], point[1]);
    return { x: box.left + (converted[0] * page.div.clientWidth / page.viewport.width + page.div.clientLeft)
        * box.width / page.div.offsetWidth,
      y: box.top + (converted[1] * page.div.clientHeight / page.viewport.height + page.div.clientTop)
        * box.height / page.div.offsetHeight };
  }

  /** Use Gecko's trusted mouse API in the specified actual document. */
  function mouse(frame, type, x, y, buttons = type === "mousedown" ? primaryMouseButtons : 0) {
    const nativeFrame = Components.utils.unwaiveXrays(frame);
    const utilities = nativeFrame.windowUtils || nativeFrame.docShell?.domWindowUtils;
    if (!utilities?.sendMouseEvent) throw new Error("Trusted native mouse API unavailable");
    // Gecko otherwise derives buttons=1 from button=0 even for an unpressed mousemove.
    utilities.sendMouseEvent(type, x, y, 0, type === "mousemove" ? 0 : 1, 0,
      false, 0, mouseInputSource, true, false, buttons);
  }

  /** Focus the isolated native window and click the real UI control. */
  async function click(button) {
    const main = Zotero.getMainWindow();
    main.focus();
    Services.focus.activeWindow = main;
    const frame = button.ownerDocument.defaultView;
    Components.utils.unwaiveXrays(frame).focus();
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
    const box = button.getBoundingClientRect();
    check(box.width > 0 && box.height > 0, "Native control is visible", { text: button.textContent });
    mouse(frame, "mousemove", box.left + box.width / 2, box.top + box.height / 2);
    mouse(frame, "mousedown", box.left + box.width / 2, box.top + box.height / 2);
    mouse(frame, "mouseup", box.left + box.width / 2, box.top + box.height / 2);
    await Zotero.Promise.delay(pollMS);
  }

  /** Find only the outer sync button, never the new hover aria-pressed control. */
  function syncButton(split) {
    return [...split.alignment.control.parentElement.children].find(element =>
      element.localName === "button" && element.hasAttribute("aria-pressed"));
  }

  /** Change native sync through its existing button without writing split state. */
  async function setSync(split, enabled) {
    const button = syncButton(split);
    check(!!button, "Independent split sync control exists");
    if (split.sync !== enabled) await click(button);
    check(split.sync === enabled && button.getAttribute("aria-pressed") === String(enabled),
      "Native sync toggle updates actual state", { enabled, hoverEnabled: split.alignment.hoverEnabled });
    await settle(split);
  }

  /** Observe navigation and forward every call to the real viewer. */
  function navigationObserver(split, index) {
    const viewer = split.apps[index].pdfViewer, original = viewer.scrollPageIntoView, calls = [];
    /** Record destinations without inhibiting actual native navigation. */
    function observed(destination) {
      calls.push(JSON.parse(JSON.stringify(destination)));
      return original.call(this, destination);
    }
    viewer.scrollPageIntoView = observed;
    split.cleanups.push(() => { if (viewer.scrollPageIntoView === observed) viewer.scrollPageIntoView = original; });
    return calls;
  }

  /** Open the parent integration, not a standalone replacement controller. */
  async function open(expectMapping = true) {
    const before = report.validationCalls;
    await ready(bridge.split(source, translated), "Native split initialization finishes");
    const reader = Zotero.Reader._readers.find(item => item.itemID === source.id);
    if (reader) nativeReaders.add(reader);
    state = reader && bridge.splits.get(reader.tabID);
    check(!!state?.alignment?.control && !!state.apps?.[1] && !!state.annotations,
      "Parent exposes real hover controller and translated native annotation adapter");
    if (expectMapping) {
      await until(() => state.alignment.mapping && !state.alignment.hoverButton.disabled,
        "Integrated hover mapping is available");
      check(report.validationCalls > before, "Split loader uses real /alignment/validate");
    } else {
      await until(() => state.alignment.hoverButton.disabled && !state.alignment.mapping
        && !state.alignment.status.textContent.includes("正在"), "Missing-map split resolves nonfatally");
    }
    state.frames.forEach((frame, index) => {
      /** Observe renderer exceptions without cancelling native handling. */
      function observeError(event) {
        report.rendererErrors.push({ message: event.message || String(event.error), stack: event.error?.stack || "" });
      }
      frame.addEventListener("error", observeError);
      state.cleanups.push(() => frame.removeEventListener("error", observeError));
      /** Record real native focus loss, which intentionally clears cosmetic hover. */
      function observeBlur() { report.focusEvents.push({ side: sides[index], stage: report.stage }); }
      frame.addEventListener("blur", observeBlur);
      state.cleanups.push(() => frame.removeEventListener("blur", observeBlur));
    });
    state.apps.forEach(app => { app.pdfViewer.currentScaleValue = "page-fit"; });
    await rendered(state, 0);
    await rendered(state, 1);
    await settle(state);
    return state;
  }

  /** Snapshot persisted native records, including dates, ownership, text and positions. */
  function annotationSnapshot() {
    return [source, translated].map(attachment => attachment.getAnnotations().map(item => ({
      key: item.key, parentID: item.parentID, type: item.annotationType, text: item.annotationText,
      comment: item.annotationComment, color: item.annotationColor, position: item.annotationPosition,
      pageLabel: item.annotationPageLabel, sortIndex: item.annotationSortIndex,
      dateModified: item.dateModified, tags: item.getTags(),
    })).sort((a, b) => a.key.localeCompare(b.key)));
  }

  /** Seed a persisted native highlight before opening either side of the split. */
  async function seed(attachment, side, label) {
    const key = Zotero.DataObjectUtilities.generateKey();
    await Zotero.Annotations.saveFromJSON(attachment, { key, type: "highlight", color: "#ffd400",
      text: "", comment: "Isolated " + label + " hover compatibility seed", pageLabel: String(side.page + 1),
      sortIndex: "00000|000000|00000", position: { pageIndex: side.page, rects: [side.rects[0]] } });
    const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
    check(item?.isAnnotation() && item.parentID === attachment.id && item.annotationType === "highlight",
      "Real native " + label + " highlight saved before split", { key, attachmentID: attachment.id });
    const evidence = { side: label, key, attachmentKey: attachment.key,
      method: "Zotero.Annotations.saveFromJSON before split (seed, not a selection gesture)",
      position: JSON.parse(item.annotationPosition), selectedTextClaim: false };
    report.annotatedInputEvidence.push(evidence);
    return evidence;
  }

  /** Decode computed paint alpha without assuming native highlight color values. */
  function colorAlpha(color) {
    if (!color || color === "transparent" || color === "none") return 0;
    const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
    return rgba ? Number(rgba[1]) : color.startsWith("rgb(") || color.startsWith("#") ? 1 : 0;
  }

  /** Check actual native CSS highlight ranges against their own request/page geometry. */
  function overlayEvidence(split, unit) {
    return sides.map((side, index) => {
      const page = split.apps[index].pdfViewer.getPageView(unit[side].page);
      const overlay = split.alignment.hoverHighlights[index], frame = split.frames[index];
      const expected = projected(split, index, unit[side]);
      const bounds = page.div.getBoundingClientRect();
      const actual = overlay ? overlay.ranges.flatMap(range => [...range.getClientRects()].map(rect => [
        (rect.left - bounds.left) * page.div.offsetWidth / bounds.width - page.div.clientLeft,
        (rect.top - bounds.top) * page.div.offsetHeight / bounds.height - page.div.clientTop,
        rect.width * page.div.offsetWidth / bounds.width, rect.height * page.div.offsetHeight / bounds.height
      ])) : [];
      const geometryMatches = actual.length > 0 && actual.every(rect => rect.every(Number.isFinite)
        && rect[2] > 0 && rect[3] > 0 && expected.some(box => rect[0] >= box[0] - textRangeTolerance
          && rect[1] >= box[1] - textRangeTolerance && rect[0] + rect[2] <= box[0] + box[2] + textRangeTolerance
          && rect[1] + rect[3] <= box[1] + box[3] + textRangeTolerance));
      const layer = page.div.querySelector(".textLayer");
      const style = layer && frame.getComputedStyle(layer);
      const highlightStyle = overlay?.ranges[0] && frame.getComputedStyle(overlay.ranges[0].startContainer,
        "::highlight(paperbridge-paragraph-hover)");
      const alpha = colorAlpha(highlightStyle?.backgroundColor) * Number(style?.opacity);
      const paintMatches = alpha > 0 && alpha <= maximumHoverAlpha;
      return { side, page: unit[side].page, expected, actual, scale: page.viewport.scale,
        rotation: page.viewport.rotation, method: "native CSS Highlight ranges", alpha,
        backgroundColor: highlightStyle?.backgroundColor, textLayerOpacity: style?.opacity,
        priority: overlay?.highlight.priority, rangeCount: overlay?.ranges.length,
        unmatchedTextItems: overlay ? [] : [...(layer?.querySelectorAll("span") || [])].map(span => {
          const range = page.div.ownerDocument.createRange();
          range.selectNodeContents(span);
          return { text: span.textContent, rectangles: [...range.getClientRects()].map(rect => [
            (rect.left - bounds.left) * page.div.offsetWidth / bounds.width - page.div.clientLeft,
            (rect.top - bounds.top) * page.div.offsetHeight / bounds.height - page.div.clientTop,
            rect.width * page.div.offsetWidth / bounds.width, rect.height * page.div.offsetHeight / bounds.height
          ]) };
        }),
        pass: !!overlay?.isConnected && overlay.unitID === unit.id && overlay.page === unit[side].page
          && frame.CSS.highlights.get("paperbridge-paragraph-hover") === overlay.highlight
          && overlay.highlight.size === overlay.ranges.length && overlay.highlight.priority === -1
          && !page.div.querySelector(".paperbridge-paragraph-highlight")
          && geometryMatches && paintMatches };
    });
  }

  /** Read actual PDF canvas pixels and identity without modifying its native renderer. */
  function canvasSnapshot(split) {
    return split.apps.map(app => [...app.pdfViewer.getPageView(0).div.querySelectorAll(".canvasWrapper canvas")]
      .map(node => ({ node, width: node.width, height: node.height, style: node.getAttribute("style"),
        pixels: node.toDataURL("image/png") })));
  }

  /** Require both DOM and controller state to contain no stale hover rectangles. */
  function hoverCleared(split) {
    return !split.alignment.hoverUnit && split.alignment.hoverHighlights.every(overlay => !overlay)
      && split.frames.every(frame => !frame.CSS.highlights.has("paperbridge-paragraph-hover"));
  }

  /** Record real pointer delivery through bubbling, never synthesizing controller callbacks. */
  async function move(split, index, point, label) {
    const frame = split.frames[index], events = [];
    const evidence = { action: label, side: sides[index], point, events: [] };
    report.inputs.push(evidence);
    /** Keep native events to observe final cancellation status after dispatch. */
    function observe(event) { events.push(event); }
    const types = ["pointermove", "mousemove"];
    types.forEach(type => frame.document.addEventListener(type, observe, { capture: true, passive: true }));
    try {
      check(point.x > 0 && point.y > 0 && point.x < frame.innerWidth && point.y < frame.innerHeight,
        "Native hover point is inside visible iframe", { label, point, width: frame.innerWidth, height: frame.innerHeight });
      mouse(frame, "mousemove", point.x, point.y);
      await Zotero.Promise.delay(pollMS);
    } finally {
      types.forEach(type => frame.document.removeEventListener(type, observe, true));
      evidence.events = events.map(event => ({ type: event.type, trusted: event.isTrusted,
        prevented: event.defaultPrevented, buttons: event.buttons, x: event.clientX, y: event.clientY,
        targetClass: event.target?.getAttribute?.("class"),
        page: event.target?.closest?.(".page[data-page-number]")?.getAttribute("data-page-number") }));
    }
    check(evidence.events.some(event => event.type === "pointermove" && event.trusted && event.buttons === 0)
      && evidence.events.every(event => !event.prevented), "Trusted passive hover input: " + label, evidence);
    return evidence;
  }

  /** Hover one verified request and prove exact bilateral overlays with no navigation or writes. */
  async function hover(split, index, unit, calls, label) {
    await settle(split);
    // Native scale redraws can destroy a retained text layer after the canvas reports FINISHED.
    await rendered(split, 0, unit.source.page);
    await rendered(split, 1, unit.target.page);
    const before = positions(split), counts = calls.map(list => list.length);
    const annotations = JSON.stringify(annotationSnapshot()), canvases = canvasSnapshot(split);
    const rect = unit[sides[index]].rects[0];
    const point = screenPoint(split, index, unit[sides[index]].page,
      [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]);
    await move(split, index, point, label);
    await until(() => {
      const evidence = overlayEvidence(split, unit);
      report.hoverProbe = { label, unit: unit.id, active: split.alignment.hoverUnit?.id, evidence,
        pointer: split.alignment.hoverPointer,
        nativePages: split.apps.map(app => {
          const page = app.pdfViewer.getPageView(0);
          return { scale: page.scale, viewerScale: app.pdfViewer.currentScale,
            renderingState: page.renderingState, children: [...page.div.children].map(child => child.className) };
        }) };
      return split.alignment.hoverUnit?.id === unit.id && evidence.every(item => item.pass);
    }, label + " paints both native request ranges");
    const evidence = overlayEvidence(split, unit), after = positions(split);
    const noMovement = before.every((item, pane) => item.page === after[pane].page
      && item.scale === after[pane].scale && item.rotation === after[pane].rotation
      && Math.abs(item.top - after[pane].top) <= rectangleTolerance
      && Math.abs(item.left - after[pane].left) <= rectangleTolerance);
    const canvasesAfter = canvasSnapshot(split);
    check(evidence.every(item => item.pass) && noMovement && calls.every((list, pane) => list.length === counts[pane])
      && JSON.stringify(annotationSnapshot()) === annotations
      && canvases.every((list, pane) => list.length > 0 && list.length === canvasesAfter[pane].length
        && list.every((item, number) => item.node === canvasesAfter[pane][number].node
          && item.width === canvasesAfter[pane][number].width && item.height === canvasesAfter[pane][number].height
          && item.style === canvasesAfter[pane][number].style && item.pixels === canvasesAfter[pane][number].pixels)),
    label + ": both native request ranges, no navigation/annotation/canvas changes", {
      unit: unit.id, before, after, overlays: evidence, pdfCanvasComparison: "identity, dimensions, style and native PNG pixel snapshot" });
  }

  /** Find a real painted seed in native annotationOverlay by identity or projected PDF position. */
  function nativeSeedEvidence(split, index, seedInput, unit) {
    const page = split.apps[index].pdfViewer.getPageView(seedInput.position.pageIndex);
    const layer = page.div.querySelector(".annotationOverlay");
    const overlay = split.alignment.hoverHighlights[index];
    if (!layer || !overlay?.isConnected) return null;
    const seedSide = { page: seedInput.position.pageIndex, rects: seedInput.position.rects };
    const expected = projected(split, index, seedSide)[0], bounds = page.div.getBoundingClientRect();
    const center = screenPoint(split, index, seedSide.page,
      [(seedSide.rects[0][0] + seedSide.rects[0][2]) / 2, (seedSide.rects[0][1] + seedSide.rects[0][3]) / 2]);
    const paints = [...layer.querySelectorAll("*")].filter(element => {
      const box = element.getBoundingClientRect(), style = element.ownerDocument.defaultView.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity) > 0 && colorAlpha(style.backgroundColor) > 0
        && center.x >= box.left && center.x <= box.right && center.y >= box.top && center.y <= box.bottom;
    });
    const mark = paints.find(element => element.getAttribute("data-annotation-id") === seedInput.key) || paints[0];
    if (!mark) return null;
    const markStyle = mark.ownerDocument.defaultView.getComputedStyle(mark);
    const box = mark.getBoundingClientRect();
    const actual = [(box.left - bounds.left) * page.div.offsetWidth / bounds.width - page.div.clientLeft,
      (box.top - bounds.top) * page.div.offsetHeight / bounds.height - page.div.clientTop,
      box.width * page.div.offsetWidth / bounds.width, box.height * page.div.offsetHeight / bounds.height];
    const nativeLayers = [...page.div.children].filter(child =>
      ["annotationOverlay", "textLayer", "customAnnotationLayer"].some(name => child.classList.contains(name)));
    const order = nativeLayers.map(child => ({ className: child.className,
      childIndex: [...page.div.children].indexOf(child),
      zIndex: child.ownerDocument.defaultView.getComputedStyle(child).zIndex,
      display: child.ownerDocument.defaultView.getComputedStyle(child).display }));
    const hit = page.div.ownerDocument.elementFromPoint(center.x, center.y);
    return { side: sides[index], key: seedInput.key, unitID: unit.id, expected, actual,
      nativePaint: { className: mark.className, background: markStyle.backgroundColor,
        opacity: markStyle.opacity, zIndex: markStyle.zIndex }, layers: order,
      hover: { method: "native text-layer CSS Highlight", priority: overlay.highlight.priority,
        newPageChildren: [...page.div.children].filter(child => child.classList.contains("paperbridge-paragraph-highlight")).length },
      matchedBy: mark.getAttribute("data-annotation-id") === seedInput.key ? "annotation key" : "native paint at seeded PDF rectangle",
      pass: actual.every((value, axis) => Math.abs(value - expected[axis]) <= rectangleTolerance)
        && Number(markStyle.zIndex) >= 1 && overlay.highlight.priority === -1
        && order.filter(item => item.className !== "annotationOverlay").every(item => Number(item.zIndex) >= 2)
        && !!hit && !page.div.querySelector(".paperbridge-paragraph-highlight") };
  }

  /** Require native seeded foreground rendering and unchanged persisted records on both PDFs. */
  async function annotationCompatibility(split, unit) {
    const evidence = await until(() => {
      const values = report.annotatedInputEvidence.map((seedInput, index) => nativeSeedEvidence(split, index, seedInput, unit));
      report.seedRenderingEvidence = values;
      return values.every(item => item?.pass) && values;
    }, "Both native seed highlights render in front of hover");
    check(JSON.stringify(annotationSnapshot()) === seededSnapshot,
      "Native source/translated seeds remain unchanged during hover", { rendering: evidence });
    report.seedRenderingEvidence = evidence;
  }

  /** Observe native rerender refresh before sending any new mouse event. */
  async function geometryRefresh(split, label) {
    await settle(split);
    const unit = split.alignment.hoverUnit;
    const overlays = unit ? overlayEvidence(split, unit) : [];
    const pointer = split.alignment.hoverPointer;
    const hit = pointer && split.frames[pointer.index].document.elementFromPoint(pointer.x, pointer.y);
    check(unit ? overlays.every(item => item.pass) : hoverCleared(split),
      label + ": native rerender leaves exact refreshed overlays or a safe miss", {
        pointer: pointer && { index: pointer.index, x: pointer.x, y: pointer.y },
        nativeHitClass: hit?.getAttribute?.("class"), unitID: unit?.id || null, overlays,
        input: "Native viewer geometry APIs; no pointer event sent after rerender" });
  }

  /** Find actual translated text within the unseeded second request, not a guessed screen line. */
  function selectionSpan(split, unit) {
    const page = split.apps[1].pdfViewer.getPageView(unit.target.page);
    return [...page.div.querySelectorAll(".textLayer span")].find(span => {
      const box = span.getBoundingClientRect(), pageBox = page.div.getBoundingClientRect();
      const x = ((box.left + box.width / 2 - pageBox.left) * page.div.offsetWidth / pageBox.width - page.div.clientLeft)
        * page.viewport.width / page.div.clientWidth;
      const y = ((box.top + box.height / 2 - pageBox.top) * page.div.offsetHeight / pageBox.height - page.div.clientTop)
        * page.viewport.height / page.div.clientHeight;
      const point = page.viewport.convertToPdfPoint(x, y);
      return span.textContent.trim().length > 8 && box.width > 40 && box.top > edgeMargin
        && box.bottom < split.frames[1].innerHeight - edgeMargin
        && unit.target.rects.some(rect => point[0] >= rect[0] && point[0] <= rect[2]
          && point[1] >= rect[1] && point[1] <= rect[3]);
    });
  }

  /** Use the actual translated highlight tool and trusted drag, then await its real annotation. */
  async function nativeHighlight(split, unit) {
    const doc = split.browser.contentWindow.document;
    const button = await until(() => doc.querySelector(".toolbar-button.highlight"), "Native translated highlight tool exists");
    check(doc.defaultView.getComputedStyle(button.closest(".tools")).display !== "none",
      "Actual native highlight tools remain accessible in split");
    await click(button);
    await until(() => split.right.toolType === "highlight", "Actual native translated highlight tool activates");
    await settle(split);
    const span = await until(() => selectionSpan(split, unit), "Real translated text is visible inside second request");
    const frame = split.frames[1], box = span.getBoundingClientRect(), y = box.top + box.height / 2;
    // Start inside the first glyph; crossing the last includes punctuation on Windows.
    const glyphInset = 0.5, endPadding = 2, dragSteps = 6;
    const start = box.left + glyphInset, end = box.right + endPadding;
    const before = new Set(split.right._state.annotations.map(annotation => annotation.id));
    let pressed = false, created;
    const events = [], evidence = { action: "native translated highlight drag with hover enabled",
      method: "native toolbar + Gecko windowUtils mouse events", expectedText: span.textContent,
      // Zotero's public PDF.js evaluator normalizes selection characters with NFKD.
      expectedNativeText: span.textContent.normalize("NFKD").trim(), textNormalization: "NFKD",
      box: { left: box.left, top: box.top, width: box.width, height: box.height }, events: [] };
    report.inputs.push(evidence);
    /** Preserve native input event objects until their actual handlers have finished. */
    function observe(event) { events.push(event); }
    const types = ["pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup"];
    types.forEach(type => frame.document.addEventListener(type, observe, { capture: true, passive: true }));
    try {
      await move(split, 1, { x: start, y }, "pre-drag native text hover");
      check(split.alignment.hoverEnabled && split.alignment.hoverUnit?.id === unit.id,
        "Hover is genuinely active immediately before native selection");
      mouse(frame, "mousedown", start, y);
      pressed = true;
      check(hoverCleared(split), "Pressed native selection clears cosmetic hover only");
      for (let step = 1; step <= dragSteps; step++) {
        mouse(frame, "mousemove", start + (end - start) * step / dragSteps, y, primaryMouseButtons);
        await Zotero.Promise.delay(pollMS);
      }
      check(split.alignment.hoverEnabled && split.right.toolType === "highlight",
        "Native highlight tool and independent hover switch stay enabled during drag");
      mouse(frame, "mouseup", end, y);
      pressed = false;
      const annotation = await until(() => split.right._state.annotations.find(item =>
        item.type === "highlight" && !before.has(item.id)), "Trusted drag creates actual native translated highlight");
      evidence.annotation = JSON.parse(JSON.stringify(annotation));
      check(annotation.text.trim() === evidence.expectedNativeText && annotation.position.pageIndex === unit.target.page
        && annotation.position.rects.length > 0 && annotation.position.rects.every(rect => rect.length === 4
          && Array.from(rect).every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]),
      "Native drag selects the full rendered line with native text normalization and real PDF positions",
      { renderedText: evidence.expectedText, expectedNativeText: evidence.expectedNativeText,
        textNormalization: evidence.textNormalization, text: annotation.text, position: evidence.annotation.position });
      created = evidence.annotation;
    } finally {
      // Release real native input even if a mid-drag assertion fails.
      if (pressed) mouse(frame, "mouseup", end, y);
      types.forEach(type => frame.document.removeEventListener(type, observe, true));
      evidence.events = events.map(event => ({ type: event.type, trusted: event.isTrusted,
        buttons: event.buttons, prevented: event.defaultPrevented, x: event.clientX, y: event.clientY }));
    }
    check(["pointerdown", "pointermove", "pointerup"].every(type => evidence.events.some(event =>
      event.type === type && event.trusted)), "Native annotation creation uses trusted input, not callbacks", evidence);
    return created;
  }

  /** Close through the actual split lifecycle and await annotation persistence. */
  async function close() {
    if (!state) return;
    const previous = state;
    bridge.closeSplit(previous.reader.tabID);
    await ready(previous.annotationSave, "Close-time translated native annotation save finishes");
    check(!bridge.splits.has(previous.reader.tabID), "Closed split releases lifecycle state");
    state = null;
  }

  try {
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    report.environment = { ...report.environment, root: typeof PAPERBRIDGE_TEST_ROOT === "undefined" ? null : PAPERBRIDGE_TEST_ROOT,
      profileDirectory: profile, dataDirectory: Zotero.DataDirectory.dir,
      expectedProfileDirectory: config.expectedProfileDirectory, expectedDataDirectory: config.expectedDataDirectory,
      fixtureDirectory: config.fixtureDirectory };
    check(config.isolated === true && !!config.reportPath && !!config.fixtureDirectory
      && samePath(profile, config.expectedProfileDirectory) && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory),
    "Harness runs only in the caller's disposable profile/data pair", report.environment);
    isolated = true;
    bridge = Zotero.PaperBridge;
    check(!!bridge, "Packaged PaperBridge is available");
    originalRequest = bridge.request;
    /** Forbid all job submissions/retries; forward validation and every other real API request. */
    guardedRequest = async function request(path, method, data) {
      if ((method || "GET").toUpperCase() === "POST" && /^\/jobs(?:[/?]|$)/.test(path)) {
        report.jobsPostAttempts++;
        throw new Error("Hover isolation forbids POST " + path);
      }
      const result = await originalRequest.call(this, path, method, data);
      if (path.split("?")[0] === "/alignment/validate") report.validationCalls++;
      return result;
    };
    bridge.request = guardedRequest;
    await ready(bridge.ready, "Packaged backend is ready");
    await ready(Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad("item"), "Native library items load");
    const jobsBefore = await bridge.request("/jobs");
    report.jobsBefore = (Array.isArray(jobsBefore) ? jobsBefore : jobsBefore.jobs)?.length;
    check(report.jobsBefore === 0 && bridge.splits.size === 0, "Isolated backend starts with no jobs or splits");
    report.stage = "trace-fixture";
    const sourceFile = PathUtils.join(config.fixtureDirectory, "source.pdf");
    const outputFile = PathUtils.join(config.fixtureDirectory, "translated.pdf");
    const mappingPath = PathUtils.join(config.fixtureDirectory, "alignment.json");
    initialSidecar = await IOUtils.read(mappingPath);
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "PaperBridge isolated traced paragraph-hover acceptance");
    await parent.saveTx();
    source = await Zotero.Attachments.importFromFile({ file: sourceFile, parentItemID: parent.id });
    translated = await Zotero.Attachments.importFromFile({ file: outputFile, parentItemID: parent.id });
    const sourcePath = await source.getFilePathAsync(), outputPath = await translated.getFilePathAsync();
    check(!samePath(sourcePath, sourceFile) && !samePath(outputPath, outputFile) && parent.getAttachments().length === 2,
      "Real source/translated attachment copies share one isolated article", { sourcePath, outputPath });
    const validated = await bridge.request("/alignment/validate", "POST",
      { mapping_path: mappingPath, source_path: sourcePath, output_path: outputPath });
    mapping = validated.mapping;
    check(validated.available === true && mapping?.units?.length === 2
      && mapping.units.every(unit => unit.status === "verified" && unit.source.page === 0 && unit.target.page === 0),
    "Real endpoint validates the two-unit one-page traced fixture", { reason: validated.reason });
    report.scope.sourceSHA256 = mapping.source_sha256;
    report.scope.outputSHA256 = mapping.output_sha256;
    report.scope.unitIDs = mapping.units.map(unit => unit.id);
    record = await bridge.library.put(source, null, bridge.configuration(),
      { state: "done", output_path: outputPath, quality: { status: "unknown" } }, await IOUtils.stat(sourcePath));
    await bridge.library.attach(record, translated);
    await bridge.library.update(record, { alignment_path: mappingPath });
    await bridge.library.settled();
    const first = mapping.units[0], second = mapping.units[1];
    await seed(source, first.source, "source");
    await seed(translated, first.target, "target");
    seededSnapshot = JSON.stringify(annotationSnapshot());
    report.stage = "controls-and-hover";
    await open();
    const alignment = state.alignment, calls = [navigationObserver(state, 0), navigationObserver(state, 1)];
    check(alignment.control.children[0] === alignment.button && alignment.control.children[1] === alignment.status
      && alignment.hoverButton.classList.contains("paperbridge-paragraph-hover-toggle")
      && !alignment.hoverEnabled && alignment.hoverButton.getAttribute("aria-pressed") === "false" && hoverCleared(state),
    "Default-off independent hover control preserves explicit localization/status order");
    await setSync(state, false);
    const rect = first.source.rects[0];
    await move(state, 0, screenPoint(state, 0, first.source.page,
      [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]), "default off");
    check(hoverCleared(state), "Default-off trusted hover creates no overlays");
    await click(alignment.hoverButton);
    check(alignment.hoverEnabled && !state.sync && alignment.hoverButton.getAttribute("aria-pressed") === "true",
      "Hover enables independently with sync disabled");
    await hover(state, 0, first, calls, "source -> translated");
    await hover(state, 1, first, calls, "translated -> source");
    await annotationCompatibility(state, first);
    if (Number(config.capturePauseMS) > 0) {
      // This is the already-verified isolated process, never another Zotero instance on the desktop.
      const testWindow = Zotero.getMainWindow();
      testWindow.focus();
      Services.focus.activeWindow = testWindow;
      // Native focus can blur the PDF iframe and clear hover; restore it through actual input.
      await hover(state, 1, first, calls, "isolated visual capture hover");
      await annotationCompatibility(state, first);
      report.windowBounds = { screenX: testWindow.screenX, screenY: testWindow.screenY,
        outerWidth: testWindow.outerWidth, outerHeight: testWindow.outerHeight };
      report.stage = "visual";
      report.visual = { pauseMS: Number(config.capturePauseMS), overlays: overlayEvidence(state, first),
        nativeAnnotations: report.seedRenderingEvidence, scope: report.scope.fixture };
      await writeReport();
      await captureNativeWindow(testWindow);
      // Capture a request without native annotations so the pale hover paint is independently visible.
      await hover(state, 0, second, calls, "unannotated visual capture hover");
      report.visualUnannotated = { unitID: second.id, overlays: overlayEvidence(state, second) };
      await captureNativeWindow(testWindow, "unannotated");
      await writeReport();
      await Zotero.Promise.delay(Number(config.capturePauseMS));
    }
    report.stage = "clearing-and-independence";
    for (const index of [0, 1]) {
      await hover(state, index, first, calls, sides[index] + " before whitespace");
      const page = state.apps[index].pdfViewer.getPageView(0), viewBox = Array.from(page.viewport.viewBox);
      const blank = [(viewBox[0] + viewBox[2]) / 2, (viewBox[1] + viewBox[3]) / 2];
      check(!mapping.units.some(unit => unit[sides[index]].rects.some(box =>
        blank[0] >= box[0] && blank[0] <= box[2] && blank[1] >= box[1] && blank[1] <= box[3])),
      "Whitespace probe lies outside every traced unit", { side: sides[index], blank });
      await move(state, index, screenPoint(state, index, 0, blank), sides[index] + " whitespace miss");
      await until(() => hoverCleared(state), "Whitespace hover frame clears both native highlights");
      check(hoverCleared(state), "Whitespace clears both overlays from " + sides[index]);
    }
    await setSync(state, true);
    check(alignment.hoverEnabled, "Changing sync does not disable hover");
    await hover(state, 1, second, calls, "sync enabled hover");
    await click(alignment.hoverButton);
    check(!alignment.hoverEnabled && state.sync && hoverCleared(state), "Hover disables without changing enabled sync");
    await click(alignment.hoverButton);
    check(alignment.hoverEnabled && state.sync, "Hover enables without changing enabled sync");
    await setSync(state, false);
    report.stage = "geometry-refresh";
    await hover(state, 0, first, calls, "before scale change");
    let oldOverlays = [...alignment.hoverHighlights];
    // Different real scales ensure neither overlay borrows the other viewer's viewport.
    state.apps[0].pdfViewer.currentScale *= 0.88;
    await rendered(state, 0);
    await settle(state);
    state.apps[1].pdfViewer.currentScale *= 0.94;
    await rendered(state, 1);
    await settle(state);
    await until(() => oldOverlays.every(overlay => !overlay.isConnected), "Scale change removes stale overlays");
    await geometryRefresh(state, "Scale refresh");
    await hover(state, 1, first, calls, "after unequal native scale changes");
    oldOverlays = [...alignment.hoverHighlights];
    // Native canvas updates are asynchronous; await each operation before changing its scale again.
    state.apps[0].pdfViewer.pagesRotation = 90;
    await rendered(state, 0);
    await settle(state);
    state.apps[1].pdfViewer.pagesRotation = 270;
    await rendered(state, 1);
    await settle(state);
    for (const index of [0, 1]) {
      state.apps[index].pdfViewer.currentScaleValue = "page-fit";
      await rendered(state, index);
      await settle(state);
    }
    await until(() => oldOverlays.every(overlay => !overlay.isConnected), "Rotation removes stale overlays");
    await geometryRefresh(state, "Rotation refresh");
    await hover(state, 0, first, calls, "after distinct native rotations");
    check(state.apps[0].pdfViewer.pagesRotation === 90 && state.apps[1].pdfViewer.pagesRotation === 270,
      "Rotation refresh uses distinct actual native viewports");
    for (const index of [0, 1]) {
      state.apps[index].pdfViewer.pagesRotation = 0;
      await rendered(state, index);
      await settle(state);
      state.apps[index].pdfViewer.currentScaleValue = "page-fit";
      await rendered(state, index);
      await settle(state);
    }
    report.stage = "whole-request-contract";
    const contract = alignment.constructor;
    const probe = JSON.parse(JSON.stringify(mapping));
    // Overlapping rectangles within one request are supplementary static probes only.
    sides.forEach(side => probe.units[0][side].rects.push([...probe.units[0][side].rects[0]]));
    for (const side of sides) {
      const box = probe.units[0][side].rects[0], point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const grouped = contract.hitTest(probe, 0, point, side, true);
      const strict = contract.hitTest(probe, 0, point, side, false);
      const ambiguous = JSON.parse(JSON.stringify(probe));
      ambiguous.units[1][side] = JSON.parse(JSON.stringify(ambiguous.units[0][side]));
      check(grouped.status === "unique" && grouped.unit?.id === first.id && strict.status === "ambiguous"
        && contract.hitTest(ambiguous, 0, point, side, true).status === "ambiguous",
      "Static " + side + " hitTest groups one request, never two different units", { scope: "supplementary static clone, not native multi-rectangle fixture" });
    }
    report.stage = "missing-mapping";
    await hover(state, 1, first, calls, "before unavailable mapping");
    const beforeMissing = positions(state);
    alignment.setMapping(null, "Isolated missing-map acceptance");
    check(!alignment.mapping && !alignment.hoverEnabled && alignment.hoverButton.disabled && alignment.button.disabled
      && hoverCleared(state) && alignment.status.textContent === "Isolated missing-map acceptance"
      && JSON.stringify(positions(state)) === JSON.stringify(beforeMissing),
    "Missing mapping disables only mapping controls without navigation");
    await move(state, 0, screenPoint(state, 0, 0, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]), "mapping unavailable");
    check(hoverCleared(state), "Missing-map native hover is a safe no-op");
    alignment.setMapping(mapping);
    check(!alignment.hoverEnabled && !alignment.hoverButton.disabled, "Restored mapping remains opt-in");
    await click(alignment.hoverButton);
    report.stage = "native-annotation-selection";
    const created = await nativeHighlight(state, second);
    report.createdNativeAnnotation = created;
    // Let the genuine reader debounce save complete before testing unrelated hover writes.
    await until(() => {
      const item = Zotero.Items.getByLibraryAndKey(translated.libraryID, created.id);
      return item?.annotationText === created.text
        && JSON.stringify(JSON.parse(item.annotationPosition)) === JSON.stringify(created.position);
    }, "Native selection reaches the real annotation database");
    await ready(state.annotations.pending, "Native selection persistence queue settles");
    // Deselect through a real blank-page click, not native annotation callbacks.
    const viewBox = Array.from(state.apps[1].pdfViewer.getPageView(0).viewport.viewBox);
    const blank = screenPoint(state, 1, 0, [(viewBox[0] + viewBox[2]) / 2, (viewBox[1] + viewBox[3]) / 2]);
    mouse(state.frames[1], "mousemove", blank.x, blank.y);
    mouse(state.frames[1], "mousedown", blank.x, blank.y);
    mouse(state.frames[1], "mouseup", blank.x, blank.y);
    await Zotero.Promise.delay(pollMS);
    report.stage = "reuse-and-close";
    await hover(state, 0, first, calls, "before split reuse");
    const reused = state;
    const focusEventsBeforeReuse = report.focusEvents.length;
    await ready(bridge.split(source, translated), "Repeated split open completes");
    const reuseBlur = report.focusEvents.slice(focusEventsBeforeReuse);
    const retainedPaint = alignment.hoverHighlights.every((overlay, index) => overlay?.isConnected
      && reused.frames[index].CSS.highlights.get("paperbridge-paragraph-hover") === overlay.highlight);
    check(bridge.splits.get(reused.reader.tabID) === reused && reused.alignment === alignment
      && reused.alignment.hoverEnabled && alignment.control.ownerDocument.querySelectorAll(".paperbridge-paragraph-hover-toggle").length === 1
      && (retainedPaint || (reuseBlur.length > 0 && hoverCleared(reused)))
      && reused.frames.every(frame => !frame.document.querySelector(".paperbridge-paragraph-highlight")),
    "Split reuse preserves one controller/switch and owned paint, or cleans it on observed native blur",
    { retainedPaint, nativeBlurEvents: reuseBlur });
    await hover(state, 1, second, calls, "switch to another complete request");
    const closingOverlays = [...alignment.hoverHighlights], closingControl = alignment.control;
    await close();
    check(alignment.disposed && !alignment.hoverEnabled && !alignment.hoverUnit
      && alignment.hoverHighlights.every(overlay => !overlay) && closingOverlays.every(overlay => !overlay.isConnected)
      && !closingControl.isConnected, "Normal close cleans hover state, both overlays and control");
    await move(reused, 0, screenPoint(reused, 0, 0, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]), "source hover after close");
    check(!reused.frames[0].CSS.highlights.has("paperbridge-paragraph-hover") && !alignment.hoverUnit,
      "Closed source reader cannot revive disposed hover listeners");
    const saved = Zotero.Items.getByLibraryAndKey(translated.libraryID, created.id);
    check(saved?.isAnnotation() && saved.parentID === translated.id && saved.annotationType === "highlight"
      && saved.annotationText.trim() === created.text.trim()
      && JSON.stringify(JSON.parse(saved.annotationPosition)) === JSON.stringify(created.position)
      && source.getAnnotations().length === 1 && translated.getAnnotations().length === 2
      && JSON.stringify(annotationSnapshot().map(items => items.filter(item => item.key !== created.id))) === seededSnapshot,
    "Normal close retains exact native selection and unchanged seeds without cross-pane copying", { key: created.id });
    const native = await Zotero.Reader.open(translated.id);
    nativeReaders.add(native);
    await ready(native._initPromise, "Standalone translated reader reopens persisted items");
    await until(() => native._internalReader._state.annotations.some(item => item.id === created.id),
      "Standalone reader reloads the actual saved highlight");
    const reopened = native._internalReader._state.annotations.find(item => item.id === created.id);
    check(reopened.text === created.text && JSON.stringify(reopened.position) === JSON.stringify(created.position),
      "Standalone native reopen retains selected text and position (not a process restart)");
    native.close();
    await until(() => !Zotero.Reader._readers.includes(native), "Standalone translated reader closes");
    await bridge.library.update(record, { alignment_path: null });
    await open(false);
    check(!state.alignment.hoverEnabled && state.alignment.hoverButton.disabled && state.alignment.button.disabled
      && state.alignment.status.getBoundingClientRect().height > 0 && !state.right._state.readOnly
      && state.apps.every(app => app.pdfViewer.getPageView(0).renderingState === renderingFinished),
    "Actual no-sidecar split retains readable PDFs and editable native translated annotations");
    await close();
    await bridge.library.update(record, { alignment_path: mappingPath });
    const fixturesValid = await bridge.request("/alignment/validate", "POST",
      { mapping_path: mappingPath, source_path: sourceFile, output_path: outputFile });
    const finalSidecar = await IOUtils.read(mappingPath);
    check(fixturesValid.available === true && fixturesValid.mapping.source_sha256 === mapping.source_sha256
      && fixturesValid.mapping.output_sha256 === mapping.output_sha256 && finalSidecar.length === initialSidecar.length
      && finalSidecar.every((byte, index) => byte === initialSidecar[index]), "Original traced PDFs and sidecar stay untouched");
    const jobsAfter = await bridge.request("/jobs");
    report.jobsAfter = (Array.isArray(jobsAfter) ? jobsAfter : jobsAfter.jobs)?.length;
    check(report.jobsPostAttempts === 0 && report.jobsAfter === 0 && report.validationCalls >= 3,
      "No POST /jobs or /jobs/retry; real alignment validation was not inhibited", {
        jobsBefore: report.jobsBefore, jobsAfter: report.jobsAfter, blockedPosts: report.jobsPostAttempts,
        validationCalls: report.validationCalls, modelCallsThisRun: report.scope.modelCallsThisRun });
    check(report.rendererErrors.length === 0, "No observed native PDF renderer exceptions", { errors: report.rendererErrors });
    report.stage = "complete";
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || "" });
    Zotero.logError(error);
  } finally {
    // Save failure evidence before teardown; a cleanup failure must still produce a report.
    try { await writeReport(); } catch (error) { Zotero.logError(error); }
    if (isolated) {
      try {
        if (state) await close();
        // An initialization failure can leave a split before open() records its state.
        for (const split of [...(bridge?.splits.values() || [])]) {
          if (split.source?.id === source?.id && split.translated?.id === translated?.id) {
            nativeReaders.add(split.reader);
            bridge.closeSplit(split.reader.tabID);
            await ready(split.annotationSave, "Partially initialized split save finishes");
          }
        }
        await ready(Promise.all(bridge?.annotationWrites.values() || []), "All native annotation writes finish before quit");
        if (record) {
          await bridge.library.update(record, { alignment_path: PathUtils.join(config.fixtureDirectory, "alignment.json") });
          await ready(bridge.library.settled(), "Isolated library persistence settles");
        }
        for (const reader of Zotero.Reader._readers) {
          if (reader.itemID === source?.id || reader.itemID === translated?.id) nativeReaders.add(reader);
        }
        for (const reader of nativeReaders) if (Zotero.Reader._readers.includes(reader)) reader.close();
        await until(() => [...nativeReaders].every(reader => !Zotero.Reader._readers.includes(reader)), "All suite-created native tabs close");
      } catch (error) {
        report.ok = false;
        report.errors.push({ message: "Cleanup: " + String(error), stack: error.stack || "" });
        Zotero.logError(error);
      }
    }
    if (guardedRequest && bridge?.request === guardedRequest) bridge.request = originalRequest;
    if (report.errors.length || report.jobsPostAttempts || report.rendererErrors.length) report.ok = false;
    try { await writeReport(); }
    finally {
      // A misconfigured invocation reports failure but must never quit a daily Zotero instance.
      if (isolated) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
