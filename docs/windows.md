<!-- Windows installation, runtime portability, and native verification entry points. -->
# Windows 适配说明

原工程只面向 macOS Apple Silicon：插件拒绝在其它平台解包运行时，内置解释器路径、
依赖目录、字体来源和构建脚本也都是 macOS 专用的。本目录的代码已改为按平台分发，
共享源码按平台构建安装包；独立发布的 macOS 0.4.2 源码尚未合入，不应使用本分支覆盖该包。

Windows x64 安装 `paperbridge-0.3.3-windows-x64.xpi`。一般用户使用自带 Python 版；
本地 Python 版需在高级设置指定 x64 CPython 3.12。右下角「段落高亮」默认关闭，
只映射可追溯的翻译请求片段，不修改 PDF 或批注。

## 支持范围

| 平台 | 版本标识 | 内置解释器 | 依赖目录 |
|---|---|---|---|
| macOS Apple Silicon | `macos-arm64` | `python/bin/python3.12` | `python/lib/python3.12/site-packages` |
| Windows x64 | `windows-x64` | `python/python.exe` | `python/Lib/site-packages` |

XPI 内按 `runtime/<平台>/` 存放运行时；插件启动时按 `Services.appinfo.OS` 与
`XPCOMABI` 选择，平台不符会给出明确提示而不是解包失败。

## 改动清单

| 文件 | 改动 |
|---|---|
| `addon/content/runtime.js` | 新增 `platform()` 平台描述；运行时前缀、解释器路径、标记文件均按平台生成；`PathUtils.join` 不再一次追加含分隔符的路径（Windows 上会抛 `NS_ERROR_FILE_UNRECOGNIZED_PATH`）；Windows 跳过 `setPermissions`；本机 Python 模式新增 Windows 候选路径与 `AMD64` 架构校验；引擎参数加 `-X utf8` |
| `addon/content/settings.xhtml` | 本机 Python 提示改为与架构无关，补充 Windows 路径示例 |
| `backend/launcher.py` | 依赖目录按平台选择；开发环境（无内置解释器）回退到当前解释器/虚拟环境的 site-packages；Windows 同时设置 `TMP`/`TEMP`；强制 stdio 为 UTF-8 |
| `backend/server.py` | Windows 上 `os.kill(pid, 0)` 会**终止**目标进程（即 Zotero），改为 `OpenProcess`+`GetExitCodeProcess` 判断宿主存活；引擎子进程用 `-X utf8` 启动并按 UTF-8 解码 stdout/stderr，避免中文进度在 cp936 下乱码或解码失败 |
| `backend/engine.py` | 读取 BabelDOC 源码时显式 `encoding="utf-8"`（Windows 默认 cp936 会解码失败） |
| `backend/fonts.py` | 字体来源按平台选择：macOS 用 `Songti.ttc` 的 `STSongti-SC-Regular/Bold`；Windows 用宋体 `SimSun`，粗体优先取 `NotoSerifSC-VF`（可变字体实例化到 700）或 `Microsoft YaHei Bold`；文件名仍保留 `SongtiSerif-*.ttf`，因为引擎按文件名里的 `serif` 匹配衬线字体，并按字体头部的粗体位匹配粗体 |
| `scripts/stage_runtime.py` | 按平台定位 CPython、`DLLs`、`Lib` 与 site-packages；Windows 保留官方 `opencv-python-headless`（精简版 OpenCV 只提供 macOS 构建脚本） |
| `scripts/build.py` | 输出名、XPI 内前缀、本机模式的过滤规则按平台生成 |
| `scripts/sanitize_runtime.py` | 仅在 macOS 上对 Mach-O 重新 `codesign` |
| `scripts/create_fixture.py` | 使用 `backend/fonts.py` 准备好的字体，不再写死 `/System/Library/Fonts/...` |
| `scripts/prepare_packaged_test.py` | 测试用 XPI 名称与提示按平台生成 |
| `scripts/setup.ps1`、`scripts/serve.ps1` | Windows 下等价于 `setup.sh`、`serve.sh` |

各平台使用同一套任务与附件归属实现。持久化任务、质量证据与
进度接口见 [任务与成果架构](tasks-and-results.md)；历史格式继续读取，不要求迁移译文附件。

## 在 Windows 上开发与构建

