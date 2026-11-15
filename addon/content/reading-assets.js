/** Keep verified PDF alignment as a synced Zotero attachment, independent of Python. */
/* global Zotero, IOUtils, PathUtils, Cc, Ci, Components, FragmentAlignment */
// A relation marker identifies our JSON attachments without guessing filenames.
const ALIGNMENT_ASSET_RELATION = "urn:paperbridge:alignment:1";
// The portable wrapper evolves independently of the producer's geometry schema.
const ALIGNMENT_ASSET_VERSION = 1;
// Bound only optional reading metadata; a large or damaged map never blocks PDF reading.
const ALIGNMENT_ASSET_MAX_BYTES = 16 * 1024 * 1024;
// Match the producer's request-unit bound, not the number of translated pages.
const ALIGNMENT_ASSET_MAX_UNITS = 4096;
// Keep portable files small without imposing a translation-size limit.
const ALIGNMENT_ASSET_MAX_REGIONS = 65536;
// PDF.js and the producer may round page boundaries slightly differently.
const ALIGNMENT_ASSET_EPSILON = 0.01;
// Publication filenames are temporary and independent of source PDF or task identities.
const ALIGNMENT_ASSET_FILENAME_ID_LENGTH = 24;

var AlignmentAssets = class AlignmentAssets {
  /** Serialize publication per exact attachment pair, never per PDF content alone. */
  constructor(bridge) {
    this.bridge = bridge;
    this.publishing = new Map();
  }

  /** Hash the actual file with Gecko, without loading Python or retaining PDF contents. */
  static hashFile(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.normalize(path));
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    // Read-only mode and the documented all-remaining-bytes hash sentinel.
    const readOnly = 0x01, entireStream = 0xffffffff;
    stream.init(file, readOnly, 0, 0);
    try {
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, entireStream);
      return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } finally { stream.close(); }
  }

  /** Copy only identity and verified geometry; captured text and logs cannot be exported. */
  static canonical(mapping) {
    const checked = FragmentAlignment.checkMapping(mapping);
    if (!checked.mapping) throw new Error(checked.reason);
    if (mapping.units.length > ALIGNMENT_ASSET_MAX_UNITS) throw new Error("映射过大，保留普通 PDF 阅读。");
    for (const field of ["source_sha256", "output_sha256"]) {
      if (!/^[a-f0-9]{64}$/.test(mapping[field])) throw new Error("片段映射缺少有效的 PDF 哈希。");
    }
    let regions = 0;
    const units = mapping.units.map(unit => {
      if (!/^[\w:-]{1,128}$/.test(unit.id)) throw new Error("片段身份格式不受支持。");
      const value = { id: unit.id, status: "verified" };
      for (const side of ["source", "target"]) {
        regions += unit[side].rects.length;
        value[side] = { page: unit[side].page, rects: unit[side].rects.map(rect => [...rect]) };
        if (unit[side].quads) value[side].quads = unit[side].quads.map(quad => [...quad]);
      }
      return value;
    });
    if (regions > ALIGNMENT_ASSET_MAX_REGIONS) throw new Error("映射几何过大，保留普通 PDF 阅读。");
    const generator = mapping.generator_version || (mapping.schema_version === 1 ? "legacy-rectangles-1" : "");
    if (!/^[\w.-]{1,80}$/.test(generator)) throw new Error("映射生成器版本不受支持。");
    return { schema_version: mapping.schema_version, coordinate_space: "pdf-user-space",
      generator_version: generator, source_sha256: mapping.source_sha256,
      output_sha256: mapping.output_sha256, units };
  }

  /** Read optional metadata without triggering Zotero file downloads or engine startup. */
  static async readJSON(path) {
    const stat = await IOUtils.stat(path);
    if (stat.size > ALIGNMENT_ASSET_MAX_BYTES) throw new Error("映射附件过大，保留普通 PDF 阅读。");
    return JSON.parse(await IOUtils.readUTF8(path));
  }

  /** Check the wrapper before resolving its exact keys inside the attachment's library. */
  static payload(value) {
    const fields = ["kind", "schema_version", "source_attachment_key", "translated_attachment_key", "owner_key",
      "language", "generator_version", "validation", "mapping"];
    if (!value || value.kind !== "paperbridge-alignment" || value.schema_version !== ALIGNMENT_ASSET_VERSION
      || Object.keys(value).some(field => !fields.includes(field))
      || !/^[A-Z0-9]{8}$/.test(value.source_attachment_key || "")
      || !/^[A-Z0-9]{8}$/.test(value.translated_attachment_key || "")
      || value.source_attachment_key === value.translated_attachment_key
      || (value.owner_key !== null && !/^[A-Z0-9]{8}$/.test(value.owner_key || ""))
      || value.validation?.status !== "verified"
      || value.validation?.basis !== "captured-identity-final-pdf"
      || Object.keys(value.validation).some(field => !["status", "basis"].includes(field))
      || typeof value.language !== "string" || value.language.length > 32) {
      throw new Error("映射附件格式或验证身份不受支持。");
    }
    const mapping = this.canonical(value.mapping);
    if (value.generator_version !== mapping.generator_version) throw new Error("映射生成器版本不一致。");
    return { ...value, mapping };
  }

  /** Locate explicit relation-marked attachments; a similarly named JSON file is not evidence. */
  async attachments(libraryID) {
    if (!Zotero.Relations?.getByPredicateAndObject) return [];
    const items = await Zotero.Relations.getByPredicateAndObject("item", "dc:relation", ALIGNMENT_ASSET_RELATION);
    return items.filter(item => item.libraryID === libraryID && item.isAttachment() && !item.deleted);
  }

  /** Preserve a missing or damaged synced attachment; its failure affects only precision. */
  async readAttachment(attachment) {
    if (!await attachment.fileExists()) throw new Error("映射附件尚未下载，继续使用页级同步。");
    return AlignmentAssets.payload(await AlignmentAssets.readJSON(await attachment.getFilePathAsync()));
  }

  /** Resolve keys and owner together; cross-library copies with old keys are not rebound by hash. */
  async resolve(attachment, payload) {
    const source = await this.bridge.library.item(attachment.libraryID, payload.source_attachment_key);
    const translated = await this.bridge.library.item(attachment.libraryID, payload.translated_attachment_key);
    if (!source?.isPDFAttachment() || !translated?.isPDFAttachment() || source.deleted || translated.deleted) return null;
    const owner = payload.owner_key;
    if ((attachment.parentKey || null) !== owner || (source.parentKey || null) !== owner
      || (translated.parentKey || null) !== owner) return null;
    return { source, attachment: translated, record: { libraryID: attachment.libraryID,
      sourceKey: source.key, attachmentKey: translated.key, language: payload.language || "",
      mappingAttachmentKey: attachment.key } };
  }

  /** Discover downloaded assets and exact legacy source relations, without reconstructing a task. */
  async savedPairs(item) {
    const pairs = new Map();
    for (const asset of await this.attachments(item.libraryID)) {
      try {
        const payload = await this.readAttachment(asset);
        const pair = await this.resolve(asset, payload);
        if (pair && [pair.source.key, pair.attachment.key, payload.owner_key].includes(item.key)) {
          pairs.set(pair.source.key + ":" + pair.attachment.key, pair);
        }
      } catch (error) { Zotero.debug("PaperBridge: optional reading asset unavailable: " + error.message); }
    }
    const owner = item.isRegularItem() ? item : item.parentID ? await Zotero.Items.getAsync(item.parentID) : null;
    const pdfs = owner ? (await Zotero.Items.getAsync(owner.getAttachments(true)))
      .filter(candidate => candidate?.isPDFAttachment() && !candidate.deleted) : item.isPDFAttachment() ? [item] : [];
    for (const translated of pdfs.filter(candidate => this.bridge.library.isTranslation(candidate))) {
      const relations = translated.getRelationsByPredicate("dc:relation");
      for (const source of pdfs.filter(candidate => !this.bridge.library.isTranslation(candidate))) {
        if (!relations.includes(Zotero.URI.getItemURI(source))
          || ![owner?.key, source.key, translated.key].includes(item.key)) continue;
        const key = source.key + ":" + translated.key;
        if (!pairs.has(key)) pairs.set(key, { source, attachment: translated,
          record: { libraryID: source.libraryID, sourceKey: source.key, attachmentKey: translated.key } });
      }
    }
    return [...pairs.values()];
  }

  /** Verify actual bytes every time a pair is opened; file timestamps are not trust evidence. */
  async evidence(source, translated) {
    if (!await source.fileExists() || !await translated.fileExists()) throw new Error("原文或译文尚未下载，片段定位暂不可用。");
    const sourcePath = await source.getFilePathAsync(), targetPath = await translated.getFilePathAsync();
    return { source: AlignmentAssets.hashFile(sourcePath), target: AlignmentAssets.hashFile(targetPath) };
  }

  /** Validate page bounds with the already-open native PDF.js documents, never a backend request. */
  async geometry(mapping, state) {
    const apps = state.alignment?.apps;
    if (!apps) return;
    for (const [index, side] of ["source", "target"].entries()) {
      const document = apps[index]?.pdfDocument;
      if (!document?.getPage) throw new Error("原生 PDF 几何接口不可用，继续使用页级同步。");
      const pages = new Map();
      for (const unit of mapping.units) {
        const page = unit[side].page;
        if (page >= document.numPages) throw new Error("映射页不存在，继续使用页级同步。");
        if (!pages.has(page)) {
          const proxy = await document.getPage(page + 1);
          // PDF.js owns this getter in its content compartment; an Xray hides the page view.
          const native = typeof Components !== "undefined" ? Components.utils.waiveXrays(proxy) : proxy;
          const view = native.view;
          pages.set(page, view?.length === 4 ? [view[0], view[1], view[2], view[3]] : null);
        }
        const bounds = pages.get(page);
        if (!bounds || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
          throw new Error("PDF 页面边界不可用，继续使用页级同步。");
        }
        for (const rect of unit[side].rects) {
          if (rect[0] < bounds[0] - ALIGNMENT_ASSET_EPSILON || rect[1] < bounds[1] - ALIGNMENT_ASSET_EPSILON
            || rect[2] > bounds[2] + ALIGNMENT_ASSET_EPSILON || rect[3] > bounds[3] + ALIGNMENT_ASSET_EPSILON) {
            throw new Error("映射几何越界，继续使用页级同步。");
          }
        }
      }
    }
  }

  /** Bind one canonical mapping to the present PDF bytes before enabling precise interaction. */
  async verified(mapping, state, hashes) {
    const canonical = AlignmentAssets.canonical(mapping);
    if (canonical.source_sha256 !== hashes.source) throw new Error("原文已变化，旧片段映射已停用。");
    if (canonical.output_sha256 !== hashes.target) throw new Error("译文已变化，旧片段映射已停用。");
    await this.geometry(canonical, state);
    return canonical;
  }

  /** Prefer synced trusted geometry; an existing local sidecar can fill a missing asset for free. */
  async load(state, record) {
    let reason = "没有可信片段映射，继续使用页级同步；不会为补映射重新翻译。";
    try {
      const hashes = await this.evidence(state.source, state.translated);
      const valid = [];
      for (const asset of await this.attachments(state.source.libraryID)) {
        const relations = asset.getRelationsByPredicate("dc:relation");
        // An unreadable asset can explain this pair only when both exact native relations agree.
        let relevant = relations.includes(Zotero.URI.getItemURI(state.source))
          && relations.includes(Zotero.URI.getItemURI(state.translated));
        try {
          const payload = await this.readAttachment(asset);
          if (payload.source_attachment_key !== state.source.key || payload.translated_attachment_key !== state.translated.key) continue;
          relevant = true;
          if (!await this.resolve(asset, payload)) throw new Error("映射附件归属不一致，继续使用页级同步。");
          valid.push(await this.verified(payload.mapping, state, hashes));
        } catch (error) { if (relevant) reason = error.message; }
      }
      if (valid.length) {
        const version = Math.max(...valid.map(mapping => mapping.schema_version));
        const current = valid.filter(mapping => mapping.schema_version === version);
        if (current.some(mapping => JSON.stringify(mapping) !== JSON.stringify(current[0]))) {
          return { available: false, mapping: null, reason: "同一附件对有冲突映射，继续使用页级同步；不会自动重新翻译。" };
        }
        return { available: true, mapping: current[0], origin: "zotero-attachment" };
      }
      if (record?.alignmentPath && await IOUtils.exists(record.alignmentPath)) {
        const mapping = await this.verified(await AlignmentAssets.readJSON(record.alignmentPath), state, hashes);
        // Publishing failure is nonfatal; the verified local reading result remains usable.
        await this.publish(record, state.translated).catch(error => this.bridge.library.warn(error));
        return { available: true, mapping, origin: "local-sidecar" };
      }
    } catch (error) { reason = error.message; }
    return { available: false, mapping: null, reason: reason.includes("重新翻译") ? reason : reason + " 不会自动重新翻译。" };
  }

  /** Publish idempotently for an exact source/translation pair, including shared-job owners. */
  async publish(record, translated) {
    const key = `${record.libraryID}:${record.sourceKey}:${translated.key}`;
    if (!this.publishing.has(key)) this.publishing.set(key, this.publishOnce(record, translated));
    try { return await this.publishing.get(key); }
    finally { this.publishing.delete(key); }
  }

  /** Import a small immutable JSON attachment; preserve every older PDF and mapping asset. */
  async publishOnce(record, translated) {
    if (!record.alignmentPath || !await IOUtils.exists(record.alignmentPath)) return null;
    const source = await this.bridge.library.item(record.libraryID, record.sourceKey);
    if (!source?.isPDFAttachment() || source.deleted || translated.deleted
      || source.libraryID !== translated.libraryID || (source.parentKey || null) !== (translated.parentKey || null)) return null;
    const hashes = await this.evidence(source, translated);
    const mapping = await this.verified(await AlignmentAssets.readJSON(record.alignmentPath), { source, translated }, hashes);
    const payload = { kind: "paperbridge-alignment", schema_version: ALIGNMENT_ASSET_VERSION,
      source_attachment_key: source.key, translated_attachment_key: translated.key,
      owner_key: translated.parentKey || null, language: record.language || "",
      generator_version: mapping.generator_version, validation: { status: "verified", basis: "captured-identity-final-pdf" }, mapping };
    for (const asset of await this.attachments(record.libraryID)) {
      try {
        const existing = await this.readAttachment(asset);
        if (JSON.stringify(existing) === JSON.stringify(payload) && await this.resolve(asset, existing)) {
          await this.bridge.library.update(record, { mappingAttachmentKey: asset.key, mappingState: "synced-attachment" });
          return asset;
        }
      } catch (_) { /* A damaged old asset is retained, not overwritten. */ }
    }
    const directory = PathUtils.join(this.bridge.runtime.base, "mapping-export");
    await IOUtils.makeDirectory(directory, { ignoreExisting: true });
    const path = PathUtils.join(directory, Zotero.Utilities.randomString(ALIGNMENT_ASSET_FILENAME_ID_LENGTH) + ".json");
    try {
      await IOUtils.writeUTF8(path, JSON.stringify(payload));
      const asset = await Zotero.Attachments.importFromFile({ file: path, libraryID: translated.libraryID,
        parentItemID: translated.parentID || undefined });
      asset.setField("title", "PaperBridge 可信片段映射 · " + (translated.getField("title") || translated.key));
      asset.addRelation("dc:relation", ALIGNMENT_ASSET_RELATION);
      asset.addRelation("dc:relation", Zotero.URI.getItemURI(source));
      asset.addRelation("dc:relation", Zotero.URI.getItemURI(translated));
      await asset.saveTx();
      await this.bridge.library.update(record, { mappingAttachmentKey: asset.key, mappingState: "synced-attachment" });
      return asset;
    } finally { await IOUtils.remove(path, { ignoreAbsent: true }); }
  }
};
