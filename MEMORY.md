<!-- Current source baseline, safe continuation entry points, and unresolved product limits. -->
# 当前开发基线

- 主分支 `master`；共享源码 **0.3.6 候选**。版本同步 addon manifest、`backend/server.py VERSION`、pyproject 和 uv.lock。Linux/Windows 四条稳定公开通道及资产仍为 **0.3.4**；源码推送不代表新 XPI 发布或通道启用。
- BabelDOC 固定 **0.6.4** / PyMuPDF **1.26.7**，默认 `deepseek-flash`。新版迁移低优先级，不列 TODO；不以升级替代直接维护现有翻译、保护、字体、缓存和阅读链路。
- 独立 macOS **0.4.2** 专属源码尚未取得，发布 tag 内共享 manifest 与独立发布物并不对应。不要合流、反向提取、重建覆盖或改变仓库 Latest；共享实现仍保持跨平台兼容。
- 当前四包交付身份见 `docs/candidate-delivery-0.3.6.json`；MSVC 整合后精确四包的条款/豁免、synthetic PDF 阅读、health 与冷重开见 `docs/runtime-terms-acceptance-0.3.6.json`。`docs/windows-acceptance-0.3.6.md` 的升级/notes/诊断及 `docs/nonmac-verification-0.3.6.json` 的阅读/清理均保留各自整合前 hash，不回填新身份；稳定 0.3.4 投递历史与 0.3.5 质量证据仍独立。验收只覆盖注明范围，不借用同名旧包、mocks、CI 或缓存重放的结论。
- GitHub TODO #1 为范围化待办；下一步见 `docs/product-roadmap-0.3.6.md`。根 TODO 未获授权不修改。`agent/report` 只放每次新的任务简报；`agent/task` 只放用户给出的任务文件；普通任务不扫描 `agent/codex`、`agent/grok`。

## 存储、任务与费用

- 译文为 Zotero 原生 PDF 附件；笔记、批注和可同步映射是独立阅读资产。插件数据在 Zotero 数据目录的 `paperbridge/`：`engine/` 为可重建解包副本，`cache/` 为模型/字体/段落缓存，`.runtime/jobs/` 为任务及保留成果。不要把后三者和日常文献库当作可随意清理的临时文件。
- `library.js` 管理按源附件/owner 的 durable records；`tasks.js` 管理串行任务/保存/显式重试。翻译结果、质量状态、PDF 导入状态和映射导出状态分开。重启不重发，保存失败可单独重试；显式重译可能重复收费，不能用自动重试美化 unknown/partial。
- 新尝试在 `jobs/attempts/<job-id>-<number>/`；旧 nested 目录兼容读取。`identity.json`、结果、质量及映射证据保留；共享、活动、未知归属不猜删。`prune_library()` 不取消任务，取消只由明确任务动作触发；损坏/不完整索引停用清理，不阻断已有 PDF 阅读。
- 完整 PDF 的排版身份为 `protected-v5-metadata`，段落缓存身份不变。服务/模型/语言/高级配置须进快照与匹配，避免旧缓存串用。旧 PDF 不静默改写。
- 仅已授权的 sklearn 第 2 页和 LIBLINEAR 第 1 页有真实服务请求历史；可复用既有缓存零费用重排。结构 complete/映射 verified 不等于人类语义接受，更多公式/图表及全文审查仍未完成。新 provider 请求、兼容服务或付费探测均须另获授权。

## 可信映射与阅读

- `FragmentTrace` 在固定引擎 capture 同身份的 before/applied 证据；最终 PDF 保护恢复后，`backend/alignment.py` 核对两份 PDF hash、完整 raw 字符包含、唯一可见字面，再生成 **schema 2 / fragment-trace-2**。页码零基，未旋转 PDF user space；跨页/移页/重复字面/隐藏或不支持区域继续 unavailable，不提高覆盖率猜配。
- 普通横排用最终 paint glyph bounds 组成逐行 quads，避免 raw ascender 框行间重叠；每侧 `rects` 是对应 quad 的兼容 bounds，schema 1 仍读。hover 使用完全落入可信区域的原生文本 Range / CSS Custom Highlights（priority -1），显式定位用逐行 polygon overlay；不改 PDF/textLayer opacity/selection、不抢链接或批注。
- `reading-assets.js` 将 verified geometry 导出为 imported JSON 附件，包装版本 1，关系标记 `urn:paperbridge:alignment:1`。只含 source/translated keys、owner、PDF SHA、schema、generator/validation 和有限几何；不含全文、路径、凭据或日志。
- 打开时用 Gecko 重新 hash 当前文件，核对同库 exact keys/parent 和真实 PDF.js 页界，无后端/Python 依赖。PDFPageProxy 的 content getter 要 `Components.utils.waiveXrays()`，不能用 Xray 隐藏字段当理由跳过页界校验。其他未下载映射的错误不能覆盖当前附件对的真实降级原因。
- 多译本显式选择，各自绑定；同一 PDF 在不同文献中的 keys/owner 独立。新资产不删除旧 PDF/映射；有效旧 sidecar 可免费补 JSON，无 sidecar 不付费重译。跨库旧 keys、缺失/损坏/未下载、换字节、错误 parent/冲突仅停精确功能；普通阅读/页同步保留，源已删除时可独立打开已知译文。
- 同一附件对重复打开复用初始化 promise，保留两侧页码/缩放/宽度/同步。Zotero `Reader.open()` 可能因已有/恢复 tab 返回 undefined；按实际 itemID 找原生 reader，不用另造 reader 验收。
- `notes.js` 用官方 serializer 和一次 `note.saveTx()` 建独立 note，**新 Item 不预设 key**；回链为正确译文附件/物理页。`annotations.js` 仅写译文附件批注，串行保存、关闭前快照并等待 pending writes；失败只降级相关功能。原译精确批注同步未实现。

