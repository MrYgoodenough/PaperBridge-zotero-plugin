/** Edit isolated provider drafts with optional checks and local diagnostics. */

/** Initialize profile drafts without storing credentials in preferences. */
window.addEventListener("load", function initializeSettings() {
  const bridge = window.arguments[0].bridge;
  // Separate controls retain unsaved drafts, including keys, when switching profiles.
  const profiles = {
    deepseek: { section: "deepseek-settings", advanced: "deepseek-advanced", key: "key", baseURL: "baseURL", model: "model" },
    compatible: { section: "compatible-settings", advanced: "compatible-advanced", key: "compatibleKey", baseURL: "compatibleBaseURL", model: "compatibleModel" }
  };
  // These preferences apply to both profiles.
  const globalFields = ["language", "pages", "pythonPath"];
  // Zotero integer preferences use signed 32-bit values.
  const maxPrefInteger = 2147483647;
  let saving = false;
  // Both explicit checks share one UI lock and never save drafts.
  let checking = false;
  // Export is independent of profile drafts and never submits their credentials.
  let exporting = false;
  // Keep the backend-returned path in this window only, not in preferences.
  let diagnosticPath = "";

  /** Find a settings control. */
  function get(id) { return document.getElementById(id); }

  /** Show the selected draft without expanding optional settings. */
  function showProfile() {
    const selected = get("profile").value;
    for (const [profile, fields] of Object.entries(profiles)) {
      get(fields.section).hidden = profile !== selected;
      get(fields.advanced).hidden = profile !== selected;
    }
  }

  /** Keep actionable notices visible outside the collapsed support section. */
  function setStatus(message, tone = "") {
    get("status").textContent = message;
    get("status").className = tone;
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
    setStatus("设置已保存（当前服务及全局设置）。已入队任务不受影响。", "success");
  }

  /** Save the current profile without checking an engine or service. */
  async function handleSave(event) {
    if (saving || checking) return;
    saving = true;
    // Lock editing across asynchronous key writes to prevent profile/key races.
    const controls = document.querySelectorAll("input, select, #save, #test, #service-check");
    for (const control of controls) control.disabled = true;
    try {
      await save();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      for (const control of controls) control.disabled = false;
      saving = false;
    }
  }

  /** Freeze a validated service draft without saving preferences or credentials. */
  function serviceDraft() {
    const profile = get("profile").value;
    if (!Object.hasOwn(profiles, profile)) throw new Error("请选择翻译服务配置。");
    const fields = profiles[profile];
    const model = get(fields.model).value.trim();
    const key = get(fields.key).value.trim();
    if (!model || /[\s\u0000-\u001f\u007f]/.test(model)) throw new Error("请填写有效模型名称。");
    if (!key || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error("请填写当前配置的有效 API Key；不会借用另一套密钥。");
    return { profile, base_url: endpoint(get(fields.baseURL).value.trim()), model, api_key: key,
      lang_out: get("language").value, pages: "", capabilities: { max_tokens: 512,
        json_mode: profile === "deepseek" || get("compatibleJSON").checked,
        thinking_disabled: profile === "deepseek" } };
  }

  /** Check local readiness or one confirmed public provider sample, never saving drafts. */
  async function check(event) {
    if (saving || checking) return;
    const provider = event.currentTarget.id === "service-check";
    let draft;
    try {
      if (provider) {
        draft = serviceDraft();
        if (!bridge.confirm("检查服务将使用当前配置草稿发送一条公开短样例，输出上限 512 tokens，可能计费。不会保存设置、翻译论文、自动重试或回退其他服务。继续？")) return;
      }
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    checking = true;
    const controls = document.querySelectorAll("input, select, #save, #test, #service-check");
    for (const control of controls) control.disabled = true;
    setStatus(provider ? "正在检查服务（一次短请求）…" : "正在检查已保存配置的本地引擎…");
    // Hide stale readiness details during a fresh local check, including failures.
    if (!provider) get("engine-details").hidden = true;
    try {
      if (provider) {
        const result = await bridge.request("/providers/check", "POST", { ...draft, confirmed: true });
        setStatus(result.ok
          ? "服务已响应且翻译 JSON 格式可用。仅一次公开短样例；未保存草稿，未验证真实论文质量或账单。"
          : [result.error || "服务检查未通过。", result.hint || "", "未保存草稿；请求可能已计费，不会自动重试。"].filter(Boolean).join("\n"),
          result.ok ? "success" : "error");
      } else {
        const health = await bridge.request("/health");
        get("engine-info").textContent = `引擎：${health.engine}\n后端版本：${health.version}\nPython：${health.python}`;
        get("engine-details").hidden = false;
        const warning = health.warning_count > 0;
        setStatus("排版引擎已就绪。未保存草稿，未调用服务商。" +
          (warning ? `\n有 ${health.warning_count} 条记录警告；已有文件保留，可导出脱敏诊断包。` : ""),
          warning ? "warning" : "success");
      }
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      for (const control of controls) control.disabled = false;
      checking = false;
    }
  }

  /** Close without saving any remaining drafts. */
  function close() { window.close(); }

  /** Open the engine and cache directory. */
  async function openData() {
    try { await bridge.openDataDirectory(); } catch (error) { setStatus(error.message, "error"); }
  }

  /** Export safe counters and lifecycle events without saving profile drafts. */
  async function exportDiagnostics() {
    if (exporting) return;
    exporting = true;
    get("diagnostics-export").disabled = true;
    get("diagnostics-status").textContent = "正在生成脱敏诊断 ZIP…";
    try {
      const result = await bridge.exportDiagnostics();
      if (typeof result.path !== "string" || !result.path) throw new Error("诊断接口未返回文件路径，请更新插件后重试。");
      diagnosticPath = result.path;
      get("diagnostics-path").textContent = diagnosticPath;
      get("diagnostics-open").hidden = false;
      get("diagnostics-status").textContent = result.source === "addon_only"
        ? "本地插件侧诊断 ZIP 已生成（引擎不可用，后端版本/详情未确认）。不含秘密或正文，未上传。"
        : "诊断 ZIP 已生成，含固定阶段/错误码摘要。不含秘密或正文，未上传。";
    } catch (error) {
      get("diagnostics-status").textContent = `诊断包未生成：${error.message}\n原文和已有译文仍可阅读；请检查本地目录写权限后重试。`;
    } finally {
      get("diagnostics-export").disabled = false;
      exporting = false;
    }
  }

  /** Reveal the generated ZIP, or open its directory when reveal is unavailable. */
  async function openDiagnostics() {
    if (!diagnosticPath) return;
    try {
      const file = bridge.runtime.file(diagnosticPath);
      try { file.reveal(); } catch (_) { file.parent.launch(); }
    } catch (_) {
      get("diagnostics-status").textContent = "无法自动打开文件位置，请复制下方路径在文件管理器中打开。诊断 ZIP 已保留。";
    }
  }

  get("close").addEventListener("click", close);
  get("data").addEventListener("click", openData);
  get("diagnostics-export").addEventListener("click", exportDiagnostics);
  get("diagnostics-open").addEventListener("click", openDiagnostics);
  // Do not fall back to legacy unscoped key access, which could mix credentials.
  if (typeof bridge.configuration !== "function") {
    setStatus("此设置界面需要支持双配置的 PaperBridge 主程序，请更新插件后重开设置。", "error");
    for (const control of document.querySelectorAll("input, select, #save, #test, #service-check")) control.disabled = true;
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
  const terms = bridge.runtime.terms;
  get("runtime-terms").hidden = !terms.required();
  /** Show consent state without starting the engine or saving provider drafts. */
  function showTermsState() {
    get("runtime-terms-status").textContent = terms.accepted()
      ? "当前 Microsoft 运行库条款已同意；相同条款不重复确认。"
      : "首次启用 Windows 排版引擎需同意 Microsoft DLL 条款；无需额外安装软件。不接受不影响已有 PDF 阅读。";
  }
  showTermsState();
  get("runtime-terms-view").addEventListener("click", async function viewRuntimeTerms() {
    try { await terms.show(window); showTermsState(); }
    catch (error) { get("runtime-terms-status").textContent = error.message; }
  });
  showProfile();
  get("profile").addEventListener("change", showProfile);
  get("save").addEventListener("click", handleSave);
  get("test").addEventListener("click", check);
  get("service-check").addEventListener("click", check);
  get("locations").textContent = `译文：${bridge.storageRoot}/<附件 key>/translated.pdf\n缓存与引擎：${bridge.runtime.base}`;
  if (bridge.library.lastError) setStatus("上次缓存清理未完成：" + bridge.library.lastError, "warning");
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
