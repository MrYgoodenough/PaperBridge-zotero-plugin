/** Bilateral localization, independent hover, and explicit native translated-note actions. */
/* global Components, Zotero, Services, rootURI */
var FragmentAlignment = class FragmentAlignment {
  // Highlight lifetime is cosmetic, not a page-render readiness deadline.
  static HIGHLIGHT_MS = 2500;
  // Give existing page sync time to ignore programmatic navigation events.
  static NAVIGATION_GRACE_MS = 3000;
  // PDF.js RenderingStates.FINISHED means the page-specific viewport has been rendered.
  static RENDERING_FINISHED = 3;
  // Zotero's translucent text layer softens this tint to approximately 10% on the PDF.
  static HOVER_BACKGROUND = "rgba(96,165,250,.5)";
  // Own one namespaced CSS highlight per PDF document, never a native annotation or selection.
  static HOVER_NAME = "paperbridge-paragraph-hover";
  // Native/search custom highlights take priority over this cosmetic reading aid.
  static HOVER_PRIORITY = -1;
  // Native font line boxes slightly overhang painted glyph bounds; allow two CSS pixels.
  static TEXT_RECT_TOLERANCE = 2;
  // Horizontal font padding may exceed rounding noise, but ink must occupy most of the item.
  static TEXT_INK_MIN_HEIGHT_RATIO = 0.6;
  // Permit only rounding noise between each quad and its compatibility bounding rectangle.
  static GEOMETRY_EPSILON = 0.0001;
  // Share one lazily loaded native note module across split controllers.
  static Notes = null;

  /** Create one controller per split; loading and hash validation belong to the parent. */
  constructor({ loadMapping } = {}) {
    this.loadMapping = loadMapping;
    this.removers = [];
    this.disposed = true;
  }

  /** Check only the in-memory contract, never PDF files, hashes, or HTTP resources. */
  static checkMapping(mapping) {
    if (!mapping) return { mapping: null, reason: "没有可用的片段映射。" };
    if (![1, 2].includes(mapping.schema_version) || mapping.coordinate_space !== "pdf-user-space"
      || typeof mapping.source_sha256 !== "string" || typeof mapping.output_sha256 !== "string"
      || (mapping.schema_version === 2 && !/^[\w.-]{1,80}$/.test(mapping.generator_version || ""))
      || !Array.isArray(mapping.units)) {
      return { mapping: null, reason: "片段映射格式不受支持。" };
    }
    const ids = new Set();
    for (const unit of mapping.units) {
      if (!unit || typeof unit.id !== "string" || !unit.id || ids.has(unit.id)
        || unit.status !== "verified" || !this.validSide(unit.source) || !this.validSide(unit.target)
        || (mapping.schema_version === 2 && (!unit.source.quads || !unit.target.quads))) {
        return { mapping: null, reason: "片段映射损坏或包含未验证的片段。" };
      }
      ids.add(unit.id);
    }
    return mapping.units.length ? { mapping, reason: "" }
      : { mapping: null, reason: "片段映射中没有已验证的片段。" };
  }

  /** Accept legacy rectangles or matching finite, convex per-line quads on one PDF page. */
  static validSide(side) {
    const rectangles = !!side && Number.isSafeInteger(side.page) && side.page >= 0
      && Array.isArray(side.rects) && side.rects.length > 0
      && side.rects.every(rect => Array.isArray(rect) && rect.length === 4
        && rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3]);
    if (!rectangles || side.quads == null) return rectangles;
    return Array.isArray(side.quads) && side.quads.length === side.rects.length
      && side.quads.every((quad, index) => this.validQuad(quad)
        && this.quadBounds(quad).every((value, coordinate) =>
          Math.abs(value - side.rects[index][coordinate]) <= this.GEOMETRY_EPSILON));
  }

  /** Reject bow ties, collinear edges and nonfinite coordinates instead of repairing a polygon. */
  static validQuad(quad) {
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) return false;
    let orientation = 0;
    for (let index = 0; index < 4; index++) {
      const a = index * 2, b = ((index + 1) % 4) * 2, c = ((index + 2) % 4) * 2;
      const cross = (quad[b] - quad[a]) * (quad[c + 1] - quad[b + 1])
        - (quad[b + 1] - quad[a + 1]) * (quad[c] - quad[b]);
      if (!Number.isFinite(cross) || cross === 0 || (orientation && Math.sign(cross) !== orientation)) return false;
      orientation = Math.sign(cross);
    }
    return true;
  }

  /** Return a polygon's compatibility bounds, never its hit-testing area. */
  static quadBounds(quad) {
    return [Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]),
      Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])];
  }

  /** Test a convex polygon; optional edge tolerance is cosmetic native text-box padding. */
  static pointInQuad(quad, point, tolerance = 0) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return false;
    let orientation = 0;
    for (let index = 0; index < 4; index++) {
      const a = index * 2, b = ((index + 1) % 4) * 2;
      const dx = quad[b] - quad[a], dy = quad[b + 1] - quad[a + 1];
      const cross = dx * (point[1] - quad[a + 1]) - dy * (point[0] - quad[a]);
      if (Math.abs(cross) <= tolerance * Math.hypot(dx, dy) + this.GEOMETRY_EPSILON) continue;
      if (orientation && Math.sign(cross) !== orientation) return false;
      orientation = Math.sign(cross);
    }
    return true;
  }

  /** Resolve either side; hover groups rectangles of one request without guessing across units. */
  static hitTest(mapping, page, point, side = "target", wholeUnit = false) {
    let hit = null;
    for (const unit of mapping.units) {
      if (unit[side].page !== page) continue;
      const quads = unit[side].quads;
      for (const region of quads || unit[side].rects) {
        const contains = quads ? this.pointInQuad(region, point)
          : point[0] >= region[0] && point[0] <= region[2] && point[1] >= region[1] && point[1] <= region[3];
        if (!contains) continue;
        if (hit && (hit !== unit || (!wholeUnit && !quads))) return { status: "ambiguous", unit: null };
        hit = unit;
      }
    }
    return { status: hit ? "unique" : "miss", unit: hit };
  }

  /** Convert border-aware screen coordinates through this page's own PDF.js viewport. */
  static pdfPoint(pageView, clientX, clientY) {
    const { div, viewport } = pageView;
    const box = div.getBoundingClientRect();
    // PDF.js page borders are outside the viewport; CSS scaling affects the border too.
    const width = div.clientWidth || viewport.width;
    const height = div.clientHeight || viewport.height;
    const outerWidth = div.offsetWidth || width + 2 * (div.clientLeft || 0);
    const outerHeight = div.offsetHeight || height + 2 * (div.clientTop || 0);
    if (!(box.width > 0 && box.height > 0 && width > 0 && height > 0)) return null;
    const x = (clientX - box.left) * outerWidth / box.width - (div.clientLeft || 0);
    const y = (clientY - box.top) * outerHeight / box.height - (div.clientTop || 0);
    if (x < 0 || y < 0 || x > width || y > height) return null;
    const converted = viewport.convertToPdfPoint(x * viewport.width / width, y * viewport.height / height);
    // Do not pass privileged callbacks into arrays owned by the reader compartment.
    const point = converted?.length === 2 ? [converted[0], converted[1]] : null;
    return point && point.every(Number.isFinite) ? point : null;
  }

  /** Normalize rotated viewport rectangles for an absolutely positioned overlay. */
  static viewportRect(viewport, rect) {
    // Numeric arguments cross Gecko compartments; privileged rectangle arrays do not.
    const first = viewport.convertToViewportPoint(rect[0], rect[1]);
    const second = viewport.convertToViewportPoint(rect[2], rect[3]);
    const converted = [first?.[0], first?.[1], second?.[0], second?.[1]];
    if (!converted.every(Number.isFinite)) {
      throw new Error("页面坐标转换不可用。");
    }
    return [Math.min(converted[0], converted[2]), Math.min(converted[1], converted[3]),
      Math.max(converted[0], converted[2]), Math.max(converted[1], converted[3])];
  }

  /** Convert all polygon vertices through the page's real rotation/crop-aware viewport. */
  static viewportQuad(viewport, quad) {
    const result = [];
    for (let index = 0; index < quad.length; index += 2) {
      const point = viewport.convertToViewportPoint(quad[index], quad[index + 1]);
      if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) throw new Error("PDF viewport geometry unavailable");
      result.push(point[0], point[1]);
    }
    return result;
  }

  /** Accept PDF content, not links, native annotation layers, or overlaid controls. */
  static contentPage(target) {
    if (target?.closest?.("a, [role=link], .annotationLayer, .customAnnotationLayer, .annotation-popup, .toolbar, button, input, textarea, [contenteditable]")) return null;
    return target?.closest?.(".page[data-page-number]") || null;
  }

  /** Return a splitControls-compatible control; omitted mapping uses loadMapping(state). */
  attach(state, mapping, reason = "") {
    this.dispose();
    this.state = state;
    this.disposed = false;
    this.mapping = null;
    this.point = null;
    this.sourcePoint = null;
    this.pending = null;
    this.pendingIndex = null;
    this.hoverEnabled = false;
    this.hoverPointer = null;
    this.hoverUnit = null;
    this.hoverHighlights = [null, null];
    this.hoverFrameRequest = null;
    this.hoverRepaint = false;
    this.noteOperation = null;
    this.noteSelection = null;
    this.lastNoteResult = null;
    const leftFrame = state.reader?._internalReader?._primaryView?._iframeWindow;
    const rightFrame = state.right?._primaryView?._iframeWindow;
    this.frames = [leftFrame, rightFrame];
    this.apps = this.frames.map(frame => frame?.PDFViewerApplication);
    const doc = state.browser?.contentDocument || rightFrame?.document || state.reader?._iframeWindow?.document;
    this.control = doc.createElement("div");
    this.control.className = "paperbridge-fragment-alignment";
    this.control.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:4px;position:relative;min-width:0";
    const tools = doc.createElement("details");
    tools.className = "paperbridge-reading-tools";
    const toolsLabel = doc.createElement("summary");
    toolsLabel.textContent = "阅读工具";
    toolsLabel.setAttribute("aria-label", "定位与笔记工具");
    const toolsPanel = doc.createElement("div");
    toolsPanel.className = "paperbridge-reading-tools-panel";
    tools.append(toolsLabel, toolsPanel);
    this.button = doc.createElement("button");
    this.button.textContent = "定位原文";
    this.button.className = "paperbridge-localize-source";
    this.button.style.cssText = "font:inherit;padding:6px 9px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap";
    this.targetButton = doc.createElement("button");
    this.targetButton.textContent = "定位译文";
    this.targetButton.className = "paperbridge-localize-target";
    this.targetButton.style.cssText = this.button.style.cssText;
    this.status = doc.createElement("span");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.style.cssText = "display:block;width:100%;font-size:12px;line-height:1.5;overflow-wrap:anywhere;opacity:.8";
    this.hoverButton = doc.createElement("button");
    this.hoverButton.className = "paperbridge-paragraph-hover-toggle";
    this.hoverButton.setAttribute("aria-label", "原译文段落双向高亮");
    this.hoverButton.style.cssText = this.button.style.cssText;
    toolsPanel.append(this.button, this.targetButton, this.status);
    this.control.append(this.hoverButton, tools);
    this.selectionNoteButton = doc.createElement("button");
    this.selectionNoteButton.className = "paperbridge-selection-note";
    this.selectionNoteButton.textContent = "选区存笔记";
    this.selectionNoteButton.title = "将译文 PDF 的实际单页选区存为独立 Zotero 笔记。";
    this.selectionNoteButton.style.cssText = this.button.style.cssText;
    this.annotationsNoteButton = doc.createElement("button");
    this.annotationsNoteButton.className = "paperbridge-annotations-note";
    this.annotationsNoteButton.textContent = "汇总批注";
    this.annotationsNoteButton.title = "汇总译文附件已保存的原生批注；不修改 PDF 或批注。";
    this.annotationsNoteButton.style.cssText = this.button.style.cssText;
    this.noteStatus = doc.createElement("span");
    this.noteStatus.setAttribute("role", "status");
    this.noteStatus.setAttribute("aria-live", "polite");
    this.noteStatus.style.cssText = this.status.style.cssText;
    toolsPanel.append(this.selectionNoteButton, this.annotationsNoteButton, this.noteStatus);
    const control = this.control;
    state.cleanups.push(() => {
      if (this.control === control) this.dispose();
    });
    this.listen(this.button, "click", () => this.localize());
    this.listen(this.targetButton, "click", () => this.localize(0));
    this.listen(this.hoverButton, "click", () => this.toggleHover());
    // Capture before toolbar focus can collapse the real PDF selection; never alter that selection.
    this.listen(this.selectionNoteButton, "pointerdown", event => {
      if (event.button === 0 && event.isPrimary !== false) this.captureNoteSelection();
    });
    this.listen(this.selectionNoteButton, "keydown", event => {
      if (event.key === "Enter" || event.key === " ") this.captureNoteSelection();
    });
    this.listen(this.selectionNoteButton, "pointercancel", () => { this.noteSelection = null; });
    this.listen(this.selectionNoteButton, "click", () => this.createNote("selection"));
    this.listen(this.annotationsNoteButton, "click", () => this.createNote("annotations"));
    this.selectionNoteButton.disabled = !rightFrame?.document?.getSelection || !state.translated;
    this.annotationsNoteButton.disabled = !state.translated;

    this.pagesAvailable = this.apps.every(app => typeof app?.pdfViewer?.getPageView === "function"
      && typeof app?.eventBus?.on === "function" && typeof app?.eventBus?.off === "function");
    this.hoverAvailable = this.pagesAvailable && this.frames.every(frame =>
      typeof frame.Highlight === "function" && frame.CSS?.highlights);
    this.navigationAvailable = this.apps.map(app => this.pagesAvailable
      && typeof app.pdfViewer.scrollPageIntoView === "function");
    this.updateHoverButton("正在读取片段映射…");
    if (!this.pagesAvailable) {
      this.setStatus("片段定位接口不可用；仍可正常阅读。", true);
      this.updateHoverButton("段落高亮接口不可用；仍可正常阅读。");
      return control;
    }
    // Observe before native selection handlers stop bubbling, without cancelling their behavior.
    this.frames.forEach((frame, index) => {
      this.listen(frame.document, "pointerup", event => this.rememberPoint(event, index), { capture: true, passive: true });
    });
    this.bindPageEvents();
    this.bindHoverEvents();
    if (arguments.length >= 2) {
      this.setMapping(mapping, reason);
    } else if (this.loadMapping) {
      this.setStatus("正在读取片段映射…", true);
      // Late loader results cannot restore controls or listeners after split closure.
      Promise.resolve().then(() => this.disposed || this.control !== control ? null : this.loadMapping(state))
        .then(result => {
          if (this.disposed || this.control !== control) return;
          this.setMapping(result?.schema_version ? result : result?.mapping, result?.reason || "");
        }).catch(error => {
          if (!this.disposed && this.control === control) this.setMapping(null, error.message || "片段映射读取失败。");
        });
    } else {
      this.setMapping(null, reason);
    }
    return control;
  }

  /** Register one DOM listener and retain its exact removal options. */
  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.removers.push(() => target.removeEventListener(type, handler, options));
  }

  /** Remove stale points and overlays when the relevant PDF page geometry changes. */
  bindPageEvents() {
    this.apps.forEach((app, index) => {
      for (const type of ["scalechanging", "rotationchanging", "pagesdestroy", "pagechanging", "pagerendered"]) {
        const handler = event => {
          // Geometry changes invalidate the cached hit; wait for the next actual hover input.
          if (type !== "pagerendered") this.hoverPointer = null;
          // Release stale native ranges after this layout callback, including pagesdestroy.
          this.scheduleHover(true);
          if (type === "pagerendered") {
            const point = index === 0 ? this.sourcePoint : this.point;
            const destination = index === this.pendingIndex ? this.pending
              : index === this.highlightIndex ? this.highlightSide : null;
            if (event?.pageNumber !== point?.page + 1 && event?.pageNumber !== destination?.page + 1) return;
          }
          this.clearHighlight();
          if (index === 0) this.sourcePoint = null;
          else this.point = null;
          if (index === this.pendingIndex && type === "pagerendered" && this.pending) {
            this.showHighlight();
          } else if (index === this.pendingIndex && type === "pagechanging" && event?.pageNumber === this.pending?.page + 1) {
            // A navigation-induced page change must not discard the pending destination highlight.
          } else {
            this.pending = null;
            this.pendingIndex = null;
          }
        };
        app.eventBus.on(type, handler);
        this.removers.push(() => app.eventBus.off(type, handler));
      }
    });
  }

  /** Apply the parent's mapping or its visible, nonfatal unavailability reason. */
  setMapping(mapping, reason = "") {
    const checked = FragmentAlignment.checkMapping(mapping);
    this.clearHighlight();
    this.pending = null;
    this.pendingIndex = null;
    this.point = null;
    this.sourcePoint = null;
    this.clearHover();
    this.mapping = checked.mapping;
    if (!this.mapping) {
      this.hoverEnabled = false;
      this.hoverPointer = null;
    }
    const unavailable = reason || checked.reason;
    this.setStatus(this.mapping ? (this.navigationAvailable.every(Boolean)
      ? "点击或拖选片段，再按对应定位按钮。"
      : "部分片段定位接口不可用；其他可用功能不受影响。") : unavailable, !this.mapping);
    this.updateHoverButton(this.mapping ? "" : unavailable);
    this.scheduleHover();
  }

  /** Display status without alerts or changes to ordinary reading behavior. */
  setStatus(message, disabled = false) {
    this.status.textContent = message;
    this.button.disabled = disabled || !this.mapping || !this.navigationAvailable[0];
    this.button.title = message;
    this.targetButton.disabled = disabled || !this.mapping || !this.navigationAvailable[1];
    this.targetButton.title = message;
  }

  /** Load only the official native-note adapter when the user requests a note. */
  noteAPI() {
    if (!FragmentAlignment.Notes) {
      const scope = { Zotero };
      Services.scriptloader.loadSubScript(rootURI + "content/notes.js", scope);
      if (!scope.PaperBridgeNotes?.createFromSelection || !scope.PaperBridgeNotes?.createFromAnnotations) {
        throw new Error("原生笔记模块未能加载。");
      }
      FragmentAlignment.Notes = scope.PaperBridgeNotes;
    }
    return FragmentAlignment.Notes;
  }

  /** Read only one actual, connected translated text-layer range and its physical page. */
  selectionForNote() {
    const selection = this.frames[1]?.document?.getSelection();
    const text = selection?.toString() || "";
    if (!text.trim() || selection.isCollapsed || selection.rangeCount !== 1) {
      throw new Error("请先在译文 PDF 中拖选实际文字。");
    }
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const end = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
    const page = FragmentAlignment.contentPage(start);
    const endPage = FragmentAlignment.contentPage(end);
    if (!start?.closest?.(".textLayer") || !end?.closest?.(".textLayer") || !page?.isConnected
      || (page !== endPage && !page.isSameNode?.(endPage))) {
      throw new Error("笔记需要译文 PDF 内的单页文字选区；跨页选区请分开保存。");
    }
    const pageIndex = Number(page.getAttribute("data-page-number")) - 1;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error("无法读取选区的实际译文页码。");
    return { text, pageIndex, page };
  }

  /** Retain this explicit button activation's selection, not a hover or guessed fragment. */
  captureNoteSelection() {
    if (this.disposed || this.noteOperation) return;
    try { this.noteSelection = this.selectionForNote(); }
    catch (error) { this.noteSelection = { error }; }
  }

  /** Await native persistence and reject visible edits still inside the reader's debounce. */
  async waitForNoteAnnotations(state) {
    await state.annotations?.pending;
    if (state.annotations?.failed) throw new Error("译文批注保存失败，请确认原生批注保存状态后再汇总。");
    // Existing adapter compatibility boundary: inspect public-source reader state, never write it.
    const live = state.right?._state?.annotations;
    if (!live) return;
    await state.translated.loadDataType("childItems");
    const items = state.translated.getAnnotations();
    if (items.length !== live.length) throw new Error("译文批注仍在原生保存，请稍后再汇总。");
    for (const value of live) {
      const item = items.find(annotation => annotation.key === value.id);
      if (!item) throw new Error("译文批注仍在原生保存，请稍后再汇总。");
      await item.loadAllData();
      const json = await Zotero.Annotations.toJSON(item);
      // Compare content relevant to this note, ignoring transient reader image URLs and permissions.
      const fields = ["type", "text", "comment", "pageLabel", "color", "position"];
      if (fields.some(field => JSON.stringify(json[field] || "") !== JSON.stringify(value[field] || ""))) {
        throw new Error("译文批注仍在原生保存，请稍后再汇总。");
      }
    }
  }

  /** Keep save and open outcomes separate; repeated clicks share the complete current action. */
  createNote(kind) {
    if (this.disposed) return Promise.resolve(null);
    if (this.noteOperation) return this.noteOperation;
    const state = this.state;
    const control = this.control;
    let selection = this.noteSelection;
    this.noteSelection = null;
    if (kind === "selection" && !selection) {
      try { selection = this.selectionForNote(); }
      catch (error) { selection = { error }; }
    }
    this.selectionNoteButton.disabled = true;
    this.annotationsNoteButton.disabled = true;
    this.noteStatus.textContent = "正在创建独立笔记…";
    const operation = Promise.resolve().then(async () => {
      let note;
      try {
        if (selection?.error) throw selection.error;
        if (kind === "annotations") await this.waitForNoteAnnotations(state);
        if (this.disposed || this.control !== control) return null;
        const api = this.noteAPI();
        const args = { translatedAttachment: state.translated, sourceAttachment: state.source };
        if (kind === "selection") {
          if (!selection.page.isConnected) throw new Error("译文选区页面已关闭，请重新划选。");
          let labels;
          try { labels = await this.apps[1]?.pdfDocument?.getPageLabels?.(); }
          catch (error) { /* Physical pages remain valid when PDF labels cannot be read. */ }
          if (this.disposed || this.control !== control) return null;
          note = await api.createFromSelection({ ...args, text: selection.text, pageIndex: selection.pageIndex,
            pageLabel: labels?.[selection.pageIndex] || undefined });
        } else {
          note = await api.createFromAnnotations(args);
        }
      } catch (error) {
        if (!this.disposed && this.control === control) {
          const message = error.code === "NOTE_SAVE_FAILED" ? "笔记保存结果未确认：" : "笔记未能创建：";
          this.noteStatus.textContent = message + (error.message || error);
        }
        return { note: null, opened: false, error };
      }
      const result = { note, opened: false };
      if (this.disposed || this.control !== control) return result;
      this.lastNoteResult = result;
      this.noteStatus.textContent = "笔记已保存。";
      try {
        if (!Zotero.Notes?.open) throw new Error("Zotero 原生笔记打开接口不可用。");
        await Zotero.Notes.open(note.id, null, { openInWindow: true });
        result.opened = true;
      } catch (error) {
        result.openError = error;
        if (!this.disposed && this.control === control) {
          this.noteStatus.textContent = "笔记已保存，但打开失败；请在 Zotero 库中打开，勿重复保存：" + (error.message || error);
        }
      }
      return result;
    }).finally(() => {
      if (this.control !== control || this.noteOperation !== operation) return;
      this.noteOperation = null;
      if (!this.disposed) {
        this.selectionNoteButton.disabled = !this.frames[1]?.document?.getSelection || !state.translated;
        this.annotationsNoteButton.disabled = !state.translated;
      }
    });
    this.noteOperation = operation;
    return operation;
  }

  /** Show an independent per-split switch and a nonfatal mapping availability reason. */
  updateHoverButton(reason = "") {
    this.hoverButton.textContent = "段落高亮";
    this.hoverButton.setAttribute("aria-pressed", String(this.hoverEnabled));
    this.hoverButton.disabled = !this.mapping || !this.hoverAvailable;
    this.hoverButton.title = reason || (this.hoverAvailable ? "悬停高亮已验证的原译文片段；不跳页、不创建批注。"
      : "当前 Zotero 的文本高亮接口不可用；仍可正常阅读和批注。");
    this.hoverButton.style.background = this.hoverEnabled ? "rgba(96,165,250,.16)" : "transparent";
  }

  /** Toggle only hover; page sync, explicit localization, and annotations stay independent. */
  toggleHover() {
    if (this.disposed || this.hoverButton.disabled) return;
    this.hoverEnabled = !this.hoverEnabled;
    this.hoverPointer = null;
    this.clearHover();
    this.updateHoverButton();
  }

  /** Observe both documents without intercepting native links, selection, or annotation drags. */
  bindHoverEvents() {
    this.frames.forEach((frame, index) => {
      const doc = frame.document;
      const style = doc.createElement("style");
      // CSS Highlights paint within the native text layer without adding PDFPageView children.
      style.textContent = `::highlight(${FragmentAlignment.HOVER_NAME}){background-color:${FragmentAlignment.HOVER_BACKGROUND};color:transparent}`;
      doc.head.append(style);
      this.removers.push(() => style.remove());
      const rendered = () => this.scheduleHover(true);
      this.apps[index].eventBus.on("textlayerrendered", rendered);
      this.removers.push(() => this.apps[index].eventBus.off("textlayerrendered", rendered));
      const options = { capture: true, passive: true };
      this.listen(doc, "pointermove", event => this.rememberHover(event, index), options);
      this.listen(doc, "pointerdown", () => {
        this.hoverPointer = null;
        this.clearHover();
      }, options);
      this.listen(doc, "pointerout", event => {
        if (event.relatedTarget?.closest?.(".page[data-page-number]")) return;
        this.hoverPointer = null;
        this.clearHover();
      }, options);
      // Scrolling changes the PDF point under a stationary mouse, even without pointermove.
      this.listen(doc, "scroll", () => this.scheduleHover(true), options);
      if (typeof frame.addEventListener === "function") {
        this.listen(frame, "resize", () => this.scheduleHover(true), options);
        this.listen(frame, "blur", () => {
          this.hoverPointer = null;
          this.clearHover();
        }, options);
      }
    });
  }

  /** Retain plain screen coordinates only while an unpressed primary mouse is over the PDF. */
  rememberHover(event, index) {
    if (this.disposed || !this.hoverEnabled) return;
    if (event.isPrimary === false || event.pointerType === "touch" || event.buttons > 0 || event.button > 0
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
      || !FragmentAlignment.contentPage(event.target)) {
      this.hoverPointer = null;
      this.clearHover();
      return;
    }
    this.hoverPointer = { index, x: event.clientX, y: event.clientY };
    this.scheduleHover(false, event.target);
  }

  /** Coalesce hover work after native rendering/annotation callbacks finish, not inside them. */
  scheduleHover(repaint = false, target = null) {
    if (this.disposed || !this.hoverEnabled || !this.mapping) return this.clearHover();
    this.hoverRepaint ||= repaint;
    if (this.hoverFrameRequest) return;
    const frame = this.frames[this.hoverPointer?.index ?? 0];
    if (typeof frame.requestAnimationFrame !== "function") {
      // Lightweight reader mocks may lack animation frames; normal Gecko windows provide them.
      const redraw = this.hoverRepaint;
      this.hoverRepaint = false;
      return this.refreshHover(target, redraw);
    }
    const request = { frame, id: null };
    this.hoverFrameRequest = request;
    request.id = frame.requestAnimationFrame(() => {
      if (this.hoverFrameRequest !== request) return;
      this.hoverFrameRequest = null;
      const redraw = this.hoverRepaint;
      this.hoverRepaint = false;
      // Wait for native render/layout callbacks before reading fresh hit geometry.
      this.refreshHover(null, redraw);
    });
  }

  /** Highlight one traceable request on both sides, without bringing offscreen pages into view. */
  refreshHover(target = null, repaint = false) {
    if (this.disposed || !this.hoverEnabled || !this.mapping || !this.hoverPointer) return this.clearHover();
    const { index, x, y } = this.hoverPointer;
    try {
      target ||= this.frames[index].document.elementFromPoint?.(x, y);
      const page = FragmentAlignment.contentPage(target);
      const pageIndex = Number(page?.getAttribute("data-page-number")) - 1;
      if (!page || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return this.clearHover();
      const pageView = this.apps[index].pdfViewer.getPageView(pageIndex);
      if (!pageView?.viewport?.convertToPdfPoint || pageView.div?.isConnected === false
        || (pageView.div !== page && !pageView.div?.isSameNode?.(page))
        || (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED)) {
        return this.clearHover();
      }
      const point = FragmentAlignment.pdfPoint(pageView, x, y);
      if (!point) return this.clearHover();
      const hit = FragmentAlignment.hitTest(this.mapping, pageIndex, point, index === 0 ? "source" : "target", true);
      if (!hit.unit || hit.unit.source.page >= this.apps[0].pdfViewer.pagesCount
        || hit.unit.target.page >= this.apps[1].pdfViewer.pagesCount) return this.clearHover();
      if (!repaint && this.hoverUnit === hit.unit
        && this.hoverHighlights.every(overlay => !overlay || overlay.isConnected !== false)) return;
      this.clearHover();
      this.hoverUnit = hit.unit;
      for (const [pane, side] of [hit.unit.source, hit.unit.target].entries()) {
        // Retain each layer immediately so a later viewport failure cannot leave an orphan.
        this.hoverHighlights[pane] = this.createHoverHighlight(side, pane, hit.unit.id);
      }
    } catch (error) {
      this.clearHover();
      this.hoverButton.title = "当前页面无法显示段落高亮；仍可正常阅读。";
    }
  }

  /** Remove only our cosmetic hover layers, leaving the native PDF and annotation DOM intact. */
  clearHover() {
    this.cancelHoverFrame();
    for (const overlay of this.hoverHighlights || []) overlay?.remove();
    this.hoverHighlights = [null, null];
    this.hoverUnit = null;
  }

  /** Cancel queued work without changing native text paints in the middle of a geometry update. */
  cancelHoverFrame() {
    if (this.hoverFrameRequest) {
      this.hoverFrameRequest.frame.cancelAnimationFrame(this.hoverFrameRequest.id);
      this.hoverFrameRequest = null;
    }
    this.hoverRepaint = false;
  }

  /** Match whole items, discounting only horizontal font line-box padding around verified ink. */
  static containsTextRect(rect, box, polygon = null) {
    const tolerance = this.TEXT_RECT_TOLERANCE;
    if (rect.left < box[0] - tolerance || rect.right > box[2] + tolerance) return false;
    let top = rect.top, bottom = rect.bottom;
    if (top < box[1] - tolerance || bottom > box[3] + tolerance) {
      const axisAligned = !polygon || polygon.every((value, index) =>
        Math.abs(value - box[index % 2]) <= this.GEOMETRY_EPSILON
        || Math.abs(value - box[index % 2 + 2]) <= this.GEOMETRY_EPSILON);
      const middle = (top + bottom) / 2;
      const overlap = Math.min(bottom, box[3]) - Math.max(top, box[1]);
      // PDF.js Range boxes include font ascent/descent, unlike the final painted glyph quads.
      // Do not widen horizontal, rotated, skewed or neighboring-line geometry to compensate.
      if (!axisAligned || box[2] - box[0] < box[3] - box[1]
        || middle < box[1] || middle > box[3]
        || overlap / (bottom - top) < this.TEXT_INK_MIN_HEIGHT_RATIO) return false;
      top = Math.max(top, box[1]);
      bottom = Math.min(bottom, box[3]);
    }
    if (top < box[1] - tolerance || bottom > box[3] + tolerance) return false;
    return !polygon || [[rect.left, top], [rect.right, top], [rect.right, bottom], [rect.left, bottom]]
      .every(point => this.pointInQuad(polygon, point, tolerance));
  }

  /** Paint complete native text items within one verified request, never guessed word pairs. */
  createHoverHighlight(side, index, unitID) {
    const pageView = this.apps[index].pdfViewer.getPageView(side.page);
    if (!pageView?.viewport || pageView.div?.isConnected === false
      || (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED)) return null;
    const { div, viewport } = pageView;
    const layer = div.querySelector(".textLayer");
    if (!layer) return null;
    const bounds = div.getBoundingClientRect();
    const width = div.clientWidth || viewport.width;
    const height = div.clientHeight || viewport.height;
    const cssX = bounds.width / (div.offsetWidth || width);
    const cssY = bounds.height / (div.offsetHeight || height);
    const left = bounds.left + (div.clientLeft || 0) * cssX;
    const top = bounds.top + (div.clientTop || 0) * cssY;
    const sx = width / viewport.width * cssX;
    const sy = height / viewport.height * cssY;
    const boxes = side.rects.map(rect => {
      const box = FragmentAlignment.viewportRect(viewport, rect);
      return [left + box[0] * sx, top + box[1] * sy, left + box[2] * sx, top + box[3] * sy];
    });
    const polygons = side.quads?.map(quad => {
      const polygon = FragmentAlignment.viewportQuad(viewport, quad);
      return polygon.map((value, coordinate) => coordinate % 2 ? top + value * sy : left + value * sx);
    });
    const ranges = [];
    for (const span of layer.querySelectorAll("span")) {
      const parent = span.parentElement?.closest("span");
      // Search markup belongs to its complete PDF text item; do not split it into words.
      if ((parent && !parent.classList.contains("markedContent"))
        || span.classList.contains("markedContent") || !span.textContent?.trim()) continue;
      const range = div.ownerDocument.createRange();
      range.selectNodeContents(span);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      if (rects.length && rects.every(rect => boxes.some((box, region) =>
        FragmentAlignment.containsTextRect(rect, box, polygons?.[region])))) {
        ranges.push(range);
      }
    }
    if (!ranges.length) return null;
    const frame = this.frames[index];
    const highlight = new frame.Highlight(...ranges);
    highlight.priority = FragmentAlignment.HOVER_PRIORITY;
    const registry = frame.CSS.highlights;
    registry.set(FragmentAlignment.HOVER_NAME, highlight);
    return { unitID, page: side.page, ranges, highlight,
      /** Native rerendered text items cannot keep a stale request visibly active. */
      get isConnected() {
        return registry.get(FragmentAlignment.HOVER_NAME) === highlight
          && ranges.every(range => range.startContainer.isConnected);
      },
      /** Delete only our exact registry entry, preserving search, selection, and other plugins. */
      remove() {
        if (registry.get(FragmentAlignment.HOVER_NAME) === highlight) registry.delete(FragmentAlignment.HOVER_NAME);
      }
    };
  }

  /** Remember either pane's release point; never consume links, selection, or annotations. */
  rememberPoint(event, index = 1) {
    if (event.button !== 0 || event.isPrimary === false) return;
    // Toolbar releases must retain the PDF hit until the subsequent explicit button click.
    if (!event.target?.closest?.(".page[data-page-number]")) return;
    if (index === 0) this.sourcePoint = null;
    else this.point = null;
    const page = FragmentAlignment.contentPage(event.target);
    if (!page) return;
    const label = index === 0 ? "原文" : "译文";
    try {
      const pageIndex = Number(page.getAttribute("data-page-number")) - 1;
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return;
      const pageView = this.apps[index].pdfViewer.getPageView(pageIndex);
      // Gecko may expose the same DOM node through Xray and waived reader wrappers.
      if (!pageView || (pageView.div !== page && !pageView.div?.isSameNode?.(page))
        || !pageView.viewport?.convertToPdfPoint) return;
      if (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED) {
        this.setStatus(label + "页面仍在渲染，请稍后点击片段。", !this.mapping);
        return;
      }
      const point = FragmentAlignment.pdfPoint(pageView, event.clientX, event.clientY);
      if (point) {
        const remembered = { page: pageIndex, point };
        if (index === 0) this.sourcePoint = remembered;
        else this.point = remembered;
      }
    } catch (error) {
      this.setStatus("无法读取当前" + label + "页面坐标；仍可正常阅读。", !this.mapping);
    }
  }

  /** Navigate only after the explicit action resolves one verified request-unit region. */
  localize(index = 1) {
    if (this.disposed || !this.mapping || ![0, 1].includes(index) || !this.navigationAvailable[1 - index]) return;
    this.clearHighlight();
    this.pending = null;
    this.pendingIndex = null;
    const point = index === 0 ? this.sourcePoint : this.point;
    const label = index === 0 ? "译文" : "原文";
    if (!point) return this.setStatus("请先点击或拖选" + (index === 0 ? "原文" : "译文") + " PDF 中的片段。");
    const hit = FragmentAlignment.hitTest(this.mapping, point.page, point.point, index === 0 ? "source" : "target");
    if (hit.status === "ambiguous") return this.setStatus("此处可信片段重叠，无法唯一定位" + label + "。");
    if (!hit.unit) return this.setStatus("此处没有已验证的片段映射。");
    const destinationSide = index === 0 ? hit.unit.target : hit.unit.source;
    const destinationIndex = 1 - index;
    const viewer = this.apps[destinationIndex].pdfViewer;
    if (destinationSide.page >= viewer.pagesCount) return this.setStatus("映射的" + label + "页不存在；仍可正常阅读。");
    try {
      this.guardNavigation();
      this.pending = destinationSide;
      this.pendingIndex = destinationIndex;
      // XYZ accepts PDF-native coordinates, including negative crop-box origins.
      const destination = { pageNumber: destinationSide.page + 1,
        destArray: [null, { name: "XYZ" }, destinationSide.rects[0][0], destinationSide.rects[0][3], null],
        allowNegativeOffset: true };
      const cloned = typeof Components !== "undefined" && Components.utils?.cloneInto
        ? Components.utils.cloneInto(destination, this.frames[destinationIndex]) : destination;
      viewer.scrollPageIntoView(cloned);
      this.setStatus("已定位" + label + "片段。");
      if (this.pending) this.showHighlight();
    } catch (error) {
      this.pending = null;
      this.pendingIndex = null;
      this.clearHighlight();
      this.setStatus("片段定位失败：" + (error.message || "阅读器接口不可用。"));
    }
  }

  /** Suppress parent page sync briefly without changing sync mode or the active pane. */
  guardNavigation() {
    this.navigationUntil = Date.now() + FragmentAlignment.NAVIGATION_GRACE_MS;
    this.state.alignmentNavigationUntil = this.navigationUntil;
  }

  /** Keep the existing explicit-localization overlay separate from hover's native text paint. */
  createHighlight(side, index, className, markStyle, unitID = "") {
    const pageView = this.apps[index].pdfViewer.getPageView(side.page);
    if (!pageView?.viewport || !pageView.div || pageView.div.isConnected === false) return null;
    // Unrendered placeholders may still carry another page's default viewport.
    if (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED) return null;
    const { div, viewport } = pageView;
    const overlay = div.ownerDocument.createElement("div");
    overlay.className = className;
    overlay.setAttribute("aria-hidden", "true");
    if (unitID) overlay.setAttribute("data-unit-id", unitID);
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;user-select:none;z-index:30";
    const scaleX = (div.clientWidth || viewport.width) / viewport.width;
    const scaleY = (div.clientHeight || viewport.height) / viewport.height;
    for (const [region, rect] of side.rects.entries()) {
      const polygon = side.quads ? FragmentAlignment.viewportQuad(viewport, side.quads[region]) : null;
      const box = polygon ? FragmentAlignment.quadBounds(polygon) : FragmentAlignment.viewportRect(viewport, rect);
      const mark = div.ownerDocument.createElement("div");
      mark.style.cssText = "position:absolute;pointer-events:none;user-select:none;box-sizing:border-box;" + markStyle;
      mark.style.left = box[0] * scaleX + "px";
      mark.style.top = box[1] * scaleY + "px";
      mark.style.width = (box[2] - box[0]) * scaleX + "px";
      mark.style.height = (box[3] - box[1]) * scaleY + "px";
      if (polygon) {
        // Each line paints only its polygon; the paragraph's inter-line gaps remain untouched.
        const points = [];
        for (let coordinate = 0; coordinate < polygon.length; coordinate += 2) {
          points.push((polygon[coordinate] - box[0]) / (box[2] - box[0]) * 100 + "% "
            + (polygon[coordinate + 1] - box[1]) / (box[3] - box[1]) * 100 + "%");
        }
        mark.style.clipPath = "polygon(" + points.join(",") + ")";
      }
      overlay.append(mark);
    }
    div.append(overlay);
    return overlay;
  }

  /** Paint either destination using its own viewport and cosmetic expiration timer. */
  showHighlight() {
    if (!this.pending || this.disposed) return;
    try {
      const index = this.pendingIndex;
      const overlay = this.createHighlight(this.pending, index, "paperbridge-fragment-highlight",
        "background:rgba(255,210,0,.28);border:2px solid #e5a900");
      if (!overlay) return;
      this.clearHighlight();
      this.highlight = overlay;
      this.highlightSide = this.pending;
      this.highlightIndex = index;
      this.pending = null;
      this.pendingIndex = null;
      this.guardNavigation();
      this.highlightTimer = this.frames[index].setTimeout(() => this.clearHighlight(), FragmentAlignment.HIGHLIGHT_MS);
    } catch (error) {
      const label = this.pendingIndex === 1 || this.highlightIndex === 1 ? "译文" : "原文";
      this.pending = null;
      this.pendingIndex = null;
      this.clearHighlight();
      this.setStatus("已定位" + label + "；当前页面无法显示临时高亮。");
    }
  }

  /** Remove the temporary overlay and cancel its cosmetic expiration timer. */
  clearHighlight() {
    if (this.highlightTimer != null) this.frames[this.highlightIndex].clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.highlight?.remove();
    this.highlight = null;
    this.highlightSide = null;
    this.highlightIndex = null;
  }

  /** Release listeners, timers, pending work, and controls on split closure. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.noteSelection = null;
    this.selectionNoteButton.disabled = true;
    this.annotationsNoteButton.disabled = true;
    this.clearHighlight();
    this.clearHover();
    this.hoverEnabled = false;
    this.hoverPointer = null;
    this.pending = null;
    this.pendingIndex = null;
    this.point = null;
    this.sourcePoint = null;
    this.mapping = null;
    for (const remove of this.removers.splice(0)) remove();
    if (this.state.alignmentNavigationUntil === this.navigationUntil) this.state.alignmentNavigationUntil = 0;
    this.control?.remove();
  }
};
