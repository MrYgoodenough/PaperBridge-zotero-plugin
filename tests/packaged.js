(async () => {
  const root = PAPERBRIDGE_TEST_ROOT;
  const reportPath = root + "/.runtime/packaged-test.json";
  const marker = root + "/.runtime/packaged-key-saved.json";
  const stage = text => IOUtils.writeUTF8(root + "/.runtime/packaged-stage.json", JSON.stringify({stage:text}));
  try {
    const bridge = Zotero.PaperBridge;
    await bridge.ready;
    const main = Zotero.getMainWindow();
    await Zotero.Promise.delay(2000);
    await stage("打开设置并验证密钥保存");
    const settings = main.openDialog("chrome://paperbridge/content/settings.xhtml", "paperbridge-settings",
      "chrome,centerscreen,resizable", {bridge});
    await Zotero.Promise.delay(1000);
    const doc = settings.document;
    const options = JSON.parse(await IOUtils.readUTF8(root + "/.runtime/packaged-options.json"));
    doc.getElementById("pythonPath").value = options.pythonPath;
    const fixture = "paperbridge-ui-persistence-test";
    const report = { version:bridge.runtime.version, model:bridge.pref("model"), settingsOpened:!!doc.getElementById("key") };
    report.settingsRootBackground=settings.getComputedStyle(doc.documentElement).backgroundColor;
    report.settingsBodyBackground=settings.getComputedStyle(doc.body || doc.querySelector("body")).backgroundColor;
    if (!await IOUtils.exists(marker)) {
      doc.getElementById("key").value = fixture;
      doc.getElementById("save").click();
      for(let i=0;i<50 && bridge.getKey()!==fixture;i++) await Zotero.Promise.delay(100);
      if(bridge.getKey()!==fixture) throw new Error("界面密钥保存失败："+doc.getElementById("status").textContent);
      report.keySaved = true;
      settings.close();
      await stage("解包并启动 XPI 内置引擎");
      const health = await bridge.request("/health");
      report.engine = health;
      report.packagedPythonStarted = health.root === bridge.runtime.home;
      await IOUtils.writeUTF8(marker,JSON.stringify({keySaved:true}));
      report.phase = "restart-required";
      await IOUtils.writeUTF8(reportPath,JSON.stringify(report,null,2));
      return;
    }
    // The .env is a test input only; production code does not read it.
    const env = await IOUtils.readUTF8(root + "/.env");
    const line = env.split(/\r?\n/).find(line => /^(?:DEEPSEEK_API_KEY|key)\s*=/.test(line));
    if (!line) throw new Error("测试 .env 中未找到 API Key");
    const key = line.slice(line.indexOf("=")+1).trim().replace(/^["']|["']$/g, "");
    report.keyPersistedAfterRestart = bridge.getKey()===fixture || bridge.getKey()===key;
    if (!report.keyPersistedAfterRestart) throw new Error("重启后未读取到界面保存的密钥");
    doc.getElementById("key").value = key;
    doc.getElementById("model").value = "deepseek-flash";
    doc.getElementById("pages").value = "2-4";
    doc.getElementById("status").textContent = "";
    doc.getElementById("save").click();
    for(let i=0;i<60 && !doc.getElementById("status").textContent.includes("设置已保存");i++) await Zotero.Promise.delay(100);
    if (bridge.getKey()!==key || bridge.pref("pages")!=="2-4" || !doc.getElementById("status").textContent.includes("设置已保存")) {
      throw new Error("设置未成功保存或页码范围不正确："+doc.getElementById("status").textContent);
    }
    report.settingsSavedThroughUI=true;
    report.locationsShown=doc.getElementById("locations").textContent.includes(bridge.storageRoot);
    settings.close();
    await stage("使用 deepseek-flash 翻译第 2–4 页");
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title","π₀ · deepseek-flash · 2–4 页实测");
    await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({file:root+"/.cache/references/pi0-v3.pdf",parentItemID:parent.id});
    const reader = await Zotero.Reader.open(source.id);
    await reader._initPromise;
    await bridge.translate(reader);
    const translated = await bridge.existing(source);
    if(!translated) throw new Error("译文附件未保存");
    report.coldUsage=JSON.parse(bridge.pref("lastUsage"));
    report.translatedAttachment = await translated.getFilePathAsync();
    report.sourceAttachment = await source.getFilePathAsync();
    report.engineRoot = bridge.runtime.home;
    const health = await bridge.request("/health");
    report.python = health.python;
    report.pythonMode = bridge.runtime.build.pythonMode;
    report.remainingVersionedEngines = (await IOUtils.getChildren(bridge.runtime.base)).filter(path => /\/\d+\.\d+\.\d+$/.test(path));
    report.cacheRoot = bridge.runtime.cache;
    report.stateRoot = bridge.runtime.state;
    report.storedKeyReadBack = bridge.getKey()===key;
    report.selectedPages = bridge.pref("pages");
    report.model = bridge.pref("model");
    const state = bridge.splits.get(reader.tabID);
    await Zotero.Promise.delay(1500);
    reader.navigate({pageIndex:2});
    await Zotero.Promise.delay(1000);
    report.forwardSync = state.apps[1].pdfViewer.currentPageNumber === 3;
    state.active=1;
    state.right.navigate(Components.utils.cloneInto({pageIndex:3},state.browser.contentWindow));
    await Zotero.Promise.delay(1000);
    report.reverseSync = state.apps[0].pdfViewer.currentPageNumber === 4;
    state.sync=false;
    state.right.navigate(Components.utils.cloneInto({pageIndex:1},state.browser.contentWindow));
    await Zotero.Promise.delay(1000);
    report.independent = state.apps[0].pdfViewer.currentPageNumber === 4 && state.apps[1].pdfViewer.currentPageNumber === 2;
    state.sync=true;state.active=0;
    reader.navigate({pageIndex:1});
    await Zotero.Promise.delay(1000);
    bridge.closeSplit(reader.tabID);
    report.cleanup = !bridge.splits.has(reader.tabID);
    await bridge.split(source,translated);
    await bridge.translate(reader);
    report.reopenUsage=JSON.parse(bridge.pref("lastUsage"));
    report.reopenZeroAPI=report.reopenUsage.api_requests===0 && report.reopenUsage.full_pdf_cache;
    bridge.setPref("pages", "");
    report.ok=report.forwardSync&&report.reverseSync&&report.independent&&report.cleanup&&report.storedKeyReadBack;
    report.phase="complete";
    await IOUtils.writeUTF8(reportPath,JSON.stringify(report,null,2));
    await stage("完整 XPI 三页实测完成");
    if (await IOUtils.exists(root+"/.runtime/run-lifecycle")) {
      await stage("验证文献删除、PDF 保留与共享缓存清理");
      const scope={Zotero,Services,IOUtils,PathUtils,Cc,Ci,Components,ChromeUtils,PAPERBRIDGE_TEST_ROOT:root};
      Services.scriptloader.loadSubScript(PathUtils.toFileURI(root+"/tests/lifecycle.js"),scope);
      report.lifecycle=await scope.runLifecycleTests(bridge);
      await IOUtils.writeUTF8(reportPath,JSON.stringify(report,null,2));
      await stage("三页阅读与文献生命周期验证完成");
    }
    if (await IOUtils.exists(root+"/.runtime/show-settings")) bridge.settings();
  } catch(error) {
    await IOUtils.writeUTF8(reportPath,JSON.stringify({ok:false,error:String(error),stack:error.stack},null,2));
  }
})();
