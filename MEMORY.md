<!-- Current shared baseline, safe development entry points and unresolved product boundaries. -->
# 当前开发基线

- 主分支 `master` 为吸收 macOS 增量后的**未发布 0.4.3 候选源码**（addon manifest、server VERSION、pyproject、uv.lock 一致），不代表旧安装包新增了功能，也不授权公开发布。已公开 Linux/Windows **0.3.7** 的 `v0.3.7` 固定生产提交 `3f85caf61303245b880803eceeb977f4124630ec`；四条稳定通道仍绑定 freeze07 四包及下述 v16 引擎/v5 提示。旧 freeze05/v14 与 freeze06/v15 四包不能代表该公开基线；候选准备不重写冻结包、源码 ZIP 或标签。
- 固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**，默认 `deepseek-flash`。不顺带升级引擎。
- 独立 macOS **0.4.2** 的第一方源码由 [PR #3](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/pull/3) 提供，头提交 `272d85e52bf653d084191e705cabe60ef1188f62`、共同基线 `b51a82f`；功能增量已吸收到共享实现，保留合流前 `bbf1f0d` 的任务/阅读/引擎修复。既有 macOS 发布包及通道仍独立且不覆盖；0.4.3 只是新共享候选身份，正式发布/稳定更新另需授权。
- 已按 GitHub asset digest 核对旧 macOS 0.4.2 XPI（SHA-256 `6cbc0a5b43a3ab034a5dc0558f8029d8dbcb3f706275a7afe90ba25707b5d285`）：实际 manifest 的 `update_url` 是 `example.invalid` 占位地址，内置 CPython 为 3.12.14。它不能靠新增 Mac feed 自动迁移，需一次手动安装新版接入；此限制不阻塞注明手动升级方式的 Release，但不能宣称旧包自动升级已实现。
- 常规验证入口：本项目 `.venv/bin/python -B scripts/check_offline.py --mode full`，清理继承的 `PYTHONPATH/PYTHONHOME/LD_*`；不要改系统 Python/ROS2。轻量 CI 只安装 pytest/PyMuPDF/httpx，须在真实最小依赖环境验证；完整 `.venv` 下的 lightweight 通过不能替代它。使用 BabelDOC IL 或科学依赖的用例属于 `FULL_ONLY_CASES`，完整模式仍必须运行。Windows 用项目实际有效的环境，不借用其他产品的 Python。
- 已确认的历史 CI 根因包括轻量依赖边界、辅助测试入口/设置 disclosure 和原生 runner 配置，以及真实 Darwin HTTP 未消费 body 导致连接 reset（共享 `server.Handler` 已修复）。看当前提交对应的 run，不以历史红色记录代表现状；不跳过完整引擎断言换绿灯。
- 手动 `release-candidate.yml` 的 `all` 包含 Linux x64 / Windows x64 / macOS arm64；Mac 使用固定原生 `macos-26` 并拒绝 Rosetta（OpenCV 最低部署目标仍为 macOS 13），Windows CPython 固定 3.12.13、Linux/Mac 3.12.16。构建与 CPU forward 不是 Zotero 原生验收或发布授权；独立复制 stage，不改 freeze07 或 `.cache/package` 原暂存。Mac OpenCV 脚本保存实际配置/原始归档/架构/hash，未取得构建证据的旧 stage 只警告，不让其他基本功能失效。
- 当前 Mac 候选依赖的最低 wheel tag 并不统一：orjson `macosx_15_0_arm64`，NumPy/ONNX Runtime `macosx_14_0_arm64`。OpenCV target 13 不能证明整包支持 macOS 13/14；原生实测为 macOS 26。发布前说明实际最低系统范围，若承诺 13/14 则另行适配/验证，不暗改范围或新增 Intel 验收门禁。
- `restore_candidate_stage.py` 只恢复已校验 bundled XPI 的原生字节/执行权限，不执行外平台二进制。Mac 候选工作流可用 `reuse_macos_run` 保留同一原生 stage/原始构建证据并重建新源码/notices；实际 Zotero 10.0.8 的 create/reopen 结果单独绑定最终 XPI SHA 和真实 native PID，受控 Gecko 输入不是物理操作。CI Mac VM 使用 LaunchServices/软件 WebRender，不改插件生产偏好、签名、锁或 NSS；未通过不能冒称原生验收。
- 当前 `candidate03` 六包绑定共享阅读器修复源码 `80e39a8`，在真实 Zotero 10.0.8 完成三平台、两个模式的批注 create/cold-reopen 与真实后端启动；新增真实 tab 切换后第二页 FINISHED/canvas/text-layer 验证。Linux/Windows 0.3.7→0.4.3 原生文件安装升级和冷重开已完成；Windows 另验证既有真实 PDF 的原生选词、高亮、两类独立笔记及编辑器 PDF 反链。Mac 是隔离新安装/冷启动，不等于旧 0.4.2 资料迁移通过。证据入口为 `agent/codex/current-release-prep-path.txt`，不替代自动更新、物理输入或全文语义验收；旧 `candidate02` 仅保留为历史输入，不作为当前发布候选。
- Mac 上游/真实 native 源与 notice 范围已加入交付 manifest（319 个固定归档、15 个 build inputs，保留原 L/W 303 归档身份）；四个 copyleft package 的 pinned sources/notices 已有实物覆盖。三平台 ONNX Runtime 1.31.1 的短 revision `6af1a93`/对应 tag 仍未取得可验证源，不以 ONNX 1.23.2 或另一 Runtime 版本替代。Berkeley DB 自身来源/条款已提供，其 clause 3 的必要 accompanying-software 范围仍需确认。只把明确必须交付的 source/notice 缺口当发布阻塞；这些不是已发现的 runtime bug，固定 `partial/false` 或 compiler/optional-link unknown 不自行新增门禁，也不宣称法律或完整原生源码已闭合。
- `scripts/probe_formulas.py` 可用显式 PDF、零基页码、backend/cache 路径做免费 CPU 区域检测。它阻止 Python 外连、禁用 ONNX telemetry、把模型复制到临时私有 cache；不写原 PDF/模型/用户 cache，不做 provider、LaTeX 转写或召回/语义验收。输出放新 JSON，不覆盖既有证据。

## 共享公式与原生译文阅读器

- `formulas.js` / `formula-cache.js` 负责选区与显示公式悬停复制、本机 JSON 和晚配对合并；工具菜单/设置可管理缓存。缓存位于 Zotero 数据目录 `paperbridge/formula-cache`，只清理本模块 JSON，按存活论文/PDF 引用保留，不等于跨设备云同步。优先复用原生 LaTeX/缓存；转写固定使用已保存的 **DeepSeek Key 与基础地址配对**、`deepseek-flash`，不借用当前 compatible 配置。缓存写入失败不阻断已取得 LaTeX 的复制。
- `/formulas/regions` 复用包内模型进行 CPU 本地检测，后台启动为非交互；失败不写成永久空页，悬停重试有界。`formula_regions.py` 保留旋转 CropBox/MediaBox 的原始 PDF user-space 坐标，初始化失败可重试；`formulas.py` 拒绝带明确 provider error 的部分 LaTeX。没有新增依赖或升级 BabelDOC；科学依赖用例在 `check_offline.py` 的现有 full-only 边界中保留完整验收。
- `server.Handler` 在响应前以小块丢弃未消费的请求体；拒绝大请求、认证失败或忽略 body 的控制路由不能直接带未读字节关闭 TCP，否则 Darwin 客户端可能收到连接重置而不是 JSON 错误。普通 JSON/公式请求仍按原限额验证，拒绝输入不执行 provider，丢弃阶段只限制空闲读取时间，不改变普通请求超时。
- `reader.js` 的 attachment-backed `TranslationReader` 是共享原生首选，`annotations.js` 的 `TranslationAnnotations` 仅在接口不支持时作为兼容 fallback；同一译文 pane **只有一个批注 owner**。embedded reader 不作为可选择的 Zotero tab，不显示整篇翻译命令；原生菜单/权限/批注属于译文附件。`split()` 初始化并跟随 host container 的 `tab-selection-change` 同步 sibling `docShellIsActive`，关闭时移除监听；Zotero 自己只管理 ReaderTab，不可用强制 PDF 绘制代替此生命周期。关闭在首个 await 前截取 debounce 编辑，等待本附件写入/状态 flush，并在失败时仍释放注册、factory、observer、view 和原分屏布局。保留 source itemID 恢复、同 pair 复用、stale 初始化保护、flex 恢复及任务中断/重试语义。
- 三平台 Zotero **10.0.8** 的两个候选模式已在隔离资料库完成原生阅读、高亮/下划线/笔记、删除及真实进程冷重开；受信 Gecko 输入不是物理操作。Windows 原生反链验收必须排除 embedded owner，观察真正的独立译文 reader；既有 v5 PDF 的重复页眉不是精确选区 oracle，验收选用明确正文词且不改写 PDF。旧 Mac 0.4.2 资料迁移、公开自动更新、公式真实转写质量/检测召回及全文语义仍未闭合；共享源码 CI 和旧包证据不能替代这些边界，生产源码变化后须重建并绑定新产物。

## 翻译、身份与结果

- prompt `paperbridge-compact-v5-anaphora`：相邻/跨页碎片保持独立 ID，不转移文本/标签、不补造后文；已有比较之后的短残缺条件用实际源字符串分开请求，只在同一原段落内重组，逐项保留占位符。each 等省略指代只依赖同一输入中的先行词，数值不能换到错误实体。普通拉丁词内连字符不成为假公式；真实公式、样式和科学维度仍校验。改变 prompt 不复用旧段落来证明新提示质量。
- 整篇排版身份 `babeldoc-0.6.4-protected-v16-transparent-clips`；源行/嵌套图注统一归属，原词尾宽度/URL 断行规则直接修正；`source_formulas.py` 用实际源字形合并完整表达式，多行公式按行顶对齐，纯数字乘法不把普通多字母正文声明为变量。每个保护区在独立副本上清除完全在裁剪区外的文字再恢复，避免隐藏整页原文进入局部复制/搜索；副本不得绘制删除填充，否则画外矩形会使精确映射误判遮挡。保留边缘字形、原字体和图形，旋转页裁切/链接使用未旋转坐标；正文白底置于整段译文之前。唯一不变标签支持 URI/内部引用定位；译后标签、歧义和不可见热点不猜配。
- `preserve.py` 在分段前仅剔除完全处于其已变换 Form BBox 外的不可见字形，防止裁图中残留的整页文字生成重复段落、错误收费及排版碰撞；不靠最小字号或删可见正文掩盖问题。Abstract/Summary 都终止前言，机构词必须位于真实块开头，尾部机构依赖局部联系邮箱。`references.py` 只在实际跨列共享间隙分段重启列阅读顺序，避免尾部参考文献误吞右栏科学结论。
- 仅缩小与本地 Songti 缓存字节相同的新字体程序，保留 glyph ID、ToUnicode/编码/宽度表；禁止通用 `subset_fonts(fallback=True)` 重建原出版字体字典。源端隐式 Symbol 编码只在工作副本显式化，原 PDF 保持不变。
- 执行、quality、PDF 导入与映射导出分开；`complete` 只代表观察到的段落应用，不是整篇语义认可。未知账单和 provider 格式/占位符拒绝如实保留，不用自动重试美化结果。
- 新尝试 `jobs/attempts/<job-id>-<number>/`，旧 nested 目录仍读。重启不重发；显式重译可能收费，单独保存不收费。最新尝试不能继承旧成果或被旧 `complete` 掩盖。
- Zotero 数据目录 `paperbridge/engine` 可重建，`cache` 是模型/字体/段落缓存，`.runtime/jobs` 保留任务成果。日常这些目录、原 PDF/译文/JSON、未知归属和备份不能按临时文件猜删。清理不取消任务；SQLite 连接显式关闭以免 Windows 锁文件。

## 阅读与原生保存

- `library.js` 持有 durable records，`tasks.js` 负责串行任务/显式重试/保存。完成轮询保存本次 `alignment_path`；`library.attach()` 一次保存标题、原生 URI 和 type-1 自动恢复标签，随后独立导出 JSON。映射失败显示 warning，不使已导入 PDF 变成失败。
- 内部 `urn:paperbridge:record/job/alignment` 使用自动标签；Zotero 云拒绝它们进入 `dc:relation`。旧标记原生迁移保持 keys/ID/PDF，真实条目 URI 保留。损坏索引先备份、停清理，普通阅读继续。
- `fragment_trace.py` / `alignment.py` 验证同身份 applied 证据、最终 PDF hash 和有限逐行四边形；schema 2、pdf-user-space、0-based page。跨页/歧义/不可见字面不猜配。sidecar 不写全文。
- `reading-assets.js` 的同步 JSON 含精确原/译/owner keys、hash 和几何；读取用 Gecko 与实际 PDF.js 页界，不依赖 Python/API。缺失、未下载、换字节或冲突仅停精确定位/高亮；原文缺失时保留可独立打开的译文。
- `paperbridge.js` 恢复 reader 按原附件 itemID 查找，不能选无关 tab；同一附件对复用 split/初始化 promise。笔记经官方 serializer 和一次 saveTx，新 Item 不预设 key；批注只属译文，关闭前快照并等待 pending writes。不做双向批注或词/句语义对齐。
- 保存 Python 路径不停止已有引擎；新路径在下次正常启动生效，等待任务完成后重启 Zotero 才切换。

## 构建、许可与发布

- Linux glibc ≥ 2.34，默认 stage `.cache/package/linux-x64`；image-only OpenCV 4.12 的兼容工具链/install 在 `.cache/opencv-linux-x64`，不得用 Ubuntu 24.04 默认 glibc 2.38 产物替换。Windows 沿用既有官方 OpenCV wheel/CPython 3.12.13，Linux CPython 3.12.16。
- `build.py` 每次生成 payload，固定 ZIP 元数据/压缩级别，保留原许可字节和 nested runtime.json。验收绑定完成 XPI SHA，不只 backend build ID；原生 Linux/Windows 分别构建 bundled/local。修改任意生产资产后重建对应包。
- `package_sources.py` 从已提交快照绑定四包全部生产文件（含 CSS），同行提供 303 上游归档和 4 个 Linux build inputs。缓存 `agent/codex/licensing-p0-1-20261116-003659/source-cache` 保留；源码 ZIP 同地公开，其内部 `bundle-manifest.json` 与四个 inventory 保留，本地外置清单/checksum 保留，不用无范围 written offer。法律合规仍 unknown，不将普通编译元数据不确定性当作已发现缺失义务。
- 用户已确认 Community 2026 的合法使用和 section 8 分发责任，不重复索取。三 DLL/原始条款保持原字节；Windows 初次引擎启用只确认 `msvc-community-2026-v1` 一次，拒绝只停引擎，设置可重开；后台/诊断不弹窗，Linux/macOS 豁免。
- Linux/Windows 独立平台/模式 feeds，0.3.7 仅四个 XPI 与对应源码 ZIP 共 **5** 个上传资产公开，GitHub 自动 Source code 不动；包位于 `dist/release-0.3.7-freeze07/`。用户确认保留对应源码 ZIP，其余独立校验/清单只本地保存，未来不上传；`verify_release.py --online` 核对实际本地包、feed、GitHub XPI digest/size 与下载可达性，不依赖这些 sidecar。冻结 XPI/源码 ZIP 与标签不因后续工具/政策改动而重写。
- Release 用 `make_latest=false`，仓库 Latest 仍为独立 macOS 0.4.2，不改其资产/通道。公开版本与各附件用途见 `docs/release-versions.md`；0.3.5/0.3.6 仅开发候选。GitHub TODO #1 已同步 0.3.7 交付及未完成验收，发布时继续维护且不以勾选比例表示完成度。Git 操作在 master 快进，不建分支/worktree，不强推；API 不用 gh。公开元数据验证不等于 Zotero 从旧版本自动升级实测。

## 安全接续与证据

- 日常 Linux Zotero `/home/scq/.local/opt/zotero/zotero`，profile `/home/scq/.zotero/zotero/ylkmnjtn.default`，data `/home/scq/Zotero`。不要与项目内隔离测试混淆，正常停机备份后才升级；不强杀、不改锁/SQLite/NSS制造通过。
- Windows SSH `desktop-hz`，Zotero `D:\Zotero\zotero.exe`，原工程 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`。有效 Python `.runtime\windows-p1-validation-20261114\.venv\Scripts\python.exe`。不改原工程工作文件/HEAD/stash及原备份；原生 UI 用登录 Interactive Session，不用 SSH Session 0。
- Windows 隔离验收使用本项目 `agent\codex\r043` 的短 plain-source 拷贝；过深测试 dataDir 曾导致同一候选解包失败，短目录后真实后端通过，不宣称长路径支持。`prepare_nonmac_test.py` / `prepare_packaged_test.py` 仅在 disposable Windows profile 设置官方 `extensions.zoteroWinWordIntegration.skipInstallation`，避免无关 Word 首次安装弹窗阻塞；不改日常 Office 设置，不跳过 PaperBridge 的真实运行库条款/后端断言。UTF-8 Gecko 回执在 PowerShell 读取时须显式 `-Encoding UTF8`。
- 当前 Linux 检出未配置 GitHub 写入凭据；可使用 `desktop-hz` 既有 Git 凭据从独立临时 bare 对象仓库推送已核验提交，不改 Windows 原检出的 HEAD/工作区，不导出或将凭据写入仓库。Git HTTP verbose 变量须移除而非赋值 `0`，并保持凭据 trace redaction。
- Windows 日常 profile `C:\Users\LostPatrol_2\AppData\Roaming\Zotero\Zotero\Profiles\dljrawap.default`、data `E:\0syncthing\Zotero` 未获日常升级/同步授权。Linux 日常 metadata-only 同步已成功，但 Windows 接收/文件/多译本/group 云验收仍未完成；不全库上传。
- 日常 Linux 已存在的 metadata helper 读 `agent/codex/account-metadata-v10-20261117-005536/native-helper/account-linux-v9-metac-options.json`，其 report 已存在，禁止重放。该目录保留一致停机备份及安全接续证据，不删；实际账号同步只用官方 Runner，`getAPIKey()` 可能写 OSKeyStore，不当纯读取或导出 NSS。
- 新版本真实测试/财务/原生和清理证据集中在 `agent/codex/real-release-20261117`。两批 **20 篇 / 306 页**最终 v16 均 terminal done，结构应用结果 **2 complete / 18 partial**，不是全文语义通过；2411 个真实请求的账本已闭合，未知用量为 0，费用仍是官方费率估算而非账户 invoice。本次授权不延伸到任务完成后的新付费探测。原始输入、已收费/失败成果、ledger、字体/段落 cache 和 source archives 保留；隔离 engine 可重建，但不可按临时文件猜删其余数据。
- freeze07 的 Linux/Windows bundled/local 原生 create/reopen 验收均完成；Windows 最终证据为 `continuation/windows-final06-receipts/`。完整选区通过实际 PDF.js controlled Range、原生按钮及官方 serializer/Annotation API 保存，不冒称物理鼠标拖选/高亮已测；真实旧版到新版自动升级和 Windows 日常跨设备接收仍未完成。
- 仍有限制：provider 可能返回缺标记/合并片段，保留 partial/unknown；未读段落不冒充语义接受。繁体/日文、完整术语规则、精确双向批注、真实跨设备文件同步尚未完整交付。维护指南见 `docs/`；根 TODO 不自行改，task 文件只由用户提供，过程放 agent/codex，每次新简报放 agent/report。
