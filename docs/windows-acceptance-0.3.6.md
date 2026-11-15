<!-- Exact Windows candidate identities, native evidence coverage, and explicit acceptance limits. -->
# Windows 0.3.6 原生验收

本页对应路线图 **P1-3** 的隔离升级/UI 专项，不代表日常账号 metadata、文件同步、公开更新或完整发布验收。宿主为 Windows、Zotero **10.0.8**，交互 Session **1**；BabelDOC **0.6.4** / PyMuPDF **1.26.7** 未升级。本文只核实既有证据，没有再次启动 Windows UI 或改变系统缩放。

## 精确包身份

| 模式 / 证据 | XPI SHA-256 | 实际 extracted engine build ID |
| --- | --- | --- |
| bundled 最终候选，`wp13fb16` | `b13d1a0a795ad80a5677ad1707962a4a1defbf2195fc46f94aa683437752dfba` | `0e2c7f3837a5951d00acbe593d8fd773e0cd87150d646904c5c53f4c1f86363f` |
| local 最终候选，`wp13fl16` | `c56598415f55b6e0789f723b2ce6b02692b035fee45ccdca36ffd005f3af80c0` | `1212e1d1b4843322cc600ad14b37344cc670195df6483d63a2623ab0ac49976e` |
| bundled 旧 0.3.6 / 100%，`wp13b2` | `3b7ee5da05dab8c463f4264e6e43cf753c07a052f68929c64dcf07d7c700ad4c` | `13cd8c309f8cd5d0b6535d251e26418ff05d4da5f8b759f148572e2759dea345` |
| local 旧 0.3.6 / 100%，`wp13l2` | `38dacab3f75e8db0367f845c588c72fec050e313a2405091bd2d4728229aa1d0` | `15f2ff3324ee230a73497f3f41e19597c4d8f9d625558760bc66c20d94e94df7` |

最终升级起点为真实 **0.3.4** XPI：bundled `b4dfdf905c705dfd43d4361e9f3dd9842b5d13f1d904b1845af094f9c8d7d29f`；local `453d9b48d6782d15ee3c57f045e5b965d530182cdb1043ac96cf32f3f3df4272`。两者由 create 报告的 `installedXpiSha256` 证明。

SHA 来源分开核对：install 的 `nativeFileInstall.xpiSha256` 是经 hash 检查、AddonManager 文件安装完成的**候选输入**；reopen 的 `installedXpiSha256` 是 profile 中 `extensions/paperbridge@local.dev.xpi` 的**实际落盘字节**。install 报告中的顶层 `installedXpiSha256` / `installed` 仍是安装前 0.3.4，不应误标为新包。最终候选快照来源为远端 `E:\PBAssets-1115\agent\codex\windows-p1-3-20261115-2220\packages\wp13fb16-candidate.xpi` / `wp13fl16-candidate.xpi`；不是公共更新投递。

四包当前交付身份见 [candidate-delivery-0.3.6.json](candidate-delivery-0.3.6.json)，本页两条最终 Windows SHA/build ID 与其一致。[nonmac-verification-0.3.6.json](nonmac-verification-0.3.6.json) 保留历史原生包身份；不能把 license 重打包后的新 SHA 回填到历史验收。

`agent/codex/continuation-20261116/candidate-baseline-delta.json` 证明新旧 Windows runtime 的逐文件内容一致（bundled **6535**、local **5962**），但 ZIP 属性不同，payload SHA 与 build ID **确实改变**。因此旧 100% 结果只作同内容运行时的补充证据，**不是最终 SHA 在 100% 下重跑**；也不以 build ID 代替 addon/XPI 字节校验。

## 阶段、checks 与退出

