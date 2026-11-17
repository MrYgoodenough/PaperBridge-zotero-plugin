/** Exercise persistent formula ownership, late linking and clear safety with local Node mocks. */
// Use Node's built-in runner without external services or dependencies.
const {test} = require('node:test');
// Fail on lost cache results or unexpected PDF mutations.
const assert = require('node:assert/strict');
// Implement the Gecko SHA256 service locally.
const crypto = require('node:crypto');
// Load the current production modules as saved on disk.
const fs = require('node:fs');
// Persist mock PDFs and JSON in uniquely created test directories only.
const fsp = require('node:fs/promises');
// Resolve production sources independently of the test working directory.
const path = require('node:path');
// Supply Zotero/XPCOM services without starting Zotero or an engine.
const vm = require('node:vm');
// Callers can keep all test artifacts in their explicitly authorized process directory.
const TEST_DATA_ROOT = path.resolve(process.env.PAPERBRIDGE_TEST_ROOT || '.runtime/formula-cache-unit');
// These tests read only the two formula modules under the repository source root.
const SOURCE_ROOT = path.resolve(__dirname, '../addon/content');

/** Create isolated, real-IO mocks with mutable Zotero item ownership. */
async function fixture() {
  await fsp.mkdir(TEST_DATA_ROOT, {recursive:true});
  const base = await fsp.mkdtemp(path.join(TEST_DATA_ROOT, 'case-'));
  const items = new Map();
  const errors = [];
  const requests = [];
  let clipboard = 'initial';
  const scope = vm.createContext({
    TextEncoder,
    Cc: {
      '@mozilla.org/security/hash;1': {
        /** Emulate Gecko hashing without platform-specific native binaries. */
        createInstance() {
          let hash;
          return {
            SHA256:1,
            /** Start a content hash. */
            init() { hash = crypto.createHash('sha256'); },
            /** Append PDF or selection bytes. */
            update(bytes) { hash.update(bytes); },
            /** Return the binary digest expected by the production implementation. */
            finish() { return hash.digest('latin1'); }
          };
        }
      },
      '@mozilla.org/widget/clipboardhelper;1': {
        getService: () => ({copyString:value => { clipboard = value; }})
      }
    },
    Ci:{},
    PathUtils:{join:path.join, filename:path.basename},
    IOUtils: {
      makeDirectory: value => fsp.mkdir(value, {recursive:true}),
      getChildren: async value => (await fsp.readdir(value)).map(name => path.join(value, name)),
      readUTF8: value => fsp.readFile(value, 'utf8'),
      read: async value => new Uint8Array(await fsp.readFile(value)),
      /** Emulate the atomic temporary-file replacement used by Gecko. */
      async writeUTF8(value, data, options = {}) {
        await fsp.writeFile(options.tmpPath || value, data);
        if (options.tmpPath) await fsp.rename(options.tmpPath, value);
      },
      setPermissions: (value, mode) => fsp.chmod(value, mode),
      remove: value => fsp.rm(value, {force:true}),
      /** Preserve the physical fingerprint memoization inputs. */
      async stat(value) {
        const stat = await fsp.stat(value);
        return {size:stat.size, lastModified:stat.mtimeMs};
      }
    },
    Zotero: {
      Items: {
        get: id => items.get(id),
        getByLibraryAndKeyAsync: async (libraryID, key) =>
          [...items.values()].find(item => item.libraryID === libraryID && item.key === key)
      },
      logError: error => errors.push(String(error))
    }
  });
  for (const name of ['formula-cache', 'formulas']) {
    const source = path.join(SOURCE_ROOT, name + '.js');
    vm.runInContext(fs.readFileSync(source, 'utf8'), scope, {filename:source});
  }
  const bridge = {
    alive:true,
    runtime:{base},
    library:{records:[]},
    /** Enforce the dedicated provider contract even in cache tests. */
    getKey(profile) { assert.equal(profile, 'deepseek'); return 'fixture-key'; },
    /** Keep credentials and endpoint in the same provider profile. */
    configuration(profile) { assert.equal(profile, 'deepseek'); return {baseURL:'https://deepseek.example.invalid'}; },
    /** Record mock requests without HTTP or external model calls. */
    async request(route, method, payload, options) {
      requests.push({route, method, payload, options});
      await new Promise(resolve => setTimeout(resolve, 5));
      return {latex:'x_i^2'};
    }
  };
  const cache = bridge.formulaCache = new scope.FormulaCache(bridge);
  await cache.load();

  /** Add a regular paper owner that can independently survive attachment deletion. */
  function parent(id, key) {
    const item = {id, key, libraryID:1, deleted:false,
      isRegularItem:() => true, isPDFAttachment:() => false, getField:() => key};
    items.set(id, item);
    return item;
  }

  /** Store mock PDF bytes and expose live parent relationships for move tests. */
  async function pdf(id, key, owner, content) {
    const file = path.join(base, key + '.pdf');
    await fsp.writeFile(file, content);
    const item = {id, key, libraryID:1, deleted:false, parentID:owner?.id, parentKey:owner?.key,
      isRegularItem:() => false, isPDFAttachment:() => true, getField:() => key,
      getFilePathAsync:async () => file};
    Object.defineProperty(item, 'parentItem', {get:() => items.get(item.parentID)});
    items.set(id, item);
    return item;
  }

  return {base, scope, bridge, cache, formulas:new scope.FormulaClipboard(bridge),
    items, errors, requests, parent, pdf, clipboard:() => clipboard};
}

