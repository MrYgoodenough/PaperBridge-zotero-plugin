/** Exercise note orchestration with small native-item and inert-DOM doubles, without Zotero. */
// Read the production module without accessing a Zotero profile.
const fs = require('node:fs');
// Resolve the module relative to the test file on every platform.
const path = require('node:path');
// Provide the addon's independent script scope.
const vm = require('node:vm');
// Keep assertions dependency-free.
const assert = require('node:assert/strict');
// Use Node's built-in offline test runner.
const { test } = require('node:test');
// Execute the actual module, not another implementation of its public entry points.
const source = fs.readFileSync(path.join(__dirname, '../addon/content/notes.js'), 'utf8');

/** Copy cross-realm values for ordinary contract comparisons. */
function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** Escape fixture text like the native serializer's text-node path. */
function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

/** Decode only entities emitted by this fixture, not arbitrary HTML. */
function unescape(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (match, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"
  })[name]);
}

/** Model serializer-shaped fragments; this is deliberately not a browser HTML parser. */
function fragment(html) {
  const root = { childNodes: [] };
  const stack = [root];
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (!token.startsWith('<')) {
      stack.at(-1).childNodes.push({ nodeType: 3, nodeValue: unescape(token) });
      continue;
    }
    const tag = /^<([a-z0-9]+)/i.exec(token)[1].toLowerCase();
    const attributes = {};
    for (const match of token.matchAll(/([a-z-]+)="([^"]*)"/gi)) {
      attributes[match[1]] = unescape(match[2]);
    }
    const node = { nodeType: 1, localName: tag, childNodes: [],
      /** Expose only fixture attribute values for the production allowlist. */
      getAttribute(name) { return attributes[name] ?? null; }
    };
    stack.at(-1).childNodes.push(node);
    if (!['img', 'br', 'input', 'embed'].includes(tag)) stack.push(node);
  }
  return root;
}

// Supply the inert template boundary; real Gecko parsing remains a native acceptance obligation.
class ParserDouble {
  /** Parse an empty owner document; unsafe HTML must go through the inert template. */
  parseFromString(html, type) {
    assert.equal(html, '');
    assert.equal(type, 'text/html');
    return {
      /** Model just the template element consumed by notes.js. */
      createElement(tag) {
        assert.equal(tag, 'template');
        return {
          /** Populate a serializer-shaped, disconnected fragment. */
          set innerHTML(value) { this.content = fragment(value); }
        };
      }
    };
  }
}

