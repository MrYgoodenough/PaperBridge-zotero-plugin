# Windows 验收、轻量跨平台 CI 与更新清单修复

执行者：Codex；日期：2026-11-14（Asia/Shanghai）。
目标：使用 `desktop-hz` 验证当前 Windows 包，建立三平台基本兼容性 CI，直接修复公开更新清单 404。

## 1. 当前基线与完成范围

- 生产源码提交：`d1ccc229e32f3cf87d8eaf04970f975cce1b349d`，已同步远端 `master` 和 Windows 工程；没有新分支或 worktree。
- 本分支为共享源码 **0.3.2**，不含尚不可获得的 macOS 0.4.2 专属实现；未替换该 macOS 资产。
- `ssh desktop-hz` 已配置独立公钥与 `IdentitiesOnly yes`，实测免密码连接成功；旧 Windows 授权文件备份保留，密码和私钥没有写入仓库或报告。
- Windows 使用工程内的隔离 Python、Zotero profile/data 与新包，没有覆盖日常安装、原工程根 `dist/`、历史 stash 或备份。

## 2. Windows 实机验收

环境：Windows 11 build 26200、Zotero 10.0.8；自带 Python / 本地 Python 两种当前 XPI 分别运行。

| 检查 | 自带 Python | 本地 Python | 限定范围 |
| --- | ---: | ---: | --- |
| 原生批注创建、全文拖选、评论、关闭保存、删除、重开 | 21 | 21 | 真实 Zotero 原生交互 |
| 独立进程重启后的批注持久化 | 8 | 8 | 实际重启，不是仅重建阅读器 |
| 保留的本地 0.3.1 手动升级基线 | 4 | 4 | 旧包检查，不计入当前版本 124 项 |
| 升级到当前包、诊断 ZIP、中文渲染、内部链接点击 | 16 | 16 | 真实译文显示；链接为合成 BabelDOC 样本 |
| 任务、设置及恢复界面 | 17 | 17 | 模型结果明确模拟，没有服务商调用 |

- 共 **132 项**（含 8 项旧版基线），其中当前版本 **124 项**；10 次最终原生进程退出码全部为 0，6 个最终数据库完整性全部为 `ok`。
- 所有最终报告 SHA-256 再次与验收索引核对一致；两种 Windows 包与 28 个发货源码文件一致，实际安装哈希匹配。
- 链接验收使用实际焦点、稳定视口和 trusted mouse click，由第 2 页跳到第 1 页；没有用直接设置页码冒充点击。
- 2026-11-14 07:42（Asia/Shanghai）复核：无本轮 Zotero/backend 原生测试进程、无匹配的临时计划任务；原 stash 与历史备份仍在。

| 当前 Windows 包 | SHA-256 |
| --- | --- |
| 自带 Python | `862b337e56970e419217856f4d37fe1ebf9e1819661ed4711184cc85e2ac89ec` |
| 本地 Python | `5a2bea86d43d54769643e3ba691c13e6ab1de3ba08759b72b5375ea367203d01` |

验收索引：`.runtime/p0-p1-windows-native-verification-20261114.json`；原始最终报告：`.runtime/windows-p1-native-20261114/`；四包源码/哈希索引：`.runtime/p0-p1-artifact-verification.json`。

### 未计为通过的初次尝试

- 拖选未包含末尾句号：修正测试鼠标终点，保留精确全文断言。
- 历史包在最长目标 271 字符的目录解包失败：改用短隔离 run ID，未更改系统长路径设置；极深 Windows 数据目录仍未认证。
- 一次链接已解码但未导航：修正测试的焦点、视口等待及 trusted mousemove，两种模式均从全新旧版基线重验。
- 初次任务套件缺少既有合成 PDF：补传原 fixture，以全新 profile 重验。
- Windows launcher 初次缺 PyMuPDF：将既有同版本原生依赖复制到所选测试 `.venv`，26 个文件哈希匹配；没有改生产 launcher、放宽断言或添加 skip。

这些失败保留在验收索引，不纳入最终通过计数。

## 3. 轻量跨平台 CI

实现位于 `.github/workflows/ci.yml` 与 `scripts/check_offline.py`：

- Linux / Windows / macOS 三平台矩阵，Python 3.12 / Node 22。
- 仅安装 pytest 9.1.1、PyMuPDF 1.26.7、httpx 0.28.1；不安装 BabelDOC/模型，不构建大型 runtime，不调用服务商。
- 检查 Python 语法、核心单测、23 个 JavaScript 语法检查、7 个 Node 脚本，以及六个平台/Python 模式启动契约；契约模拟不冒充原生执行。
- 保留完整引擎的本地 `full` 模式。轻量模式明确排除完整引擎/科学依赖用例；1 个原有参考 PDF 用例因样本不存在跳过，另 1 个真实 SDK 适配器用例被明确 deselect。
- setup-uv 使用存在的 `v10.3.3` 完整 tag，不使用不存在的 `v10` major alias。

