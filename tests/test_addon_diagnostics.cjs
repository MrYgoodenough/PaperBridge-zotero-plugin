/** Check addon-only diagnostic allowlists and ZIP cleanup using in-memory native API mocks. */
// Built-in modules evaluate production code without Zotero, credentials, disk writes or networking.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
// Both the local exporter and its actual parent fallback are read-only test subjects.
const source = fs.readFileSync(path.join(__dirname, '../addon/content/diagnostics.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');
// Sentinel strings are synthetic and must never appear in exported JSON.
const privateData = { api_key: 'secret-sentinel', token: 'token-sentinel', id: 'raw-id-sentinel',
  path: '/private/path-sentinel/document.pdf', log: 'raw-log-sentinel', title: 'private-title-sentinel' };

/** Simulate native files and ZIP writing, with failures at individual write stages. */
function fixture(failure = '') {
  const files = new Map();
  const calls = { directories: [], writes: [], removals: [], entries: [], closes: 0, requests: [] };
  const archives = new Map();
  const writeError = new Error('synthetic ZIP entry failure');
  let key = 0;
  let archivePath;
  const runtime = { version: '0.3.4', state: '/fixture/state', connection: null,
    diagnosticEvents: [{ at: '2026-11-15T00:00:00.000Z', stage: 'failed', code: 'startup', ...privateData }],
    /** Model an nsIFile path without touching the real filesystem. */
    file(value) { return { path: value }; },
  };
  const writer = {
    /** Simulate a partially created ZIP before a native open failure. */
    open(file, flags) {
      assert.equal(flags, 0x04 | 0x08 | 0x20);
      archivePath = file.path;
      files.set(archivePath, 'partial ZIP');
      archives.set(archivePath, new Map());
      if (failure === 'open') throw new Error('synthetic ZIP open failure');
    },
    /** Copy only the allowlisted JSON entry, not any file discovered by scanning. */
    addEntryFile(name, compression, file, queue) {
      calls.entries.push(name);
      assert.equal(name, 'diagnostics.json');
      assert.equal(queue, false);
      if (failure === 'entry' || failure === 'cleanup') throw writeError;
      archives.get(archivePath).set(name, files.get(file.path));
    },
    /** A persistent native close error must not bypass removal of the partial archive. */
    close() {
      calls.closes++;
      if (failure === 'close') throw new Error('synthetic ZIP close failure');
      if (failure === 'cleanup') throw new Error('secondary close failure');
    },
  };
  const context = {
    Services: { appinfo: { OS: 'Linux', XPCOMABI: 'x86_64-gcc3' } },
    Zotero: { DataObjectUtilities: { generateKey: () => `TESTKEY${++key}` } },
    PathUtils: { join: path.posix.join, tempDir: '/fixture/temp' },
    Ci: { nsIZipWriter: { COMPRESSION_DEFAULT: 0 } },
    Cc: { '@mozilla.org/zipwriter;1': { createInstance: () => writer } },
    IOUtils: {
      /** Failure of the configured directory should use only the exporter's named temp directory. */
      async makeDirectory(value) {
        calls.directories.push(value);
        if (failure === 'directory' && value === '/fixture/state/diagnostics') throw new Error('synthetic state directory failure');
      },
      /** Simulate a partial JSON write that still requires cleanup. */
      async writeUTF8(value, text) {
        calls.writes.push(value);
        files.set(value, text);
        if (failure === 'json') throw new Error('synthetic JSON write failure');
      },
      /** Delete only the exact path supplied by this export action. */
      async remove(value, options) {
        assert.equal(options.ignoreAbsent, true);
        calls.removals.push(value);
        if (failure === 'cleanup') throw new Error('secondary removal failure');
        files.delete(value);
      },
    },
  };
  vm.runInNewContext(source, context);
  return { diagnostics: context.LocalDiagnostics, context, runtime, files, archives, calls, writeError };
}

/** Convert cross-realm plain JSON before comparing its exact public shape. */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

/** Reject every synthetic secret, raw ID, path, title and log in the JSON payload. */
function assertPrivateDataAbsent(payload) {
  const text = JSON.stringify(payload);
  for (const value of Object.values(privateData)) assert.equal(text.includes(value), false, value);
}

test('addon summary exports only anonymous allowlisted states, codes, phases and version facts', () => {
  const f = fixture();
  const at = '2026-11-15T00:00:00.000Z';
  const record = { ...privateData, state: 'failed', quality: { status: 'partial', text: privateData.log },
    events: [{ at, state: 'failed', phase: 'typesetting', code: 'resource', attempt: 2, ...privateData },
      { at, state: 'running', phase: privateData.path, code: privateData.log, attempt: privateData.id },
      { at: privateData.path, state: 'failed' }, { at, state: privateData.log }] };
  f.runtime.diagnosticEvents.push({ at, stage: privateData.path, code: 'startup' },
    { at, stage: 'launching', code: privateData.log, ...privateData });
  Object.defineProperty(f.runtime, 'logs', { get() { throw new Error('Raw logs read'); } });
  const summary = plain(f.diagnostics.summary(f.runtime, [record, null]));
  assert.deepEqual(summary, {
    schema_version: 2, versions: { paperbridge: '0.3.4', python: 'unknown', babeldoc: 'unknown', pymupdf: 'unknown' },
    platform: { system: 'linux', architecture: 'x64' },
    tasks: { total: 2, states: { queued: 0, running: 0, cancelling: 0, done: 0, failed: 1, cancelled: 0, interrupted: 0, unknown: 1 },
      quality: { complete: 0, partial: 1, unusable: 0, unknown: 1 } },
    events: { startup: [{ at, stage: 'failed', code: 'startup' }, { at, stage: 'launching', code: null }],
      jobs: [{ task: 1, events: [{ at, state: 'failed', phase: 'typesetting', code: 'resource', attempt: 2 },
        { at, state: 'running', phase: null, code: null, attempt: null }] }, { task: 2, events: [] }] },
    runtime_status: { engine_ready: false, export_source: 'addon_only' },
    safety: { export_scope: 'allowlist_only', warning_count: null, credentials_included: false,
      document_content_included: false, user_paths_included: false, raw_logs_included: false },
  });
  assertPrivateDataAbsent(summary);
  f.runtime.version = privateData.path;
  f.runtime.connection = { token: privateData.token, path: privateData.path };
  const connected = f.diagnostics.summary(f.runtime, []);
  assert.equal(connected.versions.paperbridge, 'unknown');
  assert.equal(connected.runtime_status.engine_ready, true);
  assertPrivateDataAbsent(connected);
});

test('bad state directories use only the owned temp fallback and preserve unrelated files', async () => {
  const f = fixture('directory');
  const unrelated = '/fixture/temp/PaperBridge-diagnostics/other-export.zip';
  f.files.set(unrelated, 'existing export');
  const first = await f.diagnostics.create(f.runtime, [{ ...privateData, state: 'done' }]);
  const second = await f.diagnostics.create(f.runtime, []);
  assert.equal(first.source, 'addon_only');
  assert.notEqual(first.path, second.path);
  assert.match(first.path, /^\/fixture\/temp\/PaperBridge-diagnostics\/PaperBridge-diagnostics-\d+-TESTKEY1\.zip$/);
  assert.deepEqual(f.calls.directories, ['/fixture/state/diagnostics', '/fixture/temp/PaperBridge-diagnostics',
    '/fixture/state/diagnostics', '/fixture/temp/PaperBridge-diagnostics']);
  assert.deepEqual(f.calls.entries, ['diagnostics.json', 'diagnostics.json']);
  for (const result of [first, second]) {
    assert.ok(f.files.has(result.path));
    const payload = JSON.parse(f.archives.get(result.path).get('diagnostics.json'));
    assertPrivateDataAbsent(payload);
    assert.equal(payload.runtime_status.engine_ready, false);
  }
  assert.equal(f.files.get(unrelated), 'existing export');
  assert.ok(f.calls.removals.every(value => value.endsWith('.json')));
  assert.deepEqual([...f.files.keys()].sort(), [unrelated, first.path, second.path].sort());
});

test('JSON or ZIP write failures remove both owned temporary files and leave prior exports intact', async () => {
  for (const failure of ['json', 'open', 'entry', 'close']) {
    const f = fixture(failure);
    const unrelated = '/fixture/state/diagnostics/prior-export.zip';
    f.files.set(unrelated, 'existing export');
    await assert.rejects(f.diagnostics.create(f.runtime, []), /synthetic/);
    assert.deepEqual([...f.files.keys()], [unrelated], failure + ': partial output must not survive');
    assert.equal(f.files.get(unrelated), 'existing export');
    assert.ok(f.calls.removals.some(value => value.endsWith('.json')));
  }
});

test('secondary close and both removal errors cannot replace the original write error or skip cleanup attempts', async () => {
  const f = fixture('cleanup');
  await assert.rejects(f.diagnostics.create(f.runtime, []), error => {
    assert.equal(error, f.writeError, 'Preserve the exact initial exception, not a cleanup error');
    return true;
  });
  assert.equal(f.calls.closes, 1);
  assert.equal(f.calls.removals.length, 2, 'Try both deletions even when close and ZIP removal fail');
  assert.ok(f.calls.removals[0].endsWith('.zip'));
  assert.ok(f.calls.removals[1].endsWith('.json'));
});

test('real parent export falls back after one startup-failed request, without exporting its exception', async () => {
  const f = fixture();
  Object.assign(f.context, { rootURI: 'chrome://paperbridge/' });
  f.context.Services.scriptloader = {
    /** Exercise the parent's lazy loader without opening a native chrome resource. */
    loadSubScript(url, scope) {
      assert.equal(url, 'chrome://paperbridge/content/diagnostics.js');
      vm.runInNewContext(source, scope);
    },
  };
  vm.runInNewContext(bridgeSource, f.context);
  const bridge = f.context.PaperBridge;
  Object.assign(bridge, { runtime: f.runtime, library: { records: [{ ...privateData, state: 'failed', events: [{
    at: '2026-11-15T00:00:00.000Z', state: 'failed', phase: 'typesetting', code: 'resource', attempt: 1, ...privateData,
  }] }] },
    /** Simulate unavailable startup, not a network connection or a real provider request. */
    async request(...args) { f.calls.requests.push(plain(args)); throw new Error(privateData.log + privateData.path); },
    /** Export must never consult or persist a credential. */
    getKey() { throw new Error('Credential read'); },
    /** Export must never persist a draft. */
    saveKey() { throw new Error('Credential write'); },
  });
  const result = await bridge.exportDiagnostics();
  assert.equal(result.source, 'addon_only');
  assert.deepEqual(f.calls.requests, [['/diagnostics', 'POST', {
    startup: [{ at: '2026-11-15T00:00:00.000Z', stage: 'failed', code: 'startup' }],
  }, { interactive: false }]]);
  const payload = JSON.parse(f.archives.get(result.path).get('diagnostics.json'));
  assertPrivateDataAbsent(payload);
  assert.equal(payload.versions.python, 'unknown');
  assert.equal(payload.runtime_status.engine_ready, false);
  assert.equal(payload.schema_version, 2);
  assert.deepEqual(payload.events.jobs, [{ task: 1, events: [{ at: '2026-11-15T00:00:00.000Z',
    state: 'failed', phase: 'typesetting', code: 'resource', attempt: 1 }] }]);
});
