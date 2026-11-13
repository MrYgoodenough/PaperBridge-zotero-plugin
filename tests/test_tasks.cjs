/** Exercise batch ownership, save retries and restart behavior without model calls. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Build a small Zotero-shaped boundary, keeping queue logic real. */
function setup() {
  let imports = 0;
  let metadataFailures = 0;
  const requests = [];
  const attachments = new Map();
  const library = {
    records: [], matching: async () => null, configKey: config => JSON.stringify(config), sourceUnchanged: async () => true,
    describe: async () => ({ fingerprint: "fingerprint", document_key: "document" }),
    update: async (record, patch) => Object.assign(record, patch, patch.id ? { jobID: patch.id } : {},
      patch.document_key ? { documentKey: patch.document_key } : {}),
    attach: async (record, attachment) => Object.assign(record, { attachmentKey: attachment.key, saveState: "imported" }),
    findAttachment: async record => attachments.get(record.attachmentKey || record.importingAttachmentKey),
    ownerAlive: async () => true,
    put: async (source, _, config, status) => {
      const record = { recordID: "record" + library.records.length, config, sourceID: source.id, sourceKey: source.key, libraryID: 1, title: source.key,
        jobID: status.id, state: status.state, fingerprint: status.fingerprint, documentKey: status.document_key, ...config };
      library.records.push(record);
      return record;
    }
  };
  const context = vm.createContext({ Zotero: {
    Promise: { delay: async () => {} }, logError() {}, getMainWindow: () => ({}),
    Attachments: { importFromFile: async () => {
      imports++;
      const attachment = { id: imports, key: "PDF" + imports, setField(name, value) { this[name] = value; }, addRelation() {},
        saveTx: async () => { if (metadataFailures-- > 0) throw new Error("metadata failed"); } };
      attachments.set(attachment.key, attachment);
      return attachment;
    } }
  }, Services: { prompt: { confirm: () => true } }, IOUtils: { stat: async () => ({ size: 9, lastModified: 1 }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/tasks.js"), "utf8"), context);
  const bridge = { alive: true, library, jobs: new Map(), getKey: () => "test-key", setPref() {},
    configuration: () => ({ profile: "deepseek", model: "m", baseURL: "https://test.invalid", language: "zh-CN", pages: "" }),
    request: async (url, method, data) => { requests.push({ url, method, data }); return { id: "job1", state: "queued" }; } };
  const tasks = new context.TranslationTasks(bridge);
  tasks.monitor = () => {};
  return { tasks, bridge, library, requests, context, imports: () => imports, failMetadata: () => metadataFailures++ };
}

/** Pause one async boundary so duplicate clicks can be exercised deterministically. */
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Check reader preparation, duplicate reopening and explicit incomplete-result review. */
async function readerFlow(source) {
  const test = setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/paperbridge.js"), "utf8"), test.context);
  const bridge = Object.assign(test.context.PaperBridge, test.bridge, { tasks: test.tasks });
  test.tasks.bridge = bridge;
  bridge.pref = () => "m";
  bridge.source = async () => source;
  bridge.library.item = async () => source;
  const startup = deferred(), describing = deferred(), completed = deferred(), opening = deferred();
  let windows = 0, waits = 0, splits = 0;
  bridge.showTasks = () => { windows++; };
  bridge.split = async () => { splits++; await opening.promise; };
  bridge.library.describe = async () => {
    assert.ok(windows > 0, "the durable task view opens before backend startup");
    assert.equal(bridge.library.records.length, 1, "preparation already has its durable owner row");
    describing.resolve();
    await startup.promise;
    return { fingerprint: "fingerprint", document_key: "document" };
  };
  test.tasks.wait = async () => { waits++; return completed.promise; };
  const first = bridge.translate();
  await describing.promise;
  await bridge.translate();
  assert.equal(windows, 2);
  assert.equal(test.requests.length, 0);
  startup.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await bridge.translate();
  assert.equal(waits, 1, "reopening progress never registers another completion waiter");
  assert.equal(test.requests.length, 1);
  bridge.jobs.clear();
  bridge.library.records[0].state = "done";
  completed.resolve({ id: 99 });
  await new Promise(resolve => setImmediate(resolve));
  await bridge.translate();
  assert.equal(splits, 1, "the guard survives through the asynchronous split operation");
  opening.resolve();
  await first;
  assert.equal(bridge.readerWaits.size, 0);

  const previous = bridge.library.records[0];
  previous.saveState = "imported";
  for (const quality of ["partial", "unknown", "unusable"]) {
    previous.quality = { status: quality };
    await bridge.translate();
    assert.equal(test.requests.length, 1, "incomplete outcomes require explicit retry, not automatic submission");
    assert.equal(splits, 1, "an incomplete result is not presented as a complete cache hit");
  }
  previous.state = "failed";
  await bridge.translate();
  assert.equal(waits, 1);
  let warning = "";
  test.context.Services.prompt.confirm = (_, title, text) => { warning = text; return false; };
  await test.tasks.retry(previous);
  assert.match(warning, /可能重复计费/);
  assert.equal(test.requests.length, 1, "declining explicit retry cannot send a new request");
  previous.state = "running";
  await bridge.translate();
  assert.equal(waits, 1, "an active batch/recovered task stays save-only when inspected from the reader");
  previous.state = "done";
  previous.quality = { status: "complete" };
  bridge.library.matching = async () => ({ id: 99 });
  await bridge.translate();
  assert.equal(splits, 2, "verified complete attachments retain the single-reader split path");
}

/** Keep batch selection from silently resending reviewable outcomes. */
async function batchReview() {
  const test = setup();
  const config = test.bridge.configuration();
  const outcomes = [
    { state: "failed" }, { state: "interrupted" }, { state: "cancelled" },
    { state: "done", quality: { status: "partial" }, saveState: "imported" },
    { state: "done", quality: { status: "unusable" } },
    { state: "done", quality: { status: "unknown" }, saveState: "imported" },
    { state: "done", quality: { status: "complete" }, saveState: "import_failed" }
  ];
  const sources = outcomes.map((outcome, index) => {
    const source = { id: index + 10, key: "SOURCE" + index, libraryID: 1, getField: () => "Paper " + index,
      fileExists: async () => true, getFilePathAsync: async () => "/paper" + index + ".pdf" };
    test.library.records.push({ ...outcome, recordID: "review" + index, sourceID: source.id,
      sourceKey: source.key, libraryID: source.libraryID, config });
    return source;
  });
  const cached = { ...sources[0], id: 30, key: "COMPLETE" };
  // Older failures must not block the latest complete, saved outcome.
  test.library.records.push({ state: "failed", sourceID: cached.id, sourceKey: cached.key, libraryID: 1, config },
    { state: "done", quality: { status: "complete" }, saveState: "imported",
      sourceID: cached.id, sourceKey: cached.key, libraryID: 1, config });
  const fresh = { ...sources[0], id: 31, key: "NEW", getFilePathAsync: async () => "/fresh.pdf" };
  test.library.matching = async source => source.id === cached.id ? { id: 99 } : null;
  const focused = [];
  test.bridge.showTasks = (sourceID, recordID) => { if (recordID) focused.push(recordID); };
  test.bridge.sourceForItem = async item => item;
  test.context.Zotero.getMainWindow = () => ({ ZoteroPane: {
    getSelectedItems: () => [...sources, sources[0], cached, fresh]
  } });
  const summary = await test.tasks.batch();
  assert.equal(summary.skipped.length, outcomes.length);
  assert.ok(summary.skipped.every(message => message.includes("显式重试或重新保存")));
  assert.deepEqual(focused, outcomes.map((_, index) => "review" + index));
  assert.equal(summary.cached, 1);
  assert.equal(summary.queued, 1, "reviewable items must not block unrelated new work");
  assert.equal(test.requests.length, 1, "only the new paper may send a translation request");
  assert.equal(test.requests[0].data.source_path, "/fresh.pdf");
  assert.equal(test.library.records.length, outcomes.length + 3, "reviewable history remains unchanged");
}

/** Run meaningful queue contracts rather than duplicating backend scheduling tests. */
async function main() {
  const test = setup();
  const source = { id: 1, key: "SOURCE", libraryID: 1, fileExists: async () => true, getFilePathAsync: async () => "/paper.pdf" };
  const { record } = await test.tasks.enqueue(source);
  assert.equal(record.jobID, "job1");
  assert.equal(record.model, "m");
  await assert.rejects(test.tasks.enqueue(source), /已在任务列表/);
  const status = { id: "job1", state: "done", output_path: "/translated.pdf", quality: { status: "partial" } };
  test.failMetadata();
  await assert.rejects(test.tasks.save(record, status), /metadata failed/);
  assert.equal(record.saveState, "import_failed");
  assert.equal(test.imports(), 1);
  await Promise.all([test.tasks.save(record, status), test.tasks.save(record, status)]);
  assert.equal(test.imports(), 1, "retry metadata without reimporting PDF");
  assert.equal(record.saveState, "imported");
  assert.equal(record.quality.status, "partial");
  assert.match((await test.library.findAttachment(record)).title, /部分可用/);

  const preparing = setup();
  const startup = deferred();
  preparing.library.describe = () => startup.promise;
  const enqueue = preparing.tasks.enqueue(source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparing.library.records.length, 1);
  const preparation = preparing.library.records[0];
  await preparing.tasks.cancel(preparation);
  startup.resolve({ fingerprint: "fingerprint", document_key: "document" });
  await enqueue;
  assert.equal(preparation.state, "cancelled");
  assert.equal(preparing.requests.length, 0, "cancelling preparation must not submit or call a null job endpoint");
  assert.equal(await preparing.tasks.wait(preparation), null);
  preparing.library.item = async () => source;
  await preparing.tasks.retry(preparation);
  assert.equal(preparing.library.records.length, 2, "explicit preparation retry retains the cancelled owner history");
  assert.equal(preparation.state, "cancelled");
  assert.equal(preparing.requests.length, 1);

  const interruptedPreparation = setup();
  const unsent = { sourceID: 20, state: "queued" };
  interruptedPreparation.library.records.push(unsent);
  await interruptedPreparation.tasks.resume();
  assert.equal(unsent.state, "interrupted");
  assert.equal(interruptedPreparation.requests.length, 0, "restart does not replay unfinished preparation");

  const batch = setup();
  batch.context.Zotero.getMainWindow = () => ({ ZoteroPane: { getSelectedItems: () => [source, source] } });
  batch.bridge.sourceForItem = async item => item;
  batch.bridge.showTasks = () => {};
  batch.bridge.split = () => assert.fail("batch must not open a split");
  batch.tasks.wait = () => assert.fail("batch must not register a reader waiter");
  const summary = await batch.tasks.batch();
  assert.equal(summary.queued, 1);
  assert.equal(batch.requests.length, 1);

  const cancel = setup();
  const first = { sourceID: 1, jobID: "shared", state: "queued" };
  const second = { sourceID: 2, jobID: "shared", state: "queued" };
  cancel.library.records.push(first, second);
  await cancel.tasks.cancel(first);
  assert.equal(cancel.requests.length, 0, "one owner cannot cancel another owner's shared work");
  assert.equal(first.detached, true);
  await cancel.tasks.cancel(second);
  assert.equal(cancel.requests[0].url, "/jobs/shared/cancel");

  const failedWrite = setup();
  const cancelled = { sourceID: 3, jobID: "cancel-write", state: "running" };
  failedWrite.library.records.push(cancelled);
  failedWrite.bridge.jobs.set(3, cancelled.jobID);
  failedWrite.library.update = async (record, patch) => { Object.assign(record, patch); throw new Error("disk full"); };
  await assert.rejects(failedWrite.tasks.cancel(cancelled), /disk full/);
  assert.equal(failedWrite.bridge.jobs.has(3), false, "failed cancellation persistence cannot lock the source forever");

  const retryWrite = setup();
  const previous = { sourceID: 4, recordID: "record", jobID: "old", state: "failed", baseURL: "https://test.invalid" };
  retryWrite.library.records.push(previous);
  retryWrite.library.forkAttempt = async (record, status) => {
    retryWrite.library.records.push({ ...record, recordID: "retry", jobID: status.id, detached: false, state: status.state });
    throw new Error("disk full");
  };
  let monitored = false;
  retryWrite.tasks.monitor = () => { monitored = true; };
  await assert.rejects(retryWrite.tasks.retry(previous), /disk full/);
  assert.equal(retryWrite.bridge.jobs.get(4), "job1", "accepted retries stay tracked even if their index write fails");
  assert.equal(monitored, true);
  assert.equal(previous.detached, true, "superseded unimported outcomes are not automatically imported");

  const retryLost = setup();
  const origin = { sourceID: 5, recordID: "origin", jobID: "before-retry", state: "failed", baseURL: "https://test.invalid" };
  retryLost.library.records.push(origin);
  retryLost.library.forkAttempt = async (record, status) => {
    const attempt = { ...record, recordID: "after", jobID: status.id, retryPendingSince: null, detached: false, state: status.state };
    retryLost.library.records.push(attempt);
    return attempt;
  };
  let retrySends = 0;
  retryLost.bridge.request = async (_, method) => {
    if (method === "POST") { retrySends++; throw new Error("retry response lost"); }
    return [{ id: "after-retry", previous_job_id: origin.jobID, created_at: new Date().toISOString(), state: "interrupted" }];
  };
  await assert.rejects(retryLost.tasks.retry(origin), /retry response lost/);
  await retryLost.tasks.refresh();
  assert.equal(retryLost.library.records[1].jobID, "after-retry");
  assert.equal(origin.retryPendingSince, null);
  assert.equal(retrySends, 1, "a lost retry response is reconciled without resending");

  const restart = setup();
  const interrupted = { sourceID: 9, jobID: "lost", state: "running" };
  restart.library.records.push(interrupted);
  restart.bridge.request = async (url, method) => {
    assert.equal(url, "/jobs"); assert.equal(method, undefined, "recovery must never resubmit"); return [];
  };
  await restart.tasks.refresh();
  assert.equal(interrupted.state, "interrupted");
  assert.match(interrupted.lastError, /没有自动重新发送/);

  const lost = setup();
  let sends = 0;
  lost.bridge.request = async (_, method) => {
    if (method === "POST") { sends++; throw new Error("response lost"); }
    return [{ id: "recovered", fingerprint: "fingerprint", document_key: "document", state: "interrupted" }];
  };
  await assert.rejects(lost.tasks.enqueue(source), /response lost/);
  assert.equal(lost.library.records.length, 1, "ownership precedes submission");
  await lost.tasks.refresh();
  assert.equal(lost.library.records[0].jobID, "recovered");
  assert.equal(sends, 1, "recovery binds a lost response without sending again");
  const legacy = setup();
  const imported = { sourceID: source.id, sourceKey: source.key, libraryID: 1, state: "done",
    baseURL: "https://test.invalid", fingerprint: "old-fingerprint", saveState: "imported", attachmentKey: "OLD",
    quality: { status: "unknown" }, config: legacy.bridge.configuration() };
  legacy.library.records.push(imported);
  legacy.library.item = async () => source;
  await legacy.tasks.retry(imported);
  assert.equal(legacy.requests.length, 1, "confirmed legacy retry creates a new job rather than waiting for a nonexistent ID");
  assert.equal(imported.attachmentKey, "OLD");
  assert.equal(legacy.library.records.length, 2, "the old imported result remains in history");
  await readerFlow(source);
  await batchReview();
  console.log("Batch deduplication, shared cancellation, idempotent save and passive/lost-response recovery passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
