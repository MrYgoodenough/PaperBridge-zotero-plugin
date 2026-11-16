/* global Zotero, Components */
// Reuse Zotero's attachment-backed ReaderInstance, including annotation persistence,
// permissions, menus, tags, clipboard serialization and item notifications.
var TranslationReader = {
  async open(bridge, state, attachment) {
    const host = state.reader;
    const ReaderInstance = Object.getPrototypeOf(host.constructor);
    if (typeof ReaderInstance?.prototype?._open !== "function") {
      throw new Error("当前 Zotero 阅读器接口不兼容，请更新 PaperBridge。");
    }
    const reader = new ReaderInstance({ item: attachment });
    state.translationReader = reader;
    reader._paperbridgeEmbedded = true;
    // This instance has no selectable Zotero tab. Exclude it from Reader.open's
    // reusable-tab search so opening the translated attachment still opens a tab.
    reader._isTabClosed = true;
    reader.updateTitle = async () => {
      reader._title = await attachment.getTabTitle();
      if (!reader._isUninitialized) reader._internalReader?.setTitle(reader._title);
    };
    reader._window = host._window;
    reader._iframe = state.browser;
    reader._iframeWindow = state.browser.contentWindow;
    reader._sidebarWidth = 200;
    reader._sidebarOpen = false;
    reader._bottomPlaceholderHeight = 0;
    reader._contextPaneOpen = false;
    reader._setTitleValue = () => {};
    reader._addToNote = annotations => host._addToNote.call(reader, annotations);
    reader.close = () => bridge.action(() => bridge.closeSplit(host.tabID));
    const popupset = host._window.document.createXULElement("popupset");
    state.container.append(popupset);
    reader._popupset = popupset;
    state.cleanups.push(() => popupset.remove());
    reader._iframe.addEventListener("contextmenu", reader._handleReaderTextboxContextMenuOpen);
    // Keep pending writes in the privileged attachment reader. A tab can remove
    // its browser before asynchronous saves finish; content-owned arguments and
    // callbacks would then become dead wrappers. Snapshot them before any await.
    state.pendingWrites = new Set();
    const track = task => {
      const promise = Promise.resolve(task);
      state.pendingWrites.add(promise);
      promise.then(() => state.pendingWrites.delete(promise), () => state.pendingWrites.delete(promise));
      return promise;
    };
    const frame = reader._iframeWindow;
    const createReader = frame.wrappedJSObject.createReader;
    frame.wrappedJSObject.createReader = Components.utils.exportFunction(options => {
      options = Components.utils.waiveXrays(options);
      const save = options.onSaveAnnotations;
      const erase = options.onDeleteAnnotations;
      state.saveAnnotations = annotations => track(save(annotations, () => {}));
      state.deleteAnnotations = ids => track(erase(ids));
      options.onSaveAnnotations = Components.utils.exportFunction((annotations, callback) => {
        const snapshot = JSON.parse(JSON.stringify(annotations));
        track(save(snapshot, () => { if (!state.closing) callback(); })).catch(error => Zotero.logError(error));
      }, frame);
      options.onDeleteAnnotations = Components.utils.exportFunction(ids => {
        track(erase(JSON.parse(JSON.stringify(ids)))).catch(error => Zotero.logError(error));
      }, frame);
      return createReader(options);
    }, frame);
    // Base instances are excluded from Zotero's tab/session list, but receive
    // annotation and preference updates through the regular reader manager.
    Zotero.Reader._readers.push(reader);
    await reader._open({ state: {
      pageIndex: host._internalReader._state.primaryViewState?.pageIndex || 0,
      scale: "page-width"
    } });
    state.right = reader._internalReader;
    await state.right._primaryView.initializedPromise;
    await bridge.formulas.attach(reader);
    await reader.enableAddToNote(!!host._window.ZoteroContextPane?.activeEditor);
    return reader;
  },

  async close(state) {
    const reader = state.translationReader;
    if (!reader) return;
    state.closing = true;
    // Capture unsaved edits synchronously, including when the parent tab is
    // about to destroy the content frame in its next event-loop turn.
    const manager = reader._internalReader?._annotationManager;
    if (manager) {
      const pending = JSON.parse(JSON.stringify([...manager._unsavedAnnotations]));
      manager._unsavedAnnotations.clear();
      reader._iframeWindow.clearTimeout(manager._saveTimeout);
      const saves = pending.filter(([, annotation]) => annotation).map(([, annotation]) => annotation);
      const deletes = pending.filter(([, annotation]) => !annotation).map(([id]) => id);
      if (saves.length) state.saveAnnotations(saves);
      if (deletes.length) state.deleteAnnotations(deletes);
    }
    try {
      await Promise.all([...state.pendingWrites || []]);
      await reader._flushState();
    } finally {
      // Remove from the manager even when the parent tab has already destroyed
      // its iframe; future item/preference notifications must not reach it.
      const readers = Zotero.Reader._readers;
      const index = readers.indexOf(reader);
      if (index !== -1) readers.splice(index, 1);
      // unregister(browser) requires a live docShell; dispose() also works after
      // the parent tab has detached its browser (the native ReaderTab does this).
      reader._blockingObserver?.dispose();
      reader._blockingObserver = null;
      reader.uninit();
      try { state.right?._primaryView?.destroy(); }
      catch (error) { if (!String(error).includes("dead object")) throw error; }
    }
  }
};
