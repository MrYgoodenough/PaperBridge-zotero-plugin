<!-- Current baseline, maintenance entry points, and unresolved compatibility limits. -->
# 当前开发基线

- 源码与 Linux/Windows 已发布包为 PaperBridge **0.3.4**，主分支为 `master`；包含可靠任务、串行批量、双配置、本地成果恢复、PDF 链接修正、独立原生译文批注、脱敏诊断和可追溯请求片段的双向悬停高亮。后端固定 BabelDOC 0.6.4 / PyMuPDF 1.26.7，默认 DeepSeek `deepseek-flash`。版本变更须同时维护 addon manifest、`backend/server.py VERSION`、pyproject 与 uv.lock；`tests/test_bridge.py` 核对这份公开版本契约。
- 改动生产 addon/backend 后必须重建各平台 XPI；同名旧包不会跟随源码更新。四种 0.3.4 包均核对 29 个发货源码文件及最终 XPI SHA-256，在 Ubuntu 24.04 / Win11 + Zotero 10.0.8 各通过 290 项代表性片段读取、304 项同 profile 真冷重开、112 项悬停/批注/降级检查；正常退出、库完整性 `ok`、无隔离引擎残留。Windows 在 `desktop-hz` 使用历史原生 stage 重打包后实机验证，不是交叉编译。当前包与限定范围见 `docs/nonmac-verification-2026-11-15.json`；macOS 未重建。
- GitHub `v0.3.4` 有四种已验收 XPI 与四份校验文件。根目录 `updates/` 四条 Linux/Windows 独立通道已发布 0.3.4，精确公开 URL、内容/版本/资产 hash 均实测一致；先发布资产再启用清单，不使用查询串绕缓存。四种包均实际完成 `AddonManager.findUpdates` → 公共下载/安装 → 同 profile 真冷重开（0.3.2→0.3.4，18+14 项），并核对当前 health/installed marker 版本和 build ID。`0.3.3` 历史公开资产保留但曾发现后端公开版本不一致，当前使用修复后的 0.3.4。不要把仓库级 `releases/latest` 当作平台回退：Latest 仍为独立 macOS 0.4.2，其 tag/资产/通道未改动；`example.invalid` 的旧安装仍需原生手动安装一次。
- 日常安装必须保留停机 profile/库备份，并使用 Zotero 原生文件安装或更新安装器；只复制 XPI 不证明 AddonManager 实际加载版本。核对原生插件版本、落盘 XPI hash、延迟引擎 health/marker，再正常退出和同 profile 真冷重开；不得清除插件元数据、preferences 或 NSS 凭据来制造成功。
- `.github/workflows/ci.yml` 是 Linux/Windows/macOS 轻量矩阵，Python 3.12 / Node 22，只安装 pytest、PyMuPDF、httpx，运行 `scripts/check_offline.py --mode lightweight`。GitHub run `43613934143` 已核验 0.3.4 源码 `8b2cd6632886`：三平台及全部步骤 success。默认 `full` 另检查已安装引擎依赖。CI 不调用服务商、不构建大型 runtime，也不等于 macOS 原生验收；setup-uv 使用 `v10.3.3` 完整 tag。
- 运行时按 `macos-arm64`、`windows-x64`、`linux-x64` 独立构建。Linux amd64 自带 CPython 3.12，解释器路径 `python/bin/python3.12`；当前 Linux 包的原生库要求 glibc ≥ 2.34。Ubuntu 24.04 + Zotero 10.0.8 已实测，其他发行版尚未实机验证。
- Linux 使用官方 OpenCV headless wheel，需保留各 wheel 的 `.libs`；仅 macOS 需要自编译精简 OpenCV。打包用 uv 管理的独立解释器，不用系统 Python 作为可重定位运行时。
- Linux 中文字体通过 fontconfig 查询已安装的思源宋体等中文衬线字体，选择简体中文字面并导出到插件缓存；CFF 字面以 `.ttf` 缓存名保存，但 PDF 中实际为嵌入的 OTF。系统字体不随 XPI 分发。
- 项目及插件启动的 Linux Python 清除继承的 Python 和原生库路径；不修改父环境、系统 Python、ROS2 或 shell 配置。开发环境、模型、测试状态位于项目自己的 `.tools`、`.venv`、`.cache`、`.runtime`。
- 正式译文是 Zotero PDF 附件；插件不再因论文进回收站或原文缺失永久删除译文。Zotero 自身的删除行为不变。可恢复成果、任务和共享归属都保留，只有已确认无归属的临时缓存可清理；损坏索引禁用清理。

