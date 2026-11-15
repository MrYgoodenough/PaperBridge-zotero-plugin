/**
 * Inert native WebDAV export/download helpers for disposable reading-asset profiles.
 * Uses Zotero 10.0.8 storage APIs only; loading this file performs no native work.
 */

/** Install the test-only namespace into the caller's loadSubScript scope. */
var ReadingAssetWebDAV = (() => {
  // Match the owned manifest accepted by the local fixture server.
  const fixtureKind = "zotero-webdav-acceptance-v1";
  // Native attachment keys are eight uppercase ASCII letters/digits.
  const keyPattern = /^[A-Z0-9]{8}$/;
  // Native attachmentHash and WebDAV .prop use the primary file's lowercase MD5.
  const md5Pattern = /^[0-9a-f]{32}$/;
  // The upstream .prop parser accepts at most thirteen millisecond timestamp digits.
  const maximumMtime = 9_999_999_999_999;
  // The isolated Linux sidecar uses HTTP and an explicit, non-production port.
  const defaultServer = "192.168.112.101:8769";

  /** Reject invalid producer inputs without leaking fixture credentials. */
  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }

  /** Keep Basic credentials disposable, printable, and compatible with the sidecar. */
  function validCredentials(username, password) {
    return typeof username === "string" && typeof password === "string"
      && /^[\x20-\x7e]+$/.test(username) && /^[\x20-\x7e]+$/.test(password)
      && !username.includes(":");
  }

  /** Validate the metadata needed to prove exact native downloads, including size. */
  function validAttachment(entry) {
    return entry && typeof entry.key === "string" && keyPattern.test(entry.key)
      && typeof entry.filename === "string" && entry.filename.length > 0
      && !/[\/\\\0]/.test(entry.filename) && !entry.filename.startsWith(".zotero")
      && typeof entry.md5 === "string" && md5Pattern.test(entry.md5)
      && Number.isSafeInteger(entry.mtime) && entry.mtime > 0 && entry.mtime <= maximumMtime
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0;
  }

  /** Export exact-key attachments with the same native ZIP helper used by WebDAV upload. */
  async function exportProducer({ exportDir, keys, username, password }) {
    requireValue(typeof exportDir === "string" && exportDir.length > 0, "WebDAV export directory is required");
    requireValue(Array.isArray(keys) && keys.length > 0, "WebDAV export requires explicit attachment keys");
    requireValue(validCredentials(username, password), "WebDAV export requires fixture-only ASCII credentials");
    const prepared = [];
    const seen = new Set();
    for (const key of keys) {
      requireValue(typeof key === "string" && keyPattern.test(key) && !seen.has(key),
        "WebDAV export requires unique native attachment keys");
      seen.add(key);
      const item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
      requireValue(item && item.key === key && item.isStoredFileAttachment(),
        `WebDAV producer stored attachment is missing: ${key}`);
      const path = await item.getFilePathAsync();
      requireValue(path, `WebDAV producer attachment file is missing: ${key}`);
      prepared.push({ item, path });
    }
    // Native zipDirectory truncates its output, so never reuse an existing export directory.
    requireValue(!(await IOUtils.exists(exportDir)), "WebDAV export directory must be new");
    await Zotero.File.createDirectoryIfMissingAsync(exportDir);
    const fixture = { kind: fixtureKind, username, password, attachments: [] };
    for (const { item, path } of prepared) {
      const archivePath = PathUtils.join(exportDir, `${item.key}.zip`);
      const zipResult = await Zotero.File.zipDirectory(
        Zotero.Attachments.getStorageDirectory(item).path, archivePath,
      );
      requireValue(zipResult === true && await IOUtils.exists(archivePath),
        `Native WebDAV ZIP was not created: ${item.key}`);
      const entry = {
        key: item.key,
        libraryID: item.libraryID,
        filename: item.attachmentFilename,
        mtime: await item.attachmentModificationTime,
        md5: await item.attachmentHash,
        bytes: (await IOUtils.stat(path)).size,
        archiveBytes: (await IOUtils.stat(archivePath)).size,
        zipResult,
      };
      requireValue(validAttachment(entry) && entry.archiveBytes > 0,
        `Native WebDAV producer metadata is invalid: ${item.key}`);
      fixture.attachments.push(entry);
    }
    const fixturePath = PathUtils.join(exportDir, "fixture.json");
    await Zotero.File.putContentsAsync(fixturePath, JSON.stringify(fixture, null, 2));
    // Only the on-disk, test-owned manifest contains credentials, never this summary.
    return { exportDir, fixturePath, keys: keys.slice(), attachments: fixture.attachments };
  }

  /** Download exact-key missing files with native Request.start, then verify stored bytes. */
  async function downloadReceiver({ fixturePath, server = defaultServer, check }) {
    requireValue(typeof check === "function", "WebDAV receiver requires the harness check function");
    let failedCheck = false;
    let stage = "fixture-metadata";
    let currentKey = null;
    const receipts = [];

    /** Record failures even when the supplied check callback only collects results. */
    function checked(condition, name, detail = {}) {
      const pass = !!condition;
      if (!pass) failedCheck = true;
      check(pass, name, detail);
      if (!pass) throw new Error(name);
    }

    try {
      checked(typeof fixturePath === "string" && fixturePath.length > 0, "WebDAV fixture path is supplied");
      // Native _init appends zotero/; reject schemes, paths and URI credentials here.
      checked(typeof server === "string"
        && /^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$/.test(server)
        && Number(server.slice(server.lastIndexOf(":") + 1)) > 0
        && Number(server.slice(server.lastIndexOf(":") + 1)) <= 65535,
      "WebDAV server is an explicit credential-free host:port");
      const fixture = JSON.parse(await Zotero.File.getContentsAsync(fixturePath));
      checked(fixture && fixture.kind === fixtureKind, "WebDAV fixture has the owned test marker");
      checked(validCredentials(fixture.username, fixture.password), "WebDAV fixture has disposable ASCII credentials");
      checked(Array.isArray(fixture.attachments) && fixture.attachments.length > 0,
        "WebDAV fixture contains explicit attachments");
      const libraryID = Zotero.Libraries.userLibraryID;
      const prepared = [];
      const seen = new Set();
      for (const expected of fixture.attachments) {
        currentKey = null;
        checked(validAttachment(expected), "WebDAV attachment has key/filename/mtime/MD5/size metadata");
        currentKey = expected.key;
        checked(!seen.has(currentKey), "WebDAV fixture attachment keys are unique", { key: currentKey });
        seen.add(currentKey);
        const item = Zotero.Items.getByLibraryAndKey(libraryID, currentKey);
        checked(item && item.key === currentKey && item.libraryID === libraryID
          && (expected.libraryID === undefined || expected.libraryID === item.libraryID),
        "WebDAV receiver preserves exact metadata key/library", { key: currentKey, libraryID });
        checked(item.isStoredFileAttachment(), "WebDAV receiver attachment is natively stored", { key: currentKey });
        checked(item.attachmentFilename === expected.filename,
          "WebDAV receiver preserves exact storage filename", { key: currentKey });
        const storageDir = Zotero.Attachments.getStorageDirectory(item).path;
        const expectedPath = PathUtils.join(storageDir, expected.filename);
        checked(PathUtils.filename(storageDir) === currentKey && item.getFilePath() === expectedPath,
          "WebDAV receiver targets its actual native stored-key directory", { key: currentKey });
        const missingBefore = !(await item.getFilePathAsync());
        checked(missingBefore, "WebDAV receiver attachment is missing before download", { key: currentKey });
        prepared.push({ item, expected, expectedPath, missingBefore });
      }

      stage = "mark-download-required";
      for (const { item } of prepared) {
        currentKey = item.key;
        item.attachmentSyncState = "to_download";
        await item.saveTx({ skipAll: true });
        checked(item.attachmentSyncState === Zotero.Sync.Storage.Local.SYNC_STATE_TO_DOWNLOAD,
          "WebDAV receiver native metadata is download-required", { key: currentKey });
      }

      stage = "configure-fixture";
      currentKey = null;
      const prefs = {
        "sync.autoSync": false,
        "sync.storage.enabled": true,
        "sync.storage.protocol": "webdav",
        "sync.storage.scheme": "http",
        "sync.storage.url": server,
        "sync.storage.username": fixture.username,
        "sync.storage.verified": false,
        "sync.storage.downloadMode.personal": "on-demand",
        "sync.storage.groups.enabled": false,
      };
      for (const [name, value] of Object.entries(prefs)) Zotero.Prefs.set(name, value);
      const controller = new Zotero.Sync.Storage.Mode.WebDAV({});
      await controller.setPassword(fixture.password);
      stage = "verify-native-server";
      await controller.checkServer();
      checked(controller.verified, "WebDAV native verification actually succeeds");
      stage = "cache-native-credentials";
      await controller.cacheCredentials();

      for (const { item, expected, expectedPath, missingBefore } of prepared) {
        currentKey = expected.key;
        stage = "native-request-download";
        // A same-mtime shortcut can report localChanges without GET; require absence at start too.
        const missingAtRequest = !(await item.getFilePathAsync());
        checked(missingAtRequest, "WebDAV attachment is still missing at native Request.start", { key: currentKey });
        const request = new Zotero.Sync.Storage.Request({
          type: "download",
          libraryID: item.libraryID,
          name: item.libraryKey,
          /** Run the upstream controller only after Request.start marks it running. */
          onStart(request) {
            return controller.downloadFile(request);
          },
        });
        const result = await request.start();
        checked(result && result.localChanges === true,
          "WebDAV native Request.start reports an actual local download change", { key: currentKey });

        stage = "verify-native-stored-file";
        const path = await item.getFilePathAsync();
        const size = path ? (await IOUtils.stat(path)).size : null;
        const md5 = path ? await item.attachmentHash : null;
        const exactKey = item.key === expected.key && item.libraryID === libraryID
          && (expected.libraryID === undefined || item.libraryID === expected.libraryID);
        const exactFilename = item.attachmentFilename === expected.filename;
        const exactStoredPath = path === expectedPath;
        const inSync = item.attachmentSyncState === Zotero.Sync.Storage.Local.SYNC_STATE_IN_SYNC;
        checked(exactKey && exactFilename && exactStoredPath,
          "WebDAV native extraction preserves exact key/storage filename/path", { key: currentKey });
        checked(md5 === expected.md5 && size === expected.bytes,
          "WebDAV downloaded primary MD5 and size match the producer", { key: currentKey, md5, size });
        checked(inSync, "WebDAV downloaded native attachment is in_sync", { key: currentKey });
        const receipt = {
          key: item.key,
          libraryID: item.libraryID,
          requestName: request.name,
          api: "WebDAV.downloadFile via Storage.Request.start",
          missingBefore,
          missingAtRequest,
          exactKey,
          exactFilename,
          exactStoredPath,
          primaryMD5: md5,
          size,
          inSync,
          nativeResult: {
            localChanges: result.localChanges,
            remoteChanges: result.remoteChanges,
            syncRequired: result.syncRequired,
          },
          progressBytes: request.progress,
          progressMax: request.progressMax,
        };
        checked(true, "WebDAV native file-download receipt", receipt);
        receipts.push(receipt);
      }
      return receipts;
    } catch (error) {
      // Upstream errors can contain credential-bearing URIs; report only stage/key.
      if (!failedCheck) check(false, "WebDAV receiver native action failed", { stage, key: currentKey });
      throw new Error(`WebDAV receiver failed at ${stage}${currentKey ? ` (${currentKey})` : ""}`);
    }
  }

  return { exportProducer, downloadReceiver };
})();
