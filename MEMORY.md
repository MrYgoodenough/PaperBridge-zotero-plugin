<!-- Current source baseline, safe continuation entry points, and unresolved product limits. -->
# 当前开发基线

- 主分支 `master`；共享源码 **0.3.6 候选**。版本同步 addon manifest、`backend/server.py VERSION`、pyproject 和 uv.lock。Linux/Windows 四条稳定公开通道及资产仍为 **0.3.4**；源码推送不代表新 XPI 发布或通道启用。
- BabelDOC 固定 **0.6.4** / PyMuPDF **1.26.7**，默认 `deepseek-flash`。新版迁移低优先级，不列 TODO；不以升级替代直接维护现有翻译、保护、字体、缓存和阅读链路。
- 独立 macOS **0.4.2** 专属源码尚未取得，发布 tag 内共享 manifest 与独立发布物并不对应。不要合流、反向提取、重建覆盖或改变仓库 Latest；共享实现仍保持跨平台兼容。
- 当前 Linux/Windows bundled/local 四包在 `agent/codex/continuation-quality-20261116/candidates/native-regions-v10-sync-tags-20261116`，精确 SHA 见 `docs/source-delivery-readiness.md`。四包 addon/backend 源码均匹配；两种 Linux 模式已原生安装、迁移内部标记、阅读/删除恢复、实际 backend health、同 profile/data 新 PID 冷重开、正常退出及停机 integrity ok。Windows 两个最终包的原生升级、标记迁移、笔记/批注回链及补测冷重开也已通过；仅认可各自精确包身份和已测范围，不代表质量、真实云同步或公开交付全部完成。
- `docs/candidate-delivery-0.3.6.json`、`docs/runtime-terms-acceptance-0.3.6.json` 及更早 Windows/nonmac 验收保留各自历史 hash 和范围，不回填本轮 GUI 包身份；稳定 0.3.4 投递历史与 0.3.5 质量证据仍独立。不得借用旧包、mocks、CI 或免费重排作为新包全部功能/许可/发布的证明。
- GitHub TODO #1 为范围化待办；下一步见 `docs/product-roadmap-0.3.6.md`。根 TODO 未获授权不修改。`agent/report` 只放每次新的任务简报；`agent/task` 只放用户给出的任务文件；普通任务不扫描 `agent/codex`、`agent/grok`。

## 存储、任务与费用

- 译文为 Zotero 原生 PDF 附件；笔记、批注和可同步映射是独立阅读资产。插件数据在 Zotero 数据目录的 `paperbridge/`：`engine/` 为可重建解包副本，`cache/` 为模型/字体/段落缓存，`.runtime/jobs/` 为任务及保留成果。不要把后三者和日常文献库当作可随意清理的临时文件。
- `library.js` 管理按源附件/owner 的 durable records；`tasks.js` 管理串行任务/保存/显式重试。翻译结果、质量状态、PDF 导入状态和映射导出状态分开。重启不重发，保存失败可单独重试；显式重译可能重复收费，不能用自动重试美化 unknown/partial。
- 新尝试在 `jobs/attempts/<job-id>-<number>/`；旧 nested 目录兼容读取。`identity.json`、结果、质量及映射证据保留；共享、活动、未知归属不猜删。`prune_library()` 不取消任务，取消只由明确任务动作触发；损坏/不完整索引停用清理，不阻断已有 PDF 阅读。
- 完整 PDF 的排版身份为 `babeldoc-0.6.4-protected-v10-native-regions`，段落 namespace/prompt 不变。保护框按原始输入与 BabelDOC 规范化工作页的真实变换映射；文字仅按保护框内字形中心清除，保留相邻正文。标题边缘误命中不再拆开完全落在普通正文框内的字形；仍使用固定引擎的优先级/IoU 选择。完整 PDF 不复用旧排版、不静默改写已保存文件；出版信息/参考文献只合并包含或同列紧邻保护框。
- 已完成用户授权的 **20 篇不同论文、241 页真实全文**测试，baseline 580 个真实请求；含诊断/集中修复为 **632 个去重真实返回 ID**，均有完整 provider 用量。真实 baseline 为 19 partial/1 complete，六篇 paid-final 为 5 partial/1 complete，不代表整篇语义接受。成果/财务保留在 `agent/codex/paid-gui-20261116`；免费重排的被封锁 cache miss 不算新增付费或真实成功。任务结束后的新付费请求/探测须重新获得授权。
- 旧 v9 全量诊断覆盖 **20 篇/241 页**，1 complete/19 partial；修正后的 v10 真实全文缓存重排覆盖 **6 篇/68 页**，全部 partial，真实 provider 调用 0，输入及后端 hash 保持不变。证据入口为 `agent/codex/continuation-quality-20261116/corrected-preservation/manifest.json`，输出为同任务 `replays/native-regions-v10-free`。Elsevier05 p3 的 K/R/L、`dρ/dt` 前缀及两段中文已实际视觉复核修复；Wheat 两段完整正文缺 exact cache，Cement p4、Science02 p7、IEEE03 等仍有漏译/未知。不得拼旧片段伪造完整缓存或把结构/免费重排当成人类双语接受；新的付费调用须重新授权。

