/** Exercise paired-reader reuse and PDF coordinates without a native Zotero profile. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
// Each fixture evaluates the real split, loadSplit, and closeSplit implementations.
const moduleSource = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');

/** Pause right-view initialization without real files or timers. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Drain promise continuations before inspecting a pending initialization. */
const nextTurn = () => new Promise(setImmediate);

/** Ignore APIs unrelated to the paired-reader lifecycle. */
function noop() {}

/** Supply only layout attributes, disposal, and automatic browser loading. */
function element() {
  const attributes = {};
  return {
    style: { cssText: '' }, removed: false,
    /** Store attributes and restore inline styles during closeSplit. */
    setAttribute(name, value) {
      attributes[name] = value;
      if (name === 'style') this.style.cssText = value;
    },
    /** Preserve null for absent style and flex attributes. */
    getAttribute(name) { return attributes[name] ?? null; },
    /** Restore an originally absent flex attribute. */
    removeAttribute(name) { delete attributes[name]; },
    append: noop,
    /** Record disposal without maintaining an unrelated DOM tree. */
    remove() { this.removed = true; },
    /** Deliver load asynchronously, after split has stored its state. */
    addEventListener(type, handler) {
      if (type === 'load') queueMicrotask(() => handler({ target: this.contentDocument }));
    },
  };
}

/** Record navigation performed by the real syncPosition. */
function viewer() {
  return {
    pagesCount: 10, currentScaleValue: 'page-width', destinations: [],
    _location: { pageNumber: 4, left: 0, top: 600 },
    /** Apply PDF.js coordinates without rendering. */
    scrollPageIntoView(value) {
      this.destinations.push(value);
      this._location = { pageNumber: value.pageNumber, left: value.destArray[2], top: value.destArray[3] };
    },
  };
}

/** Stub native resources, optionally blocking only the first right view. */
function fixture(firstReady = Promise.resolve()) {
  const calls = { closes: 0, browsers: 0, reads: 0, creates: 0 };
  const left = viewer();
  const source = { id: 1 };
  const translated = { id: 2,
    /** Return a synthetic attachment path; no filesystem read follows. */
    async getFilePathAsync() { return 'translated.pdf'; },
    /** Supply the title used by reader creation. */
    getField() { return 'Translation'; },
  };
  const reader = {
    tabID: 'source-tab', _initPromise: Promise.resolve(), _iframe: element(),
    _internalReader: {
      _state: { primaryViewState: { pageIndex: 3 } },
      _primaryView: { initializedPromise: Promise.resolve(),
        _iframeWindow: { PDFViewerApplication: { pdfViewer: left } } },
    },
  };
  reader._iframe.parentElement = element();
  const win = { document: {
    /** Provide a controlled right reader only for browser elements. */
    createXULElement(tag) {
      const browser = element();
      if (tag !== 'browser') return browser;
      calls.browsers++;
      const right = { destroyed: false, setTitle: noop, _primaryView: {
        initializedPromise: calls.browsers === 1 ? firstReady : Promise.resolve(),
        _iframeWindow: { PDFViewerApplication: { pdfViewer: viewer() } },
        /** Observe the real closeSplit destroying the right view. */
        destroy() { right.destroyed = true; },
      } };
      browser.contentDocument = {};
      browser.contentWindow = { document: browser.contentDocument, addEventListener: noop,
        wrappedJSObject: {
          /** Count reader creation by the real loadSplit. */
          createReader() { calls.creates++; return right; },
        },
      };
      return browser;
    },
  } };
  const context = vm.createContext({
    Zotero: {
      debug: noop, getMainWindow: () => win,
      Reader: { open: async () => reader }, Prefs: { get: () => 13 },
      /** Do not hide unexpected cleanup errors. */
      logError(error) { throw error; },
    },
    Services: { locale: { appLocalesAsBCP47: [] } },
    Components: { utils: { cloneInto: value => value } },
    IOUtils: {
      /** Count synthetic PDF reads without accessing disk. */
      async read() { calls.reads++; return new Uint8Array([1]); },
    },
  });
  vm.runInContext(moduleSource, context);
  const bridge = context.PaperBridge;
  // Spy on actual disposal; only unrelated controls and event wiring are stubbed.
  const closeSplit = bridge.closeSplit;
  /** Detect unwanted close attempts on duplicate commands or stale errors. */
  bridge.closeSplit = function(tabID) {
    calls.closes++;
    return closeSplit.call(this, tabID);
  };
  bridge.splitControls = noop;
  /** Supply PDF apps so real page and zoom synchronization still runs. */
  bridge.bindSync = state => {
    state.frames = [reader._internalReader._primaryView, state.right._primaryView]
      .map(view => view._iframeWindow);
    state.apps = state.frames.map(frame => frame.PDFViewerApplication);
  };
  return { bridge, calls, reader, source, translated, left };
}