```powershell
# 1. 依赖与资源（需要 uv；没有时会用 pip 安装到 .tools）
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# 2. 打包运行时（.cache/package/windows-x64，约 450 MB）
.\.venv\Scripts\python.exe scripts\stage_runtime.py

# 3. 生成安装包（dist\paperbridge-0.3.3-windows-x64.xpi）
.\.venv\Scripts\python.exe scripts\build.py            # 自带 Python
.\.venv\Scripts\python.exe scripts\build.py --python local   # 仅依赖，需自备 Python 3.12
```

`scripts/setup.ps1` 会调用 `scripts/warmup.py` 下载版面模型（约 72 MB）与 tokenizer，
并生成 Windows 字体缓存；这两类资源是打包与离线运行的前提，插件运行时不下载。

本机 Python 模式在 Windows 上需要与系统架构一致的 CPython 3.12（含 `ssl`、`sqlite3`）。
解释器可从设置页填写，或由下列位置自动探测：
`%LocalAppData%\Programs\Python\Python312\python.exe`、`%ProgramFiles%\Python312\python.exe`、
`C:\Python312\python.exe`。

## 验证环境与结果

Zotero 10 兼容范围由 `addon/manifest.json` 的 `strict_max_version: 10.*` 声明。
已有 Windows XPI 若仍声明 `9.*`，需要从当前源码重新运行 `scripts/build.py` 并安装新包；
仅更新源码不会改变已安装的 XPI。旧版占位更新地址需先从文件安装新版。
0.3.3 构建包使用 Windows/Python 模式独立更新地址，草稿清单在 `dist/updates/`；
对应安装包发布后再发布清单，构建或同步源码不会自动启用更新。

新任务尝试目录不再重复嵌套指纹与 UUID，避免常规数据路径触发 Windows MAX_PATH。
旧目录仍可读取；Gecko 解包仍受很深的数据路径影响，不承诺所有极端长路径可用，
也不要求修改系统注册表。测试用较短的独立目录，不覆盖日常工程或文献库。
Gecko 文件接口使用 `PathUtils.join(root, "folder", "file")`，不要拼接混合分隔符路径。

真实论文和冷启动检查使用 `scripts/prepare_nonmac_test.py --suite reading` 与
`tests/reading_packaged.js`；原生更新使用 `--suite update` 与 `tests/update_packaged.js`。
`--phase reopen` 保留原 profile、数据、插件和缓存，仅更新外部测试参数。
OpenSSH 的 Session 0 不适合原生 UI 验收，应在已登录交互会话运行 Zotero。

以下为历史 0.3.1 的验证范围，不替代当前安装包的验收。

2026-11-07 使用独立 Zotero 10.0.6 程序副本、profile 和文献库验证重建的自带 Python 包：
插件菜单、设置保存、内置引擎解包与启动、选页翻译、译文附件、双向同步、独立阅读及关闭清理均通过。
翻译复用 17 条段落缓存，API 请求为 0；第 1 页含 798 个中文字符并嵌入宋体，
其余 14 页文字及所有页尺寸与原文一致。此轮未验证新的 DeepSeek API 请求。
本机正常 Zotero 启动时自动应用已有的 10.0.8 更新，插件管理器已显示 Enabled，阅读器按钮正常。
10.0.8 本轮仅验证加载；完整功能验证针对 10.0.6。摘要见 `windows-compatibility-0.3.1.json`。

此前 Zotero 9 的验证结果：

- Zotero 9.0.6（Windows 安装版），Windows x64，Python 3.12.13
- 独立 profile 与独立数据目录，安装最终 `dist\paperbridge-0.3.1-windows-x64.xpi`（190 MiB）后实测
- 另有离线引擎测试：注入固定译文的模拟 LLM，用真实论文 PDF（15 页，双栏、公式、图表、参考文献）
  跑完整排版流程，逐页比对页面尺寸与中文字符数

已验证：

1. 插件在 Zotero 启动时加载，工具菜单与条目右键菜单出现，PDF 阅读器工具栏出现「译 / 分屏」。
2. 设置页可打开、保存 DeepSeek Key（写入登录管理器）并保存页码范围。
3. 首次请求 `/health` 时解包内置引擎（6 530 个文件、约 347 MB，7–9 秒）并写出
   `installed.json`（`platform: windows-x64`、`pythonMode: bundled`）；之后启动只需 0.5 秒。
