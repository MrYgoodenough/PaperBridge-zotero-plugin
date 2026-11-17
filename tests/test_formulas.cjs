/** Verify formula profile routing, optional-cache warnings and bounded non-interactive hover retries. */
// Keep all tests local with the standard Node runner.
const {test} = require('node:test');
// Assert clipboard and cache safety without real native UI actions.
const assert = require('node:assert/strict');
// Read the current production formula implementation only.
const fs = require('node:fs');
// Locate production source independently of the caller's working directory.
const path = require('node:path');
// Replace Zotero, timers and providers with deterministic local mocks.
const vm = require('node:vm');
// This delay identifies the pointer detection timer, not an actual native UI acceptance limit.
const TEST_HOVER_DELAY_MS = 140;
// Advance beyond the production cooldown without waiting on real clocks.
const TEST_RETRY_ADVANCE_MS = 6000;
// The reviewed module is the live production file, never the prior PR export.
const SOURCE_PATH = path.resolve(__dirname, '../addon/content/formulas.js');

/** Create an active-compatible bridge with distinct DeepSeek credentials and configuration. */
function fixture() {
  const values = new Map();
  const pages = new Map();
  const requests = [];
  const keyProfiles = [];
  const configurationProfiles = [];
  const errors = [];
  const warnings = [];
  const clock = {now:1000};
  let clipboard = 'unchanged';
  const cache = {
    generation:0,
    context:async reader => ({id:reader.itemID, physicalID:`pdf-${reader.itemID}`, path:'/mock/source.pdf', generation:0}),
    key:value => JSON.stringify(value),
    lookup:async (context, key) => values.get(context.id + key),
    store:async (context, key, selection, latex) => values.set(context.id + key, latex),
    page:async (context, pageIndex) => pages.get(`${context.id}:${pageIndex}`),
    storePage:async (context, pageIndex, regions) => pages.set(`${context.id}:${pageIndex}`, {regions}),
    settled:async () => {}
  };
  const prefs = {profile:'compatible', model:'vendor-model', baseURL:'https://compatible.example.invalid'};
  const bridge = {
    alive:true,
    formulaCache:cache,
    pref:name => prefs[name],
    /** Match mainline's profile-sensitive credential default. */
    getKey(profile = this.pref('profile') || 'deepseek') {
      keyProfiles.push(profile);
      return profile === 'deepseek' ? 'MOCK_DEEPSEEK_KEY' : 'MOCK_COMPATIBLE_KEY';
    },
    /** Return the same profile's configuration without activating it. */
    configuration(profile = this.pref('profile') || 'deepseek') {
      configurationProfiles.push(profile);
      return profile === 'deepseek'
        ? {model:'deepseek-flash', baseURL:'https://deepseek.example.invalid', capabilities:{}}
        : {model:prefs.model, baseURL:prefs.baseURL, capabilities:{}};
    },
    action:task => task(),
    /** Observe payloads without HTTP, engine startup or external models. */
    async request(route, method, payload, options) {
      requests.push({route, method, payload, options});
      return {latex:'\\frac{x^2}{y_i}'};
    }
  };

  /** Record visible warning descriptions instead of opening a native progress window. */
  class ProgressWindowMock {
    /** Capture the displayed warning title. */
    changeHeadline(value) { this.title = value; }
    /** Capture the displayed warning text. */
    addDescription(value) { this.description = value; }
    /** Record that the implementation requested a visible warning. */
    show() { warnings.push(this.description); }
    /** Accept the native timeout API without scheduling real UI. */
    startCloseTimer() {}
  }

  const scope = vm.createContext({
    Date:{now:() => clock.now},
    Cc:{'@mozilla.org/widget/clipboardhelper;1': {getService:() => ({copyString:value => { clipboard = value; }})}},
    Ci:{nsIClipboardHelper:{}},
    Components:{utils:{cloneInto:value => value}},
    Zotero:{logError:error => errors.push(String(error)), ProgressWindow:ProgressWindowMock}
  });
  vm.runInContext(fs.readFileSync(SOURCE_PATH, 'utf8'), scope, {filename:SOURCE_PATH});
  return {scope, bridge, cache, values, pages, requests, keyProfiles, configurationProfiles,
    errors, warnings, clock, formulas:new scope.FormulaClipboard(bridge), clipboard:() => clipboard};
}

