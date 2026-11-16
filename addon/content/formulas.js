/* global Zotero, Cc, Ci, Components */
var FormulaClipboard = class {
  constructor(bridge) {
    this.bridge = bridge;
    this.inFlight = new Map();
    this.regionRequests = new Map();
    this.readers = new Map();
  }

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
        if (rects.some(r => x >= r[0] - 0.5 && x <= r[2] + 0.5 && y >= r[1] - 0.5 && y <= r[3] + 0.5)) {
          glyphs.push({ c: char.c, rect: [x1, y1, x2, y2].map(n => Math.round(n * 100) / 100), page: pageIndex });
        }
      }
    }
    return { text: annotation.text.trim(), glyphs };
  }

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

  menu({ reader, params, append }) {
    if (reader._type !== "pdf") return;
    const selection = this.selection(reader);
    const tex = params.overlay?.type === "math" && params.overlay.tex;
    if (!selection && !tex) return;
    for (const [label, display] of [["复制公式为 LaTeX（行内 $…$）", false], ["复制公式为 LaTeX（独立 $$…$$）", true]]) {
      append({ label, onCommand: () => this.bridge.action(() => this.copy(reader, selection, display, tex)) });
    }
  }

  async copy(reader, selection, display, nativeTex) {
    let latex = nativeTex;
    if (!latex) {
      if (!selection) throw new Error("请先选中要复制的公式。");
      const context = await this.bridge.formulaCache.context(reader);
      const key = this.bridge.formulaCache.key(selection);
      latex = await this.bridge.formulaCache.lookup(context, key);
      if (!latex) {
        const requestKey = `${context.id}:${context.generation}:${key}`;
        if (!this.inFlight.has(requestKey)) {
          const task = (async () => {
            const apiKey = this.bridge.getKey();
            if (!apiKey) throw new Error("请在 PaperBridge 设置中填写 DeepSeek API Key，再复制公式。");
            const result = await this.bridge.request("/formulas/latex", "POST", {
              ...selection, api_key:apiKey, base_url:this.bridge.pref("baseURL")
            });
            const value = this.unwrap(result.latex);
            if (!value) throw new Error("没有识别到有效公式，请重新选取完整公式。");
            await this.bridge.formulaCache.store(context, key, selection, value);
            return value;
          })();
          this.inFlight.set(requestKey, task);
          task.then(() => this.inFlight.delete(requestKey), () => this.inFlight.delete(requestKey));
        }
        latex = await this.inFlight.get(requestKey);
      }
    }
    latex = this.unwrap(latex);
    if (nativeTex && selection) {
      const context = await this.bridge.formulaCache.context(reader);
      await this.bridge.formulaCache.store(context, this.bridge.formulaCache.key(selection), selection, latex);
    }
    if (!this.bridge.alive) return;
    if (!latex) throw new Error("没有识别到公式，请重新选取完整公式。");
    const delimiter = display ? "$$" : "$";
    const output = delimiter + latex + delimiter;
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(output);
    reader._internalReader?.setA11yMessage("公式 LaTeX 已复制");
    return output;
  }

  async regions(reader, pageIndex) {
    const context = await this.bridge.formulaCache.context(reader);
    const cached = await this.bridge.formulaCache.page(context, pageIndex);
    if (cached) return cached.regions;
    const key = `${context.id}:${context.physicalID}:${context.generation}:${pageIndex}`;
    if (!this.regionRequests.has(key)) {
      const task = (async () => {
        const result = await this.bridge.request("/formulas/regions", "POST", {source_path:context.path, page_index:pageIndex});
        await this.bridge.formulaCache.storePage(context, pageIndex, result.regions);
        return result.regions;
      })();
      this.regionRequests.set(key, task);
      task.then(() => this.regionRequests.delete(key), () => this.regionRequests.delete(key));
    }
    return this.regionRequests.get(key);
  }

  async attach(reader) {
    if (reader._type !== "pdf" || this.readers.has(reader) || !this.bridge.alive) return;
    const binding = {active:true, cleanups:[]};
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
      const failures = new Set();
      const hide = () => { button.hidden = true; current = null; };
      const laterHide = () => { host.clearTimeout(hideTimer); hideTimer = host.setTimeout(hide, 180); };
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
        if (pendingPage === pageIndex || failures.has(pageIndex)) return;
        pendingPage = pageIndex;
        host.clearTimeout(timer);
        timer = host.setTimeout(async () => {
          const requestedGeneration = generation;
          try {
            const regions = await this.regions(reader,pageIndex);
            if (!binding.active || requestedGeneration !== this.bridge.formulaCache.generation) return;
            loaded.set(pageIndex,regions); show();
          } catch (error) { failures.add(pageIndex); this.bridge.formulaCache.lastError=String(error); Zotero.logError(error); }
          finally { if (pendingPage === pageIndex) pendingPage = null; }
        }, 140);
      };
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
              host.setTimeout(() => { if (binding.active) {button.textContent="⧉";button.title="复制长公式 LaTeX（$$…$$）";} },1200);
            }
          }
        });
      };
      const listen = (target,name,handler,options) => {
        target.addEventListener(name,handler,options);
        binding.cleanups.push(() => target.removeEventListener(name,handler,options));
      };
      listen(doc,"pointermove",move,{passive:true});
      listen(doc,"pointerleave",laterHide);
      listen(button,"pointerenter",() => host.clearTimeout(hideTimer));
      listen(button,"pointerleave",laterHide);
      listen(button,"click",click);
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

  detach(reader) {
    const binding = this.readers.get(reader);
    if (!binding) return;
    binding.active = false;
    for (const cleanup of binding.cleanups) {
      try {cleanup();} catch (error) {if (!String(error).includes("dead object")) Zotero.logError(error);}
    }
    this.readers.delete(reader);
  }

  async stop() {
    for (const reader of [...this.readers.keys()]) this.detach(reader);
    await this.bridge.formulaCache.settled();
  }

  unwrap(value) {
    let text = String(value || "").trim();
    if (text.startsWith("$$") && text.endsWith("$$")) text = text.slice(2, -2);
    else if (text.startsWith("$") && text.endsWith("$")) text = text.slice(1, -1);
    else if ((text.startsWith("\\[") && text.endsWith("\\]")) || (text.startsWith("\\(") && text.endsWith("\\)"))) text = text.slice(2, -2);
    return text.trim();
  }
};
