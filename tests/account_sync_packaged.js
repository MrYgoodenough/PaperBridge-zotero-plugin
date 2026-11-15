/** Verify authorized native cloud metadata and attachment sync without reading or transporting API keys. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils, PAPERBRIDGE_ACCOUNT_SYNC_TEST */
var PAPERBRIDGE_ACCOUNT_SYNC_PROMISE = (async () => {
  // Only the explicitly supplied account/profile and newly created keys are used by this helper.
  const config = PAPERBRIDGE_ACCOUNT_SYNC_TEST;
  const report = {ok: false, phase: config.phase, checks: [], processID: Services.appinfo.processID,
    providerCalls: 0, engineStarts: 0, backendRequests: 0, credentialExported: false,
    metadataDatabaseCopied: false, fileTransport: "native-account-storage", groupSyncTested: false};
  // Reader and runtime observers are restored before normal application exit.
  const readers = new Set(), restore = [];
  let authorized = false, bridge;

  /** Compare the real native directories without guessing a profile from account name. */
  function samePath(left, right) {
    const normalize = value => Zotero.isWin ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
    return !!left && !!right && normalize(left) === normalize(right);
  }

  /** Preserve failed evidence rather than treating an incomplete sync as a pass. */
  function check(condition, name, detail = {}) {
    report.checks.push({name, pass: !!condition, detail});
    if (!condition) throw new Error(name);
  }

  /** Record non-secret stage progress while the native application performs asynchronous work. */
  async function checkpoint(stage) {
    report.stage = stage;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Wait for actual UI and download completion; timeout is not acceptance. */
  async function until(predicate, message) {
    // Large first-sync uploads may take minutes; the helper does not resend translation jobs.
    const deadline = Date.now() + 180000;
    do {
      const result = await predicate();
      if (result) return result;
      await Zotero.Promise.delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Hash native file bytes without loading a large XPI into the JavaScript heap. */
  function sha256(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(file, -1, -1, 0);
    try {
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, -1);
      return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } finally { stream.close(); }
  }

  /** Count real production calls without replacing or bypassing their implementation. */
  function observeRuntime() {
    const start = bridge.runtime.start, request = bridge.request;
    bridge.runtime.start = function (...args) { report.engineStarts++; return start.apply(this, args); };
    bridge.request = function (...args) { report.backendRequests++; return request.apply(this, args); };
    restore.push(() => { bridge.runtime.start = start; bridge.request = request; });
  }

  /** Ask Zotero's account runner to sync selected libraries, with no direct API-key access. */
  async function sync(files) {
    check(!files || config.allowLibraryFileSync === true,
      "Library-wide file upload requires separate explicit authorization");
    const errors = [];
    await until(() => !Zotero.Sync.Runner.syncInProgress, "The account already has a running native sync");
    await checkpoint(files ? "native-account-file-upload" : "native-account-metadata-sync");
    report.requestedFileLibraries = files ? [Zotero.Libraries.userLibraryID] : [];
    await Zotero.Sync.Runner.sync({background: true, libraries: [Zotero.Libraries.userLibraryID],
      fileLibraries: files ? [Zotero.Libraries.userLibraryID] : [], fullTextLibraries: [],
      onError: error => errors.push({name: error.name || "Error", code: error.code || error.error || "unknown"})});
    report.syncErrors = errors;
    check(!errors.length, "Native account sync returned no reported error", {files});
  }

  /** Create only a synthetic article and note, then upload metadata with all file libraries excluded. */
  async function produceMetadata() {
    check(!await IOUtils.exists(config.statePath), "Metadata fixture creation needs a fresh run ID");
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "PaperBridge 元数据验收 · " + config.runID;
    await collection.saveTx();
    const owner = new Zotero.Item("journalArticle");
    owner.libraryID = collection.libraryID;
    owner.setField("title", "PaperBridge metadata-only acceptance · " + config.runID);
    owner.setCollections([collection.id]);
    await owner.saveTx();
    const note = new Zotero.Item("note");
    note.libraryID = owner.libraryID;
    note.parentID = owner.id;
    note.setNote("<p>PaperBridge metadata-only acceptance: " + config.runID + ". No attachment files are uploaded.</p>");
    await note.saveTx();
    const index = {kind:"paperbridge-account-metadata-index", runID:config.runID,
      collectionKey:collection.key, ownerKey:owner.key, noteKey:note.key,
      title:owner.getField("title"), note:note.getNote()};
    await IOUtils.writeUTF8(config.statePath, JSON.stringify(index, null, 2));
    await sync(false);
    index.userID = Zotero.Users.getCurrentUserID();
    check(!!index.userID, "Native metadata sync established the account's real user ID");
    for (const item of [collection, owner, note]) check(item.synced && item.version > 0,
      "New collection, article and note metadata have actual server versions", {key:item.key, version:item.version});
    await IOUtils.writeUTF8(config.statePath, JSON.stringify(index, null, 2));
    report.producerIndex = config.statePath;
    report.collectionKey = collection.key;
    report.createdAttachments = 0;
  }

  /** Read exact server-backed keys and note ownership; an identity index is not a database clone. */
  async function readMetadata(index) {
    check(index.kind === "paperbridge-account-metadata-index" && !!index.userID,
      "Receiver has only the synthetic fixture's non-secret metadata identity index");
    check(Zotero.Users.getCurrentUserID() === index.userID, "Both native profiles use the same actual account user ID");
    const libraryID = Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, index.collectionKey);
    const owner = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, index.ownerKey);
    const note = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, index.noteKey);
    check(!!collection && !!owner && note?.isNote(), "Cloud metadata supplies the exact collection, article and note keys");
    for (const item of [collection, owner, note]) check(item.synced && item.version > 0,
      "Receiver metadata retains real server versions", {key:item.key, version:item.version});
    check(owner.getField("title") === index.title && owner.getCollections().includes(collection.id),
      "Synced article retains its title and collection membership");
    check(note.parentKey === owner.key && note.getNote() === index.note,
      "Synced note retains its exact native HTML and parent article");
    report.collectionKey = index.collectionKey;
    report.metadataItemsChecked = 3;
    report.createdAttachments = 0;
  }

  /** Install the explicit candidate through AddonManager rather than replacing the production XPI file. */
  async function install() {
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    check(!!bridge.runtime && !!config.candidateXpi, "Authorized native install has an explicit candidate");
    const digest = sha256(config.candidateXpi);
    check(digest === config.candidateSha256, "Native candidate input matches its declared SHA-256");
    const installation = await AddonManager.getInstallForFile(bridge.runtime.file(config.candidateXpi));
    let ended = false, failure;
    const listener = {
      /** Capture the actual addon-manager completion. */
      onInstallEnded(_value, addon) { ended = addon.id === "paperbridge@local.dev" && addon.version === config.expectedVersion; },
      /** Keep a native install error distinguishable from file-copy success. */
      onInstallFailed(value) { failure = new Error("Native install failed: " + value.error); },
      /** User cancellation is not an installed candidate. */
      onInstallCancelled() { failure = new Error("Native install cancelled"); }
    };
    installation.addListener(listener);
    try {
      Promise.resolve(installation.install()).catch(error => { failure = error; });
      await until(() => { if (failure) throw failure; return ended; }, "Native candidate installation did not finish");
      const addon = await AddonManager.getAddonByID("paperbridge@local.dev");
      check(addon.version === config.expectedVersion, "AddonManager reports the installed candidate");
      const uri = addon.getResourceURI();
      const fileURI = uri.scheme === "jar" ? uri.QueryInterface(Ci.nsIJARURI).JARFile : uri;
      const path = fileURI.QueryInterface(Ci.nsIFileURL).file.path;
      check(sha256(path) === digest, "The actual installed XPI matches the tested candidate bytes");
      report.installedXpiSha256 = digest;
    } finally { installation.removeListener(listener); }
  }

  /** Import existing real output bytes and publish their production verified mapping; no translation runs. */
  async function produce() {
    check(config.allowLibraryFileSync === true,
      "PDF fixture creation requires separately authorized native file sync");
    const cases = (await IOUtils.readJSON(config.caseManifest)).cases;
    const sample = cases?.[0];
    check(!!sample?.artifacts_sha256, "The producer uses an existing hash-bound real translation sample");
    for (const field of ["source_pdf", "translated_pdf", "alignment_path"]) {
      check(sha256(sample[field]) === sample.artifacts_sha256[field],
        "The preserved translation input matches its historical SHA-256", {field});
    }
    check(!await IOUtils.exists(config.statePath), "A new fixture needs a fresh run ID; existing account assets are retained");
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "PaperBridge 验收 · " + config.runID;
    await collection.saveTx();
    const index = {kind: "paperbridge-account-sync-index", runID: config.runID,
      collectionKey: collection.key, pairs: [], fixtureComplete: false};
    await IOUtils.writeUTF8(config.statePath, JSON.stringify(index, null, 2));
    await checkpoint("creating-owned-reading-fixture");
    // Same-byte duplicate versions exercise exact key/owner identity, not another paid model output.
    for (const [number, sample] of [cases[0], cases[0]].entries()) {
      const owner = new Zotero.Item("journalArticle");
      owner.libraryID = collection.libraryID;
      owner.setField("title", (number ? "共享原文归属验收 · " : "真实账号同步验收 · ") + sample.title);
      owner.setCollections([collection.id]);
      await owner.saveTx();
      const source = await Zotero.Attachments.importFromFile({file: sample.source_pdf, parentItemID: owner.id});
      for (let version = 0; version < (number ? 1 : 2); version++) {
        const translated = await Zotero.Attachments.importFromFile({file: sample.translated_pdf, parentItemID: owner.id});
        translated.setField("title", version ? "译本 B（同字节身份验收）" : "译本 A（既有真实输出）");
        await translated.saveTx();
        const record = await bridge.library.put(source, translated, bridge.configuration(),
          {id: `account-sync-fixture-${config.runID}-${number}-${version}`, state: "done",
            quality: {status: sample.quality_status || "unknown"}, alignment_path: sample.alignment_path},
          await IOUtils.stat(await source.getFilePathAsync()));
        check(record.attachmentKey === translated.key, "Each explicit translation version retains its own durable identity");
        const asset = await bridge.alignmentAssets.publish(record, translated);
        check(asset?.isStoredFileAttachment(), "Production mapping publisher creates a native imported JSON attachment");
        const files = [];
        for (const item of [source, translated, asset]) {
          const path = await item.getFilePathAsync();
          files.push({key: item.key, ownerKey: item.parentKey, filename: item.attachmentFilename,
            sha256: bridge.alignmentAssets.constructor.hashFile(path), bytes: (await IOUtils.stat(path)).size});
        }
        index.pairs.push({ownerKey: owner.key, sourceKey: source.key, translatedKey: translated.key, mappingKey: asset.key, files});
        await IOUtils.writeUTF8(config.statePath, JSON.stringify(index, null, 2));
      }
    }
    index.fixtureComplete = true;
    await IOUtils.writeUTF8(config.statePath, JSON.stringify(index, null, 2));
    await sync(true);
    for (const pair of index.pairs) for (const file of pair.files) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(collection.libraryID, file.key);
      check(item.synced && item.version > 0, "New attachment metadata has a real server version", {key: item.key, version: item.version});
      check(item.attachmentSyncState === Zotero.Sync.Storage.Local.SYNC_STATE_IN_SYNC,
        "Native source, translation and JSON file upload reached in-sync", {key: item.key});
    }
    report.producerIndex = config.statePath;
    report.collectionKey = collection.key;
    report.pairCount = index.pairs.length;
    check(report.engineStarts === 0 && report.backendRequests === 0,
      "Publishing the preserved real outputs makes no translation-worker or backend request");
  }

  /** Resolve only expected keys downloaded through actual account metadata sync. */
  async function expectedItems(index) {
    check(index.kind === "paperbridge-account-sync-index" && index.fixtureComplete === true
      && Array.isArray(index.pairs) && index.pairs.length > 0, "Receiver has a complete non-secret identity/hash index");
    const libraryID = Zotero.Libraries.userLibraryID;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, index.collectionKey);
    check(!!collection, "Account metadata sync created the producer's native collection key");
    const result = new Map();
    for (const pair of index.pairs) for (const expected of pair.files) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, expected.key);
      check(item?.isStoredFileAttachment() && item.synced && item.version > 0 && item.parentKey === expected.ownerKey,
        "Receiver obtains the exact attachment key and owner from account metadata", {key: expected.key});
      check(item.attachmentFilename === expected.filename, "Native metadata preserves the storage filename", {key: expected.key});
      result.set(expected.key, {item, expected});
    }
    return result;
  }

  /** Prove missing files remain a visible reading limitation before native on-demand download. */
  async function receive(index) {
    await sync(false);
    const items = await expectedItems(index);
    for (const {item} of items.values()) check(!await item.fileExists(),
      "Receiver starts with cloud metadata and no copied attachment bytes", {key: item.key});
    const pair = index.pairs[0];
    const loaded = await bridge.alignmentAssets.load({source: items.get(pair.sourceKey).item, translated: items.get(pair.translatedKey).item});
    check(!loaded.available && /尚未下载/.test(loaded.reason), "Undownloaded PDFs clearly disable precise mapping without retranslating");
    report.collectionKey = index.collectionKey;
    report.missingFiles = items.size;
    await IOUtils.writeUTF8(config.statePath, JSON.stringify({kind: index.kind, receiverPID: report.processID}, null, 2));
  }

  /** Download through Zotero's authenticated native storage runner; do not copy or synthesize bytes. */
  async function download(index) {
    const items = await expectedItems(index);
    for (const {item, expected} of items.values()) {
      check(!await item.fileExists(), "Attachment is missing at native download start", {key: item.key});
      const result = await Zotero.Sync.Runner.downloadFile(item);
      check(!!result && await item.fileExists(), "Native account on-demand download produced the real attachment", {key: item.key});
      const path = await item.getFilePathAsync();
      check(bridge.alignmentAssets.constructor.hashFile(path) === expected.sha256
        && (await IOUtils.stat(path)).size === expected.bytes, "Downloaded bytes match the producer SHA-256 and size", {key: item.key});
    }
    await read(index);
  }

  /** Open the synced pairs without task journals, translation requests or Python startup. */
  async function read(index) {
    const items = await expectedItems(index);
    for (const pair of index.pairs) {
      const source = items.get(pair.sourceKey).item, translated = items.get(pair.translatedKey).item;
      const pairs = await bridge.alignmentAssets.savedPairs(source);
      const expected = index.pairs.filter(value => value.sourceKey === source.key);
      check(pairs.length === expected.length && pairs.every(value => expected.some(candidate =>
        candidate.translatedKey === value.attachment.key && candidate.ownerKey === value.attachment.parentKey)),
        "Synced multiple versions and same-byte other owners are not collapsed or guessed", {sourceKey: source.key});
      check(pairs.some(value => value.attachment.key === translated.key && value.source.key === source.key),
        "Synced mapping discovery retains the exact source/translation pair", {translatedKey: translated.key});
      const loaded = await bridge.alignmentAssets.load({source, translated});
      check(loaded.available && loaded.origin === "zotero-attachment" && loaded.mapping.schema_version === 2,
        "Cloud-downloaded JSON is hash-verified independently of a translation worker", {translatedKey: translated.key});
      await bridge.split(source, translated);
      const native = Zotero.Reader._readers.find(value => value.itemID === source.id);
      readers.add(native);
      const split = bridge.splits.get(native.tabID);
      await until(() => split.alignment.mapping && split.apps.every(app => app.pdfDocument), "Downloaded native split did not load trusted geometry");
      check(!!split.sync && !split.alignment.button.disabled && !split.alignment.targetButton.disabled,
        "Downloaded PDFs open with page sync and both precise controls enabled");
      bridge.closeSplit(native.tabID);
      await split.annotationSave;
      native.close();
      await until(() => !Zotero.Reader._readers.includes(native), "The test-owned native reader did not close normally");
    }
    check(report.engineStarts === 0 && report.backendRequests === 0, "Native synced reading requires no Python start or backend request");
    report.pairCount = index.pairs.length;
  }

  try {
    authorized = config.allowRealAccount === true
      && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory)
      && Zotero.Prefs.get("sync.server.username") === config.expectedAccount;
    if (!authorized) throw new Error("Refusing account checks outside the explicitly authorized profile, data and username");
    await checkpoint("authorized-account-native-ready");
    bridge = await until(() => Zotero.PaperBridge, "Production plugin did not start");
    await bridge.ready;
    report.zoteroVersion = Zotero.version;
    report.sameAuthorizedUsername = true;
    report.productionVersion = bridge.runtime.version;
    report.storageProtocol = Zotero.Prefs.get("sync.storage.protocol") || "zfs";
    report.fileSyncEnabled = Zotero.Prefs.get("sync.storage.enabled");
    // Suppress automatic file sync during the explicit metadata-only stage, then restore the native setting.
    if (!config.startupSyncSuppressed) {
      const autoSync = Zotero.Prefs.get("sync.autoSync");
      Zotero.Prefs.set("sync.autoSync", false);
      restore.push(() => Zotero.Prefs.set("sync.autoSync", autoSync));
    }
    if (config.phase.startsWith("metadata-")) {
      report.fileTransport = "none (metadata-only)";
      observeRuntime();
      if (config.phase === "metadata-produce") await produceMetadata();
      else {
        const index = await IOUtils.readJSON(config.producerIndex);
        if (config.phase === "metadata-receive") {
          await sync(false);
          await readMetadata(index);
          await IOUtils.writeUTF8(config.statePath, JSON.stringify({receiverPID:report.processID}, null, 2));
        } else {
          const previous = await IOUtils.readJSON(config.statePath);
          check(previous.receiverPID !== report.processID, "Metadata cold reopen uses a genuinely new native process");
          await readMetadata(index);
        }
      }
      check(report.engineStarts === 0 && report.backendRequests === 0,
        "Metadata-only acceptance makes no translation-worker or plugin-backend request");
      check(Zotero.Prefs.get("sync.storage.enabled") === report.fileSyncEnabled,
        "Metadata acceptance leaves the existing native file-sync setting unchanged");
    } else if (config.phase === "install") {
      await install();
    } else if (config.phase !== "inspect") {
      check(bridge.runtime.version === config.expectedVersion && !!bridge.alignmentAssets,
        "Account acceptance uses the selected production reading-assets implementation");
      observeRuntime();
      if (config.phase === "produce") await produce();
      else {
        const index = await IOUtils.readJSON(config.producerIndex);
        if (config.phase === "receive") await receive(index);
        else if (config.phase === "download") await download(index);
        else if (config.phase === "reopen") {
          const previous = await IOUtils.readJSON(config.statePath);
          check(previous.receiverPID !== report.processID, "Account reading uses a genuinely new receiver process");
          await read(index);
        } else throw new Error("Unsupported account phase");
      }
    }
    report.stage = "complete";
    report.ok = true;
  } catch (error) {
    // Do not export raw native sync exceptions, which can contain URL credentials or account paths.
    report.error = {name: error.name || "Error", message: authorized ? String(error.message).replace(/https?:\/\/\S+/g, "[URL]")
      : "Account/profile authorization mismatch"};
    report.stage = "failed";
    Zotero.logError(error);
  } finally {
    if (authorized) {
      for (const native of readers) if (Zotero.Reader._readers.includes(native)) native.close();
      for (const action of restore.reverse()) action();
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      if (config.quit) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    } else await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }
})();