## 任务与成果接口

- `backend/server.py` 使用 `.runtime/jobs/records/*.json` 与不可变尝试目录持久化串行任务。`GET /jobs` 返回 `{jobs:[...]}`；显式 `POST /jobs/{id}/retry` 传入当前凭据，返回新 ID，并链接 `previous_job_id` / `root_job_id`。重启未完成任务标为中断，不自动重发。
- 损坏的单条任务记录保留在磁盘并跳过，不阻断其他记录。认证后的 `POST /jobs/{id}/recover` 只核对已落盘 PDF、质量及哈希/来源证据，沿用正常 `finish()` 恢复可用成果，不调用模型。提交区分 accepted/rejected/unknown/not_found；响应丢失先找回，确认拒绝或确认未入队后才允许显式重发。
- 新尝试在 `jobs/attempts/<job-id>-<number>/`，记录标记 `layout: "flat"`，避免指纹与 UUID 重复嵌套造成 Windows MAX_PATH 错误。缺少布局字段的旧记录继续读取旧目录，不迁移文件。`identity.json` 是新目录的归属依据，清理必须保留；缺失或损坏身份的未知目录不猜测删除。
- 顶层用量是重试链累计，各尝试另有独立用量，不能跨任务列表再求和。响应丢失/缺少用量时账单未知。SDK 重试关闭，失败自动回退只用确认缓存；引擎父进程失联后自行退出。
- `quality.json` 区分 complete/partial/unusable/unknown，依据所选页翻译单元的结构与应用证据，不保证语义质量。仅有 PDF 不算成功；未知或不可用尝试仍保留文件与清单，不覆盖旧可用结果。
- 后台完整结果复用需核对已记录的 PDF SHA-256，旧记录可从 manifest 读取；改动过或无校验依据的 PDF 保留但不自动复用。前端部分/未知附件仅供显式打开和重试；旧版已保存附件即使没有任务 ID，也可经确认新建翻译而保留旧成果。
- 后端不能恢复但 PDF 仍在时，可经确认保存为“质量未确认”，不付费重译、不覆盖旧附件；已确认 unusable 的结果不能降格包装为 unknown 成功。已删除的归属不自动导入，但保留文件定位操作。
- `addon/content/tasks.js` 分离入队、跟踪、导入和打开阅读器。批量每篇取首个非译文 PDF，完成只保存；单篇和批量都把未变原文、相同配置的未完成/未确认成果转到任务列表，批量跳过后继续其余论文，不隐式重试。同一后端 job 的不同论文分别保存，取消一项不误取消其他归属。提交前先存归属；响应丢失按指纹或重试链找回，不自动再次调用模型。
- `tasks-window.js` / `tasks.xhtml` 使用简洁任务卡片，终态隐藏进度、只显示可用操作；段落明细、原始阶段、用量及重试次数在默认折叠详情中，轮询不重建节点。错误、部分/未知完整性和计费未知仍在卡片上提示，不能为了简化界面冒充成功。布局随系统浅/深色和窄窗调整，不改变任务/保存/重试语义。
- `library.js` 的索引版本为 2。`put/update/findAttachment/attach/forkAttempt` 管理每个归属；重试保留旧记录和附件，未导入的旧结果脱离自动保存。导入 key、record/job 关系用于恢复，未落任何标记前崩溃仍可能留下未索引副本。
- 设置保留默认 DeepSeek，加一个可选 OpenAI Chat Completions 兼容 profile；各自密钥留在登录管理器，任务固定非秘密配置。缓存身份只由 `library_cache.py` 规范化；未知服务身份的旧段落缓存保留但不复用。维护入口见 `docs/tasks-and-results.md`。
- 统一任务窗口负责启动阶段、百分比、实际段落/缓存计数及尝试用时，关闭后从阅读器重开，不建立第二个等待者或再次自动打开阅读器。引擎 `phase/counts` 使用现有质量账本；上游百分比为 0–100，小数不按比例放大。Windows 草稿中的独立 `results.py` / `progress.*` 没有并存引入，目标已合入当前结构。
- `backend/errors.py` 提供 startup/resource/long_path/file_busy/provider/general 操作建议；`backend/diagnostics.py` 的认证 `POST /diagnostics` 仅导出汇总白名单 JSON 的本地 ZIP，不包含密钥、正文/PDF、路径/任务 ID 或原始日志，不自动上传。设置页负责导出与定位；`/health.warning_count` 暴露启动记录警告数量。

