/** Exercise the translation journal and conservative cleanup without a Zotero profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
// Load only the owned library; mocks deliberately fail on destructive Zotero operations.
const librarySource = fs.readFileSync(path.join(__dirname, '../addon/content/library.js'), 'utf8');
// Stable public settings and realistic backend cache identities for focused tests.
const config = {profile:'compatible', capabilities:{json:true, thinking:false},
  baseURL:'https://example.test/v1', model:'test-model', language:'zh-CN', pages:''};
// Stat values identify a source revision without hashing in the frontend.
const stat = {lastModified:100, size:200};
// Identical jobs may serve multiple independent Zotero sources.
const job = {id:'shared-job', state:'queued', fingerprint:'a'.repeat(64), document_key:'b'.repeat(64)};

/** Provide in-memory item, relation and atomic-file APIs plus controllable failures. */
function fixture() {
  const files = new Map();
  const items = new Map();
  const calls = [];
  const errors = [];
  const prefs = new Map();
  const faults = {writes:0, metadata:0, prune:0, copy:0};
  let nextID = 1;
  let nextRecord = 1;
  const Zotero = {
    Utilities:{randomString:() => `record-${nextRecord++}`},
    URI:{getItemURI:item => `zotero://items/${item.libraryID}/${item.key}`},
    Items:{getAsync:async id => items.get(id),
      getByLibraryAndKeyAsync:async (libraryID, key) => [...items.values()].find(item => item.libraryID === libraryID && item.key === key)},
    Relations:{getByPredicateAndObject:async (_type, _predicate, uri) =>
      [...items.values()].filter(item => item.relations.includes(uri))},
    Promise:{delay:async () => {}},
    logError:error => errors.push(error.message)
  };
  const IOUtils = {
    exists:async file => files.has(file),
    readUTF8:async file => files.get(file),
    makeDirectory:async () => {},
    setPermissions:async () => {},
    stat:async file => {
      assert(files.has(file), 'Missing source file');
      return {...stat, ...[...items.values()].find(item => item.file === file)?.stat};
    },
    copy:async (from, to) => {
      if (faults.copy-- > 0) throw new Error('backup failed');
      files.set(to, files.get(from));
    },
    writeUTF8:async (file, content) => {
      if (faults.writes-- > 0) throw new Error('disk full');
      files.set(file, content);
    }
  };
  const Services = {prefs:{getBranch:() => ({
    getChildList:prefix => [...prefs.keys()].filter(key => key.startsWith(prefix)),
    getStringPref:key => prefs.get(key), clearUserPref:key => prefs.delete(key)
  })}};
  const bridge = {
    runtime:{base:'/data/paperbridge', state:'/data/paperbridge/state'},
    cancel:async () => assert.fail('Reconciliation must not cancel shared jobs'),
    request:async (url, _method, body) => {
      calls.push({url, body:JSON.parse(JSON.stringify(body))});
      if (url === '/cache/describe') return {fingerprint:job.fingerprint, document_key:job.document_key};
      assert.equal(url, '/cache/prune');
      assert.equal(body.sweep, false);
      if (faults.prune-- > 0) throw new Error('backend unavailable');
      return {removed_jobs:body.remove.map(ref => ref.fingerprint)};
    }
  };
  const context = vm.createContext({Zotero, IOUtils, Services, PathUtils:path.posix});
  vm.runInContext(librarySource, context);
  /** Create an item whose bytes and dirty metadata survive library-instance restarts. */
  function item(key, parent = null, regular = false, libraryID = 1) {
    const result = {id:nextID++, key, libraryID, parentID:parent?.id, parentKey:parent?.key,
      deleted:false, relations:[], file:`/storage/${key}.pdf`, stat:{...stat}, dirty:false,
      isRegularItem:() => regular, isPDFAttachment:() => !regular,
      getField:() => key, getFilePathAsync:async () => result.file,
      fileExists:async () => files.has(result.file),
      getAttachments:() => [...items.values()].filter(child => child.parentID === result.id).map(child => child.id),
      getRelationsByPredicate:() => [...result.relations],
      addRelation:(_predicate, uri) => { result.relations.push(uri); result.dirty = true; },
      hasChanged:() => result.dirty,
      saveTx:async () => {
        if (faults.metadata-- > 0) throw new Error('metadata failed');
        result.dirty = false;
      },
      eraseTx:async () => assert.fail('Plugin must never permanently erase an attachment')};
    items.set(result.id, result);
    if (!regular) files.set(result.file, '%PDF-test');
    return result;
  }
  const owner = item('OWNER', null, true);
  const source = item('SOURCE', owner);
  const library = new context.TranslationLibrary(bridge);
  /** Reload the durable JSON into a fresh plugin instance. */
  async function reload() {
    const restored = new context.TranslationLibrary(bridge);
    await restored.load();
    return restored;
  }
  return {library, files, items, calls, errors, faults, prefs, item, owner, source, reload};
}

