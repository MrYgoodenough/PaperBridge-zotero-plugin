/** Coordinate serial engine jobs, per-library saves and explicit recovery. */
/* global Zotero, Services, IOUtils */
var TranslationTasks = class {
  /** Keep UI coordination separate from the backend's serial worker. */
  constructor(bridge) {
    this.bridge = bridge;
    this.statuses = new Map();
    this.saving = new Map();
    this.submitting = new Set();
    this.lastError = "";
    this.monitoring = false;
    this.refreshing = null;
  }

  /** Recognize terminal execution independently of attachment save state. */
  terminal(state) {
    return ["done", "failed", "cancelled", "interrupted"].includes(state);
  }

  /** Copy non-secret settings before selection or network calls can yield. */
  config() {
    return JSON.parse(JSON.stringify(this.bridge.configuration()));
  }

  /** Find preparation or active ownership even before a backend ID is assigned. */
  active(source) {
    return this.submitting.has(`${source.libraryID}:${source.key}`) || this.bridge.jobs.has(source.id) ||
      this.bridge.library.records.some(record => record.sourceID === source.id && !record.detached &&
        ["queued", "running", "cancelling"].includes(record.state));
  }

  /** Keep incomplete outcomes on the explicit retry path, not silent cache reuse. */
  async reviewable(source, config) {
    const library = this.bridge.library;
    for (const record of [...library.records].reverse()) {
      if (record.libraryID !== source.libraryID || record.sourceKey !== source.key ||
          library.configKey(record.config) !== library.configKey(config) || !await library.sourceUnchanged(record)) continue;
      // Only the latest matching outcome decides; older failures remain in history.
      return this.terminal(record.state) && (record.quality?.status !== "complete" || record.saveState !== "imported") ? record : null;
    }
    return null;
  }

  /** Reconnect to persisted work without resending translation requests. */
  async resume() {
    for (const record of this.bridge.library.records) {
      if (!record.jobID && !record.fingerprint && !this.terminal(record.state)) {
        try { await this.bridge.library.update(record, { state: "interrupted", lastError: "准备阶段已中断，未提交翻译。可显式重试。" }); }
        catch (error) { Zotero.logError(error); }
      }
      if (record.jobID && !this.terminal(record.state)) this.bridge.jobs.set(record.sourceID, record.jobID);
    }
    if (this.bridge.library.records.some(record => record.retryPendingSince || record.fingerprint && record.saveState !== "imported")) this.monitor();
  }

  /** Enqueue one stable attachment and retain its own Zotero ownership. */
  async enqueue(source, config = this.config(), key = this.bridge.getKey(config.profile)) {
    const identity = `${source.libraryID}:${source.key}`;
    if (this.active(source)) throw new Error("这篇论文已在任务列表中执行。");
    this.submitting.add(identity);
    try {
      const existing = await this.bridge.library.matching(source, config);
      if (existing) return { attachment: existing };
      if (!key) throw new Error("请先在设置中保存所选配置的 API Key。");
      if (!await source.fileExists()) throw new Error("请先下载此 PDF 附件。");
      const path = await source.getFilePathAsync();
      const stat = await IOUtils.stat(path);
      // Persist the same owner row before describe() can wait for backend startup.
      const record = await this.bridge.library.put(source, null, config, { state: "queued" }, stat);
      let status;
      let submitted = false;
      try {
        if (record.detached || !this.bridge.alive) return { record };
        await this.bridge.library.update(record, { state: "queued", lastError: "" });
        if (record.detached || !this.bridge.alive) return { record };
        const described = await this.bridge.library.describe(source, null, config);
        if (record.detached || !this.bridge.alive) return { record };
        await this.bridge.library.update(record, described);
        if (record.detached || !this.bridge.alive) return { record };
        submitted = true;
        status = await this.bridge.request("/jobs", "POST", {
          source_path: path, api_key: key, model: config.model, base_url: config.baseURL,
          lang_out: config.language, pages: config.pages, profile: config.profile, capabilities: config.capabilities
        });
        await this.bridge.library.update(record, { ...status, submissionState: "accepted" });
      } catch (error) {
        if (record.detached) return { record };
        try {
          // A bridge rejection is different from a request whose response was lost.
          const rejected = !status && (!submitted || (error.status >= 400 && error.status < 500 && error.status !== 408));
          await this.bridge.library.update(record, { state: status?.state || "interrupted",
            submissionState: status ? "accepted" : rejected ? "rejected" : "unknown",
            errorCode: error.code, errorHint: error.hint,
            lastError: (rejected ? "未提交或后端已拒绝，未自动重发。修正问题后可显式重试："
              : "提交或归属保存未确认，未自动重发。刷新任务列表会尝试找回已有任务：") + error.message });
        } finally {
          if (status) {
            this.statuses.set(status.id, status);
            this.bridge.jobs.set(source.id, status.id);
          }
          this.monitor();
        }
        throw error;
      }
      this.statuses.set(status.id, status);
      this.bridge.jobs.set(source.id, status.id);
      this.monitor();
      return { record, status };
    } finally {
      this.submitting.delete(identity);
    }
  }

  /** Snapshot the selection once; one missing attachment cannot stop a batch. */
  async batch() {
    const items = [...Zotero.getMainWindow().ZoteroPane.getSelectedItems()];
    if (!items.length) throw new Error("请在文献库多选论文或 PDF 附件。");
    const config = this.config();
    // Keep the in-memory credential paired with the batch's frozen endpoint.
    const key = this.bridge.getKey(config.profile);
    const sources = new Set();
    const summary = { queued: 0, cached: 0, skipped: [] };
    this.bridge.showTasks();
    for (const item of items) {
      if (!this.bridge.alive) break;
      try {
        const source = await this.bridge.sourceForItem(item);
        if (!source) throw new Error("没有可翻译的原文 PDF");
        if (sources.has(source.id)) continue;
        sources.add(source.id);
        // Batch selection is not consent to resend incomplete or unconfirmed work.
        const previous = await this.reviewable(source, config);
        if (previous) {
          this.bridge.showTasks(source.id, previous.recordID);
          throw new Error("已有未完成或未确认的结果，请在任务列表中检查，并显式重试或重新保存。");
        }
        const result = await this.enqueue(source, config, key);
        summary[result.attachment ? "cached" : "queued"]++;
      } catch (error) {
        summary.skipped.push(`${item.getField("title") || item.key}：${error.message}`);
      }
    }
    this.batchSummary = summary;
    return summary;
  }

  /** Share one polling loop between progress windows and the task list. */
  monitor() {
    if (this.monitoring) return;
    this.monitoring = true;
    this.loop = (async () => {
      try {
        while (this.bridge.alive) {
          try { await this.refresh(); }
          catch (error) { this.lastError = error.message; Zotero.logError(error); }
          const pending = this.bridge.library.records.some(record => record.retryPendingSince || record.jobID && !record.detached &&
            (!this.terminal(record.state) || (record.state === "done" && record.saveState === "produced")));
          if (!pending) break;
          // A modest interval avoids busy polling while the engine processes a page.
          await Zotero.Promise.delay(1500);
        }
      } finally { this.monitoring = false; }
    })();
  }

  /** Read status once and persist only changed, credential-free fields. */
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce();
    try { return await this.refreshing; }
    finally { this.refreshing = null; }
  }

  /** Reconcile backend execution with each owner's independent save outcome. */
  async refreshOnce() {
    const response = await this.bridge.request("/jobs");
    const jobs = Array.isArray(response) ? response : response.jobs;
    if (!Array.isArray(jobs)) throw new Error("任务列表响应无效，请重启 PaperBridge 引擎。");
    this.statuses = new Map(jobs.map(job => [job.id, job]));
    this.lastError = "";
    // A retry may have been accepted just before its HTTP response or index write was lost.
    for (const record of [...this.bridge.library.records]) {
      if (!record.retryPendingSince) continue;
      const retry = [...jobs].reverse().find(job => job.previous_job_id === record.jobID &&
        Date.parse(job.created_at) >= Date.parse(record.retryPendingSince));
      if (retry) {
        const attempt = await this.bridge.library.forkAttempt(record, retry);
        await this.bridge.library.update(record, { retryPendingSince: null });
        if (!this.terminal(attempt.state)) this.bridge.jobs.set(attempt.sourceID, retry.id);
      }
    }
    for (const record of [...this.bridge.library.records]) {
      if (!this.bridge.alive || record.detached || this.submitting.has(`${record.libraryID}:${record.sourceKey}`)) continue;
      if (!record.jobID && record.fingerprint && record.saveState !== "imported") {
        const recovered = [...jobs].reverse().find(job => job.fingerprint === record.fingerprint && job.document_key === record.documentKey);
        if (recovered) await this.bridge.library.update(record, { jobID: recovered.id, submissionState: "accepted", lastError: "" });
        else if (record.submissionState !== "rejected") await this.bridge.library.update(record, {
          state: "interrupted", submissionState: "not_found",
          lastError: "本次刷新未找到匹配任务；没有自动重发。可确认重复计费风险后显式重新提交。"
        });
      }
      if (!record.jobID) continue;
      const status = this.statuses.get(record.jobID);
      if (!status) {
        if (!this.terminal(record.state)) await this.bridge.library.update(record, {
          state: "interrupted", lastError: "后端任务记录不可用；没有自动重新发送。请检查数据目录。"
        });
        this.release(record);
        continue;
      }
      const latest = status.attempts?.at(-1);
      const quality = status.state === "done" ? status.quality : latest?.quality || status.quality;
      const patch = { state: status.state, quality: quality || { status: "unknown" },
        outputPath: status.output_path || record.outputPath || null, outputAvailable: status.output_available };
      if (status.error) patch.lastError = status.error;
      patch.errorCode = status.error_code;
      patch.errorHint = status.error_hint;
      if (status.state === "done" && !record.saveState) patch.saveState = "produced";
      if (Object.entries(patch).some(([key, value]) => JSON.stringify(record[key]) !== JSON.stringify(value))) {
        await this.bridge.library.update(record, patch);
      }
      if (status.state === "done" && record.saveState === "produced") {
        try { await this.save(record, status); }
        catch (error) { Zotero.logError(error); }
      }
      if (this.terminal(record.state)) this.release(record);
    }
    return jobs;
  }

  /** Release only the task that still owns the source's active UI entry. */
  release(record) {
    if (this.bridge.jobs.get(record.sourceID) === record.jobID) this.bridge.jobs.delete(record.sourceID);
  }

  /** Serialize import retries so one owner never imports twice concurrently. */
  async save(record, status = this.statuses.get(record.jobID)) {
    if (this.saving.has(record)) return this.saving.get(record);
    const operation = this.saveOnce(record, status);
    this.saving.set(record, operation);
    try { return await operation; }
    finally { this.saving.delete(record); }
  }

  /** Save artifacts separately from execution, retaining failed imports for retry. */
  async saveOnce(record, status) {
    try {
      // Losing backend access must not erase an already known unusable verdict.
      const knownUnusable = (status?.quality?.status || record.quality?.status) === "unusable";
      if (status?.state === "interrupted" && record.jobID) {
        try {
          status = await this.bridge.request(`/jobs/${record.jobID}/recover`, "POST", {});
          this.statuses.set(status.id, status);
          await this.bridge.library.update(record, status);
        } catch (error) {
          // Missing/corrupt backend records must not block explicit local PDF recovery.
          await this.bridge.library.update(record, { lastError: "后端核对失败；保留文件可作为未确认译文恢复：" + error.message,
            errorCode: error.code, errorHint: error.hint });
          status = null;
        }
      }
      if (knownUnusable || (status?.quality?.status || record.quality?.status) === "unusable") {
        throw new Error("本次结果已确认不可用；可打开保留文件位置核查，或显式重试翻译。");
      }
      if (!status || status.state !== "done" || !status.output_path) {
        const path = await this.retainedOutput(record);
        if (!Services.prompt.confirm(Zotero.getMainWindow(), "恢复保留的译文", "后端未确认本次结果。将把保留 PDF 保存为未确认译文，不调用模型，也不覆盖旧附件。是否继续？")) return null;
        status = { state: "done", output_path: path, quality: { status: "unknown" } };
      }
      if (!status || status.state !== "done" || !status.output_path) throw new Error("尚无可保存的译文 PDF。");
      let attachment = await this.bridge.library.findAttachment(record);
      if (attachment && record.saveState === "imported") return attachment;
      if (!attachment) {
        if (!await this.bridge.library.ownerAlive(record)) throw new Error("原论文已删除或在回收站；结果已保留，恢复条目后可重试保存。");
        attachment = await Zotero.Attachments.importFromFile({
          file: status.output_path, libraryID: record.libraryID,
          parentItemID: record.parentKey ? record.ownerID : undefined
        });
        // Persist the imported key before metadata writes, so a retry can finish it.
        record.importingAttachmentKey = attachment.key;
        await this.bridge.library.update(record, { importingAttachmentKey: attachment.key });
      }
      const quality = status.quality?.status || "unknown";
      const warning = quality === "complete" ? "" : quality === "partial" ? " · 部分可用" : " · 质量未确认";
      attachment.setField("title", `译文${warning} · ${record.language} · ${record.title}`);
      if (record.sourceURI) attachment.addRelation("dc:relation", record.sourceURI);
      attachment.addRelation("dc:relation", "urn:paperbridge:job:" + record.jobID);
      await attachment.saveTx();
      await this.bridge.library.attach(record, attachment);
      await this.bridge.library.update(record, { saveState: "imported", lastError: "", quality: status.quality || { status: "unknown" } });
      const usage = status.cached ? { api_requests: 0, full_pdf_cache: true } : status.usage;
      if (usage) this.bridge.setPref("lastUsage", JSON.stringify({ ...usage, model: record.model, date: new Date().toISOString() }));
      return attachment;
    } catch (error) {
      await this.bridge.library.update(record, { saveState: "import_failed", lastError: error.message });
      throw error;
    }
  }

  /** Check a retained PDF only for an explicit local recovery or reveal action. */
  async retainedOutput(record) {
    if (!record.outputPath || !await IOUtils.exists(record.outputPath)) throw new Error("保留的译文 PDF 不存在，请检查数据目录或备份；不会自动重新翻译。");
    const bytes = await IOUtils.read(record.outputPath, { maxBytes: 5 });
    if (String.fromCharCode(...bytes) !== "%PDF-") throw new Error("保留文件不是可识别的 PDF；请检查备份，不会自动重新翻译。");
    return record.outputPath;
  }

  /** Reveal an existing local result even when its Zotero owner is unavailable. */
  async revealOutput(record) {
    await Zotero.File.reveal(await this.retainedOutput(record));
  }

  /** Cancel only this owner; shared backend work continues for other owners. */
  async cancel(record) {
    if (this.terminal(record.state)) return;
    if (!record.jobID && record.fingerprint) throw new Error("正在确认提交结果，请稍后取消；响应丢失时请先刷新找回任务。");
    const shared = this.bridge.library.records.some(other => other !== record && other.jobID === record.jobID &&
      !other.detached && !this.terminal(other.state));
    if (record.jobID && !shared) await this.bridge.request(`/jobs/${record.jobID}/cancel`, "POST", {});
    try { await this.bridge.library.update(record, { state: "cancelled", detached: true }); }
    finally { this.release(record); }
  }

  /** Retry only after consent, using the original endpoint and a current credential. */
  async retry(record) {
    if (!this.terminal(record.state)) throw new Error("任务仍在运行，请先取消或等待完成。");
    if (!record.jobID && record.fingerprint && record.saveState !== "imported" && record.submissionState !== "rejected") {
      // Reconcile first; never turn a lost response into an automatic second request.
      await this.refresh();
      if (record.jobID) throw new Error("已找回已有任务，请先检查其状态或保存成果，再决定是否重译。");
    }
    const profile = record.profile || "deepseek";
    const current = this.bridge.configuration(profile);
    if (current.baseURL.replace(/\/$/, "") !== record.baseURL.replace(/\/$/, "")) {
      throw new Error("该任务的 API 地址与当前配置不同。请先恢复原配置，避免将新凭据发送至旧地址。");
    }
    const key = this.bridge.getKey(profile);
    if (!key) throw new Error("请先保存该任务配置的 API Key。");
    const sourceWarning = record.jobID ? "将使用任务原有模型和源文件快照。" : record.saveState === "imported"
      ? "旧译文没有可重试的任务 ID，将保留旧附件，并用原配置和当前原文创建新任务。"
      : record.fingerprint && record.submissionState !== "rejected"
        ? "本次刷新未找到任务，但旧请求可能已执行；将使用原配置和当前原文显式新建任务。"
        : "准备阶段未提交或后端已拒绝，将使用任务原有配置和当前原文附件。";
    if (!Services.prompt.confirm(Zotero.getMainWindow(), "重试翻译", sourceWarning + "未收到响应的请求也可能已收费；重试可能重复计费。是否继续？")) return;
    if (!record.jobID) {
      // Imported legacy results predate durable job IDs; they are not lost submissions.
      const source = await this.bridge.library.item(record.libraryID, record.sourceKey);
      if (!source || source.deleted) throw new Error("原文附件不可用，请恢复条目后重试。");
      await this.bridge.library.update(record, { detached: true });
      return this.enqueue(source, record.config || record, key);
    }
    if (this.saving.has(record)) throw new Error("该结果正在保存，请等待保存结束后再重试。");
    // Keep the old outcome readable, but do not automatically import a superseded result.
    await this.bridge.library.update(record, { retryPendingSince: new Date().toISOString(),
      detached: record.saveState !== "imported" });
    let status;
    try { status = await this.bridge.request(`/jobs/${record.jobID}/retry`, "POST", { api_key: key }); }
    catch (error) {
      if (error.status) await this.bridge.library.update(record, { retryPendingSince: null });
      this.monitor();
      throw error;
    }
    // Fork ownership as well as execution, so retries cannot replace saved outcomes.
    this.statuses.set(status.id, status);
    this.bridge.jobs.set(record.sourceID, status.id);
    try {
      await this.bridge.library.forkAttempt(record, status);
      await this.bridge.library.update(record, { retryPendingSince: null });
    }
    finally {
      // forkAttempt retains the new record in memory even if its atomic write fails.
      this.monitor();
    }
  }

  /** Wait for a single-item UI without coupling batch completion to reader opening. */
  async wait(record) {
    while (this.bridge.alive) {
      if (record.state === "cancelled") return null;
      // A temporary read failure must not discard the sole reader continuation.
      try { await this.refresh(); }
      catch (error) { this.lastError = error.message; }
      const status = this.statuses.get(record.jobID);
      if (this.terminal(record.state)) {
        if (record.state === "done" && record.saveState === "imported") return this.bridge.library.findAttachment(record);
        if (record.state === "cancelled") return null;
        throw new Error(record.lastError || status?.error || "任务中断，请在任务列表中查看或重试。");
      }
      await Zotero.Promise.delay(1500);
    }
    return null;
  }
};