## PDF 与原生批注

- `backend/preserve.py` 在现有最终写出步骤修正链接：保护区/未选页保留源链接，译文页剔除已识别的正文旧坐标热点，保留生产者已移动的链接；无法确认的正文目的地使用真正的页级 `/Fit`，不猜测精确坐标。真实禁网 BabelDOC 两页管线覆盖成功与响应丢失，未选页链接保留；该模拟结果不是付费语义验收。维护入口见 `docs/pdf-links.md`。
- `addon/content/annotations.js` 使用 Zotero 原生附件批注 API，独立于不可取得的 macOS 0.4.2 源码。批注只属于译文附件；写入串行化、关闭先快照并等待持久化、重开等待旧写入；权限变化才调用原生 `setReadOnly`，已销毁 iframe 不再接收保存回调。不可写时只降级批注，不阻断 PDF 阅读，不做原译双向批注复制或完整标签/QuickCopy/公式功能。维护入口见 `docs/annotations.md`。
- 此前 P0/P1 基线包在 Linux / Win11 Zotero 10.0.8 的自带/本地 Python 模式，各完成 21+8 项原生批注、16 项升级/阅读/链接和 17 项任务/设置检查，正常退出、库完整性 `ok`；索引见 `.runtime/p0-p1-native-verification.json` 和 `.runtime/p0-p1-windows-native-verification-20261114.json`。这些不是当前悬停包对旧套件的再次验收。升级使用保留的本地 0.3.1 包手动替换为 0.3.2，并非自动更新；任务模型结果显式模拟，不是真实论文语义验收。

## 引擎、片段映射与悬停高亮

- `scripts/probe_engine.py` 在独立环境研究发布 wheel，不是生产采集入口。0.7.1 正式 wheel 的 `stage_capture_enabled=False`；官方字体下公开管线成功，但旧保护适配与 `PageProjection` 不兼容，系统宋体 hash/profile 也被 Rust 拒绝。生产依赖没有升级，不维护自定义 Rust 分支。
- 正常 0.6.4 翻译及段落缓存应用由 `backend/fragment_trace.py`、`batching.py` 的自身 adapter 和 `engine.py` 最终保存钩子生成 sidecar。仅保留真实 quality `applied`、同一 paragraph identity 的单页请求片段；受保护、未应用、移页/合并、无法可靠追踪的对象不映射。固定版本的普通页文本 `xobj_id=0` 不能误当 form XObject 排除。源 hash 绑定原始 `source.pdf`，目标绑定 `restore_regions()` 后的最终译文；不保存捕获全文，不增加请求或改变缓存身份。
- `backend/alignment.py` 只接受已应用、同单元捕获的候选，并核对两份实际 PDF 的可见字面文本/几何。比较 NFKC 后的非空白字形，仅 U+2010/U+2011 与 `-` 等价；大小写、数学负号/长破折号、缺字和 NUL 可见性断点保持严格，不做双语语义猜配。Schema 1 使用 PDF user space、0-based page、双方 SHA-256。`POST /alignment/validate` 是认证后的只读校验，失败只停用映射，既不删除 PDF，也不提交模型任务。
- `addon/content/alignment.js` 保留显式译文→原文定位，并新增右下角独立、默认关闭的段落高亮开关。两侧用各自当前 viewport 命中已验证请求片段，不导航、不切换同步、不改 PDF/canvas/text span/批注/selection；同单元矩形重叠可命中，不同单元歧义不猜配。最小单位是请求片段，不是句词；未渲染的对应页不强行滚动。
- 悬停只注册原生文本项 Range 的 CSS Custom Highlights，命名 `paperbridge-paragraph-hover`、`priority=-1`，浅蓝色经过 Zotero 原生文本层约为 10% 可见透明度。不要修改 textLayer opacity 或新增页级 DOM overlay；显式定位的旧 DOM 高亮另行保留。几何事件在下一 RAF 撤销旧范围，包括没有后续 render 的 pagesdestroy；清理只删除精确匹配的自有 registry entry。缺 API 只禁用该功能，不能阻断普通阅读/批注。
- “打开已有译文”只打开分屏，不是片段跳转；悬停不等于双向导航、句词对齐或批注复制。`paperbridge.js` 的 `split()` 对同一阅读器及原/译附件复用现有状态，初始化中的重复命令共享 `state.ready`；`loadSplit()` 只初始化当前归属，旧异步任务不能关闭替代分屏。不同译文或关闭后仍重新创建。
- `library.js` 保存 `alignmentPath`，新重试不继承旧映射；尝试目录清理保留 sidecar。旧成果无映射仍可读，不为补 sidecar 自动重译，不做双语字面猜配。采集上限或失败仅影响映射、警告后继续保存译文；维护入口和原生套件见 `docs/engine-and-alignment.md`。
- 已有禁网生产成功/缓存/失败模拟（2/2/0 个 verified 单元），并用两篇已授权历史译文的真实段落缓存经生产管线生成 **38 个真实请求单元**（sklearn 第 2 页 16、LIBLINEAR 第 1 页 22，含两份摘要和四个长正文片段）；39 次缓存命中，无新增 provider/HTTP/DNS/socket 请求，八个未选页文本/像素保持。四种包原生验收另含两页、两单元的几何夹具和 12 个可见不合法区域探针。生产 `FragmentTrace` 每侧只输出一个 bounding rectangle；同页分离矩形测试是同身份的 fixture-only 变体，不能声称生产已输出多岛矩形。跨页、移页、合并身份只验证排除，不猜测映射；不是整篇或句词语义验收。
- `backend/deepseek.py` 的 ParagraphCache 每次连接均显式关闭，同时保留事务提交/回滚；单独使用 `with sqlite3.connect()` 不会关闭连接，可能使 Windows 隔离临时数据库无法清理。
- `scripts/verify_providers.py` 默认 inspect，显式 `--run` 每个 ready profile 最多一次短请求，SDK 重试/回退关闭，输出上限 512 tokens。DeepSeek 默认 `deepseek-flash` 的 JSON / thinking-disabled 请求已实测接受；兼容服务仍需独立的 endpoint/model/key。该验证脚本不配置日常 Zotero 凭据；本机日常凭据存储情况见下节。