/** Store one distinct formula through the public cache API. */
async function store(f, item, text, latex = text) {
  const context = await f.cache.context({itemID:item.id});
  const selection = {text, glyphs:[]};
  await f.cache.store(context, f.cache.key(selection), selection, latex);
  return context;
}

/** Preserve the original cache/restart/deletion coverage with readable assertions. */
test('shared persistence, concurrent copies, deletion and manual clear preserve PDFs', async () => {
  const f = await fixture();
  const first = f.parent(10, 'PAPER_A');
  const second = f.parent(20, 'PAPER_B');
  const source = await f.pdf(1, 'SOURCE', first, 'source content');
  const translated = await f.pdf(2, 'TRANSLATED', first, 'translated content');
  const other = await f.pdf(3, 'SOURCE_B', second, 'source content');
  const selection = {text:'x2', glyphs:[
    {c:'x', page:0, rect:[0, 0, 5, 10]}, {c:'2', page:0, rect:[5, 7, 9, 13]}
  ]};
  await f.cache.link(source, translated);
  assert.equal(await f.formulas.copy({itemID:1}, selection, false), '$x_i^2$');
  assert.equal(await f.formulas.copy({itemID:2}, selection, true), '$$x_i^2$$');
  assert.equal(f.requests.length, 1);
  assert.equal((await fsp.readdir(f.cache.root)).filter(name => name.endsWith('.json')).length, 1);
  const document = (await f.cache.list())[0];
  const raw = await fsp.readFile(path.join(f.cache.root, document.id + '.json'), 'utf8');
  assert.equal(raw.includes('fixture-key'), false);

  const next = {text:'y2', glyphs:[]};
  await Promise.all([
    f.formulas.copy({itemID:1}, next, false), f.formulas.copy({itemID:2}, next, true)
  ]);
  assert.equal(f.requests.length, 2, 'simultaneous copies use one provider request');
  f.cache = f.bridge.formulaCache = new f.scope.FormulaCache(f.bridge);
  await f.cache.load();
  f.formulas = new f.scope.FormulaClipboard(f.bridge);
  f.bridge.getKey = () => '';
  assert.equal(await f.formulas.copy({itemID:2}, selection, false), '$x_i^2$');
  assert.equal(f.requests.length, 2, 'a restart cache hit does not need credentials');
  f.bridge.getKey = () => 'fixture-key';

  source.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 1);
  const third = await f.pdf(4, 'TRANSLATED_B', first, 'second translation');
  await f.cache.link(translated, third);
  translated.deleted = true;
  await f.cache.reconcile();
  await f.formulas.copy({itemID:other.id}, selection, false);
  first.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 1, 'another paper still owns the shared cache');
  second.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 0);

  first.deleted = source.deleted = false;
  const context = await store(f, source, 'q');
  const originalBytes = await fsp.readFile(await source.getFilePathAsync());
  await f.cache.clear(context.id);
  assert.deepEqual(await fsp.readFile(await source.getFilePathAsync()), originalBytes);
  assert.equal((await f.cache.list()).length, 0);
  await store(f, source, 'r');
  first.deleted = true;
  f.cache = f.bridge.formulaCache = new f.scope.FormulaCache(f.bridge);
  await f.cache.load();
  assert.equal((await f.cache.list()).length, 0, 'startup reconciles deletions while disabled');

  const standalone = await f.pdf(5, 'STANDALONE', null, 'standalone');
  await store(f, standalone, 's');
  f.items.delete(standalone.id);
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 0);
  const badID = 'f'.repeat(64);
  await fsp.writeFile(path.join(f.cache.root, badID + '.json'), '{broken');
  const reloaded = new f.scope.FormulaCache(f.bridge);
  await reloaded.load();
  assert.equal((await reloaded.list())[0].id, badID);
  await reloaded.clear(badID);
  assert.equal((await reloaded.list()).length, 0);
  assert.equal(f.errors.length, 0);
});

