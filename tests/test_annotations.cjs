/** Check native annotation persistence and split integration without a Zotero profile. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
// Evaluate the actual adapter and bridge, not a second annotation implementation.
const annotationSource = fs.readFileSync(path.join(__dirname, '../addon/content/annotations.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');
// Guard checks evaluate the optional native entry without creating a native session.
const packagedSource = fs.readFileSync(path.join(__dirname, 'annotations_packaged.js'), 'utf8');

/** Copy cross-realm JSON into plain host objects for contract assertions. */
function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** Supply small native JSON with valid Zotero annotation fields. */
function annotation(id, type = 'highlight') {
  return { id, type, color: '#ffd400', text: type === 'highlight' || type === 'underline' ? 'Translated text' : '',
    comment: 'Reader note', pageLabel: '1', sortIndex: '00000|000001|00000',
    position: { pageIndex: 0, rects: [[24, 40, 160, 56]] }, tags: [] };
}

/** Model only documented Zotero item, notification, and reader boundaries in memory. */
function fixture() {
  const items = new Map();
  const observers = new Map();
  const calls = { writes: [], erases: [], errors: [], notices: [], commits: 0, images: 0, permissions: [] };
  let serial = 100;
  const attachment = { id: 20, libraryID: 1, deleted: false, editable: true,
    /** The PDF attachment is an item, but never an annotation item. */
    isAnnotation() { return false; },
    /** Reflect the attachment's real permission flag. */
    isEditable() { return this.editable; },
    /** Return only the attachment's own native child items. */
    getAnnotations() { return [...items.values()].filter(item => item.parentID === this.id); },
  };

  /** Insert one native item, optionally parented by another PDF for boundary tests. */
  function add(value, parentID = attachment.id) {
    const json = copy(value);
    const item = { id: serial++, key: json.id, parentID, libraryID: 1, json, editable: true,
      annotationIsExternal: !!json.isExternal,
      /** Report this fixture's actual native item type. */
      isAnnotation() { return true; },
      /** Expose native annotation permissions independently of attachment permissions. */
      isEditable() { return this.editable; },
      /** Model native transactional erase and its notification payload. */
      async eraseTx(options) {
        calls.erases.push(this.key);
        items.delete(this.id);
        options.notifierQueue.events.push(['delete', 'item', [this.id], { [this.id]: options.notifierData }]);
      },
    };
    items.set(item.id, item);
    return item;
  }

  /** Deliver an actual fixture notifier event without intercepting production callbacks. */
  function notify(event, type, ids, extra) {
    for (const observer of observers.values()) observer.notify(event, type, ids, extra);
  }

  const Zotero = {
    DataObjectUtilities: { generateKey: () => 'TESTKEY' + serial++ },
    Notes: { AUTO_SYNC_DELAY: 15 }, Prefs: { get: () => 'highlight', set() {} },
    logError: error => calls.errors.push(error), debug() {},
    Items: {
      get: id => id === attachment.id ? attachment : items.get(id),
      getByLibraryAndKey: (libraryID, key) => [...items.values()].find(item => item.libraryID === libraryID && item.key === key),
    },
    Annotations: {
      /** Return Zotero's key-based storage JSON rather than reader JSON. */
      async toJSON(item) {
        const result = copy(item.json);
        result.key = item.key;
        delete result.id;
        result.readOnly = !item.editable || item.annotationIsExternal;
        return result;
      },
      /** Exercise the adapter's key conversion and native notifier options. */
      async saveFromJSON(parent, json, options) {
        if (calls.saveFailure) throw calls.saveFailure;
        if (calls.beforeSave) await calls.beforeSave();
        assert.equal(parent, attachment);
        assert.equal('id' in json, false);
        assert.equal('authorName' in json, false);
        let item = Zotero.Items.getByLibraryAndKey(parent.libraryID, json.key);
        const value = { ...copy(json), id: json.key };
        delete value.key;
        item ||= add(value);
        item.json = value;
        calls.writes.push({ key: item.key, options });
        options.notifierQueue.events.push(['modify', 'item', [item.id], { [item.id]: options.notifierData }]);
        return item;
      },
      async saveCacheImage() { calls.images++; },
    },
    Notifier: {
      Queue: class {
        /** Accumulate only this native persistence batch's events. */
        constructor() { this.events = []; }
      },
      registerObserver: observer => { const id = serial++; observers.set(id, observer); return id; },
      unregisterObserver: id => observers.delete(id),
      /** Await observer return values like Zotero.Notifier.trigger. */
      async commit(queue) {
        calls.commits++;
        for (const event of queue.events) {
          for (const observer of observers.values()) await Promise.resolve(observer.notify(...event));
        }
      },
    },
  };
  const context = vm.createContext({ Zotero, Components: { utils: { cloneInto: copy } } });
  vm.runInContext(annotationSource, context);
  vm.runInContext(bridgeSource, context);
  const frame = { wrappedJSObject: { contextMenuParams: { itemGroups: [] } },
    fetch: async () => ({ blob: async () => 'native cache blob' }),
  };

  /** Open a fresh adapter over the same native items, simulating a reader reopening. */
  async function open() {
    const controller = new context.TranslationAnnotations(attachment, frame, error => calls.notices.push(error.message));
    const values = await controller.load();
    const reader = { _state: { annotations: copy(values) }, readOnly: controller.readOnly(),
      /** Update only native reader editability. */
      setReadOnly(value) { this.readOnly = value; calls.permissions.push(value); },
      /** Model the native reader's public annotation setter. */
      setAnnotations(values) {
        for (const value of copy(values)) {
          this._state.annotations = this._state.annotations.filter(item => item.id !== value.id);
          this._state.annotations.push(value);
        }
      },
      /** Model the native reader's public annotation removal method. */
      unsetAnnotations(keys) { this._state.annotations = this._state.annotations.filter(item => !keys.includes(item.id)); },
      openContextMenu: params => params,
    };
    controller.connect(reader);
    return { controller, reader, options: controller.options(values) };
  }
  return { open, add, notify, items, observers, calls, attachment, Zotero, frame, bridge: context.PaperBridge };
}