| 已有本地检查 | Python / Node | Python 单测结果 | 其他离线检查 |
| --- | --- | --- | --- |
| Linux full | 3.12.16 / 22.23.5 | 221 passed，1 skipped | 通过 |
| Linux lightweight（最少依赖） | 3.12.16 / 22.23.5 | 187 passed，1 skipped，1 deselected | 通过 |
| Windows full | 3.12.13 / 24.22.2 | 221 passed，1 skipped | 通过 |
| Windows lightweight | 3.12.13 / 24.22.2 | 187 passed，1 skipped，1 deselected | 通过 |

### GitHub 三平台实际结果

Run `43528230775`、attempt 1、`push / master`，于 2026-11-14 07:36（Asia/Shanghai）完成，最终结论 **success**。Run 元数据、三个 job 元数据与各自 checkout 日志的 SHA 均为 `d1ccc229e32f3cf87d8eaf04970f975cce1b349d`。

| 远程 job | Job ID | 实际 Python / Node | 最终结论 | Python 单测 |
| --- | ---: | --- | --- | --- |
| Core offline (ubuntu-latest) | 132239166467 | 3.12.3 / 22.23.4 | success | 187 passed，1 skipped，1 deselected |
| Core offline (windows-latest) | 132239166712 | 3.12.10 / 22.23.4 | success | 187 passed，1 skipped，1 deselected |
| Core offline (macos-latest) | 132239166845 | 3.12.10 / 22.23.4 | success | 187 passed，1 skipped，1 deselected |

每个平台的全部 workflow steps、7 个 Node 脚本、23 个语法检查及六种模拟启动契约均通过，checker 为 `0 failures`。macOS 有 5 条 SWIG 类型 `DeprecationWarning`，非失败，没有为此改源码或压制警告。

最终 run/job 元数据和原始日志已核对，日志 SHA-256 匹配汇总索引 `agent/codex/ci-remote-20261114-summary.json`。本报告与 MEMORY 的收尾同步仅改文档，不修改受验生产代码；文档提交可使用 `[skip ci]`，真实 CI 验证的是上述生产源码提交。

## 4. 更新清单 404：原因与直接修复

原因有两层：

1. 构建只生成本地 `dist/updates/` 草稿；修复前公开 `master` 根本没有安装器请求的 `updates/` 目录。不是把分支路径拼错。
2. 仓库级 `releases/latest/download` 不是平台回退：2026-11-14 07:45（Asia/Shanghai）GitHub API 确认最新 Release 为 `v0.4.2`，只有 macOS 自带 Python XPI，Windows/Linux 资产不能从中下载。`v0.3.2` Release API 仍返回 404。

直接在缺失对象上增加四个根目录清单并推送，不另建下载服务或绕过检查：

| 公开 `master/updates/` 文件 | 精确原始 URL HTTP 状态 | 内容 |
| --- | ---: | --- |
| `linux-x64.json` | 200 | 合法空更新列表 |
| `linux-x64-local-python.json` | 200 | 合法空更新列表 |
| `windows-x64.json` | 200 | 合法空更新列表 |
| `windows-x64-local-python.json` | 200 | 合法空更新列表 |

2026-11-14 07:42（Asia/Shanghai）逐个核验了实际安装器地址，**没有添加 nonce 或查询串绕过缓存**；四份返回体与提交文件逐字节一致，SHA-256 均为 `436b1b104c8f1772ad4c8fdfbfc9a6a97a10b47898a48117cfde85b0bbc87c1b`。

清单 `updates: []` 的含义是**暂无已发布更新**，不是发布或自动升级成功。未上传 XPI/校验文件、创建 tag/Release 或广告尚未批准的包。macOS 两条通道未修、未改。

只读执行 `verify_release.py --online` 检查本地 Linux 0.3.2 草稿，正确返回 1 和 `PUBLICATION-NOT-VERIFIED`：公开空清单与本地非空草稿不同。本地 XPI/校验/草稿仍为 `LOCAL-CONSISTENT`。没有削弱发布检查来伪造成功。

发布工具报错已区分缺失的清单、tag、XPI 和 checksum；维护说明见 `docs/releasing.md`。旧安装器若仍内置 `example.invalid`，需要手动安装一次新包，新增公开文件无法改写旧安装器 URL。

## 5. 边界与未完成项

- 未进行 macOS 原生 Zotero 或缺失的 0.4.2 源码验收；轻量 CI 不替代原生阅读器、完整引擎或打包认证。
- 未完成公开 0.3.2 发布和 Zotero 自动更新安装验收；需要先确认并上传对应平台的 XPI 与校验文件，再发布非空清单。
- 未进行代表性论文的人工中文/双语排版与语义接受。既有两篇真实 DeepSeek 样本仍为 partial，不能包装为完整质量通过。
- 本次 Windows/CI/清单收尾 **0 次新增付费调用**。此前用户已允许的 DeepSeek 检查仍限定既有两页，不扩展授权。
- BabelDOC 0.6.4 的既有解析安全迁移（P0-2）仍未解决，不属于本次 CI/清单修复的完成范围。

收尾证据位于 `agent/codex/update-feeds-public-20261114.json`、`release-scope-after-source-push-20261114.json`、`update-public-draft-boundary-20261114.txt`、`windows-final-cleanup-state-20261114.json`、`final-acceptance-binding-20261114.json` 和 `ci-remote-20261114-summary.json`。这些本地过程文件按仓库规范不公开；本报告单独版本化。
