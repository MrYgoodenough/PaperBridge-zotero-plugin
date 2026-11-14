/** Mock-only geometry, explicit DOM localization, native CSS hover, and cleanup contracts. */
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
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.isConnected = true;
    this.classList = {
      /** Check a CSS token without a browser CSS engine. */
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  /** Expose native parent names while retaining existing fixture assertions. */
  get parentNode() { return this.parent || null; }
  /** Resolve native text-item and search-markup ancestors. */
  get parentElement() { return this.parentNode; }
  /** Propagate page/text-layer detachment to range containers. */
  get isConnected() { return this.connected && this.parent?.isConnected !== false; }
  /** Retain local attachment state for mock DOM moves. */
  set isConnected(value) { this.connected = value; }
  /** Store a DOM attribute without HTML parsing. */
  setAttribute(name, value) { this.attributes[name] = String(value); }
  /** Read one page-number or accessibility attribute. */
  getAttribute(name) { return this.attributes[name] ?? null; }
  /** Attach children to support overlay removal assertions. */
  append(...children) {
    for (const child of children) this.insertBefore(child, null);
  }
  /** Support ordinary DOM appendChild without introducing HTML parsing. */
  appendChild(child) { this.append(child); return child; }
  /** Place an overlay between native layers, moving an existing node if needed. */
  insertBefore(child, reference) {
    if (reference === child) return child;
    if (reference !== null && !this.children.includes(reference)) throw new Error('Unknown reference node');
    child.remove();
    child.parent = this;
    child.isConnected = true;
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    return child;
  }
  /** Detach a node idempotently. */
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
    this.isConnected = false;
  }
  /** Match simple tags, classes, IDs, and attributes used by reader filters. */
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim();
      const tag = simple.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = simple.match(/#([\w-]+)/)?.[1];
      if (id && (this.id || this.attributes.id) !== id) return false;
      if ([...simple.matchAll(/\.([\w-]+)/g)].some(match => !this.classList.contains(match[1]))) return false;
      for (const [, name, value] of simple.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        const actual = this.getAttribute(name);
        if (actual === null || (value !== undefined && actual !== value)) return false;
      }
      return !!simple;
    });
  }
  /** Resolve page and interactive ancestors with the same fixture nodes. */
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) || null;
  }
  /** Find one descendant native layer by a simple selector. */
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  /** Traverse real fixture descendants, including nested native search spans. */
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  /** Return the fixture's CSS border box. */
  getBoundingClientRect() { return this.box; }
}

/** Create a document with no actual browser access. */
class Document extends Events {
  /** Track only the rendered fixture pages for stationary-pointer refreshes. */
  constructor() {
    super();
    this.pageViews = [];
    this.head = this.createElement('head');
    this.selection = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 1,
      /** Native text selection must never be commandeered for hover paint. */
      removeAllRanges() { throw new Error('Hover modified native selection'); },
      /** Native selection is independent of custom highlight ranges. */
      addRange() { throw new Error('Hover modified native selection'); },
    };
  }
  /** Construct one isolated element in this mock document. */
  createElement(tag) { return new Element(this, tag); }
  /** Return the existing native selection without changing it. */
  getSelection() { return this.selection; }
  /** Model whole-node range geometry, never word-level range guesses. */
  createRange() {
    return { startContainer: null, endContainer: null,
      /** Selecting node contents must retain the entire top-level text item. */
      selectNodeContents(span) { this.startContainer = span; this.endContainer = span; },
      /** Derive native text rectangles independently of the production painter. */
      getClientRects() {
        return this.startContainer?.isConnected ? this.startContainer.rangeRects?.() || [] : [];
      },
    };
  }
  /** Resolve visible fixture pages using screen coordinates, not assumed PDF geometry. */
  elementFromPoint(x, y) {
    return this.pageViews.find(({ div }) => {
      const box = div.getBoundingClientRect();
      return div.isConnected && x >= box.left && x <= box.left + box.width
        && y >= box.top && y <= box.top + box.height;
    })?.div || null;
  }
}

/** Model the public CSS Highlight range set without writing PDF DOM or native selection. */
class Highlight extends Set {
  /** Initialize native ranges and the browser's default search-highlight priority. */
  constructor(...ranges) { super(ranges); this.priority = 0; }
}

