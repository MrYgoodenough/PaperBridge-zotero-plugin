<!-- Current shared baseline, safe development entry points and unresolved product boundaries. -->
# 当前开发基线

- 主分支 `master`，共享源码及已公开 Linux/Windows 版本 **0.3.7**；`v0.3.7` 固定生产提交 `3f85caf61303245b880803eceeb977f4124630ec`。版本同步 addon manifest、server VERSION、pyproject 和 uv.lock。四条稳定通道绑定最终 freeze07 四包及下述 v16 引擎/v5 提示；旧 freeze05/v14 与 freeze06/v15 四包不能代表当前源码验收。后续 feed/记忆/报告提交不改变冻结生产身份。
- 固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**，默认 `deepseek-flash`。不顺带升级引擎。独立 macOS **0.4.2** 专属源码未取得：不合流、逆向提取、重建覆盖或推进其发布；共享代码继续跨平台。
- 常规验证入口：本项目 `.venv/bin/python -B scripts/check_offline.py --mode full`，清理继承的 `PYTHONPATH/PYTHONHOME/LD_*`；不要改系统 Python/ROS2。Windows 用项目实际有效的环境，不借用其他产品的 Python。

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
- `package_sources.py` 从已提交快照绑定四包全部生产文件（含 CSS），同行提供 303 上游归档和 4 个 Linux build inputs。缓存 `agent/codex/licensing-p0-1-20261116-003659/source-cache` 保留；源码 ZIP、manifest、checksum 同地公开，不用无范围 written offer。法律合规仍 unknown，不将普通编译元数据不确定性当作已发现缺失义务。
- 用户已确认 Community 2026 的合法使用和 section 8 分发责任，不重复索取。三 DLL/原始条款保持原字节；Windows 初次引擎启用只确认 `msvc-community-2026-v1` 一次，拒绝只停引擎，设置可重开；后台/诊断不弹窗，Linux 豁免。
- Linux/Windows 独立平台/模式 feeds，0.3.7 的四个 XPI、inventory、checksum 及 corresponding sources 共 15 个资产已公开并通过匿名可达/摘要核对；包位于 `dist/release-0.3.7-freeze07/`。Release 用 `make_latest=false`，仓库 Latest 仍为独立 macOS 0.4.2，不改其资产/通道。Git 操作在 master 快进，不建分支/worktree，不强推；API 不用 gh。公开元数据验证不等于 Zotero 从旧版本自动升级实测。

## 安全接续与证据

- 日常 Linux Zotero `/home/scq/.local/opt/zotero/zotero`，profile `/home/scq/.zotero/zotero/ylkmnjtn.default`，data `/home/scq/Zotero`。不要与项目内隔离测试混淆，正常停机备份后才升级；不强杀、不改锁/SQLite/NSS制造通过。
- Windows SSH `desktop-hz`，Zotero `D:\Zotero\zotero.exe`，原工程 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`。有效 Python `.runtime\windows-p1-validation-20261114\.venv\Scripts\python.exe`。不改原工程工作文件/HEAD/stash及原备份；原生 UI 用登录 Interactive Session，不用 SSH Session 0。
- Windows 日常 profile `C:\Users\LostPatrol_2\AppData\Roaming\Zotero\Zotero\Profiles\dljrawap.default`、data `E:\0syncthing\Zotero` 未获日常升级/同步授权。Linux 日常 metadata-only 同步已成功，但 Windows 接收/文件/多译本/group 云验收仍未完成；不全库上传。
- 日常 Linux 已存在的 metadata helper 读 `agent/codex/account-metadata-v10-20261117-005536/native-helper/account-linux-v9-metac-options.json`，其 report 已存在，禁止重放。该目录保留一致停机备份及安全接续证据，不删；实际账号同步只用官方 Runner，`getAPIKey()` 可能写 OSKeyStore，不当纯读取或导出 NSS。
- 新版本真实测试/财务/原生和清理证据集中在 `agent/codex/real-release-20261117`。两批 **20 篇 / 306 页**最终 v16 均 terminal done，结构应用结果 **2 complete / 18 partial**，不是全文语义通过；2411 个真实请求的账本已闭合，未知用量为 0，费用仍是官方费率估算而非账户 invoice。本次授权不延伸到任务完成后的新付费探测。原始输入、已收费/失败成果、ledger、字体/段落 cache 和 source archives 保留；隔离 engine 可重建，但不可按临时文件猜删其余数据。
- freeze07 的 Linux/Windows bundled/local 原生 create/reopen 验收均完成；Windows 最终证据为 `continuation/windows-final06-receipts/`。完整选区通过实际 PDF.js controlled Range、原生按钮及官方 serializer/Annotation API 保存，不冒称物理鼠标拖选/高亮已测；真实旧版到新版自动升级和 Windows 日常跨设备接收仍未完成。
- 仍有限制：provider 可能返回缺标记/合并片段，保留 partial/unknown；未读段落不冒充语义接受。繁体/日文、完整术语规则、精确双向批注、真实跨设备文件同步尚未完整交付。维护指南见 `docs/`；根 TODO 不自行改，task 文件只由用户提供，过程放 agent/codex，每次新简报放 agent/report。
