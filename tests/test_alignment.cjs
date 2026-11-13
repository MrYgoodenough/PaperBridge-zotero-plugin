/** Mock-only contract, geometry, explicit-navigation, and cleanup tests for alignment.js. */
// Built-in modules keep this frontend suite independent of Zotero and new dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
// Resolve from this file so the suite also runs outside the repository root.
const moduleSource = fs.readFileSync(path.join(__dirname, '../addon/content/alignment.js'), 'utf8');

/** Implement only DOM/event-bus registration used by the module. */
class Events {
  /** Initialize isolated listeners for each mock surface. */
  constructor() { this.listeners = new Map(); }
  /** Retain listener options so passive behavior can be asserted. */
  addEventListener(type, handler, options) {
    const entries = this.listeners.get(type) || [];
    entries.push({ handler, options });
    this.listeners.set(type, entries);
  }
  /** Remove only the supplied handler. */
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.handler !== handler));
  }
  /** Match the established PDF.js event-bus API. */
  on(type, handler) { this.addEventListener(type, handler); }
  /** Match the established PDF.js event-bus cleanup API. */
  off(type, handler) { this.removeEventListener(type, handler); }
  /** Deliver a deterministic event without any browser or native API. */
  emit(type, event = {}) {
    for (const { handler } of [...(this.listeners.get(type) || [])]) handler(event);
  }
  /** Count retained listeners for closure assertions. */
  count() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0); }
}

/** Model the small DOM subset needed for controls and transient overlays. */
class Element extends Events {
  /** Create an inspectable element with ordinary style and attribute storage. */
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag;
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.isConnected = true;
  }
  /** Store a DOM attribute without HTML parsing. */
  setAttribute(name, value) { this.attributes[name] = String(value); }
  /** Read one page-number or accessibility attribute. */
  getAttribute(name) { return this.attributes[name] ?? null; }
  /** Attach children to support overlay removal assertions. */
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  /** Detach a node idempotently. */
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
    this.isConnected = false;
  }
  /** Resolve only PDF.js page ancestors, not toolbar elements. */
  closest(selector) {
    if (selector === '.page[data-page-number]' && this.attributes['data-page-number']) return this;
    return this.parent?.closest(selector) || null;
  }
  /** Return the fixture's CSS border box. */
  getBoundingClientRect() { return this.box; }
}

/** Create a document with no actual browser access. */
class Document extends Events {
  /** Construct one isolated element in this mock document. */
  createElement(tag) { return new Element(this, tag); }
}

/** Build an affine viewport with crop offsets, rotation, scale, and conversion tracing. */
function viewport(transform, width, height) {
  const [a, b, c, d, e, f] = transform;
  const calls = { pdf: [], rect: [] };
  return {
    width, height, calls,
    /** Invert the affine transform as PDF.js convertToPdfPoint does. */
    convertToPdfPoint(x, y) {
      calls.pdf.push([x, y]);
      const determinant = a * d - b * c;
      return [(d * (x - e) - c * (y - f)) / determinant,
        (-b * (x - e) + a * (y - f)) / determinant];
    },
    /** Transform scalar PDF endpoints without sharing caller-owned arrays. */
    convertToViewportPoint(x, y) {
      calls.rect.push([x, y]);
      return [a * x + c * y + e, b * x + d * y + f];
    },
  };
}

/** Create a rendered page with asymmetric viewport dimensions and a scaled CSS border box. */
function page(doc, pageIndex, pageViewport) {
  const div = doc.createElement('div');
  div.setAttribute('data-page-number', pageIndex + 1);
  div.clientWidth = pageViewport.width;
  div.clientHeight = pageViewport.height;
  div.clientLeft = 5;
  div.clientTop = 5;
  div.offsetWidth = div.clientWidth + 10;
  div.offsetHeight = div.clientHeight + 10;
  div.box = { left: 100, top: 200, width: div.offsetWidth * 1.5, height: div.offsetHeight * 1.5 };
  return { div, viewport: pageViewport, renderingState: 3 };
}

/** Supply the exact fixed backend shape; hashes are opaque parent-validated strings here. */
function mapping() {
  return { schema_version: 1, coordinate_space: 'pdf-user-space', source_sha256: 'source', output_sha256: 'output',
    units: [{ id: 'fragment-1', status: 'verified',
      source: { page: 1, rects: [[-20, 40, 10, 60], [-15, 65, 5, 75]] },
      target: { page: 0, rects: [[10, 20, 30, 40]] } }] };
}