/** Supply the event APIs needed by attach/detach, not a simulated native renderer. */
class EventTargetMock {
  /** Track handlers and mutable button properties. */
  constructor() { this.listeners = new Map(); this.style = {}; this.dataset = {}; }
  /** Register the exact handler identity. */
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  /** Remove a registered handler during detach. */
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  /** Deliver explicit mock pointer events. */
  dispatch(name, event) { for (const callback of this.listeners.get(name) || []) callback(event); }
  /** Accept accessibility attributes on the copy button. */
  setAttribute() {}
  /** Observe hover-control removal. */
  remove() { this.removed = true; }
}

/** Create a initialized reader with manually advanced hover timers and two logical pages. */
function hoverReader(itemID) {
  const doc = new EventTargetMock();
  const button = new EventTargetMock();
  const timers = new Map();
  let nextTimer = 0;
  const host = {
    setTimeout(callback, delay) { timers.set(++nextTimer, {callback, delay}); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  };
  const pageNode = {
    dataset:{pageNumber:'1'},
    closest(selector) { return selector === '.page[data-page-number]' ? this : null; },
    getBoundingClientRect() { return {left:0, top:0, width:100, height:100}; }
  };
  const page = {div:pageNode, viewport:{width:100, height:100,
    convertToPdfPoint:(x, y) => [x, y], convertToViewportRectangle:value => value}};
  const bus = new EventTargetMock();
  doc.createElement = () => button;
  doc.documentElement = {append() {}};
  const frame = {document:doc, innerWidth:1000, innerHeight:1000,
    PDFViewerApplication:{pdfViewer:{getPageView:() => page},
      eventBus:{on:(name, callback) => bus.addEventListener(name, callback),
        off:(name, callback) => bus.removeEventListener(name, callback)}}};
  const view = {initializedPromise:Promise.resolve(), _iframeWindow:frame, _pdfPages:[{overlays:[]}, {overlays:[]}]};
  const reader = {itemID, _type:'pdf', _initPromise:Promise.resolve(), _window:host,
    _iframeWindow:new EventTargetMock(), _internalReader:{_primaryView:view, setA11yMessage() {}}};
  return {reader, doc, button, pageNode,
    move:() => doc.dispatch('pointermove', {target:pageNode, clientX:10, clientY:10}),
    /** Run only detection callbacks; no wall-clock waits or native UI operations occur. */
    async runHover() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== TEST_HOVER_DELAY_MS) continue;
        timers.delete(id);
        await timer.callback();
      }
    }
  };
}

/** Preserve delimiters, native TeX, geometry and clipboard failure safety while pinning profile. */
test('copy pins the DeepSeek key and URL without changing the active compatible profile', async () => {
  const f = fixture();
  const reader = {itemID:1};
  const selection = {text:'x2/yi', glyphs:[]};
  assert.equal(await f.formulas.copy(reader, selection, false), '$\\frac{x^2}{y_i}$');
  assert.equal(await f.formulas.copy(reader, selection, true), '$$\\frac{x^2}{y_i}$$');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.keyProfiles, ['deepseek']);
  assert.deepEqual(f.configurationProfiles, ['deepseek']);
  assert.equal(f.requests[0].payload.api_key, 'MOCK_DEEPSEEK_KEY');
  assert.equal(f.requests[0].payload.base_url, 'https://deepseek.example.invalid');
  assert.equal(Object.hasOwn(f.requests[0].payload, 'model'), false);
  assert.equal(f.bridge.pref('profile'), 'compatible');
  await f.formulas.copy(reader, null, false, '\\[x^2\\]');
  assert.equal(f.clipboard(), '$x^2$');
  assert.equal(f.requests.length, 1);
  f.bridge.request = async () => { throw new Error('provider failed'); };
  await assert.rejects(() => f.formulas.copy({itemID:2}, selection, false), /provider failed/);
  assert.equal(f.clipboard(), '$x^2$');

  reader._internalReader = {_primaryView:{_pdfPages:[{chars:[
    {c:'2', rect:[1, 2, 3, 4]}, {c:'outside', rect:[50, 50, 51, 51]}
  ]}]}};
  const payload = f.formulas.selection(reader, {text:'x2', position:{pageIndex:0, rects:[[0, 0, 4, 5]]}});
  assert.equal(payload.glyphs.length, 1);
  assert.equal(payload.glyphs[0].c, '2');
});

