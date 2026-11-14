<!-- Task outcome, bounded native acceptance, and retained failure evidence. -->
# 段落级双向高亮与 Windows 验收

## 结论

已等待前置聊天“核查 TODO 进度、优先级与路线冲突”结束，再基于 `master / 06eea7c` 实现本功能。Linux 验收完成后，才在 `desktop-hz` 执行 Windows 验收；最终四种包全部通过本次限定检查。未创建分支/worktree、未修改 TODO、未替换日常 Zotero profile、未调用真实模型，也未升级依赖或发布 Release。

## 实现

- 右下角新增独立、默认关闭的“段落高亮”开关，不改变同步模式。开启后，原文或译文的鼠标悬停均映射到同一已验证请求片段，两侧显示浅蓝背景。
- 最小单位为可追溯的翻译请求片段，不拆句词。同单元多个矩形可作为整体命中；不同单元歧义、未应用/受保护或无映射区域不猜配。
- 悬停使用原生文本层的 CSS Custom Highlights，`priority=-1`，可见背景约 10%。不增加页级 DOM overlay，不修改原生 PDF、canvas、text span、opacity、批注或 selection，不导航、不拦截原生事件。原有显式定位仍独立保留。
- 正常 BabelDOC 0.6.4 翻译和段落缓存应用，利用自身 adapter 捕获前后同一 paragraph identity；最终 `restore_regions()` 后验证并原子保存 `alignment.json`。源 hash 绑定原始 `source.pdf`，不是 `repaired.pdf`。采集失败/超限仅警告，不阻断译文保存；旧成果不为补映射自动重译。
- 直接修复 ParagraphCache 的连接生命周期：事务提交/回滚后显式关闭 SQLite 连接，避免 Windows 临时数据库被本次验证工具持有。没有跳过失败测试或忽略文件清理异常。

主要改动为 `addon/content/alignment.js`、`paperbridge.js`，新增 `backend/fragment_trace.py` 并接入 `batching.py` / `engine.py`；另修改 `deepseek.py`、原生准备脚本、相关测试及简要开发文档。所有四种 XPI 的 29 个发货源码文件均逐字节核对，真实安装 XPI 的 SHA-256 与当前包一致。

## 验收

使用 Zotero 10.0.8、同次可信采集的一页/两片段合成夹具，以及独立 profile/data。Windows 使用 `E:\PBHover-1114`，项目自身 Python 和 Node；临时任务在交互 session 1 运行，结束后全部删除。

| 平台 / Python 模式 | 最终 run ID | 原生检查 | Zotero 退出码 | 库完整性 | 最终引擎残留 |
| --- | --- | --- | --- | --- | --- |
| Linux / 自带 | `lc14` | 112 / 112 | 0 | `ok` | 0 |
| Linux / 本地 | `ll6` | 112 / 112 | 0 | `ok` | 0 |
| Windows / 自带 | `wb5` | 112 / 112 | 0 | `ok` | 0 |
| Windows / 本地 | `wl1` | 112 / 112 | 0 | `ok` | 0 |

原生检查包括默认关闭、双向悬停、空白区域清理、与同步开关独立、真实不同缩放及 90°/270° 旋转、批注叠加、真实工具栏与可信鼠标拖选、数据库保存、关闭/独立阅读器重开、复用/销毁及无 sidecar 降级。hover 前后原生 canvas 的身份、尺寸、样式及 PNG 像素不变；原有源/译批注记录不变。新增高亮批注仅属于译文附件。

- Linux 和 Windows 完整离线测试均为 **229 passed / 1 skipped**；跳过项为缺少可选参考文献样本。7 个 Node 套件与 24 项 JS 语法检查通过，片段控制器保留 26 项核心测试。
- 当前真实禁网生产管线：模拟成功生成 **2** 个 verified 单元；缓存应用生成 **2** 个、请求尝试 **0**；模拟响应失败生成 **0** 个。网络尝试与真实模型调用均为 **0**。模拟请求账本中的请求数不冒充真实调用。
- 四种模式的原生合成窗口截图均已检查：无批注正文可见两侧浅蓝高亮，原有黄色批注仍可见。截图使用 Gecko `WindowGlobalParent.drawSnapshot`，不是重建的 PDF/DOM 合成图。
- Windows 引擎由既有父进程 watcher 自然退出，最终观察分别约 **3.03 秒 / 3.62 秒**；验收允许 30 秒有界等待并保留全部 PID 观察，未强杀后再记为通过。