## Linux 接续验证

- 本机日常 Zotero 为 10.0.8，默认 profile 是 `/home/scq/.zotero/zotero/ylkmnjtn.default`，数据目录为 `/home/scq/Zotero`；其中有“PaperBridge 实测文献（2026-11-13）”分类及 Transformer、BERT、LoRA 三篇真实全文。不要将此环境与项目 `.runtime/*-profile` 的隔离套件混淆，也不要对日常 profile 运行隔离准备脚本。
- 日常 PaperBridge 选择 DeepSeek，Key 保存至 Zotero NSS 加密登录库（`chrome://paperbridge` / `DeepSeek`），不是明文 preferences；项目 runtime 的源 Key 文件及 profile 密钥数据库不得提交。手动离线配置必须先正常退出 Zotero，并备份原凭据库。
- 重复打开译文修复的 8 项隔离原生检查证据为 `.runtime/split-reuse-smoke-20261114-001952/result.json` / `verification.json`；两侧页码/缩放/滚动坐标、宽度及同步模式保持。精简任务窗口另通过 Linux Zotero 10.0.8 自带 Python XPI 的 10 项原生检查，默认/窄窗无横向溢出，证据为 `.runtime/task-ui-native-20261114-010301/result.json`。均未调用 provider；前者用合成三页 PDF，后者用模拟任务状态，不是论文翻译质量验收；两份测试库完整性均为 `ok`。
- 日常 profile 已通过原生更新安装 Linux 自带 Python 0.3.4 并同 profile 真冷重开，XPI hash 为 `077ee68e74bed3fa91e7b0cff0008f904fa141b966c6db795c32c7b1909bf865`，health/marker 与该包一致；用户的设置、NSS 凭据及任务记录保留。库完整性 `ok`，文献、附件归属/正文、批注、标签和引用中元数据保持；**原始库表 hash 并非全不变**，已证明只涉及 Zotero 阅读时间/客户端元数据及一条无引用值清理，原始备份保留。不要强杀日常 Zotero、修改 SQLite 锁或改写库以抹去差异。
- SSH 别名 `nvidia` / `703nvidia` 使用本机专用 `703nvidia` 密钥。远端工程位于 `/home/nvidia/scq/ZoteroPlugin/PaperBridge-zotero-plugin`；Zotero 位于 `~/.local/opt/Zotero_linux-x86_64`，用户启动器 `~/.local/bin/zotero`。不得改变该主机的 ROS2 和其他项目环境。
- `scripts/prepare_packaged_test.py` 使用隔离 profile/data，实际 XPI 验证入口是 `tests/packaged.js`。首轮保存临时 Key，重启后从测试 `.env` 输入真实 Key；正式插件仍从 Zotero 登录管理器读取。不要将真实 Key 或密钥数据库提交到仓库。
- `--suite queue` 使用独立 queue-profile/data，入口 `tests/queue_packaged.js`。已在 Linux Zotero 10.0.8 验证真实设置、凭据隔离、后端启动、批量/任务界面、附件导入与保守删除；模型结果显式模拟，不是付费模型翻译验收。实际 BabelDOC 管线另经禁网合成 PDF 验证成功与响应丢失两条路径。
- 当前 Linux 和 Windows 完整离线基线为 Python `231 passed, 1 skipped`（缺少 `.cache/references/pi0-v3.pdf`），另有 7 个 Node 套件、26 个 JavaScript 语法检查，片段控制器 26 项通过。统一入口 `scripts/check_offline.py` 不调用服务商、不构建大型运行时；已运行远程 CI 的提交及限定范围见本文件开头，不应当作未提交变更的验证。使用项目 Python，清除继承的 Python/原生库路径并设置 `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`，不改系统环境。不要从根目录收集独立测试脚本；`tests/offline_quality_pipeline.py` 用预置 `.cache` 资源运行禁网管线。
- 2026-11-07 Linux 实测通过：真实三页翻译、字体嵌入、未选页保留、双向同步、独立阅读、全文缓存复用、10 项文献生命周期检查、公式/参考文献保护、运行中取消、退出后停止引擎。证据在 `docs/linux-verification-0.3.1.json`，使用说明在 `docs/linux.md`。
- `agent/codex`、`agent/grok`、`agent/dsh` 是忽略的本地过程目录；不要默认读取。`agent/report` 保存任务简报，`agent/task` 只放用户提供的任务文件。

