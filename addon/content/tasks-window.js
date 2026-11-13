/** Render per-owner task outcomes without exposing prompts or credentials. */
/* global Zotero */
window.addEventListener("load", () => {
  // Dialog arguments reference the existing addon controller, not a second queue.
  const bridge = window.arguments[0].bridge;
  const tasks = bridge.tasks;
  // Reuse row nodes so polling never steals focus from task controls.
  const rows = new Map();
  // Execution, quality and saving are independent backend/library contracts.
  const states = { queued: "排队", running: "执行中", cancelling: "取消中", cancelled: "已取消",
    interrupted: "已中断（未自动重试）", failed: "失败", done: "引擎已产出" };
  // Quality describes observed paragraph application, not linguistic correctness.
  const qualities = { complete: "完整（已检查翻译单元）", partial: "部分可用，请核对原文", unusable: "不可用", unknown: "未确认" };
  // Imports can be retried without repeating translation.
  const saves = { produced: "待导入", imported: "已保存 Zotero 附件", import_failed: "导入失败，可单独重试保存" };
  // Phases are presentation only, never additional execution states.
  const phases = { preparing: "准备", parsing: "解析版面", translating: "翻译段落",
    typesetting: "排版", restoring: "恢复原文区域", finished: "已结束" };
  // Redraw elapsed time independently of potentially slow backend requests.
  const renderInterval = 500;
  // Share backend reads with the existing task monitor at a modest cadence.
  const refreshInterval = 2000;
  let sourceID = window.arguments[0].sourceID;
  let recordID = window.arguments[0].recordID;
  let focusPending = sourceID != null;
  let refreshing = false;
  let actionError = "";

  /** Create HTML nodes in a XUL document using text, never provider markup. */
  function node(tag, text, className) {
    const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  /** Show observed paragraph counts; missing evidence must not look like zero work. */
  function countsText(counts) {
    if (!counts || !Number.isFinite(counts.total)) return "段落：尚未取得实际计数（不按百分比估算）。";
    const count = name => Number.isFinite(counts[name]) && counts[name] >= 0 ? counts[name] : "—";
    const applied = typeof count("success") === "number" && typeof count("cache") === "number"
      ? counts.success + counts.cache : "—";
    return `段落：已应用 ${applied} / ${count("total")} · 新译 ${count("success")} · 缓存应用 ${count("cache")} · 跳过 ${count("skipped")}\n` +
      `失败 ${count("failed")} · 未知 ${count("unknown")} · 未解决 ${count("unresolved")}（含未知，不重复累加）` +
      (Number.isFinite(counts.cache_hits) ? ` · 缓存命中 ${count("cache_hits")} 次` : "");
  }

  /** Format a measured duration without allowing clock skew to show negative time. */
  function duration(start, end) {
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }

  /** Use only the current attempt's timestamps and never tick a terminal attempt. */
  function elapsedText(record, status) {
    if (record.detached && record.state === "cancelled") return "此归属已取消；共享任务可能仍在继续。取消用时未记录。";
    const attempt = status?.attempts?.at(-1) || status;
    const created = Date.parse(attempt?.created_at || attempt?.started_at);
    const started = Date.parse(attempt?.started_at);
    const finished = Date.parse(attempt?.finished_at);
    const terminal = tasks.terminal(record.state) || tasks.terminal(attempt?.state);
    const end = Number.isFinite(finished) ? finished : terminal ? NaN : Date.now();
    if (!Number.isFinite(created) || !Number.isFinite(end)) return terminal ? "本次用时：未记录。" : "本次用时：等待引擎创建尝试。";
    return `本次用时 ${duration(created, end)}（含排队）` +
      (Number.isFinite(started) ? ` · 执行 ${duration(started, end)}` : "");
  }

  /** Catch an individual action without stopping updates for other papers. */
  async function action(command) {
    actionError = "";
    try { await command(); await refresh(); }
    catch (error) { actionError = error.message; if (!window.closed) render(); }
  }

  /** Construct controls once to preserve focus while progress changes. */
  function row(record) {
    const container = node("section", "", "task");
    const title = node("h2");
    const progress = node("progress");
    progress.max = 100;
    progress.setAttribute("aria-label", "任务执行进度（不代表翻译质量）");
    const details = node("div", "", "details");
    const actions = node("div", "", "actions");
    const buttons = {};
    const commands = {
      cancel: ["取消此项", () => tasks.cancel(record)],
      retry: ["重试翻译…", async () => {
        await tasks.retry(record);
        if (!window.closed) window.focusSource(record.sourceID);
      }],
      save: ["重试保存", () => tasks.save(record)],
      open: ["打开译文", async () => {
        const attachment = await bridge.library.findAttachment(record);
        if (!attachment) throw new Error("译文附件不可用，缓存不会自动替代已删除的附件。");
        await Zotero.Reader.open(attachment.id);
      }]
    };
    for (const [name, [label, command]] of Object.entries(commands)) {
      const button = node("button", label);
      button.addEventListener("click", () => action(command));
      buttons[name] = button;
      actions.append(button);
    }
    container.append(title, progress, details, actions);
    document.getElementById("tasks").append(container);
    return { container, title, progress, details, buttons };
  }

  /** Update status independently from backend availability and attachment state. */
  function render() {
    const records = bridge.library.records.filter(record => record.jobID || record.fingerprint || states[record.state]);
    const selected = recordID ? records.find(record => record.recordID === recordID)
      : [...records].reverse().find(record => record.sourceID === sourceID);
    for (const [record, view] of rows) {
      if (!records.includes(record)) { view.container.remove(); rows.delete(record); }
    }
    for (const record of [...records].reverse()) {
      if (!rows.has(record)) rows.set(record, row(record));
      const view = rows.get(record);
      // Detached cancellations must not inherit another owner's continuing progress.
      const status = record.detached && record.state === "cancelled" ? null : tasks.statuses.get(record.jobID);
      const quality = record.quality?.status || "unknown";
      const usage = status?.usage;
      const preparing = !record.jobID && !tasks.terminal(record.state);
      const phase = preparing ? (record.fingerprint ? "正在确认提交结果…" : "正在启动引擎与准备论文…")
        : phases[status?.phase] || status?.phase || "尚无阶段信息";
      const percent = Number.isFinite(status?.progress) ? Math.round(Math.max(0, Math.min(100, status.progress))) : null;
      const counts = status?.counts && Object.keys(status.counts).length ? status.counts
        : (record.state === "done" ? status?.quality?.counts : status?.attempts?.at(-1)?.quality?.counts) || record.quality?.counts;
      view.title.textContent = record.title || record.sourceKey;
      view.container.className = record === selected ? "task selected" : "task";
      if (percent == null) view.progress.removeAttribute("value");
      else view.progress.value = percent;
      view.progress.hidden = tasks.terminal(record.state) && percent == null;
      view.details.textContent = `${record.model} · ${record.language} · 页码 ${record.pages || "全文"}\n` +
        `执行：${states[record.state] || record.state || "未知"} · ${percent == null ? "进度待确认" : percent + "%"}\n` +
        `阶段：${phase}${status?.stage ? " · " + status.stage : ""}\n` +
        `${countsText(counts)}${status?.cached ? "\n整篇 PDF 缓存复用（不是本次新译段落）。" : ""}\n` +
        `${elapsedText(record, status)}\n` +
        `质量：${qualities[quality] || "未确认"}　保存：${saves[record.saveState] || "尚未产出"}` +
        (tasks.terminal(record.state) && quality !== "complete" ? "\n如需继续翻译，请显式选择“重试翻译…”并确认可能重复计费；原结果保留。" : "") +
        (usage ? `\n重试链累计：${usage.api_requests || 0} 次 API · 输入 ${usage.input_tokens || 0} · 输出 ${usage.output_tokens || 0} token（仅已记录用量，不等于最终账单）` : "") +
        (usage?.billing_uncertain ? "\n部分请求计费未知：可能已收费但未收到用量。" : "") +
        (status?.attempts ? `\n尝试记录：${status.attempts.length} 次` : "") +
        (record.lastError ? `\n提示：${record.lastError}` : "");
      view.buttons.cancel.disabled = (!record.jobID && !!record.fingerprint) || tasks.terminal(record.state);
      view.buttons.retry.disabled = tasks.submitting.has(`${record.libraryID}:${record.sourceKey}`) ||
        (!record.jobID && !!record.fingerprint && record.saveState !== "imported") ||
        !tasks.terminal(record.state) || (record.saveState === "imported" && quality === "complete");
      view.buttons.save.disabled = record.state !== "done" || record.saveState === "imported" || quality === "unusable";
      view.buttons.open.disabled = !record.attachmentKey;
      view.buttons.open.textContent = quality === "partial" ? "打开部分译文" : "打开译文";
    }
    if (selected && focusPending) {
      rows.get(selected).container.scrollIntoView({ block: "nearest" });
      focusPending = false;
    }
    const summary = tasks.batchSummary;
    const preparingSelection = sourceID != null && !selected && bridge.readerWaits.has(sourceID);
    const messages = [actionError, tasks.lastError, preparingSelection ? "正在准备论文、检查已有译文并启动引擎…"
      : !records.length ? "暂无任务。请在文献库多选论文后使用批量翻译命令。" : ""];
    if (summary) messages.push(`本批：入队 ${summary.queued} · 已有译文 ${summary.cached} · 跳过 ${summary.skipped.length}`, ...summary.skipped);
    document.getElementById("status").textContent = messages.filter(Boolean).join("\n");
  }

  /** Reopening from a reader selects its existing row without creating a waiter. */
  window.focusSource = (id, selectedRecordID = null) => {
    sourceID = id;
    recordID = selectedRecordID;
    focusPending = id != null;
    render();
  };

  /** Refresh once per interval; the background monitor shares in-flight reads. */
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { await tasks.refresh(); }
    catch (error) { tasks.lastError = error.message; }
    finally { refreshing = false; if (!window.closed) render(); }
  }

  document.getElementById("refresh").addEventListener("click", () => refresh());
  document.getElementById("close").addEventListener("click", () => window.close());
  // Only the visible dialog uses a timer; closing it leaves the shared worker intact.
  const timer = window.setInterval(refresh, refreshInterval);
  const renderTimer = window.setInterval(render, renderInterval);
  window.addEventListener("unload", () => {
    window.clearInterval(timer);
    window.clearInterval(renderTimer);
  }, { once: true });
  render();
  refresh();
});