/** Strip vm prototypes before comparing durable JSON. */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('enqueue deduplicates the same owner/job but retains shared-job owners and retry identities', async () => {
  const f = fixture();
  const [record, duplicate] = await Promise.all([
    f.library.put(f.source, null, config, job, stat), f.library.put(f.source, null, config, job, stat)
  ]);
  assert.strictEqual(record, duplicate);
  const other = f.item('OTHER', f.item('OWNER2', null, true));
  const second = await f.library.put(other, null, config, job, stat);
  assert.notEqual(record.recordID, second.recordID);
  assert.equal(record.jobID, second.jobID);
  const retry = await f.library.put(f.source, null, config, {...job, id:'retry-job'}, stat);
  assert.notEqual(retry.recordID, record.recordID);
  const changed = await f.library.put(f.source, null, config, job, {...stat, size:201});
  assert.notEqual(changed.recordID, record.recordID);
  await f.library.update(record, {state:'running', quality:{status:'unknown'}, error:'interrupted'});
  const restored = await f.reload();
  assert.equal(restored.records.length, 4);
  assert.equal(restored.records[0].recordID, record.recordID);
  assert.equal(restored.records[0].state, 'running');
  assert.equal(restored.records[0].lastError, 'interrupted');
  assert.equal(restored.records[0].saveState, null);
  assert.equal(restored.records[0].jobID, job.id);
  assert.equal(f.calls.length, 0);
});

test('configuration snapshots and status updates persist only public metadata', async () => {
  const f = fixture();
  const input = {...config, api_key:'top-secret', headers:{Authorization:'raw-secret'},
    capabilities:{json:true, apiKey:'nested-secret'}, baseURL:'https://user:password@example.test/v1?api_key=url-secret'};
  const record = await f.library.put(f.source, null, input, {...job, api_key:'job-secret'}, stat);
  input.capabilities.json = false;
  assert.equal(record.config.capabilities.json, true);
  await f.library.update(record, {id:'retry', state:'done', output_path:'/outputs/result.pdf',
    quality:{status:'partial', api_key:'quality-secret'}, api_key:'patch-secret',
    error:'api_key=error-secret Bearer token-secret sk-example-key', config:{model:'unwanted'}});
  assert.equal(record.jobID, 'retry');
  assert.equal(record.saveState, 'produced');
  assert.equal(record.config.model, config.model);
  const saved = f.files.get(f.library.path);
  for (const secret of ['top-secret', 'raw-secret', 'nested-secret', 'job-secret', 'url-secret',
    'quality-secret', 'patch-secret', 'error-secret', 'token-secret', 'sk-example-key', 'user:password']) {
    assert(!saved.includes(secret), secret);
  }
  assert.deepEqual(plain((await f.reload()).records[0].quality), {status:'partial'});
});