/** Follow no-record attachment moves without losing surviving paper or standalone references. */
test('standalone moves and split owners retain every surviving real owner or PDF', async () => {
  const f = await fixture();
  const first = f.parent(10, 'PAPER_A');
  const second = f.parent(20, 'PAPER_B');
  const standalone = await f.pdf(1, 'MOVED', first, 'standalone bytes');
  await store(f, standalone, 'standalone formula');
  standalone.parentID = standalone.parentKey = null;
  first.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 1, 'the live standalone PDF retains its cache');
  f.items.delete(standalone.id);
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 0);

  first.deleted = false;
  const source = await f.pdf(2, 'SOURCE', first, 'source bytes');
  const translated = await f.pdf(3, 'TRANSLATED', first, 'translated bytes');
  await f.cache.link(source, translated);
  await store(f, source, 'split formula');
  translated.parentID = second.id;
  translated.parentKey = second.key;
  await f.cache.reconcile();
  const references = (await f.cache.list())[0].references;
  assert.deepEqual(Array.from(references, ref => ref.ownerKey).sort(), ['PAPER_A', 'PAPER_B']);
  assert.deepEqual(Array.from(references.find(ref => ref.ownerKey === first.key).attachmentKeys), [source.key]);
  assert.deepEqual(Array.from(references.find(ref => ref.ownerKey === second.key).attachmentKeys), [translated.key]);
  source.deleted = translated.deleted = second.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 1, 'the original paper remains a paper-only reference');
  first.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 0);
});

/** Discover live originals independently of a translated object's trash state. */
test('a trashed translated attachment cannot hide a live source in a known record', async () => {
  const f = await fixture();
  const first = f.parent(10, 'PAPER_A');
  const second = f.parent(20, 'PAPER_B');
  const source = await f.pdf(1, 'SOURCE_A', first, 'identical bytes');
  const other = await f.pdf(2, 'SOURCE_B', second, 'identical bytes');
  const translated = await f.pdf(3, 'TRANSLATED_B', second, 'translated bytes');
  translated.deleted = true;
  const physical = await f.cache.fingerprint(source);
  f.bridge.library.records.push({libraryID:1, ownerKey:second.key, sourceKey:other.key,
    attachmentKey:translated.key, documentKey:physical.id});
  await store(f, source, 'shared');
  const reference = (await f.cache.list())[0].references.find(ref => ref.ownerKey === second.key);
  assert.deepEqual(Array.from(reference.attachmentKeys), [other.key]);
  first.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 1);
  second.deleted = true;
  await f.cache.reconcile();
  assert.equal((await f.cache.list()).length, 0);
});

