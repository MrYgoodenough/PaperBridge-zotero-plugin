<!-- Current baseline, maintenance entry points, and unresolved compatibility limits. -->
# 当前开发基线

- 共享源码与本机 Linux 候选为 PaperBridge **0.3.5**，主分支 `master`；Linux/Windows 四条稳定公开通道仍为 **0.3.4**，不因源码更新自动覆盖。0.3.5 新增启动失败诊断、显式服务检查、双向可信片段定位、独立笔记回写和书目/字体修复。固定 BabelDOC 0.6.4 / PyMuPDF 1.26.7，默认 `deepseek-flash`。版本须同步 addon manifest、`backend/server.py VERSION`、pyproject 与 uv.lock；`tests/test_bridge.py` 核对契约。
- 本机两种重建 Linux 0.3.5 候选在 Ubuntu 24.04.4 / Zotero 10.0.8 各完成 476 项限定原生检查：双向定位/独立 note 新建与真进程重开、真实缓存论文阅读、0.3.4 原生文件升级、复制/搜索、密钥替换身份与诊断回退；六套隔离库停机 integrity `ok`，无自有进程残留。精确 XPI hash 和范围见 `docs/linux-verification-0.3.5.json`。这是本机原生 stage 重打包，不是 Windows 验收或新公开自动投递；旧同名候选的通过不能沿用。
- 改动生产 addon/backend 后必须重建各平台 XPI；同名旧包不会跟随源码更新。四种 0.3.4 包均核对 29 个发货源码文件及最终 XPI SHA-256，在 Ubuntu 24.04 / Win11 + Zotero 10.0.8 各通过 290 项代表性片段读取、304 项同 profile 真冷重开、112 项悬停/批注/降级检查；正常退出、库完整性 `ok`、无隔离引擎残留。Windows 在 `desktop-hz` 使用历史原生 stage 重打包后实机验证，不是交叉编译。当前包与限定范围见 `docs/nonmac-verification-2026-11-15.json`；macOS 未重建。
- GitHub `v0.3.4` 有四种已验收 XPI 与四份校验文件。根目录 `updates/` 四条 Linux/Windows 独立通道已发布 0.3.4，精确公开 URL、内容/版本/资产 hash 均实测一致；先发布资产再启用清单，不使用查询串绕缓存。四种包均实际完成 `AddonManager.findUpdates` → 公共下载/安装 → 同 profile 真冷重开（0.3.2→0.3.4，18+14 项），并核对当前 health/installed marker 版本和 build ID。`0.3.3` 历史公开资产保留但曾发现后端公开版本不一致，当前使用修复后的 0.3.4。不要把仓库级 `releases/latest` 当作平台回退：Latest 仍为独立 macOS 0.4.2，其 tag/资产/通道未改动；`example.invalid` 的旧安装仍需原生手动安装一次。
- 日常安装必须保留停机 profile/库备份，并使用 Zotero 原生文件安装或更新安装器；只复制 XPI 不证明 AddonManager 实际加载版本。引擎 build ID 来源于 payload/后端，不证明 addon 脚本字节；务必核对落盘 XPI hash、原生插件版本和延迟 health/marker，再正常退出和同 profile 真冷重开。不得清除插件元数据、preferences 或 NSS 凭据来制造成功。
- `.github/workflows/ci.yml` 是 Linux/Windows/macOS 轻量矩阵，Python 3.12 / Node 22，只安装 pytest、PyMuPDF、httpx，运行 `scripts/check_offline.py --mode lightweight`。GitHub run `43656077025` 核验 0.3.5 发货源码基线 `5e8e471`：三平台全部必要步骤 success。默认 `full` 另检查已安装引擎依赖，本机及 Linux 构建 CI 为 243 passed / 1 optional-reference skip、22 Node 套件和 32 JS 语法检查通过。轻量 CI 不构建大型 runtime，也不等于 macOS 原生验收；setup-uv 使用 `v10.3.3` 完整 tag。
- 运行时按 `macos-arm64`、`windows-x64`、`linux-x64` 独立构建。Linux amd64 自带 CPython 3.12，解释器路径 `python/bin/python3.12`；当前 Linux 包的原生库要求 glibc ≥ 2.34。Ubuntu 24.04 + Zotero 10.0.8 已实测，其他发行版尚未实机验证。
- Linux 使用官方 OpenCV headless wheel，需保留各 wheel 的 `.libs`；仅 macOS 需要自编译精简 OpenCV。打包用 uv 管理的独立解释器，不用系统 Python 作为可重定位运行时。
- Linux 中文字体通过 fontconfig 查询已安装的思源宋体等中文衬线字体，选择简体中文字面并导出到插件缓存；CFF 字面以 `.ttf` 缓存名保存，但 PDF 中实际为嵌入的 OTF。系统字体不随 XPI 分发。
- 项目及插件启动的 Linux Python 清除继承的 Python 和原生库路径；不修改父环境、系统 Python、ROS2 或 shell 配置。开发环境、模型、测试状态位于项目自己的 `.tools`、`.venv`、`.cache`、`.runtime`。
- 正式译文是 Zotero PDF 附件；插件不再因论文进回收站或原文缺失永久删除译文。Zotero 自身的删除行为不变。可恢复成果、任务和共享归属都保留，只有已确认无归属的临时缓存可清理；损坏索引禁用清理。
- 未完成目标以 GitHub [TODO #1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/issues/1) 的独立细项及验证范围为准。PDF 笔记批注不是独立笔记，悬停不是显式导航，本地 Python 包不是本地翻译模型；实现、原生验收与公开投递分别判定。
- 开发政策固定 BabelDOC 0.6.4：新版迁移为低优先级，不列为 TODO 或优先事项，直接维护当前版本功能。macOS 专属源码暂不可得，不推进其合流/验收；本轮 Windows 原生验收交由用户后续的 Windows agent，保留共享实现兼容性。术语表/自定义规则只做技术路线研究；繁体/日文只保留语言接口，暂不实现完整支持。
- 候选真实构建入口为 `.github/workflows/release-candidate.yml`，仅手动、默认 Linux；Windows 另选，无 macOS。run `43656079515` 在 `5e8e471` 实际完成 Linux 原生 fresh stage、禁网 imports/model/tokenizer 和两种 XPI 构建；下载核对 artifact SHA、外层/内层 CRC、模型 hash、30 原始源码及生成 manifest，独立 `verify_release` 通过。其 XPI hash 与本机原生验收包不同，不沿用 Zotero 验收。inventory 大小只告警，CPython/模型/tokenizer 许可来源证据仍 unknown。公开 feed 必须晚于精确资产；暂停 feed 不能降级已装用户，修复使用递增版本前滚。
- Linux 0.3.4 自带包为 272.88 MiB、Windows 为 189.70 MiB；差额主要是依赖 58.30 MiB 和解释器 24.76 MiB，模型/词表相同。`docs/linux-package-size.md` 仅研究：保留资源的 ZIP 候选节省 16.59–18.75 MiB；内层 XZ/别名/模型压缩预算约 201.07 MiB，安装器未实现。CPython 一刀切 strip 实测失败，不采用；不要删除必要资源或联网补齐冒充瘦身。

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
- `preserve.metadata_regions()` 在无裁剪/旋转的开篇页，需 explicit abstract + 配对粗体姓名/邮箱 + 斜体机构，才保留作者/机构原语言及源矢量；页脚仅识别带年份版权。歧义不保护，标题/摘要/正文仍翻译。`fonts.py` 在本地字体副本删除同 glyph 的 CJK 兼容/空白/连字符别名，修复“机器”复制为“机器”及 soft hyphen 搜索失败；不改系统字体，Windows 替换前关闭句柄。full-PDF 身份为 `protected-v5-metadata` / `songti-sc-v2-unicode`；段落缓存身份不变，旧 PDF 保留不静默重写。
- `notes.js` 用官方 serializer 和一次 `note.saveTx()` 建独立 note；**新 Item 不提前设置 key**，由原生保存分配，否则 `setNote()` 会要求尚未加载的 primaryData。失败只报告实际 key，分配前为 null，不自动重试。绑定正确 library/parent、译文附件/物理页回链和原生引用，源链接不猜语义页；实际单页选区/已保存批注只读、in-flight 去重，保存与打开失败分开，不改 PDF/批注、不收费。Linux 原生高亮的 NFKC 文本和 `Annotations.toJSON()` 位置契约已核对；group/根 note/图像 UI 等扩展仍未原生认证。入口见 `docs/notes.md`。
- `addon/content/annotations.js` 使用 Zotero 原生附件批注 API，独立于不可取得的 macOS 0.4.2 源码。批注只属于译文附件；写入串行化、关闭先快照并等待持久化、重开等待旧写入；权限变化才调用原生 `setReadOnly`，已销毁 iframe 不再接收保存回调。不可写时只降级批注，不阻断 PDF 阅读，不做原译双向批注复制或完整标签/QuickCopy/公式功能。维护入口见 `docs/annotations.md`。

## 引擎、片段映射与悬停高亮

- `scripts/probe_engine.py` 在独立环境研究发布 wheel，不是生产采集入口。0.7.1 正式 wheel 的 `stage_capture_enabled=False`；官方字体下公开管线成功，但旧保护适配与 `PageProjection` 不兼容，系统宋体 hash/profile 也被 Rust 拒绝。生产依赖没有升级，不维护自定义 Rust 分支。
- 正常 0.6.4 翻译及段落缓存应用由 `backend/fragment_trace.py`、`batching.py` 的自身 adapter 和 `engine.py` 最终保存钩子生成 sidecar。仅保留真实 quality `applied`、同一 paragraph identity 的单页请求片段；受保护、未应用、移页/合并、无法可靠追踪的对象不映射。固定版本的普通页文本 `xobj_id=0` 不能误当 form XObject 排除。源 hash 绑定原始 `source.pdf`，目标绑定 `restore_regions()` 后的最终译文；不保存捕获全文，不增加请求或改变缓存身份。
- `backend/alignment.py` 只接受已应用、同单元捕获的候选，并核对两份实际 PDF 的可见字面文本/几何。比较 NFKC 后的非空白字形，仅 U+2010/U+2011 与 `-` 等价；大小写、数学负号/长破折号、缺字和 NUL 可见性断点保持严格，不做双语语义猜配。Schema 1 使用 PDF user space、0-based page、双方 SHA-256。`POST /alignment/validate` 是认证后的只读校验，失败只停用映射，既不删除 PDF，也不提交模型任务。
- `addon/content/alignment.js` 原文/译文各记录点击或拖选松开位置；“定位译文片段 / 定位原文片段”才显式双向导航，普通交互不抢链接、批注或选区。默认关闭的独立悬停仍不导航、不改同步或 PDF/原生选区。最小单位是唯一可信请求片段，不是句词；歧义/缺映射不猜配、不重译。
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
- Windows 日常 0.3.4 已完成原生文件安装及同 profile 冷验收：addon/XPI、health/build/父 PID、库完整性、六个核心表和 19 条批注保持。此前误触“保存设置”确实写变 PaperBridge 密钥；已按用户授权用原生 `modifyLogin` 只恢复这一条密码，真实冷重开后的默认/显式 getter 与原始值一致，其他实际密钥、账号和插件设置保持。原始加密/库备份和失败 false 永久保留，新限定验收见 `docs/nonmac-verification-2026-11-15.json` 及 `agent/codex/nonmac-finish-20261114-201038/windows-daily-034/repair-20261115-0324/`。不得把修复说成从未发生误保存，也未验证服务商端密钥有效性。四种自动更新仍是单独 0.3.2 profile 的验收，日常文件安装不能说成自动送达。
- Zotero 10.0.8 的 `chrome://zotero` / `Zotero Web API (encrypted)` 存的是额外 OSKeyStore 加密的同步密钥镜像；`getAPIKey()` 优先旧 realm `Zotero Web API`，并可能重新加密/写镜像，**不是纯只读 getter**。比较真实值须在 native NSS 解密后再用 `Zotero.OSKeyStore.decrypt()` 解这一明确 realm，勿将密文变化当密钥丢失，也勿回滚整个凭据库。原生核对已确认原始与当前镜像解得同一实际 key；凭据文件/GUID/全表字节仍不完全相同。
- OpenSSH 进程在 session 0，Zotero UI 要在已登录的交互 session 启动；Windows 启动器 PID 不一定是 UI PID，取 `Services.appinfo.processID` 并核对实际 profile。悬停测试 profile 设 `firstRun2=false`，否则欢迎网页可能遮住 Zotero、使原生渲染被节流。正常 UI 退出会由 addon 的 `runtime.stop()` 调用已有 `Subprocess.kill()/wait()` 结束自有引擎，Windows 原始退出码 127 符合 Gecko 契约（JS wait 归一化为 -9），不是 watcher 自然退出 0；3 秒父进程 watcher 是失联兜底。等待原生/引擎及子进程实际消失再查停机 SQLite，不用外部强杀制造通过；只清理自有任务。
- Gecko 文件接口使用 `PathUtils.join`。原生拖选需越过末尾字形以包含标点，PDF.js 会按 NFKD 及其特殊规则规范化选中文字；验收保留实际文本与 PDF 位置，不注入批注。缩放/旋转需分别等待对应页和文本层完成；链接点击需实际焦点与稳定视口，不直接设置目标页冒充点击。
- Windows 引擎含较长的原生依赖路径，过深数据目录可让 Gecko 解包报 `NS_ERROR_FILE_NOT_FOUND`；使用较短的隔离 run ID/数据路径。当前验收没有认证极深路径，也没有修改系统长路径设置。开发 launcher 的 `-I -S` 检查需要依赖实际位于所选 `.venv` 中，不能只依赖 `--system-site-packages` 的全局包。

## 仍需注意

- GitHub 已发布 macOS `v0.4.2`（原生译文批注、公式 LaTeX 与缓存），但发布说明明确其源码待同步，该 tag 中 manifest 仍为 0.3.1。共享 0.3.5 不含这些专属源码，不要冒充 0.4.2 或重建覆盖该 macOS 产物；对应源码取得后才有合流条件，当前不推进。非 macOS 工作保持其 tag/资产/通道和仓库 Latest 不变。
- Linux / Win11 自带和本地 Python 0.3.4 包已在 Zotero 10.0.8 实测；Zotero 9、其他 Linux 发行版和 macOS 未重复实机验证。三平台轻量 CI 不替代这些原生/完整引擎验收。
- BabelDOC 0.6.4 的历史“已披露解析安全问题”主张缺具体公告或本插件可利用路径依据，不能臆测 CVE 或声称新版已修复。隔离不是 OS 沙箱；只处理可信 PDF。既有新版 probe 属历史低优先级研究，不是当前 TODO，不能以迁移替代维护 0.6.4 的现有功能。
- `saveKey()` 非空更新使用原生 `modifyLogin(old, old.clone())`，失败保留旧值；有意清空仅删当前 realm。两条 production 排版/tokenizer 消息现归 resource。诊断 schema 2 仅匿名计数、UTC/固定阶段/错误码；job JSON 保留最多 64 次状态变化，startup 最多 32 次，无 raw logs。后端不可用用 Gecko ZIP，state 不可写可落系统 temp；后端/Python版本未确认为 unknown。设置保存与两种检查独立；`POST /providers/check` 须 confirmed，公开短样例、512 输出上限、30 秒、SDK retries 0，不保存草稿/任务/缓存、不回退服务。
- 繁体/日文已有 UI 和请求配置，但对应离线字体及区域字形未完成交付验收。中文字体路线偏向 SC 字面，日文依赖上游资源解析且运行期禁止补下载；不能将下拉框存在视为多语言离线能力完整。
- 固定论文工具为 `scripts/review_quality.py` / `docs/quality-corpus.json`。用户授权的真实 DeepSeek 检查仅翻译 sklearn 第 2 页、LIBLINEAR 第 1 页；4 次 `deepseek-flash` 请求、2,295 输入/1,693 输出 tokens，无 SDK 重试。八个未选页文本及 144-dpi 像素保留；两份账本仍为 partial，6/10 个已应用但未变化条目仍 unknown。证据在 `.runtime/quality-p1-20261114/summary.json`；不能擅自补跑付费探测/全文或把助手抽查当人工验收。
- 0.3.5 对 sklearn 第 2 页和 LIBLINEAR 第 1 页用旧缓存重排，19 命中/0 miss，0 provider/HTTP/DNS，历史输入未改。作者/机构/版权文本、字体样式与 144-dpi 像素一致，八个未选页保持；新结构账本 complete 不是人类语义接受，旧 partial 报告不改写。`docs/quality-verification-0.3.5.json` 固定 locators 和非人类抽查；更广公式/图表、全文双语审查仍未完成。两篇无链接批注，空比较不算点击通过；真实兼容服务须独立授权。裁剪/UserUnit 无新增原生验收，sidecar 不保证随 Zotero PDF 同步。
- 原生 PDF 连续几何重构仍须留意 WebRender 稳定性：旋转/缩放应分别等待对应页和文本层就绪，避免同步突发连发。最终四种包正常退出，并不等于全部上游渲染组合均已认证稳定。
- 隔离测试自动退出阶段出现过 Zotero 的事务关闭警告；退出后的 `PRAGMA integrity_check` 为 `ok`，引擎已停止。快速重复文献操作后的退出仍需留意该上游警告。