test('retry forks leave previous imported outcomes intact and persist detached owner state', async () => {
  const f = fixture();
  const pdf = f.item('PREVIOUS', f.owner);
  const prior = await f.library.put(f.source, pdf, config, {...job, state:'done'}, stat);
  const previous = plain(prior);
  const attempt = await f.library.forkAttempt(prior, {...job, id:'retry'});
  assert.deepEqual(plain(prior), previous);
  assert.notEqual(attempt.recordID, prior.recordID);
  assert.equal(attempt.retryOf, prior.recordID);
  assert.equal(attempt.attachmentKey, null);
  assert.equal(attempt.saveState, null);
  assert.equal(attempt.outputPath, null);
  assert.equal(await f.library.findAttachment(attempt), null);
  assert.strictEqual(await f.library.forkAttempt(prior, {...job, id:'retry'}), attempt);
  await assert.rejects(f.library.forkAttempt(prior, job), /new backend job ID/);
  await f.library.update(attempt, {detached:true, state:undefined});
  const restored = await f.reload();
  assert.equal(restored.records[1].detached, true);
  assert.equal(restored.records[1].state, 'queued');
  assert.equal(restored.records[0].jobID, job.id);
  assert.strictEqual((await restored.savedFor(f.owner, config.language)).attachment, pdf);
  const rejoined = await restored.put(f.source, null, config, {...job, id:'retry'}, stat);
  assert.notEqual(rejoined.recordID, attempt.recordID);
  assert.equal(rejoined.detached, false);
});

test('matching includes all advanced settings and source revision, while saved PDFs remain readable', async () => {
  const f = fixture();
  const pdf = f.item('TRANSLATED', f.owner);
  const record = await f.library.put(f.source, pdf, config, {...job, state:'done', quality:{status:'complete'}}, stat);
  assert.strictEqual(await f.library.matching(f.source, {...config, capabilities:{thinking:false, json:true}}), pdf);
  for (const patch of [{profile:'other'}, {capabilities:{json:false}}, {baseURL:'https://other.test'},
    {model:'other'}, {language:'en'}, {pages:'1-2'}]) {
    assert.equal(await f.library.matching(f.source, {...config, ...patch}), null);
    assert.strictEqual((await f.library.savedFor(f.owner, config.language)).attachment, pdf);
  }
  f.source.stat.lastModified++;
  assert.equal(await f.library.sourceUnchanged(record), false);
  assert.equal(await f.library.matching(f.source, config), null);
  f.items.delete(f.source.id);
  f.items.delete(f.owner.id);
  await f.library.reconcile();
  assert.strictEqual((await f.library.savedFor(pdf, config.language)).attachment, pdf);
  assert.equal(f.library.records.length, 1);
  assert.equal(f.calls.length, 0);
});

test('trash, missing owners, interrupted tasks and import failures never destroy outcomes or shared jobs', async () => {
  const f = fixture();
  const pdf = f.item('TRANSLATED', f.owner);
  const record = await f.library.put(f.source, pdf, config, job, stat);
  f.owner.deleted = f.source.deleted = pdf.deleted = true;
  await f.library.reconcile();
  assert.equal(f.library.records.length, 1);
  assert.equal(await f.library.ownerAlive(record), false);
  f.owner.deleted = f.source.deleted = pdf.deleted = false;
  assert.strictEqual((await f.library.savedFor(f.owner, config.language)).attachment, pdf);
  f.items.clear();
  for (const [state, saveState] of [['queued', null], ['running', null], ['unknown', null],
    ['done', 'produced'], ['done', 'import_failed'], ['cancelled', null]]) {
    await f.library.update(record, {state, saveState});
    await f.library.reconcile();
    assert.equal(f.library.records.length, 1);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.reload()).records[0].jobID, job.id);
});