/** Build an affine viewport with crop offsets, rotation, scale, and conversion tracing. */
function viewport(transform, width, height) {
  const [a, b, c, d, e, f] = transform;
  const calls = { pdf: [], rect: [] };
  return {
    width, height, calls, transform,
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
  div.className = 'page';
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

/** Independently project fixed PDF text geometry into scaled CSS client rectangles. */
function textRect(pageView, rect) {
  const { div, viewport } = pageView;
  const [a, b, c, d, e, f] = viewport.transform;
  const points = [[rect[0], rect[1]], [rect[0], rect[3]], [rect[2], rect[1]], [rect[2], rect[3]]]
    .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const bounds = div.getBoundingClientRect();
  const cssX = bounds.width / div.offsetWidth;
  const cssY = bounds.height / div.offsetHeight;
  const left = bounds.left + (div.clientLeft + Math.min(...points.map(point => point[0])) * div.clientWidth / viewport.width) * cssX;
  const top = bounds.top + (div.clientTop + Math.min(...points.map(point => point[1])) * div.clientHeight / viewport.height) * cssY;
  const right = bounds.left + (div.clientLeft + Math.max(...points.map(point => point[0])) * div.clientWidth / viewport.width) * cssX;
  const bottom = bounds.top + (div.clientTop + Math.max(...points.map(point => point[1])) * div.clientHeight / viewport.height) * cssY;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Seed an actual native text item with independent, possibly multiline range rectangles. */
function textItem(pageView, parent, label, rects) {
  const span = pageView.div.ownerDocument.createElement('span');
  span.textContent = label;
  span.style.cssText = 'font-size:12px;color:transparent;transform:scaleX(1.1)';
  /** Native geometry follows the page's current viewport, not the hover mapping. */
  span.rangeRects = () => rects.map(rect => textRect(pageView, rect));
  parent.append(span);
  return span;
}

/** Provide native text, marked content, and nested search markup without hover-owned nodes. */
function textLayer(pageView, source) {
  const doc = pageView.div.ownerDocument;
  const layer = doc.createElement('div');
  layer.className = 'textLayer';
  layer.style.cssText = 'opacity:.2;color:transparent';
  pageView.div.append(layer);
  const first = textItem(pageView, layer, 'Whole first item', source
    ? [[-18, 42, 8, 58], [-13, 66, 3, 74]] : [[11, 21, 29, 28], [12, 32, 28, 38]]);
  const wrapper = doc.createElement('span');
  wrapper.className = 'markedContent';
  layer.append(wrapper);
  const second = textItem(pageView, wrapper, 'Whole searchable item', source ? [[-15, 45, -5, 50]] : [[14, 23, 18, 26]]);
  const search = textItem(pageView, second, 'search', source ? [[-14, 46, -12, 48]] : [[15, 24, 17, 25]]);
  search.className = 'highlight selected';
  const other = textItem(pageView, layer, 'Another request', source ? [[31, 91, 39, 99]] : [[51, 61, 59, 69]]);
  const straddling = textItem(pageView, layer, 'Item crosses request bounds', source
    ? [[-19, 42, -17, 45], [-10, 80, 0, 82]] : [[10, 22, 12, 24], [35, 22, 38, 24]]);
  textItem(pageView, straddling, 'inside word', source ? [[-19, 42, -17, 45]] : [[10, 22, 12, 24]]);
  return { layer, first, second, other, straddling, search };
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
  const nativeText = { source: textLayer(leftPage, true), target: textLayer(rightPage, false) };
  for (const [doc, side] of [[leftDoc, 'source'], [rightDoc, 'target']]) {
    Object.assign(doc.selection, { anchorNode: nativeText[side].second, focusNode: nativeText[side].second, focusOffset: 5 });
  }
  leftDoc.pageViews.push(leftPage);
  rightDoc.pageViews.push(rightPage);
  const timers = new Map();
  let timerId = 0;
  const destinations = [];
  const leftBus = new Events();
  const rightBus = new Events();
  const leftViewer = {
    pagesCount: 3, currentScaleValue: 'original-scale',
    container: leftDoc.createElement('div'),
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
    container: rightDoc.createElement('div'),
    /** Return only the translated page. */
    getPageView(index) { return index === 0 ? rightPage : undefined; },
  };
  const leftFrame = Object.assign(new Events(), { document: leftDoc, PDFViewerApplication: { pdfViewer: leftViewer, eventBus: leftBus },
    Highlight, CSS: { highlights: new Map() },
    /** Keep visual timers deterministic and local to this fixture. */
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    /** Cancel one recorded timer without waiting in real time. */
    clearTimeout(id) { timers.delete(id); },
  });
  const rightFrame = Object.assign(new Events(), { document: rightDoc, PDFViewerApplication: { pdfViewer: rightViewer, eventBus: rightBus },
    Highlight, CSS: { highlights: new Map() } });
  // RAF stays opt-in so existing cases retain the immediate mock-only fallback.
  let animationFrames = null;
  if (options.animationFrames) {
    const pending = new Map();
    const cancelled = [];
    let frameId = 0;
    animationFrames = { pending, cancelled,
      /** Flush one frame batch; callbacks queued during it wait for another explicit flush. */
      flush() {
        for (const [id, { callback }] of [...pending]) {
          if (pending.delete(id)) callback(0);
        }
      },
    };
    for (const frame of [leftFrame, rightFrame]) {
      /** Record a callback without running it inside the native event. */
      frame.requestAnimationFrame = callback => {
        const id = ++frameId;
        pending.set(id, { frame, callback });
        return id;
      };
      /** Track cancellations, including accidental cancellation of the executing frame. */
      frame.cancelAnimationFrame = id => { cancelled.push(id); pending.delete(id); };
    }
  }
  const state = { reader: { _internalReader: { _primaryView: { _iframeWindow: leftFrame } } },
    right: { _primaryView: { _iframeWindow: rightFrame } }, cleanups: [], active: 1, sync: true };
  const controller = new Alignment(options);
  return { Alignment, controller, state, leftPage, rightPage, leftViewport, rightViewport,
    leftDoc, rightDoc, leftBus, rightBus, timers, destinations, clones, leftFrame, rightFrame, leftViewer, rightViewer,
    animationFrames, nativeText };
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

/** Move over a PDF-native point on either page and detect native-event interference. */
function hover(f, side = 'target', point = side === 'source' ? [-5, 50] : [20, 30], overrides = {}) {
  const pageView = side === 'source' ? f.leftPage : f.rightPage;
  const doc = side === 'source' ? f.leftDoc : f.rightDoc;
  const [x, y] = pageView.viewport.convertToViewportPoint(...point);
  const div = pageView.div;
  const box = div.getBoundingClientRect();
  const cancelled = { prevented: false, stopped: false };
  doc.emit('pointermove', { target: div, pointerType: 'mouse', isPrimary: true, button: -1, buttons: 0,
    clientX: box.left + (x * div.clientWidth / pageView.viewport.width + div.clientLeft) * box.width / div.offsetWidth,
    clientY: box.top + (y * div.clientHeight / pageView.viewport.height + div.clientTop) * box.height / div.offsetHeight,
    /** Detect cancellation of native text, links, and annotation interactions. */
    preventDefault() { cancelled.prevented = true; },
    /** Detect cancellation of native event delivery. */
    stopPropagation() { cancelled.stopped = true; }, ...overrides });
  return cancelled;
}

/** Require the hover pair to be cleared without assumptions about empty-array identity. */
function assertHoverCleared(f, message) {
  assert.equal(f.controller.hoverUnit, null, message);
  assert.ok((f.controller.hoverHighlights || []).every(record => record === null));
  for (const frame of [f.leftFrame, f.rightFrame]) {
    assert.equal(frame.CSS?.highlights?.has('paperbridge-paragraph-hover') || false, false, message);
  }
  for (const pageView of [f.leftPage, f.rightPage]) {
    assert.equal(pageView.div.querySelector('.paperbridge-paragraph-highlight'), null);
  }
}

/** Verify whole native text items, not projected DOM boxes or nested search-word fragments. */
function assertHoverRecord(f, index, unit, spans) {
  const side = index === 0 ? 'source' : 'target';
  const frame = index === 0 ? f.leftFrame : f.rightFrame;
  const record = f.controller.hoverHighlights[index];
  assert.ok(record);
  assert.equal(record.unitID, unit.id);
  assert.equal(record.page, unit[side].page);
  assert.equal(record.isConnected, true);
  assert.equal(record.highlight instanceof frame.Highlight, true);
  assert.equal(record.highlight.priority, -1);
  assert.equal(frame.CSS.highlights.get('paperbridge-paragraph-hover'), record.highlight);
  const containers = Array.from(record.ranges, range => range.startContainer);
  assert.deepEqual(containers.map(span => span.textContent), spans.map(span => span.textContent), `${side}: eligible whole items`);
  for (const [index, container] of containers.entries()) assert.equal(container, spans[index]);
  assert.ok(record.ranges.every(range => range.endContainer === range.startContainer));
  assert.deepEqual(Array.from(record.highlight), Array.from(record.ranges));
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
  const overlay = f.leftPage.div.querySelector('.paperbridge-fragment-highlight');
  assert.equal(overlay.children.length, 2);
  assert.equal(overlay.children[0].style.left, '80px');
  assert.equal(overlay.children[0].style.top, '40px');
  assert.equal(overlay.children[0].style.width, '60px');
  assert.equal(overlay.children[0].style.height, '40px');
  assert.match(overlay.style.cssText, /pointer-events:none/);
  assert.match(overlay.style.cssText, /z-index:30/);
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
    assert.equal(f.controller.hoverButton.disabled, true);
    assert.equal(f.controller.hoverEnabled, false);
    assert.match(control.children[1].textContent, value ? /格式/ : /hash mismatch/);
    pointer(f);
    click(control);
    assert.equal(f.destinations.length, 0);
    assert.equal(f.state.sync, true);
    close(f);
  }
});

test('missing navigation or CSS Highlight APIs disable only their independent feature', () => {
  const f = fixture();
  delete f.leftViewer.scrollPageIntoView;
  const control = f.controller.attach(f.state, mapping());
  assert.match(control.children[1].textContent, /接口不可用/);
  assert.equal(control.children[0].disabled, true);
  assert.equal(f.controller.hoverButton.disabled, false);
  assert.ok(f.rightDoc.listeners.get('pointermove')?.length);
  close(f);
  assert.equal(control.children[0].count(), 0);
  for (const [index, api] of [[0, 'Highlight'], [1, 'Highlight'], [0, 'registry'], [1, 'registry']]) {
    const missing = fixture();
    const frame = index === 0 ? missing.leftFrame : missing.rightFrame;
    if (api === 'Highlight') delete frame.Highlight;
    else delete frame.CSS.highlights;
    const availableControl = missing.controller.attach(missing.state, mapping());
    assert.equal(missing.controller.hoverAvailable, false);
    assert.equal(missing.controller.hoverButton.disabled, true);
    assert.equal(availableControl.children[0].disabled, false);
    hover(missing);
    assertHoverCleared(missing);
    pointer(missing);
    click(availableControl);
    assert.equal(missing.destinations.length, 1);
    assert.ok(missing.controller.highlight);
    assert.equal(missing.state.sync, true);
    close(missing);
  }
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
    assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0);
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
  assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0);
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
  assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0);
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
    assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0, `${bus}/${type}`);
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
  assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 1);
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
  assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 1);
  close(f);
  f.leftBus.emit('pagerendered', { pageNumber: 2 });
  assert.equal(f.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0);

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
  assert.equal(waiting.leftPage.div.querySelectorAll('.paperbridge-fragment-highlight').length, 0);
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

