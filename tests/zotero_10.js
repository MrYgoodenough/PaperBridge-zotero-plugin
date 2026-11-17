/** Historical macOS 0.4.2 Zotero 10 harness; never included in a release package. */
(async () => {
  const root = PAPERBRIDGE_TEST_ROOT;
  const report = { version: Zotero.version, plugin: "0.4.2", checks: {} };
  /** Save this historical harness's explicit checks. */
  const write = () => IOUtils.writeJSON(root + "/.runtime/zotero10-test.json", report);
  /** Bound native initialization while preserving assertion failures. */
  const waitFor = async predicate => {
    for (let i = 0; i < 50; i++) {
      if (predicate()) return;
      await Zotero.Promise.delay(100);
    }
    throw Error("Timed out waiting for reader state");
  };
  /** Record and enforce one native integration condition. */
  const check = (name, value) => {
    report.checks[name] = !!value;
    if (!value) throw new Error("Check failed: " + name);
  };
  try {
    const bridge = Zotero.PaperBridge;
    await bridge.ready;
    for (const tabID of [...bridge.splits.keys()]) await bridge.closeSplit(tabID);
    await Zotero.Promise.delay(1500);
    const health = await bridge.request("/health");
    report.engine = health;
    check("packagedEngine", health.version === "0.4.2" && health.root === bridge.runtime.home);
    let parent = new Zotero.Item("journalArticle");
    parent.setField("title", "PaperBridge 0.4.2 · Zotero 10 isolated verification");
    await parent.saveTx();
    const path = root + "/.cache/references/pi0-v3.pdf";
    const source = await Zotero.Attachments.importFromFile({ file: path, parentItemID: parent.id });
    const translated = await Zotero.Attachments.importFromFile({ file: path, parentItemID: parent.id });
    translated.setField("title", "译文 · 标注测试附件");
    await translated.saveTx();
    report.sourceID = source.id; report.translatedID = translated.id;
    await bridge.split(source, translated);
    const reader = Zotero.Reader._readers.find(r => r.itemID === source.id);
    let state = bridge.splits.get(reader.tabID);
    await Zotero.Promise.delay(1000);
    check("rightEditable", !state.right._state.readOnly);
    check("rightRegistered", Zotero.Reader._readers.includes(state.translationReader));
    check("annotationToolbarVisible", state.browser.contentWindow.getComputedStyle(
      state.browser.contentDocument.querySelector(".toolbar .center.tools")).display !== "none");
    const clone = value => Components.utils.cloneInto(value, state.browser.contentWindow);
    const add = (type, extra = {}) => state.right._annotationManager.addAnnotation(clone({
      type, color: "#ffd400", sortIndex: "00000|000000|00000", pageLabel: "1", text: "isolated test",
      position: { pageIndex: 0, rects: [[80, 700, 180, 712]] }, ...extra
    }));
    const highlight = add("highlight");
    const underline = add("underline", { position: { pageIndex: 0, rects: [[80, 680, 180, 692]] } });
    const note = add("note", { text: "", comment: "译文注释持久化测试", position: { pageIndex: 0, rects: [[200, 700, 222, 722]] } });
    const highlightID = highlight.id, underlineID = underline.id, noteID = note.id;
    await waitFor(()=>Zotero.Items.getByLibraryAndKey(translated.libraryID,underlineID)?.parentID===translated.id && Zotero.Items.getByLibraryAndKey(translated.libraryID,noteID)?.annotationComment==="译文注释持久化测试");
    check("highlightSavedToTranslation", Zotero.Items.getByLibraryAndKey(translated.libraryID, highlightID)?.parentID === translated.id);
    check("underlineSavedToTranslation", Zotero.Items.getByLibraryAndKey(translated.libraryID, underlineID)?.parentID === translated.id);
    check("noteSavedToTranslation", Zotero.Items.getByLibraryAndKey(translated.libraryID, noteID)?.annotationComment === "译文注释持久化测试");
    check("sourceAnnotationsUntouched", source.getAnnotations().length === 0);
    state.right._annotationManager.updateAnnotations(clone([{ id: noteID, comment: "关闭前最后一次编辑" }]));
    await bridge.closeSplit(reader.tabID);
    check("immediateCloseFlush", Zotero.Items.getByLibraryAndKey(translated.libraryID, noteID)?.annotationComment === "关闭前最后一次编辑");
    check("cleanup", !bridge.splits.has(reader.tabID) && !Zotero.Reader._readers.some(r => r._paperbridgeEmbedded));
    await bridge.split(source, translated);
    state = bridge.splits.get(reader.tabID);
    check("annotationsRestored", state.right._state.annotations.length === 3);
    reader.navigate({ pageIndex: 2 });
    await waitFor(()=>state.apps[1].pdfViewer.currentPageNumber===3);
    check("forwardSync", state.apps[1].pdfViewer.currentPageNumber === 3);
    state.active = 1;
    state.translationReader.navigate({ pageIndex: 3 });
    await waitFor(()=>state.apps[0].pdfViewer.currentPageNumber===4);
    check("reverseSync", state.apps[0].pdfViewer.currentPageNumber === 4);
    state.sync = false;
    state.translationReader.navigate({ pageIndex: 1 });
    await waitFor(()=>state.apps[1].pdfViewer.currentPageNumber===2);
    check("independentScroll", state.apps[0].pdfViewer.currentPageNumber === 4 && state.apps[1].pdfViewer.currentPageNumber === 2);
    await bridge.formulas.copy(state.translationReader, null, false, String.raw`x^2+y_i=\frac{1}{2}`);
    const clipboard = () => Zotero.Utilities.Internal.getClipboard("text/plain");
    check("inlineLatexClipboard", clipboard() === String.raw`$x^2+y_i=\frac{1}{2}$`);
    await bridge.formulas.copy(state.translationReader, null, true, String.raw`\[\sum_{i=1}^{n} x_i\]`);
    check("displayLatexClipboard", clipboard() === String.raw`$$\sum_{i=1}^{n} x_i$$`);
    // Verify the real popup event invokes our extension in an attachment-backed reader.
    const selected = { text: "x2", position: { pageIndex: 1, rects: [[80, 700, 120, 712]] } };
    const nodes = [];
    Zotero.Reader._dispatchEvent({ type: "renderTextSelectionPopup", reader: state.translationReader,
      doc: state.browser.contentDocument, params: { annotation: selected }, append: n => nodes.push(n) });
    check("formulaPopupButtons", nodes.some(n => n.querySelectorAll("button").length === 2));
    const groups = [];
    Zotero.Reader._dispatchEvent({ type: "createViewContextMenu", reader: state.translationReader,
      params: { overlay: { type: "math", tex: "x" } }, append: g => groups.push(g) });
    check("formulaContextMenu", groups.filter(g => g.label?.includes("LaTeX")).length === 2);
    state.right._annotationManager.deleteAnnotations(clone([underlineID]));
    await bridge.closeSplit(reader.tabID);
    check("deletePersisted", !Zotero.Items.getByLibraryAndKey(translated.libraryID, underlineID));
    await bridge.split(source, translated);
    state = bridge.splits.get(reader.tabID);
    check("deleteRestored", state.right._state.annotations.length === 2);
    state.right._annotationManager.updateAnnotations(clone([{ id: noteID, comment: "关闭标签页前编辑" }]));
    Zotero.getMainWindow().Zotero_Tabs.close(reader.tabID);
    await Zotero.Promise.delay(1200);
    check("tabCloseFlush", Zotero.Items.getByLibraryAndKey(translated.libraryID, noteID)?.annotationComment === "关闭标签页前编辑");
    check("tabCloseCleanup", !bridge.splits.has(reader.tabID) && !Zotero.Reader._readers.some(r => r._paperbridgeEmbedded));
    await bridge.split(source, translated);
    state = [...bridge.splits.values()].find(s => s.reader.itemID === source.id);
    const standalone = await Zotero.Reader.open(translated.id);
    await standalone._initPromise;
    check("standaloneTranslationTab", !!standalone.tabID && standalone !== state.translationReader);
    await standalone._internalReader._primaryView.initializedPromise;
    check("standaloneAnnotations", standalone._internalReader._state.annotations.length === 2);
    standalone._internalReader._annotationManager.updateAnnotations(Components.utils.cloneInto(
      [{ id: noteID, comment: "单独译文标签页编辑" }], standalone._iframeWindow));
    await Zotero.Promise.delay(1500);
    check("nativeAnnotationUpdates", state.right._state.annotations.some(a => a.id === noteID && a.comment === "单独译文标签页编辑"));
    Zotero.getMainWindow().Zotero_Tabs.close(standalone.tabID);
    Zotero.getMainWindow().Zotero_Tabs.select(state.reader.tabID);
    const popup = { rect: [40, 120, 240, 140], annotation: selected };
    state.right._updateState(clone({ primaryViewSelectionPopup: popup }));
    await Zotero.Promise.delay(500);
    check("renderedFormulaPopup", state.browser.contentDocument.querySelectorAll(".selection-popup .paperbridge-formula-copy button").length === 2);
    const clipboardBeforeFailure = clipboard();
    const originalRequest = bridge.request;
    const originalGetKey = bridge.getKey;
    try {
      bridge.getKey = () => "isolated-test-placeholder";
      bridge.request = async () => { throw new Error("simulated provider failure"); };
      let rejected = false;
      try { await bridge.formulas.copy(state.translationReader, {text:"test-uncached-formula",glyphs:[]}, false); }
      catch { rejected = true; }
      check("clipboardUnchangedOnFailure", rejected && clipboard() === clipboardBeforeFailure);
    } finally { bridge.request = originalRequest; bridge.getKey = originalGetKey; }
    if (bridge.runtime.version === "0.4.2") {
      const scope={Zotero,Services,IOUtils,PathUtils,Components};
      Services.scriptloader.loadSubScriptWithOptions(PathUtils.toFileURI(root+"/tests/zotero_042.js"),{ignoreCache:true,target:scope});
      state=await scope.runFormula042Tests(bridge,state,source,translated,root,check);
    }
    report.tabID = state.reader.tabID;
    const doc = state.browser.contentDocument;
    report.layout = { rightWidth: doc.documentElement.clientWidth,
      toolbarHeight: doc.querySelector(".toolbar").getBoundingClientRect().height,
      formulaButtons: [...doc.querySelectorAll(".selection-popup .paperbridge-formula-copy button")].map(n => n.textContent) };
    state.right._annotationManager.updateAnnotations(clone([{id:noteID,comment:"停用前编辑已保存"}]));
    await bridge.stop();
    check("pluginStopFlush", Zotero.Items.getByLibraryAndKey(translated.libraryID,noteID)?.annotationComment === "停用前编辑已保存");
    check("pluginStopCleanup", bridge.splits.size === 0 && bridge.closingSplits.size === 0 && !Zotero.Reader._readers.some(r => r._paperbridgeEmbedded));
    check("engineStop", !bridge.runtime.process);
    report.ok = true;
    await write();
  } catch (error) {
    report.ok = false; report.error = String(error); report.stack = error.stack;
    await write();
  }
  // Read-only inspection / further test commands for this disposable profile.
  while (true) {
    await Zotero.Promise.delay(500);
    const command = root + "/.runtime/zotero10-command.js";
    if (!await IOUtils.exists(command)) continue;
    const code = await IOUtils.readUTF8(command);
    await IOUtils.remove(command);
    try {
      const result = await (new Function("Zotero", "Services", "IOUtils", "Components", "return (async () => {" + code + "})()"))(Zotero, Services, IOUtils, Components);
      await IOUtils.writeJSON(root + "/.runtime/zotero10-command-result.json", { result: result ?? null });
    } catch (error) {
      await IOUtils.writeJSON(root + "/.runtime/zotero10-command-result.json", { error: String(error), stack: error.stack });
    }
  }
})();
