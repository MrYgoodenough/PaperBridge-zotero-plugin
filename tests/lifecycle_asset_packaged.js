/** Reusable isolated lifecycle checks; load with Services.scriptloader, then call run().
 * check(condition, name, details = {}) is synchronous; run() returns state for reopen().
 * Optional mappingFile uses the real asset publisher; otherwise sidecars are retention-only fixtures. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci */
// Loading this export never starts a runner, registers an observer, or quits Zotero.
var LifecycleAssetChecks = {
  /** Compare native paths without admitting a sibling directory or Windows case mismatch. */
  inside(root, path) {
    if (!root || !path) return false;
    /** Normalize separators and case using the running Zotero platform. */
    const normalize = value => {
      let ancestor = value, suffix = [];
      let resolved;
      for (;;) {
        try { resolved = PathUtils.normalize(ancestor); break; }
        catch (error) {
          // Removed fixture paths have no inode; resolve their surviving parent, not another directory.
          if (!error.message.includes("NS_ERROR_FILE_NOT_FOUND")) throw error;
          const parent = PathUtils.parent(ancestor), name = PathUtils.filename(ancestor);
          if (parent === ancestor || [".", ".."].includes(name)) throw error;
          suffix.unshift(name); ancestor = parent;
        }
      }
      const result = PathUtils.join(resolved, ...suffix).replace(/\\/g, "/").replace(/\/+$/, "");
      return Zotero.isWin ? result.toLowerCase() : result;
    };
    const base = normalize(root), target = normalize(path);
    return !!base && (target === base || target.startsWith(base + "/"));
  },

  /** Accept a suite root or the caller's explicit isolated profile/data pair; create no profile. */
  scope(bridge, root, check, isolation = null) {
    if (typeof check !== "function") throw new TypeError("Lifecycle checks require check(condition, name, details = {})");
    /** Report failures even when the caller's check callback does not throw. */
    function verify(name, condition, detail = {}) {
      check(!!condition, name, detail);
      if (!condition) throw new Error(name);
    }
    const profileDirectory = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    const dataDirectory = Zotero.DataDirectory.dir;
    const explicit = isolation?.isolated === true &&
      this.inside(profileDirectory, isolation.expectedProfileDirectory) &&
      this.inside(isolation.expectedProfileDirectory, profileDirectory) &&
      this.inside(dataDirectory, isolation.expectedDataDirectory) &&
      this.inside(isolation.expectedDataDirectory, dataDirectory);
    const enclosing = this.inside(root, profileDirectory) && this.inside(root, dataDirectory);
    const paths = [bridge?.runtime?.base, bridge?.runtime?.state, bridge?.runtime?.cache];
    verify("[native prerequisite] Explicit isolated profile/data and backend paths are verified",
      (explicit || enclosing) && this.inside(root, root) && paths.every(path => this.inside(dataDirectory, path)),
      { root, profileDirectory, dataDirectory });
    return { verify, profileDirectory, dataDirectory };
  },

  /** Hash actual bytes with Gecko rather than trusting filenames or fixture metadata. */
  async hash(path) {
    const bytes = await IOUtils.read(path);
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  },

  /** Read native identities and result bytes back; trash is not permanent removal. */
  async retained(library, saved, verify, stage) {
    const pdf = await library.item(saved.libraryID, saved.translatedKey);
    const record = library.records.find(value => value.recordID === saved.recordID);
    verify(`[native/frontend] ${stage}: translated PDF and durable record survive`,
      pdf?.isPDFAttachment() && await pdf.fileExists() && record?.attachmentKey === pdf.key &&
      record.sourceKey === saved.sourceKey && record.outputPath === saved.outputPath && record.alignmentPath === saved.alignmentPath &&
      await this.hash(await pdf.getFilePathAsync()) === saved.translatedHash &&
      pdf.getRelationsByPredicate("dc:relation").includes("urn:paperbridge:record:" + saved.recordID));
    if (saved.noteKey) {
      const note = await library.item(saved.libraryID, saved.noteKey);
      if (note) await note.loadAllData();
      verify(`[native] ${stage}: independent note survives`, note?.isNote() && note.getNote() === saved.noteHTML);
      const annotation = await library.item(saved.libraryID, saved.annotationKey);
      if (annotation) await annotation.loadAllData();
      await pdf.loadDataType("childItems");
      verify(`[native] ${stage}: annotation remains on the same translated PDF`,
        annotation?.isAnnotation() && annotation.parentID === pdf.id && annotation.annotationType === "note" &&
        annotation.annotationComment === saved.annotationComment &&
        pdf.getAnnotations().some(value => value.key === saved.annotationKey));
    }
    if (saved.mappingKey) {
      const mapping = await library.item(saved.libraryID, saved.mappingKey);
      verify(`[native publisher] ${stage}: synced mapping attachment survives`,
        mapping?.isAttachment() && await mapping.fileExists() && record.mappingAttachmentKey === mapping.key &&
        await this.hash(await mapping.getFilePathAsync()) === saved.mappingHash);
    }
    for (const asset of saved.cacheAssets) {
      verify(`[actual filesystem] ${stage}: ${asset.kind} bytes survive`,
        await IOUtils.exists(asset.path) && await this.hash(asset.path) === asset.sha256,
        { path: asset.path, fixtureKind: asset.kind });
    }
  },

  /** Exercise real native deletion plus actual local prune, never model submission or global stubs. */
  async run({ bridge, root, check, sourceFile, translatedFile, mappingFile = null, isolation = null }) {
    const { verify, profileDirectory, dataDirectory } = this.scope(bridge, root, check, isolation);
    await bridge.ready;
    verify("[native prerequisite] Supplied PDFs exist and TranslationLibrary is loaded",
      await IOUtils.exists(sourceFile) && await IOUtils.exists(translatedFile) && !!bridge.library?.constructor);
    if (mappingFile) verify("[native prerequisite] Explicit mapping has the real publisher available",
      await IOUtils.exists(mappingFile) && !!bridge.alignmentAssets?.constructor);
    // Unique public settings prevent these cache references from matching another suite's jobs.
    const runKey = Zotero.DataObjectUtilities.generateKey();
    const libraryBase = PathUtils.join(root, "la-" + runKey);
    await IOUtils.makeDirectory(libraryBase);
    // Restrict destructive cache requests to this invocation's actual described fingerprints.
    const known = new Set(), pruneCalls = [];
    const helper = this;
    const local = {
      runtime: { base: libraryBase, state: bridge.runtime.state, cache: bridge.runtime.cache },
      /** Allow only local cache APIs, and only identities described for this invocation. */
      async request(path, method, body) {
        if (method !== "POST" || !["/cache/describe", "/cache/prune"].includes(path)) {
          throw new Error("Lifecycle isolation forbids " + method + " " + path);
        }
        if (path === "/cache/prune" && (body.sweep !== false ||
          [...body.remove, ...body.keep].some(ref => !known.has(ref.fingerprint)))) {
          throw new Error("Lifecycle prune must target only explicitly seeded local identities without sweep");
        }
        const result = await bridge.request(path, method, body);
        if (path === "/cache/describe") known.add(result.fingerprint);
        else pruneCalls.push({ mode: "actual installed backend", request: body, result });
        return result;
      }
    };
    const library = new bridge.library.constructor(local);
    local.library = library;
    if (mappingFile) local.alignmentAssets = new bridge.alignmentAssets.constructor(local);
    // A fresh independent index must not migrate another suite's legacy preferences.
    await library.save();

    /** Freeze nonsecret, offline-only configuration independently for each fixture family. */
    function config(name) {
      return { profile: "compatible", baseURL: "https://example.invalid/v1", model: "lifecycle-" + runKey + "-" + name,
        language: "zh-CN", pages: "", capabilities: { json_mode: false, thinking_disabled: false } };
    }

    /** Describe the supplied source bytes even after this helper erases its imported source. */
    async function identity(name) {
      const settings = config(name);
      return local.request("/cache/describe", "POST", { source_path: sourceFile, profile: settings.profile,
        base_url: settings.baseURL, model: settings.model, lang_out: settings.language,
        pages: settings.pages, capabilities: settings.capabilities });
    }

    /** Build actual backend cache layouts with synthetic ownership, never a persisted model job. */
    async function cache(identity, { output = false, evidence = false, unknown = false } = {}) {
      const jobs = PathUtils.join(local.runtime.state, "jobs");
      const legacy = PathUtils.join(jobs, identity.fingerprint);
      const attempt = PathUtils.join(jobs, "attempts", identity.fingerprint.slice(0, 32) + "-1");
      const paths = unknown ? [attempt] : [legacy, attempt];
      for (const path of paths) {
        if (await IOUtils.exists(path)) throw new Error("Refusing to overwrite existing cache fixture: " + path);
        await IOUtils.makeDirectory(path, { createAncestors: true });
        await IOUtils.copy(sourceFile, PathUtils.join(path, "source.pdf"));
      }
      const identityPath = PathUtils.join(attempt, "identity.json");
      await IOUtils.writeUTF8(identityPath, unknown ? "{" : JSON.stringify(identity));
      const outputPath = PathUtils.join(attempt, "translated.pdf");
      const alignmentPath = PathUtils.join(attempt, "alignment.json");
      const assets = [];
      if (unknown) assets.push({ path: PathUtils.join(attempt, "source.pdf"), kind: "unknown-attempt supplied input",
        sha256: await helper.hash(PathUtils.join(attempt, "source.pdf")) });
      if (output) {
        await IOUtils.copy(translatedFile, outputPath);
        assets.push({ path: outputPath, kind: "supplied PDF cache fixture", sha256: await helper.hash(outputPath) });
      }
      if (output || evidence) {
        if (mappingFile) await IOUtils.copy(mappingFile, alignmentPath);
        else await IOUtils.writeUTF8(alignmentPath, JSON.stringify({ fixture: "retention-only alignment sentinel", runKey }));
        assets.push({ path: alignmentPath, kind: mappingFile ? "supplied alignment sidecar" : "synthetic alignment sentinel",
          sha256: await helper.hash(alignmentPath) });
      }
      assets.push({ path: identityPath, kind: unknown ? "unreadable attempt identity" : "synthetic immutable identity",
        sha256: await helper.hash(identityPath) });
      return { identity, legacy, attempt, outputPath, alignmentPath, assets };
    }

    /** Import real PDF items and persist an independent per-source result record. */
    async function outcome(name, jobID = null) {
      const parent = new Zotero.Item("journalArticle");
      parent.setField("title", "PaperBridge lifecycle assets " + runKey + " · " + name);
      await parent.saveTx();
      const source = await Zotero.Attachments.importFromFile({ file: sourceFile, parentItemID: parent.id });
      const translated = await Zotero.Attachments.importFromFile({ file: translatedFile, parentItemID: parent.id });
      const settings = config(name);
      const identity = await library.describe(source, translated, settings);
      const record = await library.put(source, translated, settings,
        { ...identity, id: jobID, state: "done", quality: { status: "unknown" } },
        await IOUtils.stat(await source.getFilePathAsync()));
      return { parent, source, translated, record, identity };
    }

    /** Bind cached paths, optionally publishing the caller's real map as a native attachment. */
    async function bind(fixture, cached) {
      fixture.cached = cached;
      await library.update(fixture.record, { outputPath: cached.outputPath, alignmentPath: cached.alignmentPath });
      if (mappingFile) {
        fixture.mapping = await library.publishMapping(fixture.record, fixture.translated);
        verify("[native publisher] Explicit mapping was actually published", !!fixture.mapping &&
          fixture.record.mappingAttachmentKey === fixture.mapping.key);
      }
    }

    /** Snapshot stable keys and bytes for the caller's genuine cold-reopen phase. */
    async function snapshot(fixture) {
      return { libraryID: fixture.source.libraryID, recordID: fixture.record.recordID,
        sourceKey: fixture.record.sourceKey, outputPath: fixture.record.outputPath, alignmentPath: fixture.record.alignmentPath,
        translatedKey: fixture.translated.key, translatedHash: await helper.hash(await fixture.translated.getFilePathAsync()),
        noteKey: fixture.note?.key || null, noteHTML: fixture.note?.getNote() || null,
        annotationKey: fixture.annotationKey || null, annotationComment: fixture.annotationComment || null,
        mappingKey: fixture.mapping?.key || null,
        mappingHash: fixture.mapping ? await helper.hash(await fixture.mapping.getFilePathAsync()) : null,
        cacheAssets: fixture.cached.assets };
    }

    /** Explicitly reconcile after native transactions without replacing the addon's notifier. */
    async function settle() {
      await library.schedule();
      await library.settled();
      verify("[frontend] Independent reconciliation completes without an error", !library.lastError, library.lastError);
    }

    /** Restore only objects created by this invocation through native Item saving. */
    async function restore(fixture) {
      for (const item of [fixture.parent, fixture.source, fixture.translated, fixture.note, fixture.mapping]) {
        if (item?.deleted) { item.deleted = false; await item.saveTx(); }
      }
    }

    const primary = await outcome("primary");
    await bind(primary, await cache(primary.identity, { output: true }));
    primary.note = new Zotero.Item("note");
    primary.note.parentID = primary.parent.id;
    primary.note.setNote("<p>Independent lifecycle note " + runKey + "</p>");
    await primary.note.saveTx();
    await primary.note.reload(["note"], true);
    primary.annotationKey = Zotero.DataObjectUtilities.generateKey();
    primary.annotationComment = "Native lifecycle annotation " + runKey;
    // This first-page sticky-note rectangle is a persistence fixture, not a precise/input test.
    const noteRectangle = [48, 200, 70, 222];
    // Official annotation persistence is real; this does not claim trusted reader-input coverage.
    await Zotero.Annotations.saveFromJSON(primary.translated, { key: primary.annotationKey, type: "note", color: "#ffd400",
      comment: primary.annotationComment, pageLabel: "1", sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [noteRectangle] } });
    const primarySaved = await snapshot(primary);
    // Capture read-only native identities before erase disables Item data access.
    const erasedSource = { libraryID: primary.source.libraryID, key: primary.source.key };
    const erasedOwner = { libraryID: primary.parent.libraryID, key: primary.parent.key };
    await Zotero.Items.trashTx([primary.source.id]);
    await settle();
    verify("[native] Source entered Zotero trash", primary.source.deleted);
    await this.retained(library, primarySaved, verify, "Source trash");
    await restore(primary);
    await Zotero.Items.trashTx([primary.parent.id]);
    await settle();
    verify("[native] Owner entered Zotero trash", primary.parent.deleted);
    await this.retained(library, primarySaved, verify, "Owner trash");
    await restore(primary);
    await settle();
    verify("[native/frontend] Restored source and owner resolve the original translated attachment",
      !primary.source.deleted && !primary.parent.deleted && !primary.translated.deleted &&
      (await library.savedFor(primary.parent))?.attachment.id === primary.translated.id);
    await primary.source.eraseTx();
    await settle();
    verify("[native/frontend] Permanent source erasure keeps the existing result readable",
      !await library.item(erasedSource.libraryID, erasedSource.key) &&
      (await library.savedFor(primary.parent))?.attachment.id === primary.translated.id);
    await this.retained(library, primarySaved, verify, "Permanent source removal");
    // Zotero itself cascades owner erasure; explicitly move retained outcomes before testing owner loss.
    for (const item of [primary.translated, primary.note, primary.mapping]) {
      if (item) { item.parentID = false; await item.saveTx(); }
    }
    await primary.parent.eraseTx();
    await settle();
    verify("[native] Retained translated PDF and independent note are standalone after owner removal",
      !primary.translated.parentID && !primary.note.parentID && !primary.translated.deleted && !primary.note.deleted);

    const sharedA = await outcome("shared");
    await bind(sharedA, await cache(sharedA.identity, { output: true }));
    // A shared ID tests frontend ownership only; no backend job is submitted or fabricated on disk.
    const sharedJobID = sharedA.identity.fingerprint.slice(0, 32);
    await library.update(sharedA.record, { jobID: sharedJobID });
    const sharedB = await outcome("shared", sharedJobID);
    await bind(sharedB, sharedA.cached);
    verify("[native/frontend] Shared bytes and a synthetic shared job retain independent source owners",
      sharedA.identity.fingerprint === sharedB.identity.fingerprint && sharedA.record.recordID !== sharedB.record.recordID &&
      sharedA.record.sourceKey !== sharedB.record.sourceKey && sharedA.record.ownerKey !== sharedB.record.ownerKey &&
      sharedA.record.jobID === sharedB.record.jobID, { jobReferenceMode: "synthetic; no model jobs" });
    await Zotero.Items.trashTx([sharedA.parent.id, sharedB.parent.id]);
    await settle();
    verify("[native/frontend] Trashing every shared owner retains both records and their common output",
      library.records.includes(sharedA.record) && library.records.includes(sharedB.record) &&
      await IOUtils.exists(sharedA.cached.outputPath) && await sharedB.translated.fileExists());
    await restore(sharedB);
    await sharedA.parent.eraseTx();
    await settle();
    verify("[native/frontend] Zotero erasing one owner does not erase its surviving peer",
      !await library.item(sharedA.record.libraryID, sharedA.record.attachmentKey) && await sharedB.translated.fileExists());
    const peerSaved = await snapshot(sharedB);

    const disposable = new Zotero.Item("journalArticle");
    disposable.setField("title", "PaperBridge lifecycle disposable " + runKey);
    await disposable.saveTx();
    const deadSource = await Zotero.Attachments.importFromFile({ file: sourceFile, parentItemID: disposable.id });
    const deadIdentity = await library.describe(deadSource, null, config("disposable"));
    const deadRecord = await library.put(deadSource, null, config("disposable"),
      { ...deadIdentity, state: "failed" }, await IOUtils.stat(await deadSource.getFilePathAsync()));
    const deadCache = await cache(deadIdentity);
    await disposable.eraseTx();
    // These requests are inspection-only; no fake response contributes to an actual-backend check.
    const inspections = [];
    /** Inspect frontend requests only; never present these stub outcomes as backend validation. */
    function inspection(base) {
      return new bridge.library.constructor({ runtime: { ...local.runtime, base },
        /** Record a forbidden cleanup request without actually deleting a cache fixture. */
        async request(path, method, body) { inspections.push({ mode: "stub-only", path, method, body }); return {}; } });
    }
    const uncertain = inspection(PathUtils.join(libraryBase, "uncertain"));
    await IOUtils.makeDirectory(uncertain.bridge.runtime.base);
    const schema = (await IOUtils.readJSON(library.path)).version;
    await IOUtils.writeUTF8(uncertain.path, JSON.stringify({ version: schema, records: [primary.record],
      pending: [library.ref(deadRecord)], indexComplete: false }));
    await uncertain.load();
    verify("[frontend/stub-only] Uncertain index disables cleanup while keeping native results readable",
      !uncertain.indexComplete && inspections.length === 0 && await IOUtils.exists(deadCache.attempt) &&
      (await uncertain.savedFor(primary.translated))?.attachment.id === primary.translated.id,
      { requestMode: "stub-only", expectedWarning: uncertain.lastError });
    const attempts = inspection(PathUtils.join(libraryBase, "states"));
    for (const state of ["queued", "running", "unknown", "done"]) {
      attempts.records.push(attempts.restoreRecord({ libraryID: deadRecord.libraryID, sourceKey: deadRecord.sourceKey,
        ownerKey: deadRecord.ownerKey, config: config("disposable"), state,
        jobID: state === "done" ? sharedJobID : null, ...deadIdentity, documentKey: deadIdentity.document_key }));
    }
    await attempts.schedule();
    verify("[frontend/stub-only] Active, unknown, and job-referenced records do not prune or cancel",
      attempts.records.length === 4 && !attempts.lastError && inspections.length === 0 && await IOUtils.exists(deadCache.attempt));

    const evidenceIdentity = await identity("evidence-only");
    const evidence = await cache(evidenceIdentity, { evidence: true });
    const unknownIdentity = await identity("unknown-attempt");
    const unknown = await cache(unknownIdentity, { unknown: true });
    // Deliberately omit frontend keep records to exercise the real stale-pending backend defense.
    const stale = await local.request("/cache/prune", "POST", {
      remove: [library.ref(primary.record), evidenceIdentity, unknownIdentity], keep: [], sweep: false });
    verify("[actual backend] Old removal references cannot erase a result, sidecar-only evidence, or unknown attempt",
      Array.isArray(stale.removed_jobs) && stale.removed_jobs.length === 0 &&
      await IOUtils.exists(evidence.alignmentPath) && await IOUtils.exists(unknown.attempt));
    for (const asset of [...evidence.assets, ...unknown.assets]) verify("[actual backend] Orphan fixture bytes are unchanged",
      await IOUtils.exists(asset.path) && await this.hash(asset.path) === asset.sha256, { path: asset.path, kind: asset.kind });
    await settle();
    const cleanup = pruneCalls[pruneCalls.length - 1];
    verify("[actual backend/frontend] Reconciliation removes only the proven unowned disposable cache",
      !library.records.includes(deadRecord) && library.pending.length === 0 &&
      !await IOUtils.exists(deadCache.legacy) && !await IOUtils.exists(deadCache.attempt) &&
      cleanup.result.removed_jobs.includes(deadIdentity.fingerprint) &&
      cleanup.request.keep.some(ref => ref.fingerprint === sharedA.identity.fingerprint));
    await this.retained(library, primarySaved, verify, "Final standalone retention");
    await this.retained(library, peerSaved, verify, "Final shared-owner retention");
    return { root, libraryBase, indexPath: library.path, profileDirectory, dataDirectory,
      processID: Services.appinfo.processID, providerCalls: 0, engineOutcomes: "not run",
      mappingMode: mappingFile ? "actual native publisher" : "synthetic sidecar retention only",
      inspectionMode: "stub-only; zero cleanup requests", pruneCalls,
      retained: [primarySaved, peerSaved], recordIDs: library.records.map(record => record.recordID),
      erasedSource, erasedOwner,
      removedCache: [deadCache.legacy, deadCache.attempt], orphanAssets: [...evidence.assets, ...unknown.assets] };
  },

  /** Verify returned state in a genuinely new process; caller owns persistence and normal shutdown. */
  async reopen({ bridge, root, check, state }) {
    const { verify, profileDirectory, dataDirectory } = this.scope(bridge, root, check, {
      isolated: true, expectedProfileDirectory: state.profileDirectory, expectedDataDirectory: state.dataDirectory });
    verify("[native cold reopen] Same isolated profile/data, genuinely different process",
      Number.isInteger(state.processID) && state.processID > 0 && state.processID !== Services.appinfo.processID &&
      this.inside(profileDirectory, state.profileDirectory) &&
      this.inside(state.profileDirectory, profileDirectory) && this.inside(dataDirectory, state.dataDirectory) &&
      this.inside(state.dataDirectory, dataDirectory) && this.inside(root, state.libraryBase));
    await bridge.ready;
    const library = new bridge.library.constructor({ runtime: { base: state.libraryBase, state: bridge.runtime.state },
      /** Cold readback never simulates a backend response or permits unexpected cleanup. */
      async request(path) { throw new Error("Cold lifecycle readback unexpectedly requested " + path); } });
    await library.load();
    verify("[frontend cold reopen] All retained record identities remain indexed",
      state.recordIDs.every(id => library.records.some(record => record.recordID === id)) && library.indexComplete && !library.lastError);
    for (const saved of state.retained) await this.retained(library, saved, verify, "Cold reopen");
    for (const item of [state.erasedSource, state.erasedOwner]) {
      verify("[native cold reopen] Permanently removed original stays absent", !await library.item(item.libraryID, item.key));
    }
    for (const path of state.removedCache) verify("[actual filesystem cold reopen] Disposable cache stays removed",
      this.inside(dataDirectory, path) && !await IOUtils.exists(path));
    for (const asset of state.orphanAssets) verify("[actual filesystem cold reopen] Unowned evidence/unknown attempt stays retained",
      this.inside(dataDirectory, asset.path) && await IOUtils.exists(asset.path) && await this.hash(asset.path) === asset.sha256);
    return { processID: Services.appinfo.processID, providerCalls: 0, retainedRecords: library.records.length };
  }
};
