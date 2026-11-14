/** Mock-only bilateral localization, CSS hover, translated-note actions, and cleanup contracts. */
// Built-in modules keep this frontend suite independent of Zotero and new dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
// Resolve from this file so the suite also runs outside the repository root.
const moduleSource = fs.readFileSync(path.join(__dirname, '../addon/content/alignment.js'), 'utf8');
// Check the native harness refusal path without running an actual Zotero profile.
const nativeHarnessSource = fs.readFileSync(path.join(__dirname, 'alignment_packaged.js'), 'utf8');

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
  const context = vm.createContext({ ...options.globals, Components: { utils: {
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
  const targetDestinations = [];
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
    /** Observe translated navigation through the same native API as the original pane. */
    scrollPageIntoView(destination) {
      if (options.targetNavigationError) throw new Error('mock target navigation failure');
      targetDestinations.push(destination);
      rightBus.emit('pagechanging', { pageNumber: destination.pageNumber });
    },
  };
  const leftFrame = Object.assign(new Events(), { document: leftDoc, PDFViewerApplication: { pdfViewer: leftViewer, eventBus: leftBus },
    Highlight, CSS: { highlights: new Map() },
    /** Keep visual timers deterministic and local to this fixture. */
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    /** Cancel one recorded timer without waiting in real time. */
    clearTimeout(id) { timers.delete(id); },
  });
  const rightFrame = Object.assign(new Events(), { document: rightDoc, PDFViewerApplication: { pdfViewer: rightViewer, eventBus: rightBus },
    Highlight, CSS: { highlights: new Map() },
    /** Keep destination-pane highlight timers deterministic too. */
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    /** Cancel a translated-pane visual timer. */
    clearTimeout(id) { timers.delete(id); },
  });
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
    animationFrames, nativeText, targetDestinations };
}

/** Release either pane's fragment using its current viewport and CSS border scaling. */
function pointer(f, eventOverrides = {}, side = 'target') {
  const pageView = side === 'source' ? f.leftPage : f.rightPage;
  const doc = side === 'source' ? f.leftDoc : f.rightDoc;
  const point = side === 'source' ? [-5, 50] : [20, 30];
  const [x, y] = pageView.viewport.convertToViewportPoint(...point);
  const div = pageView.div;
  const box = div.getBoundingClientRect();
  let prevented = false;
  const event = { target: div, button: 0, isPrimary: true,
    clientX: box.left + (x * div.clientWidth / pageView.viewport.width + div.clientLeft) * box.width / div.offsetWidth,
    clientY: box.top + (y * div.clientHeight / pageView.viewport.height + div.clientTop) * box.height / div.offsetHeight,
    /** Detect accidental cancellation of native selection or links. */
    preventDefault() { prevented = true; }, ...eventOverrides };
  doc.emit('pointerup', event);
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

/** Supply only the native APIs used by the note UI, retaining the actual controller. */
function noteFixture() {
  const calls = { loaded: [], selected: [], annotations: [], opened: [] };
  const hooks = {};
  const note = { id: 300, key: 'NOTE0001' };
  const api = {
    /** Capture exactly what the real selection controller passes to notes.js. */
    async createFromSelection(args) {
      calls.selected.push(args);
      if (hooks.save) await hooks.save();
      return note;
    },
    /** Record the attachment-only native summary request. */
    async createFromAnnotations(args) {
      calls.annotations.push(args);
      if (hooks.save) await hooks.save();
      return note;
    }
  };
  const globals = { rootURI: 'chrome://test-addon/',
    Zotero: {
      Notes: {
        /** Observe the official native window-opening contract separately from saving. */
        async open(id, location, options) {
          calls.opened.push({ id, location, options });
          if (hooks.open) await hooks.open();
        }
      },
      Annotations: {
        /** Return the persisted native text/position used by the debounce check. */
        async toJSON(item) { return item.json; }
      }
    },
    Services: { scriptloader: {
      /** Model lazy script loading without registering UI or starting Zotero. */
      loadSubScript(url, scope) {
        calls.loaded.push(url);
        if (hooks.load) hooks.load();
        scope.PaperBridgeNotes = api;
      }
    } }
  };
  const f = fixture({ globals });
  const persisted = [];
  f.state.source = { id: 20, key: 'SOURCE01' };
  f.state.translated = { id: 21, key: 'TRANS001',
    /** Model public child-data loading without persistence. */
    async loadDataType() {},
    /** Read only persisted annotation items. */
    getAnnotations() { return persisted; }
  };
  Object.assign(f.rightDoc.selection, { isCollapsed: false,
    /** Native selection supplies actual text, independent of mapping contents. */
    toString() { return 'Actual <translated> selection & punctuation.'; },
    /** Expose the actual selected text layer's range boundaries. */
    getRangeAt() { return { startContainer: f.nativeText.target.first, endContainer: f.nativeText.target.second }; }
  });
  f.rightFrame.PDFViewerApplication.pdfDocument = {
    /** Page labels are the native PDF labels, not the viewer's current page guess. */
    async getPageLabels() { return ['iv']; }
  };
  f.controller.attach(f.state, null, 'No mapping');
  return { ...f, calls, hooks, note, persisted, globals };
}

/** Read the translated selection before toolbar focus, regardless of mapping availability. */
test('note UI lazily uses actual translated selection/page labels without changing bilateral localization', async () => {
  const f = noteFixture();
  const originalStatus = f.controller.status.textContent;
  assert.equal(f.calls.loaded.length, 0);
  assert.equal(f.controller.selectionNoteButton.disabled, false);
  f.controller.selectionNoteButton.emit('pointerdown', { button: 0 });
  f.rightDoc.selection.isCollapsed = true;
  const result = await f.controller.createNote('selection');
  assert.equal(result.note, f.note);
  assert.equal(result.opened, true);
  assert.deepEqual(f.calls.loaded, ['chrome://test-addon/content/notes.js']);
  assert.equal(f.calls.selected[0].text, 'Actual <translated> selection & punctuation.');
  assert.equal(f.calls.selected[0].pageIndex, 0);
  assert.equal(f.calls.selected[0].pageLabel, 'iv');
  assert.equal(f.calls.selected[0].translatedAttachment, f.state.translated);
  assert.equal(f.calls.selected[0].sourceAttachment, f.state.source);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.opened)), [{ id: 300, location: null, options: { openInWindow: true } }]);
  assert.equal(f.controller.status.textContent, originalStatus);
  assert.deepEqual(f.destinations, []);
  assert.deepEqual(f.targetDestinations, []);
  close(f);
});

