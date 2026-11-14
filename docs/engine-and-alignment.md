<!-- Developer entry points and boundaries for probes, production traces, and reader alignment. -->
# 引擎接口、provider 验证与可信定位

生产依赖仍固定为 **BabelDOC 0.6.4 / PyMuPDF 1.26.7**（`pyproject.toml`）。接口探针、直接 provider 验证和生产片段映射是独立入口，不代表引擎升级或真实模型语义质量验收。任务、成果与恢复架构见 [tasks-and-results.md](tasks-and-results.md)。

以下命令从项目根目录执行，`python` 必须指向项目自己的环境：Linux/macOS 使用 `.venv/bin/python`，Windows 使用 `.venv\Scripts\python.exe`。不要为研究探针修改生产环境的依赖版本。

## 引擎接口研究

`scripts/probe_engine.py` 在所选研究环境中运行真实解析、排版、字体处理和 PDF 写出，仅模拟 `DeepSeekTranslator.request_completion()` 的 response。默认输出到 `.runtime/engine-interface-probe/<版本>-<随机标识>/`，包含 `report.json`、各模式日志和 PDF。

```text
python -I -B scripts/probe_engine.py
python -I -B scripts/probe_engine.py --official-fonts
```

- 0.6.4 走 `pinned_capture`：临时观察同一翻译单元在翻译前及最终写出后的对象，生成研究用的 `captured-candidates.json`，经 `backend/alignment.py` 验证后写入 `pinned_capture/alignment.json`。生产采集使用下述自身适配器钩子，不依赖此探针。
- 0.7.1 走发布版 public pipeline 和 `existing_protection_adapter` 两个独立模式。**正式 0.7.1 wheel 的 `stage_capture_enabled()` 为 `False`**，不能把接口名称或调试能力当作可用的生产阶段快照。
- 迁移障碍包括：旧 `ILTranslatorLLMOnly` 已移除，而 `backend/batching.py` / `backend/engine.py` 仍依赖它；`backend/preserve.py` 的保护适配依赖可修改的 Python 页对象，与新版 `PageProjection` 不兼容；Rust 字体映射的系统字体 hash/profile 与当前 `backend/fonts.py` 覆写不兼容。探针中的字体 family / `sha3_256` 适配仅用于研究，不能视为生产迁移完成。
- `--official-fonts` 使用官方思源宋体字面区分字体 profile 与解析问题；public pipeline 的成功仍只使用**模拟 response**，不表示保护适配可用、稳定快照可用或升级完成。

管线执行阶段会阻断并记录联网尝试，模型响应始终模拟；但 `--official-fonts` 的资源准备位于禁网保护之前，缓存不足时可能联网获取字体。禁网任务不要直接执行该选项，也不要把资源准备描述成全程离线。

## Provider 验证 CLI

`scripts/verify_providers.py` 复用现有 Chat Completions 请求契约，只验证直接 API 接受能力和单段 JSON 响应，不运行 PDF/mapping 管线。

```text
python scripts/verify_providers.py
python scripts/verify_providers.py --run --max-tokens 128
```

