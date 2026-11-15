/** Check settings action isolation with control-only mocks, never a browser or provider. */
// Built-in modules keep these checks offline and dependency-free.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
// Load the actual window controller and IDs so renamed markup cannot silently pass.
const source = fs.readFileSync(path.join(__dirname, '../addon/content/settings.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../addon/content/settings.xhtml'), 'utf8');
// Confirmation must come from the real scope bridge, not an invented settings-only method.
const bridgeSource = fs.readFileSync(path.join(__dirname, '../addon/content/paperbridge.js'), 'utf8');

/** Hold an asynchronous action open while checking its shared UI lock. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Provide only control values/events and fake bridge calls; no DOM tree is required. */
function fixture(os = 'Linux') {
  const controls = Object.fromEntries([...markup.matchAll(/<(?:html:)?([\w-]+)\b[^>]*\bid="([^"]+)"/g)]
    .map(([, tag, id]) => [id, { id, tag, value: '', checked: false, disabled: false, hidden: false,
      textContent: '', listeners: {},
      /** Retain the production handler for explicit test dispatch. */
      addEventListener(type, handler) { this.listeners[type] = handler; },
    }]));
  const locked = Object.values(controls).filter(control => ['input', 'select'].includes(control.tag)
    || ['save', 'test', 'service-check'].includes(control.id));
  const calls = { keys: [], prefs: [], requests: [], confirmations: [], stops: 0, exports: 0, reveals: [], terms: 0 };
  const prefs = { profile: 'deepseek', language: 'zh-CN', pages: '1-3', pythonPath: '/fixture/saved-python', lastUsage: '' };
  const bridge = {
    storageRoot: '/fixture/storage', library: {},
    runtime: { base: '/fixture/runtime', build: { pythonMode: 'local' },
      terms: {
        agreed: false,
        /** Show controls only on the synthetic Windows platform. */
        required() { return os === 'WINNT'; },
        /** Model UI state without writing a real preference. */
        accepted() { return this.agreed; },
        /** Record the independent agreement action, without starting a backend. */
        async show() { calls.terms++; this.agreed = true; return true; },
      },
      /** Record local engine invalidation without spawning a process. */
      async stop() { calls.stops++; },
      /** Record only explicit reveal, never open a native file manager. */
      file(value) { return { reveal() { calls.reveals.push(value); } }; },
    },
    /** Supply fake saved profiles, deliberately different from the checked draft. */
    configuration(profile = prefs.profile) {
      return { profile, baseURL: `https://${profile}.example.invalid/v1`, model: `saved-${profile}`,
        capabilities: { json_mode: true, max_tokens: 8192 } };
    },
    /** Return synthetic credentials only. */
    getKey(profile) { return `saved-${profile}-key`; },
    /** Read only this fixture's non-secret preferences. */
    pref(name) { return prefs[name]; },
    /** Observe preference persistence and update the synthetic saved state. */
    setPref(name, value) { calls.prefs.push([name, value]); prefs[name] = value; },
    /** Observe credential persistence without touching a login manager. */
    async saveKey(key, profile) { calls.keys.push([key, profile]); await bridge.keyGate; },
    /** Replace every backend/provider request with a deterministic local response. */
    async request(...args) { calls.requests.push(args); return bridge.reply; },
    /** Export is independent of the settings draft and may succeed without an engine. */
    async exportDiagnostics() { calls.exports++; return bridge.exportReply; },
    accept: true, reply: { ok: true }, exportReply: { path: '/fixture/addon.zip', source: 'addon_only' },
  };
  const parent = {};
  const scope = { Zotero: { getMainWindow: () => parent }, Services: { prompt: {
    /** Exercise the real bridge's native prompt forwarding without displaying any UI. */
    confirm(owner, title, message) {
      assert.equal(owner, parent);
      assert.equal(title, 'PaperBridge');
      calls.confirmations.push(message);
      return bridge.accept;
    },
  } } };
  vm.runInNewContext(bridgeSource, scope);
  assert.equal(typeof scope.PaperBridge.confirm, 'function', 'Settings require a real bridge confirmation API');
  bridge.confirm = scope.PaperBridge.confirm;
  let load;
  vm.runInNewContext(source, { URL, document: {
    getElementById: id => { assert.ok(controls[id], `Missing real settings control: ${id}`); return controls[id]; },
    querySelectorAll: selector => Object.values(controls).filter(control => selector.split(',')
      .some(part => [control.tag, '#' + control.id].includes(part.trim()))),
  }, window: { arguments: [{ bridge }], addEventListener: (type, handler) => {
    assert.equal(type, 'load'); load = handler;
  } } });
  load();
  return { bridge, controls, locked, calls, prefs,
    /** Invoke even disabled controls to test handler-level reentrancy protection. */
    fire(id) { return controls[id].listeners.click({ currentTarget: controls[id] }); },
  };
}