/** Build a split using only reader APIs already used by PaperBridge. */
function fixture(options = {}) {
  const clones = [];
  const context = vm.createContext({ Components: { utils: {
    /** Simulate cross-compartment cloning and record the intended source frame. */
    cloneInto(value, frame) {
      clones.push({ value, frame });
      return JSON.parse(JSON.stringify(value));
    },
  } } });
  vm.runInContext(moduleSource, context);
  const Alignment = context.FragmentAlignment;
  const leftDoc = new Document();
  const rightDoc = new Document();
  // Source is rotated 180 degrees with a negative crop origin; target is rotated 90 degrees.
  const leftViewport = viewport([-2, 0, 0, 2, 100, -40], 400, 600);
  const rightViewport = viewport([0, 3, 3, 0, -30, -15], 300, 450);
  const leftPage = page(leftDoc, 1, leftViewport);
  const rightPage = page(rightDoc, 0, rightViewport);
  const timers = new Map();
  let timerId = 0;
  const destinations = [];
  const leftBus = new Events();
  const rightBus = new Events();
  const leftViewer = {
    pagesCount: 3, currentScaleValue: 'original-scale',
    /** Return the original page without touching PDF files. */
    getPageView(index) { return index === 1 ? leftPage : undefined; },
    /** Capture the established page-coordinate navigation API. */
    scrollPageIntoView(destination) {
      if (options.navigationError) throw new Error('mock navigation failure');
      destinations.push(destination);
      leftBus.emit('pagechanging', { pageNumber: destination.pageNumber });
    },
  };
  const rightViewer = {
    pagesCount: 1, currentScaleValue: 'translation-scale',
    /** Return only the translated page. */
    getPageView(index) { return index === 0 ? rightPage : undefined; },
  };
  const leftFrame = { document: leftDoc, PDFViewerApplication: { pdfViewer: leftViewer, eventBus: leftBus },
    /** Keep visual timers deterministic and local to this fixture. */
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    /** Cancel one recorded timer without waiting in real time. */
    clearTimeout(id) { timers.delete(id); },
  };
  const rightFrame = { document: rightDoc, PDFViewerApplication: { pdfViewer: rightViewer, eventBus: rightBus } };
  const state = { reader: { _internalReader: { _primaryView: { _iframeWindow: leftFrame } } },
    right: { _primaryView: { _iframeWindow: rightFrame } }, cleanups: [], active: 1, sync: true };
  const controller = new Alignment(options);
  return { Alignment, controller, state, leftPage, rightPage, leftViewport, rightViewport,
    leftDoc, rightDoc, leftBus, rightBus, timers, destinations, clones, leftFrame, leftViewer, rightViewer };
}

/** Release inside the translated rectangle using CSS coordinates, not assumed page heights. */
function pointer(f, eventOverrides = {}) {
  // Target PDF point (20, 30) becomes viewport point (60, 45), then receives CSS border scaling.
  let prevented = false;
  const event = { target: f.rightPage.div, button: 0, isPrimary: true,
    clientX: 100 + (60 + 5) * 1.5, clientY: 200 + (45 + 5) * 1.5,
    /** Detect accidental cancellation of native selection or links. */
    preventDefault() { prevented = true; }, ...eventOverrides };
  f.rightDoc.emit('pointerup', event);
  return prevented;
}

/** Invoke the returned control exactly as an explicit toolbar click would. */
function click(control) { control.children[0].emit('click'); }

/** Run every registered split cleanup, matching PaperBridge.closeSplit. */
function close(f) { for (const cleanup of f.state.cleanups) cleanup(); }

test('schema checks reject malformed contracts without validating files or hash contents', () => {
  const { Alignment } = fixture();
  assert.equal(Alignment.checkMapping(mapping()).mapping.units.length, 1);
  const changes = [
    value => { value.schema_version = 2; },
    value => { value.coordinate_space = 'viewport'; },
    value => { value.source_sha256 = 123; },
    value => { value.units[0].status = 'unverified'; },
    value => { value.units[0].source.page = -1; },
    value => { value.units[0].target.page = 0.5; },
    value => { value.units[0].source.rects = []; },
    value => { value.units[0].target.rects = [[0, 0, NaN, 10]]; },
    value => { value.units[0].target.rects = [[10, 0, 0, 10]]; },
    value => { value.units.push({ ...value.units[0] }); },
  ];
  for (const change of changes) {
    const value = mapping();
    change(value);
    assert.equal(Alignment.checkMapping(value).mapping, null);
  }
  assert.equal(Alignment.checkMapping({ ...mapping(), units: [] }).mapping, null);
});