本轮源码 `f852ddc871ae` 已推送至 `master`；[GitHub Offline CI 43548039959](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43548039959) 的 Linux / Windows / macOS 三个 job 及测试步骤均为 success。该轻量 CI 不替代 macOS 原生验收；后续只补充本报告和验收索引，不改变已验收的发货源码。

## 失败及修正，如实保留

- 初次生产采集误排除 `xobj_id=0`，导致候选为 0；已按固定版本真实正文 sentinel 直接修复，重新运行成功/缓存/失败管线，原失败证据未覆盖。
- Linux 早期同步突发旋转/缩放曾产生 WebRender 线程 SIGSEGV；无 painter 的对照也出现异常，不能把这些崩溃全部归为功能绘制故障。最终按原生异步操作分别等待完成，所有最终运行正常退出；未改 GPU、渲染器或上游方法。
- 测试输入早期将 hover 误发为 `buttons=1`，已改为真实未按键鼠标事件。原生选区会把全角 `：` 规范化为 `:`；已核对公开 PDF.js 的 NFKD 行为，仍精确核对完整原生行文本和真实 PDF 位置，没有伪造批注。
- Windows 早期驱动误跟踪启动器 PID，且首次启动欢迎网页遮住 Zotero，造成绘制节流/文本层重绘等待失败。已取实际 UI PID 并核对 profile，仅关闭测试 profile 的首次启动欢迎页，核对真实前台窗口；没有关闭用户其他应用或更改日常设置。
- 复用时真实 blur 合法清理 hover；测试现在只有观察到原生 blur 才允许清理状态，否则仍要求精确的自有 registry/ranges；随后真实鼠标输入必须重新产生双侧高亮。
- Windows 完整离线首轮暴露 SQLite 未显式关闭的 `WinError 32`，已在缓存对象自身修复。`wb4` 已通过 112 项功能检查，但第 1 秒的退出门限错误报告瞬时残留；未改写该失败报告，最终 `wb5` / `wl1` 使用正确的自然退出观察重新通过。

过程及失败证据保留在 `agent/codex/paragraph-hover-20261114-075855`；生产采集证据在 `agent/codex/fragment-trace-20261114-090400/production-final`。早期失败不计入最终通过数量。生产模拟仍出现已知 MuPDF 字体 charstring 警告，不能将本轮结果当作字体/排版质量问题已解决。

## 边界与交付

- 只验收当前结构可追溯的单页请求片段；未做句词、代表性真实论文对齐准确率、跨栏跨页原生验证、语义质量或冷进程重启验收。部分重叠/未验证情况属于静态补充探针，不冒充复杂原生夹具。
- macOS 本轮没有重建或原生验收，未覆盖已有 macOS 0.4.2 Release。缺 API 或 sidecar 仍只停用映射功能，普通阅读和原生批注保持可用。
- README、开发入口和 MEMORY 已维护为当前基线；过程日志只放在报告/忽略的过程目录，未写入 README 或 TODO。
- Linux 没有可用的非交互推送凭据，因此通过 Windows 既有凭据转交 Git bundle 做正常快进推送。GCM 发出凭据保存警告，但实际远端提交及 CI 已核验；未修改凭据配置，也未输出 token。Windows 工程的 HEAD、分支及工作文件前后核对均未改变。
- 包位于 `dist/`：Linux / Windows 自带和本地 Python 四个 `paperbridge-0.3.2-*.xpi`。完整 hash、安装核验、截图索引和范围见 `docs/paragraph-hover-verification-2026-11-14.json`。本轮只是更新安装包草稿，不发布非空更新清单；需要手动安装当前平台包，默认不开启高亮。
