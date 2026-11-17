/** Use one attachment-backed Zotero reader for the translated pane and its writes. */
/* global Zotero, Components */
// Native annotation ownership, menus and permissions stay with the translated attachment.
var TranslationReader = {
  /** Detect the shared native contract before falling back to the legacy adapter. */
  supported(state, attachment) {
    const Base = Object.getPrototypeOf(state.reader.constructor);
    return typeof Base === "function" && typeof Base.prototype?._open === "function"
      && typeof Base.prototype?.uninit === "function" && typeof Base.prototype?._flushState === "function"
      && typeof attachment.getAnnotations === "function" && typeof attachment.getTabTitle === "function"
      && typeof state.browser.contentWindow?.wrappedJSObject?.createReader === "function"
      && Array.isArray(Zotero.Reader._readers);
  },

  /** Initialize a native reader without creating a second selectable Zotero tab. */
  async open(bridge, state, attachment) {
    if (!this.supported(state, attachment)) throw new Error("Zotero native reader API unavailable");
    const host = state.reader;
    const Base = Object.getPrototypeOf(host.constructor);
    const reader = new Base({ item: attachment });
    state.translationReader = reader;
    state.pendingWrites = new Set();
    state.nativeCleanups = [];
    reader._paperbridgeEmbedded = true;
    // Reader.open must not reuse this instance as a tab for the translated attachment.
    reader._isTabClosed = true;
    /** Keep native title updates bound to this attachment, not the host tab. */
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
    /** Embedded readers have no outer tab title to change. */
    reader._setTitleValue = () => {};
    /** Serialize translated annotations using the native attachment reader. */
    reader._addToNote = annotations => host._addToNote.call(reader, annotations);
    /** Route native close commands through the deduplicated pane lifecycle. */
    reader.close = () => bridge.closeSplit(host.tabID);
    const popupset = host._window.document.createXULElement("popupset");
    state.container.append(popupset);
    reader._popupset = popupset;
    state.nativeCleanups.push(() => popupset.remove());
    reader._iframe.addEventListener("contextmenu", reader._handleReaderTextboxContextMenuOpen);
    state.nativeCleanups.push(() => reader._iframe.removeEventListener("contextmenu", reader._handleReaderTextboxContextMenuOpen));

    /** Track privileged writes before returning control to a destructible content frame. */
    const track = task => {
      let promise;
      try { promise = Promise.resolve(task()); }
      catch (error) { promise = Promise.reject(error); }
      state.pendingWrites.add(promise);
      promise.then(() => state.pendingWrites.delete(promise), () => state.pendingWrites.delete(promise));
      promise.catch(error => {
        Zotero.logError(error);
        try { bridge.annotationMessage(state, error); }
        catch (displayError) { Zotero.logError(displayError); }
      });
      return promise;
    };
    const frame = reader._iframeWindow;
    const createReader = frame.wrappedJSObject.createReader;
    const wrappedCreate = Components.utils.exportFunction(options => {
      if (state.closing) throw new Error("PaperBridge pane closed during initialization");
      options = Components.utils.waiveXrays(options);
      const save = options.onSaveAnnotations;
      const erase = options.onDeleteAnnotations;
      /** Save a close-time snapshot without retaining a content-owned callback. */
      state.saveAnnotations = annotations => track(() => save(annotations, () => {}));
      /** Delete only through the native translated-attachment handler. */
      state.deleteAnnotations = ids => track(() => erase(ids));
      options.onSaveAnnotations = Components.utils.exportFunction((annotations, callback) => {
        const snapshot = JSON.parse(JSON.stringify(annotations));
        track(() => save(snapshot, () => {
          if (!state.closing) callback();
        }));
      }, frame);
      options.onDeleteAnnotations = Components.utils.exportFunction(ids => {
        const snapshot = JSON.parse(JSON.stringify(ids));
        track(() => erase(snapshot));
      }, frame);
      state.right = createReader(options);
      return state.right;
    }, frame);
    frame.wrappedJSObject.createReader = wrappedCreate;
    /** Restore the factory before a fallback or any future reader initialization. */
    const restoreFactory = () => {
      if (frame.wrappedJSObject.createReader === wrappedCreate) frame.wrappedJSObject.createReader = createReader;
    };
    state.nativeCleanups.push(restoreFactory);
    Zotero.Reader._readers.push(reader);
    try {
      state.nativeOpening = reader._open({ state: {
        pageIndex: host._internalReader._state.primaryViewState?.pageIndex || 0,
        scale: "page-width"
      } });
      await state.nativeOpening;
    } finally {
      restoreFactory();
    }
    if (state.closing) return;
    state.right = reader._internalReader;
    await state.right._primaryView.initializedPromise;
    if (state.closing) return;
    if (typeof reader.enableAddToNote === "function") {
      await reader.enableAddToNote(!!host._window.ZoteroContextPane?.activeEditor);
    }
    return reader;
  },

  /** Snapshot debounced edits before any await, then always release native resources. */
  async close(state) {
    const reader = state.translationReader;
    if (!reader) return;
    state.closing = true;
    const errors = [];
    try {
      try {
        const manager = reader._internalReader?._annotationManager;
        if (manager) {
          const pending = JSON.parse(JSON.stringify([...manager._unsavedAnnotations]));
          const saves = pending.filter(([, annotation]) => annotation).map(([, annotation]) => annotation);
          const deletes = pending.filter(([, annotation]) => !annotation).map(([id]) => id);
          if (saves.length) state.saveAnnotations(saves);
          if (deletes.length) state.deleteAnnotations(deletes);
          manager._unsavedAnnotations.clear();
          reader._iframeWindow.clearTimeout(manager._saveTimeout);
        }
      } catch (error) { errors.push(error); }
      // A closing factory refuses late creation; let an already-started _open settle.
      await Promise.resolve(state.nativeOpening).catch(() => {});
      const writes = await Promise.allSettled([...(state.pendingWrites || [])]);
      errors.push(...writes.filter(result => result.status === "rejected").map(result => result.reason));
      try { await reader._flushState(); }
      catch (error) { errors.push(error); }
    } finally {
      const readers = Zotero.Reader._readers;
      const index = readers.indexOf(reader);
      if (index !== -1) readers.splice(index, 1);
      const cleanups = [
        ...(state.nativeCleanups || []),
        () => { reader._blockingObserver?.dispose(); reader._blockingObserver = null; },
        () => {
          if (reader._customEventHandler) reader._iframeWindow.removeEventListener("customEvent", reader._customEventHandler);
          reader._customEventHandler = null;
        },
        () => {
          for (const id of reader._prefObserverIDs || []) Zotero.Prefs.unregisterObserver(id);
          reader._prefObserverIDs = [];
        },
        () => {
          // Zotero uninit re-flushes without awaiting; the explicit attempt above owns errors.
          reader._flushState = () => Promise.resolve();
          reader.uninit();
        },
        () => state.right?._primaryView?.destroy()
      ];
      for (const cleanup of cleanups) {
        try { cleanup(); }
        catch (error) {
          if (!String(error).includes("dead object")) errors.push(error);
        }
      }
      state.nativeCleanups = [];
    }
    if (errors.length) {
      for (const error of errors.slice(1)) Zotero.logError(error);
      throw errors[0];
    }
  }
};