test('hit testing distinguishes unique, missing, and overlapping rectangle hits', () => {
  const { Alignment } = fixture();
  const value = mapping();
  assert.equal(Alignment.hitTest(value, 0, [20, 30]).status, 'unique');
  assert.equal(Alignment.hitTest(value, 1, [20, 30]).status, 'miss');
  assert.equal(Alignment.hitTest(value, 0, [0, 0]).status, 'miss');
  value.units.push({ ...value.units[0], id: 'overlap' });
  assert.equal(Alignment.hitTest(value, 0, [20, 30]).status, 'ambiguous');
  value.units.pop();
  value.units[0].target.rects.push([20, 30, 40, 50]);
  assert.equal(Alignment.hitTest(value, 0, [20, 30]).status, 'ambiguous');
  assert.equal(Alignment.hitTest(value, 0, [15, 25]).status, 'unique');
  value.units[0].target.rects = [[10, 20, 20, 40], [20, 20, 30, 40]];
  assert.equal(Alignment.hitTest(value, 0, [20, 30]).status, 'ambiguous');
});

test('viewport geometry handles crop offsets, rotation, borders, CSS scale, and outside points', () => {
  const f = fixture();
  const result = f.Alignment.pdfPoint(f.rightPage, 197.5, 275);
  assert.deepEqual(Array.from(result), [20, 30]);
  assert.deepEqual(f.rightViewport.calls.pdf, [[60, 45]]);
  assert.equal(f.Alignment.pdfPoint(f.rightPage, 100, 200), null);
  assert.equal(f.Alignment.pdfPoint(f.rightPage, 10000, 200), null);
  assert.deepEqual(Array.from(f.Alignment.viewportRect(f.leftViewport, [-20, 40, 10, 60])), [80, 40, 140, 80]);
  // A 270-degree viewport reverses the other axis independently of the source viewport.
  const rotated = viewport([0, -4, -4, 0, 500, 400], 500, 400);
  assert.deepEqual(Array.from(f.Alignment.viewportRect(rotated, [10, 20, 30, 40])), [340, 280, 420, 360]);
  // The ordinary unrotated viewport also includes a crop offset, not just a page-height flip.
  const unrotated = viewport([2, 0, 0, -2, -20, 200], 400, 600);
  assert.deepEqual(Array.from(f.Alignment.viewportRect(unrotated, [10, 20, 30, 40])), [0, 120, 40, 160]);
});

test('pointerup remembers a hit but only the toolbar action navigates and paints source rectangles', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  const listener = f.rightDoc.listeners.get('pointerup')[0];
  assert.equal(listener.options.passive, true);
  assert.equal(listener.options.capture, true);
  // Reader and event wrappers can differ while referring to the same native DOM page.
  const pageWrapper = { getAttribute: name => f.rightPage.div.getAttribute(name) };
  f.rightPage.div.isSameNode = candidate => candidate === pageWrapper;
  pointer(f, { target: { closest: () => pageWrapper } });
  assert.deepEqual(Array.from(f.controller.point.point), [20, 30]);
  assert.equal(pointer(f), false);
  pointer(f, { target: control.children[0] });
  assert.equal(f.destinations.length, 0);
  assert.deepEqual(Array.from(f.controller.point.point), [20, 30]);
  click(control);
  assert.deepEqual(f.destinations, [{ pageNumber: 2,
    destArray: [null, { name: 'XYZ' }, -20, 60, null], allowNegativeOffset: true }]);
  assert.equal(f.clones[0].frame, f.leftFrame);
  assert.deepEqual(f.leftViewport.calls.rect, [[-20, 40], [10, 60], [-15, 65], [5, 75]]);
  assert.equal(f.rightViewport.calls.rect.length, 0);
  const overlay = f.leftPage.div.children[0];
  assert.equal(overlay.children.length, 2);
  assert.equal(overlay.children[0].style.left, '80px');
  assert.equal(overlay.children[0].style.top, '40px');
  assert.equal(overlay.children[0].style.width, '60px');
  assert.equal(overlay.children[0].style.height, '40px');
  assert.match(overlay.style.cssText, /pointer-events:none/);
  assert.equal(f.state.active, 1);
  assert.equal(f.state.sync, true);
  assert.equal(f.leftViewer.currentScaleValue, 'original-scale');
  assert.equal(f.rightViewer.currentScaleValue, 'translation-scale');
  assert.ok(f.state.alignmentNavigationUntil > Date.now());
  assert.equal(f.timers.size, 1);
  close(f);
});