/** Saving and opening share one disabled action, and opening failure never repeats the save. */
test('continuous note clicks share the pending action and preserve save success on native open failure', async () => {
  const f = noteFixture();
  let resolveSave;
  f.hooks.save = () => new Promise(resolve => { resolveSave = resolve; });
  f.hooks.open = async () => { throw new Error('Native window failed'); };
  const first = f.controller.createNote('selection');
  assert.equal(f.controller.selectionNoteButton.disabled, true);
  assert.equal(f.controller.annotationsNoteButton.disabled, true);
  assert.equal(f.controller.createNote('selection'), first);
  assert.equal(f.controller.createNote('annotations'), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.selected.length, 1);
  resolveSave();
  const result = await first;
  assert.equal(result.note, f.note);
  assert.equal(result.opened, false);
  assert.match(f.controller.noteStatus.textContent, /已保存.*打开失败.*勿重复保存/);
  assert.equal(f.calls.opened.length, 1);
  assert.equal(f.calls.annotations.length, 0);
  assert.equal(f.controller.selectionNoteButton.disabled, false);
  close(f);
});

/** No source-only, collapsed, multi-range, non-PDF, or cross-page selection is silently accepted. */
test('invalid real-selection boundaries fail only the note UI before loading or saving', async () => {
  const f = noteFixture();
  const selection = f.rightDoc.selection;
  const ordinary = selection.getRangeAt;
  for (const invalid of [
    () => { selection.isCollapsed = true; },
    () => { selection.rangeCount = 2; },
    () => { selection.getRangeAt = () => ({ startContainer: f.controller.status, endContainer: f.controller.status }); },
    () => { selection.getRangeAt = () => ({ startContainer: f.nativeText.target.first, endContainer: f.nativeText.source.first }); }
  ]) {
    selection.isCollapsed = false;
    selection.rangeCount = 1;
    selection.getRangeAt = ordinary;
    invalid();
    const result = await f.controller.createNote('selection');
    assert.equal(result.note, null);
    assert.match(f.controller.noteStatus.textContent, /笔记未能创建/);
    assert.equal(f.controller.status.textContent, 'No mapping');
    assert.equal(f.controller.selectionNoteButton.disabled, false);
  }
  assert.equal(f.calls.loaded.length, 0);
  assert.equal(f.calls.selected.length, 0);
  close(f);
});

