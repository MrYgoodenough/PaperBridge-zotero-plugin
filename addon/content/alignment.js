/** Explicit translated-fragment localization using parent-validated PDF mappings. */
/* global Components */
var FragmentAlignment = class FragmentAlignment {
  // Highlight lifetime is cosmetic, not a page-render readiness deadline.
  static HIGHLIGHT_MS = 2500;
  // Give existing page sync time to ignore programmatic navigation events.
  static NAVIGATION_GRACE_MS = 3000;
  // PDF.js RenderingStates.FINISHED means the page-specific viewport has been rendered.
  static RENDERING_FINISHED = 3;

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

  /** Require exactly one target rectangle hit, including overlaps within the same unit. */
  static hitTest(mapping, page, point) {
    let hit = null;
    for (const unit of mapping.units) {
      if (unit.target.page !== page) continue;
      for (const rect of unit.target.rects) {
        if (point[0] < rect[0] || point[0] > rect[2] || point[1] < rect[1] || point[1] > rect[3]) continue;
        if (hit) return { status: "ambiguous", unit: null };
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

  /** Return a splitControls-compatible control; omitted mapping uses loadMapping(state). */
  attach(state, mapping, reason = "") {
    this.dispose();
    this.state = state;
    this.disposed = false;
    this.mapping = null;
    this.point = null;
    this.pending = null;
    const leftFrame = state.reader?._internalReader?._primaryView?._iframeWindow;
    const rightFrame = state.right?._primaryView?._iframeWindow;
    this.frames = [leftFrame, rightFrame];
    this.apps = this.frames.map(frame => frame?.PDFViewerApplication);
    const doc = state.browser?.contentDocument || rightFrame?.document || state.reader?._iframeWindow?.document;
    this.control = doc.createElement("div");
    this.control.className = "paperbridge-fragment-alignment";
    this.control.style.cssText = "display:flex;align-items:center;gap:5px;max-width:330px";
    this.button = doc.createElement("button");
    this.button.textContent = "定位原文片段";
    this.button.style.cssText = "font:inherit;padding:5px 8px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap";
    this.status = doc.createElement("span");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.style.cssText = "font-size:12px;overflow-wrap:anywhere";
    this.control.append(this.button, this.status);
    const control = this.control;
    state.cleanups.push(() => {
      if (this.control === control) this.dispose();
    });
    this.listen(this.button, "click", () => this.localize());

    if (!this.apps.every(app => typeof app?.pdfViewer?.getPageView === "function"
      && typeof app?.eventBus?.on === "function" && typeof app?.eventBus?.off === "function")
      || typeof this.apps[0].pdfViewer.scrollPageIntoView !== "function") {
      this.setStatus("片段定位接口不可用；仍可正常阅读。", true);
      return control;
    }
    // Observe before native selection handlers stop bubbling, without cancelling their behavior.
    this.listen(rightFrame.document, "pointerup", event => this.rememberPoint(event), { capture: true, passive: true });
    this.bindPageEvents();
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
    this.mapping = checked.mapping;
    this.setStatus(this.mapping ? "点击译文片段，再按定位按钮。" : reason || checked.reason, !this.mapping);
  }

  /** Display status without alerts or changes to ordinary reading behavior. */
  setStatus(message, disabled = false) {
    this.status.textContent = message;
    this.button.disabled = disabled;
    this.button.title = message;
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
    if (this.disposed || !this.mapping) return;
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

  /** Paint transient DOM rectangles with the original page's viewport, never annotations. */
  showHighlight() {
    if (!this.pending || this.disposed) return;
    const pageView = this.apps[0].pdfViewer.getPageView(this.pending.page);
    if (!pageView?.viewport || !pageView.div || pageView.div.isConnected === false) return;
    // Unrendered placeholders may still carry another page's default viewport.
    if (pageView.renderingState != null && pageView.renderingState !== FragmentAlignment.RENDERING_FINISHED) return;
    const { div, viewport } = pageView;
    try {
      const overlay = div.ownerDocument.createElement("div");
      overlay.className = "paperbridge-fragment-highlight";
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:30";
      const scaleX = (div.clientWidth || viewport.width) / viewport.width;
      const scaleY = (div.clientHeight || viewport.height) / viewport.height;
      for (const rect of this.pending.rects) {
        const box = FragmentAlignment.viewportRect(viewport, rect);
        const mark = div.ownerDocument.createElement("div");
        mark.style.cssText = "position:absolute;pointer-events:none;box-sizing:border-box;background:rgba(255,210,0,.28);border:2px solid #e5a900";
        mark.style.left = box[0] * scaleX + "px";
        mark.style.top = box[1] * scaleY + "px";
        mark.style.width = (box[2] - box[0]) * scaleX + "px";
        mark.style.height = (box[3] - box[1]) * scaleY + "px";
        overlay.append(mark);
      }
      this.clearHighlight();
      div.append(overlay);
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
    this.pending = null;
    this.point = null;
    this.mapping = null;
    for (const remove of this.removers.splice(0)) remove();
    if (this.state.alignmentNavigationUntil === this.navigationUntil) this.state.alignmentNavigationUntil = 0;
    this.control?.remove();
  }
};