/** Optional cache faults warn visibly after successful copy, never conceal clipboard/provider faults. */
test('known native/provider TeX remains copyable when optional cache persistence fails', async () => {
  const f = fixture();
  const selection = {text:'native', glyphs:[]};
  const originalContext = f.cache.context;
  f.cache.store = async () => { throw new Error('mock disk full'); };
  assert.equal(await f.formulas.copy({itemID:1}, selection, false, 'x'), '$x$');
  assert.equal(f.requests.length, 0);
  assert.match(f.warnings[0], /公式已复制.*缓存未保存/);
  assert.match(f.cache.lastError, /mock disk full/);
  f.cache.context = async () => { throw new Error('mock cache unavailable'); };
  assert.equal(await f.formulas.copy({itemID:1}, selection, true, 'y'), '$$y$$');
  assert.equal(f.warnings.length, 2);
  f.cache.context = originalContext;
  assert.equal(await f.formulas.copy({itemID:2}, {text:'provider', glyphs:[]}, false), '$\\frac{x^2}{y_i}$');
  assert.equal(f.warnings.length, 3);
  assert.equal(f.requests.length, 1);
  const previousClipboard = f.clipboard();
  f.scope.Cc['@mozilla.org/widget/clipboardhelper;1'].getService = () => ({
    copyString() { throw new Error('mock clipboard unavailable'); }
  });
  await assert.rejects(() => f.formulas.copy({itemID:1}, null, false, 'z'), /clipboard unavailable/);
  assert.equal(f.clipboard(), previousClipboard);
  assert.equal(f.warnings.length, 3);
});

/** Failed/invalid detection never becomes an empty persistent result; successful empty pages may cache. */
test('regions are non-interactive, retryable after failure and concurrently deduplicated', async () => {
  const f = fixture();
  const reader = {itemID:1};
  let response;
  f.bridge.request = async (route, method, payload, options) => {
    f.requests.push({route, method, payload, options});
    if (!response) throw new Error('mock engine unavailable');
    await new Promise(resolve => setTimeout(resolve, 5));
    return response;
  };
  await assert.rejects(() => f.formulas.regions(reader, 0), /engine unavailable/);
  assert.equal(f.pages.size, 0);
  assert.equal(f.formulas.regionRequests.size, 0);
  response = {regions:null};
  await assert.rejects(() => f.formulas.regions(reader, 0), /返回格式无效/);
  assert.equal(f.pages.size, 0);
  response = {regions:[]};
  assert.equal((await f.formulas.regions(reader, 0)).length, 0);
  assert.equal((await f.formulas.regions(reader, 0)).length, 0);
  assert.equal(f.requests.length, 3, 'the successful empty page is cached, not a failure');
  await Promise.all([f.formulas.regions(reader, 1), f.formulas.regions(reader, 1)]);
  assert.equal(f.requests.length, 4, 'concurrent region calls share one request');
  assert.equal(f.formulas.regionRequests.size, 0);
  for (const request of f.requests) assert.equal(request.options.interactive, false);
});

/** Use pointer/timer mocks to prove bounded recovery and symmetric reader cleanup. */
test('hover allows one cooldown retry, requires explicit reset after two failures and detaches cleanly', async () => {
  const f = fixture();
  const ui = hoverReader(1);
  let available = false;
  f.bridge.request = async (route, method, payload, options) => {
    f.requests.push({route, method, payload, options});
    if (!available) throw new Error('mock engine unavailable');
    return {regions:[]};
  };
  await f.formulas.attach(ui.reader);
  assert.equal(f.requests.length, 0, 'attach alone never requests a provider or engine');
  ui.move();
  await ui.runHover();
  for (let index = 0; index < 5; index++) { ui.move(); await ui.runHover(); }
  assert.equal(f.requests.length, 1);
  available = true;
  f.clock.now += TEST_RETRY_ADVANCE_MS;
  ui.move();
  await ui.runHover();
  assert.equal(f.requests.length, 2, 'a temporary failure recovers on the bounded retry');

  ui.pageNode.dataset.pageNumber = '2';
  available = false;
  ui.move();
  await ui.runHover();
  f.clock.now += TEST_RETRY_ADVANCE_MS;
  ui.move();
  await ui.runHover();
  f.clock.now += TEST_RETRY_ADVANCE_MS;
  ui.move();
  await ui.runHover();
  assert.equal(f.requests.length, 4, 'two failures do not trigger endless automatic retries');
  assert.equal(f.pages.has('1:1'), false, 'failed page detection is not cached as empty');
  assert.equal(f.warnings.length, 0, 'background errors never open a progress warning window');
  available = true;
  await f.formulas.copy(ui.reader, null, false, 'x');
  ui.move();
  await ui.runHover();
  assert.equal(f.requests.length, 5, 'explicit user copy resets the bounded failure state');
  for (const request of f.requests) assert.equal(request.options.interactive, false);
  f.formulas.detach(ui.reader);
  f.formulas.detach(ui.reader);
  assert.equal(f.formulas.readers.size, 0);
  assert.equal(ui.button.removed, true);
  assert.equal(ui.doc.listeners.get('pointermove').size, 0);
  await f.formulas.stop();
});