test('whole-request hit testing supports both sides without weakening explicit overlap rejection', () => {
  const { Alignment } = fixture();
  const value = mapping();
  value.units[0].source.rects.push([-10, 45, 15, 70]);
  value.units[0].target.rects.push([20, 30, 40, 50]);
  assert.equal(Alignment.hitTest(value, 0, [20, 30]).status, 'ambiguous');
  for (const [side, pageIndex, point] of [['source', 1, [-5, 50]], ['target', 0, [20, 30]]]) {
    const hit = Alignment.hitTest(value, pageIndex, point, side, true);
    assert.equal(hit.status, 'unique');
    assert.equal(hit.unit, value.units[0]);
    assert.equal(Alignment.hitTest(value, pageIndex, point, side).status, 'ambiguous');
    assert.equal(Alignment.hitTest(value, pageIndex + 3, point, side, true).status, 'miss');
  }
  value.units.push({ ...value.units[0], id: 'another-request' });
  assert.equal(Alignment.hitTest(value, 1, [-5, 50], 'source', true).status, 'ambiguous');
  assert.equal(Alignment.hitTest(value, 0, [20, 30], 'target', true).status, 'ambiguous');
});

test('the appended hover toggle is opt-in and independent of sync and navigation support', () => {
  for (const navigation of [true, false]) {
    const f = fixture();
    f.state.sync = false;
    if (!navigation) delete f.leftViewer.scrollPageIntoView;
    const control = f.controller.attach(f.state, mapping());
    const button = f.controller.hoverButton;
    assert.equal(control.children[0], f.controller.button);
    assert.equal(control.children[1], f.controller.status);
    assert.equal(control.children[2], button);
    assert.equal(button.classList.contains('paperbridge-paragraph-hover-toggle'), true);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(f.controller.hoverEnabled, false);
    hover(f);
    assertHoverCleared(f);
    button.emit('click');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(f.controller.hoverEnabled, true);
    hover(f);
    assert.ok(f.controller.hoverUnit);
    assert.equal(f.state.sync, false);
    f.state.sync = true;
    hover(f, 'source');
    assert.ok(f.controller.hoverUnit);
    button.emit('click');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(f.controller.hoverEnabled, false);
    assertHoverCleared(f);
    assert.equal(f.state.sync, true);
    assert.equal(f.destinations.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(control.children[0].disabled, !navigation);
    close(f);
  }
});

test('passive hover maps both directions and highlights whole native items of exactly one request', () => {
  const f = fixture();
  const value = mapping();
  value.units[0].target.rects.push([20, 30, 40, 50]);
  value.units.push({ id: 'separate-request', status: 'verified',
    source: { page: 1, rects: [[30, 90, 40, 100]] }, target: { page: 0, rects: [[50, 60, 60, 70]] } });
  f.controller.attach(f.state, value);
  assert.equal(f.controller.hoverAvailable, true);
  for (const doc of [f.leftDoc, f.rightDoc]) {
    const listeners = doc.listeners.get('pointermove');
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].options.capture, true);
    assert.equal(listeners[0].options.passive, true);
  }
  f.controller.hoverButton.emit('click');
  for (const [side, point, unitIndex] of [['source', [-5, 50], 0], ['target', [20, 30], 0],
    ['target', [55, 65], 1], ['source', [35, 95], 1]]) {
    assert.deepEqual(hover(f, side, point), { prevented: false, stopped: false });
    assert.equal(f.controller.hoverUnit, value.units[unitIndex]);
    assert.equal(f.controller.hoverHighlights.length, 2);
    for (const [index, name] of ['source', 'target'].entries()) {
      const items = f.nativeText[name];
      assertHoverRecord(f, index, value.units[unitIndex], unitIndex === 0 ? [items.first, items.second] : [items.other]);
    }
    assert.equal(f.controller.point, null);
    assert.equal(f.destinations.length, 0);
    assert.equal(f.clones.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.alignmentNavigationUntil, undefined);
    assert.equal(f.state.sync, true);
    assert.equal(f.state.active, 1);
    assert.equal(f.leftViewer.currentScaleValue, 'original-scale');
    assert.equal(f.rightViewer.currentScaleValue, 'translation-scale');
  }
  close(f);
});

