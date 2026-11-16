window.addEventListener("load", () => {
  const bridge = window.arguments[0].bridge;
  const cache = bridge.formulaCache;
  const get = id => document.getElementById(id);
  let selected;
  get("location").textContent = cache.root;
  const select = doc => {
    selected = doc?.id;
    get("clear").disabled = !doc;
    for (const button of get("documents").children) button.setAttribute("aria-pressed",String(button.dataset.id === selected));
    get("details").value = doc ? [doc.title, `${doc.id}.json`,
      `公式：${doc.entries.length} 条 · 已识别页面：${doc.pages} · 论文引用：${doc.references.length}`,
      ...(doc.error ? [doc.error] : []), "",
      ...doc.entries.map((entry,index) => `${index+1}. ${entry.page === null ? "" : `第 ${entry.page+1} 页`}\n${entry.text}\n$$${entry.latex}$$\n`)].join("\n") : "暂无公式缓存。";
  };
  const refresh = async () => {
    const docs = await cache.list();
    get("documents").replaceChildren();
    for (const doc of docs) {
      const button = document.createElementNS("http://www.w3.org/1999/xhtml","button");
      button.textContent = `${doc.title}\n${doc.entries.length} 条公式 · ${doc.pages} 页`;
      button.dataset.id = doc.id;
      button.addEventListener("click",() => select(doc));
      get("documents").append(button);
    }
    select(docs.find(d => d.id === selected) || docs[0]);
    get("clear-all").disabled = docs.length === 0;
    get("status").textContent = cache.lastError ? `最近一次缓存操作：${cache.lastError}` : `${docs.length} 篇 PDF`;
  };
  const action = task => async () => {
    try {await task();} catch (error) {get("status").textContent=error.message;}
  };
  get("refresh").addEventListener("click",action(refresh));
  get("clear").addEventListener("click",action(async () => {
    if (!selected) return;
    await cache.clear(selected); await refresh(); get("status").textContent="所选公式缓存已清除。";
  }));
  get("clear-all").addEventListener("click",action(async () => {
    await cache.clear(); await refresh(); get("status").textContent="全部公式缓存已清除。";
  }));
  get("close").addEventListener("click",() => window.close());
  action(refresh)();
});
