/** Test installed-XPI UI and real Zotero saves with explicitly simulated engine outcomes. */
/* global Zotero, Services, IOUtils, PathUtils, Ci, PAPERBRIDGE_TEST_ROOT */
(async () => {
  // All files and Zotero items belong to prepare_packaged_test.py's queue profile.
  const root = PAPERBRIDGE_TEST_ROOT;
  const report = { ok: false, providerCalls: 0, engineOutcomes: "simulated", checks: [] };
  let originalRequest;
  let bridge;

  /** Fail visibly on a missing capability rather than reporting a partial pass. */
  function check(condition, message) {
    if (!condition) throw new Error(message);
    report.checks.push(message);
  }

  /** Wait for asynchronous UI writes without holding addon startup. */
  async function until(predicate, message) {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await Zotero.Promise.delay(100);
    }
    throw new Error(message);
  }

  try {
    bridge = Zotero.PaperBridge;
    await bridge.ready;
    report.zoteroVersion = Zotero.version;
    report.platform = bridge.runtime.platform().id;
    const main = Zotero.getMainWindow();
    const settings = main.openDialog("chrome://paperbridge/content/settings.xhtml", "paperbridge-queue-settings",
      "chrome,centerscreen,resizable", { bridge });
    await until(() => settings.document.readyState === "complete" &&
      settings.document.getElementById("compatibleMaxTokens")?.value, "Settings did not initialize");
    const doc = settings.document;
    doc.getElementById("profile").value = "compatible";
    doc.getElementById("profile").dispatchEvent(new settings.Event("change"));
    doc.getElementById("compatibleBaseURL").value = "https://example.invalid/v1";
    doc.getElementById("compatibleModel").value = "offline-ui-test";
    doc.getElementById("compatibleKey").value = "queue-compatible-test-key";
    doc.getElementById("compatibleJSON").checked = false;
    doc.getElementById("save").click();
    await until(() => doc.getElementById("status").textContent.length > 0, "Compatible settings save did not finish");
    check(bridge.pref("profile") === "compatible", "Compatible settings save: " + doc.getElementById("status").textContent);
    check(bridge.getKey("compatible") === "queue-compatible-test-key" && !bridge.configuration().capabilities.json_mode,
      "Compatible UI saves its credential and capabilities");
    check(bridge.getKey("deepseek") !== bridge.getKey("compatible"), "Provider credentials stay isolated");
    settings.close();
    report.health = await bridge.request("/health");
    const actualJobs = await bridge.request("/jobs");
    check(Array.isArray(actualJobs) || Array.isArray(actualJobs.jobs), "Bundled backend exposes persistent job listing");

    const sourcePath = PathUtils.join(root, ".runtime", "queue-fixture.pdf");
    const statuses = new Map();
    let submitted = 0;
    originalRequest = bridge.request;
    // Only model-job outcomes are simulated. Settings, XPI, backend startup and imports are real.
    bridge.request = async function request(path, method, data) {
      if (path === "/jobs" && method === "POST") {
        submitted++;
        const identity = await originalRequest.call(bridge, "/cache/describe", "POST", data);
        const status = { id: (Date.now().toString(16) + submitted.toString(16)).padStart(32, "0"),
          ...identity, state: "queued", progress: 0, stage: "模拟排队",
          output_path: sourcePath, quality: { status: "partial" }, usage: { api_requests: 0 } };
        statuses.set(status.id, status);
        return status;
      }
      if (path === "/jobs") return [...statuses.values()];
      return originalRequest.call(bridge, path, method, data);
    };
    const parents = [];
    for (let i = 0; i < 2; i++) {
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", `PaperBridge isolated queue smoke ${i + 1}`);
      await parent.saveTx();
      await Zotero.Attachments.importFromFile({ file: sourcePath, parentItemID: parent.id });
      parents.push(parent);
    }
    await main.ZoteroPane.selectItems(parents.map(parent => parent.id));
    const summary = await bridge.tasks.batch();
    check(summary.queued === 2 && submitted === 2, "Multi-selection creates two independent owner records");
    check(bridge.splits.size === 0, "Batch enqueue does not open paired readers");
    for (const status of statuses.values()) Object.assign(status, {
      state: "running", progress: 45, phase: "translating", stage: "模拟翻译阶段",
      counts: { total: 2, success: 0, cache: 1, skipped: 0, failed: 0, unknown: 0, unresolved: 1, cache_hits: 1 },
      attempts: [{ state: "running", created_at: new Date().toISOString(), started_at: new Date().toISOString() }]
    });
    await bridge.tasks.refresh();
    await until(() => bridge.taskWindow?.document.querySelector("body")?.textContent.includes("缓存应用 1"), "Live progress counts did not render");
    check(bridge.taskWindow.document.querySelector("body").textContent.includes("45%") &&
      bridge.taskWindow.document.querySelector("body").textContent.includes("本次用时"), "Task window shows live percentage, real counts and elapsed time");
    bridge.taskWindow.close();
    bridge.showTasks();
    await until(() => bridge.taskWindow?.document.querySelector("body")?.textContent.includes("缓存应用 1"), "Progress did not reopen");
    check(submitted === 2, "Closing and reopening progress never resubmits translation");
    for (const status of statuses.values()) {
      Object.assign(status, { state: "done", progress: 100, phase: "finished", stage: "模拟部分产出" });
      Object.assign(status.attempts[0], { state: "done", finished_at: new Date().toISOString() });
    }
    await bridge.tasks.refresh();
    const records = bridge.library.records.filter(record => parents.some(parent => parent.key === record.ownerKey));
    check(records.length === 2 && records.every(record => record.saveState === "imported"), "Both PDFs are imported into real Zotero items");
    check(records.every(record => record.quality.status === "partial"), "Partial quality is not relabelled complete");
    const translated = await Promise.all(records.map(record => bridge.library.item(record.libraryID, record.attachmentKey)));
    check(translated.every(item => item.getField("title").includes("部分可用")), "Partial PDFs are labelled on real Zotero attachments");
    await bridge.tasks.refresh();
    check(parents.every(parent => parent.getAttachments().length === 2), "Repeated polling never duplicates imports");
    await until(() => bridge.taskWindow?.document.querySelectorAll(".task").length >= 2, "Task dialog rows did not render");
    check(bridge.taskWindow.document.querySelector("body").textContent.includes("部分可用"), "Task dialog displays quality and save dimensions");
    check(bridge.splits.size === 0, "Batch completion does not open paired readers");
    parents[0].deleted = true;
    await parents[0].saveTx();
    await bridge.library.schedule();
    check(!!await bridge.library.item(records[0].libraryID, records[0].attachmentKey), "Trashing a paper never permanently erases its translated attachment");
    check(bridge.library.records.includes(records[0]), "Trashed-paper outcome remains indexed");
    report.ok = true;
  } catch (error) {
    report.error = String(error);
    report.stack = error.stack;
    Zotero.logError(error);
  } finally {
    if (originalRequest) bridge.request = originalRequest;
    try {
      await IOUtils.writeUTF8(PathUtils.join(root, ".runtime", "queue-test.json"), JSON.stringify(report, null, 2));
    } finally {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }
})();