test('unsafe pointer interactions, off-page coordinates, and ambiguous or missing hits clear hover', () => {
  const f = fixture();
  const value = mapping();
  f.controller.attach(f.state, value);
  f.controller.hoverButton.emit('click');
  const editor = f.leftDoc.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  f.leftPage.div.append(editor);
  const toolbar = f.rightDoc.createElement('div');
  toolbar.className = 'toolbar';
  f.rightPage.div.append(toolbar);
  const foreignPage = page(f.rightDoc, 0, f.rightViewport);
  for (const [side, point, overrides] of [
    ['source', [-5, 50], { button: 2 }], ['target', [20, 30], { buttons: 1 }],
    ['source', [-5, 50], { buttons: 2 }], ['target', [20, 30], { pointerType: 'touch' }],
    ['source', [-5, 50], { isPrimary: false }], ['target', [20, 30], { target: toolbar }],
    ['source', [-5, 50], { target: editor }], ['target', [20, 30], { target: f.controller.hoverButton }],
    ['target', [20, 30], { target: foreignPage.div }], ['source', [-5, 50], { target: f.leftDoc }],
    ['target', [20, 30], { clientX: -1000 }], ['source', [20, 100], {}],
  ]) {
    hover(f);
    assert.ok(f.controller.hoverUnit);
    assert.deepEqual(hover(f, side, point, overrides), { prevented: false, stopped: false });
    assertHoverCleared(f, `${side}: ${JSON.stringify({ point, ...overrides,
      target: overrides.target ? `${overrides.target.tagName} ${overrides.target.className}` : undefined })}`);
  }
  for (const side of ['source', 'target']) {
    hover(f);
    value.units.push({ ...value.units[0], id: 'ambiguous-request' });
    hover(f, side);
    assertHoverCleared(f);
    value.units.pop();
  }
  hover(f);
  value.units[0].source.page = f.leftViewer.pagesCount;
  hover(f);
  assertHoverCleared(f);
  assert.equal(f.destinations.length, 0);
  assert.equal(f.timers.size, 0);
  close(f);
});