/** Wait for the current native write queue; never manufacture reader annotations to flush it. */
test('annotation summary waits for native persistence and rejects reader-only pending edits', async () => {
  const f = noteFixture();
  let resolveWrite;
  f.state.annotations = { pending: new Promise(resolve => { resolveWrite = resolve; }) };
  const json = { key: 'ANNOT001', type: 'highlight', text: 'Actual saved highlight', comment: '',
    pageLabel: 'iv', color: '#ffd400', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } };
  f.state.right._state = { annotations: [{ ...json, id: json.key }] };
  const operation = f.controller.createNote('annotations');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.annotations.length, 0);
  f.persisted.push({ key: json.key, json,
    /** Native data load is a read, not a synthetic annotation write. */
    async loadAllData() {}
  });
  resolveWrite();
  assert.equal((await operation).note, f.note);
  assert.equal(f.calls.annotations[0].translatedAttachment, f.state.translated);
  assert.equal(f.calls.annotations[0].sourceAttachment, f.state.source);
  assert.equal('text' in f.calls.annotations[0], false);
  f.state.right._state.annotations[0].comment = 'Not saved yet';
  const failed = await f.controller.createNote('annotations');
  assert.equal(failed.note, null);
  assert.match(f.controller.noteStatus.textContent, /仍在原生保存/);
  assert.equal(f.calls.annotations.length, 1);
  close(f);
});

/** Loading/save failure must preserve the PDF, localization buttons, and retry availability. */
test('note loader or save failures stay separate from mapping and reading controls', async () => {
  const f = noteFixture();
  f.controller.setMapping(mapping());
  const status = f.controller.status.textContent;
  f.hooks.load = () => { throw new Error('Note module unavailable'); };
  assert.equal((await f.controller.createNote('selection')).note, null);
  assert.match(f.controller.noteStatus.textContent, /module unavailable/);
  delete f.hooks.load;
  f.hooks.save = async () => {
    const error = new Error('Check attempted native key NOTE0001');
    error.code = 'NOTE_SAVE_FAILED';
    throw error;
  };
  assert.equal((await f.controller.createNote('selection')).note, null);
  assert.match(f.controller.noteStatus.textContent, /native key NOTE0001/);
  assert.match(f.controller.noteStatus.textContent, /保存结果未确认/);
  assert.equal(f.controller.status.textContent, status);
  assert.equal(f.controller.button.disabled, false);
  assert.equal(f.controller.targetButton.disabled, false);
  assert.equal(f.calls.opened.length, 0);
  close(f);
});

