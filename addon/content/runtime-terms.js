/** Obtain explicit Windows-only consent for the bundled Microsoft runtime code. */
/* global Zotero, Services, Cc, Ci */
// Change the agreement identity only when its protective terms change, not on addon upgrades.
var MICROSOFT_RUNTIME_TERMS = Object.freeze({
  id: "msvc-community-2026-v1",
  preference: "extensions.paperbridge.microsoftRuntimeTerms",
  path: "licenses/supplemental/msvc/Microsoft-Runtime-Terms.txt"
});

var MicrosoftRuntimeTerms = class {
  /** Keep a single consent window and a session-only refusal, without collecting user data. */
  constructor(rootURI) {
    this.rootURI = rootURI;
    this.pending = null;
    this.window = null;
    this.declined = false;
    // The bridge can resume existing local reconciliation after explicit consent.
    this.onAccepted = null;
  }

  /** Only the Windows packages contain these Microsoft runtime DLLs. */
  required() { return Services.appinfo.OS === "WINNT"; }

  /** Remember agreement identity across restarts and addon version changes. */
  accepted() {
    return !this.required() || Zotero.Prefs.get(MICROSOFT_RUNTIME_TERMS.preference, true) === MICROSOFT_RUNTIME_TERMS.id;
  }

  /** Explain the disabled engine without presenting it as a broken installation. */
  blockedError() {
    const error = new Error("Windows 排版引擎尚未获得 Microsoft 运行库条款同意。\n请在 PaperBridge 设置中打开“Windows 运行库条款”，明确同意后再使用翻译或本地引擎。\n不影响 Zotero、原文及已有译文阅读；无需安装 Visual Studio 或额外运行库。");
    error.paperbridgeTerms = true;
    error.paperbridgeStartup = true;
    return error;
  }

  /** Never prompt from background polling or repeatedly after a session's refusal. */
  async ensure({ interactive = true } = {}) {
    if (this.accepted()) return;
    if (!interactive || this.declined || !await this.show()) throw this.blockedError();
  }

  /** Persist only a real accept action from the displayed, packaged agreement. */
  accept() {
    Zotero.Prefs.set(MICROSOFT_RUNTIME_TERMS.preference, MICROSOFT_RUNTIME_TERMS.id, true);
    this.declined = false;
    this.onAccepted?.();
  }

  /** Read a UTF-8 ZIP stream; Zotero's deprecated URI overload returns an XHR, not text. */
  async readText() {
    const uri = Services.io.newURI(this.rootURI).QueryInterface(Ci.nsIJARURI);
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(uri.JARFile.QueryInterface(Ci.nsIFileURL).file);
    try {
      return await Zotero.File.getContentsAsync(zip.getInputStream(MICROSOFT_RUNTIME_TERMS.path), "UTF-8");
    } finally { zip.close(); }
  }

  /** Read the agreement offline and let close/refusal resolve without accepting it. */
  show(parent = Zotero.getMainWindow()) {
    if (!this.required()) return Promise.resolve(true);
    if (this.pending) { this.window?.focus(); return this.pending; }
    this.pending = (async () => {
      let text;
      try {
        text = await this.readText();
        if (typeof text !== "string" || !text.trim()) throw new Error("Empty or non-text agreement");
      }
      catch (_) {
        const error = new Error("安装包中的 Windows 运行库条款无法读取。请重新安装完整 XPI 后再启用排版引擎；不影响 Zotero 及已有 PDF 阅读。");
        error.paperbridgeStartup = true;
        throw error;
      }
      return new Promise(resolve => {
        // openDialog unloads its initial about:blank document; only a real window close settles consent.
        const observer = {
          /** Ignore navigation and closure of other Zotero windows. */
          observe: subject => {
            if (subject !== this.window) return;
            Services.obs.removeObserver(observer, "domwindowclosed");
            const accepted = this.accepted();
            this.declined = !accepted;
            resolve(accepted);
          }
        };
        Services.obs.addObserver(observer, "domwindowclosed");
        try {
          this.window = parent.openDialog("chrome://paperbridge/content/runtime-terms.xhtml", "paperbridge-runtime-terms",
            "chrome,centerscreen,resizable", { terms: this, text });
        } catch (error) {
          Services.obs.removeObserver(observer, "domwindowclosed");
          throw error;
        }
      });
    })().finally(() => { this.pending = null; this.window = null; });
    return this.pending;
  }
};