## 可信映射与阅读

- `FragmentTrace` 在固定引擎 capture 同身份的 before/applied 证据；最终 PDF 保护恢复后，`backend/alignment.py` 核对两份 PDF hash、完整 raw 字符包含、唯一可见字面，再生成 **schema 2 / fragment-trace-2**。页码零基，未旋转 PDF user space；跨页/移页/重复字面/隐藏或不支持区域继续 unavailable，不提高覆盖率猜配。
- 普通横排用最终 paint glyph bounds 组成逐行 quads，支持有同一基线/真实 paint 证据的复合 ToUnicode 字符；每侧 `rects` 是 quad 的兼容 bounds，schema 1 仍读。hover 仅补偿原生 Range 上下字体留白：中心和至少 60% 高度仍须在同一可信行内，横向 2 CSS px 容差及旋转/倾斜拒绝不变。CSS Custom Highlights priority -1，显式定位用逐行 polygon overlay；不改 PDF/textLayer opacity/selection，不放松后端验证。
- 内部 `urn:paperbridge:record:` / `job:` / `alignment:1` 标记存为 Zotero 自动标签（type 1）；`dc:relation` 只保留真实条目 URI，否则云端会以 HTTP 400 拒绝。`library.load()` 经 native Item `saveTx()` 迁移旧关系；标签和旧关系均可读取，保留 record/job ID、附件 key、PDF/JSON 字节，只读条目警告不阻断其他阅读。不要删恢复标签；Zotero 会移除指向已永久删除源条目的 URI 关系，独立记录标签仍须保留。
- `reading-assets.js` 将 verified geometry 导出为 imported JSON 附件，包装版本 1，只含 source/translated keys、owner、PDF SHA、schema、generator/validation 和有限几何；不含全文、路径、凭据或日志。资产按 exact 自动标签/旧关系发现，不按文件名或 hash 猜归属。
- 打开时用 Gecko 重新 hash 当前文件，核对同库 exact keys/parent 和真实 PDF.js 页界，无后端/Python 依赖。PDFPageProxy 的 content getter 要 `Components.utils.waiveXrays()`，不能用 Xray 隐藏字段当理由跳过页界校验。其他未下载映射的错误不能覆盖当前附件对的真实降级原因。
- 多译本显式选择，各自绑定；同一 PDF 在不同文献中的 keys/owner 独立。新资产不删除旧 PDF/映射；有效旧 sidecar 可免费补 JSON，无 sidecar 不付费重译。跨库旧 keys、缺失/损坏/未下载、换字节、错误 parent/冲突仅停精确功能；普通阅读/页同步保留，源已删除时可独立打开已知译文。
- 同一附件对重复打开复用初始化 promise，保留两侧页码/缩放/宽度/同步。Zotero `Reader.open()` 可能因已有/恢复 tab 返回 undefined；按实际 itemID 找原生 reader，不用另造 reader 验收。
- `notes.js` 用官方 serializer 和一次 `note.saveTx()` 建独立 note，**新 Item 不预设 key**；回链为正确译文附件/物理页。`annotations.js` 仅写译文附件批注，串行保存、关闭前快照并等待 pending writes；失败只降级相关功能。原译精确批注同步未实现。

