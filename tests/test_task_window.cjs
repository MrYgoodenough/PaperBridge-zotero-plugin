/** Verify compact task cards, progress evidence and delegated controls without a browser. */
// Standard Node boundaries keep this test independent of Zotero and model services.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Implement only the DOM operations used by the task window. */
class Element {
  /** Retain children, attributes and handlers for assertions. */
  constructor(tag) {
    this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {};
    this.hidden = false; this.open = false;
  }
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

/** Find nested card nodes without depending on layout or button order. */
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

/** Read the card surface, optionally excluding hidden blocks as well as details. */
function textOutsideDetails(root, visibleOnly = false) {
  if (root.tag === "details" || (visibleOnly && root.hidden)) return "";
  return [root.textContent || "", ...root.children.map(child => textOutsideDetails(child, visibleOnly))].join("\n");
}

/** Run a few representative snapshots through the real window renderer. */
async function main() {
  const elements = Object.fromEntries(["tasks", "summary", "status", "refresh", "close", "batch-details", "batch-label", "batch-skipped"]
    .map(id => [id, new Element(id === "batch-details" ? "details" : id)]));
  elements["batch-details"].append(elements["batch-label"], elements["batch-skipped"]);
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
  const row = find(elements.tasks, node => node.className?.split(" ").includes("task"));
  /** Locate each card part by its stable class rather than its position. */
  const part = name => find(row, node => node.className?.split(" ").includes(name));
  const title = find(part("task-header"), node => node.tag === "h2");
  const progressBlock = part("task-progress"), progress = find(progressBlock, node => node.tag === "progress");
  const details = part("details"), disclosure = part("task-details"), notice = part("notice"), badge = part("badge");
  const { cancel, retry, save, open } = Object.fromEntries(["cancel", "retry", "save", "open"]
    .map(name => [name, find(row, node => node.attributes["data-action"] === name)]));
  assert.equal(title.textContent, "Example <PDF>", "provider/document strings remain literal text");
  assert.match(part("phase").textContent, /启动引擎与准备论文/);
  assert.match(details.textContent, /段落：暂无统计/);
  assert.equal(disclosure.open, false, "raw details are collapsed by default");
  assert.equal(details.parent, disclosure);
  assert.equal(progress.value, undefined, "preparation is indeterminate, not fabricated percent completion");
  assert.equal(progressBlock.hidden, false);
  assert.equal(cancel.disabled, false);
  assert.equal(cancel.hidden, false);
  assert.equal(retry.disabled, true);
  for (const button of [retry, save, open]) assert.equal(button.hidden, true, "unavailable actions are hidden");
  assert.equal(row.scrolled, true);
  assert.equal(elements.summary.textContent, "1 个任务 · 1 进行中");
  assert.equal(elements.status.hidden, true);
  assert.equal(elements["batch-details"].hidden, true);

  record.jobID = "job";
  record.state = "running";
  const snapshot = { id: "job", state: "running", phase: "translating", stage: "逐段翻译", progress: 63.6,
    counts: { total: 12, success: 3, cache: 2, skipped: 1, failed: 1, unknown: 2, unresolved: 5, cache_hits: 4 },
    usage: { api_requests: 2, input_tokens: 100, output_tokens: 40, billing_uncertain: true },
    attempts: [{ state: "failed", created_at: "2026-11-12T08:00:00Z", finished_at: "2026-11-12T08:01:00Z" },
      { state: "running", created_at: "2026-11-13T08:00:00Z", started_at: "2026-11-13T08:00:30Z" }] };
  bridge.tasks.statuses.set("job", snapshot);
  redraw();
  assert.equal(progress.value, 64);
  assert.match(details.textContent, /阶段：翻译段落 · 逐段翻译/);
  assert.match(details.textContent, /已应用 5 \/ 12 · 新译 3 · 缓存应用 2 · 跳过 1/);
  assert.match(details.textContent, /失败 1 · 未知 2 · 未解决 5/);
  assert.match(details.textContent, /缓存命中 4 次/);
  assert.match(part("metrics").textContent, /已译 5 \/ 12 段/);
  assert.match(details.textContent, /2 次 API · 输入 100 · 输出 40 token/);
  assert.doesNotMatch(textOutsideDetails(row), /逐段翻译|token|新译|缓存应用|跳过 1|失败 1|未知 2|未解决 5|缓存命中/);
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /部分请求用量未知，可能已计费/);
  assert.match(details.textContent, /本次用时 2 分 0 秒（含排队） · 执行 1 分 30 秒/);
  assert.match(details.textContent, /完整性：未确认/, "percent is never a quality classifier");
  assert.doesNotMatch(badge.className, /\bsuccess\b/);
  disclosure.open = true;
  now += 1000;
  redraw();
  await timers.get(2000)();
  assert.match(details.textContent, /本次用时 2 分 1 秒/);
  assert.equal(find(elements.tasks, node => node === row), row, "polling preserves the controls' DOM identity");
  assert.equal(part("task-details"), disclosure);
  assert.equal(part("details"), details);
  assert.equal(disclosure.open, true, "polling preserves the user's expanded details");
  await cancel.handlers.click();
  assert.deepEqual(actions.pop(), ["cancel", record], "cancellation delegates owner semantics to tasks.js");

