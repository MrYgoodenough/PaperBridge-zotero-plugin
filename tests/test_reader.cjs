/** Verify native attachment ownership, close snapshots and unconditional addon cleanup. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
// Evaluate production methods against one compact native-shaped reader contract.
const readerSource = fs.readFileSync(path.join(__dirname, '../addon/content/reader.js'), 'utf8');
// Keep lifecycle assertions on the actual bridge rather than an independent close implementation.
const bridgeSource = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');

/** Pause a native write or initialization without a real profile or timers. */
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Drain asynchronous reader initialization before simulating a tab close. */
const nextTurn = () => new Promise(setImmediate);

/** Supply only the layout and listener methods used by production cleanup. */
function element() {
  const attrs = new Map([['style', 'original-style'], ['flex', '2']]);
  return {
    style: { cssText: '' }, removed: false, listeners: new Map(),
    /** Preserve original layout attributes. */
    getAttribute(name) { return attrs.get(name) ?? null; },
    /** Observe layout restoration. */
    setAttribute(name, value) { attrs.set(name, value); },
    /** Restore absent host flex attributes. */
    removeAttribute(name) { attrs.delete(name); },
    /** Retain the actual native context-menu listener until cleanup. */
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    /** Verify detached content no longer receives native events. */
    removeEventListener(type) { this.listeners.delete(type); },
    /** Mark native popup or pane disposal. */
    remove() { this.removed = true; },
    /** Ignore visual tree construction. */
    append() {},
  };
}