## 构建与平台

- 实际宿主 Linux，使用项目 `.venv/bin/python`；离线入口 `scripts/check_offline.py --mode full`，清除继承 `PYTHONPATH` 并禁 pytest 外部插件。跨宿主 staging 测试先取得真实解释器 ABI，再模拟 `sys.platform`，不把模拟 OS 当成真实 Python 构建。开发/插件子进程清理 Python/native 环境，不改系统 Python、ROS2 或 shell 配置。
- Linux x64 默认已验收 stage 为 `.cache/package/linux-x64`；保留 CPython/libpython、其他 wheel `.libs`、模型和词表。OpenCV 4.12 只含 `core/imgproc/imgcodecs/python3`，与既有 macOS scope 相同，暂不进一步精简，不做 XZ/别名恢复/后置 strip/运行期补下载。
- Linux 原生基线 glibc ≥ 2.34；兼容 OpenCV 实际最高需 glibc 2.30 / GLIBCXX 3.4.26。Ubuntu 24.04 默认工具链会引入 2.38，不能直接作为该基线发布包。源码 build/install 入口为 `scripts/build_opencv_linux.sh`、`.cache/opencv-linux-x64/install`，本机兼容 sysroot/toolchain 在该目录的 `tools/`；旧 wheel stage 仅保留一份于 `.cache/package-baselines/linux-x64-before-image-only-20261115`。构建输入与路径净化前后 hash 的区别见 `docs/linux-package-size.md`。
- `build.py` 每次重建 payload，支持独立 `--stage-dir` / `--output-dir`；改 addon/backend/资源后四包重建并核 SHA，prepare 必须在构建结束后执行，避免同名 XPI hash race。marker/build ID 只绑定 payload/backend，不证明 addon 字节；还要核真实落盘 XPI 和全部发货源码。
- Windows stage 继续用官方 OpenCV wheel、CPython 3.12.13；Linux CPython 实际为 3.12.16。完整原始许可补充材料、303 个固定源码归档及四包绑定生成器已准备；**licenseCompliance 仍 unknown、公开源码交付未完成**。选用 AGPL/GPL/Berkeley DB 完整对应源码同行交付，不使用无明确范围的书面 offer；当前未找到具体缺失的必要上游源码/notice，普通原工具链/字节重建不确定性不是自动法律门槛。
- MSVC 三 DLL 已匹配微软原始发布字节且签名有效；用户明确确认合法使用 Community 2026 18.9.2 及第 8 条分发责任（含应用相关索赔补偿/辩护及其例外），不重复索取。Windows 两模式的 DLL 专属条款/拒绝/设置接受/冷重开已在实际 150% 原生窗口核验，Linux 两模式保持豁免。`runtime-terms.js` / `Microsoft-Runtime-Terms.txt` 只保存身份 `msvc-community-2026-v1`，不因插件升级重复；后台迁移/轮询/清理/诊断不弹窗，拒绝只停用引擎，设置可重开。读取用 ZIP UTF-8 输入流（Zotero URI overload 返回 XHR），关闭用 `domwindowclosed`，不把初始 about:blank unload 当拒绝。原始 2026 文档/DLL 保持原字节，条款不限制 AGPL 插件整体；普通用户无需额外安装软件。Runtime 使用 EULA/免费 Build Tools 使用权不独立授予再分发；见 `docs/windows-msvc-redistribution.md`、evidence 和 runtime-terms acceptance。既有引擎 20s 启动等待未改，快速连续重启的普遍可靠性不在本次验收范围。
- 当前四包对应源码为同候选目录的 `paperbridge-0.3.6-linux-windows-source.zip`，SHA **c1c562ee426a00b71f9aed198e4ba5ce76c93f4c429cb8597e669121c8dd863f**，源码快照 **5891296bc943f1729dcb585b60ae9c9c14bcb5a8**。24,546 索引文件、303 归档、4 个 Linux build inputs 及四包 project/native/notice 均已绑定核验；359 个项目文件匹配该提交的 checkout，含两份 PS1 按已提交 `.gitattributes` 从 LF 转 CRLF，不能误当未提交修改。内部/外部 manifest 与 checksum 一致，fromCommitOnly=true，纳入必要的 tracked 测试/开发文档并排除私有过程目录。后续仅 MEMORY 改动不改变该源码绑定。仅本地私有交付，不清除 licenseCompliance unknown / 对应源码 partial，不代表获准公开。
- `scripts/package_sources.py` 纳入 Git-tracked `tests/` / `docs/`；303 归档缓存为 `agent/codex/licensing-p0-1-20261116-003659/source-cache`。任何实际 source/XPI 改动须重新冻结绑定；`dist/candidate-20261116-msvc` 历史 ZIP 仅属于其旧 hash。原始第三方许可的空格/换行须保留，不为 diff whitespace 检查修改原文；公开时源码 ZIP/manifest/checksum 与获准 XPI 同地提供。
- `.github/workflows/ci.yml` 为三平台 lightweight 合约；`release-candidate.yml` 手动构建 Linux/Windows，不构建 macOS、不发布 feed。runner-native OpenCV 可比发布基线新，构建 CI 不替代兼容工具链和原生 Zotero。

