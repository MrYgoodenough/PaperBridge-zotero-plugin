/** Persist shared formula results separately from PDF files and engine caches. */
/* global Zotero, IOUtils, PathUtils, Cc, Ci */
// Keep the existing on-disk schema compatible across ordinary plugin upgrades.
const FORMULA_CACHE_SCHEMA = 1;
// Cache filenames must be content hashes, never attachment paths or item titles.
const FORMULA_CACHE_ID_PATTERN = /^[a-f0-9]{64}$/;
// Only completed JSON files participate in startup recovery.
const FORMULA_CACHE_SUFFIX = ".json";
// Quantize small PDF extraction jitter without including provider settings in identity.
const FORMULA_CACHE_GLYPH_PRECISION = 10;
// Formula text is private local data on platforms supporting Unix permissions.
const FORMULA_CACHE_PERMISSIONS = 0o600;

var FormulaCache = class {
  /** Initialize serialized IO and per-document invalidation state. */
  constructor(bridge) {
    this.bridge = bridge;
    this.root = PathUtils.join(bridge.runtime.base, "formula-cache");
    this.documents = new Map();
    this.broken = new Map();
    this.fingerprints = new Map();
    this.queue = Promise.resolve();
    this.generation = 0;
    this.epochs = new Map();
    // Pending requests may still carry an identity retired by a late link.
    this.redirects = new Map();
  }

  /** Hash PDF bytes and normalized selections using Gecko's cross-platform SHA256. */
  hash(bytes) {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }

  /** Identify a formula independently of delimiters, provider settings and plugin version. */
  key(selection) {
    // Formula identity is independent of $/$$, model settings, iframe and plugin version.
    // Normalize sub-point extraction jitter between the original and preserved PDF vectors.
    const glyphs = (selection.glyphs || []).map(g => [g.c, g.page || 0,
      g.rect.map(n => Math.round(n * FORMULA_CACHE_GLYPH_PRECISION) / FORMULA_CACHE_GLYPH_PRECISION)]);
    return this.hash(new TextEncoder().encode(JSON.stringify([selection.text.replace(/\s+/g,""), glyphs])));
  }

  /** Resolve identities merged during this session, including already pending requests. */
  resolve(id) {
    while (this.redirects.has(id)) id = this.redirects.get(id);
    return id;
  }

  /** Check whether a pending context still owns writable data after clear or late link. */
  isCurrent(context) {
    return this.bridge.alive && this.documents.has(this.resolve(context.id))
      && context.generation === (this.epochs.get(context.id) || 0);
  }

  /** Serialize cache mutations while preserving errors for callers and the cache UI. */
  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(error => { this.lastError = String(error); Zotero.logError(error); });
    return result;
  }

  /** Wait for all currently queued cache operations before shutdown. */
  async settled() {
    let previous;
    do { previous = this.queue; await previous; } while (previous !== this.queue);
  }

  /** Restore completed JSON documents and reconcile their current Zotero ownership. */
  async load() {
    await IOUtils.makeDirectory(this.root, {ignoreExisting:true});
    for (const path of await IOUtils.getChildren(this.root)) {
      const name = PathUtils.filename(path);
      if (!name.endsWith(FORMULA_CACHE_SUFFIX)) continue;
      const id = name.slice(0, -FORMULA_CACHE_SUFFIX.length);
      if (!FORMULA_CACHE_ID_PATTERN.test(id)) continue;
      try {
        const doc = JSON.parse(await IOUtils.readUTF8(path));
        if (doc.schema !== FORMULA_CACHE_SCHEMA || doc.id !== id || !Array.isArray(doc.references)
            || !doc.entries || !doc.pages || !doc.aliases) throw new Error("公式缓存格式无效");
        this.documents.set(doc.id, doc);
      } catch (error) { this.broken.set(id, String(error)); }
    }
    await this.reconcile();
  }

  /** Memoize physical PDF hashes until its path, size or modification time changes. */
  async fingerprint(item) {
    const path = await item.getFilePathAsync();
    if (!path) throw new Error("PDF 文件不可用，请先下载附件。");
    const stat = await IOUtils.stat(path);
    const signature = JSON.stringify([path, stat.size, stat.lastModified]);
    if (!this.fingerprints.has(signature)) this.fingerprints.set(signature, this.hash(await IOUtils.read(path)));
    return {id:this.fingerprints.get(signature), path};
  }

  /** Look up items by stable Zotero library/key identity, including trash state. */
  async item(libraryID, key) { return key ? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key) || null : null; }

  /** Add one actual owner without assigning attachments moved to other owners. */
  addReference(doc, item, sourceKey, attachmentKeys = []) {
    const owner = item.parentItem || item;
    const identity = `${item.libraryID}:${owner.key}`;
    let ref = doc.references.find(r => `${r.libraryID}:${r.ownerKey}` === identity);
    if (!ref) {
      ref = {libraryID:item.libraryID, ownerKey:owner.key, parent:owner.isRegularItem(), sourceKey,
        attachmentKeys:[]};
      doc.references.push(ref);
    }
    ref.attachmentKeys = [...new Set([
      ...ref.attachmentKeys, item.isPDFAttachment() ? item.key : null, ...attachmentKeys
    ].filter(Boolean))];
    return ref;
  }

  /** Atomically replace only this formula document's JSON. */
  async write(doc) {
    await IOUtils.makeDirectory(this.root, {ignoreExisting:true});
    const path = PathUtils.join(this.root, doc.id + FORMULA_CACHE_SUFFIX);
    await IOUtils.writeUTF8(path, JSON.stringify(doc), {tmpPath:path + ".tmp"});
    // Unsupported file permissions must not discard a successfully persisted result.
    try { await IOUtils.setPermissions(path, FORMULA_CACHE_PERMISSIONS); }
    catch (error) { this.lastError = String(error); Zotero.logError(error); }
  }

  /** Resolve an attachment to its original-content cache and current clear epoch. */
  async context(reader) {
    const item = Zotero.Items.get(reader.itemID);
    if (!item?.isPDFAttachment() || item.deleted || item.parentItem?.deleted) throw new Error("PDF 或所属论文已删除。");
    const physical = await this.fingerprint(item);
    return this.run(async () => {
      let record = [...this.bridge.library.records].reverse().find(r => r.libraryID === item.libraryID
        && [r.sourceKey, r.attachmentKey].includes(item.key));
      if (record?.sourceKey === item.key && record.documentKey !== physical.id) record = null;
      const recordID = this.resolve(record?.documentKey);
      let doc = recordID && this.documents.get(recordID);
      doc ||= [...this.documents.values()].find(d => d.references.some(r => r.libraryID === item.libraryID
        && r.attachmentKeys.includes(item.key)) && d.aliases[`${item.libraryID}:${item.key}`] === physical.id);
      const id = doc?.id || recordID || this.resolve(physical.id);
      doc ||= this.documents.get(id);
      if (!doc) {
        if (this.broken.has(id)) throw new Error("这篇 PDF 的公式缓存损坏，请在缓存查看窗口清除后重试。");
        doc = {schema:FORMULA_CACHE_SCHEMA, id, title:item.parentItem?.getField("title") || item.getField("title"),
          references:[], aliases:{}, entries:{}, pages:{}, created:new Date().toISOString()};
        this.documents.set(id, doc);
      }
      const before = JSON.stringify([doc.references,doc.aliases]);
      this.addReference(doc, item, record?.sourceKey || item.key, record ? [record.sourceKey, record.attachmentKey] : []);
      doc.aliases[`${item.libraryID}:${item.key}`] = physical.id;
      if (before !== JSON.stringify([doc.references,doc.aliases])) await this.write(doc);
      if (!this.epochs.has(id)) this.epochs.set(id, 0);
      return {id, physicalID:physical.id, path:physical.path, generation:this.epochs.get(id) || 0};
    });
  }

  /** Merge late-created translated caches into the established original identity. */
  async link(source, translated) {
    const context = await this.context({itemID:source.id});
    const physical = await this.fingerprint(translated);
    await this.run(async () => {
      const doc = this.documents.get(this.resolve(context.id));
      if (!this.isCurrent(context)) return;
      const alias = `${translated.libraryID}:${translated.key}`;
      const duplicates = [...this.documents.values()].filter(candidate => candidate.id !== doc.id
        && (candidate.id === physical.id || candidate.aliases[alias] === physical.id));
      for (const duplicate of duplicates) {
        // Existing original results win collisions; all other results and physical pages survive.
        doc.entries = {...duplicate.entries, ...doc.entries};
        doc.pages = {...duplicate.pages, ...doc.pages};
        doc.aliases = {...duplicate.aliases, ...doc.aliases};
        doc.references.push(...duplicate.references);
      }
      this.addReference(doc, translated, source.key, [source.key, translated.key]);
      doc.aliases[alias] = physical.id;
      await this.refreshReferences(doc);
      // Persist the union before retiring old JSON files; a failed write loses no old file.
      await this.write(doc);
      for (const duplicate of duplicates) {
        this.redirects.set(duplicate.id, doc.id);
        await this.remove(duplicate.id);
      }
    });
  }

  /** Read results through late-link redirects without invoking a provider. */
  async lookup(context, key) {
    return this.run(() => this.documents.get(this.resolve(context.id))?.entries[key]?.latex || null);
  }

  /** Retain valid pending results, but never restore entries invalidated by a clear. */
  async store(context, key, selection, latex) {
    return this.run(async () => {
      const doc = this.documents.get(this.resolve(context.id));
      if (!this.isCurrent(context)) return;
      // A result started under a retired identity must not overwrite an established original entry.
      if (context.id !== doc.id && doc.entries[key]) return;
      if (!await this.refreshReferences(doc)) { await this.remove(doc.id); return; }
      doc.entries[key] = {latex, text:selection?.text || "", page:selection?.glyphs?.[0]?.page ?? null,
        updated:new Date().toISOString()};
      await this.write(doc);
    });
  }

  /** Keep region results distinct for each physical PDF and page. */
  async page(context, pageIndex) {
    return this.run(() => this.documents.get(this.resolve(context.id))?.pages[`${context.physicalID}:${pageIndex}`] || null);
  }

  /** Persist only successfully detected page regions under the current clear epoch. */
  async storePage(context, pageIndex, regions) {
    return this.run(async () => {
      const doc = this.documents.get(this.resolve(context.id));
      if (!this.isCurrent(context)) return;
      if (!await this.refreshReferences(doc)) { await this.remove(doc.id); return; }
      doc.pages[`${context.physicalID}:${pageIndex}`] = {regions};
      await this.write(doc);
    });
  }

  /** Rebuild actual owner groups while retaining surviving paper-only references. */
  async refreshReferences(doc) {
    // Commit groups only after discovery; a split or standalone move must not overwrite an owner.
    const refreshed = {references:[]};
    for (const ref of doc.references) {
      const owner = await this.item(ref.libraryID, ref.ownerKey);
      if (owner && !owner.deleted && (owner.isRegularItem()
          || owner.isPDFAttachment() && !owner.parentItem?.deleted)) {
        this.addReference(refreshed, owner, ref.sourceKey);
      }
      for (const key of ref.attachmentKeys) {
        const item = await this.item(ref.libraryID, key);
        if (item?.isPDFAttachment() && !item.deleted && !item.parentItem?.deleted) {
          this.addReference(refreshed, item, ref.sourceKey);
        }
      }
    }
    // Check both files: an existing trashed translation must not mask a live source.
    for (const record of this.bridge.library.records) {
      if (this.resolve(record.documentKey) !== doc.id) continue;
      const owner = await this.item(record.libraryID, record.ownerKey);
      if (owner?.isRegularItem() && !owner.deleted) this.addReference(refreshed, owner, record.sourceKey);
      for (const key of new Set([record.sourceKey, record.attachmentKey].filter(Boolean))) {
        const item = await this.item(record.libraryID, key);
        if (item?.isPDFAttachment() && !item.deleted && !item.parentItem?.deleted) {
          this.addReference(refreshed, item, record.sourceKey);
        }
      }
    }
    doc.references = refreshed.references;
    return doc.references.length > 0;
  }

  /** Delete only an owned formula JSON, never PDFs or other plugin caches. */
  async remove(id) {
    this.documents.delete(id);
    this.broken.delete(id);
    await IOUtils.remove(PathUtils.join(this.root, id + FORMULA_CACHE_SUFFIX), {ignoreAbsent:true});
  }

  /** Prune only documents with no surviving Zotero paper or PDF reference. */
  reconcile() {
    return this.run(async () => {
      for (const doc of [...this.documents.values()]) {
        const before = JSON.stringify(doc.references);
        if (await this.refreshReferences(doc)) {if (before !== JSON.stringify(doc.references)) await this.write(doc);}
        else await this.remove(doc.id);
      }
    });
  }

  /** Invalidate pending contexts, including retired identities, before removing selected JSON. */
  clear(id) {
    return this.run(async () => {
      this.generation++;
      const ids = id ? [this.resolve(id)] : [...new Set([...this.documents.keys(), ...this.broken.keys()])];
      if (ids.some(key => !FORMULA_CACHE_ID_PATTERN.test(key))) throw new Error("公式缓存 ID 无效");
      for (const key of this.epochs.keys()) {
        if (!id || ids.includes(this.resolve(key))) this.epochs.set(key, this.generation);
      }
      for (const key of ids) {
        this.epochs.set(key, this.generation);
        await this.remove(key);
      }
      return ids.length;
    });
  }

  /** Return nonsecret document summaries for the cache window. */
  list() {
    return this.run(() => [
      ...[...this.documents.values()].map(doc => ({id:doc.id,title:doc.title, references:doc.references,
        entries:Object.values(doc.entries), pages:Object.keys(doc.pages).length})),
      ...[...this.broken].map(([id,error]) => ({id,title:"损坏的公式缓存",error,entries:[],references:[],pages:0}))
    ]);
  }
};
