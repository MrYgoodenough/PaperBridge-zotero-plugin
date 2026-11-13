/* The helper must not hold Zotero's serial add-on startup queue. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../scripts/prepare_packaged_test.py"), "utf8");
const bootstrap = source.match(/bootstrap = '''([\s\S]*?)'''\.replace/)[1];
const turn = () => new Promise(resolve => setImmediate(resolve));

function context(initializationPromise, uiReadyPromise, delay) {
  const calls = [], errors = [], reports = [];
  const scope = {
    Zotero: { initializationPromise, uiReadyPromise, Promise: { delay }, logError: e => errors.push(e) },
    Services: { scriptloader: { loadSubScript: (...args) => calls.push(args) } },
    IOUtils: { writeUTF8: async (...args) => reports.push(args) },
    PathUtils: { join: path.join }, Cc: {}, Ci: {}, Components: {}, ChromeUtils: {},
    TEST_URI: "file:///workspace/tests/packaged.js", PROJECT_ROOT_LITERAL: "/workspace with spaces"
  };
  vm.createContext(scope);
  vm.runInContext(bootstrap, scope);
  return { scope, calls, errors, reports };
}

(async () => {
  let initialize, ready, finishDelay;
  const state = context(new Promise(r => initialize = r), new Promise(r => ready = r),
    () => new Promise(r => finishDelay = r));
  assert.equal(state.scope.startup(), undefined, "startup must return before dependencies become ready");
  assert.equal(state.calls.length, 0);
  initialize();
  await turn();
  assert.equal(state.calls.length, 0, "wait for UI readiness");
  ready();
  await turn();
  assert.equal(state.calls.length, 0, "wait for the real add-on");
  state.scope.Zotero.PaperBridge = {};
  finishDelay();
  await turn();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0][0], state.scope.TEST_URI);
  assert.equal(state.calls[0][1].PAPERBRIDGE_TEST_ROOT, state.scope.PROJECT_ROOT_LITERAL);
  assert.equal(state.errors.length, 0);

  let polls = 0;
  const missing = context(Promise.resolve(), Promise.resolve(), async () => polls++);
  assert.equal(missing.scope.startup(), undefined);
  await turn();
  assert.equal(polls, 100, "readiness polling must be bounded");
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.reports.length, 1);
  assert.equal(missing.reports[0][0], path.join("/workspace with spaces", ".runtime", "packaged-test.json"));
  const report = JSON.parse(missing.reports[0][1]);
  assert.equal(report.ok, false);
  assert.match(report.error, /did not start within 10 seconds/);
  console.log("Packaged helper non-blocking startup and timeout reporting passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