  record.state = snapshot.state = snapshot.attempts[1].state = "done";
  snapshot.phase = "finished";
  snapshot.progress = 100;
  snapshot.attempts[1].finished_at = "2026-11-13T08:01:20Z";
  record.quality = { status: "partial", counts: snapshot.counts };
  record.saveState = "import_failed";
  redraw();
  assert.match(details.textContent, /执行：译文已生成/);
  assert.match(details.textContent, /部分可用，请核对原文/);
  assert.match(retry.title, /重新翻译可能重复计费/);
  assert.equal(progressBlock.hidden, true, "terminal cards hide progress instead of displaying 100%/finished");
  assert.doesNotMatch(textOutsideDetails(row, true), /100%|finished|已结束/);
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /译文不完整，请对照原文核对/);
  assert.equal(badge.textContent, "保存失败");
  assert.doesNotMatch(badge.className, /\bsuccess\b/);
  assert.equal(cancel.disabled, true);
  assert.equal(retry.disabled, false);
  assert.equal(save.disabled, false);
  assert.equal(open.disabled, true);
  assert.equal(cancel.hidden, true);
  assert.equal(open.hidden, true);
  assert.equal(save.hidden, false);
  assert.equal(retry.hidden, false);
  assert.equal(save.className, "primary");
  assert.equal(retry.className, "secondary");
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
  assert.equal(open.hidden, false);
  assert.equal(save.disabled, true);
  assert.equal(save.hidden, true);
  assert.equal(open.className, "primary");
  assert.equal(badge.textContent, "部分译文");
  assert.doesNotMatch(badge.className, /\bsuccess\b/);
  assert.doesNotMatch(elements.summary.textContent, /已保存/, "saved partial results are not counted as complete");
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
  assert.equal(elements.status.hidden, false);

  record.saveState = "produced";
  delete record.attachmentKey;
  snapshot.usage.billing_uncertain = false;
  for (const [state, error, label, warning] of [["failed", "请求失败，请稍后重试", "翻译失败", /请求失败/],
    ["done", "", "待核对", /完整性尚未确认/]]) {
    record.state = snapshot.state = snapshot.attempts[1].state = state;
    record.quality = { status: "unknown" };
    record.lastError = error;
    redraw();
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, warning);
    assert.equal(badge.textContent, label);
    assert.doesNotMatch(badge.className, /\bsuccess\b/, "failure or unverified integrity is not success");
    assert.equal(progressBlock.hidden, true);
    assert.equal(save.hidden, state === "failed");
    assert.equal((state === "failed" ? retry : save).className, "primary");
  }

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
  assert.equal(progressBlock.hidden, true);

  record.detached = false;
  record.state = "queued";
  snapshot.state = "queued";
  snapshot.phase = "preparing";
  snapshot.counts = {};
  record.quality = { status: "unknown" };
  snapshot.attempts = [{ state: "queued", created_at: "2026-11-13T09:03:00Z" }];
  redraw();
  assert.match(details.textContent, /段落：暂无统计/, "a new retry does not borrow the old attempt's counts");
  assert.equal(progressBlock.hidden, false);
  bridge.tasks.batchSummary = { queued: 1, cached: 2, skipped: ["PDF A：已在队列", "PDF B：附件不可用"] };
  redraw();
  assert.equal(elements["batch-details"].hidden, false);
  assert.equal(elements["batch-details"].open, false, "batch skip reasons are collapsed by default");
  assert.equal(elements["batch-label"].textContent, "本批：新增 1 · 复用 2 · 跳过 2");
  assert.equal(elements["batch-skipped"].textContent, bridge.tasks.batchSummary.skipped.join("\n"));
  assert.equal(elements["batch-skipped"].parent, elements["batch-details"]);
  assert.doesNotMatch(elements.status.textContent, /本批|PDF A|PDF B/, "batch reasons do not accumulate in global status");
  bridge.library.records.push({ ...record, recordID: "another", sourceID: 2 });
  redraw();
  window.focusSource(1, "owner");
  assert.equal(row.className, "task selected");
  elements.close.handlers.click();
  assert.equal(timers.size, 0);
  assert.equal(actions.length, 0, "closing/reopening the view never cancels, retries or opens readers");
  console.log("Compact task cards, real counts, fixed timing, notices, details, batch skips and delegated actions passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
