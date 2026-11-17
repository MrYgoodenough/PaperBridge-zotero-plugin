/** Display local formula documents and clear only their dedicated JSON cache. */
// Cache controls are XHTML elements inside a native Zotero chrome window.
const FORMULA_CACHE_UI_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** Initialize the shared cache viewer without creating a second cache instance. */
window.addEventListener("load", () => {
  const bridge = window.arguments[0].bridge;
  const cache = bridge.formulaCache;
  /** Locate a cache-window control. */
  const get = id => document.getElementById(id);
  let selected;
  get("location").textContent = cache.root;
  /** Show a selected document's nonsecret formula contents and ownership count. */
  const select = doc => {
    selected = doc?.id;
    get("clear").disabled = !doc;
    for (const button of get("documents").children) {
      button.setAttribute("aria-pressed", String(button.dataset.id === selected));
    }
    get("details").value = doc ? [doc.title, `${doc.id}.json`,
      `公式：${doc.entries.length} 条 · 已识别页面：${doc.pages} · 论文引用：${doc.references.length}`,
      ...(doc.error ? [doc.error] : []), "",
      ...doc.entries.map((entry,index) => `${index+1}. ${entry.page === null ? "" : `第 ${entry.page+1} 页`}\n${entry.text}\n$$${entry.latex}$$\n`)].join("\n") : "暂无公式缓存。";
  };
  /** Refresh completed documents and any visible cache-operation warning. */
  const refresh = async () => {
    const docs = await cache.list();
    get("documents").replaceChildren();
    for (const doc of docs) {
      const button = document.createElementNS(FORMULA_CACHE_UI_NAMESPACE, "button");
      button.textContent = `${doc.title}\n${doc.entries.length} 条公式 · ${doc.pages} 页`;
      button.dataset.id = doc.id;
      button.addEventListener("click",() => select(doc));
      get("documents").append(button);
    }
    select(docs.find(d => d.id === selected) || docs[0]);
    get("clear-all").disabled = docs.length === 0;
    get("status").textContent = cache.lastError ? `最近一次缓存操作：${cache.lastError}` : `${docs.length} 篇 PDF`;
  };
  /** Report a failed user action in the window without hiding existing documents. */
  const action = task => async () => {
    try { await task(); }
    catch (error) { get("status").textContent = error.message; }
  };
  /** Remove the selected formula JSON and retain PDFs and all unrelated caches. */
  const clearSelected = async () => {
    if (!selected) return;
    await cache.clear(selected);
    await refresh();
    get("status").textContent = "所选公式缓存已清除。";
  };
  /** Clear all formula documents and invalidate pending cache writes. */
  const clearAll = async () => {
    await cache.clear();
    await refresh();
    get("status").textContent = "全部公式缓存已清除。";
  };
  get("refresh").addEventListener("click", action(refresh));
  get("clear").addEventListener("click", action(clearSelected));
  get("clear-all").addEventListener("click", action(clearAll));
  get("close").addEventListener("click",() => window.close());
  action(refresh)();
});
