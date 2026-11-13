/** Zotero commands and paired PDF reading; task execution lives in tasks.js. */
/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils, TranslationTasks, FragmentAlignment */
// One bridge is shared by all Zotero windows in the addon scope.
var PaperBridge = {
  jobs: new Map(),
  // Only the initiating reader command may wait and auto-open its saved result.
  readerWaits: new Set(),
  splits: new Map(),
  buttons: new Set(),
  alive: true,

  /** Read one addon preference. */
  pref(name) { return Zotero.Prefs.get("extensions.paperbridge." + name, true); },
  /** Store one non-secret addon preference. */
  setPref(name, value) { Zotero.Prefs.set("extensions.paperbridge." + name, value, true); },
  /** Initialize durable tasks and register Zotero UI entry points. */
  async start(id) {
    this.id = id;
    this.storageRoot = PathUtils.join(Zotero.DataDirectory.dir,"storage");
    this.alive = true;
    await this.library.load();
    this.tasks = new TranslationTasks(this);
    await this.tasks.resume();
    this.toolbarHandler = event => this.toolbar(event);
    this.contextHandler = ({ reader, append }) => {
      if (reader._type !== "pdf") return;
      append({ label: "PaperBridge 翻译并分屏", onCommand: () => this.action(() => this.translate(reader)) });
      append({ label: "PaperBridge：打开已有译文", onCommand: () => this.action(() => this.openExisting(reader)) });
      append({ label: "PaperBridge：取消翻译", onCommand: () => this.action(() => this.cancel(reader.itemID)) });
    };
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, id);
    Zotero.Reader.registerEventListener("createViewContextMenu", this.contextHandler, id);
    this.observer = {
      notify: (event, type, ids) => {
        if (type === "tab" && event === "close") ids.forEach(tab => this.closeSplit(tab));
        if (type === "item" && ["trash","delete","modify"].includes(event)) this.library.schedule();
      }
    };
    this.notifier = Zotero.Notifier.registerObserver(this.observer,["tab","item"],"paperbridge");
    for (const win of Zotero.getMainWindows()) this.addMenus(win);
    // A newly installed plugin must also appear in readers that were already open.
    for (const reader of Zotero.Reader._readers || []) {
      try {
        await reader._initPromise;
        const doc = reader._iframeWindow?.document;
        const host = doc?.querySelector(".toolbar .end");
        if (host && !doc.querySelector(".paperbridge-translate")) {
          this.toolbar({ reader, doc, append: node => host.append(node) });
        }
      } catch (error) {
        // Private reader changes must not disable the library queue or saved artifacts.
        Zotero.logError(error);
      }
    }
  },

  /** Release readers and leave backend interruptions available for explicit recovery. */
  async stop() {
    this.alive = false;
    this.taskWindow?.close();
    // The backend records interrupted work on shutdown; never silently resubmit it.
    if (this.tasks?.refreshing) await this.tasks.refreshing.catch(error => Zotero.logError(error));
    for (const tab of [...this.splits.keys()]) this.closeSplit(tab);
    Zotero.Notifier.unregisterObserver(this.notifier);
    await this.library.settled();
    Zotero.Reader._unregisterEventListenerByPluginID(this.id);
    for (const win of Zotero.getMainWindows()) this.removeMenus(win);
    for (const button of this.buttons) button.remove();
    this.buttons.clear();
    await this.runtime.stop();
  },

  /** Report a failed command without terminating the addon. */
  action(task) {
    return task().catch(error => {
      Zotero.logError(error);
      Services.prompt.alert(Zotero.getMainWindow(), "PaperBridge", error.message);
    });
  },

  /** Add single-paper and batch commands to a main window. */
  addMenus(win) {
    if (win.document.getElementById("paperbridge-menu")) return;
    const doc = win.document;
    const menu = doc.createXULElement("menu");
    menu.id = "paperbridge-menu";
    menu.setAttribute("label", "PaperBridge · 论文对照翻译");
    const popup = doc.createXULElement("menupopup");
    for (const [label, command] of [
      ["翻译并分屏", () => this.translate()],
      ["批量翻译所选论文（仅保存）", () => this.tasks.batch()],
      ["任务列表…", async () => this.showTasks()],
      ["打开已有译文分屏", () => this.openExisting()],
      ["取消当前论文翻译", async () => this.cancel((await this.source())?.id)],
      ["设置…", async () => this.settings()]
    ]) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => this.action(command));
      popup.append(item);
    }
    menu.append(popup);
    doc.getElementById("menu_ToolsPopup").append(menu);
    const context = doc.createXULElement("menuitem");
    context.id = "paperbridge-item-menu";
    context.setAttribute("label", "PaperBridge：翻译并分屏");
    context.addEventListener("command", () => this.action(() => this.translate(null, true)));
    doc.getElementById("zotero-itemmenu").append(context);
    const saved = doc.createXULElement("menuitem");
    saved.id = "paperbridge-existing-menu";
    saved.setAttribute("label","PaperBridge：打开已有译文");
    saved.addEventListener("command",() => this.action(() => this.openExisting(null,true)));
    doc.getElementById("zotero-itemmenu").append(saved);
    const batch = doc.createXULElement("menuitem");
    batch.id = "paperbridge-batch-menu";
    batch.setAttribute("label", "PaperBridge：批量翻译所选论文（仅保存）");
    batch.addEventListener("command", () => this.action(() => this.tasks.batch()));
    doc.getElementById("zotero-itemmenu").append(batch);
  },

  /** Remove this addon's commands when a window closes. */
  removeMenus(win) {
    win.document.getElementById("paperbridge-menu")?.remove();
    win.document.getElementById("paperbridge-item-menu")?.remove();
    win.document.getElementById("paperbridge-existing-menu")?.remove();
    win.document.getElementById("paperbridge-batch-menu")?.remove();
  },

  /** Add a compact translation command to PDF toolbars. */
  toolbar({ reader, doc, append }) {
    if (reader._type !== "pdf" || doc.querySelector(".paperbridge-translate")) return;
    const button = doc.createElement("button");
    button.className = "toolbar-button paperbridge-translate";
    button.textContent = "译 / 分屏";
    button.title = "论文翻译并分屏；执行中点击可重新打开任务进度 · 右键打开设置";
    button.style.cssText = "width:auto;padding:0 9px;font-size:12px;white-space:nowrap";
    button.addEventListener("click", () => this.action(() => this.translate(reader)));
    button.addEventListener("contextmenu", event => { event.preventDefault(); this.settings(); });
    this.buttons.add(button);
    append(button);
  },

  /** Open the provider and runtime settings dialog. */
  settings() {
    Zotero.getMainWindow().openDialog("chrome://paperbridge/content/settings.xhtml", "paperbridge-settings",
      "chrome,centerscreen,resizable", { bridge: this });
  },

  /** Focus a source in the shared progress/task view without opening PDF readers. */
  showTasks(sourceID = null, recordID = null) {
    if (this.taskWindow && !this.taskWindow.closed) {
      this.taskWindow.arguments[0].sourceID = sourceID;
      this.taskWindow.arguments[0].recordID = recordID;
      this.taskWindow.focusSource?.(sourceID, recordID);
      this.taskWindow.focus();
      return;
    }
    this.taskWindow = Zotero.getMainWindow().openDialog("chrome://paperbridge/content/tasks.xhtml", "paperbridge-tasks",
      "chrome,centerscreen,resizable", { bridge: this, sourceID, recordID });
  },

  /** Resolve a profile into a non-secret snapshot for newly queued tasks. */
  configuration(profile = this.pref("profile") || "deepseek") {
    const compatible = profile === "compatible";
    return { profile, model: this.pref(compatible ? "compatibleModel" : "model"),
      baseURL: this.pref(compatible ? "compatibleBaseURL" : "baseURL"),
      language: this.pref("language"), pages: this.pref("pages"), capabilities: {
        json_mode: compatible ? this.pref("compatibleJSON") !== false : true,
        thinking_disabled: !compatible,
        // The default output limit matches the existing DeepSeek adapter.
        max_tokens: compatible ? Number(this.pref("compatibleMaxTokens")) || 8192 : 8192
      } };
  },

  /** Reveal the local engine, records and disposable cache directory. */
  async openDataDirectory() {
    await IOUtils.makeDirectory(this.runtime.base,{ignoreExisting:true});
    this.runtime.file(this.runtime.base).launch();
  },

  /** Read a profile's credential only from Zotero's login manager. */
  getKey(profile = this.pref("profile") || "deepseek") {
    const realm = profile === "compatible" ? "OpenAI-compatible" : "DeepSeek";
    return Services.logins.findLogins("chrome://paperbridge", null, realm)[0]?.password || "";
  },

  /** Replace one profile credential without writing it into preferences or tasks. */
  async saveKey(key, profile = this.pref("profile") || "deepseek") {
    const realm = profile === "compatible" ? "OpenAI-compatible" : "DeepSeek";
    const old = Services.logins.findLogins("chrome://paperbridge", null, realm);
    for (const login of old) Services.logins.removeLogin(login);
    if (!key) return;
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("chrome://paperbridge", null, realm, "api-key", key, "", "");
    await Services.logins.addLoginAsync(login);
  },

  /** Call the authenticated loopback backend, starting it lazily if needed. */
  async request(path, method = "GET", data) {
    const {port, token} = await this.runtime.ensure();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || `内置引擎错误 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  },

  /** Resolve the active reader or selected library item's original PDF. */
  async source(reader, fromLibrary = false) {
    const item = await this.selection(reader,fromLibrary);
    return this.sourceForItem(item);
  },

  /** Select one original PDF per paper, excluding generated attachments. */
  async sourceForItem(item) {
    if (item?.isRegularItem()) {
      const attachments = await Zotero.Items.getAsync(item.getAttachments());
      const source = attachments.find(attachment => !attachment.deleted && attachment.isPDFAttachment() && !this.library.isTranslation(attachment));
      return source || null;
    }
    if (item?.isPDFAttachment()) return this.library.isTranslation(item) ? null : item;
    throw new Error("请打开 PDF，或在文献库选择包含 PDF 的论文。");
  },

  /** Prefer the explicit reader unless invoked from a library context menu. */
  async selection(reader, fromLibrary = false) {
    const win = Zotero.getMainWindow();
    reader ||= !fromLibrary && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    return reader ? Zotero.Items.get(reader.itemID) : win.ZoteroPane.getSelectedItems()[0];
  },

  /** Identify a legacy language-specific preference mapping. */
  mappingKey(source) {
    return `translation.${source.libraryID}.${source.key}.${this.pref("language")}`;
  },

  /** Find an already saved result for the currently selected configuration. */
  async existing(source) {
    return this.library.matching(source, this.configuration());
  },

  /** Open a retained outcome even when its source is missing. */
  async openExisting(reader, fromLibrary = false) {
    const selected = await this.selection(reader,fromLibrary);
    const saved = selected && (await this.library.savedFor(selected,this.pref("language")) || await this.library.savedFor(selected));
    if (!saved) throw new Error("没有找到已保存的译文，请先执行翻译。");
    const source = await this.library.item(saved.record.libraryID,saved.record.sourceKey);
    if (source && !source.deleted && await source.fileExists()) await this.split(source,saved.attachment);
    else {
      const opened = await Zotero.Reader.open(saved.attachment.id);
      await opened?._initPromise;
    }
    return saved.attachment;
  },

  /** Reuse the queue/save path, opening a split only for a single-item command. */
  async translate(reader, fromLibrary = false) {
    const source = await this.source(reader, fromLibrary);
    if (!source) return this.openExisting(reader,fromLibrary);
    if (this.readerWaits.has(source.id) || this.tasks.active(source)) return this.showTasks(source.id);
    // Reserve before any further await, including attachment checks and engine startup.
    this.readerWaits.add(source.id);
    try {
      if (!await source.fileExists()) return await this.openExisting(reader,fromLibrary);
      this.showTasks(source.id);
      const config = this.tasks.config();
      const previous = await this.tasks.reviewable(source, config);
      if (this.tasks.active(source)) return this.showTasks(source.id);
      if (previous) return this.showTasks(source.id, previous.recordID);
      const result = await this.tasks.enqueue(source, config);
      if (result.attachment) {
        this.setPref("lastUsage",JSON.stringify({api_requests:0,input_tokens:0,cached_input_tokens:0,
          uncached_input_tokens:0,output_tokens:0,full_pdf_cache:true,model:this.pref("model"),date:new Date().toISOString()}));
        return await this.split(source, result.attachment);
      }
      const attachment = await this.tasks.wait(result.record);
      if (!attachment || !this.alive) return;
      const original = await this.library.item(result.record.libraryID,result.record.sourceKey);
      if (original && !original.deleted && await original.fileExists()) await this.split(original,attachment);
    } finally {
      this.readerWaits.delete(source.id);
    }
  },

  /** Cancel an owner's task without cancelling other owners of a shared PDF. */
  async cancel(sourceID) {
    const record = [...this.library.records].reverse().find(record => record.sourceID === sourceID &&
      !record.detached && !this.tasks.terminal(record.state));
    if (record && this.tasks) await this.tasks.cancel(record);
  },

  /** Check the private reader boundary with an actionable, non-destructive failure. */
  readerView(reader) {
    const view = reader?._internalReader?._primaryView;
    if (!view || !reader._iframe) throw new Error("当前 Zotero 阅读器接口不可用；译文已保存，可直接打开译文附件。");
    return view;
  },

  /** Validate the recorded local sidecar against both current PDF attachments. */
  async loadAlignment(state) {
    const record = [...this.library.records].reverse().find(candidate =>
      candidate.libraryID === state.translated.libraryID && candidate.attachmentKey === state.translated.key &&
      candidate.sourceKey === state.source.key);
    if (!record?.alignmentPath) return { mapping: null, reason: "没有片段映射，继续使用页级同步。" };
    const result = await this.request("/alignment/validate", "POST", {
      mapping_path: record.alignmentPath, source_path: await state.source.getFilePathAsync(),
      output_path: await state.translated.getFilePathAsync()
    });
    if (!result.available) {
      // Mapping failure must explain the downgrade without suggesting a paid retransmission.
      const reasons = { source_hash_changed: "原文已变化，旧片段映射已停用。", output_hash_changed: "译文已变化，旧片段映射已停用。",
        missing_mapping: "没有片段映射，继续使用页级同步。", no_verified_units: "没有可信片段，继续使用页级同步。" };
      result.reason = reasons[result.reason] || "片段映射不可用，仍可正常阅读。";
    }
    return result;
  },

  /** Open paired readers without coupling layout failure to translation saving. */
  async split(source, translated) {
    Zotero.debug("PaperBridge: opening source reader");
    const win = Zotero.getMainWindow();
    let reader = await Zotero.Reader.open(source.id);
    reader ||= Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    await reader._initPromise;
    Zotero.debug("PaperBridge: source reader ready");
    await this.readerView(reader).initializedPromise;
    this.closeSplit(reader.tabID);
    const container = reader._iframe.parentElement;
    const originalStyle = container.getAttribute("style") || "";
    const leftStyle = reader._iframe.getAttribute("style") || "";
    const leftFlex = reader._iframe.getAttribute("flex");
    container.style.cssText += ";display:flex;flex-direction:row;min-width:0;overflow:hidden";
    reader._iframe.style.cssText += ";flex:1 1 0;min-width:160px;width:0";
    const divider = win.document.createXULElement("box");
    divider.style.cssText = "flex:0 0 6px;min-width:6px;cursor:col-resize;background:var(--material-background,#ddd)";
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", "调整原文与译文宽度");
    const browser = win.document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("class", "reader paperbridge-reader");
    browser.setAttribute("flex", "1");
    browser.style.cssText = "flex:1 1 0;min-width:160px;width:0";
    const state = { reader, source, translated, browser, divider, container, originalStyle, leftStyle, leftFlex, cleanups: [], sync: true, active: 0 };
    this.splits.set(reader.tabID, state);
    const loaded = new Promise(resolve => browser.addEventListener("load", event => {
      if (event.target === browser.contentDocument) resolve();
    }, { capture: true }));
    browser.setAttribute("src", "resource://zotero/reader/reader.html");
    container.append(divider, browser);
    try {
      await loaded;
      Zotero.debug("PaperBridge: translation reader frame loaded");
      const frame = browser.contentWindow;
      frame.addEventListener("error", event => Zotero.logError(event.error || event.message));
      const bytes = await IOUtils.read(await translated.getFilePathAsync());
      const ftl = [];
      for (const locale of [...Services.locale.appLocalesAsBCP47].reverse()) {
        for (const name of ["branding/brand", "zotero", "reader"]) {
          const url = `resource://app/localization/${locale}/${name}.ftl`;
          try { ftl.push(Zotero.File.getContentsFromURL(url)); } catch (error) { Zotero.debug(`PaperBridge locale unavailable: ${url}`); }
        }
      }
      const options = {
        type: "pdf", data: { buf: bytes }, annotations: [], readOnly: true,
        primaryViewState: { pageIndex: reader._internalReader._state.primaryViewState?.pageIndex || 0, scale: "page-width" },
        sidebarOpen: false, sidebarWidth: 200, showContextPaneToggle: false,
        bottomPlaceholderHeight: null, rtl: Zotero.rtl, fontSize: Zotero.Prefs.get("fontSize"),
        ftl, showAnnotations: false, enableReadAloud: false,
        onChangeViewState() {}, onChangeViewStats() {}, onSaveAnnotations() {}, onDeleteAnnotations() {},
        onSaveCustomThemes() {}, onSetLightTheme() {}, onSetDarkTheme() {},
        onOpenLink: url => Zotero.launchURL(url),
        onOpenContextMenu: () => {}, onSetDataTransferAnnotations: () => {},
        onToggleSidebar: () => {}, onChangeSidebarWidth: () => {}, onChangeSidebarView: () => {},
        onTextSelectionAnnotationModeChange: () => {}, onToolbarShiftTab: () => {}, onIframeTab: () => {},
        onConfirm: (title, text) => Services.prompt.confirm(win, title, text)
      };
      state.right = frame.wrappedJSObject.createReader(Components.utils.cloneInto(options, frame, { cloneFunctions: true }));
      Zotero.debug("PaperBridge: translation reader created");
      state.right.setTitle("译文 · " + translated.getField("title"));
      await state.right._primaryView.initializedPromise;
      if (!this.splits.has(reader.tabID)) return;
      this.splitControls(state, frame.document);
      this.bindSync(state);
      const leftApp = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
      const rightApp = state.right._primaryView._iframeWindow.PDFViewerApplication;
      leftApp.pdfViewer.currentScaleValue = "page-width";
      rightApp.pdfViewer.currentScaleValue = "page-width";
      this.syncPosition(state, 0);
    } catch (error) {
      this.closeSplit(reader.tabID);
      throw error;
    }
  },

  /** Add independent-reading controls and bounded divider resizing. */
  splitControls(state, doc) {
    // Keep navigation and search usable when each pane is narrower than a full reader.
    for (const target of [state.reader._iframeWindow.document, doc]) {
      const style = target.createElement("style");
      style.textContent = "@media (max-width:700px){.toolbar .center.tools{display:none!important}.toolbar #read-aloud,.toolbar #navigateBack{display:none!important}.toolbar .start{gap:2px!important}.toolbar .divider{margin:0 2px!important}}";
      target.head.append(style);
      state.cleanups.push(() => style.remove());
    }
    const controls = doc.createElement("div");
    controls.style.cssText = "position:fixed;bottom:14px;right:18px;z-index:1000;display:flex;gap:5px;padding:5px;border:1px solid #ccc;border-radius:7px;background:var(--material-background,#fff);box-shadow:0 2px 12px #0002";
    const sync = doc.createElement("button");
    sync.textContent = "⇄ 同步开启";
    sync.setAttribute("aria-pressed", "true");
    sync.addEventListener("click", () => {
      state.sync = !state.sync;
      sync.textContent = state.sync ? "⇄ 同步开启" : "⇄ 独立滚动";
      sync.setAttribute("aria-pressed", String(state.sync));
      if (state.sync) this.syncPosition(state, state.active);
    });
    const close = doc.createElement("button");
    close.textContent = "关闭分屏";
    close.addEventListener("click", () => this.closeSplit(state.reader.tabID));
    for (const button of [sync, close]) button.style.cssText = "font:13px 'Songti SC','SimSun',serif;padding:5px 8px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer";
    controls.append(sync, close);
    // Missing maps disable only explicit localization; ordinary reading remains unchanged.
    state.alignment = new FragmentAlignment({ loadMapping: split => this.loadAlignment(split) });
    controls.append(state.alignment.attach(state));
    doc.body.append(controls);
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      state.cleanups.push(() => target.removeEventListener(type, handler, options));
    };
    let dragging = false;
    listen(state.divider, "pointerdown", event => {
      dragging = true;
      state.divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    listen(state.divider, "pointermove", event => {
      if (!dragging) return;
      const box = state.container.getBoundingClientRect();
      const ratio = Math.max(0.2, Math.min(0.8, (event.clientX - box.left) / box.width));
      // XUL browser flex attributes set integer relative weights, overriding CSS-only sizing.
      const weightScale = 100;
      state.reader._iframe.setAttribute("flex", String(Math.round(ratio * weightScale)));
      state.browser.setAttribute("flex", String(Math.round((1 - ratio) * weightScale)));
      state.reader._iframe.style.setProperty("flex", `${ratio} 1 0px`);
      state.browser.style.setProperty("flex", `${1 - ratio} 1 0px`);
    });
    listen(state.divider, "pointerup", () => { dragging = false; });
    listen(state.divider, "lostpointercapture", () => { dragging = false; });
  },

  /** Register bidirectional page-coordinate synchronization and its cleanup callbacks. */
  bindSync(state) {
    const views = [this.readerView(state.reader), state.right._primaryView];
    state.frames = views.map(view => view._iframeWindow);
    state.apps = views.map(view => view._iframeWindow.PDFViewerApplication);
    views.forEach((view, index) => {
      const frame = view._iframeWindow;
      for (const target of [frame, index === 0 ? state.reader._iframeWindow : state.browser.contentWindow]) {
        for (const event of ["pointerdown", "wheel", "keydown"]) {
          const activate = () => { state.active = index; };
          target.addEventListener(event, activate, { capture: true, passive: true });
          state.cleanups.push(() => target.removeEventListener(event, activate, true));
        }
      }
      const handler = event => {
        if (Date.now() < (state.alignmentNavigationUntil || 0)) return;
        if (state.sync && state.active === index) this.syncPosition(state, index, event.location);
      };
      const bus = state.apps[index].eventBus;
      bus.on("updateviewarea", handler);
      state.cleanups.push(() => bus.off("updateviewarea", handler));
    });
  },

  /** Transfer page coordinates only; this is not paragraph alignment. */
  syncPosition(state, index, viewLocation) {
    if (!state.apps) return;
    const source = state.apps[index].pdfViewer;
    const target = state.apps[1 - index].pdfViewer;
    const location = viewLocation || source._location;
    if (!location) return;
    // BabelDOC preserves page dimensions and page order, so PDF coordinates align.
    if (target.currentScaleValue !== source.currentScaleValue) target.currentScaleValue = source.currentScaleValue;
    const destination = { pageNumber: Math.min(location.pageNumber, target.pagesCount),
      destArray: [null, { name: "XYZ" }, location.left, location.top, null], allowNegativeOffset: true };
    target.scrollPageIntoView(Components.utils.cloneInto(destination, state.frames[1 - index]));
  },

  /** Dispose every reader hook even if one private cleanup API has changed. */
  closeSplit(tabID) {
    const state = this.splits.get(tabID);
    if (!state) return;
    this.splits.delete(tabID);
    const cleanups = [...state.cleanups, () => state.right?._primaryView?.destroy(),
      () => state.browser.remove(), () => state.divider.remove(),
      () => state.container.setAttribute("style", state.originalStyle),
      () => state.reader._iframe.setAttribute("style", state.leftStyle),
      () => state.leftFlex === null ? state.reader._iframe.removeAttribute("flex")
        : state.reader._iframe.setAttribute("flex", state.leftFlex)];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (error) { Zotero.logError(error); }
    }
  }
};
