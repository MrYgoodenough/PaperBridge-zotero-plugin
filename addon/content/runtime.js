/** Unpack and launch the platform-specific engine inside the Zotero data directory. */
/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils */
var BundledRuntime = class {
  /** Keep engine state separate from Zotero attachments and credentials. */
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

  /** Describe the runtime layout and interpreter architecture for this platform. */
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
    if (os === "Linux" && abi.startsWith("x86_64")) {
      return { id: "linux-x64", label: "Linux amd64", python: "python/bin/python3.12",
        machine: "x86_64" };
    }
    throw new Error(`此安装包不支持 ${os}（${abi}）。请安装与你的系统对应的版本。`);
  }

  /** Reuse one launch and report actionable failures without exposing raw output. */
  async ensure() {
    if (this.connection) return this.connection;
    this.pending ||= this.launch().catch(error => {
      this.pending = null;
      throw this.startupError(error);
    });
    return this.pending;
  }

  /** Classify startup failures locally because the backend may not be available. */
  startupError(error) {
    if (error?.paperbridgeStartup) return error;
    const text = String(error).toLowerCase();
    let code = "startup";
    let message = "本地引擎未能启动。";
    let hint = "请检查 XPI 是否匹配系统；本机版请选择同架构 Python 3.12，自带版可重新安装完整 XPI。";
    if (/filename too long|file name too long|path too long|max_path|winerror 206|路径过长|路径太长|ns_error_file_name_too_long/.test(text)) {
      code = "long_path";
      message = "引擎文件路径过长。";
      hint = "请使用较短的数据目录或文件名后重试；无需修改系统长路径设置。";
    } else if (/permission denied|access denied|sharing violation|being used by another process|winerror (?:5|32|33)\b|文件被占用|ns_error_file_access_denied|ns_error_file_is_locked/.test(text)) {
      code = "file_busy";
      message = "引擎文件被占用或无法访问。";
      hint = "请检查目录写权限及同步/杀毒软件；关闭占用文件的其他程序后重试。";
    } else if (/no space left|disk full|out of memory|cannot allocate memory|memoryerror|not enough memory|not enough storage|winerror (?:8|14|112)\b|onnx|tiktoken|font not found|缺少资源|磁盘空间不足|ns_error_file_no_device_space/.test(text)) {
      code = "resource";
      message = "本地资源不足或排版资源不可用。";
      hint = "请检查磁盘空间和可用内存；缺少模型或字体时重新安装完整 XPI，插件不会自动下载资源。";
    } else if (/glibc_|cannot open shared object|dll load failed|dyld|exec format error/.test(text)) {
      hint = "请安装匹配当前系统与架构的 XPI；Linux 自带版需要 glibc ≥ 2.34，本机版需要同架构 Python 3.12。";
    } else if (/启动超时/.test(text)) {
      message = "本地引擎启动超时。";
      hint = "请检查可用内存和磁盘、系统对 Python 的启动限制后重试；首次解包可能较慢。";
    }
    const result = new Error(`${message}\n${hint}\n不影响阅读原文和已有译文。引擎恢复后可在设置中导出脱敏诊断包。`);
    result.code = code;
    result.hint = hint;
    result.paperbridgeStartup = true;
    return result;
  }

  /** Wrap a platform path for native file operations. */
  file(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
  }

  /** Extract only the matching runtime and refresh its installation marker. */
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

  /** Start the isolated engine and wait for its loopback service to become ready. */
  async launch() {
    await this.unpack();
    await this.seedCache();
    const runtime = this.state;
    const infoPath = PathUtils.join(runtime, "service.json");
    await IOUtils.makeDirectory(runtime, { ignoreExisting: true });
    await IOUtils.remove(infoPath, { ignoreAbsent: true });
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    this.python = await this.selectPython(Subprocess);
    const environment = { PYTHONNOUSERSITE:"1",PYTHONDONTWRITEBYTECODE:"1",PYTHONPATH:null,PYTHONHOME:null,
      PAPERBRIDGE_CACHE_DIR:this.cache,PAPERBRIDGE_STATE_DIR:this.state };
    if (Services.appinfo.OS === "Linux") {
      // ROS shells can prepend incompatible native libraries; change only the child process.
      environment.LD_LIBRARY_PATH = null;
      environment.LD_PRELOAD = null;
    }
    this.process = await Subprocess.call({
      command: this.python,
      arguments: ["-X", "utf8", "-I", "-S", "-B", PathUtils.join(this.home, "backend", "launcher.py"), "server.py", "0", "--parent-pid", String(Services.appinfo.processID)],
      workdir: this.home,
      environmentAppend: true,
      environment,
      stderr: "stdout"
    });
    const process = this.process;
    this.output = "";
    // Keep a bounded in-memory tail for classification, never for exports.
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
      if (!this.process) throw this.startupError("内置引擎启动失败：" + this.output);
      await Zotero.Promise.delay(200);
    }
    throw this.startupError("内置引擎启动超时：" + this.output);
  }

  /** Return common absolute interpreter paths without searching a ROS-modified PATH. */
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
    if (Services.appinfo.OS === "Linux") {
      return ["/usr/bin/python3.12", "/usr/local/bin/python3.12", "/usr/bin/python3",
        "/usr/local/bin/python3"];
    }
    return ["/opt/homebrew/bin/python3.12", "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
      "/usr/local/bin/python3.12", "/usr/bin/python3"];
  }

  /** Select the bundled interpreter or verify the configured local Python 3.12. */
  async selectPython(Subprocess) {
    const platform = this.platform();
    // PathUtils.join rejects a component that contains a separator, so split the
    // packaged executable path instead of appending it in one piece.
    if (this.build.pythonMode === "bundled") return PathUtils.join(this.home, ...platform.python.split("/"));
    const configured = Zotero.Prefs.get("extensions.paperbridge.pythonPath", true) || "";
    const candidates = configured ? [configured] : this.pythonCandidates(platform);
    // Interpreter probes must use the same clean native-library environment as the engine.
    const environment = Services.appinfo.OS === "Linux" ? { LD_LIBRARY_PATH:null,LD_PRELOAD:null } : {};
    for (const command of candidates) {
      if (!await IOUtils.exists(command)) continue;
      const probe = await Subprocess.call({command, arguments:["-I", "-S", "-c",
        `import sys,platform,ssl,sqlite3; print('paperbridge-python-ok' if sys.version_info[:2]==(3,12) and platform.machine()=='${platform.machine}' else 'incompatible')`],
        environmentAppend:true,environment,stderr:"stdout"});
      const result = await probe.stdout.readString();
      const {exitCode} = await probe.wait();
      if (exitCode === 0 && result.trim() === "paperbridge-python-ok") return command;
    }
    throw new Error(`本机版需要 ${platform.label} 版 Python 3.12（含 ssl、sqlite3）。请在设置中填写已有解释器的绝对路径，或安装自带 Python 的 XPI。插件不会自动安装或下载 Python。`);
  }

  /** Remove only recognizable engine versions, not attachments or unknown folders. */
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

  /** Extract missing bundled models without downloading or replacing existing files. */
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

  /** Stop only this runtime's child process and reset its connection. */
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
