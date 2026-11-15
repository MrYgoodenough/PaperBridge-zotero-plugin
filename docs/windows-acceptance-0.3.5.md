<!-- Handoff checklist for a separate Windows agent; no Windows acceptance is claimed here. -->
# Windows 0.3.5 验收清单

## 范围与前置条件

- 本轮共享源码为 **0.3.5 候选**；Windows 稳定通道仍为 **0.3.4**。本清单不表示 Windows 已验收。
- 新 note 的 key 由 `saveTx()` 原生分配，避免提前标记身份导致 `primaryData` 未加载；接收明确的修复后源码提交/快照再原生重建。Linux 验收与构建 CI 只证明其注明范围，不能代替本清单的 Windows 原生结果。
- 固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**，不得顺带迁移引擎。不推进 macOS。
- 分别验收 Windows x64 自带 Python、本地 Python 3.12 两种包。ARM64 不属于本次范围。
- 默认不调用付费服务。可复用已有真实论文、段落缓存；服务检查只验“取消确认不发送”。真实请求另行取得用户明确授权。
- 使用 Windows 项目自己的 `.venv\Scripts\python.exe`，PowerShell 命令，不用 `gh`。保留现有 Clash 配置；不要为构建擅自改系统代理/TUN。
- **第 1–6 节的必要项须对两种包分别执行并记录**；缺资源、失败或未执行均如实标记，不共用另一种包的通过结果。新装与旧版升级使用各自短路径隔离 profile/data，准备前保留停机备份；不用日常 Zotero 作测试对象。

## 1. 构建与包身份

- [ ] 在 Windows 本机运行已有 setup/warmup/stage/build 路线；或明确记录复用哪个 Windows 原生 stage。Linux 重打包不算 Windows 构建/执行验证。
- [ ] manifest、后端版本、pyproject/uv.lock 均为 0.3.5；安装后再核对真实 health。分别用 `Get-FileHash -Algorithm SHA256 -LiteralPath <最终XPI路径>` 记录完整 64 位 hash、大小、展开大小、源码提交/快照及 Windows 原生 stage 来源；同名重建包必须重新计算。
- [ ] 核对 `notes.js`、`diagnostics.js`、`provider_check.py` 和其余发货源码与当前 checkout 一致；包中没有任务库、PDF、密钥、用户日志或本机路径。
- [ ] 运行 `scripts/check_offline.py`、`verify_release.py` 及包 inventory；未知许可证明确标记，不能用清单生成成功声称法律审计完成。
- [ ] 自带版无需系统 Python/工程目录/联网补模型；本地版仅复用解释器，依赖仍来自 XPI。正常旧包/旧发布资产不覆盖。

## 2. 隔离安装、真实升级与冷重开

- [ ] 新建短路径的隔离 profile/data，确认实际 `ProfD`、Zotero 数据目录和原生进程 PID。不要碰日常库或 NSS。
- [ ] 两种包各完成原生 AddonManager/“从文件安装”新装，不能仅复制 XPI 声称安装成功。记录原生插件版本/启用状态、落盘 XPI hash、engine installed marker、health 的版本/build ID/模式及实际解释器路径，并与该候选包一致。
- [ ] 两种模式各先原生安装已验收的对应 0.3.4 包，建立原文/译文、批注、任务、缓存和两套虚拟测试密钥基线；正常退出备份后，在同一隔离 profile/data 原生文件安装升级到对应 0.3.5。不得重建数据库或清空任务/cache/preferences/NSS。文件安装与公共自动更新分别报告，本清单不自动授权发布或通道更新。
- [ ] 新装后和升级后均经 Zotero 正常退出，等待原生宿主、隔离引擎及其子进程实际消失，再启动同一 profile/data 的新进程。记录退出前后的真实 UI PID（`Services.appinfo.processID`，不是启动器 PID）、`ProfD`/数据目录及新 health/marker；关窗、插件 reload 或复用旧进程不算冷重开。
- [ ] 比较停机基线与升级/冷重开后的原数据库：文献、原文/译文附件、既有 note、批注 key/内容、任务归属、双配置和两套测试密钥保留；旧任务/缓存目录没有被无依据清理。允许 Zotero 正常阅读元数据变化，但须解释差异，不把整库字节一致作为判据。
- [ ] 核对旧段落缓存的实际行/命中；新 full-PDF 身份为 `protected-v5-metadata`，段落身份不变。旧 PDF 保留，不静默重写/误复用。
- [ ] 首次运行与冷重开复查后均正常退出；确认停机数据库 `PRAGMA integrity_check` 为 `ok`，本次隔离 Zotero/引擎/子进程无残留，保留退出警告/失败。不外部强杀制造“正常清理”，不清理其他进程。