test('native highlight, underline and note read/write/delete survive reader reopen on the translated attachment', async () => {
  const f = fixture();
  const foreign = f.add(annotation('SOURCE01'), 10);
  const first = await f.open();
  const values = ['highlight', 'underline', 'note'].map((type, index) => annotation('TRANS00' + index, type));
  first.reader.setAnnotations(values);
  let completed = 0;
  first.options.onSaveAnnotations(values, () => completed++);
  await first.controller.pending;
  assert.equal(completed, 1);
  assert.equal(f.calls.writes.length, 3);
  assert.ok(f.calls.writes.every(call => call.options.notifierData.instanceID.startsWith('paperbridge-annotations-')));
  await first.controller.close();
  assert.equal(f.observers.size, 0);
  const reopened = await f.open();
  assert.deepEqual(copy(reopened.reader._state.annotations).map(value => value.type), ['highlight', 'underline', 'note']);
  reopened.reader.unsetAnnotations(['TRANS001']);
  reopened.options.onDeleteAnnotations(['TRANS001', foreign.key]);
  await reopened.controller.pending;
  await reopened.controller.close();
  const final = await f.open();
  assert.deepEqual(copy(final.reader._state.annotations).map(value => value.type), ['highlight', 'note']);
  assert.ok(f.items.has(foreign.id));
  await final.controller.close();
});

test('close snapshots native debounce state, including unsaved additions, edits and deletions', async () => {
  const f = fixture();
  f.add(annotation('REMOVE01'));
  f.add(annotation('CHANGE01'));
  const pane = await f.open();
  const changed = { ...annotation('CHANGE01'), comment: 'Most recent edit before debounce' };
  const added = annotation('NEWNOTE1', 'note');
  pane.reader._state.annotations = [changed, added];
  // Do not call any save/delete callback: the real iframe debounce has not fired yet.
  await pane.controller.close();
  await pane.controller.close();
  assert.deepEqual(f.calls.erases, ['REMOVE01']);
  assert.deepEqual(f.calls.writes.map(call => call.key), ['CHANGE01', 'NEWNOTE1']);
  const reopened = await f.open();
  assert.deepEqual(copy(reopened.reader._state.annotations).map(value => value.comment), [changed.comment, added.comment]);
  await reopened.controller.close();
  assert.equal(f.calls.writes.length, 2, 'unchanged native state is not rewritten during close');
});

