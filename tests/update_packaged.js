/** Verify native update delivery and cold-restart preservation in an isolated Zotero profile. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, ChromeUtils,
          PAPERBRIDGE_TEST_ROOT, PAPERBRIDGE_UPDATE_TEST */
// Expose the async result so the isolated helper can retain early loading/isolation failures.
var PAPERBRIDGE_UPDATE_TEST_PROMISE = (async () => {
  // The external options file is the only harness input changed between process phases.
  const config = PAPERBRIDGE_UPDATE_TEST;
  // Use the production identity and exact public channels, never a test feed or latest release.
  const addonID = "paperbridge@local.dev";
  const repository = "MrYgoodenough/PaperBridge-zotero-plugin";
  // Only this disposable profile receives a synthetic login-manager credential.
  const fixtureKey = "paperbridge-isolated-update-fixture";
  // First extraction can be slow; downloading a bundled XPI gets a separate generous deadline.
  const startupTimeout = config.startupTimeoutMS || 180000;
  const updateTimeout = config.updateTimeoutMS || 900000;
  // Native readiness is polled without reissuing update checks or engine requests.
  const pollMilliseconds = 100;
  // Snapshot every supported nonsecret setting, including the inactive provider profile.
  const preferenceNames = ["profile", "model", "baseURL", "compatibleModel", "compatibleBaseURL",
    "compatibleJSON", "compatibleMaxTokens", "language", "pages", "pythonPath"];
  const report = { ok: false, phase: config.phase, automaticUpdateVerified: false, checks: [],
    processID: Services.appinfo.processID, translationPostAttempts: 0, engineJobCounts: [] };
  // Retain originals across the production bridge's restartless replacement.
  const guardedBridges = new Map();
  let isolated = false, ownsRun = false, saved, bridge, manager, offeredInstall;

  /** Normalize native paths without changing Windows case-insensitive comparisons. */
  function normalized(path) {
    return Zotero.isWin ? PathUtils.normalize(path).toLowerCase() : PathUtils.normalize(path);
  }

  /** Reject accidental profile/data mismatches before writing or installing anything. */
  function samePath(left, right) {
    return !!left && !!right && normalized(left) === normalized(right);
  }

  /** Keep test writes inside the caller's checkout, not a daily profile. */
  function insideRoot(path) {
    if (!path) return false;
    // Gecko normalization on Linux requires an existing path; the state file is not created yet.
    const root = normalized(PAPERBRIDGE_TEST_ROOT), parent = normalized(PathUtils.parent(path));
    const separator = Zotero.isWin ? "\\" : "/";
    return parent === root || parent.startsWith(root + separator);
  }

  /** Add only observations which actually passed in the running application. */
  function check(condition, message) {
    report.checks.push({ name: message, pass: !!condition });
    if (!condition) throw new Error(message);
  }

  /** Preserve evidence before native installation or process shutdown can intervene. */
  async function checkpoint(stage) {
    report.stage = stage;
    report.updatedAt = new Date().toISOString();
    if (saved && config.phase === "create") {
      Object.assign(saved, { stage, metadata: report.metadata, updateCheck: report.updateCheck,
        nativeInstall: report.nativeInstall, createError: report.error,
        translationPostAttempts: report.translationPostAttempts, engineJobCounts: report.engineJobCounts });
      await IOUtils.writeUTF8(config.statePath, JSON.stringify(saved, null, 2), { tmpPath: config.statePath + ".tmp" });
    }
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2), { tmpPath: config.reportPath + ".tmp" });
  }

  /** Bound a single native promise without pretending that timeout means success. */
  async function bounded(promise, message, milliseconds = startupTimeout) {
    const window = Zotero.getMainWindow();
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
      })]);
    } finally { window.clearTimeout(timer); }
  }

  /** Wait for a real predicate, including a replacement bridge after restartless install. */
  async function until(predicate, message) {
    const deadline = Date.now() + startupTimeout;
    do {
      const result = predicate();
      if (result) return result;
      await Zotero.Promise.delay(pollMilliseconds);
    } while (Date.now() < deadline);
    throw new Error(message);
  }

  /** Stream the completed XPI/PDF hash instead of loading a large bundled XPI into memory. */
  function sha256(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.normalize(path));
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    // nsIFileInputStream's read-only flag; permissions are unused for existing files.
    const readOnly = 0x01;
    // The documented nsICryptoHash sentinel hashes all available stream bytes.
    const entireStream = 0xffffffff;
    stream.init(file, readOnly, 0, 0);
    try {
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(hash.SHA256);
      hash.updateFromStream(stream, entireStream);
      return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } finally { stream.close(); }
  }

  /** Read packaged metadata through the same public native ZIP API as the existing harness. */
  function zipJSON(zip, name) {
    const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
    reader.init(zip.getInputStream(name));
    try { return JSON.parse(reader.read(reader.available())); }
    finally { reader.close(); }
  }

  /** Inspect a real archive for comparison only; this path is never passed to an installer. */
  function archive(path, platform) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.normalize(path));
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(file);
    try {
      const manifest = zipJSON(zip, "manifest.json");
      const runtime = zipJSON(zip, `runtime/${platform}/runtime.json`);
      const zotero = manifest.applications.zotero;
      return { path, sha256: sha256(path), version: manifest.version, addonID: zotero.id,
        updateURL: zotero.update_url, platform: runtime.platform, pythonMode: runtime.pythonMode,
        buildId: runtime.buildId, compatibility: { strict_min_version: zotero.strict_min_version,
          strict_max_version: zotero.strict_max_version } };
    } finally { zip.close(); }
  }

  /** Hash the actual installed archive, never substituting the download or selected local XPI. */
  function installedArchive(addon, platform) {
    const resource = addon.getResourceURI("manifest.json");
    if (resource.scheme !== "jar") throw new Error("Cannot attest an unpacked addon with a whole-XPI SHA-256");
    const path = resource.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file.path;
    if (!normalized(path).startsWith(normalized(PathUtils.join(config.expectedProfileDirectory, "extensions")) +
      (Zotero.isWin ? "\\" : "/"))) throw new Error("Installed addon is outside the isolated profile extensions");
    return archive(path, platform);
  }

  /** Forbid all translation POST entry points without replacing real health/status requests. */
  function guardBridge(current) {
    if (guardedBridges.has(current)) return;
    const original = current.request;
    /** Count forbidden submissions even when production code catches the rejection. */
    async function guarded(path, method = "GET", data) {
      if (method.toUpperCase() === "POST" && /^\/(jobs|translate)(?:[/?]|$)/.test(path)) {
        report.translationPostAttempts++;
        throw new Error("Automatic-update acceptance forbids translation submissions");
      }
      return original.call(this, path, method, data);
    }
    guardedBridges.set(current, { original, guarded });
    current.request = guarded;
  }

  /** Observe the bridge and lazy engine only after the production startup promise settles. */
  async function settled(version, previousBridge) {
    const current = await until(() => {
      const value = Zotero.PaperBridge;
      if (value) guardBridge(value);
      return value?.alive && value.runtime.version === version && value !== previousBridge && value;
    }, "Expected PaperBridge startup did not appear");
    await bounded(current.ready, "PaperBridge startup did not settle");
    const health = await bounded(current.request("/health"), "Native engine did not become ready");
    const marker = await IOUtils.readJSON(PathUtils.join(current.runtime.home, "installed.json"));
    check(Zotero.PaperBridge === current && current.alive && health.version === version && marker.version === version,
      "Production bridge and native engine settle at the expected version");
    const status = await bounded(current.request("/jobs"), "Native job-store observation did not finish");
    const jobs = Array.isArray(status) ? status : status.jobs;
    report.engineJobCounts.push({ version, count: Array.isArray(jobs) ? jobs.length : null });
    check(Array.isArray(jobs) && jobs.length === 0 && report.translationPostAttempts === 0,
      "The actual native engine has no translation jobs or observed submission attempts");
    return { bridge: current, health, marker };
  }

  /** Compare meaningful JSON fields independently of object property order. */
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical(value[key])]));
    return value;
  }

  /** Read only named public preferences, never credentials or runtime tokens. */
  function preferences() {
    return Object.fromEntries(preferenceNames.map(name => [name, bridge.pref(name)]));
  }

  /** Compare all native user-library items, including annotations and the trash. */
  async function librarySnapshot(libraryID) {
    await Zotero.Libraries.get(libraryID).waitForDataLoad("item");
    const items = await Zotero.Items.getAll(libraryID, false, true);
    const result = [];
    for (const item of items) {
      await item.loadAllData();
      result.push(item.toJSON());
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Snapshot actual native annotation content, not an assumed surviving key alone. */
  async function annotations(attachment) {
    const result = [];
    for (const item of attachment.getAnnotations()) {
      const json = await Zotero.Annotations.toJSON(item);
      result.push({ key: item.key, type: json.type, text: json.text || "", comment: json.comment || "",
        color: json.color, pageLabel: json.pageLabel || "", sortIndex: json.sortIndex,
        position: json.position, tags: json.tags || [] });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Make an explicitly synthetic one-page PDF without external fixture dependencies. */
  function fixturePDF(label) {
    const stream = `BT /F1 12 Tf 36 350 Td (${label}) Tj ET\n`;
    const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    return pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  }

  /** Seed real native records once; their synthetic content is not translation-quality evidence. */
  async function createFixture() {
    bridge.setPref("profile", "compatible");
    bridge.setPref("compatibleModel", "isolated-update-model");
    bridge.setPref("compatibleBaseURL", "http://127.0.0.1:9/v1");
    bridge.setPref("pages", "1");
    await bridge.saveKey(fixtureKey, "compatible");
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "PaperBridge synthetic native-update preservation fixture");
    await parent.saveTx();
    const attachments = [];
    for (const label of ["source", "translated"]) {
      const path = PathUtils.join(config.expectedDataDirectory, `paperbridge-update-${label}.pdf`);
      await IOUtils.writeUTF8(path, fixturePDF(`Synthetic update ${label}`));
      attachments.push(await Zotero.Attachments.importFromFile({ file: path, parentItemID: parent.id }));
    }
    const [source, translated] = attachments;
    await Zotero.Annotations.saveFromJSON(translated, { key: Zotero.DataObjectUtilities.generateKey(),
      type: "note", color: "#ffd400", comment: "Native note retained across a real addon update",
      pageLabel: "1", sortIndex: "00000|000000|00000", position: { pageIndex: 0, rects: [[36, 280, 58, 302]] } });
    const sourcePath = await source.getFilePathAsync();
    const record = await bridge.library.put(source, translated, bridge.configuration(),
      { state: "done", quality: { status: "unknown" } }, await IOUtils.stat(sourcePath));
    await bridge.library.settled();
    const fixture = { libraryID: source.libraryID, parentKey: parent.key, parentTitle: parent.getField("title"),
      sourceKey: source.key, translatedKey: translated.key, sourceHash: sha256(sourcePath),
      translatedHash: sha256(await translated.getFilePathAsync()), record: JSON.parse(JSON.stringify(record)),
      sourceAnnotations: await annotations(source), translatedAnnotations: await annotations(translated),
      configuration: bridge.configuration(), pythonPath: bridge.pref("pythonPath") || "",
      preferences: preferences(), items: await librarySnapshot(source.libraryID) };
    check(fixture.translatedAnnotations.length === 1 && fixture.sourceAnnotations.length === 0,
      "Baseline saves a real native annotation and translation ownership record");
    return fixture;
  }

  /** Consume only the install supplied by the native callback, once its check has finished. */
  async function findUpdate(addon) {
    report.updateCheck = { reason: "UPDATE_WHEN_USER_REQUESTED", events: [] };
    let candidate, finished = false;
    try {
      return await bounded(new Promise((resolve, reject) => {
        const listener = {
          /** Record the real offer without installing while the update check is still running. */
          onUpdateAvailable(queried, install) {
            if (finished) { install.cancel(); return; }
            report.updateCheck.events.push({ event: "onUpdateAvailable", addonID: queried.id,
              version: install.version, sourceURI: install.sourceURI?.spec });
            if (queried.id !== addonID || candidate) {
              try { install.cancel(); }
              finally { reject(new Error("Unexpected or duplicate native update offer")); }
              return;
            }
            candidate = install;
          },
          /** Preserve an empty-channel outcome rather than inventing an available update. */
          onNoUpdateAvailable(queried) {
            if (!finished) report.updateCheck.events.push({ event: "onNoUpdateAvailable", addonID: queried.id });
          },
          /** A callback status, not a resolved method call, establishes native check completion. */
          onUpdateFinished(queried, error) {
            if (finished) return;
            finished = true;
            report.updateCheck.events.push({ event: "onUpdateFinished", addonID: queried.id, error: error ?? null });
            if (queried.id !== addonID || error) reject(new Error(`Native update check failed (${error ?? "wrong addon"})`));
            else if (!candidate) reject(new Error("Native findUpdates offered no newer version; automatic update is not verified"));
            else { report.updateCheck.completed = true; resolve(candidate); }
          }
        };
        Promise.resolve(addon.findUpdates(listener, manager.UPDATE_WHEN_USER_REQUESTED)).catch(reject);
      }), "Native findUpdates did not finish");
    } catch (error) {
      finished = true;
      // A timed-out native check can otherwise deliver an unowned offer after report teardown.
      try { addon.cancelUpdate(); }
      catch (cancelError) { report.updateCheck.cancelError = String(cancelError); }
      try { candidate?.cancel(); }
      catch (cancelError) { report.updateCheck.cancelError = String(cancelError); }
      throw error;
    }
  }

  /** Drive the returned native installer and hash its download before any file move. */
  async function installUpdate(install, target) {
    report.nativeInstall = { sourceURI: install.sourceURI?.spec, events: [], result: "pending" };
    let ended = false, restartReported, listener;
    const addonListener = {
      /** Use the public restart indication rather than guessing from an old bridge reference. */
      onInstalling(addon, requiresRestart) {
        if (addon.id !== addonID) return;
        restartReported = requiresRestart;
        report.nativeInstall.events.push({ event: "onInstalling", version: addon.version, requiresRestart });
      }
    };
    const promise = new Promise((resolve, reject) => {
      /** Validate actual downloaded bytes synchronously while the native file is still available. */
      function downloaded(value) {
        if (!value.file) throw new Error("Native download exposes no file to hash");
        const observed = archive(value.file.path, target.platform);
        report.nativeInstall.download = observed;
        check(value.existingAddon?.id === addonID && value.existingAddon.version === config.baselineVersion && value.addon?.id === addonID
          && value.addon.version === target.version && observed.sha256 === target.sha256,
        "Native downloaded addon matches the selected target version and completed-XPI SHA-256");
      }
      /** Record native failure/cancellation without treating an event timeout as completion. */
      function failed(value, event) {
        report.nativeInstall.result = event;
        report.nativeInstall.events.push({ event, state: value.state, error: value.error });
        reject(new Error(`Native addon install ${event} (${value.error ?? "no error code"})`));
      }
      listener = {
        /** Prevent installation if the independently observed downloaded package differs. */
        onDownloadEnded(value) {
          report.nativeInstall.events.push({ event: "onDownloadEnded", state: value.state });
          try { downloaded(value); }
          catch (error) { reject(error); return false; }
          return undefined;
        },
        /** Preserve the native staged/active result and restart requirement for the next process. */
        onInstallEnded(value, addon) {
          try {
            const pending = (addon?.pendingOperations || 0) | (value.existingAddon?.pendingOperations || 0);
            if (addon?.id !== addonID || addon.version !== target.version || value.state !== manager.STATE_INSTALLED
              || value.error || !report.nativeInstall.download) {
              throw new Error("Native install ended without the verified target addon");
            }
            ended = true;
            Object.assign(report.nativeInstall, { result: "installed", state: value.state, error: value.error,
              version: addon.version, pendingOperations: pending,
              operationsRequiringRestart: addon.operationsRequiringRestart,
              restartReported: restartReported ?? null,
              requiresRestart: restartReported === true || !!(pending & (manager.PENDING_INSTALL | manager.PENDING_UPGRADE)) });
            report.nativeInstall.events.push({ event: "onInstallEnded", version: addon.version, state: value.state });
            resolve();
          } catch (error) {
            // AddonManager consumes listener exceptions; reject explicitly rather than hanging.
            report.nativeInstall.result = "unverified-install-ended";
            reject(error);
          }
        },
        /** Keep a native postponed install distinct from an installed addon. */
        onInstallPostponed(value) { failed(value, "onInstallPostponed"); },
        /** Keep native download errors visible to the caller. */
        onDownloadFailed(value) { failed(value, "onDownloadFailed"); },
        /** Keep native cancellation distinct from a completed download. */
        onDownloadCancelled(value) { failed(value, "onDownloadCancelled"); },
        /** Keep native install errors visible to the caller. */
        onInstallFailed(value) { failed(value, "onInstallFailed"); },
        /** Keep native install cancellation distinct from a completed installation. */
        onInstallCancelled(value) { failed(value, "onInstallCancelled"); }
      };
      install.addListener(listener);
      manager.addAddonListener(addonListener);
      try {
        if (install.state === manager.STATE_DOWNLOADED) downloaded(install);
        Promise.resolve(install.install()).catch(reject);
      } catch (error) { reject(error); }
    });
    try { await bounded(promise, "Native addon download/install did not finish", updateTimeout); }
    finally {
      install.removeListener(listener);
      manager.removeAddonListener(addonListener);
      if (!ended) {
        try { install.cancel(); }
        catch (error) { report.nativeInstall.cancelError = String(error); }
      }
    }
  }

  try {
    isolated = config.isolated === true
      && samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      && samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory)
      && [config.expectedProfileDirectory, config.expectedDataDirectory, config.statePath, config.reportPath].every(insideRoot);
    if (!isolated) throw new Error("Refusing native update checks outside the explicit isolated profile/data/root");
    // This test-only registry survives production-addon hot restart, but never crosses process phases.
    const runKey = PathUtils.join(normalized(PathUtils.parent(config.statePath)), PathUtils.filename(config.statePath))
      + ":" + config.phase;
    Zotero.paperbridgeUpdateTestRuns ||= new Set();
    if (Zotero.paperbridgeUpdateTestRuns.has(runKey)) return;
    Zotero.paperbridgeUpdateTestRuns.add(runKey);
    ownsRun = true;
    check(["create", "reopen"].includes(config.phase) && config.baselineVersion === "0.3.2"
      && config.expectedVersion === "0.3.3" && /^[a-f0-9]{64}$/.test(config.baselineXpiSha256)
      && /^[a-f0-9]{64}$/.test(config.expectedXpiSha256),
    "The isolated test requires explicit accepted 0.3.2 and target 0.3.3 XPI hashes");
    ({ AddonManager: manager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"));
    await bounded(Zotero.initializationPromise, "Zotero initialization did not settle");
    bridge = await until(() => Zotero.PaperBridge, "Baseline PaperBridge did not start");
    guardBridge(bridge);
    await bounded(bridge.ready, "Initial PaperBridge startup did not settle");
    const platform = bridge.runtime.platform().id;
    check(["linux-x64", "windows-x64"].includes(platform), "This native update check uses Linux or Windows only");
    report.process = { pid: Services.appinfo.processID, started: Services.startup.getStartupInfo().process.toISOString() };
    report.processID = report.process.pid;
    report.zoteroVersion = Zotero.version;
    const addon = await manager.getAddonByID(addonID);
    if (!addon) throw new Error("The baseline/updated production addon is not installed");
    report.installed = installedArchive(addon, platform);
    // Derive both public URLs from the installed channel in each process, not saved overrides.
    const suffix = report.installed.pythonMode === "local" ? "-local-python" : "";
    const updateURL = `https://raw.githubusercontent.com/${repository}/master/updates/${platform}${suffix}.json`;
    const updateLink = `https://github.com/${repository}/releases/download/v${config.expectedVersion}/paperbridge-${config.expectedVersion}-${platform}${suffix}.xpi`;
    check(addon.updateURL === updateURL && report.installed.updateURL === updateURL,
      "Native AddonManager and the installed archive use the exact public platform/Python channel");
    if (config.phase === "create") {
      check(!await IOUtils.exists(config.statePath), "Create has no previous update attempt; never trigger installation twice");
      const baseline = report.installed;
      const target = archive(config.expectedXpiPath, platform);
      report.baseline = baseline;
      report.target = target;
      check(addon.isActive && addon.version === config.baselineVersion && baseline.version === config.baselineVersion
        && baseline.sha256 === config.baselineXpiSha256 && baseline.addonID === addonID && baseline.updateURL === updateURL,
      "Actual baseline version/hash and real platform update URL match; example.invalid is never accepted");
      check(target.addonID === addonID && target.version === config.expectedVersion && target.sha256 === config.expectedXpiSha256
        && target.updateURL === updateURL && target.platform === platform && baseline.platform === platform
        && ["local", "bundled"].includes(baseline.pythonMode) && target.pythonMode === baseline.pythonMode
        && target.pythonMode === (config.pythonPath ? "local" : "bundled"),
      "Selected comparison XPI matches the target version/hash and the baseline platform/Python channel");
      const initial = await settled(config.baselineVersion);
      bridge = initial.bridge;
      report.baselineEngine = { health: initial.health, marker: initial.marker };
      check(initial.marker.buildId === baseline.buildId && initial.marker.pythonMode === baseline.pythonMode,
        "The baseline native engine uses the accepted XPI's actual build and Python mode");
      saved = { schema: 1, process: report.process, profileDirectory: config.expectedProfileDirectory,
        dataDirectory: config.expectedDataDirectory, baseline, target, updateLink, fixture: await createFixture() };
      await checkpoint("baseline-preserved-before-native-update");
      const window = Zotero.getMainWindow();
      const response = await bounded(window.fetch(baseline.updateURL, { credentials: "omit" }), "Public update metadata did not respond");
      report.metadata = { requestedURL: baseline.updateURL, responseURL: response.url, status: response.status };
      check(response.ok && response.url === updateURL, "The original exact production update URL returns public metadata");
      report.metadata.document = await bounded(response.json(), "Public update metadata did not decode");
      const updates = report.metadata.document.addons?.[addonID]?.updates;
      const entry = Array.isArray(updates) && updates.find(value => value.version === target.version);
      check(entry?.update_link === updateLink && entry?.update_hash === "sha256:" + target.sha256,
        "Public metadata contains the exact tagged target XPI and completed-XPI SHA-256");
      report.metadata.selected = entry;
      await checkpoint("public-metadata-observed");
      const install = offeredInstall = await findUpdate(addon);
      await checkpoint("native-update-check-finished");
      check(install.version === target.version && install.sourceURI?.spec === entry.update_link,
        "Native findUpdates offers the exact published target from the original addon channel");
      await checkpoint("native-install-starting");
      await installUpdate(install, target);
      await checkpoint("native-install-ended");
      if (!report.nativeInstall.requiresRestart) {
        const active = await settled(target.version, bridge);
        bridge = active.bridge;
        report.activeEngine = { health: active.health, marker: active.marker };
        const currentAddon = await manager.getAddonByID(addonID);
        report.installedAfterUpdate = installedArchive(currentAddon, platform);
        report.installed = report.installedAfterUpdate;
        check(report.installedAfterUpdate.sha256 === target.sha256 && active.marker.buildId === target.buildId,
          "Restartless native install activates the actual target XPI and engine build");
      }
      check(report.translationPostAttempts === 0, "Native update completes without translation submissions");
      report.coldRestartStillRequiredForAcceptance = true;
      report.ok = true;
      await checkpoint("installed-awaiting-cold-restart-verification");
    } else {
      saved = await IOUtils.readJSON(config.statePath);
      report.baseline = saved.baseline;
      report.target = saved.target;
      report.metadata = saved.metadata;
      report.updateCheck = saved.updateCheck;
      report.nativeInstall = saved.nativeInstall;
      report.createError = saved.createError;
      check(saved.schema === 1 && saved.baseline.version === config.baselineVersion
        && saved.baseline.sha256 === config.baselineXpiSha256 && saved.target.version === config.expectedVersion
        && saved.target.sha256 === config.expectedXpiSha256 && saved.baseline.updateURL === updateURL
        && saved.updateLink === updateLink && saved.target.updateURL === updateURL
        && samePath(saved.profileDirectory, config.expectedProfileDirectory)
        && samePath(saved.dataDirectory, config.expectedDataDirectory)
        && saved.stage === "complete" && !saved.createError && saved.updateCheck?.completed === true
        && saved.metadata?.requestedURL === updateURL && saved.metadata.responseURL === updateURL
        && saved.metadata.selected?.version === config.expectedVersion
        && saved.metadata.selected?.update_link === updateLink
        && saved.metadata.selected?.update_hash === "sha256:" + saved.target.sha256
        && saved.nativeInstall?.result === "installed" && saved.nativeInstall.sourceURI === updateLink
        && saved.nativeInstall.download?.sha256 === saved.target.sha256,
      "Reopen has retained evidence of the actual native update, not a manually replaced addon");
      check(report.process.pid !== saved.process.pid && report.process.started !== saved.process.started,
        "Reopen has a different native Zotero PID and process startup time");
      check(saved.translationPostAttempts === 0 && saved.engineJobCounts?.length > 0
        && saved.engineJobCounts.every(value => value.count === 0),
      "The retained native-update phase had no observed translation submissions or engine jobs");
      const active = await settled(saved.target.version);
      bridge = active.bridge;
      report.activeEngine = { health: active.health, marker: active.marker };
      check(addon.isActive && addon.version === saved.target.version && report.installed.sha256 === saved.target.sha256
        && report.installed.addonID === addonID && report.installed.version === saved.target.version
        && report.installed.platform === platform && saved.target.platform === platform
        && report.installed.updateURL === saved.baseline.updateURL && report.installed.pythonMode === saved.target.pythonMode
        && active.marker.buildId === saved.target.buildId && active.marker.pythonMode === saved.target.pythonMode,
      "Cold restart loads the actual updated XPI hash, platform channel and native engine configuration");
      const fixture = saved.fixture;
      const parent = await Zotero.Items.getByLibraryAndKeyAsync(fixture.libraryID, fixture.parentKey);
      const source = await Zotero.Items.getByLibraryAndKeyAsync(fixture.libraryID, fixture.sourceKey);
      const translated = await Zotero.Items.getByLibraryAndKeyAsync(fixture.libraryID, fixture.translatedKey);
      check(parent && !parent.deleted && parent.getField("title") === fixture.parentTitle
        && source?.isPDFAttachment() && !source.deleted && translated?.isPDFAttachment() && !translated.deleted
        && source.parentKey === parent.key && translated.parentKey === parent.key
        && sha256(await source.getFilePathAsync()) === fixture.sourceHash
        && sha256(await translated.getFilePathAsync()) === fixture.translatedHash,
      "Original native library parent and both PDF attachment bytes survive the update");
      const record = bridge.library.records.find(value => value.recordID === fixture.record.recordID);
      check(JSON.stringify(canonical(record)) === JSON.stringify(canonical(fixture.record))
        && JSON.stringify(canonical(await annotations(source))) === JSON.stringify(canonical(fixture.sourceAnnotations))
        && JSON.stringify(canonical(await annotations(translated))) === JSON.stringify(canonical(fixture.translatedAnnotations)),
      "Translation ownership and full native annotation content remain unchanged after cold restart");
      check(JSON.stringify(canonical(bridge.configuration())) === JSON.stringify(canonical(fixture.configuration))
        && JSON.stringify(canonical(preferences())) === JSON.stringify(canonical(fixture.preferences))
        && (bridge.pref("pythonPath") || "") === fixture.pythonPath && fixture.pythonPath === (config.pythonPath || "")
        && bridge.getKey("compatible") === fixtureKey,
      "Provider/Python settings and the synthetic native login-manager credential survive the update");
      check(JSON.stringify(canonical(await librarySnapshot(fixture.libraryID))) === JSON.stringify(canonical(fixture.items)),
        "All original native library items, annotation items and deleted items are unchanged");
      report.preservedFixture = { parentKey: parent.key, sourceKey: source.key, translatedKey: translated.key,
        recordID: record.recordID, translatedAnnotations: (await annotations(translated)).length,
        configuration: bridge.configuration(), pythonPath: bridge.pref("pythonPath") || "" };
      check(report.translationPostAttempts === 0, "Cold-restart verification submits no translation calls");
      report.coldRestartStillRequiredForAcceptance = false;
      report.automaticUpdateVerified = true;
      report.ok = true;
    }
  } catch (error) {
    report.ok = false;
    report.automaticUpdateVerified = false;
    report.error = String(error);
    report.stack = error.stack;
    Zotero.logError(error);
    if (!isolated || !ownsRun) throw error;
  } finally {
    if (isolated && ownsRun) {
      // An offered download must not remain owned by nobody after metadata validation fails.
      if (offeredInstall && [manager.STATE_AVAILABLE, manager.STATE_DOWNLOADING,
        manager.STATE_DOWNLOADED, manager.STATE_POSTPONED].includes(offeredInstall.state)) {
        try { offeredInstall.cancel(); }
        catch (error) { report.offerCancelError = String(error); }
      }
      report.quitRequestedByHarness = config.quit !== false;
      try { await checkpoint(report.ok ? "complete" : "failed"); }
      finally {
        for (const [current, { original, guarded }] of guardedBridges) {
          if (current.request === guarded) current.request = original;
        }
        if (config.quit !== false) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
      }
    }
  }
})();