## 3. 密钥与配置 UI

- [ ] 两个服务 profile 用虚拟测试密钥独立保存、切换和冷重开；非空替换通过原生 `modifyLogin` 原子更新，保留登录项身份且不先删除旧项。在隔离环境令写入失败，核对旧值/身份仍在；有意清空仅清当前 realm，另一套不变。仅记录相等/不等与结果，不输出密钥。
- [ ] 不读取/重写 Zotero 同步密钥；不清除 logins.json、key4.db、preferences 或插件元数据。
- [ ] 检查正常/窄窗口及 Windows 100%/150% 缩放：表单、折叠高级项、按钮换行、长诊断路径、纵向滚动可用。
- [ ] 保存只保存；本地引擎检查不保存草稿、不调用 provider。更换 Python 路径须先明确保存。
- [ ] 服务检查显示费用/一次短样例说明；取消后零请求、零任务、零密钥写入。若另行授权真实检查，核对仅一次请求、上限 512、SDK retries 0、无 profile 回退；格式通过不等于论文质量/账单正确。
- [ ] zh-TW/ja 下拉接口保留，并明确离线字体和完整支持未交付；本轮不要求补字体或真实多语言请求。

## 4. 启动失败与诊断

- [ ] 在隔离副本注入启动/资源缺失故障，用户看到固定错误码及恢复建议，原文和既有译文仍可打开。
- [ ] 引擎不可启动时仍能从设置导出真实 ZIP；正常状态由后端导出，失败由 Gecko 原生 ZIP 导出。
- [ ] 仅在隔离副本令 state 目录不可写/非目录，实际导出并打开系统 temp fallback ZIP，核对用户可见路径与文件内容；恢复目录/资源故障后引擎可正常启动。不修改日常目录权限。
- [ ] ZIP 仅含 `diagnostics.json`、schema 2；检查版本、匿名任务计数/序号、固定阶段/代码/UTC 时序，无任意路径、raw job ID、正文、密钥、异常文本或原始日志。
- [ ] addon-only 中未确认的后端/Python/BabelDOC 版本为 `unknown`，不是当前包版本的猜测。

## 5. 阅读、定位与笔记

- [ ] 在真实译文原生 reader 中鼠标拖选并复制实际中文/连字符文本，再用 reader 搜索实际词（如“机器学习”），记录页码、复制文本及可见命中；不能用 DOM 文本、后端提取或直接设置选区冒充操作。
- [ ] 原文点击/真实拖选松开后执行“定位译文片段”，译文侧反向执行“定位原文片段”，分别核对目标附件、页码及可见可信片段。仅唯一可信映射跳转；悬停、页同步或脚本直接设页不算显式定位通过。
- [ ] 普通点击/拖选不抢页内链接、批注/控件，不取消选区；缺失/歧义映射不猜配、不收费补映射。
- [ ] 页同步开/关、缩放/旋转、分屏重开及独立译文 reader 不回退；几何变化分别等待就绪，避免突发连发。
- [ ] 用真实译文选区执行“选区存笔记”，在 Zotero 条目树/原生 note 编辑器确认实际新建的独立 `note` 条目及持久化 item key（不是 PDF 批注或仅生成 HTML）。核对正确 parent/library、原选中文字、原生引用元数据；实际点击附件/页码回链到译文选区所在页。HTML 特殊字符安全，保存成功不因打开失败被误报为未保存。
- [ ] 在原生 reader 创建并保存高亮和评论，再执行“批注汇总笔记”；在原生 note 编辑器确认另一个独立 note，只含当前译文附件的已保存批注。核对高亮文字/评论/页码/引用并实际点击回链；不重挂/重复批注，不改 PDF，不冒充双向批注同步。
- [ ] 连续点击不并发重复写；权限不足或笔记错误只影响该功能。真正进程冷重开后，复核两类 note 的 item key、内容、引用和回链仍可打开；出现 `primaryData` 未加载/保存失败必须记录失败，不能用 mocks 或旧 note 代替新建通过。