test('importing keys and source/job relations recover the right PDF without cross-owner adoption', async () => {
  const f = fixture();
  const record = await f.library.put(f.source, null, config, job, stat);
  const pdf = f.item('PARTIAL', f.owner);
  await f.library.update(record, {importingAttachmentKey:pdf.key, state:'done'});
  let restored = await f.reload();
  assert.strictEqual(await restored.findAttachment(restored.records[0]), pdf);
  await restored.update(restored.records[0], {importingAttachmentKey:null});
  pdf.addRelation('dc:relation', record.sourceURI);
  pdf.addRelation('dc:relation', 'urn:paperbridge:job:' + job.id);
  const wrong = f.item('WRONG', f.owner);
  wrong.addRelation('dc:relation', record.sourceURI);
  wrong.addRelation('dc:relation', 'urn:paperbridge:job:other-job');
  assert.strictEqual(await restored.findAttachment(restored.records[0]), pdf);
  const otherSource = f.item('SOURCE2', f.owner);
  const other = await restored.put(otherSource, null, config, job, stat);
  assert.equal(await restored.findAttachment(other), null);
  f.items.delete(f.owner.id);
  assert.strictEqual(await restored.findAttachment(restored.records[0]), pdf);
  await restored.attach(restored.records[0], pdf);
  restored = await f.reload();
  assert.equal(restored.records[0].saveState, 'imported');
  assert(pdf.relations.includes('urn:paperbridge:record:' + record.recordID));
  assert.equal(restored.isTranslation(pdf), true);
  assert.strictEqual(await restored.attach(restored.records[0], wrong), pdf);
  assert(f.items.has(wrong.id), 'An extra imported copy must never be erased automatically');
});

test('metadata and index-save failures can be retried on the original imported attachment', async () => {
  const f = fixture();
  const record = await f.library.put(f.source, null, config, {...job, state:'done'}, stat);
  const pdf = f.item('PARTIAL', f.owner);
  f.faults.metadata = 1;
  await assert.rejects(f.library.attach(record, pdf), /metadata failed/);
  let restored = await f.reload();
  assert.equal(restored.records[0].saveState, 'import_failed');
  assert.equal(restored.records[0].importingAttachmentKey, pdf.key);
  assert.strictEqual(await restored.findAttachment(restored.records[0]), pdf);
  f.faults.writes = 1;
  await assert.rejects(restored.update(restored.records[0], {lastError:'save retry'}), /disk full/);
  await restored.attach(restored.records[0], pdf);
  restored = await f.reload();
  assert.equal(restored.records[0].saveState, 'imported');
  assert.equal(restored.records[0].lastError, '');
  assert.equal(restored.records[0].attachmentKey, pdf.key);
  assert.equal(pdf.dirty, false);
});

test('record relations recover the metadata-save/index-save crash window', async () => {
  const f = fixture();
  const record = await f.library.put(f.source, null, config, job, stat);
  const pdf = f.item('CRASHED', null);
  pdf.addRelation('dc:relation', 'urn:paperbridge:record:' + record.recordID);
  f.items.delete(f.source.id);
  f.items.delete(f.owner.id);
  const restored = await f.reload();
  assert.strictEqual(await restored.findAttachment(restored.records[0]), pdf);
  assert.strictEqual((await restored.savedFor(pdf, config.language)).attachment, pdf);
  await restored.attach(restored.records[0], pdf);
  assert.equal(restored.records[0].attachmentID, pdf.id);
});

test('legacy records migrate without hiding saved PDFs or inventing successful pending tasks', async () => {
  const f = fixture();
  const pdf = f.item('LEGACY', f.owner);
  const old = {libraryID:1, sourceKey:f.source.key, ownerKey:f.owner.key, attachmentKey:pdf.key,
    modified:stat.lastModified, size:stat.size, rulesVersion:1, ...config, fingerprint:job.fingerprint};
  f.files.set(f.library.path, JSON.stringify({version:1, records:[old, {...old, attachmentKey:null}], pending:[], needsSweep:true}));
  const restored = await f.reload();
  assert.equal(restored.records[0].saveState, 'imported');
  assert.equal(restored.records[1].state, 'unknown');
  assert.equal(restored.records[1].jobID, null);
  assert.equal(await restored.matching(f.source, config), null);
  assert.strictEqual((await restored.savedFor(f.owner, config.language)).attachment, pdf);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(f.files.get(restored.path)).version, 2);
});

test('partial and unconfirmed attachments remain readable but never short-circuit translation', async () => {
  for (const status of ['partial', 'unknown', 'unusable']) {
    const f = fixture();
    const pdf = f.item('RETAINED', f.owner);
    await f.library.put(f.source, pdf, config, {...job, state:'done', quality:{status}}, stat);
    assert.equal(await f.library.matching(f.source, config), null);
    assert.strictEqual((await f.library.savedFor(f.owner, config.language)).attachment, pdf);
  }
});