## Windows 接续验证

- `ssh desktop-hz` 已配置独立公钥登录，别名使用专用 IdentityFile 和 `IdentitiesOnly yes`；密码和私钥不在仓库内。Windows 验证使用 `D:\Zotero\zotero.exe`，工程为 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`。原 Windows 草稿已按 `docs/update-0.3.2.md` 合并；远端备份 `.runtime/windows-wip-before-takeover-20261113.zip` 及 stash `1585dab3ddd69ff0d22c8a2a787914b1fc717d85` 不要盲目重套。本地原 Windows 包另保存在 `.runtime/windows-package-before-p1`。
- Linux 当前无可用的非交互 GitHub 推送凭据；可将 Git bundle 交给 Windows 工程的既有 Git Credential Manager 做普通快进推送，不签出、不改其 HEAD/分支/工作文件。不要输出或持久化 token，也不要为此强制重置 Windows 工程。
- 当前 Windows 0.3.4 验收目录为 `E:\PBFinish-1114`，测试源、XPI、profile/data 与日常工程分开，不覆盖原工程的 dist。测试解释器复用原工程 `.runtime\windows-p1-validation-20261114\.venv\Scripts\python.exe`，Node 为同目录 `.tools\node.exe`，不要依赖其他产品的 Python/Node。Windows 既有 Git Credential Manager 可用于普通快进推送，切勿输出或保存 token。
- Windows 日常已通过原生文件安装 0.3.4（原 0.3.1 使用占位 URL），同 profile 冷启动 addon/hash、health/build/父 PID、库完整性与 19 条批注通过；四种通道的自动更新是在单独的 0.3.2 隔离 profile 中验收，不能把日常文件安装说成自动送达。**日常密钥保留未通过，整个收尾尚未完成**：验收误触“保存设置”写变了 PaperBridge 密钥，用户的非秘密设置和六个核心文献/批注表保持，原始加密凭据及库备份仍在；只恢复 PaperBridge 密钥正在等待用户授权，恢复前勿用该 Windows 日常环境提交翻译。另有一条 Zotero API-like realm 凭据变化原因未明，原生账号身份及当前 API-key getter 对应记录保持，不能顺带回滚其他凭据。不要替换 baseline 或抹去原始 false；交接证据在当前 `agent/codex/nonmac-finish-20261114-201038/windows-daily-034/`。日常 app 留运行，引擎此时是正常的未启动延迟状态，不将此前冷启动 health 冒充当前服务。
- OpenSSH 进程在 session 0，Zotero UI 要在已登录的交互 session 启动；Windows 启动器 PID 不一定是 UI PID，取 `Services.appinfo.processID` 并核对隔离 profile。悬停测试 profile 设 `firstRun2=false`，否则欢迎网页可能遮住 Zotero、使原生渲染被节流。退出检查应等待现有 3 秒父进程 watcher，自然终止而非强杀后算通过；清理只涉及自有任务和隔离进程。
- Gecko 文件接口使用 `PathUtils.join`。原生拖选需越过末尾字形以包含标点，PDF.js 会按 NFKD 及其特殊规则规范化选中文字；验收保留实际文本与 PDF 位置，不注入批注。缩放/旋转需分别等待对应页和文本层完成；链接点击需实际焦点与稳定视口，不直接设置目标页冒充点击。
- Windows 引擎含较长的原生依赖路径，过深数据目录可让 Gecko 解包报 `NS_ERROR_FILE_NOT_FOUND`；使用较短的隔离 run ID/数据路径。当前验收没有认证极深路径，也没有修改系统长路径设置。开发 launcher 的 `-I -S` 检查需要依赖实际位于所选 `.venv` 中，不能只依赖 `--system-site-packages` 的全局包。

## 仍需注意

- GitHub 已发布 macOS `v0.4.2`（原生译文批注、公式 LaTeX 与缓存），但发布说明明确其源码待同步，该 tag 中 manifest 仍为 0.3.1。本分支 0.3.4 不含这些专属源码，不要冒充 0.4.2 或用本分支重建包覆盖该 macOS 发布产物；需另行取得对应开发源码再合并。本次非 macOS 发布保持该 tag/资产/通道和仓库 Latest 不变。
- Linux / Win11 自带和本地 Python 0.3.4 包已在 Zotero 10.0.8 实测；Zotero 9、其他 Linux 发行版和 macOS 未重复实机验证。三平台轻量 CI 不替代这些原生/完整引擎验收。
- BabelDOC 0.6.4 的已披露解析安全问题仍未修复；隔离不是安全回移。当前生产映射仅基于固定 0.6.4 自身 adapter；0.7.1 的捕获、保护和字体路线仍有明确迁移障碍，不能将此功能或 public probe 冒充引擎升级完成。
- 固定论文工具为 `scripts/review_quality.py` / `docs/quality-corpus.json`。用户授权的真实 DeepSeek 检查仅翻译 sklearn 第 2 页、LIBLINEAR 第 1 页；4 次 `deepseek-flash` 请求、2,295 输入/1,693 输出 tokens，无 SDK 重试。八个未选页文本及 144-dpi 像素保留；两份账本仍为 partial，6/10 个已应用但未变化条目仍 unknown。证据在 `.runtime/quality-p1-20261114/summary.json`；不能擅自补跑付费探测/全文或把助手抽查当人工验收。
- 代表性论文所选页的可追溯片段、缓存命中定位、批注叠加与真冷重开已原生验收，但历史翻译质量仍 partial，机构名断行、版权符号重构和作者字体层级未修复，全文语义/字体/复制/搜索的人类验收没有完成。两份源 PDF 没有链接批注，不能借空比较声称链接通过；兼容服务还需独立授权的真实验证。裁剪/UserUnit 有合成坐标检查，但无新增 macOS 或裁剪 PDF 原生验收；对齐 sidecar 不保证随 Zotero PDF 同步。
- 原生 PDF 连续几何重构仍须留意 WebRender 稳定性：旋转/缩放应分别等待对应页和文本层就绪，避免同步突发连发。最终四种包正常退出，并不等于全部上游渲染组合均已认证稳定。
- 隔离测试自动退出阶段出现过 Zotero 的事务关闭警告；退出后的 `PRAGMA integrity_check` 为 `ok`，引擎已停止。快速重复文献操作后的退出仍需留意该上游警告。
