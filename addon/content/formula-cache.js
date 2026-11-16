/* global Zotero, IOUtils, PathUtils, Cc, Ci */
var FormulaCache = class {
  constructor(bridge) {
    this.bridge = bridge;
    this.root = PathUtils.join(bridge.runtime.base, "formula-cache");
    this.documents = new Map();
    this.broken = new Map();
    this.fingerprints = new Map();
    this.queue = Promise.resolve();
    this.generation = 0;
    this.epochs = new Map();
  }

  hash(bytes) {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  key(selection) {
    // Formula identity is independent of $/$$, model settings, iframe and plugin version.
    // Normalize sub-point extraction jitter between the original and preserved PDF vectors.
    const glyphs = (selection.glyphs || []).map(g => [g.c, g.page || 0, g.rect.map(n => Math.round(n * 10) / 10)]);
    return this.hash(new TextEncoder().encode(JSON.stringify([selection.text.replace(/\s+/g,""), glyphs])));
  }

  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(error => { this.lastError = String(error); Zotero.logError(error); });
    return result;
  }

  async settled() {
    let previous;
    do { previous = this.queue; await previous; } while (previous !== this.queue);
  }

  async load() {
    await IOUtils.makeDirectory(this.root, {ignoreExisting:true});
    for (const path of await IOUtils.getChildren(this.root)) {
      const name = PathUtils.filename(path);
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const doc = JSON.parse(await IOUtils.readUTF8(path));
        if (doc.schema !== 1 || doc.id !== name.slice(0, -5) || !Array.isArray(doc.references)
            || !doc.entries || !doc.pages || !doc.aliases) throw new Error("公式缓存格式无效");
        this.documents.set(doc.id, doc);
      } catch (error) { this.broken.set(name.slice(0, -5), String(error)); }
    }
    await this.reconcile();
  }

  async fingerprint(item) {
    const path = await item.getFilePathAsync();
    if (!path) throw new Error("PDF 文件不可用，请先下载附件。");
    const stat = await IOUtils.stat(path);
    const signature = JSON.stringify([path, stat.size, stat.lastModified]);
    if (!this.fingerprints.has(signature)) this.fingerprints.set(signature, this.hash(await IOUtils.read(path)));
    return {id:this.fingerprints.get(signature), path};
  }

  async item(libraryID, key) { return key ? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key) || null : null; }

  addReference(doc, item, sourceKey, attachmentKeys = []) {
    const owner = item.parentItem || item;
    const identity = `${item.libraryID}:${owner.key}`;
    let ref = doc.references.find(r => `${r.libraryID}:${r.ownerKey}` === identity);
    if (!ref) {
      ref = {libraryID:item.libraryID, ownerKey:owner.key, parent:owner.isRegularItem(), sourceKey,
        attachmentKeys:[]};
      doc.references.push(ref);
    }
    ref.attachmentKeys = [...new Set([...ref.attachmentKeys, item.key, ...attachmentKeys].filter(Boolean))];
    return ref;
  }

  async write(doc) {
    await IOUtils.makeDirectory(this.root, {ignoreExisting:true});
    const path = PathUtils.join(this.root, doc.id + ".json");
    await IOUtils.writeUTF8(path, JSON.stringify(doc), {tmpPath:path + ".tmp"});
    await IOUtils.setPermissions(path, 0o600);
  }

  async context(reader) {
    const item = Zotero.Items.get(reader.itemID);
    if (!item?.isPDFAttachment() || item.deleted || item.parentItem?.deleted) throw new Error("PDF 或所属论文已删除。");
    const physical = await this.fingerprint(item);
    return this.run(async () => {
      let record = [...this.bridge.library.records].reverse().find(r => r.libraryID === item.libraryID
        && [r.sourceKey, r.attachmentKey].includes(item.key));
      if (record?.sourceKey === item.key && record.documentKey !== physical.id) record = null;
      let doc = record?.documentKey && this.documents.get(record.documentKey);
      doc ||= [...this.documents.values()].find(d => d.references.some(r => r.libraryID === item.libraryID
        && r.attachmentKeys.includes(item.key)) && d.aliases[`${item.libraryID}:${item.key}`] === physical.id);
      const id = doc?.id || record?.documentKey || physical.id;
      doc ||= this.documents.get(id);
      if (!doc) {
        if (this.broken.has(id)) throw new Error("这篇 PDF 的公式缓存损坏，请在缓存查看窗口清除后重试。");
        doc = {schema:1, id, title:item.parentItem?.getField("title") || item.getField("title"),
          references:[], aliases:{}, entries:{}, pages:{}, created:new Date().toISOString()};
        this.documents.set(id, doc);
      }
      const before = JSON.stringify([doc.references,doc.aliases]);
      this.addReference(doc, item, record?.sourceKey || item.key, record ? [record.sourceKey, record.attachmentKey] : []);
      doc.aliases[`${item.libraryID}:${item.key}`] = physical.id;
      if (before !== JSON.stringify([doc.references,doc.aliases])) await this.write(doc);
      return {id, physicalID:physical.id, path:physical.path, generation:this.epochs.get(id) || 0};
    });
  }

  async link(source, translated) {
    const context = await this.context({itemID:source.id});
    const physical = await this.fingerprint(translated);
    await this.run(async () => {
      const doc = this.documents.get(context.id);
      if (!doc) return;
      this.addReference(doc, translated, source.key, [source.key, translated.key]);
      doc.aliases[`${translated.libraryID}:${translated.key}`] = physical.id;
      await this.write(doc);
    });
  }

  async lookup(context, key) {
    return this.run(() => this.documents.get(context.id)?.entries[key]?.latex || null);
  }

  async store(context, key, selection, latex) {
    return this.run(async () => {
      const doc = this.documents.get(context.id);
      if (!doc || context.generation !== (this.epochs.get(context.id) || 0) || !this.bridge.alive) return;
      if (!await this.refreshReferences(doc)) { await this.remove(doc.id); return; }
      doc.entries[key] = {latex, text:selection?.text || "", page:selection?.glyphs?.[0]?.page ?? null,
        updated:new Date().toISOString()};
      await this.write(doc);
    });
  }

  async page(context, pageIndex) {
    return this.run(() => this.documents.get(context.id)?.pages[`${context.physicalID}:${pageIndex}`] || null);
  }

  async storePage(context, pageIndex, regions) {
    return this.run(async () => {
      const doc = this.documents.get(context.id);
      if (!doc || context.generation !== (this.epochs.get(context.id) || 0) || !this.bridge.alive) return;
      if (!await this.refreshReferences(doc)) { await this.remove(doc.id); return; }
      doc.pages[`${context.physicalID}:${pageIndex}`] = {regions};
      await this.write(doc);
    });
  }

  async refreshReferences(doc) {
    const alive = [];
    // Discover other known owners of the same original, even if that pane wasn't opened.
    for (const record of this.bridge.library.records) {
      if (record.documentKey !== doc.id) continue;
      const item = await this.item(record.libraryID, record.attachmentKey) || await this.item(record.libraryID, record.sourceKey);
      if (item && !item.deleted && !item.parentItem?.deleted) this.addReference(doc,item,record.sourceKey,[record.sourceKey,record.attachmentKey]);
    }
    for (const ref of doc.references) {
      let owner = await this.item(ref.libraryID, ref.ownerKey);
      const attachments = [];
      for (const key of ref.attachmentKeys) {
        const item = await this.item(ref.libraryID, key);
        if (item?.isPDFAttachment() && !item.deleted && !item.parentItem?.deleted) attachments.push(item);
      }
      // Follow an attachment moved to another paper, without retaining a deleted owner.
      const moved = attachments.find(a => a.parentKey && a.parentKey !== ref.ownerKey);
      if (moved) { owner = moved.parentItem; ref.ownerKey = owner.key; ref.parent = true; }
      ref.attachmentKeys = attachments.map(a => a.key);
      // A surviving paper remains a reference when only the original file is deleted.
      if (owner && !owner.deleted && (ref.parent && owner.isRegularItem() || attachments.length)) alive.push(ref);
    }
    doc.references = alive;
    return alive.length > 0;
  }

  async remove(id) {
    this.documents.delete(id);
    this.broken.delete(id);
    await IOUtils.remove(PathUtils.join(this.root, id + ".json"), {ignoreAbsent:true});
  }

  reconcile() {
    return this.run(async () => {
      for (const doc of [...this.documents.values()]) {
        const before = JSON.stringify(doc.references);
        if (await this.refreshReferences(doc)) {if (before !== JSON.stringify(doc.references)) await this.write(doc);}
        else await this.remove(doc.id);
      }
    });
  }

  clear(id) {
    return this.run(async () => {
      this.generation++;
      const ids = id ? [id] : [...new Set([...this.documents.keys(), ...this.broken.keys()])];
      if (ids.some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error("公式缓存 ID 无效");
      for (const key of ids) { this.epochs.set(key,this.generation); await this.remove(key); }
      return ids.length;
    });
  }

  list() {
    return this.run(() => [
      ...[...this.documents.values()].map(doc => ({id:doc.id,title:doc.title, references:doc.references,
        entries:Object.values(doc.entries), pages:Object.keys(doc.pages).length})),
      ...[...this.broken].map(([id,error]) => ({id,title:"损坏的公式缓存",error,entries:[],references:[],pages:0}))
    ]);
  }
};