/** Provide a translated attachment and native superclass without emulating Zotero DB internals. */
function fixture() {
  const calls = { creates: [], saves: [], deletes: [], started: [], errors: [], alerts: [],
    attached: [], detached: [], registered: [], cleanup: [], flushes: 0, uninits: 0, reads: 0 };
  const source = { id: 1 };
  const translated = { id: 2,
    /** Native ownership comes from the attachment, not the source tab. */
    getAnnotations() { return []; },
    /** Supply the native title. */
    async getTabTitle() { return 'Translated attachment'; },
    /** Supply only a synthetic path to compatibility reading. */
    async getFilePathAsync() { return 'translated.pdf'; },
    /** Supply the legacy title. */
    getField() { return 'Translation'; },
  };
  const popups = [];
  const doc = {
    /** Create only native popup sets; no actual UI is needed. */
    createXULElement() { const node = element(); popups.push(node); return node; },
    /** Already-open source readers need no toolbar insertion in this fixture. */
    querySelector() { return null; },
  };
  const win = { document: doc, closed: false };
  const frame = { document: doc, addEventListener() {}, removeEventListener() {},
    /** Capture timer cancellation before the frame is torn down. */
    clearTimeout() { calls.cleanup.push('timer'); },
  };
  /** Create a content reader while retaining the wrapped native callbacks. */
  const factory = options => {
    calls.creates.push(options);
    return { _annotationManager: { _unsavedAnnotations: new Map(), _saveTimeout: 1 },
      _primaryView: { initializedPromise: Promise.resolve(),
        _iframeWindow: { PDFViewerApplication: { pdfViewer: {} } },
        /** Observe destruction even after snapshot, flush or uninit failures. */
        destroy() { calls.cleanup.push('view'); },
      }, setTitle() {},
    };
  };
  frame.wrappedJSObject = { createReader: factory };
  /** Model the shared native methods which the adapter deliberately reuses. */
  class NativeReader {
    /** Bind every persistence callback to the supplied translated attachment. */
    constructor({ item }) { this._item = item; this.itemID = item.id; this._type = 'pdf'; this._initPromise = Promise.resolve(); }
    /** Exercise factory wrapping and native registration, including partial initialization. */
    async _open() {
      if (calls.beforeCreate) await calls.beforeCreate;
      this._blockingObserver = { dispose() { calls.cleanup.push('blocking'); } };
      this._prefObserverIDs = [17];
      this._internalReader = this._iframeWindow.wrappedJSObject.createReader({
        /** Delay saving so callback snapshots can outlive their content arguments. */
        onSaveAnnotations: async (annotations, callback) => {
          calls.started.push(...annotations.map(annotation => annotation.id));
          if (calls.saveGate) await calls.saveGate;
          calls.saves.push({ attachment: this._item.id, annotations });
          callback();
        },
        /** Keep native deletion bound to the same attachment. */
        onDeleteAnnotations: async ids => {
          if (calls.saveGate) await calls.saveGate;
          calls.deletes.push({ attachment: this._item.id, ids });
        },
      });
      if (calls.openError) throw calls.openError;
    }
    /** Simulate the native state writer independently from annotation persistence. */
    async _flushState() { calls.flushes++; if (calls.flushError) throw calls.flushError; }
    /** Match Zotero's unawaited repeated flush to catch accidental rejection leaks. */
    uninit() {
      calls.uninits++;
      this._flushState();
      if (calls.uninitError) throw calls.uninitError;
    }
    /** Expose translated identity through native note/clipboard commands. */
    _addToNote() { return this._item.id; }
  }
  /** Preserve Zotero's actual constructor inheritance shape. */
  class ReaderTab extends NativeReader {}
  const host = new ReaderTab({ item: source });
  host.tabID = 'source-tab'; host._window = win; host._iframe = element(); host._iframeWindow = { document: doc };
  host._internalReader = { _state: { primaryViewState: { pageIndex: 3 } },
    _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfViewer: {} } } } };
  const Zotero = { Reader: { _readers: [host],
      /** Register production event names for startup assertions. */
      registerEventListener(name) { calls.registered.push(name); },
      /** Verify shutdown does not skip reader listener cleanup. */
      _unregisterEventListenerByPluginID() { calls.cleanup.push('reader-events'); },
    }, Prefs: { get() { return 13; }, unregisterObserver() { calls.cleanup.push('pref'); } },
    Notifier: { registerObserver() { return 4; }, unregisterObserver() { calls.cleanup.push('notifier'); } },
    DataDirectory: { dir: '/isolated' }, getMainWindow() { return win; }, getMainWindows() { return [win]; },
    debug() {}, logError(error) { calls.errors.push(error); },
  };
  const context = vm.createContext({ Zotero, PathUtils: { join: (...parts) => parts.join('/') },
    Services: { locale: { appLocalesAsBCP47: [] }, prompt: { alert(_win, _title, message) { calls.alerts.push(message); } } },
    Components: { utils: { exportFunction: value => value, waiveXrays: value => value, cloneInto: value => value } },
    IOUtils: { async read() { calls.reads++; return new Uint8Array([1]); } },
    /** Startup resumes retained work, not a replacement job system. */
    TranslationTasks: class {
      /** Retain the current bridge API. */
      constructor(bridge) { this.bridge = bridge; }
      /** Record restoration without submitting a request. */
      async resume() { calls.cleanup.push('resume'); }
    },
  });
  vm.runInContext(readerSource, context);
  vm.runInContext(bridgeSource, context);
  const bridge = context.PaperBridge;
  bridge.runtime = { terms: {}, async stop() { calls.cleanup.push('runtime'); } };
  bridge.library = { records: [], async load() {}, async settled() { calls.cleanup.push('library'); } };
  bridge.formulaCache = { async load() {}, async settled() { calls.cleanup.push('cache'); } };
  bridge.formulas = { async attach(reader) { calls.attached.push(reader); }, detach(reader) { calls.detached.push(reader); },
    async stop() { calls.cleanup.push('formulas'); } };
  bridge.addMenus = () => {};
  bridge.removeMenus = () => calls.cleanup.push('menus');
  bridge.splitControls = () => calls.cleanup.push('controls');
  bridge.bindSync = () => {};
  bridge.request = async () => assert.fail('Reader lifecycle must not submit or cancel provider work');
  const state = { reader: host, source, translated, browser: element(), divider: element(), container: element(),
    cleanups: [() => calls.cleanup.push('split-hook')], originalStyle: 'container-original', leftStyle: 'left-original', leftFlex: '2' };
  state.browser.contentWindow = frame;
  bridge.splits.set(host.tabID, state);
  return { bridge, state, calls, frame, factory, popups, host, Zotero, win, context };
}