test('native hover projects whole text items and preserves DOM, selection, and higher-priority paint', () => {
  const f = fixture();
  assert.equal(f.Alignment.TEXT_RECT_TOLERANCE, 2);
  const nativeLayers = [];
  const nearBoundary = [];
  const value = mapping();
  for (const pageView of [f.leftPage, f.rightPage]) {
    const layer = pageView.div.querySelector('.textLayer');
    const layers = ['canvasWrapper', 'annotationOverlay', 'customAnnotationLayer'].map(className => {
      const layer = pageView.div.ownerDocument.createElement('div');
      layer.className = className;
      return layer;
    });
    pageView.div.insertBefore(layers[0], layer);
    pageView.div.insertBefore(layers[1], layer);
    pageView.div.append(layers[2]);
    layers[0].append(pageView.div.ownerDocument.createElement('canvas'));
    nativeLayers.push([...pageView.div.children]);
    const side = pageView === f.leftPage ? 'source' : 'target';
    for (const overflow of [2, 2.25]) {
      const item = textItem(pageView, layer, `CSS rounding ${overflow}`, []);
      /** Accept exactly two CSS pixels, rejecting overhang beyond the final tolerance. */
      item.rangeRects = () => {
        const box = textRect(pageView, value.units[0][side].rects[0]);
        return [{ ...box, left: box.left - overflow, width: box.width + overflow }];
      };
      if (overflow <= 2) nearBoundary.push(item);
    }
  }
  const nativeState = [f.leftPage, f.rightPage].flatMap(pageView => [pageView.div, ...pageView.div.querySelectorAll('*')])
    .map(node => [node, { ...node.style }, { ...node.attributes }, node.className, node.textContent, [...node.children], node.isConnected]);
  const selections = [f.leftDoc, f.rightDoc].map(doc => ({ ...doc.getSelection() }));
  const searchHighlights = [f.leftFrame, f.rightFrame].map(frame => {
    const range = frame.document.createRange();
    range.selectNodeContents(frame.document.selection.anchorNode);
    const highlight = new frame.Highlight(range);
    frame.CSS.highlights.set('native-search', highlight);
    return highlight;
  });
  f.controller.attach(f.state, value);
  f.controller.hoverButton.emit('click');
  hover(f);
  for (const [index, pageView] of [f.leftPage, f.rightPage].entries()) {
    const frame = index === 0 ? f.leftFrame : f.rightFrame;
    const items = f.nativeText[index === 0 ? 'source' : 'target'];
    assertHoverRecord(f, index, value.units[0], [items.first, items.second, nearBoundary[index]]);
    assert.ok(f.controller.hoverHighlights[index].highlight.priority < searchHighlights[index].priority);
    assert.equal(frame.CSS.highlights.get('native-search'), searchHighlights[index]);
    assert.deepEqual(pageView.div.children, nativeLayers[index]);
    assert.equal(pageView.div.querySelector('.paperbridge-paragraph-highlight'), null);
    assert.equal(frame.document.head.children.length, 1);
    assert.equal(frame.document.head.children[0].tagName, 'STYLE');
    assert.equal(frame.document.head.children[0].textContent,
      '::highlight(paperbridge-paragraph-hover){background-color:rgba(96,165,250,.5);color:transparent}');
  }
  const expected = [[[233.5, 273.5, 311.5, 321.5], [248.5, 345.5, 296.5, 369.5]],
    [[157, 234.5, 188.5, 315.5], [206.5, 239, 233.5, 311]]];
  for (const index of [0, 1]) {
    assert.deepEqual(f.controller.hoverHighlights[index].ranges[0].getClientRects()
      .map(rect => [rect.left, rect.top, rect.right, rect.bottom]), expected[index]);
  }
  assert.deepEqual([f.leftDoc, f.rightDoc].map(doc => ({ ...doc.getSelection() })), selections);
  assert.deepEqual(nativeState.map(([node]) => [node, { ...node.style }, { ...node.attributes }, node.className,
    node.textContent, [...node.children], node.isConnected]), nativeState);
  close(f);
  assert.deepEqual(f.leftPage.div.children, nativeLayers[0]);
  assert.deepEqual(f.rightPage.div.children, nativeLayers[1]);
  for (const [index, frame] of [f.leftFrame, f.rightFrame].entries()) {
    assert.equal(frame.CSS.highlights.has('paperbridge-paragraph-hover'), false);
    assert.equal(frame.CSS.highlights.get('native-search'), searchHighlights[index]);
    assert.equal(frame.document.head.children.length, 0);
  }
});