/** Build a small writable library with two PDFs and native annotation children. */
function fixture({ standalone = false, group = false } = {}) {
  const items = new Map();
  const calls = { serialized: [], read: [], saved: [], childLoads: 0 };
  const options = {};
  const library = { editable: true, filesEditable: true, libraryType: group ? 'group' : 'user' };
  let serial = 0;
  const parent = { id: 10, key: 'PAPER001', libraryID: 1, deleted: false, editable: true,
    /** Report native parent type. */
    isRegularItem() { return true; },
    /** Allow tests to change permissions during asynchronous preparation. */
    isEditable() { return this.editable; }
  };
  items.set(parent.id, parent);

  /** Add a saved PDF without file or reader operations. */
  function attachment(id, key) {
    const item = { id, key, libraryID: 1, parentID: standalone ? null : parent.id, deleted: false,
      /** Expose the actual attachment type. */
      isPDFAttachment() { return true; },
      /** Files can be read-only without denying native note creation. */
      isEditable() { return library.editable && library.filesEditable; },
      /** Child data loading is a native read, not a save. */
      async loadDataType(type) { assert.equal(type, 'childItems'); calls.childLoads++; },
      /** Return only this PDF's native child items. */
      getAnnotations() { return [...items.values()].filter(child => child.parentID === id && child.isAnnotation?.()); }
    };
    items.set(id, item);
    return item;
  }
  const translated = attachment(20, 'TRANS001');
  const original = attachment(21, 'SOURCE01');

  /** Add a real child-shaped annotation, retaining mutable JSON to detect writes. */
  function add(id, key, overrides = {}, owner = translated) {
    const json = { key, type: 'highlight', text: 'Actual translated text', comment: 'Comment',
      color: '#ffd400', pageLabel: 'ii', position: { pageIndex: 1, rects: [[1, 2, 30, 12]] }, ...overrides };
    const item = { id, key, libraryID: owner.libraryID, parentID: owner.id, deleted: false, json,
      /** Identify persisted annotation items. */
      isAnnotation() { return true; },
      /** Native annotations may belong to a different group author. */
      isEditable() { return !json.readOnly; },
      /** Permit real adapter calls without needing a database. */
      async loadAllData() {}
    };
    items.set(id, item);
    return item;
  }

  // A native note is allocated only after successful preparation and receives one saveTx call.
  class Note {
    /** Model only native note type construction. */
    constructor(type) {
      assert.equal(type, 'note');
      this._key = null;
      this._primaryDataLoaded = false;
    }
    /** Expose only the native key, which saveTx allocates directly. */
    get key() { return this._key; }
    /** Model Zotero's identified-versus-loaded constraint on caller-assigned keys. */
    set key(value) {
      if (this._primaryDataLoaded) throw new Error('Cannot change key after object is already loaded');
      this._key = value;
    }
    /** Record the completed HTML without persisting it yet. */
    setNote(html) {
      if (this._key && !this._primaryDataLoaded) throw new Error("'primaryData' not loaded for item");
      this._primaryDataLoaded = true;
      this.html = html;
    }
    /** Model ordinary failure and commit-then-reject uncertainty without implicit retry. */
    async saveTx() {
      calls.saved.push(this);
      if (options.beforeKeyFailure) throw options.beforeKeyFailure;
      this._key = 'NOTE' + String(++serial).padStart(4, '0');
      if (options.saveFailure && !options.afterCommit) throw options.saveFailure;
      this.id = 100 + serial;
      items.set(this.id, this);
      if (options.saveFailure) throw options.saveFailure;
      return this.id;
    }
  }

  const Zotero = { Item: Note,
    Items: {
      /** Resolve persisted fixture items only. */
      get: id => items.get(id)
    },
    Libraries: {
      /** Return the fixture library's current permissions. */
      get: () => library
    },
    URI: {
      /** Include actual group identity or unsynced personal-library identity. */
      getItemURI: item => 'http://zotero.org/' + (group ? 'groups/42' : 'users/local/TESTUSER') + '/items/' + item.key,
      /** Expose the public library-path contract used by backlinks. */
      getLibraryPath: () => group ? 'groups/42' : 'users/local/TESTUSER'
    },
    Annotations: {
      /** Read native JSON; never write or reparent annotations. */
      async toJSON(item) {
        calls.read.push(item.id);
        if (options.beforeRead) await options.beforeRead();
        if (options.readFailure) throw options.readFailure;
        return copy(item.json);
      }
    },
    EditorInstanceUtilities: {
      /** Supply the public 10.0.8 serializer's metadata shape, not its full browser implementation. */
      serializeAnnotations(annotations, skipEmbeddingItemData) {
        calls.serialized.push({ annotations: copy(annotations), skipEmbeddingItemData });
        if (options.serializeFailure) throw options.serializeFailure;
        const citationItems = standalone ? [] : [{ uris: [Zotero.URI.getItemURI(parent)], itemData: { title: 'Paper' } }];
        let html = '';
        for (const annotation of annotations) {
          const stored = { attachmentURI: Zotero.URI.getItemURI(translated), annotationKey: annotation.id,
            color: annotation.color, pageLabel: annotation.pageLabel, position: annotation.position };
          const citation = { citationItems: [{ uris: [Zotero.URI.getItemURI(parent)], locator: annotation.pageLabel }], properties: {} };
          if (!standalone) stored.citationItem = citation.citationItems[0];
          const data = encodeURIComponent(JSON.stringify(stored));
          html += '<p>';
          if (annotation.image) html += '<img src="' + escape(annotation.image) + '" data-annotation="' + data + '" width="120" height="40">';
          if (annotation.text) html += '<span class="' + annotation.type + '" data-annotation="' + data + '">' + escape(annotation.text) + '</span>';
          if (annotation.comment) html += escape(annotation.comment);
          if (!standalone) html += '<span class="citation" data-citation="' + encodeURIComponent(JSON.stringify(citation)) + '">(Paper, ' + escape(annotation.pageLabel) + ')</span>';
          html += '</p>';
        }
        return { html: html + (options.templateHTML || ''), citationItems };
      }
    }
  };
  const scope = { Zotero, DOMParser: ParserDouble };
  vm.runInNewContext(source, scope, { filename: 'notes.js' });
  return { api: scope.PaperBridgeNotes, scope, Zotero, parent, translated, original, library, items, calls, options, add };
}