/** Enter an unsaved selected-provider draft without borrowing the other profile. */
function draft(f, profile) {
  f.controls.profile.value = profile;
  const prefix = profile === 'compatible' ? 'compatible' : '';
  f.controls[prefix ? 'compatibleBaseURL' : 'baseURL'].value = 'https://draft.example.invalid/v1/';
  f.controls[prefix ? 'compatibleModel' : 'model'].value = 'draft-model';
  f.controls[prefix ? 'compatibleKey' : 'key'].value = 'draft-key';
  f.controls.compatibleJSON.checked = false;
  f.controls.compatibleMaxTokens.value = '9000';
  f.controls.language.value = 'ja';
  f.controls.pages.value = 'invalid-unsaved-pages';
  f.controls.pythonPath.value = '/fixture/unsaved-python';
}

/** Assert all editable/action controls share the same asynchronous lock. */
function assertLock(f, value) {
  for (const control of f.locked) assert.equal(control.disabled, value, control.id);
}

test('saving locks drafts and persists once without checking the local engine or provider', async () => {
  const f = fixture();
  const gate = deferred();
  f.bridge.keyGate = gate.promise;
  draft(f, 'compatible');
  f.controls.pages.value = '2-4';
  const saving = f.fire('save');
  assertLock(f, true);
  await f.fire('save');
  await f.fire('test');
  await f.fire('service-check');
  assert.deepEqual(f.calls.keys, [['draft-key', 'compatible']]);
  assert.equal(f.calls.prefs.length, 0, 'Preferences cannot precede successful key persistence');
  assert.equal(f.calls.requests.length + f.calls.confirmations.length, 0);
  gate.resolve();
  await saving;
  assertLock(f, false);
  assert.equal(f.calls.stops, 1, 'Changing saved Python only stops the old runtime');
  assert.equal(f.prefs.pythonPath, '/fixture/unsaved-python');
  assert.equal(f.prefs.profile, 'compatible');
  assert.ok(f.calls.prefs.some(([name, value]) => name === 'compatibleBaseURL' && value === 'https://draft.example.invalid/v1'));
  assert.equal(f.calls.requests.length, 0);
  assert.match(f.controls.status.textContent, /已保存/);
  const failed = deferred();
  const writes = f.calls.prefs.length;
  f.bridge.keyGate = failed.promise;
  const retry = f.fire('save');
  assertLock(f, true);
  failed.reject(new Error('synthetic key write failure'));
  await retry;
  assertLock(f, false);
  assert.equal(f.calls.prefs.length, writes, 'Failed key persistence leaves preferences unchanged');
  assert.match(f.controls.status.textContent, /synthetic key write failure/);
});

test('local engine check uses saved configuration, not draft validation or credential persistence', async () => {
  const f = fixture();
  const gate = deferred();
  draft(f, 'compatible');
  f.controls.compatibleKey.value = '';
  f.bridge.reply = gate.promise;
  const checking = f.fire('test');
  assertLock(f, true);
  await f.fire('save');
  await f.fire('service-check');
  await f.fire('test');
  assert.deepEqual(f.calls.requests, [['/health']]);
  gate.resolve({ engine: 'BabelDOC 0.6.4', version: '0.3.4', python: '3.12', warning_count: 1 });
  await checking;
  assertLock(f, false);
  assert.equal(f.calls.keys.length + f.calls.prefs.length + f.calls.confirmations.length + f.calls.stops, 0);
  assert.equal(f.prefs.pythonPath, '/fixture/saved-python');
  assert.match(f.controls.status.textContent, /未保存草稿，未调用服务商/);
  assert.match(f.controls.status.textContent, /警告/);
});

test('provider checks require a valid own-profile draft and confirmation; refusal makes zero requests', async () => {
  for (const profile of ['deepseek', 'compatible']) {
    const f = fixture();
    draft(f, profile);
    f.bridge.accept = false;
    await f.fire('service-check');
    assert.equal(f.calls.confirmations.length, 1);
    assert.match(f.calls.confirmations[0], /512 tokens.*可能计费/);
    assert.equal(f.calls.requests.length + f.calls.keys.length + f.calls.prefs.length, 0);
    assertLock(f, false);
    f.controls[profile === 'deepseek' ? 'key' : 'compatibleKey'].value = '';
    f.bridge.accept = true;
    await f.fire('service-check');
    assert.equal(f.calls.confirmations.length, 1, 'Invalid draft fails before confirmation');
    assert.equal(f.calls.requests.length, 0, 'Never borrow the other saved credential');
    assert.match(f.controls.status.textContent, /有效 API Key/);
  }
});

