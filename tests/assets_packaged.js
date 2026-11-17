/** Combined native asset, line-highlight and cleanup acceptance in isolated libraries. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils, PAPERBRIDGE_TEST_ROOT, PAPERBRIDGE_ASSETS_TEST */
// The helper awaits the actual completed run, including normal application shutdown.
var PAPERBRIDGE_ASSETS_TEST_PROMISE = (async () => {
  // External configuration owns the disposable profile and its evidence paths.
  const config = PAPERBRIDGE_ASSETS_TEST;
  // First installation and Windows antivirus scans may delay native page rendering.
  const waitMilliseconds = 60000, pollMilliseconds = 100;
  // PDF.js FINISHED supplies the actual page viewport, not an unrendered placeholder.
  const renderingFinished = 3;
  // Gecko's native mouse input source and pressed-primary-button mask.
  const mouseInputSource = 1, primaryMouseButtons = 1;
  // Reveal the full paragraph in screenshots without changing the mapping or rendered text.
  const screenshotScrollMargin = 90;
  const report = {ok:false, phase:config.phase, processID:Services.appinfo.processID,
    checks:[], errors:[], engineStarts:0, backendRequests:0, nativeInput:[]};
  let isolated = false, bridge, split, originalEnsure, originalRequest;

  /** Compare actual native paths without depending on Windows case or separators. */
  function samePath(left, right) {
    const normalize = value => Zotero.isWin ? PathUtils.normalize(value).toLowerCase() : PathUtils.normalize(value);
    return left && right && normalize(left) === normalize(right);
  }

  /** Preserve each true failure instead of making an incomplete phase look successful. */
  function check(condition, name, detail = {}) {
    report.checks.push({name, pass:!!condition, detail});
    if (!condition) throw new Error(name + ": " + JSON.stringify(detail));
  }

  /** Keep long native operations visible to the external driver. */
  async function checkpoint(stage) {
    report.stage = stage;
    await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
  }

  /** Load an inert native test helper into this isolated caller's privileged scope. */
  function nativeHelper(filename) {
    const scope = {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils};
    Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(
      PathUtils.join(PAPERBRIDGE_TEST_ROOT, "tests", filename))).spec, scope);
    return scope;
  }

  /** Await actual application state; timeouts remain failed checks. */
  async function until(predicate, message) {
    const deadline = Date.now() + waitMilliseconds;
    do {
      const value = await predicate();
      if (value) return value;
      await Zotero.Promise.delay(pollMilliseconds);
    } while (Date.now() < deadline);
    throw new Error(typeof message === "function" ? message() : message);
  }

  /** Require one translated annotation owner and expose its actual pending writes. */
  function annotationWrites(split) {
    const native = split.translationReader;
    const legacy = split.annotations;
    check(!!native !== !!legacy, "Split has exactly one translated annotation owner");
    if (native) {
      check(native.itemID === split.translated.id && typeof split.pendingWrites?.[Symbol.iterator] === "function",
        "Native annotation owner and write queue belong to the translated attachment");
      return Promise.all(split.pendingWrites);
    }
    check(typeof legacy.pending?.then === "function", "Legacy annotation owner exposes its persistence queue");
    return legacy.pending;
  }

  /** Hash native file bytes using the production engine-independent implementation. */
  function hashFile(path) { return bridge.alignmentAssets.constructor.hashFile(path); }

  /** Install with AddonManager; copying an XPI into the prepared profile is not acceptance. */
  async function installCandidate(manager) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.normalize(config.expectedXpiPath));
    const installation = await manager.getInstallForFile(file);
    await new Promise((resolve, reject) => {
      installation.addListener({
        /** Accept only the native install-completed event. */
        onInstallEnded() { resolve(); },
        /** Native failure is never treated as a successful preparation copy. */
        onInstallFailed(value) { reject(new Error("Native install failed: " + value.error)); },
        /** Preserve cancellation as an incomplete installation. */
        onInstallCancelled() { reject(new Error("Native installation cancelled")); },
      });
      installation.install();
    });
    await until(() => Zotero.PaperBridge && Zotero.PaperBridge !== bridge, "Candidate addon did not restart");
    bridge = Zotero.PaperBridge;
    await bridge.ready;
    check(true, "Candidate installed through native AddonManager");
  }

  /** Send trusted Gecko mouse input without constructing a PDF text selection. */
  function mouse(index, type, point) {
    const main = Zotero.getMainWindow();
    main.focus(); Services.focus.activeWindow = main;
    const frame = Components.utils.unwaiveXrays(split.frames[index]);
    frame.focus();
    // An unpressed mousemove must not inherit Gecko's default buttons=1.
    (frame.windowUtils || frame.docShell.domWindowUtils).sendMouseEvent(type, point[0], point[1], 0,
      type === "mousemove" ? 0 : 1, 0, false, 0, mouseInputSource, true, false,
      type === "mousedown" ? primaryMouseButtons : 0);
  }

  /** Wait for the requested native page and its real text layer. */
  async function page(index, number, rect = null) {
    const viewer = split.apps[index].pdfViewer;
    viewer.currentPageNumber = number + 1;
    viewer.currentScaleValue = "page-fit";
    const rendered = await until(() => {
      const value = viewer.getPageView(number);
      return value?.renderingState === renderingFinished && value.div.querySelector(".textLayer span") && value;
    }, "Native PDF text layer did not render");
    if (rect) {
      const sync = split.sync;
      split.sync = false;
      try {
        viewer.scrollPageIntoView(Components.utils.cloneInto({pageNumber:number + 1,
          destArray:[null, {name:"XYZ"}, rect[0], rect[3], null], allowNegativeOffset:true}, split.frames[index]));
        await until(() => {
          const point = screenPoint(rendered, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]);
          return point[0] >= 0 && point[1] >= 0 && point[0] < split.frames[index].innerWidth
            && point[1] < split.frames[index].innerHeight;
        }, "Native line is outside the visible reader after scroll");
        await Zotero.Promise.delay(pollMilliseconds);
      } finally { split.sync = sync; }
    }
    return rendered;
  }

  /** Convert PDF-user points through each page's own border-aware native viewport. */
  function screenPoint(view, point) {
    const native = view.viewport.convertToViewportPoint(point[0], point[1]), box = view.div.getBoundingClientRect();
    return [box.left + (native[0] * view.div.clientWidth / view.viewport.width + view.div.clientLeft) * box.width / view.div.offsetWidth,
      box.top + (native[1] * view.div.clientHeight / view.viewport.height + view.div.clientTop) * box.height / view.div.offsetHeight];
  }

  /** Capture the actual PDF reader and its CSS overlay for visual QA, not a synthetic redraw. */
  async function screenshot() {
    const frame = Components.utils.unwaiveXrays(split.frames[1]);
    const canvas = Zotero.getMainWindow().document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = frame.innerWidth; canvas.height = frame.innerHeight;
    canvas.getContext("2d").drawWindow(frame, 0, 0, canvas.width, canvas.height, "white");
    const binary = frame.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = config.reportPath.replace(/\.json$/, "-line-quads.png");
    await IOUtils.write(path, Uint8Array.from(binary, char => char.charCodeAt(0)));
    report.screenshot = path;
  }

  /** Check bilateral trusted clicks, line polygons, blank-area misses and CSS text hover together. */
  async function interactions() {
    const mapping = await until(() => split.alignment.mapping, () => split.alignment.status.textContent);
    check(mapping.schema_version === 2 && mapping.generator_version === "fragment-trace-2", "Native reader loads production schema-two line geometry");
    const unit = mapping.units.find(value => value.source.quads.length > 1 && value.target.quads.length > 1);
    check(!!unit, "A real paragraph has multiple verified lines on both PDFs");
    for (const [index, side] of ["source", "target"].entries()) {
      const rect = unit[side].rects[0], view = await page(index, unit[side].page, rect);
      const point = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], css = screenPoint(view, point), events = [];
      const capture = event => events.push({type:event.type, trusted:event.isTrusted,
        x:event.clientX, y:event.clientY, page:event.target?.closest?.(".page")?.dataset.pageNumber});
      const types = ["pointerdown", "mousedown", "pointerup", "mouseup"];
      for (const type of types) split.frames[index].document.addEventListener(type, capture, true, true);
      mouse(index, "mousedown", css); mouse(index, "mouseup", css);
      await Zotero.Promise.delay(pollMilliseconds);
      for (const type of types) split.frames[index].document.removeEventListener(type, capture, true);
      const detail = {side, events, css, frameWidth:split.frames[index].innerWidth, frameHeight:split.frames[index].innerHeight,
        selectedTab:Zotero.getMainWindow().Zotero_Tabs.selectedID, readerTab:split.reader.tabID,
        readerItemID:split.reader.itemID, sourceItemID:split.source.id};
      report.nativeInput.push(detail);
      check(events.some(event => event.type === "pointerup" && event.trusted), side + ": trusted native pointer release is observed", detail);
      (index ? split.alignment.button : split.alignment.targetButton).click();
      const overlay = await until(() => split.alignment.highlight, side + ": counterpart highlight absent");
      check(split.alignment.highlightIndex === 1 - index && overlay.children.length === unit[index ? "source" : "target"].quads.length,
        side + ": explicit navigation paints one polygon per verified line", {regions:overlay.children.length});
      check([...overlay.children].every(mark => mark.style.clipPath.startsWith("polygon(")), side + ": real DOM uses line polygons");
      if (index === 0) {
        // A real scroll reveals the paragraph's first line above the navigation anchor.
        split.apps[1].pdfViewer.container.scrollTop = Math.max(0, split.apps[1].pdfViewer.container.scrollTop - screenshotScrollMargin);
        await Zotero.Promise.delay(pollMilliseconds);
        await screenshot();
      }
      const rects = unit[side].rects;
      const gap = rects.slice(1).map((rect, offset) => {
        const previous = rects[offset], low = Math.min(previous[3], rect[3]), high = Math.max(previous[1], rect[1]);
        return high > low ? [(Math.max(previous[0], rect[0]) + Math.min(previous[2], rect[2])) / 2, (low + high) / 2] : null;
      }).find(value => value && split.alignment.constructor.hitTest(mapping, unit[side].page, value, side, true).status === "miss");
      check(!!gap, side + ": paragraph line whitespace has no precise mapping hit");
      mouse(index, "mousedown", screenPoint(view, gap)); mouse(index, "mouseup", screenPoint(view, gap));
      await Zotero.Promise.delay(pollMilliseconds);
      (index ? split.alignment.button : split.alignment.targetButton).click();
      check(!split.alignment.highlight && /没有已验证/.test(split.alignment.status.textContent), side + ": native whitespace click does not guess a fragment");
      const right = Math.max(...rects.map(rect => rect[2]));
      const tail = rects.slice().reverse().map(rect => rect[2] + 2 < right
        ? [(rect[2] + right) / 2, (rect[1] + rect[3]) / 2] : null)
        .find(point => point && split.alignment.constructor.hitTest(mapping, unit[side].page, point, side, true).status === "miss");
      check(!!tail, side + ": short-line trailing whitespace is outside every precise polygon");
      const tailView = await page(index, unit[side].page, [tail[0] - 1, tail[1] - 1, tail[0] + 1, tail[1] + 1]);
      mouse(index, "mousedown", screenPoint(tailView, tail)); mouse(index, "mouseup", screenPoint(tailView, tail));
      await Zotero.Promise.delay(pollMilliseconds);
      (index ? split.alignment.button : split.alignment.targetButton).click();
      check(!split.alignment.highlight && /没有已验证/.test(split.alignment.status.textContent), side + ": native short-line blank click does not select the paragraph");
    }
    const rect = unit.target.rects[0], view = await page(1, unit.target.page, rect);
    split.alignment.hoverButton.click();
    mouse(1, "mousemove", screenPoint(view, [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]));
    await until(() => split.alignment.hoverUnit?.id === unit.id, "Native line hover did not activate");
    check(split.alignment.hoverHighlights.some(value => value?.ranges?.length), "Native CSS highlights paint text without paragraph whitespace");
    split.alignment.hoverButton.click();
  }

  /** Exercise missing/corrupt maps and replaced bytes; restore exactly the fixture files afterwards. */
  async function degradation(source, translated, asset) {
    const mappingPath = await asset.getFilePathAsync(), mappingBytes = await IOUtils.read(mappingPath);
    const state = {source, translated, alignment:split.alignment};
    try {
      await IOUtils.writeUTF8(mappingPath, "{broken");
      const missing = await bridge.alignmentAssets.load(state);
      check(!missing.available, "Corrupt synced map degrades without API calls");
      state.alignment.setMapping(null, missing.reason);
      check(state.alignment.button.disabled && state.alignment.targetButton.disabled && split.sync
        && split.apps.every(app => app.pdfDocument && app.pdfViewer.pagesCount > 0),
      "Damaged mapping disables only precise controls; ordinary PDF reading and page sync stay available");
      await IOUtils.remove(mappingPath);
      check(!(await bridge.alignmentAssets.load(state)).available, "Undownloaded map degrades without retranslating");
    } finally { await IOUtils.write(mappingPath, mappingBytes); }
    for (const [side, attachment] of [["原文", source], ["译文", translated]]) {
      const path = await attachment.getFilePathAsync(), bytes = await IOUtils.read(path), changed = new Uint8Array(bytes.length + 1);
      changed.set(bytes); changed[bytes.length] = 10;
      try {
        await IOUtils.write(path, changed);
        check((await bridge.alignmentAssets.load(state)).reason.includes(side + "已变化"), side + ": replacement bytes disable the old map");
      } finally { await IOUtils.write(path, bytes); }
    }
    const original = JSON.parse(await IOUtils.readUTF8(mappingPath));
    for (const [field, value] of [["source_attachment_key", "ZZZZZZZZ"], ["owner_key", null], ["schema_version", 999]]) {
      try {
        await IOUtils.writeUTF8(mappingPath, JSON.stringify({...original, [field]:value}));
        check(!(await bridge.alignmentAssets.load(state)).available,
          "Synced map with incompatible identity/schema is not rebound: " + field);
      } finally { await IOUtils.write(mappingPath, mappingBytes); }
    }
    let translatedReader;
    try {
      await Zotero.Items.trashTx([source.id]);
      check(!(await bridge.alignmentAssets.load(state)).available && await translated.fileExists() && await asset.fileExists(),
        "A deleted original disables precise mapping without deleting the translated PDF or JSON asset");
      translatedReader = await Zotero.Reader.open(translated.id);
      translatedReader ||= Zotero.Reader._readers.find(value => value.itemID === translated.id);
      await translatedReader._initPromise;
      check(await bridge.openExisting(translatedReader) === translated,
        "Product command still opens the known translated PDF when its original is deleted");
    } finally { source.deleted = false; await source.saveTx(); }
    // Native trash closes the original reader; restore through the product, not its disposed controller.
    await bridge.openExisting(translatedReader);
    split = [...bridge.splits.values()].find(value => value.source.key === source.key && value.translated.key === translated.key);
    check(!!split, "Restoring the original reopens the exact native PDF pair without retranslating");
    await split.ready;
    state.alignment = split.alignment;
    const recovered = await bridge.alignmentAssets.load(state);
    state.alignment.setMapping(recovered.mapping, recovered.reason);
    check(recovered.available && await translated.fileExists(), "Exact restored bytes recover trusted reading with all results retained");
  }

  try {
    if (!config.isolated || !samePath(Services.dirsvc.get("ProfD", Ci.nsIFile).path, config.expectedProfileDirectory)
      || !samePath(Zotero.DataDirectory.dir, config.expectedDataDirectory)) throw new Error("Refusing non-isolated native acceptance");
    isolated = true; bridge = Zotero.PaperBridge; await bridge.ready;
    // Size only this isolated window so paired PDF text remains reachable on both hosts.
    Zotero.getMainWindow().resizeTo(1440, 1000);
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await checkpoint("native-install");
    if (config.phase === "create") await installCandidate(AddonManager);
    const addon = await AddonManager.getAddonByID("paperbridge@local.dev");
    report.xpiSha256 = hashFile(PathUtils.join(config.expectedProfileDirectory, "extensions", "paperbridge@local.dev.xpi"));
    check(addon?.isActive && addon.version === config.expectedVersion && report.xpiSha256 === config.expectedXpiSha256,
      "Native addon version and exact installed XPI hash match the candidate", {version:addon?.version, sha256:report.xpiSha256});
    originalEnsure = bridge.runtime.ensure; originalRequest = bridge.request;
    bridge.runtime.ensure = async function () { report.engineStarts++; throw new Error("Reading must not start Python"); };
    bridge.request = async function (endpoint) { report.backendRequests++; throw new Error("Reading must not call a backend: " + endpoint); };
    let source, translated, asset, saved;
    if (config.phase === "create") {
      const sample = JSON.parse(await IOUtils.readUTF8(config.caseManifest)).cases[0];
      const owner = new Zotero.Item("journalArticle");
      owner.setField("title", "PaperBridge 0.3.6 isolated reading assets"); await owner.saveTx();
      source = await Zotero.Attachments.importFromFile({file:PathUtils.normalize(sample.source_pdf), parentItemID:owner.id});
      translated = await Zotero.Attachments.importFromFile({file:PathUtils.normalize(sample.translated_pdf), parentItemID:owner.id});
      const record = await bridge.library.put(source, translated, {language:"zh-CN", model:"deepseek-flash", pages:"2"},
        {id:"native-assets-fixture", state:"done", quality:{status:"complete"}, alignment_path:PathUtils.normalize(sample.alignment_path)},
        await IOUtils.stat(await source.getFilePathAsync()));
      asset = await bridge.library.item(source.libraryID, record.mappingAttachmentKey);
      check(asset?.isAttachment() && !asset.isPDFAttachment(), "Producer saves verified mapping as a native synced JSON attachment");
      const payload = JSON.parse(await IOUtils.readUTF8(await asset.getFilePathAsync()));
      check(payload.source_attachment_key === source.key && payload.translated_attachment_key === translated.key
        && !JSON.stringify(payload).includes("source_text"), "Portable JSON carries exact keys/hashes/geometry without captured text");
      check((await bridge.alignmentAssets.publish(record, translated)).key === asset.key, "Repeated native publication is idempotent");
      // Seed only this isolated fixture's old URNs, then exercise the actual native migration.
      const translationMarkers = ["urn:paperbridge:record:" + record.recordID, "urn:paperbridge:job:" + record.jobID];
      const mappingMarker = "urn:paperbridge:alignment:1";
      const markerIdentity = {recordID:record.recordID, jobID:record.jobID, sourceKey:source.key,
        translatedKey:translated.key, assetKey:asset.key, sourceSha256:hashFile(await source.getFilePathAsync()),
        targetSha256:hashFile(await translated.getFilePathAsync()), mappingSha256:hashFile(await asset.getFilePathAsync())};
      for (const [item, markers] of [[translated, translationMarkers], [asset, [mappingMarker]]]) {
        check(markers.every(marker => item.getTags().some(tag => tag.tag === marker && tag.type === 1)),
          "New native outcomes use automatic tags, not internal URN relations");
        for (const marker of markers) { item.removeTag(marker); item.addRelation("dc:relation", marker); }
        await item.saveTx();
      }
      await bridge.library.migrateMarkers();
      for (const [item, markers] of [[translated, translationMarkers], [asset, [mappingMarker]]]) {
        check(markers.every(marker => item.getTags().some(tag => tag.tag === marker && tag.type === 1))
          && item.getRelationsByPredicate("dc:relation").every(uri => !uri.startsWith("urn:paperbridge:")),
          "Native legacy migration removes only internal relations and retains exact automatic marker tags");
      }
      check(translated.getRelationsByPredicate("dc:relation").includes(Zotero.URI.getItemURI(source))
        && asset.getRelationsByPredicate("dc:relation").includes(Zotero.URI.getItemURI(translated)),
        "Genuine native source and translation URI relations survive marker migration");
      check(record.recordID === markerIdentity.recordID && record.jobID === markerIdentity.jobID
        && source.key === markerIdentity.sourceKey && translated.key === markerIdentity.translatedKey && asset.key === markerIdentity.assetKey
        && hashFile(await source.getFilePathAsync()) === markerIdentity.sourceSha256
        && hashFile(await translated.getFilePathAsync()) === markerIdentity.targetSha256
        && hashFile(await asset.getFilePathAsync()) === markerIdentity.mappingSha256,
        "Marker migration preserves durable IDs, native attachment keys and exact PDF/JSON bytes");
      check((await bridge.library.markedItems(source.libraryID, mappingMarker)).some(item => item.id === asset.id),
        "Native exact-tag search discovers the migrated mapping attachment");
      report.markerMigration = markerIdentity;
      saved = {sourceKey:source.key, translatedKey:translated.key, assetKey:asset.key, libraryID:source.libraryID,
        sourceSha256:hashFile(await source.getFilePathAsync()), targetSha256:hashFile(await translated.getFilePathAsync()),
        mappingSha256:hashFile(await asset.getFilePathAsync()), processID:report.processID, markerMigration:markerIdentity,
        sourcePath:await source.getFilePathAsync(), translatedPath:await translated.getFilePathAsync(), mappingPath:await asset.getFilePathAsync()};
      await IOUtils.writeUTF8(config.statePath, JSON.stringify(saved, null, 2));
    } else {
      saved = JSON.parse(await IOUtils.readUTF8(config.statePath));
      source = await bridge.library.item(saved.libraryID, saved.sourceKey); translated = await bridge.library.item(saved.libraryID, saved.translatedKey);
      asset = await bridge.library.item(saved.libraryID, saved.assetKey);
      check(source && translated && asset, "Exact native attachment keys survive transfer or process cold reopen");
      if (config.phase === "reopen" && saved.markerMigration) {
        const record = bridge.library.records.find(value => value.recordID === saved.markerMigration.recordID);
        check(record?.jobID === saved.markerMigration.jobID && bridge.library.isTranslation(translated),
          "Cold reopen retains exact migrated record/job markers and translation recognition");
        check((await bridge.library.markedItems(saved.libraryID, "urn:paperbridge:alignment:1")).some(item => item.id === asset.id),
          "Cold reopen discovers the migrated asset through native automatic-tag search");
        report.markerMigration = saved.markerMigration;
      }
      if (config.phase === "receive" && config.webdavFixture) {
        check(bridge.library.records.length === 0 && !await IOUtils.exists(bridge.runtime.home)
          && !(await IOUtils.getChildren(PathUtils.join(Zotero.DataDirectory.dir, "storage"))).length,
        "Receiver starts with metadata only, empty storage and no Python engine");
        await checkpoint("native-webdav-download");
        report.downloads = await nativeHelper("reading_asset_webdav.js").ReadingAssetWebDAV.downloadReceiver({
          fixturePath:config.webdavFixture, server:config.webdavServer, check});
      }
      check(hashFile(await source.getFilePathAsync()) === saved.sourceSha256 && hashFile(await translated.getFilePathAsync()) === saved.targetSha256
        && hashFile(await asset.getFilePathAsync()) === saved.mappingSha256, "Downloaded source/translation/mapping bytes match the producer exactly");
      if (config.phase === "receive") check(bridge.library.records.length === 0 && !await IOUtils.exists(bridge.runtime.home),
        "Receiver has no translation journal, sidecar or extracted Python engine");
      else check(saved.processID !== report.processID, "Cold reopen uses a genuinely different Zotero process PID");
    }
    await checkpoint("engine-free-reading");
    let reader = await Zotero.Reader.open(translated.id);
    // Zotero may restore the tab before this helper; open then returns no new reader.
    reader ||= Zotero.Reader._readers.find(value => value.itemID === translated.id);
    check(!!reader, "Native translated reader is available after opening or tab restoration");
    await reader._initPromise; await bridge.openExisting(reader);
    split = [...bridge.splits.values()].find(value => value.source.key === source.key && value.translated.key === translated.key);
    check(!!split, "Product command opens the known downloaded PDF pair without a local translation job");
    await annotationWrites(split);
    await interactions();
    if (config.phase === "receive") await degradation(source, translated, asset);
    check(report.engineStarts === 0 && report.backendRequests === 0 && !bridge.runtime.process,
      "Reading/hash verification/navigation/hover cause zero engine starts or API requests");
    await bridge.closeSplit(split.reader.tabID);
    await annotationWrites(split);
    split = null;
    if (config.exportDirectory) {
      await checkpoint("native-webdav-export");
      report.export = await nativeHelper("reading_asset_webdav.js").ReadingAssetWebDAV.exportProducer({
        exportDir:config.exportDirectory, keys:[source.key, translated.key, asset.key],
        username:"reading-assets-fixture", password:Zotero.Utilities.randomString(32)});
      check(report.export.attachments.length === 3, "Producer exports the exact three attachments with native Zotero ZIPs");
    }
    if (config.phase === "create") {
      bridge.runtime.ensure = originalEnsure;
      bridge.request = async function (endpoint, ...args) {
        if (!endpoint.startsWith("/cache/") && endpoint !== "/health") throw new Error("Lifecycle must not translate: " + endpoint);
        return originalRequest.call(this, endpoint, ...args);
      };
      const scope = {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils};
      Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(PathUtils.join(PAPERBRIDGE_TEST_ROOT,
        "tests", "lifecycle_asset_packaged.js"))).spec, scope);
      await checkpoint("native-lifecycle");
      const lifecycleRoot = PathUtils.join(bridge.runtime.base, "lifecycle-test");
      // Native PathUtils.normalize resolves existing paths; create only this isolated test's directories.
      for (const path of [lifecycleRoot, bridge.runtime.state, bridge.runtime.cache]) {
        await IOUtils.makeDirectory(path, {createAncestors:true, ignoreExisting:true});
      }
      report.lifecycle = await scope.LifecycleAssetChecks.run({bridge, root:lifecycleRoot,
        check, sourceFile:await source.getFilePathAsync(), translatedFile:await translated.getFilePathAsync(),
        mappingFile:JSON.parse(await IOUtils.readUTF8(config.caseManifest)).cases[0].alignment_path, isolation:config});
      const health = await bridge.request("/health");
      const marker = await IOUtils.readJSON(PathUtils.join(bridge.runtime.home, "installed.json"));
      report.lifecycleRuntime = {version:health.version, engine:health.engine, python:health.python,
        processID:bridge.runtime.process.pid, marker, pythonMode:bridge.runtime.build.pythonMode};
      check(health.version === config.expectedVersion && marker.version === config.expectedVersion
        && marker.buildId === bridge.runtime.build.buildId && marker.pythonMode === bridge.runtime.build.pythonMode,
      "Actual cleanup backend health and extracted marker match the candidate version/build/Python mode");
      saved.lifecycle = report.lifecycle;
      await IOUtils.writeUTF8(config.statePath, JSON.stringify(saved, null, 2));
    } else if (config.phase === "reopen" && saved.lifecycle) {
      const scope = {Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components, ChromeUtils};
      Services.scriptloader.loadSubScript(Services.io.newFileURI(Zotero.File.pathToFile(PathUtils.join(PAPERBRIDGE_TEST_ROOT,
        "tests", "lifecycle_asset_packaged.js"))).spec, scope);
      report.lifecycle = await scope.LifecycleAssetChecks.reopen({bridge, root:saved.lifecycle.root, check, state:saved.lifecycle});
    }
    await bridge.library.settled(); report.ok = true; await checkpoint("complete");
  } catch (error) { report.errors.push({message:String(error), stack:error.stack || ""}); }
  finally {
    if (isolated) {
      try {
        if (split) await bridge.closeSplit(split.reader.tabID);
        if (bridge && originalEnsure) bridge.runtime.ensure = originalEnsure;
        if (bridge && originalRequest) bridge.request = originalRequest;
        await bridge?.library.settled();
      } catch (error) { report.ok = false; report.errors.push({message:String(error)}); }
      await IOUtils.writeUTF8(config.reportPath, JSON.stringify(report, null, 2));
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    } else Zotero.logError(new Error(report.errors[0]?.message || "Unsafe test configuration"));
  }
})();