test('native reading has one translated attachment owner and restores the content factory', async () => {
  const f = fixture();
  await f.bridge.loadSplit(f.state, Promise.resolve(), f.win);
  const reader = f.state.translationReader;
  assert.equal(reader.itemID, f.state.translated.id);
  assert.equal(reader._addToNote([]), f.state.translated.id);
  assert.equal(reader._paperbridgeEmbedded, true);
  assert.equal(reader._isTabClosed, true);
  assert.equal(f.Zotero.Reader._readers[1], reader);
  assert.equal(f.frame.wrappedJSObject.createReader, f.factory);
  assert.equal(f.state.annotations, undefined);
  assert.equal(f.calls.reads, 0, 'native reader owns data loading, not a second anonymous reader');
  await f.bridge.closeSplit(f.host.tabID);
  assert.deepEqual(f.Zotero.Reader._readers, [f.host]);
  assert.ok(f.popups[0].removed);
  assert.equal(f.state.browser.listeners.size, 0);
});

test('close snapshots pending edits synchronously and suppresses dead-frame acknowledgements', async () => {
  const f = fixture();
  await f.bridge.loadSplit(f.state, Promise.resolve(), f.win);
  const gate = deferred();
  f.calls.saveGate = gate.promise;
  const input = [{ id: 'PENDING1', comment: 'before await' }];
  let callbacks = 0;
  f.calls.creates[0].onSaveAnnotations(input, () => callbacks++);
  input[0].comment = 'mutated content argument';
  const pending = f.state.right._annotationManager._unsavedAnnotations;
  pending.set('FINAL001', { id: 'FINAL001', comment: 'final edit' });
  pending.set('DELETE01', null);
  const closing = f.bridge.closeSplit(f.host.tabID);
  assert.equal(closing, f.bridge.closeSplit(f.host.tabID));
  assert.equal(pending.size, 0);
  assert.deepEqual(f.calls.started, ['PENDING1', 'FINAL001']);
  assert.equal(f.bridge.annotationWrites.size, 1);
  assert.equal(f.state.browser.removed, false);
  gate.resolve();
  await closing;
  assert.equal(callbacks, 0);
  assert.equal(f.calls.saves[0].annotations[0].comment, 'before await');
  assert.ok(f.calls.saves.every(save => save.attachment === f.state.translated.id));
  assert.deepEqual(Array.from(f.calls.deletes[0].ids), ['DELETE01']);
  assert.equal(f.bridge.annotationWrites.size, 0);
  assert.equal(f.bridge.closingSplits.size, 0);
  assert.ok(f.state.browser.removed);
  assert.equal(f.host._iframe.getAttribute('style'), 'left-original');
  assert.equal(f.calls.flushes, 1, 'uninit must not leak a second unawaited state write');
});

test('snapshot, flush and uninit failures still remove all native and host resources', async () => {
  const f = fixture();
  await f.bridge.loadSplit(f.state, Promise.resolve(), f.win);
  const cyclic = { id: 'BROKEN01' }; cyclic.self = cyclic;
  f.state.right._annotationManager._unsavedAnnotations.set(cyclic.id, cyclic);
  f.calls.flushError = new Error('state write failed');
  f.calls.uninitError = new Error('native uninit failed');
  f.state.cleanups.unshift(() => { throw new Error('detached hook'); });
  await f.bridge.closeSplit(f.host.tabID);
  assert.deepEqual(f.Zotero.Reader._readers, [f.host]);
  for (const operation of ['blocking', 'pref', 'view', 'split-hook']) assert.ok(f.calls.cleanup.includes(operation));
  assert.ok(f.popups[0].removed && f.state.browser.removed && f.state.divider.removed);
  assert.equal(f.frame.wrappedJSObject.createReader, f.factory);
  assert.equal(f.state.container.getAttribute('style'), 'container-original');
  assert.ok(f.calls.alerts.length, 'failed final saves stay visible even after removal');
});