test('toolbar, secondary, and non-primary pointer releases do not create a remembered PDF hit', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  pointer(f, { target: control.children[0] });
  pointer(f, { button: 2 });
  pointer(f, { isPrimary: false });
  click(control);
  assert.equal(f.destinations.length, 0);
  assert.match(control.children[1].textContent, /先点击/);
  close(f);
});

test('overlaps and misses show nonfatal status instead of guessing a source', () => {
  for (const mode of ['overlap', 'miss']) {
    const f = fixture();
    const value = mapping();
    if (mode === 'overlap') value.units.push({ ...value.units[0], id: 'another' });
    else value.units[0].target.rects = [[100, 100, 110, 110]];
    const control = f.controller.attach(f.state, value);
    pointer(f);
    click(control);
    assert.equal(f.destinations.length, 0);
    assert.match(control.children[1].textContent, mode === 'overlap' ? /重叠/ : /没有已验证/);
    assert.equal(control.children[0].disabled, false);
    assert.equal(f.state.sync, true);
    close(f);
  }
});

test('missing or broken mappings have visible reasons without disabling the reader', () => {
  for (const value of [null, { ...mapping(), coordinate_space: 'invalid' }]) {
    const f = fixture();
    const control = f.controller.attach(f.state, value, value ? '' : 'Parent: hash mismatch');
    assert.equal(control.children[0].disabled, true);
    assert.match(control.children[1].textContent, value ? /格式/ : /hash mismatch/);
    pointer(f);
    click(control);
    assert.equal(f.destinations.length, 0);
    assert.equal(f.state.sync, true);
    close(f);
  }
});

test('unavailable navigation APIs remain a visible optional-feature failure', () => {
  const f = fixture();
  delete f.leftViewer.scrollPageIntoView;
  const control = f.controller.attach(f.state, mapping());
  assert.match(control.children[1].textContent, /接口不可用/);
  assert.equal(control.children[0].disabled, true);
  assert.equal(f.rightDoc.count(), 0);
  close(f);
  assert.equal(control.children[0].count(), 0);
});

test('invalid source page and navigation failures neither clamp nor break ordinary reading', () => {
  for (const mode of ['page', 'navigation']) {
    const f = fixture({ navigationError: mode === 'navigation' });
    const value = mapping();
    if (mode === 'page') value.units[0].source.page = 8;
    const control = f.controller.attach(f.state, value);
    pointer(f);
    assert.doesNotThrow(() => click(control));
    assert.equal(f.destinations.length, 0);
    assert.equal(f.leftPage.div.children.length, 0);
    assert.match(control.children[1].textContent, mode === 'page' ? /页不存在/ : /mock navigation failure/);
    assert.equal(f.state.sync, true);
    close(f);
  }
});

test('close removes controls, overlays, listeners, timers, and owned sync suppression', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  pointer(f);
  click(control);
  close(f);
  close(f);
  assert.equal(f.leftPage.div.children.length, 0);
  assert.equal(f.rightDoc.count(), 0);
  assert.equal(f.leftBus.count(), 0);
  assert.equal(f.rightBus.count(), 0);
  assert.equal(control.children[0].count(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal(control.isConnected, false);
  assert.equal(f.state.alignmentNavigationUntil, 0);
  pointer(f);
  click(control);
  assert.equal(f.destinations.length, 1);
});

test('temporary highlight expires without a render-readiness deadline', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  pointer(f);
  click(control);
  const timer = [...f.timers.values()][0];
  assert.equal(timer.ms, f.Alignment.HIGHLIGHT_MS);
  timer.callback();
  assert.equal(f.leftPage.div.children.length, 0);
  assert.equal(f.timers.size, 0);
  close(f);
});

