/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils */
var PaperBridge = {
  jobs: new Map(),
  splits: new Map(),
  buttons: new Set(),
  alive: true,

  pref(name) { return Zotero.Prefs.get("extensions.paperbridge." + name, true); },
  setPref(name, value) { Zotero.Prefs.set("extensions.paperbridge." + name, value, true); },
  async start(id) {
    this.id = id;
    this.storageRoot = PathUtils.join(Zotero.DataDirectory.dir,"storage");
    this.setPref("model", "deepseek-flash");
    await this.library.load();
    this.toolbarHandler = event => this.toolbar(event);
    this.contextHandler = ({ reader, append }) => {
      if (reader._type !== "pdf") return;
      append({ label: "DeepSeek 翻译并分屏", onCommand: () => this.action(() => this.translate(reader)) });
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
    for (const reader of Zotero.Reader._readers) {
      await reader._initPromise;
      const doc = reader._iframeWindow.document;
      const host = doc.querySelector(".toolbar .end");
      if (host && !doc.querySelector(".paperbridge-translate")) {
        this.toolbar({ reader, doc, append: node => host.append(node) });
      }
    }
  },

  async stop() {
    this.alive = false;
    await Promise.allSettled([...this.jobs.keys()].map(id => this.cancel(id)));
    for (const tab of [...this.splits.keys()]) this.closeSplit(tab);
    Zotero.Notifier.unregisterObserver(this.notifier);
    await this.library.settled();
    Zotero.Reader._unregisterEventListenerByPluginID(this.id);
    for (const win of Zotero.getMainWindows()) this.removeMenus(win);
    for (const button of this.buttons) button.remove();
    this.buttons.clear();
    await this.runtime.stop();
  },

  action(task) {
    return task().catch(error => {
      Zotero.logError(error);
      Services.prompt.alert(Zotero.getMainWindow(), "PaperBridge", error.message);
    });
  },

  addMenus(win) {
    if (win.document.getElementById("paperbridge-menu")) return;
    const doc = win.document;
    const menu = doc.createXULElement("menu");
    menu.id = "paperbridge-menu";
    menu.setAttribute("label", "PaperBridge · 论文对照翻译");
    const popup = doc.createXULElement("menupopup");
    for (const [label, command] of [
      ["DeepSeek 翻译并分屏", () => this.translate()],
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
    context.setAttribute("label", "DeepSeek 翻译并分屏");
    context.addEventListener("command", () => this.action(() => this.translate(null, true)));
    doc.getElementById("zotero-itemmenu").append(context);
    const saved = doc.createXULElement("menuitem");
    saved.id = "paperbridge-existing-menu";
    saved.setAttribute("label","PaperBridge：打开已有译文");
    saved.addEventListener("command",() => this.action(() => this.openExisting(null,true)));
    doc.getElementById("zotero-itemmenu").append(saved);
  },

  removeMenus(win) {
    win.document.getElementById("paperbridge-menu")?.remove();
    win.document.getElementById("paperbridge-item-menu")?.remove();
    win.document.getElementById("paperbridge-existing-menu")?.remove();
  },

  toolbar({ reader, doc, append }) {
    if (reader._type !== "pdf" || doc.querySelector(".paperbridge-translate")) return;
    const button = doc.createElement("button");
    button.className = "toolbar-button paperbridge-translate";
    button.textContent = "译 / 分屏";
    button.title = "DeepSeek 全文翻译并分屏 · 右键打开设置";
    button.style.cssText = "width:auto;padding:0 9px;font-size:12px;white-space:nowrap";
    button.addEventListener("click", () => this.action(() => this.translate(reader)));
    button.addEventListener("contextmenu", event => { event.preventDefault(); this.settings(); });
    this.buttons.add(button);
    append(button);
  },

  settings() {
    Zotero.getMainWindow().openDialog("chrome://paperbridge/content/settings.xhtml", "paperbridge-settings",
      "chrome,centerscreen,resizable", { bridge: this });
  },

  async openDataDirectory() {
    await IOUtils.makeDirectory(this.runtime.base,{ignoreExisting:true});
    this.runtime.file(this.runtime.base).launch();
  },

  getKey() {
    return Services.logins.findLogins("chrome://paperbridge", null, "DeepSeek")[0]?.password || "";
  },

  async saveKey(key) {
    const old = Services.logins.findLogins("chrome://paperbridge", null, "DeepSeek");
    for (const login of old) Services.logins.removeLogin(login);
    if (!key) return;
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("chrome://paperbridge", null, "DeepSeek", "api-key", key, "", "");
    await Services.logins.addLoginAsync(login);
  },

  async request(path, method = "GET", data) {
    const {port, token} = await this.runtime.ensure();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `内置引擎错误 ${response.status}`);
    return result;
  },

  async source(reader, fromLibrary = false) {
    const item = await this.selection(reader,fromLibrary);
    if (item?.isRegularItem()) {
      const attachments = await Zotero.Items.getAsync(item.getAttachments());
      const source = attachments.find(attachment => attachment.isPDFAttachment() && !this.library.isTranslation(attachment));
      return source || null;
    }
    if (item?.isPDFAttachment()) return this.library.isTranslation(item) ? null : item;
    throw new Error("请打开 PDF，或在文献库选择包含 PDF 的论文。");
  },

  async selection(reader, fromLibrary = false) {
    const win = Zotero.getMainWindow();
    reader ||= !fromLibrary && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    return reader ? Zotero.Items.get(reader.itemID) : win.ZoteroPane.getSelectedItems()[0];
  },

  mappingKey(source) {
    return `translation.${source.libraryID}.${source.key}.${this.pref("language")}`;
  },

  async existing(source) {
    return this.library.matching(source,{language:this.pref("language"),model:this.pref("model"),baseURL:this.pref("baseURL"),pages:this.pref("pages")});
  },

  async openExisting(reader, fromLibrary = false) {
    const selected = await this.selection(reader,fromLibrary);
    const saved = selected && await this.library.savedFor(selected,this.pref("language"));
    if (!saved) throw new Error("没有找到已保存的译文，请先执行翻译。");
    const source = await this.library.item(saved.record.libraryID,saved.record.sourceKey);
    if (source && !source.deleted && await source.fileExists()) await this.split(source,saved.attachment);
    else {
      const opened = await Zotero.Reader.open(saved.attachment.id);
      await opened?._initPromise;
    }
    return saved.attachment;
  },

  async translate(reader, fromLibrary = false) {
    const source = await this.source(reader, fromLibrary);
    if (!source || !await source.fileExists()) return this.openExisting(reader,fromLibrary);
    if (this.jobs.has(source.id)) throw new Error("这篇论文正在翻译，可从 PaperBridge 菜单取消。");
    const existing = await this.existing(source);
    if (existing) {
      this.setPref("lastUsage",JSON.stringify({api_requests:0,input_tokens:0,cached_input_tokens:0,
        uncached_input_tokens:0,output_tokens:0,full_pdf_cache:true,model:this.pref("model"),date:new Date().toISOString()}));
      return this.split(source, existing);
    }
    if (!this.getKey()) { this.settings(); return; }
    await this.request("/health");
    const path = await source.getFilePathAsync();
    if (!path) throw new Error("请先下载此 PDF 附件。");
    const originalStat = await IOUtils.stat(path);
    const config = { model: this.pref("model"), baseURL: this.pref("baseURL"),
      language: this.pref("language"), pages: this.pref("pages") };
    const job = await this.request("/jobs", "POST", { source_path: path, api_key: this.getKey(),
      model: config.model, base_url: config.baseURL, lang_out: config.language, pages: config.pages });
    this.jobs.set(source.id, job.id);
    const record = await this.library.put(source,null,config,job,originalStat);
    const progress = new Zotero.ProgressWindow({ closeOnClick: true });
    progress.changeHeadline("PaperBridge · DeepSeek 翻译");
    const line = new progress.ItemProgress("chrome://zotero/skin/attachment-pdf.png", "准备翻译…");
    progress.show();
    progress.addDescription("保留公式、图片和表格结构。可在工具菜单中取消翻译。");
    try {
      let status = job;
      while (this.alive && !["done", "failed", "cancelled"].includes(status.state)) {
        line.setText(`${Math.round(status.progress)}% · ${status.stage}`);
        line.setProgress(status.progress);
        await Zotero.Promise.delay(1200);
        status = await this.request(`/jobs/${job.id}`);
      }
      if (!this.alive || status.state === "cancelled") { line.setText("已取消翻译"); return; }
      if (status.state === "failed") throw new Error(status.error);
      if (!await this.library.ownerAlive(record)) { line.setText("论文条目已删除，译文任务已清理"); return; }
      const usage = status.cached ? { api_requests:0,input_tokens:0,cached_input_tokens:0,
        uncached_input_tokens:0,output_tokens:0,full_pdf_cache:true } : status.usage;
      if (usage) this.setPref("lastUsage",JSON.stringify({ ...usage,model:config.model,date:new Date().toISOString() }));
      line.setText("正在保存译文并打开分屏…");
      const attachment = await Zotero.Attachments.importFromFile({
        file: status.output_path, libraryID:record.libraryID, parentItemID:record.parentKey ? record.ownerID : undefined
      });
      attachment.setField("title", `译文 · ${config.language} · ${record.title}`);
      attachment.addRelation("dc:relation",record.sourceURI);
      await attachment.saveTx();
      await this.library.attach(record,attachment);
      line.setProgress(100);
      line.setText(usage ? `已保存译文 · ${usage.api_requests} 次 API · 未命中 ${usage.uncached_input_tokens} token` : "翻译完成 · 已保存为 PDF 附件");
      const original = await this.library.item(record.libraryID,record.sourceKey);
      if (original && !original.deleted && await original.fileExists()) await this.split(original,attachment);
    } finally {
      this.jobs.delete(source.id);
      progress.startCloseTimer(5000);
    }
  },

  async cancel(sourceID) {
    const job = this.jobs.get(sourceID);
    if (job) await this.request(`/jobs/${job}/cancel`, "POST", {});
  },

  async split(source, translated) {
    Zotero.debug("PaperBridge: opening source reader");
    const win = Zotero.getMainWindow();
    let reader = await Zotero.Reader.open(source.id);
    reader ||= Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    await reader._initPromise;
    Zotero.debug("PaperBridge: source reader ready");
    await reader._internalReader._primaryView.initializedPromise;
    this.closeSplit(reader.tabID);
    const container = reader._iframe.parentElement;
    const originalStyle = container.getAttribute("style") || "";
    const leftStyle = reader._iframe.getAttribute("style") || "";
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
    const state = { reader, browser, divider, container, originalStyle, leftStyle, cleanups: [], sync: true, active: 0 };
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
      state.reader._iframe.style.flex = `${ratio} 1 0`;
      state.browser.style.flex = `${1 - ratio} 1 0`;
    });
    listen(state.divider, "pointerup", () => { dragging = false; });
    listen(state.divider, "lostpointercapture", () => { dragging = false; });
  },

  bindSync(state) {
    const views = [state.reader._internalReader._primaryView, state.right._primaryView];
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
        if (state.sync && state.active === index) this.syncPosition(state, index, event.location);
      };
      const bus = state.apps[index].eventBus;
      bus.on("updateviewarea", handler);
      state.cleanups.push(() => bus.off("updateviewarea", handler));
    });
  },

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

  closeSplit(tabID) {
    const state = this.splits.get(tabID);
    if (!state) return;
    this.splits.delete(tabID);
    for (const cleanup of state.cleanups) cleanup();
    state.right?._primaryView?.destroy();
    state.browser.remove();
    state.divider.remove();
    state.container.setAttribute("style", state.originalStyle);
    state.reader._iframe.setAttribute("style", state.leftStyle);
  }
};
