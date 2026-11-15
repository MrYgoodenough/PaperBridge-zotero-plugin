/** Mock contracts for immutable, engine-independent synced alignment attachments. */
// Built-in modules keep the tests portable and independent of Zotero credentials.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
// Load the actual addon modules rather than another mapping implementation.
const sources = ['alignment.js', 'reading-assets.js'].map(name =>
  fs.readFileSync(path.join(__dirname, '../addon/content', name), 'utf8'));

/** Convert cross-realm JSON into ordinary assertion values. */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

/** Make small in-memory Zotero items and files; native verification runs separately. */
function fixture() {
  const files = new Map([['source.pdf', '%PDF-source'], ['target.pdf', '%PDF-target']]);
  const items = new Map(), writes = [], requests = [], warnings = [];
  let nextAsset = 0, hashReads = 0;
  /** Model only documented attachment, parent and relation operations. */
  function item(key, file, parentKey = 'OWNER001', libraryID = 1) {
    const relations = [];
    const value = { key, id: items.size + 1, libraryID, parentKey, parentID: items.get(parentKey)?.id || null, deleted: false,
      title: key, file,
      /** Identify the mock native item type. */
      isAttachment() { return !!this.file; },
      /** Distinguish JSON assets from PDF attachments. */
      isPDFAttachment() { return this.file?.endsWith('.pdf') || false; },
      /** Identify the mock bibliographic owner. */
      isRegularItem() { return !this.file; },
      /** Read actual file availability, including deliberately missing download cases. */
      async fileExists() { return files.has(this.file); },
      /** Resolve a mock attachment's storage path. */
      async getFilePathAsync() { return this.file; },
      /** Return PDF/JSON siblings without guessing their content. */
      getAttachments() { return [...items.values()].filter(candidate => candidate.parentKey === this.key).map(candidate => candidate.id); },
      /** Read immutable relation evidence. */
      getRelationsByPredicate() { return [...relations]; },
      /** Add one persistent relation marker. */
      addRelation(predicate, value) { if (!relations.includes(value)) relations.push(value); },
      /** Read ordinary title metadata. */
      getField() { return this.title; },
      /** Set ordinary title metadata. */
      setField(field, value) { this.title = value; },
      /** Represent a native metadata commit, not a PDF rewrite. */
      async saveTx() { writes.push({ key: this.key }); },
    };
    items.set(key, value);
    return value;
  }
  const owner = item('OWNER001', null), source = item('SOURCE01', 'source.pdf'), translated = item('TARGET01', 'target.pdf');
  translated.addRelation('dc:relation', 'urn:paperbridge:record:old');
  translated.addRelation('dc:relation', 'zotero:1:SOURCE01');
  const record = { libraryID: 1, sourceKey: source.key, attachmentKey: translated.key,
    alignmentPath: 'alignment.json', language: 'zh-CN' };
  const bridge = { runtime: { base: 'paperbridge', async ensure() { requests.push('ensure'); throw new Error('Python forbidden'); } },
    /** Refuse any HTTP request made by reading-only code. */
    async request(...args) { requests.push(args); throw new Error('HTTP forbidden'); },
    library: {
      /** Resolve an exact key in the requested library. */
      async item(libraryID, key) { const value = items.get(key); return value?.libraryID === libraryID ? value : null; },
      /** Persist the mapping identity without creating a translation job. */
      async update(value, patch) { Object.assign(value, patch); return value; },
      /** Report optional publication failures independently. */
      warn(error) { warnings.push(error.message); },
      /** Recognize real persistent translation markers. */
      isTranslation(value) { return value.getRelationsByPredicate().some(relation => relation.startsWith('urn:paperbridge:record:')); },
    } };
  const Zotero = { debug() {}, Utilities: { randomString() { return 'temporary-' + nextAsset; } },
    Items: {
      /** Return native-shaped values for scalar or array lookups. */
      async getAsync(ids) { return Array.isArray(ids) ? ids.map(id => [...items.values()].find(value => value.id === id))
        : [...items.values()].find(value => value.id === ids); },
    }, URI: {
      /** Bind legacy relations to the library and attachment, not to PDF bytes. */
      getItemURI(value) { return `zotero:${value.libraryID}:${value.key}`; },
    }, Relations: {
      /** Query exactly the production relation marker. */
      async getByPredicateAndObject(type, predicate, relation) {
        return [...items.values()].filter(value => value.getRelationsByPredicate().includes(relation));
      },
    }, Attachments: {
      /** Simulate Zotero's imported-file copy and native key allocation. */
      async importFromFile(options) {
        const key = 'MAPP' + String(++nextAsset).padStart(4, '0'), file = key + '.json';
        files.set(file, files.get(options.file));
        const parent = [...items.values()].find(value => value.id === options.parentItemID);
        return item(key, file, parent?.key || null, options.libraryID);
      },
    } };
  const context = vm.createContext({ Zotero, Components: { utils: {
    /** Preserve the content-compartment getter hidden by an Xray wrapper. */
    waiveXrays(value) { return value.native || value; },
  } }, PathUtils: { normalize: value => value, join: (...parts) => parts.join('/') },
    IOUtils: {
      /** Read local files only; a missing synced file is not downloaded. */
      async readUTF8(file) { if (!files.has(file)) throw new Error('File unavailable'); return files.get(file); },
      /** Bound the optional JSON payload by its actual byte count. */
      async stat(file) { if (!files.has(file)) throw new Error('File unavailable'); return { size: Buffer.byteLength(files.get(file)) }; },
      /** Query local existence without a server. */
      async exists(file) { return files.has(file); },
      /** Record temporary publication files only. */
      async writeUTF8(file, value) { writes.push({ file }); files.set(file, value); },
      /** Keep mock directory setup independent of files. */
      async makeDirectory() {},
      /** Remove only the publisher's disposable temporary file. */
      async remove(file) { files.delete(file); },
    } });
  sources.forEach(source => vm.runInContext(source, context));
  const Assets = context.AlignmentAssets;
  /** Replace native crypto only in this mock suite; assert exactly which files are hashed. */
  Assets.hashFile = file => { hashReads++; return crypto.createHash('sha256').update(files.get(file)).digest('hex'); };
  const assets = bridge.alignmentAssets = new Assets(bridge);
  const line = rect => [rect[0], rect[3], rect[2], rect[3], rect[2], rect[1], rect[0], rect[1]];
  const rects = [[10, 50, 90, 60], [10, 20, 50, 30]];
  const mapping = { schema_version: 2, coordinate_space: 'pdf-user-space', generator_version: 'fragment-trace-2',
    source_sha256: Assets.hashFile(source.file), output_sha256: Assets.hashFile(translated.file),
    units: [{ id: 'p0-u0', status: 'verified', source: { page: 0, rects, quads: rects.map(line) },
      target: { page: 0, rects, quads: rects.map(line) } }], metadata: { captured_text: 'NEVER EXPORT THIS' } };
  files.set(record.alignmentPath, JSON.stringify(mapping));
  const document = { numPages: 1, async getPage() { return { view: [0, 0, 100, 100] }; } };
  const state = { source, translated, alignment: { apps: [{ pdfDocument: document }, { pdfDocument: document }] } };
  return { Assets, assets, bridge, files, items, writes, requests, warnings, item, owner, source, translated, record, mapping, state,
    /** Inspect real hash reads while retaining the fixture's private counter. */
    hashReads() { return hashReads; } };
}