test('a pending write completes before close flush, and bridge reopen awaits that flush', async () => {
  const f = fixture();
  const pane = await f.open();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.calls.beforeSave = async () => { entered(); await gate; };
  const initial = annotation('DELAY001');
  pane.reader.setAnnotations([initial]);
  let callbacks = 0;
  pane.options.onSaveAnnotations([initial], () => callbacks++);
  await started;
  pane.reader._state.annotations[0].comment = 'Final native edit';
  const state = { reader: { tabID: 'native-tab', _iframe: {} }, translated: f.attachment,
    annotations: pane.controller, cleanups: [], browser: { remove() {}, contentWindow: f.frame },
    divider: { remove() {} }, container: { setAttribute() {} }, leftFlex: null };
  state.reader._iframe = { setAttribute() {}, removeAttribute() {} };
  f.bridge.splits.set(state.reader.tabID, state);
  f.bridge.closeSplit(state.reader.tabID);
  assert.equal(f.observers.size, 0);
  const replacement = { ...state, annotations: null };
  f.bridge.splits.set(state.reader.tabID, replacement);
  // Reuse the loaded constructor; script loading itself belongs to the packaged test.
  f.bridge.AnnotationController = pane.controller.constructor;
  let reopened = false;
  const opening = f.bridge.translatedAnnotationOptions(replacement, f.frame).then(() => { reopened = true; });
  await new Promise(setImmediate);
  assert.equal(reopened, false);
  release();
  await opening;
  assert.equal(callbacks, 0, 'close flush must not call back into the removed iframe');
  assert.equal(f.bridge.annotationWrites.size, 0);
  assert.equal(copy((await replacement.annotations.load())[0]).comment, 'Final native edit');
  await replacement.annotations.close();
});

test('a disposed iframe acknowledgement cannot fail a pending write or skip the close snapshot', async () => {
  const f = fixture();
  const pane = await f.open();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.calls.beforeSave = async () => { entered(); await gate; };
  const initial = annotation('CLOSED01', 'note');
  pane.reader.setAnnotations([initial]);
  let callbacks = 0;
  /** Model Gecko's invalidated content callback after browser removal. */
  const deadCallback = () => { callbacks++; throw new Error("can't access dead object"); };
  pane.options.onSaveAnnotations([initial], deadCallback);
  await started;
  pane.reader._state.annotations[0].comment = 'Final edit before browser removal';
  const closing = pane.controller.close();
  release();
  await closing;
  assert.equal([...f.items.values()][0].json.comment, 'Final edit before browser removal');
  assert.equal(callbacks, 0, 'a disposed reader has no save loop to acknowledge');
  assert.equal(!!pane.controller.failed, false);
  assert.equal(f.calls.notices.length, 0);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(f.calls.commits, 2, 'both the pending write and final snapshot must commit');
  assert.doesNotThrow(() => pane.options.onSaveAnnotations([], deadCallback));
  assert.equal(callbacks, 0, 'late callbacks must also leave the disposed iframe untouched');
  const reopened = await f.open();
  assert.equal(reopened.reader._state.annotations[0].comment, 'Final edit before browser removal');
  await reopened.controller.close();
});

test('native writes fail visibly without reparenting foreign items or changing the source reader', async () => {
  const f = fixture();
  const foreign = f.add(annotation('FOREIGN1'), 10);
  const pane = await f.open();
  let completed = 0;
  pane.options.onSaveAnnotations([annotation(foreign.key)], () => completed++);
  await pane.controller.pending;
  assert.equal(completed, 1, 'the iframe completion callback must run on errors');
  assert.equal(pane.reader.readOnly, true);
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0], /does not belong/);
  assert.equal(foreign.parentID, 10);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.commits, 1, 'partial notification queues are still committed');
  await pane.controller.close();
});