4. 内置 `python.exe` 以 `-X utf8 -I -S -B` 启动 `backend/launcher.py server.py`，
   `/health` 返回引擎根目录与解释器路径；设置页在引擎启动后隐藏"本机 Python"分支。
5. 版面模型与 tokenizer 由 XPI 播种到数据目录的 `paperbridge/cache/babeldoc/`（约 75 MB）。
6. 选页翻译（第 1 页）在 Zotero 内完成：约 20 秒，17 个段落命中段落缓存、0 次 API；
   译文保存为 Zotero 译文附件（1.78 MB），`translations.json` 建立归属记录。
7. 分屏、左右联动滚动（左 1↔右 1，翻到第 3 页右栏跟随）、关闭分屏均正常。
8. 直接调用 DeepSeek 接口（故意使用无效 Key）返回 `401 Authentication Fails`，
   说明 HTTPS 请求、`openai` 客户端与错误回传在 Windows 上链路正常。
9. `python -m pytest tests`：35 通过、1 跳过（缺少可选的参考文献 PDF 样例）。

## 体积构成

XPI 189.6 MiB 压缩、422.3 MiB 解包，其中 99.9% 是随包分发的 Python 运行时，插件自身代码
（`addon/` 与 `backend/`）不到 200 KB：

| 内容 | 压缩后 | 解包后 | 说明 |
|---|---:|---:|---|
| 版面识别模型 `doclayout_yolo` ONNX | 61.8 MB | 71.8 MB | 单文件，最大项 |
| OpenCV（`cv2`） | 29.3 MB | 82.5 MB | 仅 `cv2.pyd`；wheel 自带的 29 MB ffmpeg 视频模块已剔除 |
| 其余 Python 依赖 | 23.1 MB | 74.3 MB | fontTools、pydantic、httpx、hyperscan 等 |
| PyMuPDF | 17.0 MB | 42.3 MB | PDF 解析、矢量与字体处理 |
| ONNX Runtime | 14.1 MB | 41.6 MB | 跑版面模型 |
| NumPy | 10.1 MB | 32.6 MB | |
| Pillow / lxml / onnx / openai / rapidfuzz / cryptography | 15.3 MB | 43.1 MB | |
| CPython 3.12（解释器 + 标准库） | 11.2 MB | 33.6 MB | 24.1 MB 解释器 + 9.5 MB 标准库 |
| BabelDOC（排版引擎本体） | 5.7 MB | 8.7 MB | |
| tokenizer 词表 | 1.6 MB | 3.4 MB | |

首次翻译后数据目录里的实际占用：引擎 347 MB + `cache/babeldoc` 75 MB（模型与词表）
+ `cache/fonts` 约 18 MB（从系统字体生成，不随包分发）+ 任务与译文；加上 Zotero
profile 里的 XPI 本身，总计约 630 MB。

## 已知限制

- 只为 Windows x64 构建；Windows ARM64 需要另行打包对应架构的 Python 与依赖。
- 首次安装需要解包约 347 MB 运行时；在机械盘或严格防病毒扫描下会明显变慢。
- 安装路径受 Windows 260 字符路径长度限制。默认数据目录下最长路径约 165 字符，
  仍有余量；若把数据目录放得极深，建议开启系统"长路径"支持。
- 引擎内置的 opencv 为官方 `opencv-python-headless`（`cv2.pyd` 约 82 MB），
  macOS 版用的是自编译精简模块，两者安装包体积已接近（190 MiB 对 181 MiB）；
  若要更小，可只发布 `--python local`（再少约 11 MB）或自编译精简 OpenCV（再少约 30 MB）。
- `--python local`（本机 Python 版）已按平台适配并可通过 `build.py --python local`
  构建，但本机未安装独立 CPython 3.12，未做完整集成验证；自带 Python 版是验证目标。
- 若 API Key 无效或网络不可达，BabelDOC 会保留原文段落继续排版，任务仍显示“完成”
  （`usage.api_requests` 为 0、译文为原文）。这是上游引擎的容错行为，两平台一致；
  排查时先看设置页的"最近任务"用量与 `paperbridge/.runtime/jobs/<指纹>/usage.json`。
- 构建脚本只打包 `.cache/babeldoc/{models,tiktoken}`，并过滤 `__pycache__`/`.pyc`
  与 OpenCV 的 ffmpeg 视频模块；在暂存目录里直接运行过引擎后，字体缓存与段落缓存也
  不会进包（系统字体不可再分发）。