test('confirmed provider checks freeze unsaved drafts, lock controls and never retry or save, even on failure', async () => {
  for (const [profile, outcome] of [['deepseek', 'ok'], ['compatible', 'format'], ['compatible', 'error']]) {
    const f = fixture();
    const gate = deferred();
    draft(f, profile);
    f.bridge.reply = gate.promise;
    const checking = f.fire('service-check');
    assertLock(f, true);
    await f.fire('service-check');
    await f.fire('test');
    await f.fire('save');
    assert.equal(f.calls.confirmations.length, 1);
    assert.equal(f.calls.requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.requests[0])), ['/providers/check', 'POST', {
      profile, base_url: 'https://draft.example.invalid/v1', model: 'draft-model', api_key: 'draft-key',
      lang_out: 'ja', pages: '', confirmed: true,
      capabilities: { max_tokens: 512, json_mode: profile === 'deepseek', thinking_disabled: profile === 'deepseek' },
    }]);
    f.controls[profile === 'deepseek' ? 'key' : 'compatibleKey'].value = 'later-draft';
    if (outcome === 'error') gate.reject(new Error('synthetic provider failure'));
    else gate.resolve(outcome === 'ok' ? { ok: true } : { ok: false, error: 'synthetic format failure', hint: 'Check response format' });
    await checking;
    assertLock(f, false);
    assert.equal(f.calls.requests.length, 1, 'Failure is not retried or redirected');
    assert.equal(f.calls.keys.length + f.calls.prefs.length + f.calls.stops, 0);
    assert.equal(f.calls.requests[0][2].api_key, 'draft-key', 'In-flight request keeps its own snapshot');
    assert.match(f.controls.status.textContent, outcome === 'ok' ? /未保存草稿/ : /synthetic/);
  }
});

test('diagnostic export has its own lock and displays addon-only startup fallback without reading drafts', async () => {
  const f = fixture();
  const gate = deferred();
  f.bridge.exportReply = gate.promise;
  for (const id of ['key', 'compatibleKey', 'baseURL', 'model', 'pythonPath']) {
    Object.defineProperty(f.controls[id], 'value', { get() { throw new Error('Export read a draft'); } });
  }
  const exporting = f.fire('diagnostics-export');
  assert.equal(f.controls['diagnostics-export'].disabled, true);
  assertLock(f, false);
  await f.fire('diagnostics-export');
  assert.equal(f.calls.exports, 1);
  gate.resolve({ path: '/fixture/startup-fallback.zip', source: 'addon_only' });
  await exporting;
  assert.equal(f.controls['diagnostics-export'].disabled, false);
  assert.equal(f.controls['diagnostics-open'].hidden, false);
  assert.equal(f.controls['diagnostics-path'].textContent, '/fixture/startup-fallback.zip');
  assert.match(f.controls['diagnostics-status'].textContent, /引擎不可用.*未确认/);
  await f.fire('diagnostics-open');
  assert.deepEqual(f.calls.reveals, ['/fixture/startup-fallback.zip']);
  f.bridge.exportReply = Promise.reject(new Error('synthetic ZIP failure'));
  await f.fire('diagnostics-export');
  assert.equal(f.controls['diagnostics-export'].disabled, false);
  assert.match(f.controls['diagnostics-status'].textContent, /诊断包未生成.*synthetic ZIP failure/);
  assert.equal(f.calls.requests.length + f.calls.keys.length + f.calls.prefs.length, 0);
});

test('Windows terms are independent of provider drafts and hidden on other platforms', async () => {
  assert.equal(fixture().controls['runtime-terms'].hidden, true);
  const f = fixture('WINNT');
  assert.equal(f.controls['runtime-terms'].hidden, false);
  assert.match(f.controls['runtime-terms-status'].textContent, /首次/);
  for (const id of ['key', 'compatibleKey', 'baseURL', 'model', 'pythonPath']) {
    Object.defineProperty(f.controls[id], 'value', { get() { throw new Error('Terms read a provider draft'); } });
  }
  await f.fire('runtime-terms-view');
  assert.equal(f.calls.terms, 1);
  assert.match(f.controls['runtime-terms-status'].textContent, /已同意/);
  assert.equal(f.calls.requests.length + f.calls.keys.length + f.calls.prefs.length + f.calls.stops, 0);
});
