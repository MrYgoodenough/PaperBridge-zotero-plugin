/** Exercise real packaged readers and local alignment validation in a disposable Zotero profile. */
/* global Zotero, Services, IOUtils, PathUtils, Ci, Components, PAPERBRIDGE_TEST_ROOT */
(async () => {
  // The alignment suite owns these paths; never import into the daily library.
  const root = PAPERBRIDGE_TEST_ROOT;
  const fixtureDir = PathUtils.join(root, ".runtime", "alignment-fixture");
  const sourceFixture = PathUtils.join(fixtureDir, "source.pdf");
  const outputFixture = PathUtils.join(fixtureDir, "translated.pdf");
  const mappingPath = PathUtils.join(fixtureDir, "alignment.json");
  const reportPath = PathUtils.join(root, ".runtime", "alignment-test.json");
  // UI waits are bounded generously; highlight lifetime remains the module's responsibility.
  const waitMilliseconds = 45000;
  const pollMilliseconds = 100;
  // PDF.js exposes RenderingStates.FINISHED as 3.
  const renderingFinished = 3;
  const report = { ok: false, prototype: true, providerCalls: 0, jobsPostAttempts: 0,
    zoteroVersion: Zotero.version, fixtureModelResponses: "simulated", physicalNavigationObserved: false,
    mappingGeneration: "parent_fixture_only", checks: [], errors: [] };
  let bridge, originalRequest, state, record, temporaryDir;
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

  /** Preposition away from the source fragment, restoring sync before testing the actual action. */
  async function moveSourceAway(split, source) {
    const viewer = split.apps[0].pdfViewer;
    const savedSync = split.sync;
    // Setup must not move the translated target through page sync; the tested action is not exempted.
    split.sync = false;
    try {
      if (viewer.pagesCount > 1) {
        const otherPage = (source.page + 1) % viewer.pagesCount;
        await split.reader.navigate({ pageIndex: otherPage });
        await rendered(viewer, otherPage);
      } else {
        const page = await rendered(viewer, source.page);
        const bounds = page.viewport.viewBox;
        const anchor = source.rects[0];
        // Use the farther PDF corner when there is no other page to navigate to.
        const x = Math.abs(anchor[0] - bounds[0]) > Math.abs(anchor[0] - bounds[2]) ? bounds[0] : bounds[2];
        const y = Math.abs(anchor[3] - bounds[1]) > Math.abs(anchor[3] - bounds[3]) ? bounds[1] : bounds[3];
        const destination = { pageNumber: source.page + 1,
          destArray: [null, { name: "XYZ" }, x, y, null], allowNegativeOffset: true };
        viewer.scrollPageIntoView(Components.utils.cloneInto(destination, split.frames[0]));
      }
      await settle(viewer);
    } finally {
      split.sync = savedSync;
    }
  }

  /** Select an actually unique midpoint; do not guess when fixture target rectangles overlap. */
  function selectFragment(mapping) {
    for (const unit of mapping.units) {
      for (const rect of unit.target.rects) {
        const point = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
        let hits = 0;
        for (const candidate of mapping.units) {
          if (candidate.target.page !== unit.target.page) continue;
          for (const box of candidate.target.rects) {
            if (point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3]) hits++;
          }
        }
        if (unit.status === "verified" && hits === 1) return { unit, rect, point };
      }
    }
    throw new Error("Fixture has no uniquely hittable verified target rectangle");
  }

  /** Send trusted mouse input; observe native pointer delivery without cancelling defaults. */
  async function release(split, fragment) {
    const frame = split.frames[1];
    const doc = frame.document;
    const page = split.apps[1].pdfViewer.getPageView(fragment.unit.target.page);
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
      const point = split.alignment.point;
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
      let utilities;
      try { utilities = nativeFrame.windowUtils; }
      catch (error) { evidence.windowUtilsError = String(error); }
      utilities ||= nativeFrame.docShell?.domWindowUtils;
      if (!utilities) throw new Error("Trusted mouse input API is unavailable");
      if (typeof utilities.sendMouseEvent !== "function") throw new Error("Trusted mouse input API is unavailable");

      /** Observe one delivery attempt, retaining event objects until bubbling has finished. */
      async function attempt(mouseDown) {
        const events = [];
        const result = { mouseDown, events: [], immediatePoint: null, statusImmediate: "" };
        // Diagnostic listeners accept untrusted events too, but never alter production listeners.
        const options = { capture: true, passive: true, once: true };
        /** Record native events without preventing defaults or stopping propagation. */
        function observe(event) { events.push(event); }
        const types = ["pointerdown", "mousedown", "pointerup", "mouseup"];
        for (const type of types) doc.addEventListener(type, observe, options, true);
        try {
          // Primary button, one click, no modifiers; start with mouseup alone to avoid selection changes.
          if (mouseDown) utilities.sendMouseEvent("mousedown", coordinates.x, coordinates.y, 0, 1, 0);
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

      let delivered = await attempt(false);
      // Retry a normal down/up pair only when mouseup did not produce a trusted pointerup.
      if (!delivered.error && !delivered.events.some(event => event.type === "pointerup" && event.isTrusted)) {
        delivered = await attempt(true);
      }
      evidence.allowed = !delivered.error && delivered.events.some(event => event.type === "pointerup"
        && event.isTrusted && event.pageNumber === fragment.unit.target.page + 1);
      evidence.prevented = evidence.attempts.some(result => result.events.some(event => event.defaultPrevented));
    } catch (error) {
      evidence.error = String(error);
    }
    evidence.pointAfterRelease = pointSnapshot();
    evidence.statusAfterRelease = split.alignment.status.textContent;
    return evidence;
  }

  /** Check DOM rectangle geometry against the source viewport with tolerant CSS comparisons. */
  function highlightMatches(split, source, overlay) {
    const page = split.apps[0].pdfViewer.getPageView(source.page);
    if (overlay.parentElement !== page.div || overlay.children.length !== source.rects.length) return false;
    for (let index = 0; index < source.rects.length; index++) {
      // Clone into the source viewport's own content compartment.
      const box = page.viewport.convertToViewportRectangle(
        Components.utils.cloneInto(source.rects[index], split.frames[0]));
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
  async function localize(split, fragment, sourceCalls, targetCalls, label, expires = false) {
    await rendered(split.apps[1].pdfViewer, fragment.unit.target.page);
    await moveSourceAway(split, fragment.unit.source);
    await settle(split.apps[0].pdfViewer);
    await settle(split.apps[1].pdfViewer);
    const before = position(split.apps[0].pdfViewer);
    const sourceCount = sourceCalls.length;
    const targetCount = targetCalls.length;
    const event = await release(split, fragment);
    await Zotero.Promise.delay(200);
    const point = split.alignment.point;
    check(event.allowed && !event.prevented && sourceCalls.length === sourceCount
      && split.apps[0].pdfViewer.currentPageNumber === before.page
      && point?.page === fragment.unit.target.page
      && point.point.every((value, axis) => Number.isFinite(value)
        && value >= fragment.rect[axis] && value <= fragment.rect[axis + 2]),
    label + ": pointerup remembers a unique PDF point without navigation or cancellation", {
      before, expectedRect: fragment.rect, rememberedPoint: point,
      status: split.alignment.status.textContent, event,
    });
    split.alignment.button.click();
    const overlay = await until(() => split.alignment.highlight?.isConnected && split.alignment.highlight,
      () => label + ": source highlight absent; status=" + split.alignment.status.textContent);
    const destination = sourceCalls[sourceCount];
    const after = position(split.apps[0].pdfViewer);
    const moved = before.page !== after.page || Math.abs(before.scrollTop - after.scrollTop) > 2
      || Math.abs(before.scrollLeft - after.scrollLeft) > 2;
    report.physicalNavigationObserved ||= moved;
    check(sourceCalls.length === sourceCount + 1 && destination?.pageNumber === fragment.unit.source.page + 1
      && destination.destArray?.[1]?.name === "XYZ" && destination.destArray[2] === fragment.unit.source.rects[0][0]
      && destination.destArray[3] === fragment.unit.source.rects[0][3]
      && split.apps[0].pdfViewer.currentPageNumber === fragment.unit.source.page + 1
      && split.alignmentNavigationUntil > Date.now()
      && highlightMatches(split, fragment.unit.source, overlay),
    label + ": explicit action uses real source navigation and its own viewport highlight", {
      destination, sourceScale: split.apps[0].pdfViewer.currentScale,
      targetScale: split.apps[1].pdfViewer.currentScale, rects: overlay.children.length, before, after, physicalMovement: moved,
    });
    await Zotero.Promise.delay(200);
    check(targetCalls.length === targetCount, label + ": localization does not navigate the translated pane", { sync: split.sync });
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
    await until(() => state.alignment.mapping && !state.alignment.button.disabled,
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
      && alignment.point === null && alignment.mapping === null
      && split.reader._iframe.getAttribute("flex") === split.leftFlex,
    "Close disposes control, pending point, highlight, timer and translated browser");
    state = null;
    return alignment;
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
    check(samePath(profile, PathUtils.join(root, ".runtime", "alignment-profile"))
      && samePath(Zotero.DataDirectory.dir, PathUtils.join(root, ".runtime", "alignment-data")),
    "Harness is running only in the disposable alignment profile/data", { profile, data: Zotero.DataDirectory.dir });
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
    report.fragment = fragment;
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
      state.apps[1].pdfViewer.currentScaleValue = zoom;
      navigate(state, 0, fragment.unit.source);
      navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
      await rendered(state.apps[0].pdfViewer, fragment.unit.source.page);
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
        zoom * 100 + "% " + (state.sync ? "sync" : "independent"), zoom === 1);
    }
    const originalViewer = state.apps[0].pdfViewer;
    const canMove = originalViewer.pagesCount > 1 || originalViewer.container.scrollHeight > originalViewer.container.clientHeight + 2
      || originalViewer.container.scrollWidth > originalViewer.container.clientWidth + 2;
    check(!canMove || report.physicalNavigationObserved,
      "Original navigation physically changes position when the document permits movement", {
        canMove, physicalNavigationObserved: report.physicalNavigationObserved,
      });

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
    state.reader._iframe.style.setProperty("flex", leftFlex, "important");
    state.browser.style.setProperty("flex", rightFlex, "important");
    const sourceRotation = state.apps[0].pdfViewer.pagesRotation;
    const targetRotation = state.apps[1].pdfViewer.pagesRotation;
    state.apps[0].pdfViewer.pagesRotation = 270;
    state.apps[1].pdfViewer.pagesRotation = 90;
    navigate(state, 0, fragment.unit.source);
    navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
    await rendered(state.apps[0].pdfViewer, fragment.unit.source.page);
    await rendered(state.apps[1].pdfViewer, fragment.unit.target.page);
    check(state.apps[0].pdfViewer.pagesRotation === 270 && state.apps[1].pdfViewer.pagesRotation === 90,
      "Real readers support independent source/target display rotations");
    await localize(state, fragment, observers.sourceCalls, observers.targetCalls, "independently rotated readers");
    state.apps[0].pdfViewer.pagesRotation = sourceRotation;
    state.apps[1].pdfViewer.pagesRotation = targetRotation;
    const oldAlignment = closeSplit();
    observers = await openMapped(source, target);
    check(state.alignment !== oldAlignment && oldAlignment.disposed, "Reopen creates a fresh validated controller");
    const beforeOldClick = observers.sourceCalls.length;
    const destroyedFrame = Components.utils.isDeadWrapper(oldAlignment.button);
    if (!destroyedFrame) oldAlignment.button.click();
    check(observers.sourceCalls.length === beforeOldClick && oldAlignment.disposed,
      "Detached old control cannot navigate a reopened reader", { destroyedFrame });
    setSync(state, false);
    navigate(state, 1, { page: fragment.unit.target.page, rects: [fragment.rect] });
    await localize(state, fragment, observers.sourceCalls, observers.targetCalls, "reopened reader");
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
    check(fallback.mapping === null && !state.alignment.mapping && state.alignment.button.disabled
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
      check(state.alignment.button.disabled && !state.alignment.mapping
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
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || "" });
    Zotero.logError(error);
  } finally {
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