/** Closing or reusing a controller must not revive controls or save an invisible late request. */
test('note actions closed before saving are cancelled and late open outcomes cannot change a reused split', async () => {
  const f = noteFixture();
  const cancelled = f.controller.createNote('selection');
  close(f);
  assert.equal(await cancelled, null);
  assert.equal(f.calls.selected.length, 0);
  f.controller.attach(f.state, mapping());
  let rejectOpen;
  f.hooks.open = () => new Promise((resolve, reject) => { rejectOpen = reject; });
  const operation = f.controller.createNote('selection');
  await new Promise(resolve => setImmediate(resolve));
  const savedStatus = f.controller.noteStatus;
  assert.match(savedStatus.textContent, /已保存/);
  close(f);
  f.controller.attach(f.state, mapping());
  rejectOpen(new Error('Old native open failed'));
  assert.equal((await operation).note, f.note);
  assert.equal(f.controller.noteStatus.textContent || '', '');
  assert.equal(f.controller.selectionNoteButton.disabled, false);
  assert.doesNotMatch(savedStatus.textContent, /Old native/);
  close(f);
});

/** The native note harness must never write, import, or quit an unrelated daily profile. */
test('native alignment/notes harness refuses an unrelated profile without writes or quit', async () => {
  const calls = { errors: [], writes: 0, quits: 0 };
  const scope = { PAPERBRIDGE_TEST_ROOT: '/isolated/project',
    PathUtils: { join: (...parts) => parts.join('/'), normalize: value => value },
    Ci: { nsIFile: {}, nsIAppStartup: { eAttemptQuit: 1 } },
    Services: {
      dirsvc: { get: () => ({ path: '/daily/profile' }) },
      startup: { quit: () => { calls.quits++; } }
    },
    IOUtils: { writeUTF8: async () => { calls.writes++; } },
    Zotero: { version: '10.0.8', DataDirectory: { dir: '/daily/data' }, logError: error => calls.errors.push(error) }
  };
  await vm.runInNewContext(nativeHarnessSource, scope);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.writes, 0);
  assert.equal(calls.quits, 0);
});

