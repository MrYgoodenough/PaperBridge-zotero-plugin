/** Explicit localization and opt-in bilateral hover of parent-validated request units. */
/* global Components */
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

  /** Create one controller per split; loading and hash validation belong to the parent. */
  constructor({ loadMapping } = {}) {
    this.loadMapping = loadMapping;
    this.removers = [];
    this.disposed = true;
  }

  /** Check only the in-memory contract, never PDF files, hashes, or HTTP resources. */
  static checkMapping(mapping) {
    if (!mapping) return { mapping: null, reason: "没有可用的片段映射。" };
    if (mapping.schema_version !== 1 || mapping.coordinate_space !== "pdf-user-space"
      || typeof mapping.source_sha256 !== "string" || typeof mapping.output_sha256 !== "string"
      || !Array.isArray(mapping.units)) {
      return { mapping: null, reason: "片段映射格式不受支持。" };
    }
    const ids = new Set();
    for (const unit of mapping.units) {
      if (!unit || typeof unit.id !== "string" || !unit.id || ids.has(unit.id)
        || unit.status !== "verified" || !this.validSide(unit.source) || !this.validSide(unit.target)) {
        return { mapping: null, reason: "片段映射损坏或包含未验证的片段。" };
      }
      ids.add(unit.id);
    }
    return mapping.units.length ? { mapping, reason: "" }
      : { mapping: null, reason: "片段映射中没有已验证的片段。" };
  }

  /** Accept nonempty canonical rectangles on one zero-based PDF page. */
  static validSide(side) {
    return !!side && Number.isSafeInteger(side.page) && side.page >= 0
      && Array.isArray(side.rects) && side.rects.length > 0
      && side.rects.every(rect => Array.isArray(rect) && rect.length === 4
        && rect.every(Number.isFinite) && rect[0] < rect[2] && rect[1] < rect[3]);
  }

  /** Resolve either side; hover groups rectangles of one request without guessing across units. */
  static hitTest(mapping, page, point, side = "target", wholeUnit = false) {
    let hit = null;
    for (const unit of mapping.units) {
      if (unit[side].page !== page) continue;
      for (const rect of unit[side].rects) {
        if (point[0] < rect[0] || point[0] > rect[2] || point[1] < rect[1] || point[1] > rect[3]) continue;
        if (hit && (!wholeUnit || hit !== unit)) return { status: "ambiguous", unit: null };
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

  /** Accept PDF content, not native annotation editors, handles, or overlaid controls. */
  static contentPage(target) {
    if (target?.closest?.(".customAnnotationLayer, .annotation-popup, .toolbar, button, input, textarea, [contenteditable]")) return null;
    return target?.closest?.(".page[data-page-number]") || null;
  }

  /** Return a splitControls-compatible control; omitted mapping uses loadMapping(state). */
  attach(state, mapping, reason = "") {
    this.dispose();
    this.state = state;
    this.disposed = false;
    this.mapping = null;
    this.point = null;
    this.pending = null;
    this.hoverEnabled = false;
    this.hoverPointer = null;
    this.hoverUnit = null;
    this.hoverHighlights = [null, null];
    this.hoverFrameRequest = null;
    this.hoverRepaint = false;
    const leftFrame = state.reader?._internalReader?._primaryView?._iframeWindow;
    const rightFrame = state.right?._primaryView?._iframeWindow;
    this.frames = [leftFrame, rightFrame];
    this.apps = this.frames.map(frame => frame?.PDFViewerApplication);
    const doc = state.browser?.contentDocument || rightFrame?.document || state.reader?._iframeWindow?.document;
    this.control = doc.createElement("div");
    this.control.className = "paperbridge-fragment-alignment";
    this.control.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:5px;max-width:330px";
    this.button = doc.createElement("button");
    this.button.textContent = "定位原文片段";
    this.button.style.cssText = "font:inherit;padding:5px 8px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap";
    this.status = doc.createElement("span");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.style.cssText = "font-size:12px;overflow-wrap:anywhere";
    this.hoverButton = doc.createElement("button");
    this.hoverButton.className = "paperbridge-paragraph-hover-toggle";
    this.hoverButton.setAttribute("aria-label", "原译文段落双向高亮");
    this.hoverButton.style.cssText = this.button.style.cssText;
    this.control.append(this.button, this.status, this.hoverButton);
    const control = this.control;
    state.cleanups.push(() => {
      if (this.control === control) this.dispose();
    });
    this.listen(this.button, "click", () => this.localize());
    this.listen(this.hoverButton, "click", () => this.toggleHover());

    this.pagesAvailable = this.apps.every(app => typeof app?.pdfViewer?.getPageView === "function"
      && typeof app?.eventBus?.on === "function" && typeof app?.eventBus?.off === "function");
    this.hoverAvailable = this.pagesAvailable && this.frames.every(frame =>
      typeof frame.Highlight === "function" && frame.CSS?.highlights);
    this.localizeAvailable = this.pagesAvailable && typeof this.apps[0].pdfViewer.scrollPageIntoView === "function";
    this.updateHoverButton("正在读取片段映射…");
    if (!this.pagesAvailable) {
      this.setStatus("片段定位接口不可用；仍可正常阅读。", true);
      this.updateHoverButton("段落高亮接口不可用；仍可正常阅读。");
      return control;
    }
    // Observe before native selection handlers stop bubbling, without cancelling their behavior.
    this.listen(rightFrame.document, "pointerup", event => this.rememberPoint(event), { capture: true, passive: true });
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
            if (index === 1 && event?.pageNumber !== this.point?.page + 1) return;
            if (index === 0 && event?.pageNumber !== (this.pending || this.highlightSource)?.page + 1) return;
          }
          this.clearHighlight();
          if (index === 1) this.point = null;
          if (index === 0 && type === "pagerendered" && this.pending) {
            this.showHighlight();
          } else if (index === 0 && type === "pagechanging" && event?.pageNumber === this.pending?.page + 1) {
            // A navigation-induced page change must not discard the pending source highlight.
          } else {
            this.pending = null;
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
    this.clearHover();
    this.mapping = checked.mapping;
    if (!this.mapping) {
      this.hoverEnabled = false;
      this.hoverPointer = null;
    }
    const unavailable = reason || checked.reason;
    this.setStatus(this.mapping ? (this.localizeAvailable ? "点击译文片段，再按定位按钮。"
      : "片段定位接口不可用；悬停高亮仍可使用。") : unavailable, !this.mapping);
    this.updateHoverButton(this.mapping ? "" : unavailable);
    this.scheduleHover();
  }

  /** Display status without alerts or changes to ordinary reading behavior. */
  setStatus(message, disabled = false) {
    this.status.textContent = message;
    this.button.disabled = disabled || !this.localizeAvailable;
    this.button.title = message;
  }

  /** Show an independent per-split switch and a nonfatal mapping availability reason. */
  updateHoverButton(reason = "") {
    this.hoverButton.textContent = this.hoverEnabled ? "⇄ 段落高亮开启" : "⇄ 段落高亮关闭";
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

  /** Paint whole native text items wholly inside one verified request, never guessed word pairs. */
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
    const ranges = [];
    const tolerance = FragmentAlignment.TEXT_RECT_TOLERANCE;
    for (const span of layer.querySelectorAll("span")) {
      const parent = span.parentElement?.closest("span");
      // Search markup belongs to its complete PDF text item; do not split it into words.
      if ((parent && !parent.classList.contains("markedContent"))
        || span.classList.contains("markedContent") || !span.textContent?.trim()) continue;
      const range = div.ownerDocument.createRange();
      range.selectNodeContents(span);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      if (rects.length && rects.every(rect => boxes.some(box => rect.left >= box[0] - tolerance
        && rect.top >= box[1] - tolerance && rect.right <= box[2] + tolerance && rect.bottom <= box[3] + tolerance))) {
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

  /** Remember ordinary primary pointer releases without cancelling native selection or links. */
  rememberPoint(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const page = event.target?.closest?.(".page[data-page-number]");
    if (!page) return;
    this.point = null;
    try {
      const pageIndex = Number(page.getAttribute("data-page-number")) - 1;
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return;
      const pageView = this.apps[1].pdfViewer.getPageView(pageIndex);
      // Gecko may expose the same DOM node through Xray and waived reader wrappers.
      if (!pageView || (pageView.div !== page && !pageView.div?.isSameNode?.(page))
        || !pageView.viewport?.convertToPdfPoint) return;
      if (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED) {
        this.setStatus("译文页面仍在渲染，请稍后点击片段。", !this.mapping);
        return;
      }
      const point = FragmentAlignment.pdfPoint(pageView, event.clientX, event.clientY);
      if (point) this.point = { page: pageIndex, point };
    } catch (error) {
      this.setStatus("无法读取当前译文页面坐标；仍可正常阅读。", !this.mapping);
    }
  }

  /** Navigate only after the explicit action resolves exactly one verified rectangle. */
  localize() {
    if (this.disposed || !this.mapping || !this.localizeAvailable) return;
    this.clearHighlight();
    this.pending = null;
    if (!this.point) return this.setStatus("请先点击译文 PDF 中的片段。");
    const hit = FragmentAlignment.hitTest(this.mapping, this.point.page, this.point.point);
    if (hit.status === "ambiguous") return this.setStatus("此处映射矩形重叠，无法唯一定位原文。");
    if (!hit.unit) return this.setStatus("此处没有已验证的片段映射。");
    const source = hit.unit.source;
    const viewer = this.apps[0].pdfViewer;
    if (source.page >= viewer.pagesCount) return this.setStatus("映射的原文页不存在；仍可正常阅读。");
    try {
      this.guardNavigation();
      this.pending = source;
      // XYZ accepts PDF-native coordinates, including negative crop-box origins.
      const destination = { pageNumber: source.page + 1,
        destArray: [null, { name: "XYZ" }, source.rects[0][0], source.rects[0][3], null],
        allowNegativeOffset: true };
      const cloned = typeof Components !== "undefined" && Components.utils?.cloneInto
        ? Components.utils.cloneInto(destination, this.frames[0]) : destination;
      viewer.scrollPageIntoView(cloned);
      this.setStatus("已定位原文片段。");
      if (this.pending) this.showHighlight();
    } catch (error) {
      this.pending = null;
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
    for (const rect of side.rects) {
      const box = FragmentAlignment.viewportRect(viewport, rect);
      const mark = div.ownerDocument.createElement("div");
      mark.style.cssText = "position:absolute;pointer-events:none;user-select:none;box-sizing:border-box;" + markStyle;
      mark.style.left = box[0] * scaleX + "px";
      mark.style.top = box[1] * scaleY + "px";
      mark.style.width = (box[2] - box[0]) * scaleX + "px";
      mark.style.height = (box[3] - box[1]) * scaleY + "px";
      overlay.append(mark);
    }
    div.append(overlay);
    return overlay;
  }

  /** Paint an explicitly localized source fragment with a separate cosmetic expiration timer. */
  showHighlight() {
    if (!this.pending || this.disposed) return;
    try {
      const overlay = this.createHighlight(this.pending, 0, "paperbridge-fragment-highlight",
        "background:rgba(255,210,0,.28);border:2px solid #e5a900");
      if (!overlay) return;
      this.clearHighlight();
      this.highlight = overlay;
      this.highlightSource = this.pending;
      this.pending = null;
      this.guardNavigation();
      this.highlightTimer = this.frames[0].setTimeout(() => this.clearHighlight(), FragmentAlignment.HIGHLIGHT_MS);
    } catch (error) {
      this.pending = null;
      this.clearHighlight();
      this.setStatus("已定位原文；当前页面无法显示临时高亮。");
    }
  }

  /** Remove the temporary overlay and cancel its cosmetic expiration timer. */
  clearHighlight() {
    if (this.highlightTimer != null) this.frames[0].clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.highlight?.remove();
    this.highlight = null;
    this.highlightSource = null;
  }

  /** Release listeners, timers, pending work, and controls on split closure. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHighlight();
    this.clearHover();
    this.hoverEnabled = false;
    this.hoverPointer = null;
    this.pending = null;
    this.point = null;
    this.mapping = null;
    for (const remove of this.removers.splice(0)) remove();
    if (this.state.alignmentNavigationUntil === this.navigationUntil) this.state.alignmentNavigationUntil = 0;
    this.control?.remove();
  }
};
