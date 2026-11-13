/** Render per-owner task outcomes without exposing prompts or credentials. */
/* global Zotero */
window.addEventListener("load", () => {
  // Dialog arguments reference the existing addon controller, not a second queue.
  const bridge = window.arguments[0].bridge;
  const tasks = bridge.tasks;
  // Reuse row nodes so polling never steals focus from task controls.
  const rows = new Map();
  // Execution, quality and saving are independent backend/library contracts.
  const states = { queued: "排队中", running: "翻译中", cancelling: "取消中", cancelled: "已取消",
    interrupted: "已中断", failed: "翻译失败", done: "译文已生成" };
  // Quality describes observed paragraph application, not linguistic correctness.
  const qualities = { complete: "完整（翻译单元检查通过，不代表语义质量）", partial: "部分可用，请核对原文", unusable: "不可用", unknown: "未确认" };
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
  function countsText(counts, compact = false) {
    if (!counts || !Number.isFinite(counts.total)) return compact ? "" : "段落：暂无统计。";
    const count = name => Number.isFinite(counts[name]) && counts[name] >= 0 ? counts[name] : "—";
    const applied = typeof count("success") === "number" && typeof count("cache") === "number"
      ? counts.success + counts.cache : "—";
    if (compact) return applied === "—" ? "" : `已译 ${applied} / ${count("total")} 段`;
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
  function elapsedText(record, status, compact = false) {
    if (record.detached && record.state === "cancelled") return compact ? "" : "此项已取消；共享任务可能仍在继续。";
    const attempt = status?.attempts?.at(-1) || status;
    const created = Date.parse(attempt?.created_at || attempt?.started_at);
    const started = Date.parse(attempt?.started_at);
    const finished = Date.parse(attempt?.finished_at);
    const terminal = tasks.terminal(record.state) || tasks.terminal(attempt?.state);
    const end = Number.isFinite(finished) ? finished : terminal ? NaN : Date.now();
    if (!Number.isFinite(created) || !Number.isFinite(end)) return compact ? ""
      : terminal ? "本次用时：未记录。" : "本次用时：等待引擎创建尝试。";
    if (compact) return `用时 ${duration(created, end)}`;
    return `本次用时 ${duration(created, end)}（含排队）` +
      (Number.isFinite(started) ? ` · 执行 ${duration(started, end)}` : "");
  }

  /** Catch an individual action without stopping updates for other papers. */
  async function action(command) {
    actionError = "";
    try { await command(); await refresh(); }
    catch (error) { actionError = error.message; if (!window.closed) render(); }
  }

  /** Present one actionable state without conflating completion with verified quality. */
  function outcome(record, quality) {
    if (record.saveState === "import_failed") return ["保存失败", "error"];
    if (record.state === "done") {
      if (quality === "unusable") return ["译文不可用", "error"];
      if (quality === "partial") return ["部分译文", "warning"];
      if (quality !== "complete") return ["待核对", "warning"];
      return record.saveState === "imported" ? ["已保存", "success"] : ["待保存", "warning"];
    }
    const tone = ["failed", "interrupted"].includes(record.state) ? "error"
      : tasks.terminal(record.state) ? "muted" : "running";
    return [states[record.state] || "状态未知", tone];
  }

  /** Construct controls once to preserve focus while progress changes. */
  function row(record) {
    const container = node("section", "", "task");
    const header = node("div", "", "task-header");
    const title = node("h2");
    const badge = node("span", "", "badge");
    const meta = node("div", "", "task-meta");
    const progressBlock = node("div", "", "task-progress");
    const progressHeading = node("div", "", "progress-heading");
    const phase = node("span", "", "phase");
    const percent = node("span", "", "percent");
    const progress = node("progress");
    progress.max = 100;
    progress.setAttribute("aria-label", "任务执行进度（不代表翻译质量）");
    const metrics = node("div", "", "metrics");
    const notice = node("div", "", "notice");
    const disclosure = node("details", "", "task-details");
    const details = node("div", "", "details");
    const actions = node("div", "", "actions buttons");
    const buttons = {};
    const commands = {
      open: ["打开译文", async () => {
        const attachment = await bridge.library.findAttachment(record);
        if (!attachment) throw new Error("译文附件不可用，缓存不会自动替代已删除的附件。");
        await Zotero.Reader.open(attachment.id);
      }],
      save: ["保存译文", () => tasks.save(record)],
      file: ["保留 PDF 的位置", () => tasks.revealOutput(record)],
      retry: ["重试翻译…", async () => {
        await tasks.retry(record);
        if (!window.closed) window.focusSource(record.sourceID);
      }],
      cancel: ["取消", () => tasks.cancel(record)]
    };
    for (const [name, [label, command]] of Object.entries(commands)) {
      const button = node("button", label);
      button.setAttribute("data-action", name);
      if (name === "retry") button.title = "保留原结果；重新翻译可能重复计费。";
      button.addEventListener("click", () => action(command));
      buttons[name] = button;
      actions.append(button);
    }
    header.append(title, badge);
    progressHeading.append(phase, percent);
    progressBlock.append(progressHeading, progress, metrics);
    disclosure.append(node("summary", "查看详情"), details);
    container.append(header, meta, progressBlock, notice, actions, disclosure);
    document.getElementById("tasks").append(container);
    return { container, title, badge, meta, progressBlock, phase, percent, progress, metrics, notice, details, buttons, actions };
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
      const terminal = tasks.terminal(record.state);
      const preparing = !record.jobID && !tasks.terminal(record.state);
      const phase = preparing ? (record.fingerprint ? "正在确认提交结果…" : "正在启动引擎与准备论文…")
        : phases[status?.phase] || status?.phase || "尚无阶段信息";
      const percent = Number.isFinite(status?.progress) ? Math.round(Math.max(0, Math.min(100, status.progress))) : null;
      const counts = status?.counts && Object.keys(status.counts).length ? status.counts
        : (record.state === "done" ? status?.quality?.counts : status?.attempts?.at(-1)?.quality?.counts) || record.quality?.counts;
      view.title.textContent = record.title || record.sourceKey;
      view.container.className = record === selected ? "task selected" : "task";
      const [label, tone] = outcome(record, quality);
      view.badge.textContent = label;
      view.badge.className = "badge " + tone;
      const language = /^zh(?:[-_]cn)?$/i.test(record.language || "") ? "中文" : record.language;
      view.meta.textContent = [record.model, language, record.pages ? `第 ${record.pages} 页` : "全文"].filter(Boolean).join(" · ");
      if (percent == null) view.progress.removeAttribute("value");
      else view.progress.value = percent;
      // Finished cards need an outcome and action, not another 100%/finished indicator.
      view.progressBlock.hidden = terminal;
      view.phase.textContent = phase;
      view.percent.textContent = percent == null ? "" : percent + "%";
      view.metrics.textContent = [countsText(counts, true), elapsedText(record, status, true)].filter(Boolean).join(" · ");
      const notices = [record.lastError, record.errorHint,
        record.state === "done" && quality === "partial" ? "译文不完整，请对照原文核对。" : "",
        record.state === "done" && quality === "unknown" ? "译文完整性尚未确认，请核对后使用。" : "",
        usage?.billing_uncertain ? "部分请求用量未知，可能已计费。" : ""];
      view.notice.textContent = [...new Set(notices.filter(Boolean))].join("\n");
      view.notice.hidden = !view.notice.textContent;
      view.notice.className = tone === "error" ? "notice error" : "notice";
      view.details.textContent = `执行：${states[record.state] || record.state || "未知"}\n` +
        `配置：${record.profile || "deepseek"} · ${record.baseURL || "未记录 API 地址"}\n` +
        (record.errorCode ? `错误类别：${record.errorCode}\n` : "") +
        `阶段：${phase}${status?.stage ? " · " + status.stage : ""}\n` +
        `${countsText(counts)}${status?.cached ? "\n整篇 PDF 缓存复用（不是本次新译段落）。" : ""}\n` +
        `${elapsedText(record, status)}\n` +
        `完整性：${qualities[quality] || "未确认"}\n保存：${saves[record.saveState] || "尚未产出"}` +
        (usage ? `\n已记录累计用量：${usage.api_requests ?? "—"} 次 API · 输入 ${usage.input_tokens ?? "—"} · 输出 ${usage.output_tokens ?? "—"} token（不等于最终账单）` : "") +
        (status?.attempts?.length > 1 ? `\n尝试记录：${status.attempts.length} 次` : "");
      view.buttons.cancel.disabled = (!record.jobID && !!record.fingerprint) || tasks.terminal(record.state);
      view.buttons.retry.disabled = tasks.submitting.has(`${record.libraryID}:${record.sourceKey}`) ||
        !tasks.terminal(record.state) || (record.saveState === "imported" && quality === "complete");
      view.buttons.save.disabled = (!tasks.terminal(record.state) || (!record.outputPath && record.state !== "done")) ||
        record.saveState === "imported" || quality === "unusable";
      view.buttons.file.disabled = !record.outputPath || record.outputAvailable === false;
      view.buttons.open.disabled = !record.attachmentKey;
      view.buttons.open.textContent = quality === "partial" ? "打开部分译文" : "打开译文";
      view.buttons.save.textContent = record.state !== "done" ? "恢复保留译文…" : record.saveState === "import_failed" ? "重试保存" : "保存译文";
      let primary = true;
      for (const [name, button] of Object.entries(view.buttons)) {
        button.hidden = button.disabled;
        button.className = name === "cancel" ? "danger" : !button.disabled && primary ? "primary" : "secondary";
        if (!button.disabled && name !== "cancel") primary = false;
      }
      view.actions.hidden = Object.values(view.buttons).every(button => button.hidden);
    }
    if (selected && focusPending) {
      rows.get(selected).container.scrollIntoView({ block: "nearest" });
      focusPending = false;
    }
    const summary = tasks.batchSummary;
    const preparingSelection = sourceID != null && !selected && bridge.readerWaits.has(sourceID);
    const active = records.filter(record => !tasks.terminal(record.state)).length;
    const saved = records.filter(record => record.saveState === "imported" && record.quality?.status === "complete").length;
    const attention = records.filter(record => ["failed", "interrupted"].includes(record.state)
      || record.saveState === "import_failed" || (record.state === "done" && (record.saveState !== "imported" || record.quality?.status !== "complete"))).length;
    document.getElementById("summary").textContent = [records.length ? `${records.length} 个任务` : "",
      active ? `${active} 进行中` : "", saved ? `${saved} 已保存` : "", attention ? `${attention} 待处理` : ""].filter(Boolean).join(" · ");
    const messages = [actionError, tasks.lastError, preparingSelection ? "正在准备论文…"
      : !records.length ? "暂无翻译任务。在论文上选择“翻译并分屏”即可开始。" : ""];
    const statusElement = document.getElementById("status");
    statusElement.textContent = [...new Set(messages.filter(Boolean))].join("\n");
    statusElement.hidden = !statusElement.textContent;
    statusElement.className = actionError || tasks.lastError ? "status error" : "status";
    document.getElementById("batch-details").hidden = !summary?.skipped?.length;
    if (summary?.skipped?.length) {
      document.getElementById("batch-label").textContent = `本批：新增 ${summary.queued} · 复用 ${summary.cached} · 跳过 ${summary.skipped.length}`;
      document.getElementById("batch-skipped").textContent = summary.skipped.join("\n");
    }
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