/** Exercise only isolation/configuration routing, stopping before native setup with a missing bridge. */
test('native harness accepts fresh configured paths and report output while preserving legacy defaults', async () => {
  const root = '/isolated/project';
  const legacyProfile = root + '/.runtime/alignment-profile';
  const legacyData = root + '/.runtime/alignment-data';
  const legacyReport = root + '/.runtime/alignment-test.json';
  const config = { isolated: true, expectedProfileDirectory: '/new-run/profile',
    expectedDataDirectory: '/new-run/data', reportPath: '/new-run/create.json' };
  const cases = [
    { config, profile: config.expectedProfileDirectory, data: config.expectedDataDirectory, output: config.reportPath },
    { config: { ...config, isolated: false }, profile: config.expectedProfileDirectory, data: config.expectedDataDirectory },
    { config, profile: config.expectedProfileDirectory, data: '/other-run/data' },
    { config, profile: '/other-run/profile', data: config.expectedDataDirectory },
    { profile: legacyProfile, data: legacyData, output: legacyReport },
    { config: { isolated: true }, profile: legacyProfile, data: legacyData, output: legacyReport }
  ];
  for (const entry of cases) {
    const calls = { errors: [], writes: [], quits: 0 };
    const scope = { PAPERBRIDGE_TEST_ROOT: root,
      PathUtils: { join: (...parts) => parts.join('/'), normalize: value => value },
      Ci: { nsIFile: {}, nsIAppStartup: { eAttemptQuit: 1 } },
      Services: {
        dirsvc: { get: () => ({ path: entry.profile }) },
        startup: { quit: () => { calls.quits++; } }
      },
      IOUtils: { writeUTF8: async (path, value) => { calls.writes.push({ path, report: JSON.parse(value) }); } },
      Zotero: { version: '10.0.8', DataDirectory: { dir: entry.data }, logError: error => calls.errors.push(error) }
    };
    if (entry.config !== undefined) scope.PAPERBRIDGE_ALIGNMENT_TEST = entry.config;
    await vm.runInNewContext(nativeHarnessSource, scope);
    assert.equal(calls.errors.length, 1);
    assert.equal(calls.quits, entry.output ? 1 : 0);
    assert.equal(calls.writes.length, entry.output ? 1 : 0);
    if (entry.output) {
      assert.equal(calls.writes[0].path, entry.output);
      assert.equal(calls.writes[0].report.checks[0].pass, true);
      assert.match(calls.errors[0].message, /PaperBridge is unavailable/);
    }
  }
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
  pointer(f, { target: { closest: selector => selector === '.page[data-page-number]' ? pageWrapper : null } });
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
  assert.ok(f.rightViewport.calls.rect.every(point => point[0] === 20 && point[1] === 30));
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

test('source selection release is passive and only the translated-location button navigates', () => {
  const f = fixture();
  f.controller.attach(f.state, mapping());
  const selection = { ...f.leftDoc.selection };
  const listener = f.leftDoc.listeners.get('pointerup')[0];
  assert.equal(listener.options.capture, true);
  assert.equal(listener.options.passive, true);
  assert.equal(pointer(f, { stopPropagation() { throw new Error('Native delivery intercepted'); } }, 'source'), false);
  assert.deepEqual(Array.from(f.controller.sourcePoint.point), [-5, 50]);
  assert.deepEqual(f.leftDoc.selection, selection);
  assert.equal(f.destinations.length + f.targetDestinations.length, 0);
  f.controller.targetButton.emit('click');
  assert.deepEqual(f.targetDestinations, [{ pageNumber: 1,
    destArray: [null, { name: 'XYZ' }, 10, 40, null], allowNegativeOffset: true }]);
  assert.equal(f.destinations.length, 0);
  assert.equal(f.clones[0].frame, f.rightFrame);
  assert.equal(f.controller.highlightIndex, 1);
  const overlay = f.rightPage.div.querySelector('.paperbridge-fragment-highlight');
  assert.equal(overlay.children.length, 1);
  assert.deepEqual(['left', 'top', 'width', 'height'].map(key => overlay.children[0].style[key]),
    ['30px', '15px', '60px', '60px']);
  assert.equal(f.state.sync, true);
  assert.equal(f.state.active, 1);
  assert.equal(f.controller.hoverEnabled, false);
  f.controller.hoverButton.emit('click');
  hover(f, 'source');
  assert.ok(f.controller.hoverUnit);
  [...f.timers.values()][0].callback();
  assert.equal(f.controller.highlight, null);
  assert.ok(f.controller.hoverUnit, 'Explicit expiration does not change hover');
  pointer(f);
  f.controller.button.emit('click');
  assert.equal(f.destinations.length, 1, 'Existing reverse action still works');
  assert.equal(f.controller.highlightIndex, 0);
  assert.deepEqual(f.leftDoc.selection, selection);
  close(f);
  assert.equal(f.leftDoc.count() + f.rightDoc.count(), 0);
  assert.equal(f.controller.sourcePoint, null);
  assert.equal(f.controller.targetButton.count(), 0);
  assert.equal(f.timers.size, 0);
});

test('native links and annotation controls clear only that pane hit and never consume events', () => {
  for (const side of ['source', 'target']) {
    const f = fixture();
    f.controller.attach(f.state, mapping());
    const pageView = side === 'source' ? f.leftPage : f.rightPage;
    const button = side === 'source' ? f.controller.targetButton : f.controller.button;
    const otherKey = side === 'source' ? 'point' : 'sourcePoint';
    pointer(f, {}, side === 'source' ? 'target' : 'source');
    for (const [tag, className] of [['a', ''], ['div', 'annotationLayer'],
      ['div', 'customAnnotationLayer'], ['div', 'annotation-popup'], ['button', '']]) {
      pointer(f, {}, side);
      const control = pageView.div.ownerDocument.createElement(tag);
      control.className = className;
      pageView.div.append(control);
      assert.equal(pointer(f, { target: control,
        stopPropagation() { throw new Error('Native delivery intercepted'); } }, side), false);
      button.emit('click');
      assert.match(f.controller.status.textContent, /请先/);
      assert.ok(f.controller[otherKey], 'The opposite pane retains its independent hit');
      assert.equal(f.destinations.length + f.targetDestinations.length, 0);
      control.remove();
    }
    close(f);
  }
});

test('source misses, overlaps, missing mapping, bad target pages and navigation errors never guess', () => {
  for (const mode of ['miss', 'overlap', 'unit-overlap', 'mapping', 'page', 'navigation', 'rendering']) {
    const f = fixture({ targetNavigationError: mode === 'navigation' });
    const value = mapping();
    if (mode === 'overlap') value.units.push({ ...value.units[0], id: 'other' });
    if (mode === 'unit-overlap') value.units[0].source.rects.push([...value.units[0].source.rects[0]]);
    if (mode === 'page') value.units[0].target.page = 5;
    if (mode === 'miss') value.units[0].source.rects = [[100, 100, 110, 110]];
    f.controller.attach(f.state, mode === 'mapping' ? null : value);
    if (mode === 'rendering') f.leftPage.renderingState = 0;
    pointer(f, {}, 'source');
    assert.doesNotThrow(() => f.controller.targetButton.emit('click'));
    assert.equal(f.destinations.length + f.targetDestinations.length, 0, mode);
    assert.equal(f.controller.highlight, null, mode);
    assert.match(f.controller.status.textContent, {
      miss: /没有已验证/, overlap: /重叠/, 'unit-overlap': /重叠/, mapping: /没有可用/,
      page: /译文页不存在/, navigation: /mock target navigation failure/, rendering: /请先/,
    }[mode]);
    assert.equal(f.state.sync, true);
    close(f);
  }
});

test('each navigation API degrades only its own direction, and new mappings clear both hits', () => {
  for (const index of [0, 1]) {
    const f = fixture();
    delete (index === 0 ? f.leftViewer : f.rightViewer).scrollPageIntoView;
    f.controller.attach(f.state, mapping());
    assert.equal(f.controller.button.disabled, index === 0);
    assert.equal(f.controller.targetButton.disabled, index === 1);
    assert.equal(f.controller.hoverButton.disabled, false);
    pointer(f, {}, 'source');
    pointer(f);
    (index === 0 ? f.controller.targetButton : f.controller.button).emit('click');
    assert.equal(f.destinations.length + f.targetDestinations.length, 1);
    f.controller.setMapping(mapping());
    assert.equal(f.controller.point, null);
    assert.equal(f.controller.sourcePoint, null);
    assert.equal(f.controller.highlight, null);
    f.controller.setMapping(null, 'hash_changed');
    assert.equal(f.controller.button.disabled, true);
    assert.equal(f.controller.targetButton.disabled, true);
    assert.equal(f.controller.status.textContent, 'hash_changed');
    close(f);
  }
});

test('pending translated highlights wait for their rendered viewport and clear on geometry or close', () => {
  for (const cancellation of [null, 'scalechanging', 'rotationchanging', 'pagesdestroy', 'close']) {
    const f = fixture();
    f.rightPage.renderingState = 0;
    f.controller.attach(f.state, mapping());
    pointer(f, {}, 'source');
    f.controller.targetButton.emit('click');
    assert.equal(f.targetDestinations.length, 1);
    assert.equal(f.controller.pendingIndex, 1);
    f.rightBus.emit('pagerendered', { pageNumber: 3 });
    assert.ok(f.controller.pending);
    if (cancellation === 'close') close(f);
    else if (cancellation) f.rightBus.emit(cancellation);
    f.rightPage.renderingState = 3;
    f.rightBus.emit('pagerendered', { pageNumber: 1 });
    assert.equal(!!f.controller.highlight, cancellation === null);
    if (!cancellation) {
      f.leftBus.emit('pagerendered', { pageNumber: 1 });
      assert.ok(f.controller.highlight, 'Unrelated source render does not remove the target paint');
      f.rightBus.emit('rotationchanging');
      assert.equal(f.controller.highlight, null);
    }
    close(f);
    assert.equal(f.timers.size, 0);
    assert.equal(f.controller.pending, null);
  }
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
    assert.equal(control.children[2], f.controller.targetButton);
    assert.equal(control.children[3], button);
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