/** Prove union persistence and original-result precedence after late linking. */
test('late link unions entries, physical pages, references and aliases before restart', async () => {
  const f = await fixture();
  const first = f.parent(10, 'PAPER_A');
  const second = f.parent(20, 'PAPER_B');
  const third = f.parent(30, 'PAPER_C');
  const source = await f.pdf(1, 'SOURCE', first, 'source bytes');
  const translated = await f.pdf(2, 'TRANSLATED', second, 'translated bytes');
  const duplicate = await f.pdf(3, 'DUPLICATE', third, 'translated bytes');
  const translatedContext = await store(f, translated, 'translated only', 'y');
  const sourceContext = await store(f, source, 'source only', 'x');
  await f.cache.context({itemID:duplicate.id});
  await store(f, translated, 'collision', 'old translated');
  await store(f, source, 'collision', 'canonical original');
  await f.cache.storePage(sourceContext, 0, [{rect:[0, 0, 10, 10]}]);
  await f.cache.storePage(translatedContext, 1, [{rect:[10, 10, 20, 20]}]);
  await f.cache.link(source, translated);
  assert.equal((await f.cache.list()).length, 1);
  assert.equal((await fsp.readdir(f.cache.root)).filter(name => name.endsWith('.json')).length, 1);
  assert.equal((await f.cache.context({itemID:translated.id})).id, sourceContext.id);
  const collisionKey = f.cache.key({text:'collision', glyphs:[]});
  assert.equal(await f.cache.lookup(translatedContext, collisionKey), 'canonical original');
  await f.cache.store(translatedContext, collisionKey, {text:'collision'}, 'late translated result');
  assert.equal(await f.cache.lookup(sourceContext, collisionKey), 'canonical original');
  await f.cache.store(translatedContext, 'pending-before-link', {text:'pending'}, 'z');
  assert.equal(await f.cache.lookup(sourceContext, 'pending-before-link'), 'z');

  f.cache = f.bridge.formulaCache = new f.scope.FormulaCache(f.bridge);
  await f.cache.load();
  const reopened = await f.cache.context({itemID:translated.id});
  assert.equal(reopened.id, sourceContext.id);
  assert.equal((await f.cache.context({itemID:duplicate.id})).id, sourceContext.id);
  assert.equal(await f.cache.lookup(reopened, f.cache.key({text:'translated only', glyphs:[]})), 'y');
  assert.equal(await f.cache.lookup(reopened, collisionKey), 'canonical original');
  assert.equal(await f.cache.lookup(reopened, 'pending-before-link'), 'z');
  assert.equal((await f.cache.page(reopened, 1)).regions.length, 1);
  assert.equal((await f.cache.page({...reopened, physicalID:sourceContext.physicalID}, 0)).regions.length, 1);
  assert.deepEqual(Array.from((await f.cache.list())[0].references, ref => ref.ownerKey).sort(),
    ['PAPER_A', 'PAPER_B', 'PAPER_C']);
  assert.equal(f.requests.length, 0, 'link and restart never invoke a model');
});

/** Preserve concurrent request deduplication when the cache identity changes mid-request. */
test('copies started before and after late link share the same pending provider request', async () => {
  const f = await fixture();
  const owner = f.parent(10, 'PAPER');
  const source = await f.pdf(1, 'SOURCE', owner, 'source bytes');
  const translated = await f.pdf(2, 'TRANSLATED', owner, 'translated bytes');
  const selection = {text:'pending', glyphs:[]};
  let started;
  let release;
  let lookedUp;
  let requests = 0;
  const begun = new Promise(resolve => { started = resolve; });
  const secondLookup = new Promise(resolve => { lookedUp = resolve; });
  f.bridge.request = async () => {
    requests++;
    started();
    await new Promise(resolve => { release = resolve; });
    return {latex:'shared'};
  };
  const firstCopy = f.formulas.copy({itemID:translated.id}, selection, false);
  await begun;
  await f.cache.link(source, translated);
  const lookup = f.cache.lookup.bind(f.cache);
  f.cache.lookup = async (context, key) => {
    const result = await lookup(context, key);
    lookedUp();
    return result;
  };
  const secondCopy = f.formulas.copy({itemID:source.id}, selection, true);
  await secondLookup;
  // Let the copy continuation inspect the pending map before releasing the provider response.
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all([firstCopy, secondCopy]), ['$shared$', '$$shared$$']);
  assert.equal(requests, 1);
});

/** Clear both original and retired identities before allowing new-generation writes. */
test('selected/all clear invalidates pending retired contexts without overwriting new results', async () => {
  for (const mode of ['selected', 'all']) {
    const f = await fixture();
    const owner = f.parent(10, 'PAPER');
    const source = await f.pdf(1, 'SOURCE', owner, 'source bytes');
    const translated = await f.pdf(2, 'TRANSLATED', owner, 'translated bytes');
    const oldContext = await f.cache.context({itemID:translated.id});
    const selection = {text:'pending', glyphs:[]};
    let release;
    let started;
    const begun = new Promise(resolve => { started = resolve; });
    f.bridge.request = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return {latex:'old'};
    };
    const oldCopy = f.formulas.copy({itemID:translated.id}, selection, false);
    await begun;
    await f.cache.link(source, translated);
    const canonical = await f.cache.context({itemID:source.id});
    await f.cache.clear(mode === 'selected' ? canonical.id : undefined);
    await f.cache.link(source, translated);
    const current = await f.cache.context({itemID:source.id});
    f.bridge.request = async () => ({latex:'new'});
    assert.equal(await f.formulas.copy({itemID:source.id}, selection, false), '$new$');
    release();
    await oldCopy;
    assert.equal(await f.cache.lookup(current, f.cache.key(selection)), 'new', mode);
    await f.cache.storePage(oldContext, 99, [{rect:[0, 0, 1, 1]}]);
    assert.equal(await f.cache.page({...current, physicalID:oldContext.physicalID}, 99), null, mode);
  }
});
