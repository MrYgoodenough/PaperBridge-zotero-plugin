/** Persist per-owner translation tasks and preserve recoverable Zotero outcomes. */
/* global Zotero, Services, IOUtils, PathUtils */
// Index and record schema; rendering rules remain separate for legacy matching.
const TRANSLATION_VERSION = 2;
// Existing rendering-rule identity is unchanged by the task-journal upgrade.
const TRANSLATION_RULES_VERSION = 1;
// Zotero's random strings give records independent local identities.
const TRANSLATION_ID_LENGTH = 24;
// Only these nonsecret settings form an immutable translation configuration.
const TRANSLATION_CONFIG_KEYS = ["profile", "capabilities", "baseURL", "model", "language", "pages"];
// Relations survive a crash between Zotero metadata saving and index saving.
const TRANSLATION_RECORD_URI = "urn:paperbridge:record:";
// Shared backend jobs still have independent, source-specific library records.
const TRANSLATION_JOB_URI = "urn:paperbridge:job:";

var TranslationLibrary = class {
  /** Initialize independent reconciliation and atomic-write queues. */
  constructor(bridge) {
    this.bridge = bridge;
    this.path = PathUtils.join(bridge.runtime.base, "translations.json");
    this.records = [];
    this.pending = []; // Cache-removal references, not queued translation tasks.
    this.queue = Promise.resolve();
    this.writes = Promise.resolve();
    this.indexComplete = true;
    this.needsSweep = false; // Never infer ownership from unindexed cache folders.
    this.lastError = "";
    this.backupRequired = false;
  }

  /** Report recoverable failures without disabling unrelated library features. */
  warn(error) {
    this.lastError = this.publicValue(error.message || String(error));
    Zotero.logError(new Error(this.lastError));
  }

  /** Copy public JSON metadata, removing credentials and common error-message leaks. */
  publicValue(value) {
    if (Array.isArray(value)) return value.map(entry => this.publicValue(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/api.?key|secret|password|authorization|credential|access.?token|refresh.?token|headers/i.test(key))
        .map(([key, entry]) => [key, this.publicValue(entry)]));
    }
    return typeof value === "string" ? value
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
      .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s&,;"']+/gi, "$1[redacted]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\bsk-[\w-]+/g, "[redacted]") : value;
  }

  /** Snapshot supported settings without retaining caller objects or credentials. */
  configSnapshot(config = {}) {
    return Object.fromEntries(TRANSLATION_CONFIG_KEYS.map(key =>
      [key, this.publicValue(config[key] ?? (key === "capabilities" ? {} : key === "profile" ? "deepseek" : ""))]));
  }

  /** Compare configurations independently of capability-object property order. */
  configKey(config) {
    /** Sort nested capability keys for deterministic matching. */
    const ordered = value => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
      : Array.isArray(value) ? value.map(ordered) : value;
    return JSON.stringify(ordered(this.configSnapshot(config)));
  }

  /** Allocate a record identity independent of source hashes and shared jobs. */
  newID() {
    return Zotero.Utilities.randomString(TRANSLATION_ID_LENGTH);
  }

  /** Resolve stable item keys, including items in Zotero's trash. */
  async item(libraryID, key) {
    return key ? (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)) || null : null;
  }

  /** Write atomically; preserve an uncertain original before replacing it. */
  async save() {
    const data = JSON.stringify({version:TRANSLATION_VERSION, records:this.records,
      pending:this.pending, indexComplete:this.indexComplete, needsSweep:false});
    this.writes = this.writes.catch(() => {}).then(async () => {
      await IOUtils.makeDirectory(this.bridge.runtime.base, {ignoreExisting:true});
      if (this.backupRequired) {
        await IOUtils.copy(this.path, this.path + ".recovery-" + this.newID());
        this.backupRequired = false;
      }
      await IOUtils.writeUTF8(this.path, data, {tmpPath:this.path + ".tmp"});
      try { await IOUtils.setPermissions(this.path, 0o600); }
      catch (error) { this.warn(error); }
    });
    try { await this.writes; }
    catch (error) { this.warn(error); throw error; }
  }

  /** Return the backend's cache-reference shape without task metadata. */
  ref(record) {
    return {fingerprint:record.fingerprint, document_key:record.documentKey,
      model:record.model, lang_out:record.language};
  }

  /** Describe legacy cache identities using only public configuration. */
  async describe(source, attachment, config) {
    return this.bridge.request("/cache/describe", "POST", {
      source_path:source && await source.fileExists() ? await source.getFilePathAsync() : "",
      translated_path:attachment && await attachment.fileExists() ? await attachment.getFilePathAsync() : "",
      model:config.model, base_url:config.baseURL, lang_out:config.language, pages:config.pages,
      profile:config.profile, capabilities:config.capabilities
    });
  }

  /** Upgrade known fields without guessing that an unfinished legacy task succeeded. */
  restoreRecord(old) {
    const config = this.configSnapshot(old.config || old);
    const record = {version:TRANSLATION_VERSION, recordID:old.recordID || this.newID(), config, ...config};
    for (const key of ["libraryID", "sourceKey", "sourceID", "ownerKey", "ownerID", "parentKey",
      "attachmentKey", "attachmentID", "sourceURI", "title", "modified", "size", "rulesVersion",
      "fingerprint", "documentKey", "importingAttachmentKey", "outputPath", "retryOf", "retryPendingSince"]) {
      record[key] = this.publicValue(old[key] ?? null);
    }
    record.jobID = old.jobID || null;
    record.state = old.state || (old.attachmentKey ? "done" : "unknown");
    record.quality = this.publicValue(old.quality ?? "unknown");
    record.saveState = old.saveState || (old.attachmentKey ? "imported" : null);
    record.lastError = this.publicValue(old.lastError || "");
    record.detached = old.detached === true;
    return record;
  }

  /** Recover readable records and disable cleanup when any ownership is uncertain. */
  async load() {
    if (await IOUtils.exists(this.path)) {
      try {
        const data = JSON.parse(await IOUtils.readUTF8(this.path));
        this.indexComplete = [1, TRANSLATION_VERSION].includes(data?.version) &&
          Array.isArray(data.records) && Array.isArray(data.pending) && data.indexComplete !== false;
        for (const old of Array.isArray(data?.records) ? data.records : []) {
          if (!old || !Number.isInteger(old.libraryID) || !(old.sourceKey || old.attachmentKey || old.ownerKey)) {
            this.indexComplete = false;
            continue;
          }
          const duplicateID = this.records.some(record => record.recordID === old.recordID);
          if (!old.sourceKey || !old.ownerKey || duplicateID) {
            this.indexComplete = false;
          }
          this.records.push(this.restoreRecord(duplicateID ? {...old, recordID:this.newID()} : old));
        }
        this.pending = Array.isArray(data?.pending) ? this.publicValue(data.pending) : [];
        if (!this.indexComplete) throw new Error("Translation index is incomplete or unsupported; cache cleanup is disabled.");
      } catch (error) {
        this.indexComplete = false;
        this.backupRequired = true;
        this.warn(new Error("Translation index recovery: " + error.message));
      }
    } else {
      await this.migratePreferences();
    }
    await this.schedule();
  }

  /** Migrate legacy preferences individually, retaining failed entries for recovery. */
  async migratePreferences() {
    const branch = Services.prefs.getBranch("extensions.paperbridge.");
    for (const name of branch.getChildList("translation.")) {
      try {
        const [, library, key, language] = name.split(".");
        const old = JSON.parse(branch.getStringPref(name));
        const source = await this.item(Number(library), key);
        const attachment = await Zotero.Items.getAsync(old.id) || null;
        const owner = source?.parentID ? await Zotero.Items.getAsync(source.parentID) :
          attachment?.parentID ? await Zotero.Items.getAsync(attachment.parentID) : source;
        const config = this.configSnapshot({...old, language});
        let cache = {};
        try { cache = await this.describe(source, attachment, config); }
        catch (error) { this.warn(error); }
        this.records.push(this.restoreRecord({
          libraryID:Number(library), sourceKey:key, sourceID:source?.id,
          ownerKey:owner?.key || key, ownerID:owner?.id, parentKey:owner?.isRegularItem() ? owner.key : null,
          attachmentKey:attachment?.key, attachmentID:attachment?.id,
          sourceURI:source ? Zotero.URI.getItemURI(source) : attachment?.getRelationsByPredicate("dc:relation")[0],
          title:source ? source.getField("title") : "PDF", config,
          modified:old.modified, size:old.size, fingerprint:cache.fingerprint, documentKey:cache.document_key
        }));
        await this.save();
        branch.clearUserPref(name);
      } catch (error) {
        this.indexComplete = false;
        this.warn(error);
      }
    }
  }

  /** Defer reconciliation outside Notifier transactions and contain its failures. */
  schedule() {
    this.queue = this.queue.then(() => Zotero.Promise.delay(0)).then(() => this.reconcile())
      .catch(error => this.warn(error));
    return this.queue;
  }

  /** Wait for reconciliation and writes, including work queued by item notifications. */
  async settled() {
    let queue, writes;
    do { queue = this.queue; writes = this.writes; await queue; await writes; }
    while (queue !== this.queue || writes !== this.writes);
  }

  /** Enqueue idempotently per source/config/job; never collapse different Zotero owners. */
  async put(source, attachment, config, job = {}, stat) {
    const owner = source.parentID ? await Zotero.Items.getAsync(source.parentID) : source;
    const snapshot = this.configSnapshot(config);
    const jobID = job.id || job.jobID || null;
    let record = this.records.find(existing => !existing.detached && existing.libraryID === source.libraryID &&
      existing.sourceKey === source.key && existing.modified === stat.lastModified && existing.size === stat.size &&
      this.configKey(existing.config) === this.configKey(snapshot) &&
      (jobID ? existing.jobID === jobID : !existing.jobID &&
        (job.fingerprint ? existing.fingerprint === job.fingerprint : !existing.fingerprint)));
    if (!record) {
      record = this.restoreRecord({
        libraryID:source.libraryID, sourceKey:source.key, sourceID:source.id,
        ownerKey:owner?.key || source.parentKey || source.key, ownerID:owner?.id,
        parentKey:source.parentKey || (source.parentID ? owner?.key : null),
        sourceURI:Zotero.URI.getItemURI(source), title:source.getField("title"), config:snapshot,
        modified:stat.lastModified, size:stat.size, rulesVersion:TRANSLATION_RULES_VERSION,
        jobID, state:job.state || (attachment ? "done" : "queued"), quality:job.quality,
        saveState:job.state === "done" || job.output_path ? "produced" : null,
        lastError:job.error, outputPath:job.output_path,
        fingerprint:job.fingerprint, documentKey:job.document_key
      });
      this.records.push(record);
    }
    // Persist before Zotero writes so the relation has a durable record to identify.
    await this.save();
    if (attachment) await this.attach(record, attachment);
    return record;
  }

  /** Fork a retry with a new backend job ID, leaving the prior outcome untouched. */
  async forkAttempt(record, status) {
    const jobID = status.id || status.jobID;
    if (!jobID || jobID === record.jobID) throw new Error("A translation retry needs a new backend job ID.");
    let attempt = this.records.find(candidate => candidate.retryOf === record.recordID && candidate.jobID === jobID);
    if (!attempt) {
      attempt = this.restoreRecord({...record, recordID:this.newID(), retryOf:record.recordID,
        jobID, state:status.state || "queued", detached:false, retryPendingSince:null, quality:status.quality ?? "unknown",
        saveState:status.state === "done" || status.output_path ? "produced" : null,
        lastError:status.error || "", attachmentID:null, attachmentKey:null, importingAttachmentKey:null,
        outputPath:status.output_path || null, fingerprint:status.fingerprint ?? record.fingerprint,
        documentKey:status.document_key ?? record.documentKey});
      this.records.push(attempt);
    }
    await this.save();
    return attempt;
  }

  /** Persist mutable task/status fields; identity and the configuration stay immutable. */
  async update(record, patch) {
    record = this.records.find(candidate => candidate.recordID === record.recordID);
    if (!record) throw new Error("Translation record is no longer in the library.");
    const changes = {...patch};
    for (const [from, to] of [["id", "jobID"], ["error", "lastError"], ["output_path", "outputPath"], ["document_key", "documentKey"]]) {
      if (from in changes && !(to in changes)) changes[to] = changes[from];
    }
    for (const key of ["jobID", "state", "quality", "saveState", "lastError", "outputPath",
      "fingerprint", "documentKey", "importingAttachmentKey", "detached", "retryPendingSince"]) {
      if (key in changes && changes[key] !== undefined) record[key] = this.publicValue(changes[key]);
    }
    if ((record.state === "done" || record.outputPath) && !record.saveState) record.saveState = "produced";
    await this.save();
    return record;
  }

  /** Recover imported PDFs by stable keys first, then unambiguous persistent relations. */
  async findAttachment(record) {
    for (const key of [record.attachmentKey, record.importingAttachmentKey]) {
      const attachment = await this.item(record.libraryID, key);
      if (attachment?.isPDFAttachment() && !attachment.deleted && await attachment.fileExists()) return attachment;
    }
    if (!record.attachmentKey && record.attachmentID) {
      const attachment = await Zotero.Items.getAsync(record.attachmentID);
      if (attachment?.libraryID === record.libraryID && attachment.isPDFAttachment() &&
          !attachment.deleted && await attachment.fileExists()) return attachment;
    }
    const candidates = [];
    const owner = await this.item(record.libraryID, record.ownerKey);
    if (owner?.isRegularItem()) {
      for (const id of owner.getAttachments(true)) candidates.push(await Zotero.Items.getAsync(id));
    }
    // The relation query also recovers standalone or moved outcomes after owner loss.
    if (Zotero.Relations?.getByPredicateAndObject) {
      for (const uri of [TRANSLATION_RECORD_URI + record.recordID,
        ...(record.jobID ? [TRANSLATION_JOB_URI + record.jobID] : [])]) {
        candidates.push(...await Zotero.Relations.getByPredicateAndObject("item", "dc:relation", uri));
      }
    }
    for (const attachment of candidates) {
      if (!attachment?.isPDFAttachment() || attachment.libraryID !== record.libraryID || attachment.deleted) continue;
      const relations = attachment.getRelationsByPredicate("dc:relation");
      if ((relations.includes(TRANSLATION_RECORD_URI + record.recordID) ||
          (!relations.some(uri => uri.startsWith(TRANSLATION_RECORD_URI)) &&
           record.jobID && relations.includes(TRANSLATION_JOB_URI + record.jobID) &&
           record.sourceURI && relations.includes(record.sourceURI))) && await attachment.fileExists()) return attachment;
    }
    return null;
  }

  /** Save recovery markers before committing attachment ownership to the index. */
  async attach(record, attachment) {
    const existing = await this.findAttachment(record);
    attachment = existing || attachment;
    if (attachment.libraryID !== record.libraryID || !attachment.isPDFAttachment()) {
      throw new Error("Translation attachment must be a PDF in the source library.");
    }
    try {
      record = await this.update(record, {importingAttachmentKey:attachment.key});
      for (const uri of [record.sourceURI, TRANSLATION_RECORD_URI + record.recordID,
        record.jobID && TRANSLATION_JOB_URI + record.jobID].filter(Boolean)) {
        if (!attachment.getRelationsByPredicate("dc:relation").includes(uri)) {
          attachment.addRelation("dc:relation", uri);
        }
      }
      // Save caller metadata too: an interrupted earlier save may have left dirty fields.
      await attachment.saveTx();
      record.attachmentID = attachment.id;
      record.attachmentKey = attachment.key;
      await this.update(record, {saveState:"imported", importingAttachmentKey:null, lastError:""});
      return attachment;
    } catch (error) {
      try { await this.update(record, {saveState:"import_failed", lastError:error.message}); }
      catch (saveError) { this.warn(saveError); }
      throw error;
    }
  }

  /** Recognize indexed, partially imported, and relation-marked translations. */
  isTranslation(item) {
    return this.records.some(record => record.libraryID === item.libraryID &&
      [record.attachmentKey, record.importingAttachmentKey].includes(item.key)) ||
      (item.getRelationsByPredicate?.("dc:relation") || []).some(uri =>
        uri.startsWith(TRANSLATION_RECORD_URI) || uri.startsWith(TRANSLATION_JOB_URI));
  }

  /** Report whether automatic saving under the original owner remains appropriate. */
  async ownerAlive(record) {
    const owner = await this.item(record.libraryID, record.ownerKey);
    return !!owner && !owner.deleted;
  }

  /** Check the source snapshot before reusing or resuming a translation. */
  async sourceUnchanged(record) {
    const source = await this.item(record.libraryID, record.sourceKey);
    if (!source || source.deleted || !await source.fileExists()) return false;
    const stat = await IOUtils.stat(await source.getFilePathAsync());
    return record.modified === stat.lastModified && record.size === stat.size;
  }

  /** Automatically reuse only complete results for an unchanged source and exact configuration. */
  async matching(source, config) {
    for (const record of [...this.records].reverse()) {
      if (record.quality?.status !== "complete" || record.libraryID !== source.libraryID || record.sourceKey !== source.key || record.rulesVersion !== TRANSLATION_RULES_VERSION ||
          this.configKey(record.config) !== this.configKey(config) || !await this.sourceUnchanged(record)) continue;
      const attachment = await this.findAttachment(record);
      if (attachment) return attachment;
    }
    return null;
  }

  /** Open retained outcomes independently of current settings or source/owner existence. */
  async savedFor(item, language) {
    const records = [...this.records].reverse();
    const relations = item.getRelationsByPredicate?.("dc:relation") || [];
    records.sort((a, b) => Number(b.attachmentKey === item.key) - Number(a.attachmentKey === item.key));
    for (const record of records) {
      if (record.libraryID !== item.libraryID || (language && record.language !== language) ||
          (![record.ownerKey, record.sourceKey, record.attachmentKey, record.importingAttachmentKey].includes(item.key) &&
           !relations.includes(TRANSLATION_RECORD_URI + record.recordID) &&
           !(record.jobID && relations.includes(TRANSLATION_JOB_URI + record.jobID) && relations.includes(record.sourceURI)))) continue;
      const attachment = await this.findAttachment(record);
      if (attachment) return {record, attachment};
    }
    return null;
  }

  /** Treat cached PDFs as recoverable outcomes, not evidence of disposable work. */
  async cachedResult(ref) {
    return !!(this.bridge.runtime.state && /^[a-f0-9]{64}$/.test(ref.fingerprint || "") &&
      await IOUtils.exists(PathUtils.join(this.bridge.runtime.state, "jobs", ref.fingerprint, "translated.pdf")));
  }

  /** Remove only provably unowned disposable cache; never erase or cancel Zotero items/tasks. */
  async reconcile() {
    if (!this.indexComplete) { await this.save(); return; }
    for (const record of [...this.records]) {
      const source = await this.item(record.libraryID, record.sourceKey);
      const attachment = await this.item(record.libraryID, record.attachmentKey);
      const importing = await this.item(record.libraryID, record.importingAttachmentKey);
      const currentParent = source?.parentKey || attachment?.parentKey;
      if (record.parentKey && currentParent && currentParent !== record.parentKey) {
        const parent = await this.item(record.libraryID, currentParent);
        if (parent) {
          record.ownerKey = record.parentKey = currentParent;
          record.ownerID = parent.id;
        }
      }
      // Trash, unavailable files, all job references and uncertain states retain ownership.
      if (source || attachment || importing || await this.item(record.libraryID, record.ownerKey) || record.jobID ||
          !["done", "failed", "cancelled"].includes(record.state) ||
          ["produced", "import_failed"].includes(record.saveState) ||
          (record.outputPath && await IOUtils.exists(record.outputPath)) || await this.cachedResult(this.ref(record)) ||
          await this.findAttachment(record)) continue;
      this.records.splice(this.records.indexOf(record), 1);
      this.pending.push(this.ref(record));
    }
    await this.save();
    if (this.pending.length) {
      const pending = [...this.pending];
      const remove = [], retained = [];
      for (const ref of pending) {
        // Old cleanup queues may reference an orphan PDF produced before this upgrade.
        if (!ref || [ref.fingerprint, ref.document_key].some(key => key && !/^[a-f0-9]{64}$/.test(key))) {
          this.indexComplete = false;
          this.warn(new Error("Invalid cache reference; cache cleanup is disabled."));
          await this.save();
          return;
        }
        (await this.cachedResult(ref) ? retained : remove).push(ref);
      }
      if (!remove.length) return;
      this.lastCleanup = await this.bridge.request("/cache/prune", "POST", {
        remove, keep:[...this.records.map(record => this.ref(record)), ...retained], sweep:false
      });
      this.pending = this.pending.filter(ref => !remove.includes(ref));
      await this.save();
    }
  }
};
