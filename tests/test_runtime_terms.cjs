/** Check consent gates and the shipped window controller without claiming native UI acceptance. */
// Built-in Node APIs keep these core checks offline and independent of Zotero profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
// Load the production gate and controller, not duplicate implementations of consent behavior.
const termsSource = fs.readFileSync(path.join(__dirname, '../addon/content/runtime-terms.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../addon/content/runtime.js'), 'utf8');
const windowSource = fs.readFileSync(path.join(__dirname, '../addon/content/runtime-terms-window.js'), 'utf8');
const text = fs.readFileSync(path.join(__dirname, '../addon/licenses/supplemental/msvc/Microsoft-Runtime-Terms.txt'), 'utf8');
// Drain asynchronous offline reads before inspecting the control-only window.
const turn = () => new Promise(resolve => setImmediate(resolve));

/** Model only preferences, packaged text and window events; never launch Python or show native UI. */
function fixture(os = 'WINNT', prefs = new Map()) {
  const calls = { reads: [], writes: [], windows: [], launches: 0, unpacks: 0 };
  // WindowWatcher closure is distinct from document navigation/unload in native Gecko.
  const observers = new Set();
  const owner = {
    /** Evaluate the actual controller against a tiny control-only document. */
    openDialog(uri, name, features, args) {
      assert.equal(uri, 'chrome://paperbridge/content/runtime-terms.xhtml');
      assert.ok(!features.split(',').includes('modal'));
      const controls = Object.fromEntries(['terms-text', 'terms-accept', 'terms-decline', 'terms-status'].map(id => [id, {
        textContent: '', hidden: false, disabled: id === 'terms-accept', events: {},
        /** Retain a real controller callback for explicit unit-test dispatch. */
        addEventListener(event, handler) { this.events[event] = handler; },
        /** Observe keyboard focus without inventing default agreement. */
        focus() { this.focused = true; },
      }]));
      const window = { arguments: [args], controls, events: {}, closed: false,
        /** Retain load/unload/key callbacks rather than dispatch browser events. */
        addEventListener(event, handler) { this.events[event] = handler; },
        /** Closing must resolve the gate without writing agreement. */
        close() {
          this.closed = true; this.events.unload?.();
          for (const observer of [...observers]) observer.observe(this);
        },
        /** Observe coalesced window focus. */
        focus() { this.focused = true; },
      };
      vm.runInNewContext(windowSource, { window, document: { getElementById: id => controls[id] } });
      window.events.load();
      calls.windows.push(window);
      return window;
    },
  };
  const scope = {
    Zotero: { DataDirectory: { dir: '/fixture/data' }, getMainWindow: () => owner, Prefs: {
      /** Read only this synthetic profile's agreement preference. */
      get(name) { return prefs.get(name); },
      /** Record only an explicit accept callback; persistence failure leaves the window open. */
      set(name, value) {
        if (scope.failWrite) throw new Error('synthetic preference failure');
        calls.writes.push([name, value]); prefs.set(name, value);
      },
    }, File: {
      /** Read only the expected packaged URI, never a network resource. */
      async getContentsAsync(stream, charset) {
        assert.equal(charset, 'UTF-8');
        assert.equal(typeof stream, 'object', 'The deprecated URI overload returns an XHR, not agreement text');
        calls.reads.push(stream.path);
        assert.equal(stream.path, scope.MICROSOFT_RUNTIME_TERMS.path);
        if (scope.failRead) throw new Error('synthetic missing agreement');
        return text;
      },
    } },
    Services: { appinfo: { OS: os, XPCOMABI: 'x86_64-test' }, obs: {
      /** Observe only real top-level window closure, not initial document unload. */
      addObserver(observer, topic) { assert.equal(topic, 'domwindowclosed'); observers.add(observer); },
      /** Released windows cannot retain an addon scope or duplicate consent callback. */
      removeObserver(observer, topic) { assert.equal(topic, 'domwindowclosed'); observers.delete(observer); },
    }, io: {
      /** Keep archive identity synthetic while exercising the correct stream API. */
      newURI() { return { QueryInterface() { return { JARFile: { QueryInterface() { return { file: {} }; } } }; } }; },
    } },
    Ci: {}, Cc: { '@mozilla.org/libjar/zip-reader;1': {
      /** Model only opening/closing the explicit agreement member, never extraction. */
      createInstance() { return { open() {}, close() {}, getInputStream(name) { return { path: name }; } }; },
    } }, PathUtils: { join: path.posix.join },
  };
  vm.createContext(scope);
  vm.runInContext(termsSource, scope);
  vm.runInContext(runtimeSource, scope);
  const runtime = new scope.BundledRuntime('jar:file:///fixture.xpi!/', '0.3.6');
  // This counter is a unit-test connection, not an actual native engine health result.
  runtime.launch = async () => { calls.launches++; return { port: 12345, token: 'synthetic' }; };
  return { scope, runtime, calls, prefs, owner };
}

