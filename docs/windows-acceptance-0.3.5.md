<!-- Handoff checklist for a separate Windows agent; no Windows acceptance is claimed here. -->
# Windows 0.3.5 验收清单

## 范围与前置条件

- 本轮共享源码为 **0.3.5 候选**；Windows 稳定通道仍为 **0.3.4**。本清单不表示 Windows 已验收。
- 固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**，不得顺带迁移引擎。不推进 macOS。
- 分别验收 Windows x64 自带 Python、本地 Python 3.12 两种包。ARM64 不属于本次范围。
- 默认不调用付费服务。可复用已有真实论文、段落缓存；服务检查只验“取消确认不发送”。真实请求另行取得用户明确授权。
- 使用 Windows 项目自己的 `.venv\Scripts\python.exe`，PowerShell 命令，不用 `gh`。保留现有 Clash 配置；不要为构建擅自改系统代理/TUN。

## 1. 构建与包身份

- [ ] 在 Windows 本机运行已有 setup/warmup/stage/build 路线；或明确记录复用哪个 Windows 原生 stage。Linux 重打包不算 Windows 构建/执行验证。
- [ ] manifest、后端 health、pyproject/uv.lock 均为 0.3.5；记录两种最终 XPI SHA-256、大小、展开大小及构建来源。
- [ ] 核对 `notes.js`、`diagnostics.js`、`provider_check.py` 和其余发货源码与当前 checkout 一致；包中没有任务库、PDF、密钥、用户日志或本机路径。
- [ ] 运行 `scripts/check_offline.py`、`verify_release.py` 及包 inventory；未知许可证明确标记，不能用清单生成成功声称法律审计完成。
- [ ] 自带版无需系统 Python/工程目录/联网补模型；本地版仅复用解释器，依赖仍来自 XPI。正常旧包/旧发布资产不覆盖。

## 2. 隔离安装、真实升级与冷重开

- [ ] 新建短路径的隔离 profile/data，确认实际 `ProfD`、Zotero 数据目录和原生进程 PID。不要碰日常库或 NSS。
- [ ] 用原生 AddonManager/“从文件安装”装入包，不能仅复制 XPI 声称升级成功。记录原生插件版本、落盘 XPI hash、engine installed marker、health。
- [ ] 用同一隔离 profile 从 0.3.4 原生文件安装升级到 0.3.5，再正常退出并启动新进程。文件安装与公共自动更新分别报告。
- [ ] 原文/译文附件、批注 key 与内容、任务归属、双配置、两套测试密钥保留；检查旧任务/缓存目录没有被无依据清理。
- [ ] 核对旧段落缓存的实际行/命中；新 full-PDF 身份为 `protected-v5-metadata`，段落身份不变。旧 PDF 保留，不静默重写/误复用。
- [ ] 完全退出后检查 SQLite `PRAGMA integrity_check`、隔离引擎/子进程退出；不外部强杀制造“正常清理”。

## 3. 密钥与配置 UI

- [ ] 两个 profile 独立保存、切换、重开；非空替换保留登录项身份，写入失败保留旧值，有意清空仅清当前 realm。
- [ ] 不读取/重写 Zotero 同步密钥；不清除 logins.json、key4.db、preferences 或插件元数据。
- [ ] 检查正常/窄窗口及 Windows 100%/150% 缩放：表单、折叠高级项、按钮换行、长诊断路径、纵向滚动可用。
- [ ] 保存只保存；本地引擎检查不保存草稿、不调用 provider。更换 Python 路径须先明确保存。
- [ ] 服务检查显示费用/一次短样例说明；取消后零请求、零任务、零密钥写入。若另行授权真实检查，核对仅一次请求、上限 512、SDK retries 0、无 profile 回退；格式通过不等于论文质量/账单正确。
- [ ] zh-TW/ja 下拉接口保留，并明确离线字体和完整支持未交付；本轮不要求补字体或真实多语言请求。

