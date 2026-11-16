/** Check platform launch options and non-blocking helpers without native Zotero execution. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Read the injected helper rather than maintaining a duplicate bootstrap implementation.
const source = fs.readFileSync(path.join(__dirname, "../scripts/prepare_packaged_test.py"), "utf8");
// Keep the startup contract tied to the actual isolated-profile preparation script.
const bootstrap = source.match(/bootstrap = '''([\s\S]*?)'''\.replace/)[1];
/** Drain one event-loop turn after deferred initialization. */
const turn = () => new Promise(resolve => setImmediate(resolve));
// Evaluate shipped launch code with native-path semantics for every supported platform.
const runtimeSource = fs.readFileSync(path.join(__dirname, "../addon/content/runtime.js"), "utf8");
// Interpreter-option fixtures assume prior consent; dedicated tests exercise refusal and the real UI controller.
const termsSource = fs.readFileSync(path.join(__dirname, "../addon/content/runtime-terms.js"), "utf8");
// These are layout/API contracts, not native OS or macOS v0.4.2 acceptance results.
const platforms = [
  { os: "Linux", abi: "x86_64-gcc3", id: "linux-x64", machine: "x86_64", python: "python/bin/python3.12" },
  { os: "Darwin", abi: "aarch64-gcc3", id: "macos-arm64", machine: "arm64", python: "python/bin/python3.12" },
  { os: "WINNT", abi: "x86_64-msvc", id: "windows-x64", machine: "AMD64", python: "python/python.exe" },
];

/** Capture real platform options, stopping before any subprocess is executed. */
async function checkRuntime(platform, mode) {
  const paths = platform.os === "WINNT" ? path.win32 : path.posix;
  const root = platform.os === "WINNT" ? "C:\\Users\\offline\\Data space 中文" : "/offline/Data space 中文";
  const calls = [];
  const captured = new Error("Offline subprocess capture");
  const scope = {
    Zotero: { DataDirectory: { dir: root }, Prefs: {
      /** Model prior agreement only in these non-native launch-option fixtures. */
      get: name => name === scope.MICROSOFT_RUNTIME_TERMS.preference ? scope.MICROSOFT_RUNTIME_TERMS.id : ""
    }, debug: () => {} },
    Services: { appinfo: { OS: platform.os, XPCOMABI: platform.abi, processID: 42 },
      dirsvc: { get: key => ({ path: paths.join(root, key) }) } },
    Ci: { nsIFile: {} },
    PathUtils: {
      /** Gecko requires individual components after the initial absolute path. */
      join(base, ...parts) {
        assert.ok(parts.every(part => !/[\\/]/.test(part)), "split nested path components");
        return paths.join(base, ...parts);
      },
    },
    IOUtils: { makeDirectory: async () => {}, remove: async () => {}, exists: async () => true },
    ChromeUtils: { importESModule: () => ({ Subprocess: {
      /** Probe locally in memory; launch options are captured, never executed. */
      async call(options) {
        calls.push(options);
        if (options.arguments.includes("-c")) {
          return { stdout: { readString: async () => "paperbridge-python-ok" },
            wait: async () => ({ exitCode: 0 }) };
        }
        throw captured;
      },
    } }) },
  };
  vm.createContext(scope);
  vm.runInContext(termsSource, scope);
  vm.runInContext(runtimeSource, scope);
  const runtime = new scope.BundledRuntime("jar:file:///offline.xpi!/", "0.3.2");
  const description = runtime.platform();
  for (const key of ["id", "machine", "python"]) assert.equal(description[key], platform[key]);
  runtime.build = { pythonMode: mode };
  // Test launch/candidate selection independently of extraction and bundled models.
  runtime.unpack = runtime.seedCache = async () => {};
  await assert.rejects(runtime.launch(), error => error === captured);
  const launch = calls.at(-1);
  const expectedPython = mode === "bundled"
    ? paths.join(runtime.home, ...platform.python.split("/")) : runtime.pythonCandidates(description)[0];
  assert.equal(launch.command, expectedPython);
  assert.ok(paths.isAbsolute(launch.command));
  assert.deepEqual(Array.from(launch.arguments), ["-X", "utf8", "-I", "-S", "-B",
    paths.join(runtime.home, "backend", "launcher.py"), "server.py", "0", "--parent-pid", "42"]);
  assert.equal(launch.workdir, runtime.home);
  assert.equal(launch.environmentAppend, true);
  assert.equal(launch.environment.PYTHONHOME, null);
  assert.equal(launch.environment.PYTHONPATH, null);
  assert.equal(launch.environment.PYTHONNOUSERSITE, "1");
  assert.equal(launch.environment.PAPERBRIDGE_CACHE_DIR, runtime.cache);
  assert.equal(launch.environment.PAPERBRIDGE_STATE_DIR, runtime.state);
  if (platform.os === "Linux") {
    assert.equal(launch.environment.LD_LIBRARY_PATH, null);
    assert.equal(launch.environment.LD_PRELOAD, null);
  } else {
    assert.equal(Object.hasOwn(launch.environment, "LD_LIBRARY_PATH"), false);
  }
  if (mode === "local") {
    assert.equal(calls.length, 2);
    assert.ok(calls[0].arguments.at(-1).includes(`platform.machine()=='${platform.machine}'`));
    await checkPythonPathDeferral(scope, runtime, paths);
  } else {
    assert.equal(calls.length, 1);
  }
}