test('publication is immutable, text-free and idempotent for an exact native attachment pair', async () => {
  const f = fixture(), before = f.files.get('target.pdf');
  const first = await f.assets.publish(f.record, f.translated), second = await f.assets.publish(f.record, f.translated);
  assert.equal(first.key, second.key);
  assert.equal(f.items.size, 4);
  const payload = JSON.parse(f.files.get(first.file));
  assert.equal(payload.validation.status, 'verified');
  assert.equal(payload.source_attachment_key, f.source.key);
  assert.equal(payload.translated_attachment_key, f.translated.key);
  assert.equal(payload.generator_version, 'fragment-trace-2');
  assert.equal(JSON.stringify(payload).includes('NEVER EXPORT THIS'), false);
  assert.equal(f.files.get('target.pdf'), before);
  assert.equal([...f.files.keys()].some(file => file.startsWith('paperbridge/mapping-export/')), false);
  assert.deepEqual(f.requests, []);
});

test('a reader with no local record or sidecar discovers downloaded assets and rehashes without Python', async () => {
  const f = fixture(), asset = await f.assets.publish(f.record, f.translated);
  f.files.delete(f.record.alignmentPath);
  f.writes.length = 0;
  const beforeHashes = f.hashReads(), pairs = await f.assets.savedPairs(f.source);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].record.mappingAttachmentKey, asset.key);
  const loaded = await f.assets.load(f.state);
  assert.equal(loaded.available, true);
  assert.equal(loaded.origin, 'zotero-attachment');
  assert.equal(f.hashReads() - beforeHashes, 2);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
});

test('changed bytes, missing downloads and corrupt mappings degrade without erasing outcomes', async () => {
  const f = fixture(), asset = await f.assets.publish(f.record, f.translated);
  f.files.delete(f.record.alignmentPath);
  f.files.set('source.pdf', '%PDF-source-changed');
  const unrelated = f.item('OTHERMAP', 'not-downloaded.json');
  unrelated.addRelation('dc:relation', 'urn:paperbridge:alignment:1');
  assert.match((await f.assets.load(f.state)).reason, /原文已变化/);
  f.files.set('source.pdf', '%PDF-source');
  const original = f.files.get(asset.file);
  f.files.set(asset.file, '{broken');
  assert.equal((await f.assets.load(f.state)).available, false);
  assert.equal((await f.assets.savedPairs(f.source)).length, 1, 'exact legacy relations retain page-only comparison');
  f.files.delete(asset.file);
  assert.equal((await f.assets.load(f.state)).available, false);
  assert.equal(f.files.has('target.pdf'), true);
  f.files.set(asset.file, original);
  assert.equal((await f.assets.load(f.state)).available, true);
  assert.deepEqual(f.requests, []);
});