test('read-only attachments and external annotations cannot be mutated, but native image caches can be filled', async () => {
  const f = fixture();
  const image = f.add({ ...annotation('IMAGE001', 'image'), isExternal: true });
  f.attachment.editable = false;
  const pane = await f.open();
  assert.equal(pane.options.readOnly, true);
  pane.options.onSaveAnnotations([{ ...copy(pane.reader._state.annotations[0]), image: 'data:image/png;base64,AA==' }], () => {});
  await pane.controller.pending;
  assert.equal(f.calls.images, 1);
  assert.equal(f.calls.writes.length, 0);
  pane.options.onSaveAnnotations([annotation('NEWBAD01')], () => {});
  await pane.controller.pending;
  assert.match(f.calls.notices[0], /read-only/);
  assert.equal(f.items.get(image.id), image);
  await pane.controller.close();
});

test('DB failures preserve basic reading and release the iframe callback exactly once', async () => {
  const f = fixture();
  const pane = await f.open();
  f.calls.saveFailure = new Error('Native DB write failed');
  let callbacks = 0;
  pane.options.onSaveAnnotations([annotation('FAILED01')], () => callbacks++);
  await pane.controller.pending;
  assert.equal(callbacks, 1);
  assert.equal(pane.reader.readOnly, true);
  assert.equal(f.calls.notices[0], 'Native DB write failed');
  assert.equal(f.calls.commits, 1);
  assert.equal(f.items.size, 0);
  await pane.controller.close();
});

test('native notifier refreshes only the translated attachment and unregisters on close', async () => {
  const f = fixture();
  const pane = await f.open();
  const translated = f.add(annotation('SYNC0001'));
  const source = f.add(annotation('SOURCE01'), 10);
  f.notify('add', 'item', [translated.id, source.id], {});
  await pane.controller.pending;
  assert.deepEqual(copy(pane.reader._state.annotations).map(value => value.id), [translated.key]);
  translated.json.comment = 'Updated through native Zotero';
  f.notify('modify', 'item', [translated.id], {});
  await pane.controller.pending;
  assert.equal(pane.reader._state.annotations[0].comment, translated.json.comment);
  f.items.delete(translated.id);
  f.notify('delete', 'item', [translated.id], {});
  await pane.controller.pending;
  assert.equal(pane.reader._state.annotations.length, 0);
  assert.equal(f.calls.permissions.length, 0, 'unchanged permissions must not reset the native annotation tool');
  f.attachment.editable = false;
  f.notify('modify', 'item', [f.attachment.id], {});
  await pane.controller.pending;
  f.notify('modify', 'item', [source.id], {});
  await pane.controller.pending;
  assert.deepEqual(f.calls.permissions, [true], 'only the actual permission transition reaches the native setter');
  f.attachment.editable = true;
  f.notify('modify', 'item', [f.attachment.id], {});
  await pane.controller.pending;
  assert.deepEqual(f.calls.permissions, [true, false]);
  await pane.controller.close();
  assert.equal(f.observers.size, 0);
  assert.equal(f.calls.writes.length, 0);
});

test('native reader menus and clipboard keep their original actions and translated attachment identity', async () => {
  const f = fixture();
  const pane = await f.open();
  assert.equal(pane.options.onOpenContextMenu(), f.frame.wrappedJSObject.contextMenuParams);
  let payload;
  pane.options.onSetDataTransferAnnotations({ setData: (format, value) => {
    assert.equal(format, 'zotero/annotation'); payload = JSON.parse(value);
  } }, [annotation('COPY0001')]);
  assert.equal(payload[0].attachmentItemID, f.attachment.id);
  await pane.controller.close();
});

test('the packaged entry does not touch data or quit Zotero when its isolated directory guard fails', async () => {
  const failures = [];
  const context = vm.createContext({
    PAPERBRIDGE_ANNOTATIONS_TEST: { isolated: true, phase: 'create',
      expectedProfileDirectory: '/isolated/profile', expectedDataDirectory: '/isolated/data' },
    Zotero: { version: 'guard-test', isWin: false, DataDirectory: { dir: '/other/data' },
      logError: error => failures.push(error.message) },
    Services: { dirsvc: { get: () => ({ path: '/other/profile' }) } },
    PathUtils: { normalize: value => value }, Ci: { nsIFile: {} },
  });
  // Missing IO, startup and reader APIs would throw if the suite used any of them.
  await vm.runInContext(packagedSource, context);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /explicit isolated profile\/data pair/);
});
