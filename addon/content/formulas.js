/** Copy DeepSeek/native LaTeX and bind optional display-formula hover controls. */
/* global Zotero, Cc, Ci, Components */
// Keep selection geometry stable without changing native PDF coordinates.
const FORMULA_SELECTION_PRECISION = 100;
// Include edge glyphs whose centers slightly exceed the native selection rectangle.
const FORMULA_SELECTION_TOLERANCE = 0.5;
// Delay detection until the pointer settles over a PDF page.
const FORMULA_HOVER_DELAY_MS = 140;
// Allow the pointer to reach the adjacent copy button before hiding it.
const FORMULA_HIDE_DELAY_MS = 180;
// Keep copy confirmation brief without interfering with later clicks.
const FORMULA_FEEDBACK_DELAY_MS = 1200;
// Retry transient detection only on another pointer movement after a short cooldown.
const FORMULA_REGION_RETRY_DELAY_MS = 5000;
// One retry is enough; further attempts require explicit user action or a new reader.
const FORMULA_REGION_MAX_FAILURES = 2;
// Leave optional-cache warnings visible long enough to read.
const FORMULA_CACHE_WARNING_MS = 6000;

var FormulaClipboard = class {
  /** Track requests and reader bindings independently of cached JSON lifetime. */
  constructor(bridge) {
    this.bridge = bridge;
    this.inFlight = new Map();
    this.regionRequests = new Map();
    this.readers = new Map();
  }

  /** Extract selected text and geometry from the active native PDF view. */
  selection(reader, annotation) {
    const internal = reader._internalReader;
    const view = internal?._lastView || internal?._primaryView;
    annotation ||= internal?._state.primaryViewSelectionPopup?.annotation
      || internal?._state.secondaryViewSelectionPopup?.annotation;
    if (!annotation && view?._selectionRanges?.length && !view._selectionRanges[0].collapsed) {
      annotation = view._getAnnotationFromSelectionRanges(view._selectionRanges, "highlight");
    }
    if (!annotation?.text?.trim()) return null;
    const position = annotation.position;
    const glyphs = [];
    for (const [pageIndex, rects] of [
      [position?.pageIndex, position?.rects], [position?.pageIndex + 1, position?.nextPageRects]
    ]) {
      if (!rects?.length) continue;
      for (const char of view?._pdfPages?.[pageIndex]?.chars || []) {
        const [x1, y1, x2, y2] = char.rect;
        const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
        if (rects.some(r => x >= r[0] - FORMULA_SELECTION_TOLERANCE && x <= r[2] + FORMULA_SELECTION_TOLERANCE
            && y >= r[1] - FORMULA_SELECTION_TOLERANCE && y <= r[3] + FORMULA_SELECTION_TOLERANCE)) {
          glyphs.push({ c: char.c, rect: [x1, y1, x2, y2]
            .map(n => Math.round(n * FORMULA_SELECTION_PRECISION) / FORMULA_SELECTION_PRECISION), page: pageIndex });
        }
      }
    }
    return { text: annotation.text.trim(), glyphs };
  }

  /** Add explicit inline/display copy actions to native selection popups. */
  popup({ reader, doc, params, append }) {
    if (reader._type !== "pdf") return;
    const selection = this.selection(reader, params.annotation);
    if (!selection) return;
    const row = doc.createElement("div");
    row.className = "paperbridge-formula-copy";
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:6px";
    for (const [label, display] of [["复制公式 $…$", false], ["复制公式 $$…$$", true]]) {
      const button = doc.createElement("button");
      button.textContent = label;
      button.title = "将选中的公式复制为 LaTeX；无原生 LaTeX 时使用已配置的 DeepSeek";
      button.style.cssText = "font:inherit;color:inherit;padding:4px 7px;border:1px solid var(--fill-quaternary,#999);border-radius:4px;cursor:pointer";
      button.addEventListener("click", () => this.bridge.action(async () => {
        button.disabled = true;
        button.textContent = "正在转换…";
        try {
          await this.copy(reader, selection, display);
          button.textContent = "已复制";
        } catch (error) {
          button.textContent = label;
          throw error;
        } finally { button.disabled = false; }
      }));
      row.append(button);
    }
    append(row);
  }

  /** Offer native math or selected-text copying in the reader context menu. */
  menu({ reader, params, append }) {
    if (reader._type !== "pdf") return;
    const selection = this.selection(reader);
    const tex = params.overlay?.type === "math" && params.overlay.tex;
    if (!selection && !tex) return;
    for (const [label, display] of [["复制公式为 LaTeX（行内 $…$）", false], ["复制公式为 LaTeX（独立 $$…$$）", true]]) {
      append({ label, onCommand: () => this.bridge.action(() => this.copy(reader, selection, display, tex)) });
    }
  }

  /** Report optional persistence failure without discarding a successfully copied formula. */
  cacheWarning(error) {
    const message = `公式已复制，但缓存未保存：${error.message || error}`;
    this.bridge.formulaCache.lastError = message;
    Zotero.logError(error);
    try {
      const progress = new Zotero.ProgressWindow();
      progress.changeHeadline("PaperBridge · 公式缓存警告");
      progress.addDescription(message);
      progress.show();
      progress.startCloseTimer(FORMULA_CACHE_WARNING_MS);
    } catch (warningError) { Zotero.logError(warningError); }
    return message;
  }

  /** Reuse cached/native TeX or explicitly invoke the dedicated DeepSeek profile. */
  async copy(reader, selection, display, nativeTex) {
    let latex = nativeTex;
    // A known formula remains copyable when optional cache persistence fails.
    let cacheError;
    if (!latex) {
      if (!selection) throw new Error("请先选中要复制的公式。");
      const context = await this.bridge.formulaCache.context(reader);
      const key = this.bridge.formulaCache.key(selection);
      latex = await this.bridge.formulaCache.lookup(context, key);
      if (!latex) {
        const cache = this.bridge.formulaCache;
        const requestKey = `${context.id}:${context.generation}:${key}`;
        // A late link can change the document ID while the same formula request is still pending.
        let pending = [...this.inFlight.values()].find(request => request.key === key
          && (cache.resolve?.(request.context.id) ?? request.context.id) === context.id
          && (cache.isCurrent ? cache.isCurrent(request.context)
            : request.context.generation === context.generation));
        if (!pending) {
          /** Convert one formula without mixing active-profile credentials or endpoint settings. */
          const task = (async () => {
            const apiKey = this.bridge.getKey("deepseek");
            if (!apiKey) throw new Error("请在 PaperBridge 设置中填写 DeepSeek API Key，再复制公式。");
            const configuration = this.bridge.configuration("deepseek");
            const result = await this.bridge.request("/formulas/latex", "POST", {
              ...selection, api_key:apiKey, base_url:configuration.baseURL
            });
            const value = this.unwrap(result.latex);
            if (!value) throw new Error("没有识别到有效公式，请重新选取完整公式。");
            try { await this.bridge.formulaCache.store(context, key, selection, value); }
            catch (error) { cacheError = error; }
            return value;
          })();
          pending = {context, key, task};
          this.inFlight.set(requestKey, pending);
          const request = pending;
          /** Remove only this task, never a newer request using the same key. */
          const finish = () => {
            if (this.inFlight.get(requestKey) === request) this.inFlight.delete(requestKey);
          };
          task.then(finish, finish);
        }
        latex = await pending.task;
      }
    }
    latex = this.unwrap(latex);
    if (nativeTex && selection && latex) {
      try {
        const context = await this.bridge.formulaCache.context(reader);
        await this.bridge.formulaCache.store(context, this.bridge.formulaCache.key(selection), selection, latex);
      } catch (error) { cacheError = error; }
    }
    if (!this.bridge.alive) return;
    if (!latex) throw new Error("没有识别到公式，请重新选取完整公式。");
    const delimiter = display ? "$$" : "$";
    const output = delimiter + latex + delimiter;
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(output);
    const message = cacheError ? this.cacheWarning(cacheError) : "公式 LaTeX 已复制";
    reader._internalReader?.setA11yMessage?.(message);
    // An explicit copy may follow a repaired configuration or completed engine consent.
    this.readers.get(reader)?.failures.clear();
    return output;
  }

  /** Request local region detection non-interactively and persist only valid successful results. */
  async regions(reader, pageIndex) {
    const context = await this.bridge.formulaCache.context(reader);
    const cached = await this.bridge.formulaCache.page(context, pageIndex);
    if (cached && Array.isArray(cached.regions)) return cached.regions;
    const key = `${context.id}:${context.physicalID}:${context.generation}:${pageIndex}`;
    if (!this.regionRequests.has(key)) {
      /** Detect one physical page without an interactive engine-consent path. */
      const task = (async () => {
        const result = await this.bridge.request("/formulas/regions", "POST", {
          source_path:context.path, page_index:pageIndex
        }, {interactive:false});
        if (!Array.isArray(result.regions)) throw new Error("公式区域识别返回格式无效，请稍后重试。");
        await this.bridge.formulaCache.storePage(context, pageIndex, result.regions);
        return result.regions;
      })();
      this.regionRequests.set(key, task);
      task.then(() => this.regionRequests.delete(key), () => this.regionRequests.delete(key));
    }
    return this.regionRequests.get(key);
  }

  /** Bind one PDF reader; automatic failures allow only a bounded, pointer-driven retry. */
  async attach(reader) {
    if (reader._type !== "pdf" || this.readers.has(reader) || !this.bridge.alive) return;
    const binding = {active:true, cleanups:[], failures:new Map()};
    this.readers.set(reader, binding);
    try {
      await reader._initPromise;
      const view = reader._internalReader._primaryView;
      await view.initializedPromise;
      if (!binding.active || !this.bridge.alive) return;
      const frame = view._iframeWindow;
      const host = reader._window || Zotero.getMainWindow();
      const doc = frame.document;
      const app = frame.PDFViewerApplication;
      const button = doc.createElement("button");
      button.className = "paperbridge-display-formula-copy";
      button.textContent = "⧉";
      button.title = "复制长公式 LaTeX（$$…$$）";
      button.setAttribute("aria-label", button.title);
      button.style.cssText = "position:fixed;z-index:100000;width:28px;height:26px;border:1px solid #888;border-radius:5px;background:Canvas;color:CanvasText;font-size:20px;line-height:20px;cursor:pointer;box-shadow:0 1px 5px #0003";
      button.hidden = true;
      doc.documentElement.append(button);
      let current, pointer, lastPoint, timer, hideTimer, pendingPage;
      const loaded = new Map();
      let generation = this.bridge.formulaCache.generation;
      const failures = binding.failures;
      /** Hide the hover control and discard its current target. */
      const hide = () => { button.hidden = true; current = null; };
      /** Delay hiding while the pointer crosses the small button gap. */
      const laterHide = () => {
        host.clearTimeout(hideTimer);
        hideTimer = host.setTimeout(hide, FORMULA_HIDE_DELAY_MS);
      };
      /** Position a copy button for a successfully loaded formula region. */
      const show = () => {
        if (!binding.active || !pointer) return;
        const regions = loaded.get(pointer.pageIndex) || [];
        const region = regions.find(r => pointer.x >= r.rect[0]-3 && pointer.x <= r.rect[2]+3
          && pointer.y >= r.rect[1]-3 && pointer.y <= r.rect[3]+3);
        if (!region) { laterHide(); return; }
        host.clearTimeout(hideTimer);
        const page = app.pdfViewer.getPageView(pointer.pageIndex);
        const bounds = page.div.getBoundingClientRect();
        const r = page.viewport.convertToViewportRectangle(Components.utils.cloneInto(region.rect, frame));
        const scale = bounds.width / page.viewport.width;
        button.style.left = Math.max(2, Math.min(frame.innerWidth-32, bounds.left + Math.max(r[0],r[2])*scale-24)) + "px";
        button.style.top = Math.max(2, Math.min(frame.innerHeight-30, bounds.top + Math.min(r[1],r[3])*scale-25)) + "px";
        button.dataset.pageIndex = String(pointer.pageIndex);
        button.hidden = false;
        current = region;
      };
      /** Detect the pointed page without endlessly retrying an unavailable backend. */
      const move = event => {
        if (event.target.closest?.(".paperbridge-display-formula-copy")) return;
        lastPoint = {x:event.clientX,y:event.clientY};
        const pageNode = event.target.closest?.(".page[data-page-number]");
        if (!pageNode || event.target.closest?.("input,textarea,[contenteditable=true]")) { laterHide(); return; }
        const pageIndex = Number(pageNode.dataset.pageNumber)-1;
        const page = app.pdfViewer.getPageView(pageIndex);
        const bounds = pageNode.getBoundingClientRect();
        const [x,y] = page.viewport.convertToPdfPoint((event.clientX-bounds.left)*page.viewport.width/bounds.width,
          (event.clientY-bounds.top)*page.viewport.height/bounds.height);
        pointer = {pageIndex,x,y};
        if (generation !== this.bridge.formulaCache.generation) {
          generation = this.bridge.formulaCache.generation; loaded.clear(); failures.clear(); hide();
        }
        if (loaded.has(pageIndex)) { show(); return; }
        laterHide();
        const failure = failures.get(pageIndex);
        if (pendingPage === pageIndex || failure && (failure.count >= FORMULA_REGION_MAX_FAILURES
            || Date.now() - failure.at < FORMULA_REGION_RETRY_DELAY_MS)) return;
        pendingPage = pageIndex;
        host.clearTimeout(timer);
        /** Run a bounded detection attempt and never persist errors as empty regions. */
        timer = host.setTimeout(async () => {
          const requestedGeneration = generation;
          try {
            const regions = await this.regions(reader,pageIndex);
            if (!binding.active || requestedGeneration !== this.bridge.formulaCache.generation) return;
            failures.delete(pageIndex);
            loaded.set(pageIndex,regions); show();
          } catch (error) {
            if (!binding.active || requestedGeneration !== this.bridge.formulaCache.generation) return;
            failures.set(pageIndex, {count:(failures.get(pageIndex)?.count || 0) + 1, at:Date.now()});
            this.bridge.formulaCache.lastError = String(error);
            Zotero.logError(error);
          }
          finally { if (pendingPage === pageIndex) pendingPage = null; }
        }, FORMULA_HOVER_DELAY_MS);
      };
      /** Copy the current display formula through the explicit user-action path. */
      const click = () => {
        if (!current) return;
        const region = current;
        this.bridge.action(async () => {
          button.disabled = true; button.textContent = "…";
          try {
            const overlays = view._pdfPages?.[pointer.pageIndex]?.overlays || [];
            const math = overlays.find(o => o.type === "math" && o.tex && o.position?.rects?.some(r =>
              r[0] <= region.rect[2] && r[2] >= region.rect[0] && r[1] <= region.rect[3] && r[3] >= region.rect[1]));
            await this.copy(reader,region.selection,true,math?.tex);
            if (binding.active) { button.textContent = "✓"; button.title = "已复制 $$…$$"; }
          } finally {
            if (binding.active) {
              button.disabled = false;
              host.setTimeout(() => { if (binding.active) {button.textContent="⧉";button.title="复制长公式 LaTeX（$$…$$）";} }, FORMULA_FEEDBACK_DELAY_MS);
            }
          }
        });
      };
      /** Register paired listeners so detach always removes the original handler. */
      const listen = (target,name,handler,options) => {
        target.addEventListener(name,handler,options);
        binding.cleanups.push(() => target.removeEventListener(name,handler,options));
      };
      listen(doc,"pointermove",move,{passive:true});
      listen(doc,"pointerleave",laterHide);
      listen(button,"pointerenter",() => host.clearTimeout(hideTimer));
      listen(button,"pointerleave",laterHide);
      listen(button,"click",click);
      /** Re-evaluate the last pointer location after native PDF scrolling. */
      const scroll = () => {
        pointer=null; hide();
        if (lastPoint) {
          const target=doc.elementFromPoint(lastPoint.x,lastPoint.y);
          if (target) move({target,clientX:lastPoint.x,clientY:lastPoint.y});
        }
      };
      app.eventBus.on("updateviewarea",scroll);
      binding.cleanups.push(() => app.eventBus.off("updateviewarea",scroll));
      binding.cleanups.push(() => {host.clearTimeout(timer);host.clearTimeout(hideTimer);button.remove();});
      listen(reader._iframeWindow,"unload",() => this.detach(reader),{once:true});
    } catch (error) { this.detach(reader); if (!String(error).includes("dead object")) Zotero.logError(error); }
  }

  /** Remove listeners and hover controls without altering caches or native PDF annotations. */
  detach(reader) {
    const binding = this.readers.get(reader);
    if (!binding) return;
    binding.active = false;
    for (const cleanup of binding.cleanups) {
      try {cleanup();} catch (error) {if (!String(error).includes("dead object")) Zotero.logError(error);}
    }
    this.readers.delete(reader);
  }

  /** Unbind all readers and wait for queued cache writes during plugin shutdown. */
  async stop() {
    for (const reader of [...this.readers.keys()]) this.detach(reader);
    await this.bridge.formulaCache.settled();
  }

  /** Strip one outer TeX delimiter pair before applying the requested copy style. */
  unwrap(value) {
    let text = String(value || "").trim();
    if (text.startsWith("$$") && text.endsWith("$$")) text = text.slice(2, -2);
    else if (text.startsWith("$") && text.endsWith("$")) text = text.slice(1, -1);
    else if ((text.startsWith("\\[") && text.endsWith("\\]")) || (text.startsWith("\\(") && text.endsWith("\\)"))) text = text.slice(2, -2);
    return text.trim();
  }
};