远端报告在 `E:\PBAssets-1115\.runtime\`。每行文件名为 `upgrade-<run>-<阶段>.json`，并有对应 `.json.launch.json`；四阶段使用同一 run 的 profile/data，PID 均不同。

| 模式 / run | 阶段 | 总 checks | supplement native checks（已含在总数中） | 实际 UI PID | 实际缩放 |
| --- | --- | ---: | ---: | ---: | --- |
| bundled / wp13fb16 | create | 7 | — | 59176 | 150% / 144 DPI |
| bundled / wp13fb16 | install | 17 | — | 15208 | 150% / 144 DPI |
| bundled / wp13fb16 | reopen-native | 300 | 227 | 55712 | 150% / DPR 1.5 |
| bundled / wp13fb16 | reopen-cold | 231 | 214 | 36576 | 150% / DPR 1.5 |
| local / wp13fl16 | create | 7 | — | 57212 | 150% / 144 DPI |
| local / wp13fl16 | install | 17 | — | 11944 | 150% / 144 DPI |
| local / wp13fl16 | reopen-native | 304 | 231 | 36252 | 150% / DPR 1.5 |
| local / wp13fl16 | reopen-cold | 235 | 218 | 23884 | 150% / DPR 1.5 |
| bundled / wp13b2（旧包） | reopen-cold100 | 231 | 214 | 1432 | 100% / 96 DPI / DPR 1 |
| local / wp13l2（旧包） | reopen-cold100 | 235 | 218 | 43404 | 100% / 96 DPI / DPR 1 |

各行均 `ok=true, stage=complete`，不是超时/失败后的缓存报告。最终两模式驱动均完成，主代理 session **11616 exit 0**；本机留存 `agent/codex/continuation-20261116/windows-final-bundled.log` / `windows-final-local.log`。远端 `windows-run.ps1` 在报告后等待 helper 的真实 UI PID 消失，未正常退出便拒绝下一阶段；helper 使用 `eAttemptQuit`，不是强杀。**未单独采集每个 Zotero UI 进程的数值 exitCode**，不能把驱动 exit 0 当成八个 UI exitCode=0。

最终停机 `upgrade-wp13fb16-final-state.json` / `upgrade-wp13fl16-final-state.json` 的 Zotero SQLite 与段落缓存 `integrity_check` 均为 `ok`。段落缓存为 **1 行隔离夹具**，SHA `b4c041ac7bb535e09b7e833140c47eaa66b0df0d7df06431a8cc29ce03ab1a54`；证明字节保留，不代表日常大缓存验收。

## 实际覆盖

- **升级保留**：源/译 PDF SHA、原生 annotation key/内容摘要、基线独立 note key/parent/HTML SHA、translation record 归属、provider 配置、任务状态/缓存 sentinel；cold reopen 换进程、替换旧 engine marker，没有创建 backend model job。这里任务历史是隔离夹具，不是日常任务库；jobs 前后为零也不是网络抓包。
- **虚拟凭据**：仅隔离 PaperBridge 的 compatible / DeepSeek 两个 synthetic realm。非空替换保持 GUID、另一 realm 不变；含 NUL 的写入由原生 LoginHelper 拒绝，旧值保留；显式清空只清当前 realm。install 与首次新包 reopen 的 `logins.json/key4.db/cert9.db` 均匹配停机基线 hash；随后主动替换/清空可能改写存储，最终停机报告不宣称 NSS 全文件仍逐字节相同。未读取同步 API key，未复制真实凭据。
- **真实新 note**：在 Scikit-learn 译文物理第 **2** 页，用可信 Gecko 鼠标拖选真实“机器学习”，点击 production split 的 selection-note 按钮；再用原生 highlight 工具拖选、等待 annotation 实际保存，点击 highlight-summary-note 按钮。前者不制造替代 annotation；后者保留真实 text/geometry，summary 不改 highlight。官方编辑器初始化并显示已保存文本，两 PDF 字节和源 PDF 的无批注状态不变。
- **note 内容与归属**：核真实论文 citation/title、译文 annotation provenance、源/译 exact keys、HTML SHA 和原生 parent；cold reopen 仍恰好两条独立 note，保存的 highlight 摘要与 HTML SHA 相同，正常打开编辑器不改内容。高亮 note 显示 PDF 的 printed page label **2826**，但实际 URI 页码仍为物理第 2 页。
- **native backlink 路由**：取 note 已保存的实际译文 URI，交给 `ZoteroPane.loadURI`，等待真实 reader 到第 2 页及 summary 的 annotation selection。源 backlink 只核 URI 身份；**未测编辑器 hyperlink 的真实鼠标点击，也未单独路由源 backlink**。最终报告没有 `nativeInternalLink`，不宣称额外 PDF 内部 citation 点击已通过。
- **设置/诊断/任务窗口**：两种模式每次 native/cold 均有 settings/tasks 四个实际窗口布局：普通 outer **860×760**、窄 outer **380×620**；最终 150% inner 为 **845×723 / 365×583**，旧 100% 为 **844×721 / 364×581**。逐控件检查滚动后可达、启用控件 hit-test、按钮标签及 body 无水平溢出（允许 2 CSS px 边框舍入），真实点击诊断 disclosure、任务 details，并保存 action/details 截图。任务窗口为一个隔离 record；不代表所有任务状态、错误或全部设置动作被点击。74 张原生 viewport PNG 已离线查看，未见这些样本的明显水平重叠/编辑器空白；不是所有 DPI/主题的人工 UI 验收。

### 最终新 note 的可复核身份

`*-windows-notes-native.json` 保留以下完整 HTML/annotation SHA 与 URI；selected-text SHA 两模式均为 `e0ab0981aba5c06da59128fbbbd5877bc167abd3429c01ba5dc160f3c5fae6ba`。

| 模式 | paper / source / translated key | selection note key / HTML SHA-256 | summary note key / HTML SHA-256 | highlight key |
| --- | --- | --- | --- | --- |
| bundled | `TJWLGP8D / Q3JNZPEJ / V79SMYAP` | `79WXNV4B` / `5c1362ada577a7c212bf9f8a36fae43ab804147e996995e92cec8599c46f6729` | `ZN5PF2AS` / `a043b4b20296c82c92c40b7299a5b629c97ac35e04930d64dc36932c74045fa4` | `FTYVRSHH` |
| local | `TMUJXAY8 / QJKYZRK8 / XDC9URJZ` | `7TCCEW55` / `438713df13ae06d297e2efe8c7410b57219ac69155777788e507bf68d55ced64` | `5IJX765R` / `1440a8b1c0d5c59387949c659012dd6d720b8afeec9d5ec833e8cf853449273e` | `CSNGBF9H` |

### 诊断 ZIP 隐私三场景

每模式三份实际 ZIP 均仅有 `diagnostics.json`（schema 2 / allowlist_only）；检查解码后的字符串，排除虚拟凭据、文档标记、原始 fault 与用户路径，四个 `*_included` 隐私标志均 false。保存 ZIP 的 SHA 与 `reopen-native.diagnosticEvidence` 一致：

| 场景 / 实际范围 | bundled ZIP SHA-256 | local ZIP SHA-256 |
| --- | --- | --- |
| backend 可用，`export_source=backend` | `153a57e1b5addc6d2331d5486ffa8a6b516db81142a3de3778db924564880a9d` | `e792c36c536bbd075e0f4d7f915cfb4e836829867599a335e51b04884b860d5c` |
| 隔离 extracted `server.py` 注入启动异常，resource 分类，`addon_only` / 引擎版本 unknown | `f03874ff39e9ce57ea54d4a70f715c3825d3df04e9aaa4a1c79516ff2b54a530` | `a04e8d44a0a25549cd546a05994c8ee84364297b787c8a96c6cb4794907047db` |
| 把隔离 state 指向普通文件，ZIP 写入回退 OS temp，`addon_only` | `5407156a78623efdc1566d6db9691d40da805a01dbfe5baa7375574c7594bdbd` | `9485d6a078668efa845e51448f0869c4d4264d0145b4206e6b2e828aad9599aa` |

异常后还原隔离 server/state，实际 `/health` 恢复。后两项是明确标注的局部注入，不冒充物理资源缺失或 NTFS/NSS 权限写失败。

## 100% 与恢复证据

标准 Windows Settings 控件 `SystemSettings_Display_Scaling_ItemSizeOverride_ComboBox` 实际执行 **150%→100%→恢复150%**，未用 registry、自定义缩放或 CSS zoom，没有注销/重启或关闭其他应用。`scale-settings-actual100.json` 结束时间为 **2026-11-16 01:04:21+08**；旧包两次 cold100 的 launcher 查询分别为 **01:04:28 / 01:04:48+08**，真实窗口 DPI **96**。`scale-settings-restored.json` 于 **2026-11-16 01:05:09.0627924+08** 恢复，`restoredToInitial=true`、DPI **144**。初始值由 `scale-initial-current.json` 记录。

原始缩放报告来源是远端 `E:\PBAssets-1115\agent\codex\windows-p1-3-20261115-2220\`。最终候选四阶段则在恢复后的 **01:17–01:20+08** 运行，`.launch.json` 均为 150%，且 `osScaleChangedByLauncher=false`。**最终候选精确字节的 100% 重跑仍未完成**；本页不借用旧 SHA/ID 关闭这一缺口。

## 证据与维护入口

- 本机证据目录：`agent/codex/continuation-20261116/windows-evidence/`。只读 SSH/PowerShell 复制 **27 JSON、6 ZIP、74 PNG**；`copy-manifest.json` 记录每份远端路径、长度和 SHA，本机字节与远端 `Get-FileHash` 一致。JSON 中 `.launch.json` 保留原始 BOM，不重序列化。未传输 XPI、NSS、账号数据库或凭据。
- `scripts/prepare_nonmac_test.py`：`--suite upgrade --phase create|install|reopen`，显式 baseline/candidate/expected XPI 与 case manifest；`--windows-supplement exercise|notes|reopen|views` 仅原生 Windows reopen 可用。exercise/notes 新建独立 note state；views 保留已有 state 路径；reopen 使用前次 identity；`--report-label` 保留旧报告。create 安装 test helper，后续只换外部 options，不重新复制候选充当安装。
- `tests/upgrade_packaged.js`：AddonManager 安装、保留检查、虚拟 credential、三场景诊断、正常退出及 supplement 调用。`tests/windows_supplement_packaged.js`：可信输入、新 note、冷重开身份、真实 URI 路由、窗口布局/截图，仅收尾自身窗口/reader。
- 整合后的本地检查：Python AST、两份 JS 与生成 helper 的 `node --check`；既有 Node focused **26 passed**、Python diagnostics/errors **29 passed**；一次 preparation-only smoke 核 exercise→views→cold 的 state 与 helper 不变。两处辅助修正（state 路径保留、释放状态的 mousemove）**没有再做 Windows UI 重跑**，不把本地 smoke 当成原生通过。

## 可勾选范围 / 不可勾选范围

- [x] 两模式最终精确 SHA 的 0.3.4→0.3.6 AddonManager 本地安装、150% 原生 exercise 和冷重开；限定隔离夹具的保留检查。
- [x] 两模式真实 selection note、highlight summary note、HTML/hash/parent/citation/provenance、冷重开；已保存的译文 backlink 经 `ZoteroPane.loadURI` 路由。
- [x] 两模式三场景实际诊断 ZIP 的 allowlist/privacy；后两场景仅证明所述注入分类/回退。
- [x] 两模式普通/窄 settings/tasks 布局、诊断 disclosure 与 task details；最终包为 150%，旧包另有 100% 冷重开。
- [x] 实际标准 Settings 150%→100%→恢复150% 周期，恢复时间及原生 DPI 有独立证据。
- [ ] **最终 SHA 的 100% 冷重开**；旧包同运行时文件内容证据不足以勾选最终字节的两档缩放全验收。
- [ ] **真实权限/物理错误**：NSS/NTFS 权限或磁盘写失败、long path、file busy、真实缺资源；NUL validation 与注入故障不是这些场景。
- [ ] 编辑器 hyperlink 实际鼠标激活、单独路由源 backlink、最终包 PDF 内部 citation 点击、未列出的 UI/错误组合。
- [ ] 真实日常账号 Windows 验收及真实两设备 metadata/文件下载/多译本/group；**Windows 日常账号助手尚未成功安装**，由主代理另行处理，本页不能宣称通过，也不开启文件同步。
- [ ] 公开自动更新、完整许可证闭环、双语语义接受及整个 P1-3 无缺口完成。
