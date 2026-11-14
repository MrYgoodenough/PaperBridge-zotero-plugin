/** Exercise isolated navigation/notes, then verify native notes in a new process. */
/* global Zotero, Services, IOUtils, PathUtils, Ci, Components, PAPERBRIDGE_TEST_ROOT, PAPERBRIDGE_ALIGNMENT_TEST */
(async () => {
  // The alignment suite owns these paths; never import into the daily library.
  const root = PAPERBRIDGE_TEST_ROOT;
  // Optional runner configuration permits fresh isolated runs without changing legacy callers.
  const config = typeof PAPERBRIDGE_ALIGNMENT_TEST === "undefined" ? null : PAPERBRIDGE_ALIGNMENT_TEST;
  // Keep the historical profile path only as the legacy fallback.
  const expectedProfileDirectory = config?.expectedProfileDirectory ?? PathUtils.join(root, ".runtime", "alignment-profile");
  // Confirm the actual data directory independently from the native profile.
  const expectedDataDirectory = config?.expectedDataDirectory ?? PathUtils.join(root, ".runtime", "alignment-data");
  const fixtureDir = PathUtils.join(root, ".runtime", "alignment-fixture");
  const sourceFixture = PathUtils.join(fixtureDir, "source.pdf");
  const outputFixture = PathUtils.join(fixtureDir, "translated.pdf");
  const mappingPath = PathUtils.join(fixtureDir, "alignment.json");
  // Fresh-run reports must use the caller's output path rather than overwrite historical evidence.
  const reportPath = config?.reportPath ?? PathUtils.join(root, ".runtime", "alignment-test.json");
  // Legacy callers still run the complete create suite.
  const phase = config?.phase ?? "create";
  // Only create writes this checkpoint; reopen reads it without importing anything.
  const statePath = config?.statePath ?? PathUtils.join(root, ".runtime", "alignment-state.json");
  // Version the disposable acceptance checkpoint, not native library data.
  const stateVersion = 1;
  // UI waits are bounded generously; highlight lifetime remains the module's responsibility.
  const waitMilliseconds = 45000;
  const pollMilliseconds = 100;
  // PDF.js exposes RenderingStates.FINISHED as 3.
  const renderingFinished = 3;
  // Keep trusted selection drags away from PDF.js native auto-scroll edges.
  const selectionEdgeMargin = 24;
  // Cross the last glyph without relying on platform-specific pixel rounding.
  const selectionEndPadding = 2;
  // Start inside the first actual glyph rather than in the page margin.
  const selectionStartInset = 0.5;
  // Let native throttled text-selection processing observe multiple actual drag moves.
  const selectionDragSteps = 6;
  const report = { ok: false, phase, processID: Services.appinfo?.processID, statePath,
    prototype: true, providerCalls: 0, jobsPostAttempts: 0,
    zoteroVersion: Zotero.version, fixtureModelResponses: "simulated", physicalNavigationObserved: false,
    mappingGeneration: "parent_fixture_only", checks: [], errors: [] };
  // Keep physical movement evidence separate for both explicit navigation destinations.
  report.navigationBySide = { source: false, target: false };
  let bridge, originalRequest, state, record, temporaryDir;
  // Refuse all writes and quit requests unless both disposable native paths were confirmed.
  let isolated = false;
  let validationCalls = 0;

  /** Record exact pass/fail evidence before stopping on an assertion failure. */
  function check(condition, name, details = {}) {
    report.checks.push({ name, pass: !!condition, details });
    if (!condition) throw new Error(name + ": " + JSON.stringify(details));
  }

  /** Wait for actual readiness, returning the successful predicate value. */
  async function until(predicate, message) {
    const deadline = Date.now() + waitMilliseconds;
    do {
      const result = await predicate();
      if (result) return result;
      await Zotero.Promise.delay(pollMilliseconds);
    } while (Date.now() < deadline);
    throw new Error(typeof message === "function" ? message() : message);
  }

  /** Compare native paths without depending on Windows letter case or separators. */
  function samePath(left, right) {
    const normalize = value => {
      const path = PathUtils.normalize(value);
      return Zotero.isWin ? path.toLowerCase() : path;
    };
    return normalize(left) === normalize(right);
  }

  /** Summarize actual reading position without claiming pixel-perfect visual alignment. */
  function position(viewer) {
    return { page: viewer.currentPageNumber, scale: viewer.currentScale,
      scrollTop: viewer.container.scrollTop, scrollLeft: viewer.container.scrollLeft };
  }

  /** Let native layout and scroll callbacks settle before observing an explicit action. */
  async function settle(viewer) {
    let previous, repeats = 0;
    await until(() => {
      const current = JSON.stringify(position(viewer));
      repeats = current === previous ? repeats + 1 : 0;
      previous = current;
      return repeats >= 3;
    }, "Reader position did not settle");
  }

  /** Await the page-specific viewport rather than a PDF.js placeholder viewport. */
  async function rendered(viewer, pageIndex) {
    return until(() => {
      const page = viewer.getPageView(pageIndex);
      return page?.renderingState === renderingFinished && page.div?.isConnected && page.viewport && page;
    }, "PDF page did not render: " + pageIndex);
  }

  /** Observe navigation while forwarding every call to the real PDF.js implementation. */
  function observeNavigation(split, index) {
    const viewer = split.apps[index].pdfViewer;
    const original = viewer.scrollPageIntoView;
    const calls = [];
    /** Record arguments and forward to the untouched native implementation. */
    const observer = function scrollPageIntoView(destination) {
      calls.push(JSON.parse(JSON.stringify(destination)));
      return original.call(this, destination);
    };
    viewer.scrollPageIntoView = observer;
    split.cleanups.push(() => {
      if (viewer.scrollPageIntoView === observer) viewer.scrollPageIntoView = original;
    });
    return calls;
  }

  /** Use the existing split UI to switch modes, preserving its real event handling. */
  function setSync(split, enabled) {
    const button = split.alignment.control.parentElement.querySelector("button[aria-pressed]");
    if (!button) throw new Error("Split sync control is unavailable");
    if (split.sync !== enabled) button.click();
    if (split.sync !== enabled || button.getAttribute("aria-pressed") !== String(enabled)) {
      throw new Error("Split sync toggle did not update its actual state");
    }
    return button;
  }

  /** Navigate through the same PDF-native XYZ API used by the addon sync module. */
  function navigate(split, index, side) {
    const rect = side.rects[0];
    const destination = { pageNumber: side.page + 1,
      destArray: [null, { name: "XYZ" }, rect[0], rect[3], null], allowNegativeOffset: true };
    split.apps[index].pdfViewer.scrollPageIntoView(Components.utils.cloneInto(destination, split.frames[index]));
  }

  /** Preposition either destination, restoring sync before testing the actual button action. */
  async function moveDestinationAway(split, side, index) {
    const viewer = split.apps[index].pdfViewer;
    const savedSync = split.sync;
    // Only setup bypasses sync; the tested explicit action must use the controller's real guard.
    split.sync = false;
    try {
      if (viewer.pagesCount > 1) {
        const otherPage = (side.page + 1) % viewer.pagesCount;
        const destination = { pageNumber: otherPage + 1 };
        viewer.scrollPageIntoView(Components.utils.cloneInto(destination, split.frames[index]));
        await rendered(viewer, otherPage);
      } else {
        const page = await rendered(viewer, side.page);
        const bounds = page.viewport.viewBox;
        const anchor = side.rects[0];
        // Use the farther PDF corner when there is no other page to navigate to.
        const x = Math.abs(anchor[0] - bounds[0]) > Math.abs(anchor[0] - bounds[2]) ? bounds[0] : bounds[2];
        const y = Math.abs(anchor[3] - bounds[1]) > Math.abs(anchor[3] - bounds[3]) ? bounds[1] : bounds[3];
        const destination = { pageNumber: side.page + 1,
          destArray: [null, { name: "XYZ" }, x, y, null], allowNegativeOffset: true };
        viewer.scrollPageIntoView(Components.utils.cloneInto(destination, split.frames[index]));
      }
      await settle(viewer);
    } finally {
      split.sync = savedSync;
    }
  }

  /** Select a unique midpoint on the requested side, without guessing across overlapping rectangles. */
  function selectFragment(mapping, side = "target") {
    for (const unit of mapping.units) {
      for (const rect of unit[side].rects) {
        const point = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
        let hits = 0;
        for (const candidate of mapping.units) {
          if (candidate[side].page !== unit[side].page) continue;
          for (const box of candidate[side].rects) {
            if (point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3]) hits++;
          }
        }
        if (unit.status === "verified" && hits === 1) return { unit, rect, point };
      }
    }
    throw new Error("Fixture has no uniquely hittable verified " + side + " rectangle");
  }

  /** Send trusted mouse input; observe native pointer delivery without cancelling defaults. */
  async function release(split, fragment, index) {
    const frame = split.frames[index];
    const doc = frame.document;
    const side = index === 0 ? "source" : "target";
    const page = split.apps[index].pdfViewer.getPageView(fragment.unit[side].page);
    const box = page.div.getBoundingClientRect();
    // Content PDF.js cannot read a chrome-owned rectangle array.
    const viewportBox = page.viewport.convertToViewportRectangle(
      Components.utils.cloneInto(fragment.rect, frame));
    const x = (viewportBox[0] + viewportBox[2]) / 2;
    const y = (viewportBox[1] + viewportBox[3]) / 2;
    const coordinates = {
      x: box.left + (x * page.div.clientWidth / page.viewport.width + page.div.clientLeft)
        * box.width / page.div.offsetWidth,
      y: box.top + (y * page.div.clientHeight / page.viewport.height + page.div.clientTop)
        * box.height / page.div.offsetHeight,
      frameWidth: frame.innerWidth, frameHeight: frame.innerHeight,
    };
    const evidence = { allowed: false, prevented: false, coordinates, attempts: [] };

    /** Snapshot diagnostics only; never assign or synthesize the controller's remembered point. */
    function pointSnapshot() {
      const point = index === 0 ? split.alignment.sourcePoint : split.alignment.point;
      return point ? { page: point.page, point: Array.from(point.point) } : null;
    }

    /** Summarize the final native event flags and its actual hit-tested page target. */
    function eventSnapshot(event) {
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      const targetPage = target?.closest?.(".page[data-page-number]");
      return { observed: true, type: event.type, isTrusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented, button: event.button, buttons: event.buttons,
        pointerType: event.pointerType, isPrimary: event.isPrimary,
        clientX: event.clientX, clientY: event.clientY,
        pageNumber: targetPage ? Number(targetPage.getAttribute("data-page-number")) : null,
        targetTag: target?.localName || null, targetClass: target?.getAttribute?.("class") || null };
    }

    try {
      // Zotero exposes waived content windows; privileged input APIs live on the Xray wrapper.
      const nativeFrame = Components.utils.unwaiveXrays(frame);
      nativeFrame.focus();
      let utilities;
      try { utilities = nativeFrame.windowUtils; }
      catch (error) { evidence.windowUtilsError = String(error); }
      utilities ||= nativeFrame.docShell?.domWindowUtils;
      if (!utilities) throw new Error("Trusted mouse input API is unavailable");
      if (typeof utilities.sendMouseEvent !== "function") throw new Error("Trusted mouse input API is unavailable");

      /** Observe one delivery attempt, retaining event objects until bubbling has finished. */
      async function attempt() {
        const events = [];
        const result = { mouseDown: true, events: [], immediatePoint: null, statusImmediate: "" };
        // Diagnostic listeners accept untrusted events too, but never alter production listeners.
        const options = { capture: true, passive: true, once: true };
        /** Record native events without preventing defaults or stopping propagation. */
        function observe(event) { events.push(event); }
        const types = ["pointerdown", "mousedown", "pointerup", "mouseup"];
        for (const type of types) doc.addEventListener(type, observe, options, true);
        try {
          // Send an actual native click; any native selection change belongs to the reader.
          utilities.sendMouseEvent("mousedown", coordinates.x, coordinates.y, 0, 1, 0);
          utilities.sendMouseEvent("mouseup", coordinates.x, coordinates.y, 0, 1, 0);
          result.immediatePoint = pointSnapshot();
          result.statusImmediate = split.alignment.status.textContent;
          await Zotero.Promise.delay(pollMilliseconds);
        } catch (error) {
          result.error = String(error);
          result.immediatePoint = pointSnapshot();
          result.statusImmediate = split.alignment.status.textContent;
        } finally {
          for (const type of types) doc.removeEventListener(type, observe, options);
          result.events = events.map(eventSnapshot);
          evidence.attempts.push(result);
        }
        return result;
      }

      const delivered = await attempt();
      evidence.allowed = !delivered.error && delivered.events.some(event => event.type === "pointerup"
        && event.isTrusted && event.pageNumber === fragment.unit[side].page + 1);
      evidence.prevented = evidence.attempts.some(result => result.events.some(event => event.defaultPrevented));
    } catch (error) {
      evidence.error = String(error);
    }
    evidence.pointAfterRelease = pointSnapshot();
    evidence.statusAfterRelease = split.alignment.status.textContent;
    return evidence;
  }

  /** Check destination overlay geometry against its own viewport with tolerant CSS comparisons. */
  function highlightMatches(split, source, overlay, sideIndex) {
    const page = split.apps[sideIndex].pdfViewer.getPageView(source.page);
    if (overlay.parentElement !== page.div || overlay.children.length !== source.rects.length) return false;
    for (let index = 0; index < source.rects.length; index++) {
      // Clone into the destination viewport's own content compartment.
      const box = page.viewport.convertToViewportRectangle(
        Components.utils.cloneInto(source.rects[index], split.frames[sideIndex]));
      const scaleX = page.div.clientWidth / page.viewport.width;
      const scaleY = page.div.clientHeight / page.viewport.height;
      const expected = [Math.min(box[0], box[2]) * scaleX, Math.min(box[1], box[3]) * scaleY,
        Math.abs(box[2] - box[0]) * scaleX, Math.abs(box[3] - box[1]) * scaleY];
      const style = overlay.children[index].style;
      const actual = ["left", "top", "width", "height"].map(name => parseFloat(style.getPropertyValue(name)));
      if (!actual.every((value, axis) => Number.isFinite(value)
        && Math.abs(value - expected[axis]) <= Math.max(1, Math.abs(expected[axis]) * 0.005))) return false;
      if (!(actual[2] > 0 && actual[3] > 0)) return false;
    }
    return overlay.style.pointerEvents === "none";
  }

  /** Observe real pointer/action behavior without replacing mapping or navigation implementations. */
  async function localize(split, fragment, sourceCalls, targetCalls, label, expires = false, index = 1) {
    const inputSide = index === 0 ? "source" : "target";
    const destinationSide = index === 0 ? "target" : "source";
    const destinationIndex = 1 - index;
    const viewer = split.apps[destinationIndex].pdfViewer;
    const inputViewer = split.apps[index].pdfViewer;
    const calls = [sourceCalls, targetCalls];
    const mappedDestination = fragment.unit[destinationSide];
    // The two directions may use different verified units; prepare the exact input before observing clicks.
    const savedSync = split.sync;
    split.sync = false;
    try {
      navigate(split, index, { page: fragment.unit[inputSide].page, rects: [fragment.rect] });
      await rendered(inputViewer, fragment.unit[inputSide].page);
      await settle(inputViewer);
    } finally {
      split.sync = savedSync;
    }
    await moveDestinationAway(split, mappedDestination, destinationIndex);
    await settle(viewer);
    await settle(inputViewer);
    const before = position(viewer);
    const inputBefore = position(inputViewer);
    const destinationCount = calls[destinationIndex].length;
    const inputCount = calls[index].length;
    const event = await release(split, fragment, index);
    await Zotero.Promise.delay(200);
    const point = index === 0 ? split.alignment.sourcePoint : split.alignment.point;
    check(event.allowed && !event.prevented && calls[destinationIndex].length === destinationCount
      && viewer.currentPageNumber === before.page
      && point?.page === fragment.unit[inputSide].page
      && point.point.every((value, axis) => Number.isFinite(value)
        && value >= fragment.rect[axis] && value <= fragment.rect[axis + 2]),
    label + ": pointerup remembers a unique PDF point without navigation or cancellation", {
      before, expectedRect: fragment.rect, rememberedPoint: point,
      status: split.alignment.status.textContent, event,
    });
    const selection = split.frames[index].document.getSelection();
    const selectionBefore = { anchorNode: selection?.anchorNode, anchorOffset: selection?.anchorOffset,
      focusNode: selection?.focusNode, focusOffset: selection?.focusOffset };
    // Stress the existing sync guard even if destination view events could drive the input pane.
    if (split.sync) split.active = destinationIndex;
    const activeBefore = split.active;
    const syncBefore = split.sync;
    (index === 0 ? split.alignment.targetButton : split.alignment.button).click();
    const overlay = await until(() => split.alignment.highlight?.isConnected && split.alignment.highlight,
      () => label + ": destination highlight absent; status=" + split.alignment.status.textContent);
    const destination = calls[destinationIndex][destinationCount];
    const after = position(viewer);
    const moved = before.page !== after.page || Math.abs(before.scrollTop - after.scrollTop) > 2
      || Math.abs(before.scrollLeft - after.scrollLeft) > 2;
    report.navigationBySide[destinationSide] ||= moved;
    if (destinationIndex === 0) report.physicalNavigationObserved ||= moved;
    check(calls[destinationIndex].length === destinationCount + 1 && destination?.pageNumber === mappedDestination.page + 1
      && destination.destArray?.[1]?.name === "XYZ" && destination.destArray[2] === mappedDestination.rects[0][0]
      && destination.destArray[3] === mappedDestination.rects[0][3]
      && viewer.currentPageNumber === mappedDestination.page + 1
      && split.alignment.highlightIndex === destinationIndex
      && split.alignmentNavigationUntil > Date.now()
      && highlightMatches(split, mappedDestination, overlay, destinationIndex),
    label + ": explicit action uses real " + destinationSide + " navigation and its own viewport highlight", {
      destination, sourceScale: split.apps[0].pdfViewer.currentScale,
      targetScale: split.apps[1].pdfViewer.currentScale, rects: overlay.children.length, before, after, physicalMovement: moved,
    });
    await Zotero.Promise.delay(200);
    check(calls[index].length === inputCount && JSON.stringify(position(inputViewer)) === JSON.stringify(inputBefore),
      label + ": localization does not navigate the initiating pane", { sync: split.sync });
    check(split.active === activeBefore && split.sync === syncBefore,
      label + ": localization does not change active pane or sync mode");
    check(selection?.anchorNode === selectionBefore.anchorNode && selection?.anchorOffset === selectionBefore.anchorOffset
      && selection?.focusNode === selectionBefore.focusNode && selection?.focusOffset === selectionBefore.focusOffset,
    label + ": explicit action leaves the initiating native selection unchanged");
    if (expires) {
      await until(() => !overlay.isConnected && split.alignment.highlightTimer == null, "Temporary highlight did not expire");
      check(!split.alignment.highlight, label + ": temporary DOM highlight expires normally");
    }
    return overlay;
  }

  /** Open through the parent integration and await a map loaded by the real validation endpoint. */
  async function openMapped(source, target) {
    const previousCalls = validationCalls;
    await bridge.split(source, target);
    state = [...bridge.splits.values()].find(split => split.reader.itemID === source.id);
    check(!!state?.alignment?.control && !!state.apps?.[1], "Parent exposes initialized split.alignment controller");
    await until(() => state.alignment.mapping && !state.alignment.button.disabled && !state.alignment.targetButton.disabled,
      () => "Integrated map unavailable: " + state.alignment.status.textContent);
    check(validationCalls > previousCalls && state.alignment.mapping.schema_version === 1,
      "Integrated control receives an actual backend-validated mapping", { validationCalls });
    return { sourceCalls: observeNavigation(state, 0), targetCalls: observeNavigation(state, 1) };
  }

  /** Close while retaining inspectable references to prove immediate cleanup. */
  function closeSplit() {
    if (!state) return;
    const split = state;
    const alignment = split.alignment;
    const overlay = alignment.highlight;
    bridge.closeSplit(split.reader.tabID);
    check(!bridge.splits.has(split.reader.tabID) && alignment.disposed && !alignment.control.isConnected
      && !split.browser.isConnected && !overlay?.isConnected && alignment.highlightTimer == null
      && alignment.point === null && alignment.sourcePoint === null && alignment.pending === null && alignment.mapping === null
      && split.reader._iframe.getAttribute("flex") === split.leftFlex,
    "Close disposes control, pending point, highlight, timer and translated browser");
    state = null;
    return alignment;
  }

  /** Send trusted input in the element's own real Gecko window, without fabricating selections. */
  function nativeMouse(window, type, x, y) {
    const frame = Components.utils.unwaiveXrays(window);
    const utilities = frame.windowUtils || frame.docShell.domWindowUtils;
    utilities.sendMouseEvent(type, x, y, 0, 1, 0);
  }

  /** Activate or toggle off an actual reader tool using its native toolbar button. */
  async function noteTool(split, type) {
    if (split.right.toolType === type) return;
    const current = type === "pointer" ? split.right.toolType : type;
    const button = split.browser.contentDocument.querySelector(".toolbar-button." + current);
    if (!button) throw new Error("Native note fixture tool is unavailable: " + current);
    button.click();
    await until(() => split.right.toolType === type, "Native tool did not activate: " + type);
  }

  /** Drag one actual visible PDF text item and record trusted event/selection evidence. */
  async function selectNoteText(split, pageIndex, type) {
    await noteTool(split, type);
    const frame = split.frames[1];
    const page = await rendered(split.apps[1].pdfViewer, pageIndex);
    await settle(split.apps[1].pdfViewer);
    const span = await until(() => [...page.div.querySelectorAll(".textLayer span")].find(item => {
      const box = item.getBoundingClientRect();
      return !item.classList.contains("markedContent") && item.textContent.trim().length > 8
        && box.width > 40 && box.height > 0 && box.left > selectionEdgeMargin
        && box.right + selectionEndPadding < frame.innerWidth - selectionEdgeMargin
        && box.top > selectionEdgeMargin && box.bottom < frame.innerHeight - selectionEdgeMargin;
    }), "Note fixture needs a visible native translated text span; do not inject a selection");
    const box = span.getBoundingClientRect();
    const startX = box.left + selectionStartInset;
    const endX = box.right + selectionEndPadding;
    const y = box.top + box.height / 2;
    const events = [];
    /** Record actual native events without changing their default handling. */
    function observe(event) { events.push({ type: event.type, trusted: event.isTrusted }); }
    for (const event of ["mousedown", "mousemove", "mouseup"]) {
      frame.document.addEventListener(event, observe, { capture: true, passive: true });
    }
    try {
      nativeMouse(frame, "mousedown", startX, y);
      for (let step = 1; step <= selectionDragSteps; step++) {
        nativeMouse(frame, "mousemove", startX + (endX - startX) * step / selectionDragSteps, y);
        await Zotero.Promise.delay(pollMilliseconds);
      }
      nativeMouse(frame, "mouseup", endX, y);
      const actualText = frame.document.getSelection()?.toString() || "";
      const evidence = { type, pageIndex, spanText: span.textContent, actualText, events };
      (report.noteInputs ||= []).push(evidence);
      check(events.some(event => event.type === "mouseup") && events.every(event => event.trusted),
        "Note fixture uses trusted native " + type + " drag input", evidence);
      if (type === "pointer") {
        check(actualText.trim() === span.textContent.trim(), "Selection-note input is the real PDF selection", evidence);
      }
      return evidence;
    } finally {
      for (const event of ["mousedown", "mousemove", "mouseup"]) frame.document.removeEventListener(event, observe, true);
    }
  }

  /** Use the actual note button twice during the disabled action, then inspect the saved/opened note. */
  async function clickNote(split, button, parent, label) {
    const previous = parent.getNotes().length;
    const oldResult = split.alignment.lastNoteResult;
    const window = button.ownerDocument.defaultView;
    const box = button.getBoundingClientRect();
    check(box.width > 0 && box.height > 0 && !button.disabled, label + ": note action is visible and independent");
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    nativeMouse(window, "mousedown", x, y);
    nativeMouse(window, "mouseup", x, y);
    const operation = split.alignment.noteOperation;
    check(operation && split.alignment.selectionNoteButton.disabled && split.alignment.annotationsNoteButton.disabled,
      label + ": both note buttons disable during the same explicit action");
    nativeMouse(window, "mousedown", x, y);
    nativeMouse(window, "mouseup", x, y);
    check(split.alignment.noteOperation === operation, label + ": rapid duplicate clicks reuse the action");
    await until(() => !split.alignment.noteOperation, () => label + ": note did not finish: " + split.alignment.noteStatus.textContent);
    const result = split.alignment.lastNoteResult;
    check(result && result !== oldResult && result.note?.isNote() && result.note.parentID === parent.id
      && result.note.libraryID === split.translated.libraryID && parent.getNotes().length === previous + 1,
    label + ": exactly one native paper-child note was saved", { status: split.alignment.noteStatus.textContent });
    check(result.opened && !result.openError, label + ": official Zotero.Notes.open succeeded",
      { noteKey: result.note.key, openError: String(result.openError || "") });
    const noteWindow = await until(() => {
      for (const candidate of Services.wm.getEnumerator("zotero:note")) {
        if (candidate.document.getElementById("zotero-note-editor")?.item?.id === result.note.id) return candidate;
      }
      return null;
    }, label + ": no actual native note-editor window contains the saved note");
    check(noteWindow.document.getElementById("zotero-note-editor").item.id === result.note.id,
      label + ": actual native note window selects the saved item");
    // Close only this fixture-owned note window, preserving the native split for further checks.
    noteWindow.close();
    await until(() => noteWindow.closed, label + ": native note window did not close");
    // Native saveSync starts an asynchronous DB transaction during window unload.
    await Zotero.DB.waitForTransaction();
    Zotero.getMainWindow().focus();
    return result.note;
  }

  /** Snapshot only native annotation records, never reader-created substitute annotations. */
  async function noteAnnotations(split) {
    const result = [];
    for (const attachment of [split.source, split.translated]) {
      await attachment.loadDataType("childItems");
      const children = [];
      for (const annotation of attachment.getAnnotations()) {
        await annotation.loadAllData();
        children.push(await Zotero.Annotations.toJSON(annotation));
      }
      result.push({ id: attachment.id, key: attachment.key, libraryID: attachment.libraryID,
        parentID: attachment.parentID, children });
    }
    return JSON.stringify(result);
  }

  /** Read native note metadata and actual links without clicking a fabricated location. */
  function noteContent(note, split, pageIndex, text, annotationKey) {
    const doc = new (Zotero.getMainWindow().DOMParser)().parseFromString(note.getNote(), "text/html");
    const metadata = doc.querySelector("[data-citation-items]");
    const citations = metadata && JSON.parse(decodeURIComponent(metadata.getAttribute("data-citation-items")));
    const annotations = [...doc.querySelectorAll("[data-annotation]")]
      .map(node => JSON.parse(decodeURIComponent(node.getAttribute("data-annotation"))));
    const targetLink = [...doc.querySelectorAll("a[href]")].find(node =>
      node.getAttribute("href").includes("/items/" + split.translated.key + "?page=" + (pageIndex + 1)));
    check(doc.body.textContent.includes(text.trim()) && citations?.some(citation =>
      citation.uris.includes(Zotero.URI.getItemURI(split.source.parentItem)))
      && annotations.some(annotation => annotation.attachmentURI === Zotero.URI.getItemURI(split.translated)
        && annotation.position.pageIndex === pageIndex && annotation.annotationKey === annotationKey)
      && !!targetLink && (!annotationKey || targetLink.getAttribute("href").includes("annotation=" + annotationKey)),
    "Native note retains actual text, paper citation, translated attachment identity and physical-page backlink",
    { noteKey: note.key, pageIndex, annotationKey, metadataAnnotations: annotations.length });
    return { id: note.id, key: note.key, libraryID: note.libraryID, parentID: note.parentID,
      parentKey: note.parentItem.key, pageIndex, text, annotationKey, noteHTML: note.getNote(),
      attachmentKey: split.translated.key, attachmentURI: Zotero.URI.getItemURI(split.translated),
      targetBacklink: targetLink.getAttribute("href"), citations, annotations,
      backlinks: [...doc.querySelectorAll('a[href^="zotero://open-pdf/"]')].map(node => node.getAttribute("href")) };
  }

  /** Hash actual native attachment bytes without writing or replacing the PDF. */
  async function pdfHash(attachment) {
    const bytes = await IOUtils.read(await attachment.getFilePathAsync());
    const hash = Components.classes["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  /** Preserve stable native identity and bytes, excluding normal reader access timestamps. */
  async function attachmentSnapshot(attachment) {
    return { id: attachment.id, key: attachment.key, libraryID: attachment.libraryID,
      parentID: attachment.parentID, parentKey: attachment.parentItem.key,
      uri: Zotero.URI.getItemURI(attachment), contentType: attachment.attachmentContentType,
      path: await attachment.getFilePathAsync(), sha256: await pdfHash(attachment) };
  }

  /** Record all child note identities so cold reopening cannot silently create a note. */
  async function childNoteKeys(parent) {
    await parent.reload(["childItems"], true);
    const notes = parent.getNotes().map(id => Zotero.Items.get(id));
    check(notes.every(note => note?.isNote()), "Native paper child list resolves existing notes", { parentKey: parent.key });
    return notes.map(note => note.key).sort();
  }

  /** Capture final persisted HTML after native note windows and the split have closed. */
  async function saveNoteState(parent, source, translated, profile) {
    check(Number.isInteger(report.processID) && report.processID > 0, "Create records the actual native process ID");
    const split = { source, translated };
    const notes = [];
    for (const entry of report.noteRecords) {
      const note = Zotero.Items.getByLibraryAndKey(entry.libraryID, entry.key);
      await note.loadAllData();
      await note.reload(["note"], true);
      notes.push(noteContent(note, split, entry.pageIndex, entry.text, entry.annotationKey));
    }
    report.noteRecords = notes;
    const saved = { version: stateVersion, phase: "create", processID: report.processID,
      profile, dataDirectory: Zotero.DataDirectory.dir,
      parent: { id: parent.id, key: parent.key, libraryID: parent.libraryID,
        title: parent.getField("title"), uri: Zotero.URI.getItemURI(parent) },
      source: await attachmentSnapshot(source), translated: await attachmentSnapshot(translated),
      noteRecords: notes, childNoteKeys: await childNoteKeys(parent), annotationSnapshot: await noteAnnotations(split) };
    await IOUtils.writeUTF8(statePath, JSON.stringify(saved, null, 2));
    check(true, "Create saves final native note/parent/attachment/annotation state for cold reopening", { statePath });
  }

  /** Resolve existing checkpoint items only; never create or repair missing native data. */
  async function savedItem(entry, kind) {
    const item = Zotero.Items.getByLibraryAndKey(entry.libraryID, entry.key);
    check(item && !item.deleted && item.id === entry.id && item.libraryID === entry.libraryID
      && (kind === "note" ? item.isNote() : kind === "attachment" ? item.isPDFAttachment() : item.isRegularItem()),
    "Cold reopen resolves the existing native " + kind, { key: entry.key, libraryID: entry.libraryID });
    await item.loadAllData();
    return item;
  }

  /** Open an existing note via the official API and observe its actual native editor. */
  async function reopenNote(note) {
    await Zotero.Notes.open(note.id, null, { openInWindow: true });
    const window = await until(() => {
      for (const candidate of Services.wm.getEnumerator("zotero:note")) {
        if (candidate.document.getElementById("zotero-note-editor")?.item?.id === note.id) return candidate;
      }
      return null;
    }, "Cold reopen did not open the existing native note: " + note.key);
    check(true, "Cold reopen opens the existing native note editor", { key: note.key });
    window.close();
    await until(() => window.closed, "Cold reopen note window did not close");
    await Zotero.DB.waitForTransaction();
    Zotero.getMainWindow().focus();
  }

  /** Route the persisted backlink normally; observe, never repair, its reader destination. */
  async function reopenBacklink(entry, translated) {
    check(entry.targetBacklink.startsWith("zotero://open-pdf/"), "Cold reopen uses the actual saved PDF backlink");
    const main = Zotero.getMainWindow();
    main.ZoteroPane.loadURI(entry.targetBacklink);
    // loadURI returns void; native routing and reader initialization finish asynchronously.
    const reader = await until(() => {
      const tab = Zotero.Reader.getByTabID(main.Zotero_Tabs.selectedID);
      if (tab?.itemID === translated.id && tab._internalReader) return tab;
      for (const window of Services.wm.getEnumerator("zotero:reader")) {
        if (window.reader?.itemID === translated.id && window.reader._internalReader) return window.reader;
      }
      return null;
    }, "Persisted backlink did not open the translated native reader");
    const viewer = await until(() => reader._internalReader._primaryView?._iframeWindow
      ?.PDFViewerApplication?.pdfViewer, "Backlink reader PDF.js did not initialize");
    await until(() => viewer.currentPageNumber === entry.pageIndex + 1
      && (!entry.annotationKey || reader._internalReader._state.selectedAnnotationIDs.includes(entry.annotationKey)),
    "Persisted backlink did not reach the actual translated page/annotation");
    await rendered(viewer, entry.pageIndex);
    await settle(viewer);
    check(viewer.currentPageNumber === entry.pageIndex + 1
      && (!entry.annotationKey || reader._internalReader._state.selectedAnnotationIDs.includes(entry.annotationKey)),
    "Cold reopen observes the persisted backlink page/annotation", {
      noteKey: entry.key, attachmentKey: translated.key, href: entry.targetBacklink,
      page: viewer.currentPageNumber, annotationKey: entry.annotationKey,
      selectedAnnotationIDs: [...reader._internalReader._state.selectedAnnotationIDs] });
  }

  /** Verify a new process against create evidence without running controllers or saving notes. */
  async function coldReopen(profile) {
    report.stage = "notes-cold-reopen";
    const saved = JSON.parse(await IOUtils.readUTF8(statePath));
    check(saved.version === stateVersion && saved.phase === "create" && saved.noteRecords?.length === 2,
      "Cold reopen reads the completed create checkpoint");
    check(Number.isInteger(saved.processID) && saved.processID > 0
      && Number.isInteger(report.processID) && report.processID > 0 && saved.processID !== report.processID,
    "Cold reopen is a genuinely new native process", { before: saved.processID, after: report.processID });
    check(samePath(saved.profile, profile) && samePath(saved.dataDirectory, Zotero.DataDirectory.dir),
      "Cold reopen uses the same saved native profile/data");
    await Zotero.Libraries.get(saved.parent.libraryID).waitForDataLoad("item");
    const parent = await savedItem(saved.parent, "paper");
    check(parent.getField("title") === saved.parent.title && Zotero.URI.getItemURI(parent) === saved.parent.uri,
      "Cold reopen preserves the associated parent paper");
    const source = await savedItem(saved.source, "attachment");
    const translated = await savedItem(saved.translated, "attachment");
    const split = { source, translated };
    /** Compare ownership, bytes, annotations and note count before and after native opening. */
    async function unchanged(stage) {
      check(JSON.stringify(await attachmentSnapshot(source)) === JSON.stringify(saved.source)
        && JSON.stringify(await attachmentSnapshot(translated)) === JSON.stringify(saved.translated),
      stage + ": native attachments, paper ownership and PDF bytes are unchanged");
      check(await noteAnnotations(split) === saved.annotationSnapshot, stage + ": native annotations are unchanged");
      check(JSON.stringify(await childNoteKeys(parent)) === JSON.stringify(saved.childNoteKeys),
        stage + ": no native child note was created or removed");
    }
    await unchanged("Before opening");
    report.noteRecords = [];
    for (const entry of saved.noteRecords) {
      report.stage = "notes-cold-reopen:" + entry.key;
      const note = await savedItem(entry, "note");
      check(note.parentID === parent.id && note.parentID === entry.parentID
        && note.libraryID === translated.libraryID && entry.parentKey === parent.key,
      "Cold reopen preserves native note parent/library", { noteKey: note.key, parentKey: parent.key });
      await note.reload(["note"], true);
      check(note.getNote() === entry.noteHTML, "Cold reopen preserves exact persisted note HTML", { noteKey: note.key });
      const actual = noteContent(note, split, entry.pageIndex, entry.text, entry.annotationKey);
      check(JSON.stringify(actual) === JSON.stringify(entry), "Cold reopen preserves note text, citations, pages and backlinks");
      report.noteRecords.push(actual);
      await reopenNote(note);
      await reopenBacklink(entry, translated);
      await note.reload(["note"], true);
      check(note.getNote() === entry.noteHTML, "Normal native opening leaves persisted note HTML unchanged", { noteKey: note.key });
    }
    await unchanged("After opening");
    report.coldProcessReopen = true;
  }

  /** Exercise both real note actions without saving PDFs, translating text, or copying annotations. */
  async function nativeNotes(split, parent, fragment) {
    setSync(split, false);
    split.apps[1].pdfViewer.currentScaleValue = 1;
    const pageIndex = fragment.unit.target.page;
    split.apps[1].pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: pageIndex + 1 }, split.frames[1]));
    await rendered(split.apps[1].pdfViewer, pageIndex);
    const paths = await Promise.all([split.source.getFilePathAsync(), split.translated.getFilePathAsync()]);
    const pdfBytes = await Promise.all(paths.map(path => IOUtils.read(path)));
    const beforeSelection = await noteAnnotations(split);
    const selection = await selectNoteText(split, pageIndex, "pointer");
    const selectedNote = await clickNote(split, split.alignment.selectionNoteButton, parent, "Actual selection→note");
    const selectedRecord = noteContent(selectedNote, split, pageIndex, selection.actualText);
    check(beforeSelection === await noteAnnotations(split), "Selection note creates no native annotation and changes no existing annotation");
    const previousKeys = new Set(split.translated.getAnnotations().map(annotation => annotation.key));
    const highlight = await selectNoteText(split, pageIndex, "highlight");
    const annotation = await until(() => split.translated.getAnnotations().find(item =>
      !previousKeys.has(item.key) && item.annotationType === "highlight"), "Trusted native highlight was not persisted");
    await split.annotations.pending;
    check(annotation.annotationText.trim() === highlight.spanText.trim(), "Summary fixture is an actual native translated highlight");
    await noteTool(split, "pointer");
    const beforeSummary = await noteAnnotations(split);
    const summary = await clickNote(split, split.alignment.annotationsNoteButton, parent, "Native annotation→note");
    const summaryRecord = noteContent(summary, split, pageIndex, annotation.annotationText, annotation.key);
    check(beforeSummary === await noteAnnotations(split), "Summary note does not mutate, reparent or duplicate any native annotation");
    const afterBytes = await Promise.all(paths.map(path => IOUtils.read(path)));
    check(pdfBytes.every((bytes, index) => bytes.length === afterBytes[index].length
      && bytes.every((byte, offset) => byte === afterBytes[index][offset])), "Both note actions leave source and translated PDF bytes unchanged");
    report.noteRecords = [selectedRecord, summaryRecord];
  }

  /** Create a separate hash-changed PDF copy; original fixtures and reader attachments remain untouched. */
  async function changedCopy(input, name) {
    const original = await IOUtils.read(input);
    const suffix = "\n% PaperBridge isolated alignment hash-change probe\n";
    const bytes = new Uint8Array(original.length + suffix.length);
    bytes.set(original);
    for (let index = 0; index < suffix.length; index++) bytes[original.length + index] = suffix.charCodeAt(index);
    const output = PathUtils.join(temporaryDir, name);
    await IOUtils.write(output, bytes);
    return output;
  }

  try {
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    isolated = (config == null || config.isolated === true) && samePath(profile, expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, expectedDataDirectory);
    check(isolated,
    "Harness is running only in the disposable alignment profile/data", {
      profile, data: Zotero.DataDirectory.dir, expectedProfileDirectory, expectedDataDirectory });
    check(phase === "create" || phase === "reopen", "Harness phase is create or reopen", { phase });
    if (phase === "reopen") {
      await coldReopen(profile);
      report.ok = true;
      return;
    }
    bridge = Zotero.PaperBridge;
    if (!bridge) throw new Error("PaperBridge is unavailable");
    originalRequest = bridge.request;
    // Forbid job submission/retry before readiness; all other requests reach the actual backend.
    bridge.request = async function request(path, method, data) {
      if ((method || "GET").toUpperCase() === "POST" && /^\/jobs(?:[/?]|$)/.test(path)) {
        report.jobsPostAttempts++;
        throw new Error("Alignment isolation forbids POST " + path);
      }
      const response = await originalRequest.call(bridge, path, method, data);
      if (path === "/alignment/validate") validationCalls++;
      return response;
    };
    await bridge.ready;
    report.health = await bridge.request("/health");
    check(report.health.engine === "BabelDOC 0.6.4", "Real bundled backend reports the pinned engine", { engine: report.health.engine });
    const jobsBefore = await bridge.request("/jobs");
    const initialJobs = Array.isArray(jobsBefore) ? jobsBefore : jobsBefore.jobs;
    check(Array.isArray(initialJobs) && initialJobs.length === 0 && bridge.splits.size === 0,
      "Disposable backend starts with no jobs or paired readers");
    for (const file of [sourceFixture, outputFixture, mappingPath]) {
      if (!await IOUtils.exists(file)) throw new Error("Parent fixture is missing: " + file);
    }
    const initialSidecar = await IOUtils.read(mappingPath);
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "PaperBridge isolated translated-fragment alignment prototype");
    await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({ file: sourceFixture, parentItemID: parent.id });
    const target = await Zotero.Attachments.importFromFile({ file: outputFixture, parentItemID: parent.id });
    const sourcePath = await source.getFilePathAsync();
    const outputPath = await target.getFilePathAsync();
    check(parent.getAttachments().length === 2 && !samePath(sourcePath, sourceFixture) && !samePath(outputPath, outputFixture),
      "One real article owns two imported PDF copies", { parentID: parent.id, sourceID: source.id, targetID: target.id });
    /** Validate through the actual backend, optionally substituting only disposable probe paths. */
    function validate(paths = {}) {
      return bridge.request("/alignment/validate", "POST", {
        mapping_path: mappingPath, source_path: sourcePath, output_path: outputPath, ...paths,
      });
    }
    const validated = await validate();
    check(validated.available === true && validated.mapping?.units?.length > 0,
      "Actual endpoint accepts captured same-unit mapping against imported PDF bytes", {
        reason: validated.reason, verifiedUnits: validated.mapping?.units?.length,
      });
    const fragment = selectFragment(validated.mapping);
    const reverseFragment = selectFragment(validated.mapping, "source");
    report.fragment = fragment;
    report.sourceFragment = reverseFragment;
    record = await bridge.library.put(source, null, bridge.configuration(),
      { state: "done", output_path: outputPath, quality: { status: "unknown" } }, await IOUtils.stat(sourcePath));
    await bridge.library.attach(record, target);
    await bridge.library.update(record, { alignment_path: mappingPath });
    await bridge.library.settled();
    check(record.sourceKey === source.key && record.ownerKey === parent.key
      && record.attachmentKey === target.key && record.alignmentPath === mappingPath && !record.jobID,
    "Real source ownership row links its translated attachment and recorded sidecar without a job");

    let observers = await openMapped(source, target);
    setSync(state, false);
    check(!state.sync, "Actual split button enables independent reading");
    for (const zoom of [1, 1.5, 2]) {
      setSync(state, false);
      state.apps[0].pdfViewer.currentScaleValue = zoom === 1.5 ? 1 : zoom;
      navigate(state, 0, fragment.unit.source);
      await rendered(state.apps[0].pdfViewer, fragment.unit.source.page);
      // Let each native geometry rebuild finish before changing the other pane.
      state.apps[1].pdfViewer.currentScaleValue = zoom;
      navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
      await rendered(state.apps[1].pdfViewer, fragment.unit.target.page);
      if (zoom === 2) {
        await until(() => Date.now() >= (state.alignmentNavigationUntil || 0), "Previous navigation guard did not elapse");
        state.active = 1;
        setSync(state, true);
        await settle(state.apps[0].pdfViewer);
        // Exercise sync suppression even when source view events would normally drive the other pane.
        state.active = 0;
        check(state.sync, "Actual split button restores page sync for the 200% localization check");
      }
      check(Math.abs(state.apps[1].pdfViewer.currentScale - zoom) < 0.01
        && Math.abs(state.apps[0].pdfViewer.currentScale - (zoom === 1.5 ? 1 : zoom)) < 0.01,
      "Actual viewports render the requested " + zoom * 100 + "% case", {
        sourceScale: state.apps[0].pdfViewer.currentScale, targetScale: state.apps[1].pdfViewer.currentScale,
      });
      await localize(state, fragment, observers.sourceCalls, observers.targetCalls,
        "target→source " + zoom * 100 + "% " + (state.sync ? "sync" : "independent"), zoom === 1);
      setSync(state, false);
      navigate(state, 0, { page: reverseFragment.unit.source.page, rects: [reverseFragment.rect] });
      await rendered(state.apps[0].pdfViewer, reverseFragment.unit.source.page);
      if (zoom === 2) {
        await until(() => Date.now() >= (state.alignmentNavigationUntil || 0), "Previous navigation guard did not elapse");
        state.active = 0;
        setSync(state, true);
      }
      await localize(state, reverseFragment, observers.sourceCalls, observers.targetCalls,
        "source→target " + zoom * 100 + "% " + (state.sync ? "sync" : "independent"), zoom === 1, 0);
    }
    for (const [index, side] of ["source", "target"].entries()) {
      const viewer = state.apps[index].pdfViewer;
      const canMove = viewer.pagesCount > 1 || viewer.container.scrollHeight > viewer.container.clientHeight + 2
        || viewer.container.scrollWidth > viewer.container.clientWidth + 2;
      check(!canMove || report.navigationBySide[side],
        side + " navigation physically changes position when the document permits movement", {
          canMove, physicalNavigationObserved: report.navigationBySide[side],
        });
    }

    setSync(state, false);
    const leftFlex = state.reader._iframe.style.flex;
    const rightFlex = state.browser.style.flex;
    const widthBefore = state.reader._iframe.getBoundingClientRect().width;
    // Exercise the real divider with trusted native input, not an alternate layout implementation.
    const chromeWindow = state.divider.ownerDocument.defaultView;
    const dividerBox = state.divider.getBoundingClientRect();
    const containerBox = state.container.getBoundingClientRect();
    const mouseY = dividerBox.top + dividerBox.height / 2;
    const mouseX = dividerBox.left + dividerBox.width / 2;
    const targetX = containerBox.left + containerBox.width * 0.35;
    chromeWindow.windowUtils.sendMouseEvent("mousedown", mouseX, mouseY, 0, 1, 0);
    chromeWindow.windowUtils.sendMouseEvent("mousemove", targetX, mouseY, 0, 0, 0);
    chromeWindow.windowUtils.sendMouseEvent("mouseup", targetX, mouseY, 0, 1, 0);
    await settle(state.apps[1].pdfViewer);
    const widthAfter = state.reader._iframe.getBoundingClientRect().width;
    check(widthBefore > 0 && widthAfter > 0 && Math.abs(widthAfter - widthBefore) > 2,
      "Real split pane layout resizes", { widthBefore, widthAfter,
        parentDisplay: state.reader._iframe.ownerDocument.defaultView.getComputedStyle(state.container).display,
        sourceFlex: state.reader._iframe.style.getPropertyValue("flex"), targetFlex: state.browser.style.getPropertyValue("flex"),
        sourceComputedFlex: state.reader._iframe.ownerDocument.defaultView.getComputedStyle(state.reader._iframe).flex,
        sourceParentIsContainer: state.reader._iframe.parentElement === state.container });
    await localize(state, fragment, observers.sourceCalls, observers.targetCalls, "resized independent panes");
    await nativeNotes(state, parent, fragment);
    navigate(state, 0, { page: reverseFragment.unit.source.page, rects: [reverseFragment.rect] });
    await rendered(state.apps[0].pdfViewer, reverseFragment.unit.source.page);
    await localize(state, reverseFragment, observers.sourceCalls, observers.targetCalls, "resized source→target", false, 0);
    state.reader._iframe.style.setProperty("flex", leftFlex, "important");
    state.browser.style.setProperty("flex", rightFlex, "important");
    const sourceRotation = state.apps[0].pdfViewer.pagesRotation;
    const targetRotation = state.apps[1].pdfViewer.pagesRotation;
    state.apps[0].pdfViewer.pagesRotation = 270;
    navigate(state, 0, fragment.unit.source);
    await rendered(state.apps[0].pdfViewer, fragment.unit.source.page);
    state.apps[1].pdfViewer.pagesRotation = 90;
    navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
    await rendered(state.apps[1].pdfViewer, fragment.unit.target.page);
    check(state.apps[0].pdfViewer.pagesRotation === 270 && state.apps[1].pdfViewer.pagesRotation === 90,
      "Real readers support independent source/target display rotations");
    await localize(state, fragment, observers.sourceCalls, observers.targetCalls, "independently rotated readers");
    navigate(state, 0, { page: reverseFragment.unit.source.page, rects: [reverseFragment.rect] });
    await rendered(state.apps[0].pdfViewer, reverseFragment.unit.source.page);
    await localize(state, reverseFragment, observers.sourceCalls, observers.targetCalls, "rotated source→target", false, 0);
    state.apps[0].pdfViewer.pagesRotation = sourceRotation;
    await rendered(state.apps[0].pdfViewer, state.apps[0].pdfViewer.currentPageNumber - 1);
    state.apps[1].pdfViewer.pagesRotation = targetRotation;
    await rendered(state.apps[1].pdfViewer, state.apps[1].pdfViewer.currentPageNumber - 1);
    const oldAlignment = closeSplit();
    observers = await openMapped(source, target);
    check(state.alignment !== oldAlignment && oldAlignment.disposed, "Reopen creates a fresh validated controller");
    check(report.noteRecords.every(record => {
      const note = Zotero.Items.getByLibraryAndKey(record.libraryID, record.key);
      return note?.isNote() && note.parentID === parent.id && note.getNote().includes("data-citation-items")
        && parent.getNotes().includes(note.id);
    }), "Both independent native notes survive actual split closure/reopen (not a process restart)");
    const beforeOldClick = observers.sourceCalls.length;
    const destroyedFrame = Components.utils.isDeadWrapper(oldAlignment.button);
    if (!destroyedFrame) oldAlignment.button.click();
    check(observers.sourceCalls.length === beforeOldClick && oldAlignment.disposed,
      "Detached old control cannot navigate a reopened reader", { destroyedFrame });
    setSync(state, false);
    navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
    await localize(state, fragment, observers.sourceCalls, observers.targetCalls, "reopened reader");
    navigate(state, 0, { page: reverseFragment.unit.source.page, rects: [reverseFragment.rect] });
    await rendered(state.apps[0].pdfViewer, reverseFragment.unit.source.page);
    await localize(state, reverseFragment, observers.sourceCalls, observers.targetCalls, "reopened source→target", false, 0);
    closeSplit();

    await bridge.library.update(record, { alignment_path: null });
    const fallback = await bridge.loadAlignment({ source, translated: target });
    await bridge.split(source, target);
    state = [...bridge.splits.values()].find(split => split.reader.itemID === source.id);
    await until(() => state?.alignment?.status.textContent === fallback.reason, "Old/no-map status did not resolve");
    setSync(state, false);
    await state.reader.navigate({ pageIndex: fragment.unit.source.page });
    navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
    await rendered(state.apps[0].pdfViewer, fragment.unit.source.page);
    await rendered(state.apps[1].pdfViewer, fragment.unit.target.page);
    check(fallback.mapping === null && !state.alignment.mapping && state.alignment.button.disabled && state.alignment.targetButton.disabled
      && state.alignment.status.getBoundingClientRect().height > 0
      && state.apps[0].pdfViewer.currentPageNumber === fragment.unit.source.page + 1
      && state.apps[1].pdfViewer.currentPageNumber === fragment.unit.target.page + 1,
    "Old/no-map attachment shows visible nonfatal status while both real PDFs remain navigable", { reason: fallback.reason });
    closeSplit();
    await bridge.library.update(record, { alignment_path: mappingPath });

    await openMapped(source, target);
    setSync(state, false);
    await settle(state.apps[0].pdfViewer);
    await settle(state.apps[1].pdfViewer);
    temporaryDir = PathUtils.join(root, ".runtime", "alignment-probes-" + Date.now());
    await IOUtils.makeDirectory(temporaryDir);
    for (const side of ["source", "output"]) {
      const copy = await changedCopy(side === "source" ? sourceFixture : outputFixture, side + "-changed.pdf");
      const before = state.apps.map(app => position(app.pdfViewer));
      const failure = await validate(side === "source" ? { source_path: copy } : { output_path: copy });
      check(failure.available === false && !failure.mapping && failure.reason === side + "_hash_changed",
        side + " hash change is rejected by the real API using an isolated changed copy", { reason: failure.reason });
      // Apply the actual unavailable result through the public module API, not a simulated validator.
      state.alignment.setMapping(null, failure.reason);
      check(state.alignment.button.disabled && state.alignment.targetButton.disabled && !state.alignment.mapping
        && state.alignment.status.textContent === failure.reason
        && JSON.stringify(before) === JSON.stringify(state.apps.map(app => position(app.pdfViewer))),
      side + " hash failure disables only mapping without changing either current reader", { mode: "changed-copy API result applied to controller" });
      const restored = await validate();
      check(restored.available === true, "Unchanged reader PDFs still validate after " + side + " probe");
      state.alignment.setMapping(restored.mapping);
    }
    const originalFixtures = await validate({ source_path: sourceFixture, output_path: outputFixture });
    const finalSidecar = await IOUtils.read(mappingPath);
    check(originalFixtures.available === true
      && originalFixtures.mapping.source_sha256 === validated.mapping.source_sha256
      && originalFixtures.mapping.output_sha256 === validated.mapping.output_sha256
      && finalSidecar.length === initialSidecar.length && finalSidecar.every((byte, index) => byte === initialSidecar[index]),
    "Original fixture PDFs and sidecar remain untouched");
    closeSplit();
    const jobsAfter = await bridge.request("/jobs");
    const finalJobs = Array.isArray(jobsAfter) ? jobsAfter : jobsAfter.jobs;
    check(report.jobsPostAttempts === 0 && Array.isArray(finalJobs) && finalJobs.length === 0,
      "No translation job submissions, retries or provider calls occurred", { jobsBefore: initialJobs.length, jobsAfter: finalJobs?.length,
        blockedPostAttempts: report.jobsPostAttempts, providerCalls: report.providerCalls });
    await saveNoteState(parent, source, target, profile);
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || "" });
    Zotero.logError(error);
  } finally {
    if (!isolated) return;
    // Finish isolated cleanup before restoring the request guard or writing final evidence.
    try {
      if (state && bridge?.splits.has(state.reader.tabID)) closeSplit();
      if (record) await bridge.library.update(record, { alignment_path: mappingPath });
      if (bridge) await bridge.library.settled();
      if (temporaryDir) await IOUtils.remove(temporaryDir, { recursive: true });
    } catch (error) {
      report.ok = false;
      report.errors.push({ message: "Cleanup: " + String(error), stack: error.stack || "" });
      Zotero.logError(error);
    }
    report.validationCalls = validationCalls;
    if (report.errors.length || report.jobsPostAttempts) report.ok = false;
    if (originalRequest) bridge.request = originalRequest;
    try {
      await IOUtils.writeUTF8(reportPath, JSON.stringify(report, null, 2));
    } finally {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
