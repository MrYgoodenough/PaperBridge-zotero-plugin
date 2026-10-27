/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils */
var BundledRuntime = class {
  constructor(rootURI, version) {
    this.rootURI = rootURI;
    this.version = version;
    this.base = PathUtils.join(Zotero.DataDirectory.dir, "paperbridge");
    this.home = PathUtils.join(this.base, "engine");
    this.state = PathUtils.join(this.base, ".runtime");
    this.cache = PathUtils.join(this.base, "cache");
    this.pending = null;
    this.process = null;
    this.connection = null;
  }

  // Each XPI carries the runtime for one platform under runtime/<platform id>/.
  platform() {
    const os = Services.appinfo.OS;
    const abi = Services.appinfo.XPCOMABI;
    if (os === "Darwin" && abi.startsWith("aarch64")) {
      return { id: "macos-arm64", label: "macOS Apple Silicon", python: "python/bin/python3.12",
        machine: "arm64" };
    }
    if (os === "WINNT" && abi.startsWith("x86_64")) {
      return { id: "windows-x64", label: "Windows x64", python: "python/python.exe",
        machine: "AMD64" };
    }
    throw new Error(`此安装包不支持 ${os}（${abi}）。请安装与你的系统对应的版本。`);
  }

  async ensure() {
    if (this.connection) return this.connection;
    this.pending ||= this.launch().catch(error => { this.pending = null; throw error; });
    return this.pending;
  }

  file(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  }

  async unpack() {
    const platform = this.platform();
    const marker = PathUtils.join(this.home, "installed.json");
    const uri = Services.io.newURI(this.rootURI).QueryInterface(Ci.nsIJARURI);
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(uri.JARFile.QueryInterface(Ci.nsIFileURL).file);
    const prefix = `runtime/${platform.id}/`;
    const stream = zip.getInputStream(prefix + "runtime.json");
    const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
    reader.init(stream);
    this.build = JSON.parse(reader.read(reader.available()));
    reader.close();
    if (this.build.platform && this.build.platform !== platform.id) {
      zip.close();
      throw new Error(`安装包为 ${this.build.platform} 构建，与当前系统 ${platform.label} 不匹配。`);
    }
    if (await IOUtils.exists(marker)) {
      const installed = JSON.parse(await IOUtils.readUTF8(marker));
      if (installed.version === this.version && installed.pythonMode === this.build.pythonMode && installed.buildId === this.build.buildId) {
        zip.close();
        return;
      }
    }
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("PaperBridge · 准备内置引擎");
    const line = new progress.ItemProgress("chrome://zotero/skin/attachment-pdf.png", "首次使用：解包内置排版引擎…");
    progress.show();
    const entries = [];
    const names = zip.findEntries(prefix + "*");
    while (names.hasMore()) {
      const name = names.getNext();
      if (!name.endsWith("/")) entries.push(name);
    }
    if (!entries.length) throw new Error("安装包缺少内置引擎，请重新安装完整 XPI。");
    await IOUtils.remove(this.home, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(this.home, { ignoreExisting: true });
    const directories = new Set();
    try {
      for (let i = 0; i < entries.length; i++) {
        const relative = entries[i].slice(prefix.length);
        if (relative.startsWith(".cache/")) continue;
        if (relative.split("/").includes("..")) throw new Error("引擎文件路径无效。");
        const destination = PathUtils.join(this.home, ...relative.split("/"));
        const parent = PathUtils.parent(destination);
        if (!directories.has(parent)) {
          await IOUtils.makeDirectory(parent, { ignoreExisting: true });
          directories.add(parent);
        }
        zip.extract(entries[i], this.file(destination));
        if (i % 100 === 0) {
          line.setProgress(100 * i / entries.length);
          line.setText(`正在准备内置引擎… ${Math.round(100 * i / entries.length)}%`);
        }
      }
      if (this.build.pythonMode === "bundled" && Services.appinfo.OS !== "WINNT") {
        // Windows executables do not carry POSIX permission bits.
        await IOUtils.setPermissions(PathUtils.join(this.home, ...platform.python.split("/")), 0o755);
      }
      await IOUtils.writeUTF8(marker, JSON.stringify({ version: this.version, platform: platform.id, pythonMode:this.build.pythonMode, buildId:this.build.buildId }));
      await this.removeOldEngines();
      line.setProgress(100);
      line.setText("内置引擎已就绪");
    } finally {
      zip.close();
      progress.startCloseTimer(1500);
    }
  }

  async launch() {
    await this.unpack();
    await this.seedCache();
    const runtime = this.state;
    const infoPath = PathUtils.join(runtime, "service.json");
    await IOUtils.makeDirectory(runtime, { ignoreExisting: true });
    await IOUtils.remove(infoPath, { ignoreAbsent: true });
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    this.python = await this.selectPython(Subprocess);
    this.process = await Subprocess.call({
      command: this.python,
      arguments: ["-X", "utf8", "-I", "-S", "-B", PathUtils.join(this.home, "backend", "launcher.py"), "server.py", "0", "--parent-pid", String(Services.appinfo.processID)],
      workdir: this.home,
      environmentAppend: true,
      environment: { PYTHONNOUSERSITE:"1",PYTHONDONTWRITEBYTECODE:"1",PYTHONPATH:null,PYTHONHOME:null,
        PAPERBRIDGE_CACHE_DIR:this.cache,PAPERBRIDGE_STATE_DIR:this.state },
      stderr: "stdout"
    });
    const process = this.process;
    this.output = "";
    (async () => {
      for (;;) {
        const text = await process.stdout.readString();
        if (!text) break;
        this.output = (this.output + text).slice(-3000);
      }
    })().catch(error => Zotero.debug("PaperBridge engine output: " + error));
    process.wait().then(() => {
      this.connection = null;
      this.pending = null;
      if (this.process === process) this.process = null;
    });
    for (let i = 0; i < 100; i++) {
      if (await IOUtils.exists(infoPath)) {
        const info = JSON.parse(await IOUtils.readUTF8(infoPath));
        const token = (await IOUtils.readUTF8(PathUtils.join(runtime, "token"))).trim();
        this.connection = { port: info.port, token };
        return this.connection;
      }
      if (!this.process) throw new Error("内置引擎启动失败：" + this.output);
      await Zotero.Promise.delay(200);
    }
    throw new Error("内置引擎启动超时：" + this.output);
  }

  pythonCandidates(platform) {
    if (Services.appinfo.OS === "WINNT") {
      const candidates = [];
      // Per-user installs live under %LocalAppData%\Programs\Python, machine-wide under %ProgramFiles%.
      for (const [key, parts] of [["LocalAppData", ["Programs", "Python", "Python312"]], ["ProgF", ["Python312"]]]) {
        try {
          const root = Services.dirsvc.get(key, Ci.nsIFile).path;
          candidates.push(PathUtils.join(root, ...parts, "python.exe"));
        } catch (error) {
          Zotero.debug(`PaperBridge: ${key} unavailable (${error})`);
        }
      }
      candidates.push("C:\\Python312\\python.exe", "C:\\Python312-64\\python.exe");
      return candidates;
    }
    return ["/opt/homebrew/bin/python3.12", "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
      "/usr/local/bin/python3.12", "/usr/bin/python3"];
  }

  async selectPython(Subprocess) {
    const platform = this.platform();
    // PathUtils.join rejects a component that contains a separator, so split the
    // packaged executable path instead of appending it in one piece.
    if (this.build.pythonMode === "bundled") return PathUtils.join(this.home, ...platform.python.split("/"));
    const configured = Zotero.Prefs.get("extensions.paperbridge.pythonPath", true) || "";
    const candidates = configured ? [configured] : this.pythonCandidates(platform);
    for (const command of candidates) {
      if (!await IOUtils.exists(command)) continue;
      const probe = await Subprocess.call({command, arguments:["-I", "-S", "-c",
        `import sys,platform,ssl,sqlite3; print('paperbridge-python-ok' if sys.version_info[:2]==(3,12) and platform.machine()=='${platform.machine}' else 'incompatible')`],stderr:"stdout"});
      const result = await probe.stdout.readString();
      const {exitCode} = await probe.wait();
      if (exitCode === 0 && result.trim() === "paperbridge-python-ok") return command;
    }
    throw new Error(`本机版需要 ${platform.label} 版 Python 3.12（含 ssl、sqlite3）。请在设置中填写已有解释器的绝对路径，或安装自带 Python 的 XPI。插件不会自动安装或下载 Python。`);
  }

  async removeOldEngines() {
    const platform = this.platform();
    for (const path of await IOUtils.getChildren(this.base)) {
      const name = PathUtils.filename(path);
      if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
      const marker = PathUtils.join(path, "installed.json");
      if (!await IOUtils.exists(marker)) continue;
      const installed = JSON.parse(await IOUtils.readUTF8(marker));
      if (installed.platform === platform.id && installed.version === name) {
        await IOUtils.remove(path, {recursive:true});
      }
    }
  }

  async seedCache() {
    const platform = this.platform();
    const resources = ["models/doclayout_yolo_docstructbench_imgsz1024.onnx",
      "tiktoken/fb374d419588a4632f3f557e76b4b70aebbca790"];
    const missing = [];
    for (const name of resources) {
      const destination = PathUtils.join(this.cache,"babeldoc",...name.split("/"));
      if (!await IOUtils.exists(destination)) missing.push({name,destination});
    }
    if (!missing.length) return;
    const uri = Services.io.newURI(this.rootURI).QueryInterface(Ci.nsIJARURI);
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    zip.open(uri.JARFile.QueryInterface(Ci.nsIFileURL).file);
    try {
      for (const {name,destination} of missing) {
        await IOUtils.makeDirectory(PathUtils.parent(destination),{ignoreExisting:true});
        zip.extract(`runtime/${platform.id}/.cache/babeldoc/`+name,this.file(destination));
      }
    } finally { zip.close(); }
  }

  async stop() {
    const process = this.process;
    this.connection = null;
    this.pending = null;
    if (process) {
      process.kill();
      await process.wait();
      this.process = null;
    }
  }
};