/** Read encoded native metadata out of the saved fixture HTML. */
function metadata(html, name) {
  return [...html.matchAll(new RegExp(name + '="([^"]*)"', 'g'))]
    .map(match => JSON.parse(decodeURIComponent(unescape(match[1]))));
}

/** Preserve native ownership, annotation identity, PDF page labels, and paper citations. */
test('annotation subset creates one paper child note with native citations and explicit PDF backlinks', async () => {
  const f = fixture();
  const first = f.add(30, 'ANNOT001');
  f.add(31, 'ANNOT002', { type: 'underline', pageLabel: '3', position: { pageIndex: 2 } });
  f.add(32, 'ANNOT003');
  f.add(33, 'SOURCEAN', {}, f.original);
  const before = copy([...f.items.values()].filter(item => item.json).map(item => item.json));
  const note = await f.api.createFromAnnotations({ translatedAttachment: f.translated, sourceAttachment: f.original,
    annotationIDs: [first.id, first.key, 'ANNOT002'] });
  assert.equal(note.parentID, f.parent.id);
  assert.equal(note.libraryID, f.translated.libraryID);
  assert.equal(f.calls.saved.length, 1);
  assert.deepEqual(f.calls.read, [30, 31]);
  assert.equal(f.calls.serialized[0].skipEmbeddingItemData, true);
  assert.deepEqual(metadata(note.html, 'data-annotation').map(value => value.annotationKey), ['ANNOT001', 'ANNOT002']);
  assert.equal(metadata(note.html, 'data-citation')[0].citationItems[0].locator, 'ii');
  assert.equal(metadata(note.html, 'data-citation-items')[0][0].itemData.title, 'Paper');
  assert.match(note.html, /data-schema-version="10"/);
  assert.match(note.html, /zotero:\/\/open-pdf\/library\/items\/TRANS001\?page=2&amp;annotation=ANNOT001/);
  assert.match(note.html, /href="zotero:\/\/open-pdf\/library\/items\/SOURCE01"/);
  assert.deepEqual(copy([...f.items.values()].filter(item => item.json).map(item => item.json)), before);
});

/** Feed actual selection text to serialization, with no synthetic annotation key or write. */
test('selection escapes text, uses actual page labels, and hides unit provenance from note text', async () => {
  const f = fixture();
  const text = 'Actual <script>alert(1)</script> & <img src="x" onerror="evil()">\nSecond line';
  const note = await f.api.createFromSelection({ translatedAttachment: f.translated, text,
    pageIndex: 6, pageLabel: 'S-7', unitID: '<unit&1>' });
  assert.equal(f.calls.serialized[0].annotations[0].text, text);
  const stored = metadata(note.html, 'data-annotation')[0];
  assert.equal(stored.attachmentURI.endsWith('/TRANS001'), true);
  assert.deepEqual(stored.position, { pageIndex: 6 });
  assert.equal('annotationKey' in stored, false);
  assert.equal(stored.pageLabel, 'S-7');
  assert.match(note.html, /TRANS001\?page=7/);
  assert.doesNotMatch(note.html, /<script|<img|[?&]annotation=/);
  assert.match(note.html, /&lt;script&gt;/);
  assert.match(note.html, /data-paperbridge-unit="&lt;unit&amp;1&gt;"/);
  assert.doesNotMatch(note.html, /PaperBridge unit:|Translated PDF TRANS001|Source PDF SOURCE01/);
  assert.match(note.html, /译文 · 第 S-7 页/);
  assert.equal(f.translated.getAnnotations().length, 0);
  assert.equal(f.calls.saved.length, 1);
});