## 6. 真实论文与保护区域

- [ ] 仅离线重排授权过的 sklearn 第 2 页、LIBLINEAR 第 1 页；禁外部 HTTP/DNS/provider 调用，记录缓存命中与失败，不偷偷翻其他页。
- [ ] 作者/机构区域保持原语言、粗体/斜体/原始换行；LIBLINEAR 版权保持源矢量 `c⃝` 的可见字形及源文本。比较保护区域文本/像素，不看 CJK 数量假称质量通过。
- [ ] 标题、摘要和正文仍被翻译；八个未选页文本/像素一致。检查中文可见性、原生复制/搜索、页码与阅读顺序。
- [ ] 结构 `complete` 只代表应用/保护账本。人类双语审查未完成时继续报告 `not_accepted`；不要改写历史 partial 记录。
- [ ] 两篇真实论文没有链接批注；另用已知链接 PDF 点击验证，空链接对比不能算链接通过。

## 7. 发布与报告

- [ ] 每种包单独记录通过/失败/未执行项与精确 artifact/hash，不把 mocks、轻量 CI、缓存重放当 Windows 原生验收。
- [ ] 交付记录填写下表的真实 XPI 路径、完整 hash 和证据位置；源 XPI、校验文件、inventory/verification、实际落盘 XPI 的 hash 一致。任何必要项未执行/失败时，该模式仍为未验收；重建后不沿用旧 hash 或原生通过结论。
- [ ] **公开分发任何新候选前**先核查实际包中 CPython、原生依赖、模型/tokenizer 的来源与许可证据，补必要 NOTICE；unknown 如实记录并交用户决定，不用 inventory 成功代替许可结论。必要 Windows 项通过且用户明确授权发布后，再按 `docs/releasing.md` 的小范围候选→公开资产→对应 feed 顺序操作；不用仓库 `Latest`，不覆盖 macOS 0.4.2。
- [ ] 失败时暂停新 feed，不降版本清单假装自动回滚；修复后递增版本前滚，旧包仅作为明确人工恢复选择。
- [ ] 新建任务报告并维护 MEMORY 当前基线；本清单中的勾选和 Windows feed 由执行验收的 agent 根据证据更新。

| 模式 | 待验收文件（填写实际绝对路径） | 最终 XPI SHA-256 / 证据位置 | 当前状态 |
| --- | --- | --- | --- |
| 自带 Python | `paperbridge-0.3.5-windows-x64.xpi` | 待 Windows agent 计算/记录 | 未执行，未验收 |
| 本地 Python | `paperbridge-0.3.5-windows-x64-local-python.xpi` | 待 Windows agent 计算/记录 | 未执行，未验收 |

## 可复用入口

构建按 [Windows 开发与构建](windows.md#在-windows-上开发与构建)：`scripts\setup.ps1` 含 warmup，再由项目 Python 执行 `scripts\stage_runtime.py`、`scripts\build.py` 与 `scripts\build.py --python local`。以当前 manifest 的 0.3.5 文件名为准，不沿用该说明中的历史版本文件名；`scripts\verify_release.py` 的输入见 [发布检查](releasing.md#inspect-a-completed-artifact)。

`scripts\prepare_nonmac_test.py` 支持 `reading`、`alignment`、`upgrade` 的独立 run ID；`reopen` 不复制已装 XPI。其 `create` 复制扩展只是准备环境，不证明原生安装通过；`upgrade --upgrade-xpi` 才执行原生文件安装，`update` 是公开通道自动更新，两者不得互相冒充。真实论文 manifest 由 `scripts\prepare_representative_hover.py` 在隔离缓存副本生成；资源不足报告未执行，不增加付费请求。不要自行生成 `agent/task` 的用户任务指令文件。