/** Exercise real launch/reuse/exit logic with native subprocess boundaries kept offline. */
async function checkPythonPathDeferral(scope, runtime, paths) {
  const launches = [], children = [];
  let kills = 0;
  let configured = runtime.python;
  const previousPref = scope.Zotero.Prefs.get;
  scope.Zotero.Prefs.get = name => name === "extensions.paperbridge.pythonPath" ? configured : previousPref(name);
  scope.IOUtils.readUTF8 = async file => paths.basename(file) === "token"
    ? "synthetic-token" : JSON.stringify({ port:12300 + launches.length });
  scope.ChromeUtils.importESModule = () => ({ Subprocess: {
    /** Probe in memory and expose a manually completed native-process promise. */
    async call(options) {
      if (options.arguments.includes("-c")) return {
        stdout:{ readString:async () => "paperbridge-python-ok" }, wait:async () => ({ exitCode:0 })
      };
      let exit;
      const completion = new Promise(resolve => { exit = resolve; });
      const process = { stdout:{ readString:async () => "" }, wait:() => completion,
        /** Explicit shutdown remains available; preference changes must never call it. */
        kill() { kills++; exit({ exitCode:0 }); }
      };
      launches.push(options);
      children.push({ process, exit });
      return process;
    }
  } });
  const original = await runtime.ensure({ interactive:false });
  const running = runtime.process;
  const pending = runtime.pending;
  configured = paths.join(runtime.base, "new-python");
  assert.strictEqual(await runtime.ensure({ interactive:false }), original);
  assert.strictEqual(runtime.process, running);
  assert.strictEqual(runtime.pending, pending);
  assert.equal(launches.length, 1);
  assert.equal(kills, 0);
  assert.notEqual(runtime.python, configured, "a saved setting does not replace a live interpreter");

  // Finish only this synthetic child; exercise the actual process.wait cleanup callback.
  children[0].exit({ exitCode:0 });
  await turn();
  assert.equal(runtime.connection, null);
  assert.equal(runtime.process, null);
  assert.equal(runtime.pending, null);
  const [next, shared] = await Promise.all([runtime.ensure({ interactive:false }), runtime.ensure({ interactive:false })]);
  assert.strictEqual(next, shared, "next use still shares one launch, not a replacement scheduler");
  assert.notStrictEqual(next, original);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].command, configured);
  assert.equal(kills, 0);
  await runtime.stop();
  assert.equal(kills, 1, "only explicit lifecycle shutdown stops the synthetic runtime");
}

/** Mock dependency readiness without loading Zotero or a user profile. */
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
  for (const platform of platforms) {
    for (const mode of ["bundled", "local"]) await checkRuntime(platform, mode);
  }
  console.log("Six platform/Python launch contracts passed (mocked, not native Zotero)");
  console.log("Saved Python paths wait for natural exit and one next-use launch on all three local platforms (mocked)");
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
