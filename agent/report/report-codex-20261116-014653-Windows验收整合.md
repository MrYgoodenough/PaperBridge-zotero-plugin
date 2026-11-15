<!-- Windows acceptance integration results, preserved evidence, and unresolved coverage. -->
# Windows 验收整合简报

- 日期：2026-11-16 01:46:53 +08；执行者 Codex。本机 Linux/bash，远端 desktop-hz 只读 PowerShell。
- 范围：只编辑指定三个验收辅助源码，新增 Windows 文档及本报告。保留上一 Windows 代理的 install/preservation/diagnostics/native-note 实现；未创建分支/worktree、提交推送或修改 TODO/MEMORY/README/feed/delivery/历史 verification。MEMORY 留主代理维护。

## 具体改动

1. `scripts/prepare_nonmac_test.py`：保留现有 install 阶段、Windows supplement 参数与 helper 加载；直接修复独立 views 阶段丢弃已有 note state 路径的问题，使 exercise→views→cold 仍使用同一身份。现有报告冲突提示允许新 report label；维护英文文件/局部说明。
2. `tests/upgrade_packaged.js`：保留原生升级、合成 realm、PDF/note/hash 保留、诊断 ZIP 及正常退出；两处真实鼠标预移动显式传入 released buttons=0，避免 Gecko 默认按键位延长旧选区。未改变 production 插件代码。
3. `tests/windows_supplement_packaged.js`：保留上一代理未跟踪的完整 bounded supplement；仅澄清系统缩放/visual QA 依赖外部证据，不把 supplement 自身能力或旧 remaining 字段当成整个系统验收结论。
4. `docs/windows-acceptance-0.3.6.md`：逐模式列准确 SHA/build ID、7/17/300/231 与 7/17/304/235 checks、真实 PID、退出来源、安装输入/落盘 SHA 区别；列真实 notes/HTML/归属/冷重开/backlink 路由、三场景 ZIP 隐私、普通/窄 settings/tasks。新增可勾选与不可勾选清单。

以上路径均相对于项目根 `/home/scq/PaperBridge-zotero-plugin`。本轮代码增量仅辅助修正及注释；大部分 git diff 为进场前已存在的 Windows 实现。

## 既有真实证据

- 只读复制到 `agent/codex/continuation-20261116/windows-evidence/`：27 JSON（含阶段、launch、note state、旧 cold100、系统缩放和最终停机摘要）、6 allowlisted ZIP、74 native PNG；每份字节 SHA 与远端 Get-FileHash 相同，copy-manifest.json 保存路径/长度/hash。未传输候选 XPI、NSS、账号数据库或凭据。
- 最终 bundled：`b13d1a0a795ad80a5677ad1707962a4a1defbf2195fc46f94aa683437752dfba`；最终 local：`c56598415f55b6e0789f723b2ce6b02692b035fee45ccdca36ffd005f3af80c0`。与主代理 candidate-delivery 的对应 SHA/buildId 核对一致；不改历史原生 hash。
- 最终 wp13fb16 / wp13fl16 四阶段均 ok/complete、不同 UI PID、实际 150%/144 DPI。主代理 session11616 两模式驱动 exit0；只读核 launcher 等待真实 UI PID 正常退出的代码与停机 integrity 摘要；未单独采集 Zotero UI 数值 exitCode。
- 旧 wp13b2/wp13l2 cold100 分别 231/235 checks，实际 96 DPI；Windows 标准 Settings 从150%到100%后，于 2026-11-16 01:05:09.0627924+08 恢复150%。新旧运行时文件内容6535/5962逐文件一致但ZIP属性/payload SHA/buildId不同，旧100%不冒充最终字节重跑。
- 离线查看全部74 PNG 的六张 contact sheet，未发现这些样本明显水平重叠或新 note 编辑器空白；原生几何/hit-test约束来自既有报告，不扩大为全UI人工通过。

## 本轮检查结果

| 检查 | 结果 |
| --- | --- |
| 项目 .venv/bin/python AST；两份 native JS node --check | 通过 |
| 生成 helper bootstrap 的 node --check；preparation-only smoke | 通过：page metadata、exercise→views→cold state、helper字节不变、已有报告拒绝覆盖 |
| 现有 Node credentials/addon_diagnostics/settings/task_window/notes/packaged_startup focused | 26 passed，0 failed |
| 现有 Python diagnostics/errors focused（禁外部pytest插件/缓存，清PYTHONPATH） | 29 passed，0 failed |
| 107份远端证据 hash；6份ZIP entries/CRC/schema/privacy与报告SHA | 通过 |
| 限定源码 git diff --check、文档 SHA/build ID/checks 对照 | 通过 |

检查日志及本地派生图片只放 `agent/codex/continuation-20261116/windows-integration-checks/`。没有重复主代理 full offline，没有重跑Windows UI、改变远端状态/系统缩放、候选包、许可证缓存或日常profile；辅助代码修正仅本地语法与focused/smoke覆盖，未追加原生通过结论。

## 未完成 / 不能勾选

- 最终两个 SHA 的100%原生冷重开尚未完成；整个P1-3不能无缺口关闭。
- 物理NSS/NTFS权限或磁盘写失败、long path/file busy、真实缺资源未测；NUL原生拒绝与隔离启动异常/非目录state注入不替代真实权限场景。
- 编辑器hyperlink实际鼠标点击、源backlink单独路由及最终包额外PDF内部citation点击未测；现有通过仅译文保存URI经ZoteroPane.loadURI到物理页/annotation。
- Windows日常账号助手尚未成功安装，metadata真实两设备/文件下载/多译本/group不由此隔离验收证明。主代理独立处理，不干预官方RunJavaScriptUI、不自行开启文件同步。
- 未完成法律许可闭环、双语语义接受、公开候选自动更新/发布；未美化这些结论。