test('geometry invalidation defers registry cleanup, including destruction without a following render', () => {
  for (const side of ['source', 'target']) {
    for (const type of ['scroll', 'resize', 'pagerendered']) {
      const f = fixture();
      f.controller.attach(f.state, mapping());
      f.controller.hoverButton.emit('click');
      hover(f, side);
      const index = side === 'source' ? 0 : 1;
      const pageView = index === 0 ? f.leftPage : f.rightPage;
      const oldPaint = f.controller.hoverHighlights[index];
      if (type === 'scroll') {
        pageView.div.box = { ...pageView.div.box, left: pageView.div.box.left + 10000 };
        for (const surface of index === 0 ? [f.leftDoc, f.leftViewer.container, f.leftFrame]
          : [f.rightDoc, f.rightViewer.container, f.rightFrame]) surface.emit(type, { target: pageView.div });
      } else {
        pageView.viewport = viewport([1, 0, 0, 1, 150, 100], pageView.viewport.width, pageView.viewport.height);
        if (type === 'resize') (index === 0 ? f.leftFrame : f.rightFrame).emit(type);
        else (index === 0 ? f.leftBus : f.rightBus).emit(type, { pageNumber: index === 0 ? 2 : 1 });
      }
      if (f.controller.hoverUnit) {
        assert.ok(f.controller.hoverHighlights[index], `${side}/${type}`);
        assert.notEqual(f.controller.hoverHighlights[index], oldPaint, `${side}/${type}`);
        assert.equal(oldPaint.isConnected, false, `${side}/${type}`);
      } else {
        assertHoverCleared(f);
      }
      assert.equal(f.controller.hoverEnabled, true);
      assert.equal(f.destinations.length, 0);
      close(f);
    }

    for (const type of ['scalechanging', 'rotationchanging', 'pagechanging', 'pagesdestroy']) {
      const f = fixture({ animationFrames: true });
      const value = mapping();
      const index = side === 'source' ? 0 : 1;
      const pageView = index === 0 ? f.leftPage : f.rightPage;
      const bus = index === 0 ? f.leftBus : f.rightBus;
      const reason = `${side}/${type}`;
      f.controller.attach(f.state, value);
      f.controller.hoverButton.emit('click');
      hover(f, side);
      f.animationFrames.flush();
      const retained = Array.from(f.controller.hoverHighlights);
      let queued = null;
      if (type === 'rotationchanging') {
        hover(f, side);
        queued = f.controller.hoverFrameRequest;
      }
      let nativeLayout = false;
      for (const frame of [f.leftFrame, f.rightFrame]) {
        const registry = frame.CSS.highlights;
        for (const method of ['set', 'delete']) {
          const original = registry[method].bind(registry);
          /** Native layout callbacks must never repaint or unregister our active ranges. */
          registry[method] = (...args) => {
            assert.equal(nativeLayout, false, reason);
            return original(...args);
          };
        }
      }
      nativeLayout = true;
      try {
        bus.emit(type, { pageNumber: index === 0 ? 2 : 1 });
      } finally {
        nativeLayout = false;
      }
      assert.equal(f.controller.hoverPointer, null, reason);
      assert.ok(f.controller.hoverFrameRequest, reason);
      if (queued) assert.equal(f.controller.hoverFrameRequest, queued, reason);
      assert.equal(f.controller.hoverRepaint, true, reason);
      assert.equal(f.animationFrames.pending.size, 1, reason);
      assert.equal(f.controller.hoverUnit, value.units[0], reason);
      assert.deepEqual(Array.from(f.controller.hoverHighlights), retained, reason);
      for (const pane of [0, 1]) {
        const items = f.nativeText[pane === 0 ? 'source' : 'target'];
        assertHoverRecord(f, pane, value.units[0], [items.first, items.second]);
      }
      // No following render is needed: pagesdestroy must still release stale registry entries.
      f.animationFrames.flush();
      assertHoverCleared(f, reason);
      assert.equal(f.controller.hoverFrameRequest, null, reason);
      assert.equal(f.controller.hoverRepaint, false, reason);
      assert.equal(f.animationFrames.pending.size, 0, reason);
      assert.ok(retained.every(record => !record.isConnected), reason);
      assert.ok(retained.every(record => record.ranges.every(range => range.startContainer.isConnected)), reason);

      // Native reconstruction, not hover, detaches old ranges and replaces text-layer items.
      f.nativeText[side].layer.remove();
      assert.equal(retained[index].isConnected, false, reason);
      assert.ok(retained[index].ranges.every(range => range.getClientRects().length === 0), reason);
      pageView.viewport = viewport([1, 0, 0, 1, 150, 100], pageView.viewport.width, pageView.viewport.height);
      f.nativeText[side] = textLayer(pageView, side === 'source');
      bus.emit('pagerendered', { pageNumber: index === 0 ? 2 : 1 });
      bus.emit('textlayerrendered', { pageNumber: index === 0 ? 2 : 1 });
      assert.equal(f.animationFrames.pending.size, 1, reason);
      assertHoverCleared(f, reason);
      f.animationFrames.flush();
      assertHoverCleared(f, reason);
      assert.equal(f.controller.hoverPointer, null, reason);

      hover(f, side);
      assertHoverCleared(f, reason);
      f.animationFrames.flush();
      for (const pane of [0, 1]) {
        const items = f.nativeText[pane === 0 ? 'source' : 'target'];
        assertHoverRecord(f, pane, value.units[0], [items.first, items.second]);
        assert.notEqual(f.controller.hoverHighlights[pane].highlight, retained[pane].highlight, reason);
      }
      assert.equal(f.controller.hoverEnabled, true, reason);
      assert.equal(f.destinations.length, 0, reason);
      close(f);
    }
  }
});