## 4. 启动失败与诊断

- [ ] 在隔离副本注入启动/资源缺失故障，用户看到固定错误码及恢复建议，原文和既有译文仍可打开。
- [ ] 引擎不可启动时仍能从设置导出真实 ZIP；正常状态由后端导出，失败由 Gecko 原生 ZIP 导出。
- [ ] state 目录不可写/非目录时能使用系统 temp fallback；恢复故障后引擎可正常启动。
- [ ] ZIP 仅含 `diagnostics.json`、schema 2；检查版本、匿名任务计数/序号、固定阶段/代码/UTC 时序，无任意路径、raw job ID、正文、密钥、异常文本或原始日志。
- [ ] addon-only 中未确认的后端/Python/BabelDOC 版本为 `unknown`，不是当前包版本的猜测。

## 5. 阅读、定位与笔记

- [ ] 使用真实选区/原生 PDF 文本层；原文点击/拖选松开后“定位译文片段”，反向“定位原文片段”，仅唯一可信映射跳转。
- [ ] 普通点击/拖选不抢页内链接、批注/控件，不取消选区；缺失/歧义映射不猜配、不收费补映射。
- [ ] 页同步开/关、缩放/旋转、分屏重开及独立译文 reader 不回退；几何变化分别等待就绪，避免突发连发。
- [ ] 译文选区存独立 note：正确 parent/library、原选中文字、附件/页码回链、原生引用元数据；HTML 特殊字符安全，保存成功不因打开失败被误报为未保存。
- [ ] 批注汇总 note：只汇总当前译文附件的已保存批注；高亮文字/评论/页码/附件回链和引用保留，不重挂/重复批注，不改 PDF。
- [ ] 连续点击不并发重复写；权限不足或笔记错误只影响该功能。关闭并冷重开后 note、引用和附件链接可正常打开。

## 6. 真实论文与保护区域

- [ ] 仅离线重排授权过的 sklearn 第 2 页、LIBLINEAR 第 1 页；禁外部 HTTP/DNS/provider 调用，记录缓存命中与失败，不偷偷翻其他页。
- [ ] 作者/机构区域保持原语言、粗体/斜体/原始换行；LIBLINEAR 版权保持源矢量 `c⃝` 的可见字形及源文本。比较保护区域文本/像素，不看 CJK 数量假称质量通过。
- [ ] 标题、摘要和正文仍被翻译；八个未选页文本/像素一致。检查中文可见性、原生复制/搜索、页码与阅读顺序。
- [ ] 结构 `complete` 只代表应用/保护账本。人类双语审查未完成时继续报告 `not_accepted`；不要改写历史 partial 记录。
- [ ] 两篇真实论文没有链接批注；另用已知链接 PDF 点击验证，空链接对比不能算链接通过。

## 7. 发布与报告

- [ ] 每种包单独记录通过/失败/未执行项与精确 artifact/hash，不把 mocks、轻量 CI、缓存重放当 Windows 原生验收。
- [ ] 若全部必要 Windows 项通过，再按 `docs/releasing.md` 的候选→公开资产→对应 feed 顺序提交发布；不用仓库 `Latest`，不覆盖 macOS 0.4.2。
- [ ] 失败时暂停新 feed，不降版本清单假装自动回滚；修复后递增版本前滚，旧包仅作为明确人工恢复选择。
- [ ] 新建任务报告并维护 MEMORY 当前基线；本清单中的勾选和 Windows feed 由执行验收的 agent 根据证据更新。

## 可复用入口

`prepare_nonmac_test.py` 支持 `reading`、`alignment`、`upgrade` 的独立 run ID；`reopen` 不复制已装 XPI。真实论文 manifest 由 `prepare_representative_hover.py` 在隔离缓存副本生成。`upgrade --upgrade-xpi` 执行原生文件安装，`update` 才是公开通道自动更新；两者不得互相冒充。不要自行生成 `agent/task` 的用户任务指令文件。
