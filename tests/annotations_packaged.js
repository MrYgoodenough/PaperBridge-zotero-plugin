/** Optional native annotation suite, injected only into a disposable Zotero profile/data pair. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, PAPERBRIDGE_ANNOTATIONS_TEST */
(async () => {
  // The caller must supply both isolated directories and synthetic PDF fixture paths.
  const config = PAPERBRIDGE_ANNOTATIONS_TEST;
  // Allow real reader layout, native selection and the upstream save debounce to settle.
  const waitMilliseconds = 60000;
  const pollMilliseconds = 100;
  // PDF.js reports a fully rendered page with RenderingStates.FINISHED = 3.
  const renderingFinished = 3;
  // Enter this through the native editor, then verify the exact persisted comment after restart.
  const noteCommentText = 'Native annotation comment survives reopen and process restart.';
  const report = { ok: false, phase: config.phase, zoteroVersion: Zotero.version,
    nativeUI: true, providerCalls: 0, checks: [], errors: [], inputs: [] };
  // Native tab teardown belongs to Zotero; these are only this isolated suite's readers.
  const nativeReaders = new Set();
  let isolated = false, bridge, state, source, translated;

  /** Compare native paths without platform-specific separators or Windows letter case. */
  function samePath(left, right) {
    const normalize = value => Zotero.isWin ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
    return !!left && !!right && normalize(left) === normalize(right);
  }

  /** Record exact evidence rather than treating script completion as a pass. */
  function check(condition, name, details = {}) {
    report.checks.push({ name, pass: !!condition, details });
    if (!condition) throw new Error(name + ": " + JSON.stringify(details));
  }

  /** Wait for the real native state or fail with a bounded diagnostic. */
  async function until(predicate, message) {
    report.waiting = message;
    if (isolated) await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
    const deadline = Date.now() + waitMilliseconds;
    do {
      const value = await predicate();
      if (value) { delete report.waiting; return value; }
      await Zotero.Promise.delay(pollMilliseconds);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Await a real native promise with the same visible readiness deadline as UI predicates. */
  async function ready(promise, message) {
    let completed = false, failure;
    promise.then(() => { completed = true; }, error => { failure = error; completed = true; });
    await until(() => { if (failure) throw failure; return completed; }, message);
  }

  /** Open the actual split and wait for the translated page's text layer. */
  async function open() {
    await ready(bridge.split(source, translated), 'Native split initialization did not finish');
    const reader = Zotero.Reader._readers.find(reader => reader.itemID === source.id);
    nativeReaders.add(reader);
    state = bridge.splits.get(reader.tabID);
    /** Capture real renderer exceptions without suppressing their native handling. */
    const observeError = event => {
      report.rendererErrors ||= [];
      report.rendererErrors.push({ message: event.message || String(event.error), stack: event.error?.stack || '' });
    };
    state.browser.contentWindow.addEventListener('error', observeError);
    state.cleanups.push(() => state.browser.contentWindow.removeEventListener('error', observeError));
    check(!!state.annotations && !state.right._state.readOnly && state.right._state.showAnnotations,
      "Translated reader uses native editable annotations");
    await until(() => {
      const page = state.apps[1].pdfViewer.getPageView(0);
      return page?.renderingState === renderingFinished && page.div.querySelector('.textLayer span');
    }, "Synthetic translated page did not render");
    return state;
  }

  /** Close through the normal split lifecycle and await its native persistence write. */
  async function close() {
    const previous = state;
    bridge.closeSplit(previous.reader.tabID);
    await ready(previous.annotationSave, 'Native annotation close-save did not finish');
    check(!bridge.splits.has(previous.reader.tabID), "Closed split releases its original lifecycle state");
    state = null;
  }

  /** Use Gecko trusted mouse input in the PDF iframe, never replacing reader methods. */
  function mouse(type, x, y) {
    const frame = Components.utils.unwaiveXrays(state.frames[1]);
    const utilities = frame.windowUtils || frame.docShell.domWindowUtils;
    utilities.sendMouseEvent(type, x, y, 0, 1, 0);
  }

  /** Observe native input and selection without changing any reader implementation. */
  function inputSnapshot() {
    const view = state.right._primaryView;
    const doc = state.frames[1].document;
    return { tool: state.right.toolType, focused: doc.hasFocus(), active: doc.activeElement?.localName,
      readerFocused: state.browser.contentWindow.document.hasFocus(), nativeSelection: String(doc.getSelection()),
      ranges: JSON.parse(JSON.stringify(view._selectionRanges || [])),
      action: view.action && { type: view.action.type, triggered: view.action.triggered, mode: view.action.mode },
      pointerDownPosition: view.pointerDownPosition && JSON.parse(JSON.stringify(view.pointerDownPosition)),
      // Native Array.map retains the iframe's realm and becomes a dead object after close.
      annotations: Array.from(state.right._state.annotations, annotation => ({ id: annotation.id, type: annotation.type })),
      saved: translated.getAnnotations().map(item => ({ key: item.key, type: item.annotationType })) };
  }

  /** Activate Zotero's actual native tool through its toolbar's own click handler. */
  async function tool(type) {
    const doc = state.browser.contentWindow.document;
    const button = await until(() => doc.querySelector('.toolbar-button.' + type), "Native tool missing: " + type);
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = button.getBoundingClientRect();
    check(box.width > 0 && box.height > 0 && doc.defaultView.getComputedStyle(button.closest('.tools')).display !== 'none',
      "Native " + type + " toolbar remains visible in a split pane");
    button.click();
    await until(() => state.right.toolType === type, "Native tool did not activate: " + type);
  }

  /** Select real rendered text with trusted drag input and observe the native annotation. */
  async function mark(type, spanIndex) {
    await tool(type);
    const doc = state.frames[1].document;
    const spans = [...doc.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .filter(span => span.textContent.trim().length > 8 && span.getBoundingClientRect().width > 40);
    const span = spans[spanIndex];
    if (!span) throw new Error("Synthetic fixture needs two separate, readable text spans");
    // DOM scrollIntoView can pin a text-layer span at the edge and trigger native auto-scroll.
    state.apps[1].pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: 1 }, state.frames[1]));
    // Keep this fixture's selected line away from the reader's auto-scroll edge zone.
    const edgeMargin = 24;
    await until(() => {
      const bounds = span.getBoundingClientRect();
      return !state.right._primaryView._scrolling && bounds.top > edgeMargin
        && bounds.bottom < state.frames[1].innerHeight - edgeMargin;
    }, 'Native fixture text did not settle inside the visible PDF viewport');
    const box = span.getBoundingClientRect();
    const y = box.top + box.height / 2;
    // Start inside the first glyph; finish past the last to include punctuation at Windows pixel rounding.
    const inset = 0.5;
    const endPadding = 2;
    const endX = box.right + endPadding;
    const steps = 6;
    const before = new Set(state.right._state.annotations.map(annotation => annotation.id));
    const events = [];
    const evidence = { type, text: span.textContent, box: { left: box.left, top: box.top, width: box.width, height: box.height },
      frame: { width: state.frames[1].innerWidth, height: state.frames[1].innerHeight }, snapshots: [], events: [] };
    report.inputs.push(evidence);
    report.stage = 'before-' + type + '-drag';
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
    /** Retain events through bubbling to record final default prevention. */
    function observe(event) { events.push(event); }
    const types = ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup'];
    for (const name of types) doc.addEventListener(name, observe, { capture: true, passive: true });
    try {
      evidence.snapshots.push({ phase: 'before', ...inputSnapshot() });
      mouse('mousedown', box.left + inset, y);
      evidence.snapshots.push({ phase: 'down', ...inputSnapshot() });
      for (let step = 1; step <= steps; step++) {
        mouse('mousemove', box.left + inset + (endX - box.left - inset) * step / steps, y);
        // Zotero throttles text selection moves to 50 ms; let native processing complete.
        await Zotero.Promise.delay(pollMilliseconds);
      }
      evidence.snapshots.push({ phase: 'drag', ...inputSnapshot() });
      check(state.right.toolType === type, "Native " + type + " remains active throughout the real selection");
      mouse('mouseup', endX, y);
      evidence.snapshots.push({ phase: 'up', ...inputSnapshot() });
      report.stage = 'after-' + type + '-drag';
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      const annotation = await until(() => state.right._state.annotations.find(annotation =>
        annotation.type === type && !before.has(annotation.id)), "Native text selection did not create " + type);
      check(annotation.text.trim() === span.textContent.trim() && annotation.position.rects.length > 0,
        "Native " + type + " carries selected PDF text and positions", { text: annotation.text });
      return annotation.id;
    } finally {
      evidence.snapshots.push({ phase: 'settled', ...inputSnapshot() });
      for (const name of types) doc.removeEventListener(name, observe, true);
      evidence.events = events.map(event => ({ type: event.type, trusted: event.isTrusted, buttons: event.buttons,
        button: event.button, detail: event.detail, x: event.clientX, y: event.clientY, prevented: event.defaultPrevented,
        pointerType: event.pointerType, target: event.target.localName, targetClass: event.target.getAttribute?.('class'),
        page: event.target.closest?.('.page')?.dataset.pageNumber }));
    }
  }

  /** Click a blank PDF position with the native note tool, without constructing annotation JSON. */
  async function note() {
    await tool('note');
    const page = state.apps[1].pdfViewer.getPageView(0);
    page.div.scrollIntoView({ block: 'start' });
    await Zotero.Promise.delay(pollMilliseconds);
    const box = page.div.getBoundingClientRect();
    // The fixture reserves its lower-left area for this native note click.
    const point = { x: box.left + box.width / 4, y: box.top + Math.min(box.height / 2, 220) };
    const before = new Set(state.right._state.annotations.map(annotation => annotation.id));
    mouse('mousedown', point.x, point.y);
    mouse('mouseup', point.x, point.y);
    const annotation = await until(() => state.right._state.annotations.find(annotation =>
      annotation.type === 'note' && !before.has(annotation.id)), "Native note click did not create a note");
    check(annotation.position.rects.length > 0, "Native note has a real PDF position");
    return annotation.id;
  }

  /** Enter text through Gecko's trusted input processor into the native note comment editor. */
  async function editNote(key) {
    const frame = state.browser.contentWindow;
    const doc = frame.document;
    const editor = await until(() => [...doc.querySelectorAll('.annotation-popup .comment [contenteditable="true"]')]
      .find(element => element.id === key), 'Native note comment editor did not open');
    const events = [];
    const evidence = { type: 'note-comment', method: 'Gecko TextInputProcessor keydown/keyup', expected: noteCommentText, events };
    report.inputs.push(evidence);
    /** Observe the real input event generated by Gecko, not a constructed DOM input event. */
    function observe(event) { events.push({ type: event.type, trusted: event.isTrusted, value: editor.innerText }); }
    editor.addEventListener('input', observe, { capture: true, passive: true });
    try {
      const nativeFrame = Components.utils.unwaiveXrays(frame);
      const main = Zotero.getMainWindow();
      main.focus();
      // Launching an isolated process does not automatically activate its native window.
      Services.focus.activeWindow = main;
      nativeFrame.focus();
      const box = editor.getBoundingClientRect();
      const utilities = nativeFrame.windowUtils || nativeFrame.docShell.domWindowUtils;
      utilities.sendMouseEvent('mousedown', box.left + box.width / 2, box.top + box.height / 2, 0, 1, 0);
      utilities.sendMouseEvent('mouseup', box.left + box.width / 2, box.top + box.height / 2, 0, 1, 0);
      editor.focus();
      Services.focus.setFocus(editor, Services.focus.FLAG_RAISE);
      evidence.focusState = { documentFocused: doc.hasFocus(), activeID: doc.activeElement?.id,
        activeTag: doc.activeElement?.localName, editorConnected: editor.isConnected };
      await until(() => doc.hasFocus() && doc.activeElement === editor,
        'Native note comment editor did not receive focus after the trusted click');
      evidence.focused = doc.hasFocus() && doc.activeElement === editor;
      check(evidence.focused, 'Native note comment editor receives actual focus');
      const processor = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
      if (!processor.beginInputTransactionForTests(nativeFrame)) throw new Error('Native text input transaction unavailable');
      for (const character of noteCommentText) {
        const event = new nativeFrame.KeyboardEvent('', { key: character });
        processor.keydown(event);
        processor.keyup(event);
      }
      // Capture the native value before any awaited checkpoint so stalled UI callbacks stay diagnosable.
      evidence.readerCommentAfterInput = state.right._state.annotations.find(annotation => annotation.id === key)?.comment;
      evidence.editorTextAfterInput = editor.innerText;
      evidence.editorHTMLAfterInput = editor.innerHTML;
      evidence.rendererTextAfterInput = editor.parentElement.querySelector('.renderer')?.innerText;
      evidence.readOnly = state.right._state.readOnly;
      evidence.adapterFailed = state.annotations.failed;
      evidence.noteKey = key;
      report.stage = 'native-note-comment-input';
      report.nativeDebug = Zotero.Debug.getConsoleViewerOutput().slice(-80);
      await until(() => state.right._state.annotations.find(annotation => annotation.id === key)?.comment === noteCommentText,
        'Native note comment did not reach the reader annotation');
      check(events.some(event => event.type === 'input' && event.trusted),
        'Native note comment is edited through trusted input', { events });
    } finally {
      const annotation = state.right._state.annotations.find(annotation => annotation.id === key);
      evidence.readerComment = annotation?.comment;
      evidence.editorText = editor.innerText;
      evidence.editorConnected = editor.isConnected;
      editor.removeEventListener('input', observe, true);
    }
  }

  /** Resolve only the suite's saved attachment identities after an actual Zotero restart. */
  async function restore() {
    const record = await IOUtils.readJSON(config.statePath);
    source = await Zotero.Items.getByLibraryAndKeyAsync(record.libraryID, record.sourceKey);
    translated = await Zotero.Items.getByLibraryAndKeyAsync(record.libraryID, record.translatedKey);
    check(source?.isPDFAttachment() && translated?.isPDFAttachment(), "Restart finds the same native fixture attachments");
    return record;
  }

  try {
    const profile = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    isolated = config.isolated === true && samePath(profile, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory);
    if (!isolated) throw new Error("Refusing annotation test outside the caller's explicit isolated profile/data pair");
    if (!['create', 'reopen'].includes(config.phase)) throw new Error("Expected phase create or reopen");
    Zotero.Debug.setStore(true);
    bridge = await until(() => Zotero.PaperBridge, "Packaged PaperBridge did not start");
    await ready(bridge.ready, 'Packaged PaperBridge initialization did not finish');
    // uiReady can precede library hydration on a new profile; import only after real native loading.
    await ready(Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item'),
      'Native library item loading did not finish');
    if (config.phase === 'create') {
      source = await Zotero.Attachments.importFromFile({ file: config.sourcePDF, libraryID: Zotero.Libraries.userLibraryID });
      translated = await Zotero.Attachments.importFromFile({ file: config.translatedPDF, libraryID: Zotero.Libraries.userLibraryID });
      const keys = {};
      await open();
      const original = state;
      keys.highlight = await mark('highlight', 0);
      keys.underline = await mark('underline', 1);
      keys.note = await note();
      await editNote(keys.note);
      // Close immediately after the last native edit, deliberately before debounce expiry.
      await close();
      check(translated.getAnnotations().length === 3, "Native UI creations are parented by the translated attachment");
      check(source.getAnnotations().length === 0, "No source annotations or cross-pane copies are created");
      check(Zotero.Items.getByLibraryAndKey(translated.libraryID, keys.note).annotationComment === noteCommentText,
        'Native note comment is persisted on the translated attachment before reopening');
      await open();
      check(state !== original && state.right._state.annotations.length === 3,
        "Close/reopen reloads the native annotation items");
      check(state.right._state.annotations.find(annotation => annotation.id === keys.note)?.comment === noteCommentText,
        'Close/reopen retains the exact native note comment');
      const pair = state;
      await bridge.split(source, translated);
      check(state === pair && bridge.splits.get(pair.reader.tabID) === pair,
        "Repeated open preserves the annotated native reader object");
      state.right.deleteAnnotations(Components.utils.cloneInto([keys.underline], state.browser.contentWindow));
      await close();
      check(translated.getAnnotations().length === 2
        && !Zotero.Items.getByLibraryAndKey(translated.libraryID, keys.underline),
      "Native delete is persisted even when closing before debounce expiry");
      await IOUtils.writeUTF8(config.statePath, JSON.stringify({ libraryID: translated.libraryID,
        sourceKey: source.key, translatedKey: translated.key, keys, noteComment: noteCommentText }, null, 2));
    } else {
      const record = await restore();
      await open();
      const annotations = state.right._state.annotations;
      check(annotations.length === 2 && annotations.some(annotation => annotation.id === record.keys.highlight)
        && annotations.some(annotation => annotation.id === record.keys.note)
        && !annotations.some(annotation => annotation.id === record.keys.underline),
      "Actual process restart retains highlight/note and the native underline deletion");
      check(source.getAnnotations().length === 0, "Source remains unannotated after process restart");
      check(annotations.find(annotation => annotation.id === record.keys.note)?.comment === record.noteComment
        && record.noteComment === noteCommentText, 'Actual process restart retains the exact native note comment');
      await close();
      const native = await Zotero.Reader.open(translated.id);
      nativeReaders.add(native);
      await native._initPromise;
      check(native._internalReader._state.annotations.length === 2,
        "The standalone Zotero reader sees the same persisted native annotation items");
      check(native._internalReader._state.annotations.find(annotation => annotation.id === record.keys.note)?.comment === record.noteComment,
        'Standalone Zotero reader sees the persisted native note comment');
    }
    report.attachmentKeys = { source: source.key, translated: translated.key };
    report.stage = 'complete';
    report.ok = true;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || '' });
    // Avoid get(), whose system-info collection can wait on unrelated native addon startup.
    if (isolated) report.nativeDebug = Zotero.Debug.getConsoleViewerOutput().slice(-80);
    Zotero.logError(error);
  } finally {
    if (isolated) {
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      try {
        if (state) await close();
        await ready(Promise.all(bridge?.annotationWrites.values() || []),
          'Native annotation cleanup writes did not finish');
        for (const native of nativeReaders) native.close();
        await until(() => [...nativeReaders].every(native => !Zotero.Reader._readers.includes(native)),
          'Test-created native reader tabs did not close');
      } catch (error) {
        report.ok = false;
        report.errors.push({ message: "Cleanup: " + String(error) });
      }
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      // Keep only the isolated fixture items for the process-restart phase.
      if (config.quit !== false) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