test('partial native initialization is fully released before the single legacy fallback starts', async () => {
  const f = fixture();
  f.calls.openError = new Error('unsupported native option');
  let fallback = false;
  /** Assert ownership and restoration at the real compatibility-reader boundary. */
  f.bridge.translatedAnnotationOptions = async state => {
    assert.equal(state.translationReader, undefined);
    assert.deepEqual(f.Zotero.Reader._readers, [f.host]);
    assert.equal(f.frame.wrappedJSObject.createReader, f.factory);
    fallback = true;
    return { readOnly: true };
  };
  await f.bridge.loadSplit(f.state, Promise.resolve(), f.win);
  assert.ok(fallback);
  assert.equal(f.calls.creates.length, 2);
  assert.equal(f.calls.uninits, 1);
  assert.equal(f.calls.reads, 1);
  await f.bridge.closeSplit(f.host.tabID);
});

test('late native initialization cannot create a reader or close a replacement pair', async () => {
  const f = fixture();
  const gate = deferred(); f.calls.beforeCreate = gate.promise;
  const loading = f.bridge.loadSplit(f.state, Promise.resolve(), f.win).catch(error => error);
  await nextTurn();
  const closing = f.bridge.closeSplit(f.host.tabID);
  const replacement = { reader: f.host };
  f.bridge.splits.set(f.host.tabID, replacement);
  gate.resolve();
  assert.match(String(await loading), /closed during initialization/);
  await closing;
  assert.equal(f.bridge.splits.get(f.host.tabID), replacement);
  assert.equal(f.calls.creates.length, 0);
  assert.deepEqual(f.Zotero.Reader._readers, [f.host]);
  assert.equal(f.frame.wrappedJSObject.createReader, f.factory);
});

test('native flush failure cannot skip addon caches, registrations or runtime shutdown', async () => {
  const f = fixture();
  await f.bridge.loadSplit(f.state, Promise.resolve(), f.win);
  f.calls.flushError = new Error('state flush failed');
  await f.bridge.stop();
  for (const operation of ['formulas', 'notifier', 'library', 'cache', 'reader-events', 'menus', 'runtime']) {
    assert.ok(f.calls.cleanup.includes(operation), operation);
  }
  assert.equal(f.bridge.alive, false);
  assert.ok(f.calls.alerts.some(message => message.includes('state flush failed')));
});

test('optional cache load failure still resumes tasks and registers embedded formula-only controls', async () => {
  const f = fixture();
  f.bridge.formulaCache.load = async () => { throw new Error('cache unavailable'); };
  await f.bridge.start('test-addon');
  assert.ok(f.calls.cleanup.includes('resume'));
  assert.equal(f.calls.registered.length, 4);
  const embedded = { _type: 'pdf', _paperbridgeEmbedded: true };
  const append = () => assert.fail('Translation commands must not target an embedded translated pane');
  f.bridge.toolbarHandler({ reader: embedded, doc: f.win.document, append });
  f.bridge.contextHandler({ reader: embedded, append });
  assert.ok(f.calls.attached.includes(embedded));
  await f.bridge.stop();
});

test('bootstrap releases chrome even if an unexpected stop exception escapes', async () => {
  const context = vm.createContext({ Zotero: { PaperBridge: { async stop() { throw new Error('unexpected stop'); } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../addon/bootstrap.js'), 'utf8'), context);
  let disposed = false;
  context.chromeHandle = { destruct() { disposed = true; } };
  context.scope = {};
  await assert.rejects(context.shutdown(), /unexpected stop/);
  assert.ok(disposed);
  assert.equal(context.scope, null);
  assert.equal(context.Zotero.PaperBridge, undefined);
});