## 构建与平台

- 实际宿主 Linux，使用项目 `.venv/bin/python`；离线入口 `scripts/check_offline.py --mode full`，清除继承 `PYTHONPATH` 并禁 pytest 外部插件。跨宿主 staging 测试先取得真实解释器 ABI，再模拟 `sys.platform`，不把模拟 OS 当成真实 Python 构建。开发/插件子进程清理 Python/native 环境，不改系统 Python、ROS2 或 shell 配置。
- Linux x64 默认已验收 stage 为 `.cache/package/linux-x64`；保留 CPython/libpython、其他 wheel `.libs`、模型和词表。OpenCV 4.12 只含 `core/imgproc/imgcodecs/python3`，与既有 macOS scope 相同，暂不进一步精简，不做 XZ/别名恢复/后置 strip/运行期补下载。
- Linux 原生基线 glibc ≥ 2.34；兼容 OpenCV 实际最高需 glibc 2.30 / GLIBCXX 3.4.26。Ubuntu 24.04 默认工具链会引入 2.38，不能直接作为该基线发布包。源码 build/install 入口为 `scripts/build_opencv_linux.sh`、`.cache/opencv-linux-x64/install`，本机兼容 sysroot/toolchain 在该目录的 `tools/`；旧 wheel stage 仅保留一份于 `.cache/package-baselines/linux-x64-before-image-only-20261115`。构建输入与路径净化前后 hash 的区别见 `docs/linux-package-size.md`。
- `build.py` 每次重建 payload，支持独立 `--stage-dir` / `--output-dir`；改 addon/backend/资源后四包重建并核 SHA，prepare 必须在构建结束后执行，避免同名 XPI hash race。marker/build ID 只绑定 payload/backend，不证明 addon 字节；还要核真实落盘 XPI 和全部发货源码。
- Windows stage 继续用官方 OpenCV wheel、CPython 3.12.13；Linux CPython 实际为 3.12.16。完整原始许可补充材料、303 个固定源码归档及四包绑定生成器已准备；**licenseCompliance 仍 unknown、对应源码闭环 partial**。AGPL/GPL/Berkeley DB 源码交付义务仍待确认；普通原工具链/字节重建不确定性不是自动法律门槛。
- MSVC 三 DLL 已匹配微软原始发布字节且签名有效；用户明确确认合法使用 Community 2026 18.9.2 及第 8 条分发责任（含应用相关索赔补偿/辩护及其例外），不重复索取。Windows 两模式的 DLL 专属条款/拒绝/设置接受/冷重开已在实际 150% 原生窗口核验，Linux 两模式保持豁免。`runtime-terms.js` / `Microsoft-Runtime-Terms.txt` 只保存身份 `msvc-community-2026-v1`，不因插件升级重复；后台迁移/轮询/清理/诊断不弹窗，拒绝只停用引擎，设置可重开。读取用 ZIP UTF-8 输入流（Zotero URI overload 返回 XHR），关闭用 `domwindowclosed`，不把初始 about:blank unload 当拒绝。原始 2026 文档/DLL 保持原字节，条款不限制 AGPL 插件整体；普通用户无需额外安装软件。Runtime 使用 EULA/免费 Build Tools 使用权不独立授予再分发；见 `docs/windows-msvc-redistribution.md`、evidence 和 runtime-terms acceptance。既有引擎 20s 启动等待未改，快速连续重启的普遍可靠性不在本次验收范围。
- `scripts/package_sources.py` 生成独立源码 ZIP、manifest 和 SHA；当前四包绑定源码在 `dist/candidate-20261116-msvc`，303 归档缓存为 `agent/codex/licensing-p0-1-20261116-003659/source-cache`，身份见 delivery 文档。发货源码快照 commit 为 `0082d6f874b61dd65a661ac2a0ab8047649142bf`；24,408 文件重核通过，四包 source/notice 缺失/变化及项目源码不匹配均为 0，不代表整体许可清零或公开交付。发布前保持实际 XPI hash 绑定，不借旧包结论，不改归档内容；原始第三方许可的尾部空格/换行须保留，不为 diff whitespace 检查修改原文。
- `.github/workflows/ci.yml` 为三平台 lightweight 合约；`release-candidate.yml` 手动构建 Linux/Windows，不构建 macOS、不发布 feed。runner-native OpenCV 可比发布基线新，构建 CI 不替代兼容工具链和原生 Zotero。