test('an unrendered counterpart is nullable and unrendered pointer pages cannot supply hits', () => {
  for (const side of ['source', 'target']) {
    const f = fixture();
    f.controller.attach(f.state, mapping());
    f.controller.hoverButton.emit('click');
    const hiddenIndex = side === 'source' ? 1 : 0;
    const hidden = hiddenIndex === 0 ? f.leftPage : f.rightPage;
    hidden.renderingState = 0;
    hover(f, side);
    assert.ok(f.controller.hoverUnit);
    assert.equal(f.controller.hoverHighlights[hiddenIndex], null);
    assert.ok(f.controller.hoverHighlights[1 - hiddenIndex]);
    hidden.renderingState = 3;
    (hiddenIndex === 0 ? f.leftBus : f.rightBus).emit('pagerendered', { pageNumber: hiddenIndex === 0 ? 2 : 1 });
    assert.ok(f.controller.hoverHighlights[0]);
    assert.ok(f.controller.hoverHighlights[1]);
    hidden.renderingState = 0;
    hover(f, hiddenIndex === 0 ? 'source' : 'target');
    assertHoverCleared(f);
    hidden.renderingState = 3;
    (hiddenIndex === 0 ? f.leftBus : f.rightBus).emit('pagerendered', { pageNumber: hiddenIndex === 0 ? 2 : 1 });
    hover(f, side);
    assert.ok(f.controller.hoverHighlights[0]);
    assert.ok(f.controller.hoverHighlights[1]);
    close(f);
  }
  const broken = fixture();
  broken.controller.attach(broken.state, mapping());
  broken.controller.hoverButton.emit('click');
  /** Fail inside target range geometry after the source registry entry was installed. */
  broken.nativeText.target.first.rangeRects = () => { throw new Error('mock native range failure'); };
  assert.doesNotThrow(() => hover(broken, 'source'));
  assertHoverCleared(broken);
  close(broken);

  const missing = fixture();
  const layer = missing.nativeText.source.layer;
  layer.remove();
  missing.controller.attach(missing.state, mapping());
  missing.controller.hoverButton.emit('click');
  hover(missing);
  assert.equal(missing.controller.hoverHighlights[0], null);
  assert.ok(missing.controller.hoverHighlights[1]);
  missing.leftPage.div.append(layer);
  missing.leftBus.emit('textlayerrendered', { pageNumber: 2 });
  assert.ok(missing.controller.hoverHighlights[0]);
  close(missing);
});

test('hover and explicit expiration are independent, and closure or reuse releases owned resources', () => {
  const f = fixture();
  const control = f.controller.attach(f.state, mapping());
  f.controller.hoverButton.emit('click');
  pointer(f);
  click(control);
  hover(f);
  const firstHover = Array.from(f.controller.hoverHighlights);
  const expiration = [...f.timers.values()][0];
  expiration.callback();
  assert.equal(f.controller.highlight, null);
  assert.deepEqual(Array.from(f.controller.hoverHighlights), firstHover);
  assert.ok(f.controller.hoverUnit);
  assert.equal(f.timers.size, 0);
  pointer(f);
  click(control);
  hover(f);
  const explicit = f.controller.highlight;
  f.controller.hoverButton.emit('click');
  assertHoverCleared(f);
  assert.equal(f.controller.highlight, explicit);
  assert.equal(explicit.isConnected, true);
  assert.equal(f.timers.size, 1);
  f.controller.hoverButton.emit('click');
  hover(f);
  const oldRecords = Array.from(f.controller.hoverHighlights);
  const oldButton = f.controller.hoverButton;
  const oldCleanup = f.state.cleanups[0];
  close(f);
  close(f);
  assertHoverCleared(f);
  assert.equal(oldButton.count(), 0);
  assert.equal(f.timers.size, 0);
  for (const record of oldRecords) assert.equal(record.isConnected, false);
  assert.equal(f.leftDoc.head.children.length, 0);
  assert.equal(f.rightDoc.head.children.length, 0);
  for (const surface of [f.leftDoc, f.rightDoc, f.leftBus, f.rightBus, f.leftFrame, f.rightFrame,
    f.leftViewer.container, f.rightViewer.container]) assert.equal(surface.count(), 0);
  const freshControl = f.controller.attach(f.state, mapping());
  oldCleanup();
  assert.equal(freshControl.isConnected, true);
  assert.equal(f.controller.hoverEnabled, false);
  assert.equal(f.leftDoc.head.children.length, 1);
  assert.equal(f.rightDoc.head.children.length, 1);
  f.controller.hoverButton.emit('click');
  hover(f, 'source');
  assert.ok(f.controller.hoverUnit);
  for (const record of oldRecords) {
    assert.ok(record.ranges.every(range => range.startContainer.isConnected));
    assert.equal(record.isConnected, false);
    record.remove();
  }
  assert.equal(f.leftFrame.CSS.highlights.get('paperbridge-paragraph-hover'), f.controller.hoverHighlights[0].highlight);
  assert.equal(f.rightFrame.CSS.highlights.get('paperbridge-paragraph-hover'), f.controller.hoverHighlights[1].highlight);
  assert.equal(f.leftDoc.listeners.get('pointermove').length, 1);
  assert.equal(f.rightDoc.listeners.get('pointermove').length, 1);
  close(f);
});