test('non-Windows platforms never request Microsoft agreement or read its text', async () => {
  for (const os of ['Linux', 'Darwin']) {
    const f = fixture(os);
    await f.runtime.ensure({ interactive: false });
    assert.equal(f.runtime.terms.required(), false);
    assert.equal(f.calls.launches, 1);
    assert.equal(f.calls.reads.length + f.calls.windows.length + f.calls.writes.length, 0);
  }
});

test('Windows background and direct launch cannot unpack or run before consent', async () => {
  const f = fixture();
  await assert.rejects(f.runtime.ensure({ interactive: false }), error => error.paperbridgeTerms);
  const direct = new f.scope.BundledRuntime('jar:file:///fixture.xpi!/', '0.3.6');
  direct.unpack = async () => { f.calls.unpacks++; };
  await assert.rejects(direct.launch(), error => error.paperbridgeTerms && error.paperbridgeStartup);
  assert.equal(f.calls.reads.length + f.calls.windows.length + f.calls.unpacks + f.calls.launches, 0);
});

test('closing refuses shared requests; explicit settings consent persists across versions and restarts', async () => {
  const f = fixture();
  const first = assert.rejects(f.runtime.ensure(), error => error.paperbridgeTerms);
  const second = assert.rejects(f.runtime.ensure(), error => error.paperbridgeTerms);
  await turn();
  assert.equal(f.calls.windows.length, 1);
  const window = f.calls.windows[0];
  // Native openDialog can unload about:blank while the actual consent window remains open.
  window.events.unload?.({ target: { documentURI: 'about:blank' } });
  await turn();
  assert.equal(f.runtime.terms.window, window);
  assert.equal(f.runtime.terms.declined, false);
  assert.equal(window.controls['terms-text'].textContent, text);
  assert.equal(window.controls['terms-decline'].focused, true);
  window.events.keydown({ key: 'Enter' });
  assert.equal(f.calls.writes.length, 0);
  window.controls['terms-decline'].events.click();
  await Promise.all([first, second]);
  await assert.rejects(f.runtime.ensure(), error => error.paperbridgeTerms);
  assert.equal(f.calls.windows.length, 1, 'A refused batch/session cannot repeatedly open agreement');
  assert.equal(f.calls.launches + f.calls.writes.length, 0);

  const review = f.runtime.terms.show(f.owner);
  await turn();
  f.calls.windows[1].controls['terms-accept'].events.click();
  assert.equal(await review, true);
  await Promise.all([f.runtime.ensure(), f.runtime.ensure()]);
  assert.equal(f.calls.launches, 1);
  assert.deepEqual(f.calls.writes, [[f.scope.MICROSOFT_RUNTIME_TERMS.preference, f.scope.MICROSOFT_RUNTIME_TERMS.id]]);

  const restarted = fixture('WINNT', f.prefs);
  restarted.runtime.version = '0.3.7';
  await restarted.runtime.ensure({ interactive: false });
  assert.equal(restarted.calls.launches, 1);
  assert.equal(restarted.calls.windows.length + restarted.calls.reads.length + restarted.calls.writes.length, 0);
  const acceptedReview = restarted.runtime.terms.show();
  await turn();
  const acceptedWindow = restarted.calls.windows[0];
  assert.equal(acceptedWindow.controls['terms-accept'].hidden, true);
  acceptedWindow.controls['terms-decline'].events.click();
  await acceptedReview;
  assert.equal(restarted.runtime.terms.accepted(), true, 'Closing review does not withdraw saved agreement');
});

test('stale agreement and failed preference/text reads never fabricate consent', async () => {
  const f = fixture();
  f.prefs.set(f.scope.MICROSOFT_RUNTIME_TERMS.preference, 'old-terms');
  await assert.rejects(f.runtime.ensure({ interactive: false }), error => error.paperbridgeTerms);
  const accepting = assert.rejects(f.runtime.ensure(), error => error.paperbridgeTerms);
  await turn();
  f.scope.failWrite = true;
  const window = f.calls.windows[0];
  window.controls['terms-accept'].events.click();
  assert.equal(window.closed, false);
  assert.match(window.controls['terms-status'].textContent, /未能保存/);
  window.events.keydown({ key: 'Escape' });
  await accepting;
  assert.equal(f.calls.writes.length + f.calls.launches, 0);
  const missing = fixture();
  missing.scope.failRead = true;
  await assert.rejects(missing.runtime.ensure(), /条款无法读取/);
  assert.equal(missing.calls.windows.length + missing.calls.writes.length + missing.calls.launches, 0);
});
