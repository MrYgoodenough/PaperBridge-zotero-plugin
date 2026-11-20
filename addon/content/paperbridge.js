/** Zotero commands and paired PDF reading; task execution lives in tasks.js. */
/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils, TranslationTasks, TranslationReader, FragmentAlignment, Components, rootURI */
// One bridge is shared by all Zotero windows in the addon scope.
var PaperBridge = {
  jobs: new Map(),
  // Only the initiating reader command may wait and auto-open its saved result.
  readerWaits: new Set(),
  splits: new Map(),
  // Concurrent close commands share the same final-save and disposal operation.
  closingSplits: new Map(),
  // Reopening an attachment waits for the previous pane's final native annotation write.
  annotationWrites: new Map(),
  buttons: new Set(),
  alive: true,

  /** Read one addon preference. */
  pref(name) { return Zotero.Prefs.get("extensions.paperbridge." + name, true); },
  /** Store one non-secret addon preference. */
  setPref(name, value) { Zotero.Prefs.set("extensions.paperbridge." + name, value, true); },
  /** Ask for explicit consent before a settings action can contact a provider. */
  confirm(message) { return Services.prompt.confirm(Zotero.getMainWindow(), "PaperBridge", message); },
  /** Initialize durable tasks and register Zotero UI entry points. */
  async start(id) {
    this.id = id;
    this.storageRoot = PathUtils.join(Zotero.DataDirectory.dir,"storage");
    this.alive = true;
    await this.library.load();
    try { await this.formulaCache?.load(); }
    catch (error) { this.warn("公式缓存暂不可用，翻译和已有 PDF 阅读不受影响。", error); }
    this.tasks = new TranslationTasks(this);
    /** Resume retained local work without submitting a new translation. */
    this.runtime.terms.onAccepted = () => {
      if (!this.alive) return;
      // Merely accepting from settings need not start an engine in a fresh library.
      if (this.library.records.some(record => record.retryPendingSince || record.fingerprint && record.saveState !== "imported")) {
        this.tasks.monitor();
      }
      this.library.schedule();
    };
    await this.tasks.resume();
    this.toolbarHandler = event => {
      this.toolbar(event);
      this.formulas?.attach(event.reader).catch(error => Zotero.logError(error));
    };
    this.contextHandler = ({ reader, append }) => {
      if (reader._type !== "pdf" || reader._paperbridgeEmbedded) return;
      append({ label: "PaperBridge 翻译并分屏", onCommand: () => this.action(() => this.translate(reader)) });
      append({ label: "PaperBridge：打开已有译文", onCommand: () => this.action(() => this.openExisting(reader)) });
      append({ label: "PaperBridge：取消翻译", onCommand: () => this.action(() => this.cancel(reader.itemID)) });
    };
    Zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, id);
    Zotero.Reader.registerEventListener("createViewContextMenu", this.contextHandler, id);
    this.formulaPopupHandler = event => this.formulas?.popup(event);
    this.formulaMenuHandler = event => this.formulas?.menu(event);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.formulaPopupHandler, id);
    Zotero.Reader.registerEventListener("createViewContextMenu", this.formulaMenuHandler, id);
    this.observer = {
      notify: (event, type, ids) => {
        if (type === "tab" && event === "close") ids.forEach(tab => this.closeSplit(tab));
        if (type === "item" && ["add","trash","delete","modify"].includes(event)) {
          // Library scheduling crosses the transaction boundary before cache ownership queries.
          this.formulaReconcile = this.library.schedule().then(() => this.formulaCache?.reconcile())
            .catch(error => Zotero.logError(error));
        }
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
        await this.formulas?.attach(reader);
      } catch (error) {
        // Private reader changes must not disable the library queue or saved artifacts.
        Zotero.logError(error);
      }
    }
  },

  /** Release readers and leave backend interruptions available for explicit recovery. */
  async stop() {
    this.alive = false;
    const errors = [];
    /** Continue shutdown when one optional window, native reader or write fails. */
    const settle = async task => {
      try { await task(); }
      catch (error) { errors.push(error); Zotero.logError(error); }
    };
    await settle(() => { this.runtime.terms.onAccepted = null; this.runtime.terms.window?.close(); });
    await settle(() => this.taskWindow?.close());
    await settle(() => this.formulaCacheWindow?.close());
    // The backend records interrupted work on shutdown; never silently resubmit it.
    await settle(() => this.tasks?.refreshing);
    // Invoke all closes before awaiting so every live frame can supply its final snapshot.
    await Promise.all([...this.splits.keys()].map(tab => settle(() => this.closeSplit(tab))));
    await settle(() => Promise.allSettled([...this.closingSplits.values(), ...this.annotationWrites.values()]));
    await settle(() => this.formulas?.stop());
    await settle(() => Zotero.Notifier.unregisterObserver(this.notifier));
    await settle(() => this.library.settled());
    await settle(() => this.formulaReconcile);
    await settle(() => this.formulaCache?.settled());
    await settle(() => Zotero.Reader._unregisterEventListenerByPluginID(this.id));
    for (const win of Zotero.getMainWindows()) await settle(() => this.removeMenus(win));
    for (const button of this.buttons) await settle(() => button.remove());
    this.buttons.clear();
    await settle(() => this.runtime.stop());
    if (errors.length) this.warn("停用时部分资源未能正常保存或关闭；其他清理已继续。", errors[0]);
  },

  /** Warn about an optional failure without rejecting basic translation or reading. */
  warn(message, error) {
    Zotero.logError(error);
    const win = Zotero.getMainWindow();
    try { if (win && !win.closed) Services.prompt.alert(win, "PaperBridge", message + "\n" + error.message); }
    catch (displayError) { Zotero.logError(displayError); }
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
      ["公式缓存…", async () => this.showFormulaCache()],
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
    if (reader._type !== "pdf" || reader._paperbridgeEmbedded || doc.querySelector(".paperbridge-translate")) return;
    const button = doc.createElement("button");
    button.className = "toolbar-button paperbridge-translate";
    button.textContent = "翻译";
    button.title = "论文翻译并分屏；执行中点击可重新打开任务进度 · 右键打开设置";
    button.style.cssText = "width:auto;padding:0 10px;font:12px system-ui,sans-serif;white-space:nowrap";
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

  /** Reuse the local formula cache dialog without starting the engine or a provider. */
  showFormulaCache() {
    if (this.formulaCacheWindow && !this.formulaCacheWindow.closed) {
      this.formulaCacheWindow.focus();
      return this.formulaCacheWindow;
    }
    this.formulaCacheWindow = Zotero.getMainWindow().openDialog("chrome://paperbridge/content/formula-cache.xhtml", "paperbridge-formula-cache",
      "chrome,centerscreen,resizable", { bridge: this });
    return this.formulaCacheWindow;
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

  /** Export safe diagnostics locally when the authenticated bridge is unavailable. */
  async exportDiagnostics() {
    if (!this.LocalDiagnostics) {
      const scope = { Zotero, Services, Cc, Ci, IOUtils, PathUtils };
      Services.scriptloader.loadSubScript(rootURI + "content/diagnostics.js", scope);
      this.LocalDiagnostics = scope.LocalDiagnostics;
    }
    try {
      const result = await this.request("/diagnostics", "POST", {
        startup: this.LocalDiagnostics.startup(this.runtime.diagnosticEvents)
      }, { interactive: false });
      return { ...result, source: "bridge" };
    } catch (_) {
      // The fallback exports no exception text and never resubmits a translation.
      return this.LocalDiagnostics.create(this.runtime, this.library.records);
    }
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
    if (!key) {
      // Clearing is explicit; replacement must never erase the previous value first.
      for (const login of old) Services.logins.removeLogin(login);
      return;
    }
    if (old.length) {
      const changed = old[0].clone();
      changed.password = key;
      // The native update preserves the old login if validation or persistence fails.
      Services.logins.modifyLogin(old[0], changed);
      return;
    }
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init("chrome://paperbridge", null, realm, "api-key", key, "", "");
    await Services.logins.addLoginAsync(login);
  },

  /** Call the authenticated loopback backend, starting it lazily if needed. */
  async request(path, method = "GET", data, options) {
    const {port, token} = await this.runtime.ensure(options);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error([result.error || `内置引擎错误 ${response.status}`, result.hint].filter(Boolean).join("\n"));
      error.status = response.status;
      error.code = result.code;
      error.hint = result.hint;
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

  /** Open downloaded outcomes or synced pairs without contacting a model or requiring Python. */
  async openExisting(reader, fromLibrary = false) {
    const selected = await this.selection(reader,fromLibrary);
    const local = selected && (await this.library.savedFor(selected,this.pref("language")) || await this.library.savedFor(selected));
    const candidates = selected && this.alignmentAssets ? await this.alignmentAssets.savedPairs(selected) : [];
    if (local && !candidates.some(pair => pair.attachment.key === local.attachment.key && pair.record.sourceKey === local.record.sourceKey)) {
      candidates.unshift(local);
    }
    let saved = candidates[0];
    if (candidates.length > 1) {
      const choice = {value:0};
      const labels = candidates.map(pair => (pair.attachment.getField("title") || pair.attachment.key)
        + " · " + pair.record.sourceKey + " → " + pair.attachment.key);
      if (!Services.prompt.select(Zotero.getMainWindow(), "选择已有译本", "多个译本保留各自映射，请选择要打开的附件。",
        labels.length, labels, choice)) return null;
      saved = candidates[choice.value];
    }
    if (!saved && selected?.isPDFAttachment() && this.library.isTranslation(selected)) {
      if (!await selected.fileExists()) throw new Error("译文附件尚未下载，请先在 Zotero 中下载；不会重新翻译。");
      const opened = await Zotero.Reader.open(selected.id);
      await opened?._initPromise;
      return selected;
    }
    if (!saved) throw new Error("没有找到已保存的译文或可同步映射；请先下载已有附件，不会自动重新翻译。");
    if (!await saved.attachment.fileExists()) throw new Error("译文附件尚未下载，请先在 Zotero 中下载；不会重新翻译。");
    const source = saved.source || await this.library.item(saved.record.libraryID,saved.record.sourceKey);
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

  /** Read and rehash local/synced geometry with Gecko; reading never starts the translation engine. */
  async loadAlignment(state) {
    const record = [...this.library.records].reverse().find(candidate =>
      candidate.libraryID === state.translated.libraryID && candidate.attachmentKey === state.translated.key &&
      candidate.sourceKey === state.source.key);
    if (!this.alignmentAssets) return { mapping:null, reason:"映射读取接口不可用，继续使用页级同步。" };
    return this.alignmentAssets.load(state, record);
  },

  /** Reuse an open pair, replacing the right reader only for a different translation. */
  async split(source, translated) {
    try { await this.formulaCache?.link(source, translated); }
    catch (error) { this.warn("公式缓存配对未能保存；PDF 分屏仍可使用。", error); }
    Zotero.debug("PaperBridge: opening source reader");
    const win = Zotero.getMainWindow();
    let reader = await Zotero.Reader.open(source.id);
    // Reader.open can return undefined for a restored tab; never pair an unrelated selected PDF.
    reader ||= Zotero.Reader._readers?.find(opened => opened.itemID === source.id);
    if (!reader) throw new Error("原文阅读器未能打开；译文已保存，可直接打开译文附件后重试。");
    await reader._initPromise;
    Zotero.debug("PaperBridge: source reader ready");
    await this.readerView(reader).initializedPromise;
    const existing = this.splits.get(reader.tabID);
    if (existing?.reader === reader && existing.source.id === source.id
      && existing.translated.id === translated.id) {
      // Repeated commands share initialization and preserve both panes' reading state.
      await existing.ready;
      return;
    }
    await this.closeSplit(reader.tabID);
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
    // Zotero manages only ReaderTab browsers; an inactive sibling releases rendered PDF pages.
    browser.docShellIsActive = reader._iframe.docShellIsActive !== false;
    /** Keep the embedded PDF responsive while its host tab is selected. */
    const onTabSelection = event => {
      if (!state.closing) browser.docShellIsActive = !!event.detail.selected;
    };
    container.addEventListener("tab-selection-change", onTabSelection);
    state.cleanups.push(() => container.removeEventListener("tab-selection-change", onTabSelection));
    state.ready = this.loadSplit(state, loaded, win);
    await state.ready;
  },

  /** Show a nonfatal translated-annotation error without closing either PDF. */
  annotationMessage(state, error) {
    if (this.splits.get(state.reader.tabID) !== state) {
      // A final save failure still needs a visible warning after its pane closes.
      this.warn("译文批注或阅读状态未能保存：", error);
      return;
    }
    const doc = state.browser.contentWindow?.document;
    if (!doc?.createElement) return;
    let message = state.annotationMessage;
    if (!message) {
      message = doc.createElement("div");
      message.setAttribute("role", "alert");
      message.style.cssText = "position:fixed;top:45px;left:8px;right:8px;z-index:1000;padding:6px;background:var(--material-background,#fff);border:1px solid #c66;font-size:12px";
      doc.body.append(message);
      state.annotationMessage = message;
      state.cleanups.push(() => message.remove());
    }
    message.textContent = "译文批注暂不可写；PDF 仍可阅读：" + error.message;
  },

  /** Lazily load the legacy single-owner adapter when the native contract is unavailable. */
  async translatedAnnotationOptions(state, frame) {
    await this.annotationWrites.get(state.translated.id);
    if (this.splits.get(state.reader.tabID) !== state) return {};
    try {
      if (!Zotero.Annotations?.saveFromJSON) throw new Error("Zotero annotation API unavailable");
      if (!this.AnnotationController) {
        const scope = { Zotero, Components };
        Services.scriptloader.loadSubScript(rootURI + "content/annotations.js", scope);
        this.AnnotationController = scope.TranslationAnnotations;
      }
      if (!this.AnnotationController.supported(state.translated)) {
        throw new Error("Zotero annotation attachment API unavailable");
      }
      state.annotations = new this.AnnotationController(state.translated, frame,
        error => this.annotationMessage(state, error));
      return state.annotations.options(await state.annotations.load());
    } catch (error) {
      // An unavailable reader contract must not break translation, tasks, or basic reading.
      Zotero.debug("PaperBridge: translated annotations unavailable: " + error);
      if (state.annotations) state.annotations.failed = true;
      this.annotationMessage(state, error);
      return { readOnly: true, showAnnotations: false };
    }
  },

  /** Create the existing compatibility reader only after native resources are released. */
  async loadLegacySplit(state, frame, win) {
    const { reader, translated } = state;
    const bytes = await IOUtils.read(await translated.getFilePathAsync());
    if (this.splits.get(reader.tabID) !== state) return;
    const ftl = [];
    for (const locale of [...Services.locale.appLocalesAsBCP47].reverse()) {
      for (const name of ["branding/brand", "zotero", "reader"]) {
        const url = `resource://app/localization/${locale}/${name}.ftl`;
        try { ftl.push(Zotero.File.getContentsFromURL(url)); } catch (error) { Zotero.debug(`PaperBridge locale unavailable: ${url}`); }
      }
    }
    const annotationOptions = await this.translatedAnnotationOptions(state, frame);
    if (this.splits.get(reader.tabID) !== state) return;
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
      onConfirm: (title, text) => Services.prompt.confirm(win, title, text),
      ...annotationOptions
    };
    state.right = frame.wrappedJSObject.createReader(Components.utils.cloneInto(options, frame, { cloneFunctions: true }));
    state.annotations?.connect(state.right);
    Zotero.debug("PaperBridge: translation reader created");
    state.right.setTitle("译文 · " + translated.getField("title"));
    await state.right._primaryView.initializedPromise;
  },

  /** Initialize only the still-current pair, without letting stale work close its replacement. */
  async loadSplit(state, loaded, win) {
    const { reader, translated, browser } = state;
    try {
      await loaded;
      if (this.splits.get(reader.tabID) !== state) return;
      Zotero.debug("PaperBridge: translation reader frame loaded");
      const frame = browser.contentWindow;
      const onError = event => Zotero.logError(event.error || event.message);
      frame.addEventListener("error", onError);
      state.cleanups.push(() => frame.removeEventListener?.("error", onError));
      await this.annotationWrites.get(translated.id);
      if (this.splits.get(reader.tabID) !== state) return;
      if (typeof TranslationReader !== "undefined" && TranslationReader.supported(state, translated)) {
        try {
          await TranslationReader.open(this, state, translated);
        } catch (error) {
          if (this.splits.get(reader.tabID) !== state) throw error;
          this.formulas?.detach(state.translationReader);
          try { await TranslationReader.close(state); }
          catch (closeError) { Zotero.logError(closeError); }
          if (this.splits.get(reader.tabID) !== state) return;
          delete state.translationReader;
          delete state.nativeOpening;
          state.right = null;
          state.closing = false;
          this.warn("原生译文阅读器接口暂不可用，已切换兼容阅读模式。", error);
        }
      }
      if (this.splits.get(reader.tabID) !== state) return;
      if (!state.translationReader) await this.loadLegacySplit(state, frame, win);
      if (this.splits.get(reader.tabID) !== state) return;
      if (state.translationReader) {
        try { await this.formulas?.attach(state.translationReader); }
        catch (error) { Zotero.logError(error); }
      }
      if (this.splits.get(reader.tabID) !== state) return;
      this.splitControls(state, frame.document);
      this.bindSync(state);
      const leftApp = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
      const rightApp = state.right._primaryView._iframeWindow.PDFViewerApplication;
      leftApp.pdfViewer.currentScaleValue = "page-width";
      rightApp.pdfViewer.currentScaleValue = "page-width";
      this.syncPosition(state, 0);
    } catch (error) {
      if (this.splits.get(reader.tabID) === state) await this.closeSplit(reader.tabID);
      throw error;
    }
  },

  /** Add independent-reading controls and bounded divider resizing. */
  splitControls(state, doc) {
    // Keep navigation and search usable when each pane is narrower than a full reader.
    for (const target of [state.reader._iframeWindow.document, doc]) {
      const style = target.createElement("style");
      style.textContent = `@media (max-width:700px) {
        .toolbar {height:76px!important;min-height:76px;flex-wrap:wrap;align-content:center;gap:2px}
        .toolbar .center.tools {display:flex!important;order:3;flex:1 0 100%;justify-content:center;height:32px;overflow-x:auto}
        .toolbar #read-aloud,.toolbar #navigateBack {display:none!important}
        .toolbar .start {gap:2px!important}
        .toolbar .divider {margin:0 2px!important}
        #split-view,.split-view,.sidebar-resizer,#sidebarContainer {top:76px}
      }
      @media (max-width:420px) {
        .toolbar #zoomIn,.toolbar #zoomOut,.toolbar #zoomAuto,.toolbar #readingMode {display:none!important}
      }
      @media (max-width:300px) {
        .toolbar #previous,.toolbar #next,.toolbar .start .divider {display:none!important}
      }`;
      if (target === doc) {
        // Scope the new palette to our controls, leaving native PDF and text layers untouched.
        style.textContent += `
          .paperbridge-split-controls {
            --pb-surface:#fff; --pb-border:#dce1e8; --pb-text:#202733;
            --pb-accent:#285fc1; --pb-soft:#eaf0fc;
            position:fixed; bottom:14px; right:14px; z-index:1000;
            display:flex; flex-wrap:wrap; align-items:center; gap:3px; padding:5px;
            max-width:calc(100vw - 28px); border:1px solid var(--pb-border); border-radius:10px;
            background:var(--pb-surface); color:var(--pb-text); box-shadow:0 3px 16px #0002;
            font:13px/1.5 system-ui,sans-serif;
          }
          .paperbridge-split-controls button:hover:not(:disabled),
          .paperbridge-reading-tools > summary:hover { background:var(--pb-soft)!important; }
          .paperbridge-split-controls button:disabled { opacity:.5; cursor:default!important; }
          .paperbridge-split-controls :is(button,summary):focus-visible {
            outline:2px solid var(--pb-accent); outline-offset:2px;
          }
          .paperbridge-paragraph-hover-toggle[aria-pressed="true"] {
            color:var(--pb-accent)!important; background:var(--pb-soft)!important;
          }
          .paperbridge-reading-tools > summary { padding:6px 9px; border-radius:6px; }
          .paperbridge-reading-tools-panel {
            position:absolute; bottom:calc(100% + 12px); right:0;
            width:min(250px,calc(100vw - 40px)); max-height:60vh; overflow:auto;
            display:flex; flex-wrap:wrap; gap:5px; padding:12px;
            border:1px solid var(--pb-border); border-radius:10px;
            background:var(--pb-surface); box-shadow:0 4px 20px #0003;
          }
          @media (prefers-color-scheme:dark) {
            .paperbridge-split-controls {
              --pb-surface:#252930; --pb-border:#3e4652; --pb-text:#e8ebf0;
              --pb-accent:#9bbcff; --pb-soft:#2c3a54;
            }
          }`;
      }
      target.head.append(style);
      state.cleanups.push(() => style.remove());
    }
    const controls = doc.createElement("div");
    controls.className = "paperbridge-split-controls";
    const sync = doc.createElement("button");
    sync.textContent = "⇄ 同步滚动";
    sync.title = "切换原文与译文的滚动同步。";
    sync.setAttribute("aria-pressed", "true");
    sync.addEventListener("click", () => {
      state.sync = !state.sync;
      sync.textContent = state.sync ? "⇄ 同步滚动" : "⇄ 独立滚动";
      sync.setAttribute("aria-pressed", String(state.sync));
      if (state.sync) this.syncPosition(state, state.active);
    });
    const close = doc.createElement("button");
    close.textContent = "关闭";
    close.title = "关闭译文分屏，保留原文阅读器。";
    close.setAttribute("aria-label", "关闭译文分屏");
    close.addEventListener("click", () => this.closeSplit(state.reader.tabID));
    for (const button of [sync, close]) button.style.cssText = "font:inherit;padding:6px 9px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap";
    controls.append(sync);
    // Missing maps disable only localization/hover; ordinary reading and annotations remain usable.
    state.alignment = new FragmentAlignment({ loadMapping: split => this.loadAlignment(split) });
    controls.append(state.alignment.attach(state), close);
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
    if (!state) return this.closingSplits.get(tabID) || Promise.resolve();
    this.splits.delete(tabID);
    state.closing = true;
    try { if (state.translationReader) this.formulas?.detach(state.translationReader); }
    catch (error) { Zotero.logError(error); }
    let write;
    try {
      // Both adapters snapshot synchronously before the parent tab can destroy its frame.
      write = state.translationReader ? TranslationReader.close(state) : state.annotations?.close();
    } catch (error) { write = Promise.reject(error); }
    const saved = Promise.resolve(write).catch(error => {
      try { this.annotationMessage(state, error); }
      catch (displayError) { Zotero.logError(displayError); }
    });
    if (state.translationReader || state.annotations) {
      const previous = this.annotationWrites.get(state.translated.id);
      // A second pane of the same attachment must not hide an earlier outstanding write.
      state.annotationSave = previous ? Promise.all([previous, saved]) : saved;
      this.annotationWrites.set(state.translated.id, state.annotationSave);
      state.annotationSave.then(() => {
        if (this.annotationWrites.get(state.translated.id) === state.annotationSave) {
          this.annotationWrites.delete(state.translated.id);
        }
      });
    }
    /** Restore the host layout even if a detached frame refuses one cleanup. */
    const dispose = () => {
      const cleanups = [...state.cleanups,
        () => { if (!state.translationReader) state.right?._primaryView?.destroy(); },
        () => state.browser.remove(), () => state.divider.remove(),
        () => state.container.setAttribute("style", state.originalStyle),
        () => state.reader._iframe.setAttribute("style", state.leftStyle),
        () => state.leftFlex === null ? state.reader._iframe.removeAttribute("flex")
          : state.reader._iframe.setAttribute("flex", state.leftFlex)];
      for (const cleanup of cleanups) {
        try { cleanup(); } catch (error) { Zotero.logError(error); }
      }
    };
    // Keep native content alive through its flush; legacy saves own privileged snapshots.
    if (!state.translationReader) dispose();
    const closing = (state.annotationSave || saved).then(() => {
      if (state.translationReader) dispose();
    }).finally(() => {
      if (this.closingSplits.get(tabID) === closing) this.closingSplits.delete(tabID);
    });
    this.closingSplits.set(tabID, closing);
    return closing;
  }
};