/** Root notes and group links follow native library ownership without filesystem paths. */
test('standalone PDFs create root notes and group PDFs use group IDs in backlinks', async () => {
  for (const group of [false, true]) {
    const f = fixture({ standalone: true, group });
    const note = await f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Exact text', pageIndex: 0 });
    assert.equal(note.parentID, undefined);
    assert.deepEqual(metadata(note.html, 'data-citation-items'), [[]]);
    assert.match(note.html, new RegExp('open-pdf/' + (group ? 'groups/42' : 'library') + '/items/TRANS001\\?page=1'));
  }
});

/** Share simultaneous identical actions, but do not prevent later intentional new notes. */
test('in-flight duplicate selections and equivalent annotation ID/key requests save once per operation', async () => {
  const f = fixture();
  f.add(30, 'ANNOT001');
  const notes = await Promise.all([
    f.api.createFromAnnotations({ translatedAttachment: f.translated, annotationIDs: [30] }),
    f.api.createFromAnnotations({ translatedAttachment: f.translated, annotationIDs: ['ANNOT001', 30] })
  ]);
  assert.equal(notes[0], notes[1]);
  assert.equal(f.calls.saved.length, 1);
  assert.equal(f.calls.childLoads, 1);
  const args = { translatedAttachment: f.translated, text: 'Same selection', pageIndex: 0 };
  const selections = await Promise.all([f.api.createFromSelection(args), f.api.createFromSelection(args)]);
  assert.equal(selections[0], selections[1]);
  assert.equal(f.calls.saved.length, 2);
  assert.notEqual(await f.api.createFromSelection(args), selections[0]);
  assert.equal(f.calls.saved.length, 3);
});

/** Copying is a read of annotations; only the target note must be writable. */
test('read-only/external annotations and file-read-only PDFs can be copied, but read-only libraries cannot', async () => {
  const f = fixture();
  f.library.filesEditable = false;
  f.add(30, 'ANNOT001', { readOnly: true, isExternal: true });
  await f.api.createFromAnnotations({ translatedAttachment: f.translated });
  for (const condition of ['library', 'parent', 'trash']) {
    f.library.editable = condition !== 'library';
    f.parent.editable = condition !== 'parent';
    f.parent.deleted = condition === 'trash';
    await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, text: 'text', pageIndex: 0 }), /read-only|unavailable/);
  }
  assert.equal(f.calls.saved.length, 1);
});

/** Invalid selections, foreign IDs, and oversized content must fail before allocating a note. */
test('invalid input and cross-attachment annotations produce visible errors without saves', async () => {
  const f = fixture();
  f.add(30, 'ANNOT001');
  f.add(31, 'SOURCEAN', {}, f.original);
  for (const annotationIDs of [[], [31], ['SOURCEAN'], [999], 'ANNOT001']) {
    await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated, annotationIDs }));
  }
  for (const override of [{ text: '' }, { text: '  ' }, { text: 'bad\u0000text' }, { text: 'x'.repeat(200001) },
    { pageIndex: -1 }, { pageIndex: 0.5 }, { pageIndex: '0' }, { pageIndex: Number.MAX_SAFE_INTEGER },
    { pageLabel: '' }, { pageLabel: 'x'.repeat(257) }, { unitID: 'bad\u0000unit' }]) {
    await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Actual', pageIndex: 0, ...override }));
  }
  f.original.parentID = null;
  await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, sourceAttachment: f.original,
    text: 'Actual', pageIndex: 0 }), /same library and paper/);
  f.translated.deleted = true;
  await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated,
    text: 'Actual', pageIndex: 0 }), /non-trashed/);
  f.translated.deleted = false;
  f.items.get(30).deleted = true;
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /no selected native annotations/);
  assert.equal(f.calls.saved.length, 0);
});