## 安全接续与原生验收

- 日常 Linux Zotero：`/home/scq/.local/opt/zotero/zotero`，profile `/home/scq/.zotero/zotero/ylkmnjtn.default`，数据 `/home/scq/Zotero`。不要与 `.runtime/*-profile/*-data` 混淆；不强杀日常进程、不改锁/SQLite/NSS 来制造通过。升级日常环境前保留停机备份。
- Windows SSH 为 `desktop-hz`，Zotero `D:\Zotero\zotero.exe`，原工程 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`；本轮隔离目录 `E:\PBAssets-1115`。PowerShell 操作，项目可用 Python 为原工程 `.runtime\windows-p1-validation-20261114\.venv\Scripts\python.exe`（3.12.13）；顶层 uv venv trampoline 不可用。不要改原工程 HEAD/工作文件，也不要清除既有 stash、`windows-wip-before-takeover-20261113.zip`、`.runtime/windows-package-before-p1` 或日常凭据备份。
- Windows 日常接收端 profile 为 `C:\Users\LostPatrol_2\AppData\Roaming\Zotero\Zotero\Profiles\dljrawap.default`，data 为 `E:\0syncthing\Zotero`，不要与隔离目录混淆。当前只读准备看到 stored plugin 0.3.4、无旧 PaperBridge URN、metadata helper 未注册；stored registry 不证明实际运行版本。证据在 `agent/codex/account-metadata-v10-20261117-005536/windows-receiver/preparation-checkpoint-1.json`。尚未启动/安装/同步 Windows 日常端；最新授权明确 Linux，Windows metadata 执行授权未建立，须用户另确认，不能顺带升级。
- Windows UI 需登录交互 Session；OpenSSH Session 0 不适合。启动器常先退出，须等 helper 产生真实 `Services.appinfo.processID`，再等该 UI 正常退出后准备下一项/冷重开。只清理本轮自有进程与临时计划任务，不外部强杀制造退出成功。
- 历史 v8 四包的 GUI/条款/hover/笔记与冷重开仅属于旧 hash。当前 Windows 两模式用最终包从 0.3.4 原生升级、迁移旧 URN、保存真实 note/highlight，并经 trusted note-editor/popup 点击定位译文物理页与批注；保留文件后同 profile/data 新 PID 补测冷重开，native/driver/scheduler exit 均为 0，停机 integrity ok。证据入口 `agent/codex/continuation-quality-20261116/windows-worker/worker-final-exit-audit1.json`；实际 code0 只属于两次 corrective cold2，旧 driver 未采集的 notes/旧 cold exit 仍 unknown，不回填。隔离 Gecko DPR 1 不等于 Windows OS 100%；系统仍 150%，OS 100%、真实队列/取消收费链路及物理权限/资源错误边界未覆盖，不为验收更改全局显示设置。
- 合并原生 suite：`prepare_nonmac_test.py --suite assets --phase create|reopen|receive`、`assets_packaged.js`、`lifecycle_asset_packaged.js`。原生输入先等待实际页/textLayer 并滚到可见行；viewport placeholder 或屏幕外坐标不是有效点击。`PathUtils.normalize()` 解析 inode，已删除路径需解析其存活父目录。
- A→B 隔离检查仅种子化停机 metadata、保持 keys；B storage 为空、不复制原/译 PDF、JSON、NSS 或 PaperBridge 状态，`reading_asset_webdav.js` 经官方 WebDAV `Storage.Request.start()` 下载、校验 native 路径/MD5/size/in_sync，再核 PDF SHA。此处不使用账号 API key，也不代表云 metadata sync/group 已验收。
- 真实账号两端均 LostPatrol。用户已明确授权日常 Linux 停机备份、候选升级/旧标记迁移及 metadata-only 接续；Linux 日常 bundled 已通过原生 AddonManager 升为精确 **0.3.6** 候选，附件 `IKD2SPZF` 的两条旧 record/job URN 已迁为 type 1 自动标签，原 keys/ID、真正条目 URI、PDF、缓存/任务文件不变。原合成 collection/article/note metadata-resume 已真实同步成功、取得服务端版本；该译文附件由 version 0 / unsynced 变为 version 2342 / synced，HTTP 400 已消除。Windows 日常升级不在本次授权内；真实 Windows 接收端尚待完成，因此仍不代表两设备、文件、多译本或 group 已验收。保留原文件同步偏好，验收只用空 fileLibraries/fullTextLibraries；免费 300 MB 不允许全库上传，实际附件方案另授权。
- `prepare_account_sync.py` 支持独立输出目录；metadata 只建合成条目/note，fileLibraries/fullTextLibraries 为空，文件 produce 另需显式授权。助手须经 AddonManager 安装，不能复制 XPI；报告已存在时不重放。恢复偏好、写最终报告和正常 quit 之间不能异步让出给背景 sync。
- 日常 Linux 当前临时 `user.js` 已移除，autoSync 恢复原始无 user value，停机 integrity ok；本轮原生升级、同 profile/data 新进程冷检查及 metadata-resume 的实际 exit 均为 0。早期 metadata 的 **SIGSEGV / -11** 仍是历史真实失败，旧 launcher 标签不能由新证据回填。launcher 已区分异常退出/139，并以 SQLite backup 保留 committed WAL；不得只 copy/hash 主数据库替代一致备份。接续证据/本宿主停机备份在 `agent/codex/account-metadata-v10-20261117-005536`，入口 `metadata-resume-final-audit-1.json`；当前已安装助手读取该目录 `native-helper/account-linux-v9-metac-options.json`，其已存在 report 禁止普通启动重放。原 fixture index 仍在 `continuation-quality-20261116/account-linux/account-linux-v9-metac-state.json`，原 keys/title/note 不变，成功同步仅补入非敏感真实 userID。备份不含 NSS/login 材料，不传日常数据库或凭据。
- 原生安装必须 AddonManager，而不是只复制 XPI；create/reopen 使用相同 profile/data、新 PID、正常退出及停机 integrity。失败重试用新 report label，不覆盖证据。公共更新、旧版升级、Windows 缩放/新 note、真实账号同步为独立待验收范围。
- API Key 存 Zotero 登录管理器；非空替换直接 `modifyLogin(old, old.clone())`，失败保留旧值，清空仅当前 realm。Zotero 同步 `getAPIKey()` 可能写 OSKeyStore 加密镜像，**不是纯读取**；账号测试只调用官方 Sync.Runner，不直接探测/导出 key 或搬运 NSS。禁止输出或持久化 token。
- Linux 无可用非交互 GitHub 推送凭据时，用 Windows 既有 Git Credential Manager 和 Git bundle 普通快进推送，不签出/重置原工程、不创建分支/worktree。GCM 曾报告 wincredman 持久化失败但推送成功，须核实际 Git 返回码与远端 SHA，不自动修凭据配置或导出凭据。issue 用 GitHub API，不用 gh；先核当前远端，拒绝强推。