## 安全接续与原生验收

- 日常 Linux Zotero：`/home/scq/.local/opt/zotero/zotero`，profile `/home/scq/.zotero/zotero/ylkmnjtn.default`，数据 `/home/scq/Zotero`。不要与 `.runtime/*-profile/*-data` 混淆；不强杀日常进程、不改锁/SQLite/NSS 来制造通过。升级日常环境前保留停机备份。
- Windows SSH 为 `desktop-hz`，Zotero `D:\Zotero\zotero.exe`，原工程 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`；本轮隔离目录 `E:\PBAssets-1115`。PowerShell 操作，项目解释器/Node 复用原工程 `.runtime\windows-p1-validation-20261114\.venv\Scripts\python.exe` / `.tools\node.exe`。不要改原工程 HEAD/工作文件，也不要清除既有 stash、`windows-wip-before-takeover-20261113.zip`、`.runtime/windows-package-before-p1` 或日常凭据备份。
- Windows UI 需登录交互 Session；OpenSSH Session 0 不适合。启动器常先退出，须等 helper 产生真实 `Services.appinfo.processID`，再等该 UI 正常退出后准备下一项/冷重开。只清理本轮自有进程与临时计划任务，不外部强杀制造退出成功。
- MSVC 整合前的 Windows 两模式 0.3.4→0.3.6 在 150% 下完成原生文件安装、新 note/汇总、保存 URI 路由、三场景诊断隐私与新 PID 冷重开；新四包只新增条款范围的精确原生验证，不借用旧 hash。更早候选有实际 100% 证据，但不是当前 hash 的 100% 重跑；物理 NSS/NTFS 写失败、long path/file busy/真实缺资源、编辑器链接鼠标点击仍未验，不把注入失败或原生 NUL 拒绝当作全部权限通过。
- 合并原生 suite：`prepare_nonmac_test.py --suite assets --phase create|reopen|receive`、`assets_packaged.js`、`lifecycle_asset_packaged.js`。原生输入先等待实际页/textLayer 并滚到可见行；viewport placeholder 或屏幕外坐标不是有效点击。`PathUtils.normalize()` 解析 inode，已删除路径需解析其存活父目录。
- A→B 隔离检查仅种子化停机 metadata、保持 keys；B storage 为空、不复制原/译 PDF、JSON、NSS 或 PaperBridge 状态，`reading_asset_webdav.js` 经官方 WebDAV `Storage.Request.start()` 下载、校验 native 路径/MD5/size/in_sync，再核 PDF SHA。此处不使用账号 API key，也不代表云 metadata sync/group 已验收。
- 真实账号两端均 LostPatrol；Windows 文件同步仍关闭，日常插件仍 0.3.4，账号助手未注册，启动临时 autoSync/user.js 已恢复；停机 SQLite integrity 为 ok。真实两设备 metadata 尚未通过，更不代表文件/多译本/group。免费 300 MB 空间不足以全库上传，绝不为验收开启文件同步；实际附件流程需明确授权方案。
- `prepare_account_sync.py` 支持独立输出目录；metadata 只建合成条目/note，fileLibraries/fullTextLibraries 为空，文件 produce 另需显式授权。助手须经 AddonManager 安装，不能复制 XPI；报告已存在时不重放。恢复偏好、写最终报告和正常 quit 之间不能异步让出给背景 sync。
- Linux 日常 PID 2185669 仍等待用户正常退出；本轮启动临时 autoSync=false 尚未清理，原值为无 user value/default true。`agent/codex/continuation-20261116/restore-first-launch.py` 已等待该 PID 的正常退出；确认 `first-launch-cleanup.json`、user.js 移除及偏好恢复后才再次启动。要使用该目录修正后的 direct `zotero-bin -app ...` X11 launcher；官方 shell wrapper 会强制 Wayland。两端停机备份留在各自宿主，不传凭据/日常数据库。
- 原生安装必须 AddonManager，而不是只复制 XPI；create/reopen 使用相同 profile/data、新 PID、正常退出及停机 integrity。失败重试用新 report label，不覆盖证据。公共更新、旧版升级、Windows 缩放/新 note、真实账号同步为独立待验收范围。
- API Key 存 Zotero 登录管理器；非空替换直接 `modifyLogin(old, old.clone())`，失败保留旧值，清空仅当前 realm。Zotero 同步 `getAPIKey()` 可能写 OSKeyStore 加密镜像，**不是纯读取**；账号测试只调用官方 Sync.Runner，不直接探测/导出 key 或搬运 NSS。禁止输出或持久化 token。
- Linux 无可用非交互 GitHub 推送凭据时，用 Windows 既有 Git Credential Manager 和 Git bundle 普通快进推送，不签出/重置原工程、不创建分支/worktree。issue 用 GitHub API，不用 gh；先核当前远端，拒绝强推。