test('zoom, rotation, page changes, and relevant rerenders remove stale overlays and points', () => {
  const scenarios = [
    ['leftBus', 'scalechanging', {}], ['rightBus', 'scalechanging', {}],
    ['leftBus', 'rotationchanging', {}], ['rightBus', 'rotationchanging', {}],
    ['leftBus', 'pagechanging', { pageNumber: 3 }], ['rightBus', 'pagechanging', { pageNumber: 1 }],
    ['leftBus', 'pagerendered', { pageNumber: 2 }], ['rightBus', 'pagerendered', { pageNumber: 1 }],
    ['leftBus', 'pagesdestroy', {}], ['rightBus', 'pagesdestroy', {}],
  ];
  for (const [bus, type, event] of scenarios) {
    const f = fixture();
    const control = f.controller.attach(f.state, mapping());
    pointer(f);
    click(control);
    f[bus].emit(type, event);
    assert.equal(f.leftPage.div.children.length, 0, `${bus}/${type}`);
    assert.equal(f.timers.size, 0, `${bus}/${type}`);
    if (bus === 'rightBus') assert.equal(f.controller.point, null);
    close(f);
  }
});

test('unrelated page rendering does not discard the current point or highlight', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  pointer(f);
  click(control);
  f.leftBus.emit('pagerendered', { pageNumber: 1 });
  f.rightBus.emit('pagerendered', { pageNumber: 2 });
  assert.equal(f.leftPage.div.children.length, 1);
  assert.ok(f.controller.point);
  close(f);
});

test('a pending source highlight waits for its page and is cancelled on close', () => {
  const f = fixture();
  f.leftPage.renderingState = 0;
  const control = f.controller.attach(f.state, mapping());
  pointer(f);
  click(control);
  assert.equal(f.destinations.length, 1);
  assert.equal(f.timers.size, 0);
  f.leftBus.emit('pagerendered', { pageNumber: 1 });
  assert.ok(f.controller.pending);
  assert.equal(f.leftViewport.calls.rect.length, 0);
  f.leftPage.renderingState = 3;
  f.leftBus.emit('pagerendered', { pageNumber: 2 });
  assert.equal(f.leftPage.div.children.length, 1);
  close(f);
  f.leftBus.emit('pagerendered', { pageNumber: 2 });
  assert.equal(f.leftPage.div.children.length, 0);

  const waiting = fixture();
  waiting.leftPage.renderingState = 0;
  const waitingControl = waiting.controller.attach(waiting.state, mapping());
  pointer(waiting);
  click(waitingControl);
  assert.ok(waiting.controller.pending);
  close(waiting);
  waiting.leftPage.renderingState = 3;
  waiting.leftBus.emit('pagerendered', { pageNumber: 2 });
  assert.equal(waiting.controller.pending, null);
  assert.equal(waiting.leftPage.div.children.length, 0);
  assert.equal(waiting.timers.size, 0);
});

test('unfinished translated pages cannot provide a potentially incorrect placeholder viewport', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  f.rightPage.renderingState = 0;
  pointer(f);
  assert.equal(f.controller.point, null);
  assert.equal(f.rightViewport.calls.pdf.length, 0);
  assert.match(control.children[1].textContent, /仍在渲染/);
  f.rightPage.renderingState = 3;
  pointer(f);
  click(control);
  assert.equal(f.destinations.length, 1);
  close(f);
});

test('parent load callback supplies mappings or reasons and never restores a closed split', async () => {
  const f = fixture({ loadMapping: async () => ({ mapping: mapping() }) });
  const control = f.controller.attach(f.state);
  assert.match(control.children[1].textContent, /正在读取/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.children[0].disabled, false);
  close(f);

  const missing = fixture({ loadMapping: async () => ({ mapping: null, reason: 'Parent: output changed' }) });
  const missingControl = missing.controller.attach(missing.state);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(missingControl.children[1].textContent, /output changed/);
  close(missing);

  const broken = fixture({ loadMapping: async () => { throw new Error('Parent: unavailable'); } });
  const brokenControl = broken.controller.attach(broken.state);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(brokenControl.children[1].textContent, /unavailable/);
  close(broken);

  let resolveLoad;
  const late = fixture({ loadMapping: () => new Promise(resolve => { resolveLoad = resolve; }) });
  const lateControl = late.controller.attach(late.state);
  await new Promise(resolve => setImmediate(resolve));
  close(late);
  resolveLoad({ mapping: mapping() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.controller.mapping, null);
  assert.equal(lateControl.isConnected, false);
  assert.equal(late.leftBus.count(), 0);
  assert.equal(late.rightDoc.count(), 0);
});
