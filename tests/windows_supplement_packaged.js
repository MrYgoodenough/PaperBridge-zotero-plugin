/** Bounded Windows native-marker, note and DPI-view supplement; loaded, never auto-run.
 * Call PAPERBRIDGE_WINDOWS_SUPPLEMENT({bridge, config, check, checkpoint, until, report, state}).
 * config: isolated/expectedProfileDirectory/expectedDataDirectory/reportPath/supplementStatePath,
 * supplementPhase: 'exercise'|'notes'|'reopen'|'views'; the parent supplies upgrade PDF keys.
 * Parent owns diagnostics/credentials, real scaling runs, shutdown, and upgrade-state persistence. */
/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, Components */
/** Run the bounded supplement in the parent's native process; return evidence or throw with report evidence retained. */
var PAPERBRIDGE_WINDOWS_SUPPLEMENT = async function ({ bridge, config, check, checkpoint, until, report, state } = {}) {
  // Native decoding, editor startup and save debounce need a bounded readiness window.
  const timeoutMilliseconds = 60000;
  // Native selection moves are throttled; polling must not outrun the real reader.
  const pollMilliseconds = 100, stableLayoutSamples = 3, movementMilliseconds = 60;
  // Keep drag endpoints away from native reader auto-scroll edges.
  const edgeMargin = 24, startInset = 0.5, endPadding = 2, dragSteps = 6;
  // Gecko distinguishes a mouse source and the pressed primary button bit from click count.
  const mouseInputSource = 1, primaryMouseButtons = 1;
  // A short or subpixel span cannot provide a reliable real mouse-drag fixture.
  const minimumTextLength = 8, minimumTextWidth = 40;
  // PDF.js uses FINISHED = 3; placeholders and text without a painted canvas are insufficient.
  const renderingFinished = 3;
  // Exercise ordinary and narrow CSS sizes without changing Windows display settings.
  const viewSizes = [{ width: 860, height: 760 }, { width: 380, height: 620 }];
  // Allow harmless native border rounding, not clipped buttons or horizontal scrolling.
  const layoutTolerance = 2;
  // Bind the independent state format to this supplement, not the upgrade-state file.
  const stateSchema = 1;
  // Compare the same persisted annotation fields that the production note command checks.
  const annotationFields = ['type', 'text', 'comment', 'pageLabel', 'color', 'position'];
  // Exact native automatic tags replace only these legacy internal relation values.
  const markerPrefix = 'urn:paperbridge:', recordMarkerPrefix = markerPrefix + 'record:',
    jobMarkerPrefix = markerPrefix + 'job:', alignmentMarker = markerPrefix + 'alignment:1';
  // Preserve an ordinary user tag separately from automatic plugin markers.
  const automaticMarkerType = 1, userMarkerType = 0, markerControlTag = 'PaperBridge Windows marker fixture';
  // Reuse the observed real sidecar beside the configured PDF; never fabricate verified geometry.
  const markerAlignmentFilename = 'alignment.json', markerNearMatchSuffix = ':near-match';
  // Teardown owns only windows/readers created here; fixture items remain for cold reopen.
  const windows = new Set(), readers = new Set();
  // Do not mix unperformed OS tests or injected faults with native acceptance checks.
  const evidence = { ok: false, phase: config?.supplementPhase === 'notes' ? 'exercise' : config?.supplementPhase || config?.phase,
    requestedPhase: config?.supplementPhase,
    processID: Services.appinfo.processID, nativeChecks: [], injectedChecks: [], snapshots: [], views: [],
    remaining: ['OS 100%/150% setting and visual QA require separate external evidence; this supplement never changes scale',
      'Native long-path and file-occupied errors: no safe production fixture supplied; not injected',
      'Physical missing-resource failure: parent tests a labelled isolated startup exception, not a missing model'],
    parentChecks: 'Diagnostic ZIP/privacy and two synthetic native credential realms are tested by the upgrade harness',
    providerActionsInvoked: 0, providerNetworkMonitoring: 'Parent-owned; no request monkeypatch installed',
    faultCopiesCreated: 0, errors: [] };
  let main, previousTab, previousFocus, pair, saved, reportDirectory, statePath, isolated = false;

  /** Normalize existing native paths, including Windows drive-letter case. */
  function canonical(path) {
    const value = PathUtils.normalize(path);
    return Zotero.isWin ? value.toLowerCase() : value;
  }

  /** Resolve absent output names through their existing parent, avoiding inode normalization failures. */
  function outputPath(path) {
    return PathUtils.join(canonical(PathUtils.parent(path)), PathUtils.filename(path).toLowerCase());
  }

  /** Compare normalized path components without relying on a non-existent PathUtils.separator. */
  function inside(path, root) {
    const parts = PathUtils.split(path), prefix = PathUtils.split(root);
    return parts.length > prefix.length && prefix.every((part, index) => parts[index] === part);
  }

  /** Accept only a path inside a caller-owned report directory or this isolated profile/data. */
  function ownedOutput(path) {
    const value = outputPath(path);
    return [reportDirectory, canonical(config.expectedProfileDirectory), canonical(config.expectedDataDirectory)]
      .some(root => inside(value, root));
  }

  /** Record native evidence independently of the parent's optional assertion representation. */
  function verify(condition, name, details = {}) {
    evidence.nativeChecks.push({ name, pass: !!condition, details });
    if (check) check(!!condition, '[windows native] ' + name, details);
    if (!condition) throw new Error(name);
  }

  /** Preserve progress in the parent's report, without replacing its ok/stage or quitting Zotero. */
  async function progress(stage) {
    evidence.stage = stage;
    try { if (checkpoint) await checkpoint('windows-supplement-' + stage); }
    catch (error) {
      evidence.ok = false;
      evidence.errors.push({ message: 'Parent checkpoint: ' + String(error) });
      throw error;
    }
  }

  /** Wait for observed native readiness; reuse the parent's bounded waiter when supplied. */
  async function wait(predicate, message) {
    evidence.waiting = message;
    try {
      if (until) return await until(predicate, message);
      const deadline = Date.now() + timeoutMilliseconds;
      do {
        const result = await predicate();
        if (result) return result;
        await Zotero.Promise.delay(pollMilliseconds);
      } while (Date.now() < deadline);
      throw new Error(message);
    } finally { delete evidence.waiting; }
  }

  /** Bound real promises without replacing their implementation or swallowing native failures. */
  async function ready(promise, message) {
    let done = false, failure, result;
    Promise.resolve(promise).then(value => { result = value; done = true; }, error => { failure = error; done = true; });
    await wait(() => { if (failure) throw failure; return done; }, message);
    return result;
  }

  /** Require one translated annotation owner and expose its actual pending writes. */
  function annotationWrites(split) {
    const native = split.translationReader;
    const legacy = split.annotations;
    verify(!!native !== !!legacy, 'Split has exactly one translated annotation owner');
    if (native) {
      verify(native.itemID === split.translated.id && typeof split.pendingWrites?.[Symbol.iterator] === 'function',
        'Native annotation owner and write queue belong to the translated attachment');
      return Promise.all(split.pendingWrites);
    }
    verify(typeof legacy.pending?.then === 'function', 'Legacy annotation owner exposes its persistence queue');
    return legacy.pending;
  }

  /** Hash only fixture bytes or inert metadata, never credentials or account information. */
  function checksum(bytes) {
    const hash = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.update(bytes, bytes.length);
    return Array.from(hash.finish(false), byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }

  /** Encode note/annotation identity using the actual native UTF-8 encoder. */
  function textChecksum(text) {
    return checksum(new main.TextEncoder().encode(text));
  }

  /** Resolve fixture keys only in the isolated personal library; reject external linked files. */
  async function pdf(libraryID, key) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    verify(libraryID === Zotero.Libraries.userLibraryID && item?.isPDFAttachment() && !item.deleted,
      'Fixture key resolves an isolated personal-library PDF');
    const path = await item.getFilePathAsync();
    verify(path && inside(canonical(path), canonical(config.expectedDataDirectory)),
      'Fixture PDF bytes belong to the isolated data directory');
    return item;
  }

  /** Write independent cold-reopen identity, never overwrite the parent's upgrade state. */
  async function persist() {
    await IOUtils.writeUTF8(statePath, JSON.stringify(saved, null, 2));
  }

  /** Copy the parent's PDF fixtures into one owned paper, without reparenting upgrade items. */
  async function createFixture() {
    const fixture = config.noteFixture || state || await IOUtils.readJSON(config.statePath);
    const source = await pdf(fixture.libraryID, fixture.sourceKey);
    const translated = await pdf(fixture.libraryID, fixture.translatedKey || fixture.targetKey);
    const parent = new Zotero.Item('journalArticle');
    parent.libraryID = source.libraryID;
    parent.setField('title', config.notePaperTitle || source.parentItem.getField('title'));
    await parent.saveTx();
    evidence.fixtureKeys = { parent: parent.key };
    const left = await Zotero.Attachments.importFromFile({ file: await source.getFilePathAsync(), parentItemID: parent.id });
    evidence.fixtureKeys.source = left.key;
    const right = await Zotero.Attachments.importFromFile({ file: await translated.getFilePathAsync(), parentItemID: parent.id });
    evidence.fixtureKeys.translated = right.key;
    saved = { schema: stateSchema, complete: false, processID: evidence.processID,
      isolationChecksum: textChecksum(canonical(config.expectedProfileDirectory) + '\n' + canonical(config.expectedDataDirectory)),
      libraryID: parent.libraryID, parentKey: parent.key, sourceKey: left.key, translatedKey: right.key,
      pageIndex: fixture.pageIndex ?? 0, paperTitle: parent.getField('title'), notes: [],
      sourceChecksum: checksum(await IOUtils.read(await left.getFilePathAsync())),
      translatedChecksum: checksum(await IOUtils.read(await right.getFilePathAsync())) };
    verify(Number.isSafeInteger(saved.pageIndex) && saved.pageIndex >= 0, 'Fixture page index is explicit and zero-based');
    await persist();
    return { source: left, translated: right, parent };
  }

  /** Revalidate saved native notes even when the independent prior view checks failed. */
  async function restoreFixture() {
    saved = await IOUtils.readJSON(statePath);
    verify(saved.schema === stateSchema && saved.notes?.length === 2 && Array.isArray(saved.annotations),
      'Cold-reopen state contains two saved native-note identities for independent revalidation');
    evidence.priorSupplementComplete = !!saved.complete;
    verify(saved.processID !== evidence.processID && saved.isolationChecksum === textChecksum(
      canonical(config.expectedProfileDirectory) + '\n' + canonical(config.expectedDataDirectory)),
    'Cold reopen uses a different process in exactly the same isolated profile/data');
    const source = await pdf(saved.libraryID, saved.sourceKey);
    const translated = await pdf(saved.libraryID, saved.translatedKey);
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, saved.parentKey);
    verify(parent?.isRegularItem() && !parent.deleted && source.parentID === parent.id && translated.parentID === parent.id,
      'Cold reopen retains the owned paper and both attachment parents');
    verify(checksum(await IOUtils.read(await source.getFilePathAsync())) === saved.sourceChecksum
      && checksum(await IOUtils.read(await translated.getFilePathAsync())) === saved.translatedChecksum,
    'Cold reopen retains exact source and translated PDF bytes');
    evidence.fixtureKeys = { parent: parent.key, source: source.key, translated: translated.key };
    return { source, translated, parent };
  }

  /** Capture only owned native keys, record/job identity and exact PDF/JSON bytes. */
  async function markerIdentity(fixture, record, asset) {
    return { recordID: record.recordID, jobID: record.jobID, libraryID: record.libraryID,
      ownerKey: record.ownerKey, sourceKey: record.sourceKey, attachmentKey: record.attachmentKey,
      mappingAttachmentKey: record.mappingAttachmentKey,
      itemKeys: { parent: fixture.parent.key, source: fixture.source.key, translated: fixture.translated.key, asset: asset.key },
      itemIDs: { parent: fixture.parent.id, source: fixture.source.id, translated: fixture.translated.id, asset: asset.id },
      sourceChecksum: checksum(await IOUtils.read(await fixture.source.getFilePathAsync())),
      translatedChecksum: checksum(await IOUtils.read(await fixture.translated.getFilePathAsync())),
      alignmentChecksum: checksum(await IOUtils.read(await asset.getFilePathAsync())) };
  }

  /** Verify exact automatic tags while preserving genuine relations and an ordinary user tag. */
  function markerMetadata(item, markers, relations) {
    // Native Zotero omits the default user-tag type; automatic markers must still be exactly type 1.
    const tags = item.getTags().map(tag => ({ tag: tag.tag, type: tag.type ?? userMarkerType }));
    const actualRelations = [...item.getRelationsByPredicate('dc:relation')].sort();
    verify(markers.every(marker => tags.some(tag => tag.tag === marker && tag.type === automaticMarkerType))
      && actualRelations.every(uri => !uri.startsWith(markerPrefix)),
    'Native record/job/alignment markers are exact automatic tags, never internal URI relations', { itemKey: item.key, markers, tags });
    verify(JSON.stringify(actualRelations) === JSON.stringify([...relations].sort())
      && tags.some(tag => tag.tag === markerControlTag && tag.type === userMarkerType),
    'Native marker writes preserve genuine Zotero item URI relations and ordinary user tags',
    { itemKey: item.key, relations: actualRelations });
    return { itemKey: item.key, tags, relations: actualRelations };
  }

  /** Query production exact-tag discovery without native key or owner fallback shortcuts. */
  async function markerDiscovery(fixture, record, asset) {
    const discovered = [];
    for (const [marker, item] of [[recordMarkerPrefix + record.recordID, fixture.translated],
      [jobMarkerPrefix + record.jobID, fixture.translated], [alignmentMarker, asset]]) {
      const exact = await bridge.library.markedItems(saved.libraryID, marker);
      const near = await bridge.library.markedItems(saved.libraryID, marker + markerNearMatchSuffix);
      verify(exact.filter(candidate => candidate.id === item.id).length === 1
        && !near.some(candidate => candidate.id === item.id),
      'Native exact-tag search discovers the owned marker and rejects a near-match', { marker, itemKey: item.key });
      discovered.push({ marker, itemKey: item.key, exactIDs: exact.map(candidate => candidate.id), nearIDs: near.map(candidate => candidate.id) });
    }
    // Only this detached probe is changed; the persisted record keeps every original key and ID.
    const probe = { ...record, attachmentKey: null, attachmentID: null, importingAttachmentKey: null,
      ownerKey: null, ownerID: null };
    verify((await bridge.library.findAttachment(probe))?.id === fixture.translated.id,
      'Native translation recovery finds the exact tag without attachment-key or owner shortcuts');
    verify((await bridge.alignmentAssets.attachments(saved.libraryID)).some(candidate => candidate.id === asset.id),
      'Production alignment discovery retains the exact automatic-tagged JSON attachment');
    return discovered;
  }

  /** Exercise owned legacy metadata migration, or revalidate its exact state after cold reopen. */
  async function nativeMarkers(fixture) {
    verify(typeof bridge.library.migrateMarkers === 'function' && !!bridge.alignmentAssets,
      'Actual installed addon exposes native marker migration and alignment publication');
    let record, asset, retained;
    if (evidence.phase === 'exercise') {
      const mappingPath = canonical(config.markerAlignmentPath
        || PathUtils.join(PathUtils.parent(config.sourcePDF), markerAlignmentFilename));
      verify(inside(mappingPath, canonical(PathUtils.parent(config.expectedDataDirectory))),
        'Marker input JSON belongs to the owned isolated runtime fixtures');
      const mapping = await bridge.alignmentAssets.constructor.readJSON(mappingPath);
      await wait(() => pair.apps.every(app => app?.pdfDocument), 'Native marker PDF documents did not initialize');
      await bridge.alignmentAssets.verified(mapping, { source: fixture.source, translated: fixture.translated,
        alignment: pair.alignment }, await bridge.alignmentAssets.evidence(fixture.source, fixture.translated));
      const inputChecksum = checksum(await IOUtils.read(mappingPath));
      const sourceURI = Zotero.URI.getItemURI(fixture.source), translatedURI = Zotero.URI.getItemURI(fixture.translated),
        parentURI = Zotero.URI.getItemURI(fixture.parent);
      fixture.translated.addTag(markerControlTag, userMarkerType);
      fixture.translated.addRelation('dc:relation', parentURI);
      await fixture.translated.saveTx();
      // This is metadata-only fixture identity for existing real files, not a backend/model job response.
      const jobID = 'native-windows-marker-' + fixture.parent.key;
      record = await ready(bridge.library.put(fixture.source, fixture.translated, bridge.configuration(),
        { id: jobID, state: 'done', quality: { status: 'unknown' }, alignment_path: mappingPath },
        await IOUtils.stat(await fixture.source.getFilePathAsync())), 'Production marker record did not save');
      asset = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, record.mappingAttachmentKey);
      verify(record.jobID === jobID && asset?.isAttachment() && !asset.deleted && asset.parentID === fixture.parent.id,
        'Production record attachment publishes one owned real alignment JSON asset');
      asset.addTag(markerControlTag, userMarkerType);
      asset.addRelation('dc:relation', parentURI);
      await asset.saveTx();
      await ready(bridge.library.settled(), 'Native marker record/index saves did not settle');
      const translationMarkers = [recordMarkerPrefix + record.recordID, jobMarkerPrefix + record.jobID];
      const translatedRelations = [sourceURI, parentURI], assetRelations = [sourceURI, translatedURI, parentURI];
      const fresh = [markerMetadata(fixture.translated, translationMarkers, translatedRelations),
        markerMetadata(asset, [alignmentMarker], assetRelations)];
      const before = await markerIdentity(fixture, record, asset);
      // Seed only the newly owned items; the real native migration, not test-side tag writes, must repair them.
      for (const [item, markers] of [[fixture.translated, translationMarkers], [asset, [alignmentMarker]]]) {
        for (const marker of markers) { item.removeTag(marker); item.addRelation('dc:relation', marker); }
        await item.saveTx();
        verify(markers.every(marker => item.getRelationsByPredicate('dc:relation').includes(marker)
          && !item.getTags().some(tag => tag.tag === marker)),
        'Owned native legacy seed contains the same old URNs with their automatic tags absent', { itemKey: item.key, markers });
      }
      const legacyIDs = await Zotero.DB.columnQueryAsync(
        'SELECT DISTINCT itemID FROM itemRelations JOIN relationPredicates USING (predicateID) WHERE predicate = ? AND object LIKE ?',
        ['dc:relation', markerPrefix + '%']);
      verify(legacyIDs.length === 2 && legacyIDs.every(id => [fixture.translated.id, asset.id].includes(Number(id))),
        'Explicit native migration has only the two owned legacy-seeded items to change', { itemIDs: legacyIDs });
      verify(JSON.stringify(await markerIdentity(fixture, record, asset)) === JSON.stringify(before),
        'Legacy metadata seeding leaves native keys, record/job IDs and PDF/JSON hashes unchanged');
      await ready(bridge.library.migrateMarkers(), 'Production native marker migration did not finish');
      await ready(bridge.library.settled(), 'Migrated native marker saves did not settle');
      const migrated = [markerMetadata(fixture.translated, translationMarkers, translatedRelations),
        markerMetadata(asset, [alignmentMarker], assetRelations)];
      const after = await markerIdentity(fixture, record, asset);
      verify(JSON.stringify(after) === JSON.stringify(before)
        && checksum(await IOUtils.read(mappingPath)) === inputChecksum,
      'Native migration preserves every owned item key, record/job ID and original PDF/JSON hash', { before, after });
      retained = saved.markerMigration = { identity: before, mappingInputPath: mappingPath, mappingInputChecksum: inputChecksum,
        translationMarkers, translatedRelations, assetRelations };
      evidence.markerMigration = { phase: 'new-write-and-legacy-migration', fresh, migrated, identityBefore: before, identityAfter: after };
      await persist();
    } else {
      retained = saved.markerMigration;
      verify(retained?.identity?.recordID && retained.identity.jobID && retained.identity.itemKeys.asset,
        'Cold marker checks require saved identity from this marker-capable supplement, not preliminary evidence');
      record = bridge.library.records.find(candidate => candidate.recordID === retained.identity.recordID);
      asset = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, retained.identity.itemKeys.asset);
      verify(record?.jobID === retained.identity.jobID && asset?.isAttachment() && !asset.deleted
        && asset.parentID === fixture.parent.id, 'Cold reopen retains the owned record/job IDs and exact alignment attachment');
      const metadata = [markerMetadata(fixture.translated, retained.translationMarkers, retained.translatedRelations),
        markerMetadata(asset, [alignmentMarker], retained.assetRelations)];
      const after = await markerIdentity(fixture, record, asset);
      verify(JSON.stringify(after) === JSON.stringify(retained.identity)
        && checksum(await IOUtils.read(retained.mappingInputPath)) === retained.mappingInputChecksum,
      'Cold reopen retains exact migrated native keys, record/job IDs and original PDF/JSON bytes', { before: retained.identity, after });
      evidence.markerMigration = { phase: 'cold-reopen', migrated: metadata, identityBefore: retained.identity, identityAfter: after };
    }
    evidence.markerMigration.discovery = await markerDiscovery(fixture, record, asset);
    evidence.markerMigration.inputChecksum = retained.mappingInputChecksum;
    evidence.markerMigration.complete = true;
  }

  /** Open a fresh production split, refusing to replace any parent-owned reader or split. */
  async function openPair(fixture) {
    verify(!Zotero.Reader._readers.some(reader => reader.itemID === fixture.source.id),
      'Supplement source has no pre-existing reader to mutate');
    try { await ready(bridge.split(fixture.source, fixture.translated), 'Production split initialization did not finish'); }
    finally {
      for (const reader of Zotero.Reader._readers) if (reader.itemID === fixture.source.id) readers.add(reader);
    }
    const reader = [...readers].find(value => value.itemID === fixture.source.id);
    pair = bridge.splits.get(reader?.tabID);
    verify(pair?.alignment && !pair.right._state.readOnly, 'Production note buttons and editable native annotations are ready');
    await ready(annotationWrites(pair), 'Translated annotation owner persistence queue did not finish');
    await ready(pair.right._primaryView.initializedPromise, 'Translated native reader did not initialize');
    await wait(() => pair.apps[1]?.pdfDocument && pair.frames[1]?.document, 'Translated PDF application did not load');
    verify(saved.pageIndex < pair.apps[1].pdfDocument.numPages, 'Fixture page exists in the actual PDF');
    // Select a translated physical page independently; resize-driven source scrolling must not replace it.
    if (pair.sync) {
      await click(pair.browser.contentDocument.querySelector('.paperbridge-split-controls > button[aria-pressed]'));
      await wait(() => !pair.sync, 'Production independent-scroll control did not disable page synchronization');
      verify(true, 'Owned note fixture uses the production independent-scroll control');
    }
    // Expand the real collapsed tools before PDF selection; opening them afterward could disturb that selection.
    const tools = pair.alignment.selectionNoteButton.closest('details');
    verify(!!tools, 'Production note buttons belong to the real reading-tools disclosure');
    if (!tools.open) await click(tools.querySelector('summary'));
    await wait(() => tools.open, 'Trusted reading-tools click did not reveal the native note commands');
    return pair;
  }

  /** Send trusted Gecko mouse input in the actual UI window; never fabricate a Range or annotation. */
  function mouse(window, type, x, y, buttons = type === 'mousedown' ? primaryMouseButtons : 0) {
    const native = Components.utils.unwaiveXrays(window);
    const utilities = native.windowUtils || native.docShell.domWindowUtils;
    // Explicit released moves prevent Gecko's default buttons=1 from extending an old selection.
    utilities.sendMouseEvent(type, x, y, 0, type === 'mousemove' ? 0 : 1, 0,
      false, 0, mouseInputSource, true, false, buttons);
  }

  /** Await foreground native focus before mouse commands, particularly in Windows interactive sessions. */
  async function focus(window, ownerWindow) {
    // Content-frame focus must raise the containing chrome window, not assign an iframe as activeWindow.
    const root = ownerWindow || (windows.has(window) ? window : main);
    root.focus();
    Services.focus.activeWindow = root;
    if (window !== root) window.focus();
    await wait(() => window.document.hasFocus(), 'Native UI window did not receive foreground focus');
  }

  /** Click a real, reachable production control and require its trusted native click event. */
  async function click(element, ownerWindow) {
    const window = element.ownerDocument.defaultView;
    await focus(window, ownerWindow);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    await Zotero.Promise.delay(pollMilliseconds);
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const hit = element.ownerDocument.elementFromPoint(x, y);
    // SVG className is a live native wrapper; retain only inert strings before any editor closes.
    verify(box.width > 0 && box.height > 0 && !element.disabled && x >= 0 && x < window.innerWidth
      && y >= 0 && y < window.innerHeight && (hit === element || element.contains(hit)),
    'Production UI control is visible and hit-testable', { id: element.id, className: element.getAttribute('class') || '',
      box: { left: box.left, top: box.top, width: box.width, height: box.height }, disabled: !!element.disabled,
      viewport: { width: window.innerWidth, height: window.innerHeight }, hitClass: hit?.getAttribute?.('class') || null });
    const input = { tag: element.localName, id: element.id, className: element.getAttribute('class') || '',
      href: element.getAttribute('href'), point: [x, y], events: [] };
    (evidence.controlInputs ||= []).push(input);
    const eventNames = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    /** Observe, but never cancel or synthesize, the native click. */
    function observe(event) {
      input.events.push({ type: event.type, trusted: event.isTrusted, buttons: event.buttons });
    }
    for (const name of eventNames) element.addEventListener(name, observe, { capture: true, passive: true });
    try {
      mouse(window, 'mousedown', x, y);
      mouse(window, 'mouseup', x, y);
      verify(input.events.some(event => event.type === 'click') && input.events.every(event => event.trusted),
        'Production control receives a trusted mouse click', { href: input.href, className: input.className });
    } finally {
      for (const name of eventNames) element.removeEventListener(name, observe, true);
    }
  }

  /** Use the actual toolbar, toggling an active annotation tool off for pointer selection. */
  async function tool(type) {
    if (pair.right.toolType === type) return;
    const name = type === 'pointer' ? pair.right.toolType : type;
    const button = await wait(() => pair.browser.contentDocument.querySelector('.toolbar-button.' + name),
      'Native reader tool control is missing: ' + name);
    await click(button);
    await wait(() => pair.right.toolType === type, 'Native reader tool did not change: ' + type);
  }

  /** Drag a painted, visible text-layer line, recording native input independently of persisted annotations. */
  async function drag(type) {
    await tool(type);
    main.Zotero_Tabs.select(pair.reader.tabID);
    await focus(main);
    const frame = pair.frames[1], app = pair.apps[1], doc = frame.document;
    // Focus can scroll the containing reader; settle coordinates only after native frame focus.
    await focus(frame);
    app.pdfViewer.scrollPageIntoView(Components.utils.cloneInto({ pageNumber: saved.pageIndex + 1 }, frame));
    const page = await wait(() => {
      const view = app.pdfViewer.getPageView(saved.pageIndex);
      const canvas = view?.div.querySelector('canvas');
      evidence.pageReadiness = { pageIndex: saved.pageIndex, currentPage: app.pdfViewer.currentPageNumber,
        renderingState: view?.renderingState, canvasWidth: canvas?.width, canvasHeight: canvas?.height,
        textSpans: view?.div.querySelectorAll('.textLayer span').length, viewport: [frame.innerWidth, frame.innerHeight] };
      return view?.renderingState === renderingFinished && canvas?.width > 0 && canvas.height > 0
        && view.div.querySelector('.textLayer span') && view;
    }, 'Actual native PDF canvas/text layer did not render');
    const span = [...page.div.querySelectorAll('.textLayer span')].find(value =>
      !value.childElementCount && value.textContent.trim().length > minimumTextLength
        && (!config.noteSelectionText || value.textContent.includes(config.noteSelectionText))
        && value.getBoundingClientRect().width > minimumTextWidth
        && value.getBoundingClientRect().width + endPadding < frame.innerWidth);
    verify(!!span, 'Fixture contains a selectable real native text line');
    const expected = config.noteSelectionText || span.textContent.trim();
    const node = span.firstChild, offset = node.textContent.indexOf(expected);
    // Measure a real in-text term without installing a Selection; whitespace endpoints can cross native pages.
    const measurement = doc.createRange();
    measurement.setStart(node, offset);
    measurement.setEnd(node, offset + expected.length);
    const initial = measurement.getBoundingClientRect();
    // DOM scrollIntoView can scroll an outer reader frame; center only the actual PDF container.
    app.pdfViewer.container.scrollTop += (initial.top + initial.bottom) / 2 - frame.innerHeight / 2;
    const probe = { type, pageIndex: saved.pageIndex, viewport: { width: frame.innerWidth, height: frame.innerHeight },
      scale: app.pdfViewer.currentScale, selectedTextChecksum: textChecksum(expected) };
    (evidence.dragProbes ||= []).push(probe);
    let previousBounds, stableBounds = 0;
    const box = await wait(() => {
      const bounds = measurement.getBoundingClientRect();
      probe.bounds = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      probe.scrolling = !!pair.right._primaryView._scrolling;
      const currentBounds = JSON.stringify(probe.bounds);
      stableBounds = currentBounds === previousBounds ? stableBounds + 1 : 0;
      previousBounds = currentBounds;
      // Auto-scroll guards apply vertically; a fully visible line need not have a wide horizontal margin.
      return stableBounds >= stableLayoutSamples && !pair.right._primaryView._scrolling && bounds.left >= 0
        && bounds.right + endPadding < frame.innerWidth && bounds.top > edgeMargin
        && bounds.bottom < frame.innerHeight - edgeMargin && bounds.height > 0 && bounds;
    }, 'Actual PDF line did not settle inside the viewport; no off-screen drag performed');
    const x = box.left + startInset, endX = box.right + endPadding, y = box.top + box.height / 2;
    verify(doc.elementFromPoint(x, y)?.closest('.page')?.isSameNode(page.div), 'Native drag starts on the rendered PDF page');
    const events = [];
    /** Retain trusted input provenance without preventing upstream reader handling. */
    function observe(event) {
      events.push({ type: event.type, trusted: event.isTrusted, buttons: event.buttons,
        x: event.clientX, y: event.clientY, page: event.target?.closest?.('.page')?.dataset.pageNumber });
    }
    for (const name of ['mousedown', 'mousemove', 'mouseup']) doc.addEventListener(name, observe, { capture: true, passive: true });
    try {
      mouse(frame, 'mousemove', x, y);
      mouse(frame, 'mousedown', x, y);
      for (let step = 1; step <= dragSteps; step++) {
        mouse(frame, 'mousemove', x + (endX - x) * step / dragSteps, y, primaryMouseButtons);
        // Match the existing native copy harness; same-tick moves may be coalesced by the reader.
        await Zotero.Promise.delay(movementMilliseconds);
      }
      mouse(frame, 'mouseup', endX, y);
      await Zotero.Promise.delay(pollMilliseconds);
      verify(events.some(event => event.type === 'mousedown') && events.some(event => event.type === 'mouseup')
        && events.every(event => event.trusted), 'PDF drag produces real trusted native mouse events');
      const input = { type, pageIndex: saved.pageIndex, events, expectedText: expected,
        requested: { start: [x, y], end: [endX, y] },
        box: { left: box.left, top: box.top, width: box.width, height: box.height } };
      (evidence.inputs ||= []).push(input);
      const selected = type === 'pointer' ? await wait(() => doc.getSelection()?.toString().trim(),
        'Native PDF mouse drag did not produce a text selection') : expected;
      Object.assign(input, { textChecksum: textChecksum(selected), actualText: selected });
      verify(selected === expected, 'Actual selected text matches the exact rendered fixture text',
        { expected, actual: selected });
      return selected;
    } finally {
      for (const name of ['mousedown', 'mousemove', 'mouseup']) doc.removeEventListener(name, observe, true);
    }
  }

  /** Snapshot only persisted native annotation content, with no replacement Zotero.Annotation items. */
  async function annotations(attachment) {
    await attachment.loadDataType('childItems');
    const result = [];
    for (const item of attachment.getAnnotations()) {
      await item.loadAllData();
      const json = await Zotero.Annotations.toJSON(item);
      result.push({ key: item.key, checksum: textChecksum(JSON.stringify(
        annotationFields.map(field => json[field] || ''))) });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Observe a fully initialized production note editor, not merely a saved Item or window shell. */
  async function editor(note, label, targetBacklink) {
    const window = await wait(() => {
      for (const candidate of Services.wm.getEnumerator('zotero:note')) {
        if (candidate.document.getElementById('zotero-note-editor')?.item?.id === note.id) {
          windows.add(candidate);
          return candidate;
        }
      }
      return null;
    }, 'Actual native note editor did not open');
    const element = window.document.getElementById('zotero-note-editor');
    verify(typeof element._initPromise?.then === 'function', 'Native note editor exposes its actual initialization promise');
    await ready(element._initPromise, 'Native note-editor initialization did not finish');
    const instance = await wait(() => element.getCurrentInstance?.() || element._editorInstance,
      'Native note-editor instance is unavailable');
    await ready(instance._initPromise, 'Native editor content initialization did not finish');
    const content = await wait(() => instance._iframeWindow?.document.querySelector('[contenteditable="true"]'),
      'Native editor did not render editable note content');
    // Match the real saved attachment link, not a superseded or localized heading label.
    await wait(() => [...content.querySelectorAll('a[href]')].some(link =>
      link.getAttribute('href')?.includes(pair.translated.key)), 'Initialized native editor did not paint the saved note link');
    verify(element.item.id === note.id, 'Initialized native editor selects the saved note item');
    if (targetBacklink) await editorBacklink(content, window, targetBacklink, label);
    await snapshot(window, label);
    window.close();
    await wait(() => window.closed, 'Owned native note window did not close');
    await ready(Zotero.DB.waitForTransaction(), 'Native note-editor close transaction did not finish');
    await focus(main);
    return note;
  }

  /** Activate the real editor link and its native popup through trusted mouse input. */
  async function editorBacklink(content, window, target, label) {
    const link = [...content.querySelectorAll('a[href]')].find(value => value.getAttribute('href') === target);
    verify(!!link, 'Native note editor paints the exact saved translated-PDF backlink');
    await click(link, window);
    const popupLink = await wait(() => [...content.ownerDocument.querySelectorAll('.link-popup a[href]')]
      .find(value => value.getAttribute('href') === target), 'Native editor link popup did not expose the saved backlink');
    await snapshot(window, label + '-popup');
    // Zotero's editor opens links from this popup; no direct protocol call substitutes for either click.
    await click(popupLink, window);
    verify(true, 'Trusted editor-link and popup clicks activate the saved PDF backlink', { target });
  }

  /** Invoke a production split button once, keeping native save and native editor-open results distinct. */
  async function noteAction(kind) {
    const alignment = pair.alignment, previous = alignment.lastNoteResult;
    const before = pair.source.parentItem.getNotes().length;
    await click(kind === 'selection' ? alignment.selectionNoteButton : alignment.annotationsNoteButton);
    await wait(() => alignment.noteOperation || alignment.lastNoteResult !== previous, 'Production note command did not start');
    if (alignment.noteOperation) await ready(alignment.noteOperation, 'Production note command did not finish');
    const result = alignment.lastNoteResult;
    verify(result !== previous && result?.note?.isNote() && result.note.parentID === pair.source.parentID
      && result.note.libraryID === pair.translated.libraryID && pair.source.parentItem.getNotes().length === before + 1,
    'Production ' + kind + ' command saves exactly one independent native paper-child note');
    verify(result.opened && !result.openError, 'Production note command opens the official native editor');
    return editor(result.note, kind + '-note');
  }

  /** Check real paper citation metadata, translated provenance and both exact PDF backlink identities. */
  function noteRecord(note, kind, selectedChecksum, annotationKey) {
    const doc = new main.DOMParser().parseFromString(note.getNote(), 'text/html');
    const metadata = doc.querySelector('[data-citation-items]');
    const citations = metadata && JSON.parse(decodeURIComponent(metadata.getAttribute('data-citation-items')));
    const native = [...doc.querySelectorAll('[data-annotation]')]
      .map(node => JSON.parse(decodeURIComponent(node.getAttribute('data-annotation'))));
    const base = 'zotero://open-pdf/library/items/';
    const target = base + pair.translated.key + '?page=' + (saved.pageIndex + 1)
      + (annotationKey ? '&annotation=' + annotationKey : '');
    const source = base + pair.source.key;
    const links = [...doc.querySelectorAll('a[href]')].map(node => node.getAttribute('href'));
    verify(citations?.some(value => value.uris?.includes(Zotero.URI.getItemURI(pair.source.parentItem))
        && value.itemData?.title === saved.paperTitle)
      && native.some(value => value.attachmentURI === Zotero.URI.getItemURI(pair.translated)
        && value.position?.pageIndex === saved.pageIndex && value.annotationKey === annotationKey)
      && links.includes(target) && links.includes(source),
    'New note retains real paper citation, translated provenance and exact source/translated PDF backlinks');
    const textNode = doc.querySelector('.highlight, .underline');
    const renderedText = textNode?.textContent.trim() || '';
    const opening = Zotero.getString('punctuation.openingQMark'), closing = Zotero.getString('punctuation.closingQMark');
    // Native templates may add localized quotation marks; never strip genuine selection punctuation blindly.
    const unquoted = opening && closing && renderedText.startsWith(opening) && renderedText.endsWith(closing)
      ? renderedText.slice(opening.length, -closing.length).trim() : renderedText;
    verify(textNode && [renderedText, unquoted].some(text => textChecksum(text) === selectedChecksum),
      'New note retains actual dragged PDF text without substitution');
    return { key: note.key, kind, checksum: textChecksum(note.getNote()), selectedChecksum,
      annotationKey: annotationKey || null, targetBacklink: target, sourceBacklink: source };
  }

  /** Follow the saved backlink from its actual native editor and verify the resulting reader. */
  async function backlink(record) {
    verify(!Zotero.Reader._readers.some(reader => reader.itemID === pair.translated.id && !readers.has(reader)),
      'PDF backlink cannot reuse a parent-owned translated reader');
    const note = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, record.key);
    verify(note?.isNote(), 'Saved backlink belongs to the retained native note');
    await Zotero.Notes.open(note.id, null, { openInWindow: true });
    await editor(note, 'editor-backlink-' + record.kind, record.targetBacklink);
    const native = await wait(() => {
      const reader = Zotero.Reader._readers.find(value => value.itemID === pair.translated.id);
      if (reader) readers.add(reader);
      for (const window of Services.wm.getEnumerator('zotero:reader')) {
        if (window.reader?.itemID === pair.translated.id) windows.add(window);
      }
      return reader;
    }, 'Saved PDF backlink did not route to the real translated reader');
    await ready(native._initPromise, 'PDF backlink reader did not initialize');
    const view = await wait(() => native._internalReader?._primaryView, 'PDF backlink native view is missing');
    await ready(view.initializedPromise, 'PDF backlink native view did not initialize');
    await wait(() => view._iframeWindow?.PDFViewerApplication?.pdfViewer.currentPageNumber === saved.pageIndex + 1
      && (!record.annotationKey || native._internalReader._state.selectedAnnotationIDs?.includes(record.annotationKey)),
    'Saved PDF backlink did not reach its actual translated page/highlight');
    verify(true, 'Saved note backlink navigates to the real translated PDF page/annotation',
      { method: 'Trusted mouse clicks in the native note editor and its link popup', noteKey: record.key,
        attachmentKey: pair.translated.key, readerItemID: native.itemID,
        actualPageNumber: view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber,
        annotationKey: record.annotationKey || null,
        selectedAnnotationIDs: [...(native._internalReader._state.selectedAnnotationIDs || [])] });
    main.Zotero_Tabs.select(pair.reader.tabID);
  }

  /** Capture the actual Gecko viewport at native scale; paths belong to the parent's report directory. */
  async function snapshot(window, label) {
    await focus(window);
    const global = window.browsingContext?.currentWindowGlobal || window.windowGlobalChild?.parentActor;
    verify(typeof global?.drawSnapshot === 'function', 'Native composited-window snapshot API is available');
    const path = PathUtils.join(reportDirectory, PathUtils.filename(config.reportPath).replace(/\.[^.]+$/, '')
      + '-windows-' + evidence.phase + '-' + label + '.png');
    verify(!await IOUtils.exists(path), 'Native snapshot never overwrites earlier evidence');
    const bitmap = await ready(global.drawSnapshot(null, window.devicePixelRatio, 'rgb(255,255,255)'),
      'Native window snapshot did not finish');
    try {
      verify(bitmap.width > 0 && bitmap.height > 0, 'Native snapshot contains actual rendered pixels');
      const canvas = window.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const blob = await ready(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), 'Native snapshot PNG encoding did not finish');
      verify(!!blob, 'Native snapshot PNG encoding succeeded');
      await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
      evidence.snapshots.push({ path, label, width: bitmap.width, height: bitmap.height,
        devicePixelRatio: window.devicePixelRatio, method: 'WindowGlobalParent.drawSnapshot',
        region: 'Actual Gecko viewport including iframe subtree; OS decorations/cursor excluded', visualQA: 'pending parent review' });
    } finally { bitmap.close(); }
  }

  /** Inspect real action bounds and capture settings/diagnostics/tasks at the current system DPI. */
  async function views() {
    for (const name of ['settings', 'tasks']) {
      const window = main.openDialog('chrome://paperbridge/content/' + name + '.xhtml',
        'paperbridge-windows-supplement-' + name, 'chrome,centerscreen,resizable', { bridge });
      windows.add(window);
      await wait(() => window.document.readyState === 'complete'
        && window.document.getElementById(name === 'settings' ? 'diagnostics-export' : 'refresh'), 'Native ' + name + ' view did not load');
      if (name === 'settings') {
        const support = window.document.getElementById('support-settings');
        // Diagnostics are nested in the current support disclosure, not an independently visible control.
        if (support && !support.open) {
          await click(support.querySelector(':scope > summary'));
          await wait(() => support.open, 'Native support disclosure did not open');
        }
        await click(window.document.querySelector('#diagnostics > summary'));
      }
      else await wait(() => window.document.querySelector('.task') || window.document.getElementById('status').textContent,
        'Native task rows or empty-state message did not render');
      for (const size of viewSizes) {
        window.resizeTo(size.width, Math.min(size.height, window.screen.availHeight));
        // Keep this owned dialog on its real monitor; never simulate OS scaling with CSS.
        window.moveTo(window.screen.availLeft, window.screen.availTop);
        await wait(() => Math.abs(window.outerWidth - size.width) <= layoutTolerance,
          'Native window did not reach the requested actual width');
        await Zotero.Promise.delay(pollMilliseconds);
        const document = window.document, body = document.querySelector('body');
        const view = { name, requested: size, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          outerWidth: window.outerWidth, outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio,
          nativeScale: (window.windowUtils || window.docShell.domWindowUtils).screenPixelsPerCSSPixel ?? null,
          scaleScope: 'Observed native window scale; parent verifies actual OS setting, no CSS zoom applied',
          bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, controls: [] };
        evidence.views.push(view);
        verify(body.scrollWidth <= body.clientWidth + layoutTolerance, name + ' body has no horizontal overflow');
        for (const control of document.querySelectorAll('button, input, select, summary')) {
          // Gecko can retain geometry below a closed details element; those descendants are not painted controls.
          const collapsed = [...document.querySelectorAll('details:not([open])')].some(details =>
            details.contains(control) && !details.querySelector(':scope > summary')?.contains(control));
          if (collapsed) continue;
          const box = control.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const bounds = control.getBoundingClientRect();
          view.controls.push({ id: control.id, tag: control.localName, disabled: !!control.disabled,
            x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
          verify(bounds.left >= -layoutTolerance && bounds.right <= window.innerWidth + layoutTolerance
            && bounds.top >= -layoutTolerance && bounds.bottom <= window.innerHeight + layoutTolerance,
          name + ' control is reachable without overflowing the viewport', { id: control.id });
          if (!control.disabled) {
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            verify(hit === control || control.contains(hit), name + ' enabled control is not obscured or clipped', { id: control.id });
          }
          if (control.localName === 'button') verify(control.scrollWidth <= control.clientWidth + layoutTolerance,
            name + ' button label is not horizontally clipped', { id: control.id });
        }
        // Settings scroll their content while the footer stays fixed; body.scrollTop cannot reset that view.
        const scrollContainer = document.querySelector('.settings-content') || document.scrollingElement || body;
        scrollContainer.scrollTop = 0;
        await snapshot(window, name + '-' + size.width);
        if (name === 'settings') {
          verify(document.getElementById('diagnostics').open, 'Native diagnostic disclosure remains open via the production UI');
          document.getElementById('diagnostics-export').scrollIntoView({ block: 'center' });
          await snapshot(window, 'diagnostics-' + size.width);
        } else {
          const action = document.querySelector('.task .actions button:not([hidden])');
          if (action) {
            action.scrollIntoView({ block: 'center' });
            await snapshot(window, 'task-actions-' + size.width);
          }
          // The unrelated batch-summary shell is intentionally hidden until a batch is submitted.
          const summary = [...document.querySelectorAll('.task .task-details > summary')]
            .find(value => value.getBoundingClientRect().width > 0);
          if (summary) {
            await click(summary);
            verify(summary.parentElement.open, 'Native task diagnostic details open via the production UI');
            await snapshot(window, 'task-details-' + size.width);
            await click(summary);
          } else evidence.remaining.push('Task diagnostic card: isolated task view was empty at width ' + size.width);
        }
      }
      window.close();
      await wait(() => window.closed, 'Owned diagnostic/task view did not close');
    }
  }

  try {
    // No report writes, focus changes or addon access are allowed before this native isolation gate.
    if (config?.isolated !== true || Services.appinfo.OS !== 'WINNT'
      || canonical(Services.dirsvc.get('ProfD', Ci.nsIFile).path) !== canonical(config.expectedProfileDirectory)
      || canonical(Zotero.DataDirectory.dir) !== canonical(config.expectedDataDirectory)) {
      throw new Error('Refusing Windows supplement outside the explicit isolated native Windows profile/data pair');
    }
    isolated = true;
    if (!report || !bridge || !config.reportPath || !config.supplementStatePath) throw new Error('Parent report, bridge and separate supplementStatePath are required');
    report.windowsSupplement = evidence;
    reportDirectory = canonical(PathUtils.parent(config.reportPath));
    statePath = config.supplementStatePath;
    verify(ownedOutput(statePath) && (!config.statePath || outputPath(statePath) !== outputPath(config.statePath))
      && outputPath(statePath) !== outputPath(config.reportPath), 'Supplement state is owned and separate from upgrade state/report');
    verify(['exercise', 'reopen', 'views'].includes(evidence.phase), 'Supplement phase is native notes, cold notes or views');
    verify(bridge === Zotero.PaperBridge, 'Supplement uses the actual installed production bridge');
    main = Zotero.getMainWindow();
    previousTab = main.Zotero_Tabs.selectedID;
    previousFocus = Services.focus.activeWindow;
    await progress('ready');
    await ready(bridge.ready, 'Production addon did not finish initialization');
    await ready(Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item'), 'Native library items did not load');
    verify(!bridge.readerWaits.size && !bridge.tasks.submitting.size
      && bridge.library.records.every(record => record.detached || bridge.tasks.terminal(record.state)),
    'Isolated profile has no active translation submission/task to disturb');
    if (evidence.phase === 'views') {
      await progress('dpi-views');
      await views();
      return evidence;
    }
    if (evidence.phase === 'exercise') verify(!await IOUtils.exists(statePath), 'Exercise requires a new supplement state path; no silent duplicate notes');
    const fixture = evidence.phase === 'exercise' ? await createFixture() : await restoreFixture();
    await openPair(fixture);
    await progress('native-markers');
    await nativeMarkers(fixture);
    await progress('native-notes');
    if (evidence.phase === 'exercise') {
      const before = JSON.stringify(await annotations(pair.translated));
      const selected = await drag('pointer');
      await snapshot(main, 'pdf-selection');
      const note = await noteAction('selection');
      saved.notes.push(noteRecord(note, 'selection', textChecksum(selected)));
      verify(JSON.stringify(await annotations(pair.translated)) === before, 'Selection note creates no substitute native annotation');
      await persist();
      const highlighted = await drag('highlight');
      const item = await wait(async () => {
        await pair.translated.loadDataType('childItems');
        const value = pair.translated.getAnnotations().find(annotation => annotation.annotationType === 'highlight');
        if (!value) return null;
        await value.loadAllData();
        const json = await Zotero.Annotations.toJSON(value);
        const live = pair.right._state.annotations.find(annotation => annotation.id === value.key);
        return live && annotationFields.every(field => JSON.stringify(json[field] || '') === JSON.stringify(live[field] || '')) && value;
      }, 'Actual native highlight did not finish persisted-content debounce');
      verify(item.parentID === pair.translated.id && item.annotationText.trim() === highlighted
        && JSON.parse(item.annotationPosition).rects.length > 0, 'Mouse-created highlight persists actual text and native PDF geometry');
      saved.annotations = await annotations(pair.translated);
      const summary = await noteAction('annotations');
      saved.notes.push(noteRecord(summary, 'annotations', textChecksum(highlighted), item.key));
      verify(JSON.stringify(await annotations(pair.translated)) === JSON.stringify(saved.annotations), 'Summary note leaves saved native highlight unchanged');
      await persist();
      await backlink(saved.notes[1]);
    } else {
      verify(JSON.stringify(await annotations(pair.translated)) === JSON.stringify(saved.annotations), 'Cold reopen retains the exact saved native highlight');
      await fixture.parent.loadDataType('childItems');
      verify(fixture.parent.getNotes().length === saved.notes.length, 'Cold reopen has exactly the two owned independent notes');
      for (const record of saved.notes) {
        const note = await Zotero.Items.getByLibraryAndKeyAsync(saved.libraryID, record.key);
        verify(note?.isNote() && !note.deleted && note.parentID === fixture.parent.id
          && textChecksum(note.getNote()) === record.checksum, 'Cold reopen retains exact native note key, parent and HTML checksum');
        const actual = noteRecord(note, record.kind, record.selectedChecksum, record.annotationKey || undefined);
        verify(JSON.stringify(actual) === JSON.stringify(record), 'Cold reopen retains text, citation metadata and both PDF backlinks');
        await ready(Zotero.Notes.open(note.id, null, { openInWindow: true }), 'Existing native note did not open');
        await editor(note, 'reopened-' + record.kind + '-note');
        verify(textChecksum(note.getNote()) === record.checksum, 'Normal initialized editor open leaves persisted note unchanged');
        await backlink(record);
      }
    }
    verify((await annotations(pair.source)).length === 0, 'Native note/highlight operations do not annotate the source PDF');
    verify(checksum(await IOUtils.read(await pair.source.getFilePathAsync())) === saved.sourceChecksum
      && checksum(await IOUtils.read(await pair.translated.getFilePathAsync())) === saved.translatedChecksum,
    'Native note and annotation commands do not rewrite either PDF');
    evidence.notesComplete = true;
    if (evidence.phase === 'exercise') {
      saved.notesComplete = true;
      await persist();
    }
    await progress('dpi-views');
    await views();
  } catch (error) {
    evidence.errors.push({ message: String(error) });
    throw error;
  } finally {
    if (isolated && main) {
      // Continue independent cleanup even when one native save or close fails.
      const cleanupErrors = [];
      /** Preserve cleanup errors while still restoring the remaining owned UI. */
      async function cleanupStep(operation) {
        try { await operation(); }
        catch (error) {
          cleanupErrors.push(error);
          evidence.errors.push({ message: 'Cleanup: ' + String(error) });
        }
      }
      for (const window of windows) await cleanupStep(() => { if (!window.closed) window.close(); });
      await cleanupStep(() => wait(() => [...windows].every(window => window.closed), 'Owned supplement windows did not close'));
      for (const reader of readers) {
        await cleanupStep(async () => {
          const split = bridge.splits.get(reader.tabID);
          await ready(bridge.closeSplit(reader.tabID), 'Owned split did not fully close and save');
          if (split) {
            await ready(annotationWrites(split), 'Owned native annotation writes did not finish');
          }
        });
        await cleanupStep(() => { if (Zotero.Reader._readers.includes(reader)) reader.close(); });
      }
      await cleanupStep(() => wait(() => [...readers].every(reader => !Zotero.Reader._readers.includes(reader)), 'Owned supplement reader did not close'));
      await cleanupStep(() => ready(Zotero.DB.waitForTransaction(), 'Supplement teardown database transaction did not finish'));
      await cleanupStep(() => {
        if (previousTab) main.Zotero_Tabs.select(previousTab);
        if (previousFocus && !previousFocus.closed) previousFocus.focus();
      });
      evidence.cleanup = { ownedReadersClosed: [...readers].every(reader => !Zotero.Reader._readers.includes(reader)),
        ownedWindowsClosed: [...windows].every(window => window.closed), fixtureItemsRetained: true,
        mainWindowResized: false, runtimeFaultsCreated: false, productPrefsDirectlyWritten: false };
      if (!evidence.errors.length) {
        await cleanupStep(async () => { if (evidence.phase === 'exercise') { saved.complete = true; await persist(); } });
      }
      evidence.ok = evidence.errors.length === 0;
      await progress(evidence.ok ? 'complete' : 'failed');
      if (cleanupErrors.length) throw cleanupErrors[0];
    }
  }
  return evidence;
};
