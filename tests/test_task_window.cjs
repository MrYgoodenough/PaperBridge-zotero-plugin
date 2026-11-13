/** Verify the task view's progress evidence and controls without a browser framework. */
// Standard Node boundaries keep this test independent of Zotero and model services.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Implement only the DOM operations used by the task window. */
class Element {
  /** Retain children, attributes and handlers for assertions. */
  constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; }
  /** Keep parent relationships for removing stale rows. */
  append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
  /** Register one listener per tested event. */
  addEventListener(event, handler) { this.handlers[event] = handler; }
  /** Retain accessible labels as plain text. */
  setAttribute(name, value) { this.attributes[name] = value; }
  /** Reflect the native progress element's indeterminate state. */
  removeAttribute(name) { delete this.attributes[name]; if (name === "value") delete this.value; }
  /** Remove a row without replacing other controls. */
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  /** Record focus targeting without moving keyboard focus. */
  scrollIntoView() { this.scrolled = true; }
}

/** Run a few representative snapshots through the real window renderer. */
async function main() {
  const elements = Object.fromEntries(["tasks", "status", "refresh", "close"].map(id => [id, new Element(id)]));
  const events = {}, timers = new Map(), actions = [];
  let now = Date.parse("2026-11-13T08:02:00Z");
  const record = { recordID: "owner", sourceID: 1, sourceKey: "PDF", libraryID: 1, title: "Example <PDF>",
    state: "queued", model: "m", language: "zh-CN", pages: "1-3", quality: { status: "unknown" } };
  const bridge = { readerWaits: new Set([1]), library: { records: [record], findAttachment: async () => ({ id: 9 }) } };
  const context = vm.createContext({ Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/tasks.js"), "utf8"), context);
  bridge.tasks = new context.TranslationTasks(bridge);
  bridge.tasks.refresh = async () => {};
  for (const name of ["cancel", "retry", "save"]) bridge.tasks[name] = async item => { actions.push([name, item]); };
  const window = { arguments: [{ bridge, sourceID: 1 }],
    addEventListener: (event, handler) => { events[event] = handler; },
    setInterval: (handler, interval) => { timers.set(interval, handler); return interval; },
    clearInterval: id => timers.delete(id), close: () => { window.closed = true; events.unload(); } };
  Object.assign(context, { window, document: { getElementById: id => elements[id], createElementNS: (_, tag) => new Element(tag) },
    Zotero: { Reader: { open: async id => { actions.push(["open", id]); } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/tasks-window.js"), "utf8"), context);
  events.load();
  const redraw = timers.get(500);
  const row = elements.tasks.children[0];
  const [title, progress, details, controls] = row.children;
  const [cancel, retry, save, open] = controls.children;
  assert.equal(title.textContent, "Example <PDF>", "provider/document strings remain literal text");
  assert.match(details.textContent, /启动引擎与准备论文/);
  assert.match(details.textContent, /尚未取得实际计数/);
  assert.equal(progress.value, undefined, "preparation is indeterminate, not fabricated percent completion");
  assert.equal(cancel.disabled, false);
  assert.equal(retry.disabled, true);
  assert.equal(row.scrolled, true);

  record.jobID = "job";
  record.state = "running";
  const snapshot = { id: "job", state: "running", phase: "translating", stage: "逐段翻译", progress: 63.6,
    counts: { total: 12, success: 3, cache: 2, skipped: 1, failed: 1, unknown: 2, unresolved: 5, cache_hits: 4 },
    attempts: [{ state: "failed", created_at: "2026-11-12T08:00:00Z", finished_at: "2026-11-12T08:01:00Z" },
      { state: "running", created_at: "2026-11-13T08:00:00Z", started_at: "2026-11-13T08:00:30Z" }] };
  bridge.tasks.statuses.set("job", snapshot);
  redraw();
  assert.equal(progress.value, 64);
  assert.match(details.textContent, /阶段：翻译段落 · 逐段翻译/);
  assert.match(details.textContent, /已应用 5 \/ 12 · 新译 3 · 缓存应用 2 · 跳过 1/);
  assert.match(details.textContent, /失败 1 · 未知 2 · 未解决 5/);
  assert.match(details.textContent, /缓存命中 4 次/);
  assert.match(details.textContent, /本次用时 2 分 0 秒（含排队） · 执行 1 分 30 秒/);
  assert.match(details.textContent, /质量：未确认/, "percent is never a quality classifier");
  now += 1000;
  redraw();
  assert.match(details.textContent, /本次用时 2 分 1 秒/);
  assert.equal(elements.tasks.children[0], row, "polling preserves the controls' DOM identity");
  await cancel.handlers.click();
  assert.deepEqual(actions.pop(), ["cancel", record], "cancellation delegates owner semantics to tasks.js");

  record.state = snapshot.state = snapshot.attempts[1].state = "done";
  snapshot.phase = "finished";
  snapshot.progress = 100;
  snapshot.attempts[1].finished_at = "2026-11-13T08:01:20Z";
  record.quality = { status: "partial", counts: snapshot.counts };
  record.saveState = "import_failed";
  redraw();
  assert.match(details.textContent, /引擎已产出/);
  assert.match(details.textContent, /部分可用，请核对原文/);
  assert.match(details.textContent, /重试翻译.*可能重复计费/);
  assert.equal(cancel.disabled, true);
  assert.equal(retry.disabled, false);
  assert.equal(save.disabled, false);
  assert.equal(open.disabled, true);
  const frozen = details.textContent;
  now += 3600000;
  redraw();
  assert.equal(details.textContent, frozen, "terminal elapsed stays fixed at the current attempt's finish");
  assert.match(details.textContent, /本次用时 1 分 20 秒/);
  await retry.handlers.click();
  await save.handlers.click();
  assert.deepEqual(actions.splice(0), [["retry", record], ["save", record]]);
  record.attachmentKey = "SAVED";
  record.saveState = "imported";
  redraw();
  assert.equal(open.textContent, "打开部分译文");
  assert.equal(open.disabled, false);
  assert.equal(save.disabled, true);
  record.jobID = null;
  redraw();
  assert.equal(retry.disabled, false, "imported legacy results with no durable job ID still offer explicit retry");
  record.jobID = "job";
  await open.handlers.click();
  assert.deepEqual(actions.pop(), ["open", 9]);
  bridge.library.findAttachment = async () => null;
  await open.handlers.click();
  redraw();
  assert.match(elements.status.textContent, /译文附件不可用/, "elapsed redraws must not erase an action failure");

  delete snapshot.attempts[1].finished_at;
  redraw();
  assert.match(details.textContent, /本次用时：未记录/, "old terminal records never gain fabricated ticking durations");
  record.state = "cancelled";
  record.detached = true;
  snapshot.state = "running";
  redraw();
  const cancelled = details.textContent;
  now += 60000;
  snapshot.progress = 75;
  redraw();
  assert.equal(details.textContent, cancelled, "a cancelled owner cannot inherit shared live progress");

  record.detached = false;
  record.state = "queued";
  snapshot.state = "queued";
  snapshot.phase = "preparing";
  snapshot.counts = {};
  record.quality = { status: "unknown" };
  snapshot.attempts = [{ state: "queued", created_at: "2026-11-13T09:03:00Z" }];
  redraw();
  assert.match(details.textContent, /尚未取得实际计数/, "a new retry does not borrow the old attempt's counts");
  bridge.library.records.push({ ...record, recordID: "another", sourceID: 2 });
  redraw();
  window.focusSource(1, "owner");
  assert.equal(row.className, "task selected");
  elements.close.handlers.click();
  assert.equal(timers.size, 0);
  assert.equal(actions.length, 0, "closing/reopening the view never cancels, retries or opens readers");
  console.log("Task progress phases, real counts, attempt timing, partial controls and close/reopen rendering passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