test('broken and partial indexes retain originals, readable records and cleanup-disabled state', async () => {
  for (const malformed of ['{"version":2,"records":[', JSON.stringify({version:99, records:[]}),
    JSON.stringify({version:2, records:[null], pending:[]})]) {
    const f = fixture();
    f.files.set(f.library.path, malformed);
    const restored = await f.reload();
    assert.equal(restored.indexComplete, false);
    assert(restored.lastError);
    assert([...f.files].some(([name, bytes]) => name.includes('.recovery-') && bytes === malformed));
    const record = await restored.put(f.source, null, config, job, stat);
    const again = await f.reload();
    assert.equal(again.records[0].recordID, record.recordID);
    assert.equal(again.indexComplete, false);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const pdf = f.item('READABLE', f.owner);
  const record = await f.library.put(f.source, pdf, config, job, stat);
  const data = JSON.parse(f.files.get(f.library.path));
  delete data.pending;
  f.files.set(f.library.path, JSON.stringify(data));
  const restored = await f.reload();
  assert.equal(restored.indexComplete, false);
  assert.equal(restored.records[0].recordID, record.recordID);
  assert.strictEqual((await restored.savedFor(f.owner, config.language)).attachment, pdf);
});

test('failed recovery backup never overwrites the original; fresh indexes never sweep', async () => {
  const f = fixture();
  f.files.set(f.library.path, 'broken index');
  f.faults.copy = 1;
  await f.reload();
  assert.equal(f.files.get(f.library.path), 'broken index');
  assert.equal(f.calls.length, 0);
  const fresh = fixture();
  await fresh.reload();
  assert.equal(fresh.calls.length, 0);
});

test('only disposable unowned cache is pruned, with retained owners/results/tasks sent as keep references', async () => {
  const f = fixture();
  const abandoned = await f.library.put(f.source, null, config, {...job, id:null, state:'failed'}, stat);
  const other = f.item('RETAINED', null);
  const retained = await f.library.put(other, null, config, job, stat);
  f.items.delete(f.owner.id);
  f.items.delete(f.source.id);
  f.faults.prune = 1;
  await f.library.schedule();
  assert(!f.library.records.includes(abandoned));
  assert.equal(f.library.pending.length, 1);
  const restored = await f.reload();
  assert.equal(restored.pending.length, 0);
  assert.equal(restored.records[0].recordID, retained.recordID);
  const request = f.calls.at(-1).body;
  assert.equal(request.sweep, false);
  assert.equal(request.keep[0].fingerprint, request.remove[0].fingerprint);
  assert.equal(request.keep[0].document_key, job.document_key);
});

test('orphan cache PDFs remain protected even when referenced only by an old cleanup queue', async () => {
  const f = fixture();
  f.library.pending = [f.library.ref({fingerprint:job.fingerprint, documentKey:job.document_key})];
  f.files.set(path.posix.join(f.library.bridge.runtime.state, 'jobs', job.fingerprint, 'translated.pdf'), '%PDF-result');
  await f.library.save();
  const restored = await f.reload();
  assert.equal(restored.pending.length, 1);
  assert.equal(f.calls.length, 0);
});

test('legacy preference migration preserves source-less outcomes and failed preferences', async () => {
  const f = fixture();
  const pdf = f.item('LEGACY-ORPHAN', null);
  f.items.delete(f.source.id);
  f.items.delete(f.owner.id);
  f.prefs.set('translation.1.SOURCE.zh-CN', JSON.stringify({id:pdf.id, ...config, apiKey:'old-secret'}));
  f.prefs.set('translation.1.BROKEN.zh-CN', '{broken');
  const restored = await f.reload();
  assert.equal(restored.indexComplete, false);
  assert.strictEqual((await restored.savedFor(pdf, config.language)).attachment, pdf);
  assert(f.prefs.has('translation.1.BROKEN.zh-CN'));
  assert(!f.prefs.has('translation.1.SOURCE.zh-CN'));
  assert(!f.files.get(restored.path).includes('old-secret'));
  assert(f.calls.every(call => call.url !== '/cache/prune'));
});