- 默认是 inspect，不构造 provider client、不发请求；**仍会读取具名环境输入及存在的 `.runtime/deepseek.key`**。`.env` 只在显式传入 `--env-file` 时读取，不自动发现；不读取 Zotero credential DB。禁止读取密钥的任务也不要运行默认 inspect。
- `--run` 才允许实际请求，可能付费。每个 ready profile 最多调用一次；没有初始化失败时各 ready profile 各一次，**no retry / no fallback**，SDK 重试为 0，网络等待上限 30 秒。`--max-tokens` 接受 1–512，默认和硬上限均为 **512**；它限制输出 token，不代表总用量或账单上限。
- DeepSeek 使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`；未提供 endpoint/model 时沿用现有 DeepSeek 默认值。旧 `API_KEY` / `key` 和 `.runtime/deepseek.key` 只归 DeepSeek。
- 兼容服务必须显式提供**独立的 endpoint、model、key**：`COMPATIBLE_BASE_URL`、`COMPATIBLE_MODEL`、`COMPATIBLE_API_KEY`（对应 `OPENAI_*` 别名也接受）。不得继承 DeepSeek 输入、猜测模型或自动发现服务。非秘密 endpoint/model 可用 `--compatible-base-url` / `--compatible-model` 覆写；不提供密钥命令行参数。
- 输入优先级为非秘密 CLI 覆写、环境变量、显式 env 文件；已知明文 key 仅是 DeepSeek 的最后来源。`*_JSON_MODE` / `*_THINKING_DISABLED` 或相应布尔 CLI 参数控制请求能力，字段不被服务接受时保留原错误，不重试删字段、不切换服务。

报告默认写入 `.runtime/provider-verification-<时间标识>.json`；`--report` 只接受项目 `.runtime/` 或 `agent/codex/` 下的新路径，不覆盖旧报告。凭据及错误回显会脱敏，保留原服务商错误类型、状态和 body；收到响应、JSON 合法、文本改变分别记录，均不等于语义质量通过。用量仅采用响应实际报告值，缺失或响应丢失保持未知；没有价格查询或账单核验。

## Alignment sidecar 与证据边界

`backend/alignment.py` 不启动引擎、不调用 provider、不修改 PDF。Schema 1 的 `alignment.json` 契约为：

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 整数 `1` |
| `coordinate_space` | `pdf-user-space`，未旋转的 PDF user space，不是浏览器像素 |
| `source_sha256` / `output_sha256` | 原文/译文 PDF 原始字节的 SHA-256，64 位小写十六进制 |
| `units` | 仅已验证单元：`id`、`status: "verified"`、`source`、`target` |
| `source` / `target` | `{page, rects}`；**page 从 0 开始**，`rects` 为非空 `[x0, y0, x1, y1]` 列表 |
| `metadata`（可选） | 候选、验证、排除数量及排除原因，供诊断使用 |

`build_mapping(source_path, output_path, candidates)` 只接受上游捕获的同单元候选：`id`、两侧位置、`source_text` / `target_text` 和 `applied: true`。它在实际 PDF 中验证文本绘制证据、几何范围和字面文本，处理 CropBox、旋转及 UserUnit。比较 NFKC 后的非空白字形序列，容忍 PDF 抽取增删的词间/行间空格，并仅将排版连字符 U+2010/U+2011 视为 `-`；大小写、数学负号、长破折号、缺字和 NUL 可见性断点仍不同。不做语义、相似度或跨段猜配。候选失败只计入排除原因；sidecar 不保存候选的全文文本。

`write_mapping()` 原子写入 sidecar，不写 PDF。`load_mapping()` 复核 Schema、两份当前 PDF 的 SHA-256 和真实页几何；缺失、损坏、hash 变化或没有已验证单元时返回 `{available: false, reason}`。加载不重新猜配文本，也不触发翻译。

### 生产片段采集

- `backend/engine.py` 为现有 translator 挂接可选的 `FragmentTrace`（`backend/fragment_trace.py`）；`backend/batching.py` 在 worker 启动前记录原页、paragraph identity、文本和几何，保留同一可变对象供最终排版后读取。正常翻译和实际应用的段落缓存均走此路径，不改变请求数、模型配置或缓存身份，不修改 BabelDOC 本体。
- 只接受 quality 中真实 `applied`、最终仍有稳定同一 paragraph identity 的单页请求片段，并以实际 PDF glyph 边界验证两侧文本与位置。`xobj_id=0` 是固定版本的普通页正文，可映射；受保护、未应用、移页、合并或无法可靠追踪的对象不映射，不拆成句词，也不保证跨页对应。
- 当前生产 `FragmentTrace` 每侧只输出一个 bounding rectangle；Schema 的矩形列表并不表示生产已经分解跨栏多岛区域。同页分离矩形只在几何夹具中用同一已验证身份检查命中，不能用该结果承诺生产跨页/跨栏段落拆分。
- 最终 `restore_regions()` 和 `translated.pdf` 保存完成后，经 `build_mapping()` 验证，原子写入仅含 verified 单元的 Schema 1 `alignment.json`；候选全文只留在内存。源 hash 始终绑定原始 `source.pdf` 快照，不是可选的 `repaired.pdf`；目标 hash 绑定最终保存的译文。
- 采集有界：最多 4,096 单元、每侧 1,000,000 字符、每单元 32,768 字符；超限只排除映射，不限制翻译。采集或映射失败仅警告，不丢失 PDF、质量记录或其他阅读功能。没有已验证单元时映射不可用，不自动重发请求。

### 父级集成与阅读器

- `backend/server.py` 保留生产尝试目录中的 `alignment.json`，若文件存在则暴露 `alignment_path`。`POST /alignment/validate` 仅接收 `mapping_path`、`source_path`、`output_path` 做本地验证，不创建或重试 job。
- `addon/content/library.js` 将 `alignment_path` 持久化为归属记录的 `alignmentPath`，重试保留旧归属并使用新尝试的路径。`paperbridge.js.loadAlignment()` 按原文/译文附件归属取 sidecar，用两份当前附件的实际路径交给后端验证；`bootstrap.js` 加载 `alignment.js`。
- `addon/content/alignment.js` 只检查父级已验证 mapping 的内存形状。用户先点击译文，再显式按“定位原文片段”；通过对应页的 PDF.js viewport 换算，只有唯一矩形命中才导航到原文。重叠/歧义或未命中不猜配，不自动连续追踪。
- 独立的“段落高亮”开关位于右下角，默认关闭。开启后，两侧的被动 `pointermove` 用各自页的 viewport 命中同一已验证单元，在两份 PDF 中高亮对应的原生文本项。**最小单位是可追溯请求片段**，不是按句子或单词重新切分；同单元的矩形重叠仍可悬停，不同单元的歧义、无映射或未验证区域不处理。
- 悬停使用各 PDF 内的 **CSS Custom Highlights**：只为完全落入该单元矩形的原生文本项注册 Range，`priority=-1`，不抢占搜索等原生高亮。浅蓝背景经原生 `textLayer` opacity 柔化后约为 10%，不修改该 opacity、不增加页级 DOM overlay，也不修改 PDF、canvas、text span、批注或 selection。显式定位仍使用独立的短暂 DOM 高亮与页同步回跳抑制，原生批注保存机制不变。
- 悬停不导航、不切换同步模式、不请求模型；离开、拖选、关闭开关或分屏会清理它。滚动重新命中鼠标下的区域，缩放/旋转后的悬停使用当前 viewport 和原生文本层；对应页不可见或尚未渲染时不强行滚动。缺少 CSS 高亮 API 只禁用悬停，有可信映射和定位接口时仍保留显式定位。

旧成果没有 mapping、sidecar 丢失/损坏或 PDF hash 改变时，映射控件显示不可用原因，仍保留附件、普通阅读和页级同步；**不为补 mapping 自动重译，也不回推文本猜配**。页级同步不等于片段对齐，sidecar 也不保证随 Zotero PDF 跨设备同步。

### 打开译文与片段定位的区别

- 阅读器右键的“PaperBridge：打开已有译文”和工具菜单的“打开已有译文分屏”调用 `paperbridge.js` 的 `openExisting()` / `split()`，只打开已保存的译文分屏，不做片段跳转。
- 同一阅读器、原文和译文的重复打开复用现有分屏（初始化中也共享 `state.ready`），不重读译文 PDF，不重置页码、缩放、分屏宽度或同步模式；选择不同译文或关闭分屏后才重新创建。`loadSplit()` 负责初始化，过期初始化不得关闭替代分屏。
- 当前支持译文→原文的显式定位，以及原文↔译文的双向悬停高亮；两者独立，悬停不等于导航或双向批注复制。无 sidecar 的旧译文仍可打开，但映射控件不可用。

## 静态测试与原生套件入口

离线单元/静态入口（provider 测试使用临时模拟输入，不使用项目真实凭据）：

```text
python -m pytest tests/test_fragment_trace.py tests/test_alignment.py tests/test_verify_providers.py -q
node tests/test_alignment.cjs
node tests/test_library.cjs
node tests/test_sync.cjs
node tests/test_packaged_startup.cjs
```

原生阅读器入口是 `tests/alignment_packaged.js`（显式定位）和 `tests/hover_packaged.js`（双向悬停及原生批注叠加），使用已重建的当前平台 XPI：

```text
python scripts/prepare_packaged_test.py --suite alignment
python scripts/prepare_packaged_test.py --suite hover --run-id check
```

运行 Zotero 时指定准备脚本返回的独立 profile（`-no-remote -profile <绝对路径>`），仅使用其对应的测试 data，不运行在日常 profile。测试前在 **`.runtime/alignment-fixture/`** 准备同次可信采集的 `source.pdf`、`translated.pdf`、`alignment.json`，保持 PDF 字节不变；准备脚本不生成这些 fixture，缺失时套件不代为翻译。悬停套件只在测试 profile 关闭首次启动欢迎页，避免系统浏览器遮住 Zotero 后触发原生绘制节流。

套件测试真实附件归属、后端验证和阅读器映射/批注及降级，禁止 `POST /jobs` 和重试，**不调用 providers**。显式定位结果为 `.runtime/alignment-test.json`；命名悬停套件的 profile/data 为 `.runtime/hover-<run-id>-profile` / `-data`，结果为 `.runtime/hover-<run-id>-result.json`。默认 `--suite packaged` 是另一套可能调用付费 API 的测试，不能用它替代这两套。

代表性缓存片段和冷进程重开的独立入口是 `scripts/prepare_nonmac_test.py --suite reading` / `tests/reading_packaged.js`。`--phase create` 指定确切 XPI 与 `--case-manifest`；`--phase reopen` 复用同一 run ID 的 profile/data，不重装插件或重置设置。实际公共自动更新使用该准备器的 `--suite update` / `tests/update_packaged.js`，不是用文件替换模拟，发布前后步骤见 [releasing.md](releasing.md)。两套均禁止提交翻译任务。

`scripts/prepare_representative_hover.py` 从已授权历史译文的段落缓存经生产管线准备真实片段，缺缓存时不转为付费请求；`scripts/create_hover_geometry_fixture.py` 只准备明确标记的合成几何夹具。Linux / Windows 0.3.4 两种 Python 包的当前原生、冷启动、公开交付和日常安装范围见 [verification](nonmac-verification-2026-11-15.json)。所选页片段通过不等于整篇语义、生产跨页映射或全平台原生验收；macOS 原生兼容性未认证。