/** Rebuild inert formatting while dropping events, active elements, style, and arbitrary links. */
test('native template output is allowlisted and native citation metadata survives', async () => {
  const f = fixture();
  f.options.templateHTML = '<p onclick="evil()" style="color:red"><a href="javascript:evil()">Label</a>'
    + '<script>evil()</script><svg><script>evil()</script></svg><b>Bold</b></p>';
  const note = await f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Actual', pageIndex: 0 });
  assert.doesNotMatch(note.html, /onclick|style=|javascript:|<script|<svg|evil\(\)/);
  assert.match(note.html, /Label<b>Bold<\/b>/);
  assert.equal(metadata(note.html, 'data-annotation').length, 1);
  f.options.templateHTML = '<img src="https://example.invalid/image.png" onerror="evil()">';
  await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Actual', pageIndex: 0 }), /cached PNG\/JPEG/);
  assert.equal(f.calls.saved.length, 1);
});

/** Inline native cached raster images need no temporary note or image-attachment saves. */
test('cached image annotations serialize once; missing cache and SVG images fail without partial notes', async () => {
  const f = fixture();
  const item = f.add(30, 'IMAGE001', { type: 'image', text: '', comment: '',
    image: 'data:image/png;base64,iVBORw0KGgo=' });
  const note = await f.api.createFromAnnotations({ translatedAttachment: f.translated });
  assert.match(note.html, /<img data-annotation="[^"]+" src="data:image\/png;base64,iVBORw0KGgo=" width="120" height="40">/);
  delete item.json.image;
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /cached image/);
  item.json.image = 'data:image/svg+xml;base64,AAAA';
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /cached PNG\/JPEG/);
  assert.equal(f.calls.saved.length, 1);
});

/** Fail before saving on preparation errors or permission changes during native reads. */
test('read/serializer/parser failures and late permission loss do not create an empty note', async () => {
  const f = fixture();
  f.add(30, 'ANNOT001');
  f.options.readFailure = new Error('Native JSON read failed');
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /read failed/);
  delete f.options.readFailure;
  f.options.serializeFailure = new Error('Native serializer failed');
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /serializer failed/);
  delete f.options.serializeFailure;
  f.scope.DOMParser = undefined;
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /HTML parser is unavailable/);
  f.scope.DOMParser = ParserDouble;
  /** Revoke note permissions while native JSON is being prepared. */
  f.options.beforeRead = async () => { f.library.editable = false; };
  await assert.rejects(f.api.createFromAnnotations({ translatedAttachment: f.translated }), /read-only/);
  assert.equal(f.calls.saved.length, 0);
});

/** Native save errors carry an actually allocated key and never cause automatic second saves. */
test('failed or commit-uncertain save exposes the native note key without automatic retry', async () => {
  for (const afterCommit of [false, true]) {
    const f = fixture();
    f.options.saveFailure = new Error('Disk or notifier failure');
    f.options.afterCommit = afterCommit;
    await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Actual', pageIndex: 0 }), error => {
      assert.equal(error.code, 'NOTE_SAVE_FAILED');
      assert.equal(error.noteKey, 'NOTE0001');
      assert.equal(error.libraryID, 1);
      assert.match(error.message, /before retrying/);
      return true;
    });
    assert.equal(f.calls.saved.length, 1);
    assert.equal([...f.items.values()].filter(item => item instanceof f.Zotero.Item).length, afterCommit ? 1 : 0);
  }
});

/** Failures before native key allocation report no invented identity or automatic retry. */
test('save failure before key allocation exposes an unknown identity', async () => {
  const f = fixture();
  f.options.beforeKeyFailure = new Error('Transaction unavailable');
  await assert.rejects(f.api.createFromSelection({ translatedAttachment: f.translated, text: 'Actual', pageIndex: 0 }), error => {
    assert.equal(error.code, 'NOTE_SAVE_FAILED');
    assert.equal(error.noteKey, null);
    assert.match(error.message, /No native note key was assigned/);
    return true;
  });
  assert.equal(f.calls.saved.length, 1);
  assert.equal([...f.items.values()].filter(item => item instanceof f.Zotero.Item).length, 0);
});
