window.addEventListener("load", () => {
  const bridge = window.arguments[0].bridge;
  const fields = ["baseURL", "model", "language", "pages", "pythonPath"];
  const get = id => document.getElementById(id);
  for (const name of fields) get(name).value = bridge.pref(name);
  get("python-settings").hidden = bridge.runtime.build?.pythonMode === "bundled";
  get("key").value = bridge.getKey();
  get("locations").textContent = `译文：${bridge.storageRoot}/<附件 key>/translated.pdf\n缓存与引擎：${bridge.runtime.base}`;
  if (bridge.library.lastError) get("status").textContent = "上次缓存清理未完成："+bridge.library.lastError;
  const recorded=bridge.pref("lastUsage");
  if (recorded) {
    const usage=JSON.parse(recorded);
    get("usage").textContent=usage.full_pdf_cache ? "最近任务：复用本地译文，0 次 API 调用。" :
      `最近任务：${usage.api_requests} 次 API，输入 ${usage.input_tokens} token（命中 ${usage.cached_input_tokens}，未命中 ${usage.uncached_input_tokens}），输出 ${usage.output_tokens} token。`;
  }
  const save = async () => {
    const baseURL = get("baseURL").value.trim().replace(/\/$/, "");
    if (!baseURL.startsWith("https://")) throw new Error("API 地址应以 https:// 开头。");
    const pythonChanged = get("pythonPath").value.trim() !== bridge.pref("pythonPath");
    for (const name of fields) bridge.setPref(name, get(name).value.trim());
    if (pythonChanged) await bridge.runtime.stop();
    bridge.setPref("baseURL", baseURL);
    await bridge.saveKey(get("key").value.trim());
    get("status").textContent = "设置已保存。打开 PDF，点击工具栏「译 / 分屏」。";
  };
  get("save").addEventListener("click", async () => {
    try { await save(); } catch (error) { get("status").textContent = error.message; }
  });
  get("test").addEventListener("click", async () => {
    try {
      await save();
      const health = await bridge.request("/health");
      get("status").textContent = `排版引擎已就绪 · ${health.engine} · v${health.version}\nPython：${health.python}`;
    } catch (error) { get("status").textContent = error.message; }
  });
  get("close").addEventListener("click", () => window.close());
  get("data").addEventListener("click", () => bridge.openDataDirectory());
});