test('foreign keys, changed owners and deleted sources are not rebound by identical PDF bytes', async () => {
  const f = fixture(), asset = await f.assets.publish(f.record, f.translated), payload = JSON.parse(f.files.get(asset.file));
  f.files.delete(f.record.alignmentPath);
  const copy = f.item('COPYMAP1', 'copied.json', 'OWNER001', 2);
  copy.addRelation('dc:relation', 'urn:paperbridge:alignment:1');
  f.files.set(copy.file, JSON.stringify(payload));
  assert.equal(await f.assets.resolve(copy, f.Assets.payload(payload)), null);
  f.translated.parentKey = 'OWNER002';
  assert.equal((await f.assets.load(f.state)).available, false);
  f.translated.parentKey = f.owner.key;
  f.source.deleted = true;
  assert.equal((await f.assets.load(f.state)).available, false);
  assert.equal(f.files.has(asset.file), true);
  assert.equal(f.files.has('target.pdf'), true);
});

test('legacy verified rectangles export for free while unavailable old translations stay readable', async () => {
  const f = fixture(), legacy = plain(f.mapping);
  legacy.schema_version = 1;
  delete legacy.generator_version;
  legacy.units.forEach(unit => { delete unit.source.quads; delete unit.target.quads; });
  f.files.set(f.record.alignmentPath, JSON.stringify(legacy));
  const asset = await f.assets.publish(f.record, f.translated);
  assert.equal(JSON.parse(f.files.get(asset.file)).generator_version, 'legacy-rectangles-1');
  assert.equal((await f.assets.load(f.state)).available, true);
  f.files.delete(asset.file);
  f.files.delete(f.record.alignmentPath);
  const unavailable = await f.assets.load(f.state, f.record);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /不会.*重新翻译/);
  assert.deepEqual(f.requests, []);
});

test('conflicting maps and out-of-page geometry are unavailable rather than guessed', async () => {
  const f = fixture(), asset = await f.assets.publish(f.record, f.translated);
  f.files.delete(f.record.alignmentPath);
  const document = { numPages: 1, async getPage() { return { native: { get view() { return [0, 0, 100, 100]; } } }; } };
  f.state.alignment.apps.forEach(app => { app.pdfDocument = document; });
  assert.equal((await f.assets.load(f.state)).available, true, 'the native content getter supplies the real page bounds');
  const payload = JSON.parse(f.files.get(asset.file));
  payload.mapping.units[0].target.rects[0][2] = 101;
  payload.mapping.units[0].target.quads[0][2] = 101;
  payload.mapping.units[0].target.quads[0][4] = 101;
  f.files.set(asset.file, JSON.stringify(payload));
  assert.match((await f.assets.load(f.state)).reason, /越界/);
  payload.mapping.units[0].target.rects[0][2] = 80;
  payload.mapping.units[0].target.quads[0][2] = 80;
  payload.mapping.units[0].target.quads[0][4] = 80;
  f.files.set(asset.file, JSON.stringify(payload));
  const second = f.item('MAPP0002', 'second.json');
  second.addRelation('dc:relation', 'urn:paperbridge:alignment:1');
  const other = plain(payload);
  other.mapping.units[0].id = 'p0-u1';
  f.files.set(second.file, JSON.stringify(other));
  assert.match((await f.assets.load(f.state)).reason, /冲突/);
  assert.equal(f.files.has('target.pdf'), true);
  assert.equal(f.items.has(asset.key), true);
});

test('identical PDFs in different owners and multiple translations retain independent asset bindings', async () => {
  const f = fixture(), first = await f.assets.publish(f.record, f.translated);
  const otherOwner = f.item('OWNER002', null, null), source = f.item('SOURCE02', 'source.pdf', otherOwner.key);
  const translated = f.item('TARGET02', 'target.pdf', otherOwner.key);
  translated.addRelation('dc:relation', 'urn:paperbridge:record:other');
  const second = await f.assets.publish({ ...f.record, sourceKey: source.key }, translated);
  const alternative = f.item('TARGET03', 'target.pdf', f.owner.key);
  alternative.addRelation('dc:relation', 'urn:paperbridge:record:alternative');
  const third = await f.assets.publish({ ...f.record }, alternative);
  assert.equal(new Set([first.key, second.key, third.key]).size, 3);
  assert.equal((await f.assets.savedPairs(f.source)).length, 2);
  assert.equal((await f.assets.savedPairs(source)).length, 1);
  assert.equal(JSON.parse(f.files.get(second.file)).source_attachment_key, source.key);
  assert.deepEqual(f.requests, []);
});
