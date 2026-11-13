/** Edit two isolated provider profiles and shared translation settings. */

/** Initialize profile drafts without storing credentials in preferences. */
window.addEventListener("load", function initializeSettings() {
  const bridge = window.arguments[0].bridge;
  // Separate controls retain unsaved drafts, including keys, when switching profiles.
  const profiles = {
    deepseek: { section: "deepseek-settings", key: "key", baseURL: "baseURL", model: "model" },
    compatible: { section: "compatible-settings", key: "compatibleKey", baseURL: "compatibleBaseURL", model: "compatibleModel" }
  };
  // These preferences apply to both profiles.
  const globalFields = ["language", "pages", "pythonPath"];
  // Zotero integer preferences use signed 32-bit values.
  const maxPrefInteger = 2147483647;
  let saving = false;

  /** Find a settings control. */
  function get(id) { return document.getElementById(id); }

  /** Show only the selected draft and expand compatible capabilities. */
  function showProfile() {
    const selected = get("profile").value;
    for (const [profile, fields] of Object.entries(profiles)) {
      get(fields.section).hidden = profile !== selected;
    }
    if (selected === "compatible") get("compatible-capabilities").open = true;
  }

  /** Validate an HTTPS base URL without credentials, queries, or fragments. */
  function endpoint(value) {
    let url;
    try { url = new URL(value); } catch (_) { /* Report the same actionable error below. */ }
    if (!url || !/^https:\/\//i.test(value) || url.protocol !== "https:" || !url.hostname ||
        url.username || url.password || /[?#\\\s\u0000-\u001f\u007f]/.test(value) ||
        value.slice("https://".length).split("/")[0].includes("@")) {
      throw new Error("API 地址必须是有效的 HTTPS 地址，且不含账号、密码、查询参数或片段。");
    }
    return value.replace(/\/+$/, "");
  }

  /** Validate the current draft before writing its key or preferences. */
  async function save() {
    const profile = get("profile").value;
    if (!Object.hasOwn(profiles, profile)) throw new Error("请选择 DeepSeek 或 OpenAI 兼容配置。");
    const fields = profiles[profile];
    const baseURL = endpoint(get(fields.baseURL).value.trim());
    const model = get(fields.model).value.trim();
    if (!model || /[\s\u0000-\u001f\u007f]/.test(model)) throw new Error("请填写不含空白字符的模型名称。");
    const key = get(fields.key).value.trim();
    if (/[\s\u0000-\u001f\u007f]/.test(key)) throw new Error("API Key 不能包含空白或控制字符。");
    const pages = get("pages").value.trim();
    if (pages && (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages) ||
        pages.split(",").some(function invalidRange(range) {
          /** Reject non-positive, reversed, or unsafe integer page ranges. */
          const [first, last = first] = range.split("-").map(Number);
          return !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first;
        }))) {
      throw new Error("页码应为正整数或递增范围，例如 1-3,5；留空表示全文。");
    }
    const language = get("language").value;
    if (!["zh-CN", "zh-TW", "ja"].includes(language)) throw new Error("请选择目标语言。");
    let maxTokens;
    if (profile === "compatible") {
      const value = get("compatibleMaxTokens").value.trim();
      maxTokens = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxPrefInteger) {
        throw new Error(`max_tokens 必须是 1–${maxPrefInteger} 的整数，请按服务商限制填写。`);
      }
    }
    const pythonPath = get("pythonPath").value.trim();
    const pythonChanged = pythonPath !== bridge.pref("pythonPath");
    // Always pass the profile explicitly; a failed key write must not activate new settings.
    await bridge.saveKey(key, profile);
    bridge.setPref(fields.baseURL, baseURL);
    bridge.setPref(fields.model, model);
    if (profile === "compatible") {
      bridge.setPref("compatibleJSON", get("compatibleJSON").checked);
      bridge.setPref("compatibleMaxTokens", maxTokens);
    }
    bridge.setPref("language", language);
    bridge.setPref("pages", pages);
    bridge.setPref("pythonPath", pythonPath);
    bridge.setPref("profile", profile);
    get(fields.baseURL).value = baseURL;
    get(fields.model).value = model;
    get(fields.key).value = key;
    if (pythonChanged) await bridge.runtime.stop();
    get("status").textContent = "设置已保存（仅当前配置及全局设置）。已排队任务仍使用入队时的配置。";
  }

  /** Save once and optionally check only the local layout engine. */
  async function handleSave(event) {
    if (saving) return;
    const checkEngine = event.currentTarget.id === "test";
    saving = true;
    // Lock editing across asynchronous key writes to prevent profile/key races.
    const controls = document.querySelectorAll("input, select, #save, #test");
    for (const control of controls) control.disabled = true;
    try {
      await save();
      if (checkEngine) {
        const health = await bridge.request("/health");
        get("status").textContent = `设置已保存。排版引擎已就绪 · ${health.engine} · v${health.version}\nPython：${health.python}\n仅检查本地引擎；未验证 API Key、模型或服务商兼容性。`;
      }
    } catch (error) {
      get("status").textContent = error.message;
    } finally {
      for (const control of controls) control.disabled = false;
      saving = false;
    }
  }

  /** Close without saving any remaining drafts. */
  function close() { window.close(); }

  /** Open the engine and cache directory. */
  async function openData() {
    try { await bridge.openDataDirectory(); } catch (error) { get("status").textContent = error.message; }
  }

  get("close").addEventListener("click", close);
  get("data").addEventListener("click", openData);
  // Do not fall back to legacy unscoped key access, which could mix credentials.
  if (typeof bridge.configuration !== "function") {
    get("status").textContent = "此设置界面需要支持双配置的 PaperBridge 主程序，请更新插件后重开设置。";
    for (const control of document.querySelectorAll("input, select, #save, #test")) control.disabled = true;
    return;
  }
  const current = bridge.configuration();
  get("profile").value = current.profile === "compatible" ? "compatible" : "deepseek";
  for (const [profile, fields] of Object.entries(profiles)) {
    const config = bridge.configuration(profile);
    get(fields.baseURL).value = config.baseURL;
    get(fields.model).value = config.model;
    get(fields.key).value = bridge.getKey(profile);
    if (profile === "compatible") {
      get("compatibleJSON").checked = config.capabilities.json_mode;
      get("compatibleMaxTokens").value = config.capabilities.max_tokens;
    }
  }
  for (const name of globalFields) get(name).value = bridge.pref(name);
  get("python-settings").hidden = bridge.runtime.build?.pythonMode === "bundled";
  showProfile();
  get("profile").addEventListener("change", showProfile);
  get("save").addEventListener("click", handleSave);
  get("test").addEventListener("click", handleSave);
  get("locations").textContent = `译文：${bridge.storageRoot}/<附件 key>/translated.pdf\n缓存与引擎：${bridge.runtime.base}`;
  if (bridge.library.lastError) get("status").textContent = "上次缓存清理未完成：" + bridge.library.lastError;
  const recorded = bridge.pref("lastUsage");
  if (recorded) {
    try {
      const usage = JSON.parse(recorded);
      get("usage").textContent = usage.full_pdf_cache ? "最近任务：复用本地译文，0 次 API 调用。" :
        `最近任务：${usage.api_requests} 次 API，输入 ${usage.input_tokens} token（命中 ${usage.cached_input_tokens}，未命中 ${usage.uncached_input_tokens}），输出 ${usage.output_tokens} token。`;
    } catch (_) {
      get("usage").textContent = "最近用量记录无法读取；不影响保存设置。";
    }
  }
});