test('mapping failure clears hover while a rejected old loader cannot damage a reused controller', async () => {
  for (const reuse of [false, true]) {
    let rejectLoad;
    const f = fixture({ loadMapping: () => new Promise((resolve, reject) => { rejectLoad = reject; }) });
    f.controller.attach(f.state);
    assert.equal(f.controller.hoverButton.disabled, true);
    await new Promise(resolve => setImmediate(resolve));
    if (reuse) {
      close(f);
      f.controller.attach(f.state, mapping());
    } else {
      f.controller.setMapping(mapping());
    }
    f.controller.hoverButton.emit('click');
    hover(f);
    assert.ok(f.controller.hoverUnit);
    rejectLoad(new Error('Parent: hover mapping unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    if (reuse) {
      assert.ok(f.controller.hoverUnit);
      assert.equal(f.controller.hoverButton.disabled, false);
      assert.equal(f.controller.hoverEnabled, true);
    } else {
      assertHoverCleared(f);
      assert.equal(f.controller.hoverButton.disabled, true);
      assert.match(f.controller.status.textContent, /hover mapping unavailable/);
    }
    close(f);
  }
});

test('RAF defers native render painting, coalesces the latest hover, and cancels invalidated work', () => {
  const f = fixture({ animationFrames: true });
  const nativeChildren = [f.leftPage, f.rightPage].map(pageView => [...pageView.div.children]);
  const value = mapping();
  value.units.push({ id: 'latest-request', status: 'verified',
    source: { page: 1, rects: [[30, 90, 40, 100]] }, target: { page: 0, rects: [[50, 60, 60, 70]] } });
  f.controller.attach(f.state, value);
  f.controller.hoverButton.emit('click');
  hover(f);
  assert.equal(f.animationFrames.pending.size, 1);
  assertHoverCleared(f);
  f.animationFrames.flush();
  assert.equal(f.controller.hoverUnit, value.units[0]);
  const painted = Array.from(f.controller.hoverHighlights);
  let nativeRendering = false;
  for (const frame of [f.leftFrame, f.rightFrame]) {
    const registry = frame.CSS.highlights;
    const set = registry.set.bind(registry);
    const remove = registry.delete.bind(registry);
    /** Custom-highlight painting is deferred until native render dispatch has ended. */
    registry.set = (...args) => {
      assert.equal(nativeRendering, false, 'native render must not register hover paint');
      return set(...args);
    };
    /** Repainting must not clear active native ranges during renderer callbacks. */
    registry.delete = (...args) => {
      assert.equal(nativeRendering, false, 'native render must not clear hover paint');
      return remove(...args);
    };
  }
  for (const record of painted) {
    const remove = record.remove.bind(record);
    /** Catch clearing active native ranges even if an eager repaint replaces them. */
    record.remove = () => {
      assert.equal(nativeRendering, false, 'native render must not clear active ranges');
      remove();
    };
  }
  nativeRendering = true;
  try {
    f.leftBus.emit('pagerendered', { pageNumber: 2 });
    f.rightBus.emit('pagerendered', { pageNumber: 1 });
  } finally {
    nativeRendering = false;
  }
  assert.deepEqual(Array.from(f.controller.hoverHighlights), painted);
  const queued = f.controller.hoverFrameRequest;
  hover(f, 'target', [55, 65]);
  hover(f, 'source', [35, 95]);
  f.leftDoc.emit('scroll');
  f.rightFrame.emit('resize');
  assert.equal(f.controller.hoverFrameRequest, queued);
  assert.equal(f.animationFrames.pending.size, 1);
  assert.equal(f.controller.hoverRepaint, true);
  assert.equal(f.controller.hoverUnit, value.units[0]);
  f.animationFrames.flush();
  assert.equal(f.controller.hoverFrameRequest, null);
  assert.equal(f.animationFrames.pending.size, 0);
  assert.deepEqual(f.animationFrames.cancelled, []);
  assert.equal(f.controller.hoverUnit, value.units[1]);
  assertHoverRecord(f, 0, value.units[1], [f.nativeText.source.other]);
  assertHoverRecord(f, 1, value.units[1], [f.nativeText.target.other]);
  for (const [index, expected] of [[0, [140.5, 420.5, 164.5, 444.5]], [1, [337, 414.5, 373, 450.5]]]) {
    const rect = f.controller.hoverHighlights[index].ranges[0].getClientRects()[0];
    assert.deepEqual([rect.left, rect.top, rect.right, rect.bottom], expected);
    assert.deepEqual((index === 0 ? f.leftPage : f.rightPage).div.children, nativeChildren[index]);
  }
  close(f);

  for (const [reason, invalidate] of [
    ['toggle', fixture => fixture.controller.hoverButton.emit('click')],
    ['close', close],
    ['mapping', fixture => fixture.controller.setMapping(null, 'Parent: mapping changed')],
    ['drag', fixture => hover(fixture, 'target', [20, 30], { buttons: 1 })],
  ]) {
    const waiting = fixture({ animationFrames: true });
    waiting.controller.attach(waiting.state, mapping());
    waiting.controller.hoverButton.emit('click');
    hover(waiting);
    const request = waiting.controller.hoverFrameRequest;
    const lateCallback = waiting.animationFrames.pending.get(request.id).callback;
    invalidate(waiting);
    assert.equal(waiting.controller.hoverFrameRequest, null, reason);
    assert.equal(waiting.animationFrames.pending.size, 0, reason);
    assert.deepEqual(waiting.animationFrames.cancelled, [request.id], reason);
    waiting.animationFrames.flush();
    lateCallback(0);
    assertHoverCleared(waiting, reason);
    assert.equal(waiting.animationFrames.pending.size, 0, reason);
    close(waiting);
  }
});
