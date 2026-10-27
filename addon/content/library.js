/* global Zotero, Services, IOUtils, PathUtils */
var TranslationLibrary = class {
  constructor(bridge) {
    this.bridge = bridge;
    this.path = PathUtils.join(bridge.runtime.base, "translations.json");
    this.records = [];
    this.pending = [];
    this.queue = Promise.resolve();
    this.needsSweep = false;
    this.writes = Promise.resolve();
  }

  async item(libraryID, key) {
    return key ? (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key)) || null : null;
  }

  async save() {
    const data = JSON.stringify({version:1,records:this.records,pending:this.pending,needsSweep:this.needsSweep});
    this.writes = this.writes.then(async () => {
      await IOUtils.makeDirectory(this.bridge.runtime.base, {ignoreExisting:true});
      await IOUtils.writeUTF8(this.path,data,{tmpPath:this.path+".tmp"});
      await IOUtils.setPermissions(this.path,0o600);
    });
    return this.writes;
  }

  ref(record) {
    return {fingerprint:record.fingerprint,document_key:record.documentKey,model:record.model,lang_out:record.language};
  }

  async describe(source, attachment, config) {
    return this.bridge.request("/cache/describe","POST",{
      source_path:source && await source.fileExists() ? await source.getFilePathAsync() : "",
      translated_path:attachment && await attachment.fileExists() ? await attachment.getFilePathAsync() : "",
      model:config.model,base_url:config.baseURL,lang_out:config.language,pages:config.pages
    });
  }

  async load() {
    if (await IOUtils.exists(this.path)) {
      const data = JSON.parse(await IOUtils.readUTF8(this.path));
      this.records = data.records;
      this.pending = data.pending;
      this.needsSweep = data.needsSweep;
    } else {
      const branch = Services.prefs.getBranch("extensions.paperbridge.");
      const names = branch.getChildList("translation.");
      for (const name of names) {
        const [,library,key,language] = name.split(".");
        const old = JSON.parse(branch.getStringPref(name));
        const source = await this.item(Number(library),key);
        const attachment = await Zotero.Items.getAsync(old.id) || null;
        const owner = source?.parentID ? await Zotero.Items.getAsync(source.parentID) :
          attachment?.parentID ? await Zotero.Items.getAsync(attachment.parentID) : source;
        if (!owner) continue;
        const config = {...old,language};
        const cache = await this.describe(source,attachment,config);
        const record = {
          libraryID:Number(library),sourceKey:key,sourceID:source?.id || null,
          ownerKey:owner.key,ownerID:owner.id,parentKey:owner.isRegularItem() ? owner.key : null,
          attachmentKey:attachment?.key || null,attachmentID:attachment?.id || null,
          sourceURI:source ? Zotero.URI.getItemURI(source) : attachment?.getRelationsByPredicate("dc:relation")[0],
          title:source ? source.getField("title") : "PDF",
          language,model:old.model,baseURL:old.baseURL,pages:old.pages,
          modified:old.modified,size:old.size,fingerprint:cache.fingerprint,documentKey:cache.document_key
        };
        this.records.push(record);
      }
      this.needsSweep = true;
      await this.save();
      for (const name of names) branch.clearUserPref(name);
    }
    await this.schedule();
  }

  schedule() {
    // Do not perform Zotero writes inside a Notifier transaction callback.
    this.queue = this.queue.then(() => Zotero.Promise.delay(0)).then(() => this.reconcile()).catch(error => {
      this.lastError = error.message;
      Zotero.logError(error);
    });
    return this.queue;
  }

  async settled() {
    let queue;
    do { queue = this.queue; await queue; } while (queue !== this.queue);
  }

  async put(source, attachment, config, cache, stat) {
    const owner = source.parentID ? await Zotero.Items.getAsync(source.parentID) : source;
    const record = {
      libraryID:source.libraryID,sourceKey:source.key,sourceID:source.id,
      ownerKey:owner.key,ownerID:owner.id,parentKey:source.parentID ? owner.key : null,
      attachmentKey:attachment?.key || null,attachmentID:attachment?.id || null,
      sourceURI:Zotero.URI.getItemURI(source),title:source.getField("title"),
      ...config,modified:stat.lastModified,size:stat.size,
      rulesVersion:1,
      fingerprint:cache.fingerprint,documentKey:cache.document_key
    };
    const old = this.records.find(r => r.libraryID===record.libraryID && r.sourceKey===record.sourceKey && r.fingerprint===record.fingerprint && !r.attachmentKey);
    if (old) Object.assign(old,record);
    else this.records.push(record);
    await this.save();
    return old || record;
  }

  async attach(record, attachment) {
    record.attachmentID = attachment.id;
    record.attachmentKey = attachment.key;
    await this.save();
  }

  isTranslation(item) {
    return this.records.some(r => r.libraryID===item.libraryID && r.attachmentKey===item.key);
  }

  async ownerAlive(record) {
    const owner = await this.item(record.libraryID,record.ownerKey);
    return !!owner && !owner.deleted;
  }

  async matching(source, config) {
    if (!await source.fileExists()) return null;
    const stat = await IOUtils.stat(await source.getFilePathAsync());
    for (const record of [...this.records].reverse()) {
      if (record.libraryID!==source.libraryID || record.sourceKey!==source.key ||
          record.rulesVersion!==1 ||
          record.modified!==stat.lastModified || record.size!==stat.size ||
          ["language","model","baseURL","pages"].some(key => record[key]!==config[key])) continue;
      const attachment = await this.item(record.libraryID,record.attachmentKey);
      if (attachment && !attachment.deleted && await attachment.fileExists() && await this.ownerAlive(record)) return attachment;
    }
    return null;
  }

  async savedFor(item, language) {
    for (const record of [...this.records].reverse()) {
      if (record.libraryID!==item.libraryID || record.language!==language ||
          ![record.ownerKey,record.sourceKey,record.attachmentKey].includes(item.key)) continue;
      const attachment = await this.item(record.libraryID,record.attachmentKey);
      if (attachment && !attachment.deleted && await attachment.fileExists() && await this.ownerAlive(record)) return {record,attachment};
    }
    return null;
  }

  async reconcile() {
    const removed = [];
    for (const record of [...this.records]) {
      const source = await this.item(record.libraryID,record.sourceKey);
      const attachment = await this.item(record.libraryID,record.attachmentKey);
      // Follow attachment moves during a library merge, using stable item keys.
      const currentParent = source?.parentKey || attachment?.parentKey;
      if (record.parentKey && currentParent && currentParent!==record.parentKey) {
        const parent = await this.item(record.libraryID,currentParent);
        record.ownerKey = record.parentKey = currentParent;
        record.ownerID = parent.id;
      }
      if (await this.ownerAlive(record)) continue;
      await this.bridge.cancel(record.sourceID);
      for (const [tab,state] of this.bridge.splits) {
        if (state.reader.itemID===record.sourceID) this.bridge.closeSplit(tab);
      }
      if (attachment) await attachment.eraseTx();
      // Older versions could leave several translations for the same source.
      const owner = await this.item(record.libraryID,record.ownerKey);
      if (owner?.isRegularItem() && record.sourceURI) {
        for (const id of owner.getAttachments(true)) {
          const child = await Zotero.Items.getAsync(id);
          if (child?.isPDFAttachment() && child.getField("title").startsWith("译文 · ") &&
              child.getRelationsByPredicate("dc:relation").includes(record.sourceURI)) await child.eraseTx();
        }
      }
      removed.push(record);
    }
    for (const record of removed) {
      this.records.splice(this.records.indexOf(record),1);
      this.pending.push(this.ref(record));
    }
    await this.save();
    if (this.pending.length || this.needsSweep) {
      this.lastCleanup = await this.bridge.request("/cache/prune","POST",{
        remove:this.pending,keep:this.records.map(record => this.ref(record)),sweep:this.needsSweep
      });
      this.pending = [];
      this.needsSweep = false;
      this.lastError = "";
      await this.save();
    }
  }
};
