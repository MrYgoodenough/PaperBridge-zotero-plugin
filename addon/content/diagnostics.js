/** Export safe addon diagnostics even when the Python bridge cannot start. */
/* global Zotero, Services, Cc, Ci, IOUtils, PathUtils */
// These fixed labels are the entire exported state/code vocabulary.
const DIAGNOSTIC_STATES = ["queued", "running", "cancelling", "done", "failed", "cancelled", "interrupted", "unknown"];
// Structural quality is not a semantic-accuracy claim.
const DIAGNOSTIC_QUALITY = ["complete", "partial", "unusable", "unknown"];
// No raw exception may be substituted for these safe public codes.
const DIAGNOSTIC_CODES = ["startup", "resource", "long_path", "file_busy", "provider", "provider_format", "general"];
// Native ZIP flags create only this action's uniquely named output file.
const DIAGNOSTIC_ZIP_FLAGS = 0x04 | 0x08 | 0x20;

var LocalDiagnostics = {
  /** Copy only fixed stage/code values and real ISO timestamps. */
  startup(events) {
    const stages = ["starting", "unpacking", "selecting_python", "launching", "waiting", "ready", "failed"];
    return (Array.isArray(events) ? events : []).slice(-32).filter(event =>
      event && stages.includes(event.stage) && typeof event.at === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)).map(event => ({
        at: event.at, stage: event.stage, code: DIAGNOSTIC_CODES.includes(event.code) ? event.code : null
      }));
  },

  /** Copy anonymous per-task transitions, not IDs, titles, paths or exception text. */
  jobEvents(records) {
    const phases = ["preparing", "parsing", "translating", "typesetting", "restoring", "finished"];
    return records.map((record, index) => ({ task: index + 1, events:
      (Array.isArray(record?.events) ? record.events : []).slice(-64).filter(event =>
        event && DIAGNOSTIC_STATES.includes(event.state) && typeof event.at === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(event.at)).map(event => ({
          at: event.at, state: event.state, phase: phases.includes(event.phase) ? event.phase : null,
          code: DIAGNOSTIC_CODES.includes(event.code) ? event.code : null,
          attempt: Number.isSafeInteger(event.attempt) && event.attempt > 0 ? event.attempt : null
        })) }));
  },

  /** Summarize already-loaded records without reading preferences, credentials or folders. */
  summary(runtime, records) {
    records = Array.isArray(records) ? records : [];
    const tasks = { total: records.length, states: Object.fromEntries(DIAGNOSTIC_STATES.map(state => [state, 0])),
      quality: Object.fromEntries(DIAGNOSTIC_QUALITY.map(state => [state, 0])) };
    for (const record of records) {
      tasks.states[DIAGNOSTIC_STATES.includes(record?.state) ? record.state : "unknown"]++;
      const quality = record?.quality?.status;
      tasks.quality[DIAGNOSTIC_QUALITY.includes(quality) ? quality : "unknown"]++;
    }
    const os = Services.appinfo.OS;
    const abi = Services.appinfo.XPCOMABI || "";
    const version = /^\d+(?:\.\d+){1,3}$/.test(runtime.version) ? runtime.version : "unknown";
    return { schema_version: 2, versions: { paperbridge: version, python: "unknown", babeldoc: "unknown", pymupdf: "unknown" },
      platform: { system: { Linux: "linux", WINNT: "windows", Darwin: "macos" }[os] || "other",
        architecture: abi.startsWith("x86_64") ? "x64" : abi.startsWith("aarch64") ? "arm64" : "other" },
      tasks, events: { startup: this.startup(runtime.diagnosticEvents), jobs: this.jobEvents(records) },
      runtime_status: { engine_ready: !!runtime.connection, export_source: "addon_only" },
      safety: { export_scope: "allowlist_only", warning_count: null, credentials_included: false,
        document_content_included: false, user_paths_included: false, raw_logs_included: false } };
  },

  /** Create a native ZIP from safe JSON; no Python, downloads or current drafts are needed. */
  async create(runtime, records) {
    const payload = this.summary(runtime, records);
    let destination = PathUtils.join(runtime.state, "diagnostics");
    try {
      await IOUtils.makeDirectory(destination, { ignoreExisting: true });
    } catch (_) {
      // A bad data path must not prevent diagnosis of that same startup failure.
      destination = PathUtils.join(PathUtils.tempDir, "PaperBridge-diagnostics");
      await IOUtils.makeDirectory(destination, { ignoreExisting: true });
    }
    const name = "PaperBridge-diagnostics-" + Date.now() + "-" + Zotero.DataObjectUtilities.generateKey();
    const jsonPath = PathUtils.join(destination, name + ".json");
    const zipPath = PathUtils.join(destination, name + ".zip");
    const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
    let opened = false;
    try {
      await IOUtils.writeUTF8(jsonPath, JSON.stringify(payload, null, 2));
      writer.open(runtime.file(zipPath), DIAGNOSTIC_ZIP_FLAGS);
      opened = true;
      writer.addEntryFile("diagnostics.json", Ci.nsIZipWriter.COMPRESSION_DEFAULT, runtime.file(jsonPath), false);
      writer.close();
      opened = false;
    } catch (error) {
      // A close/cleanup failure must not hide the original ZIP-write failure.
      try { if (opened) writer.close(); } catch (_) { /* Continue this action's cleanup. */ }
      try { await IOUtils.remove(zipPath, { ignoreAbsent: true }); } catch (_) { /* The original error remains actionable. */ }
      throw error;
    } finally {
      try { await IOUtils.remove(jsonPath, { ignoreAbsent: true }); } catch (_) { /* Safe temporary JSON may remain. */ }
    }
    return { path: zipPath, source: "addon_only" };
  }
};