test('PDF coordinate mapping and page clamping', () => {
  const { bridge } = fixture();
  const left = { currentScaleValue: 'page-width', _location: { pageNumber: 4, left: 0, top: 600 } };
  let destination;
  const right = { pagesCount: 3,
    /** Capture the original coordinate-mapping result. */
    scrollPageIntoView(value) { destination = value; },
  };
  bridge.syncPosition({ frames: [{}, {}], apps: [{ pdfViewer: left }, { pdfViewer: right }] }, 0);
  assert.equal(right.currentScaleValue, 'page-width');
  assert.equal(destination.pageNumber, 3);
  assert.equal(destination.destArray[3], 600);
  left._location = null;
  destination = null;
  bridge.syncPosition({ apps: [{ pdfViewer: left }, { pdfViewer: right }] }, 0);
  assert.equal(destination, null);
});

test('the same attachment IDs reuse the pair without reloading or resetting position and zoom', async () => {
  const f = fixture();
  await f.bridge.split(f.source, f.translated);
  const state = f.bridge.splits.get(f.reader.tabID);
  const right = state.apps[1].pdfViewer;
  const ready = state.ready;
  f.left.currentScaleValue = '150%';
  right.currentScaleValue = '75%';
  f.left._location = { pageNumber: 6, left: 12, top: 300 };
  right._location = { pageNumber: 8, left: 25, top: 450 };
  state.sync = false;
  // Attachment identity is determined by IDs, not by object reference.
  await f.bridge.split({ ...f.source }, { ...f.translated });
  assert.strictEqual(f.bridge.splits.get(f.reader.tabID), state);
  assert.strictEqual(state.ready, ready);
  assert.deepEqual(f.calls, { closes: 1, browsers: 1, reads: 1, creates: 1 });
  assert.equal(state.browser.removed, false);
  assert.equal(state.right.destroyed, false);
  assert.equal(f.left.currentScaleValue, '150%');
  assert.equal(right.currentScaleValue, '75%');
  assert.deepEqual(f.left._location, { pageNumber: 6, left: 12, top: 300 });
  assert.deepEqual(right._location, { pageNumber: 8, left: 25, top: 450 });
  assert.equal(right.destinations.length, 1);
  assert.equal(state.sync, false);
});

test('duplicate initialization shares ready and waits for the right view', async t => {
  const blocked = deferred();
  const f = fixture(blocked.promise);
  t.after(() => blocked.resolve());
  const first = f.bridge.split(f.source, f.translated);
  await nextTurn();
  const state = f.bridge.splits.get(f.reader.tabID);
  const ready = state.ready;
  assert.equal(typeof ready?.then, 'function');
  const duplicate = f.bridge.split(f.source, f.translated);
  let completed = 0;
  for (const promise of [first, duplicate, ready]) promise.then(() => completed++, noop);
  await nextTurn();
  assert.strictEqual(f.bridge.splits.get(f.reader.tabID), state);
  assert.strictEqual(state.ready, ready);
  assert.deepEqual(f.calls, { closes: 1, browsers: 1, reads: 1, creates: 1 });
  assert.equal(completed, 0, 'both commands and ready remain pending until the right view is initialized');
  blocked.resolve();
  await Promise.all([first, duplicate, ready]);
  assert.equal(completed, 3);
  assert.equal(state.apps[1].pdfViewer.destinations.length, 1);
});

test('a different translation replaces the pair, and closing permits reopening', async () => {
  const f = fixture();
  await f.bridge.split(f.source, f.translated);
  const first = f.bridge.splits.get(f.reader.tabID);
  const translation = { ...f.translated, id: 3 };
  await f.bridge.split(f.source, translation);
  const second = f.bridge.splits.get(f.reader.tabID);
  assert.notStrictEqual(second, first);
  assert.equal(first.browser.removed, true);
  assert.equal(first.right.destroyed, true);
  f.bridge.closeSplit(f.reader.tabID);
  assert.equal(f.bridge.splits.has(f.reader.tabID), false);
  assert.equal(second.browser.removed, true);
  assert.equal(second.right.destroyed, true);
  await f.bridge.split(f.source, translation);
  assert.notStrictEqual(f.bridge.splits.get(f.reader.tabID), second);
  assert.deepEqual(f.calls, { closes: 4, browsers: 3, reads: 3, creates: 3 });
});

test('an old initialization failure does not close its replacement', async t => {
  const blocked = deferred();
  const f = fixture(blocked.promise);
  t.after(() => blocked.resolve());
  const error = new Error('old right reader failed');
  const opening = f.bridge.split(f.source, f.translated);
  const rejected = assert.rejects(opening, error);
  await nextTurn();
  await f.bridge.split(f.source, { ...f.translated, id: 3 });
  const current = f.bridge.splits.get(f.reader.tabID);
  blocked.reject(error);
  await rejected;
  assert.strictEqual(f.bridge.splits.get(f.reader.tabID), current);
  assert.equal(f.calls.closes, 2);
  assert.equal(current.browser.removed, false);
  assert.equal(current.right.destroyed, false);
});
