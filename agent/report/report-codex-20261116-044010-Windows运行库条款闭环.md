<!-- Completed Microsoft-runtime consent scope, exact delivery identities and remaining limits. -->
# Windows 运行库条款闭环简报

- 执行代理：Codex。
- 完成时间：2026-11-16 04:40:10，Asia/Shanghai。
- 发货源码提交：`0082d6f874b61dd65a661ac2a0ab8047649142bf`。
- 交付证据提交：`ee14d9d292a6fb9eb63d64fd4a9163eca030011a`，已普通快进同步 `master`。

## 结论及用户影响

已按用户确认的 Community 2026 第 8 条条件完成微软 DLL 专属条款接入，
并用最终四包验证原生同意/豁免、已存 PDF 阅读、本地 health 和冷重开。
这是用户声明基础上的有条件分发路线与技术实现，**不是独立法律 clearance**；
整体 `licenseCompliance=unknown`、`correspondingSourceStatus=partial` 不变。

- 普通 Windows 用户仅在首次主动启用排版引擎，或从设置查看时，多一次明确确认。
- 相同条款身份 `msvc-community-2026-v1` 跨重启及插件升级保留；只本地保存身份，不上传。
- 无需安装 Visual Studio、注册微软账户、购买开发许可或另装 VC_redist；本机版原有 CPython 3.12 要求不变。
- 拒绝/关闭只阻止引擎启动；Zotero 及原文、已有译文 PDF 阅读保留，同会话不自动反复弹窗，设置允许重新考虑。
- 下游分发责任与只运行插件的普通用户区分；条款不限制 AGPL 插件整体或其他开源代码。
- Linux/macOS 不要求此 Windows 同意；实际 Linux 两模式另已核验，macOS 独立源码/发布物未操作。

## 实现与修复

- 新增 `runtime-terms.js`、`runtime-terms.xhtml`、`runtime-terms-window.js` 与离线完整文本；共享 `ensure()` 和直接 `launch()` 都不能绕过同意。
- 后台迁移、任务轮询、清理及诊断使用非交互路径，不弹许可窗口；设置展示当前状态。
- 设置接受在新库仍保持惰性，不立即解包/启动后端或建立无用轮询；遗留任务恢复回调不提交新翻译。
- 原生核验发现 Zotero URI overload 返回 XHR，已直接改用 ZIP UTF-8 输入流读取完整文本。
- 原生核验发现初始 `about:blank` 的 unload 被误判关闭，已直接改为观察真正 `domwindowclosed`。
- 保留 Community 2026、Runtime v14、VS2026 REDIST 的原始文件字节；三 DLL 内容/版本未替换，BabelDOC 0.6.4、PyMuPDF 1.26.7 未升级。

## 验证结果

| 平台 / 模式 | 当前 run | create / reopen 检查 | 退出与停机数据库 |
| --- | --- | --- | --- |
| Linux bundled | `msvc-lb4-16` | 33 / 25，通过 | 两 PID native exit 0；integrity ok |
| Linux local | `msvc-ll4-16` | 33 / 25，通过；reopen 使用新 `cold2` label | 两 PID native exit 0；integrity ok |
| Windows bundled | `msvc-wb6-16` | 85 / 51，通过 | 正常 quit 后两实际 UI PID 均消失；integrity ok |
| Windows local | `msvc-wl6-16` | 85 / 51，通过 | 正常 quit 后两实际 UI PID 均消失；integrity ok |

Windows 运行于真实交互 Session 1、现有 150% 缩放（窗口 DPI 144），未改系统缩放。
输入使用生产窗口的可信 `windowUtils.sendMouseEvent`，记录事件 `isTrusted=true`；
不是 DOM `.click()`、`dispatchEvent()` 或直接写同意偏好，**不声称外部 OS 鼠标注入**。
首次拒绝与接受后只读查看的窗口、四模式 synthetic PDF 截图已目视核对；
settings 状态另外经实际生产 DOM 断言，未声称全面重验旧 notes/UI。

- full 离线：Python **304 passed / 1 skipped**；43 JS 语法检查、13 Node suite commands；0 failures。
- 四包 `verify_release.py` 均 consistent；每包 188 个当前项目源码/内容/notice 文件与实际 XPI 一致。
- 条款固定 SHA：`f034f11c2072f5e6d03c276cc97687796a5223eef8743b945c5af975fa0ab402`，6,546 bytes。
- 三微软 DLL 已重新核对与原始微软证据相同；签名 Valid 的原始核实不扩大为完整 channel/catalog 供应链核验。
- 源码 ZIP：303 固定归档，24,408 索引文件逐字节重核；四包 source/notice 缺失/变化与项目源码不匹配均为 0。
- 对应项目源码快照 `fromCommitOnly=true`，无未提交/漏纳入的发货源码；仍为本地候选交付，未公开源码 ZIP。

### 最终私有包身份

| 平台 / 模式 | bytes | SHA-256 |
| --- | --- | --- |
| linux-x64 / bundled | 229,012,590 | `22d89e944502b1fdf8f5c1d6445b17791cd6de837732c75c5af44a223689968e` |
| linux-x64 / local | 191,094,352 | `96f2498d39c61ad71877d1600475bdaec2f12142e03091c8fc5038ce30bec57a` |
| windows-x64 / bundled | 199,727,955 | `7dae26ed67b72a201cb4ec3e99696771d96a01d2c26f149c96514d7995c1c9c9` |
| windows-x64 / local | 187,794,491 | `50a0720625938d5bffc7f0ba57594e8577c876e2bf042d7b72d4fa46f599ab85` |

源码包 `paperbridge-0.3.6-linux-windows-source.zip`：887,865,774 bytes，
SHA-256 `c8970aa12d824c2aea1270df57c25c3747347ce40a864102a996079eec5558ff`；随附 manifest 与 checksum。
位置：`dist/candidate-20261116-msvc`；303 归档缓存位置保留于 delivery 文档。

## 同步与安全边界

- 源码普通快进推送 `master`，未建分支/worktree，未 force push。
- GitHub [TODO #1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/issues/1) 已范围化更新并再次 GET 核对；body SHA `2a44b8f9187c19dc0f1b7d88bd6ada46702f87dbad812255d9b7afa5a3da7369`。
- TODO 仅勾选 MSVC 分发者确认、条款接入/当前原生范围，保留 GPL/AGPL/Berkeley DB、账号/人类质量与发布待办。
- 升级/notes/诊断、阅读/清理及 100% 的旧证据保持原 hash，未嫁接为新包整套验收。
- Windows 原工程 HEAD、工作树、stash 指纹前后相同；未动日常 profile/SQLite/NSS/账号或开启全库文件同步。
- GitHub token 仅在既有 GCM/进程内存使用，不记录；Session 0 的 wincredman 回填警告未阻止实际普通 push/API 操作，结果已独立读取确认。
- 未发新 XPI/release、未修改公开四条 feed/Latest；稳定 Linux/Windows 仍为 0.3.4，独立 macOS 0.4.2 不变。

## 失败尝试与未完成项

1. 旧 URI 读取和初始 blank unload 两个生产错误已直接修复，旧失败证据保留。
2. 外部 `sendNativeMouseEvent` 方案因接口/输入超时未通过，未改写成成功；最终限定为既有验证方式的可信 Gecko 原生窗口输入。
3. Gecko 140 不暴露 `Ci.nsIDOMMouseEvent` 的 helper 错误已改用有注释的 `MOZ_SOURCE_MOUSE=1`；最终两个 Windows run 重新完成。
4. Linux local 第一次紧接重开的实际引擎启动超时仍保留于 `runtime-terms-msvc-ll4-16-reopen.json`；新 label 冷重开通过，不代表已定位并修复快速连续重启的根因，生产 20s 等待未改。
5. 未重新覆盖旧版升级/notes/批注/诊断全部流程、当前包 100% UI、真实账号同步/权限失败或新增人类语义接受；无付费服务请求。
6. 整体 AGPL/GPL/Berkeley DB 源码充分性、相关构建/服务源码义务及公开同行交付仍待闭环；保留技术证据限制，不以普通工具链/字节重建未知自动要求换引擎或提高发布门槛。
7. Microsoft 原始 HTML 自带尾部空格，按固定 SHA 保留未格式化；自编文件 whitespace 检查通过，未为了 diff 检查改写原始许可证据。

继续入口：`docs/windows-msvc-redistribution.md`、`docs/windows-msvc-evidence-0.3.6.json`、
`docs/runtime-terms-acceptance-0.3.6.json`、`docs/candidate-delivery-0.3.6.json` 与 `MEMORY.md`。
本轮过程证据仅位于 `agent/codex/msvc-consent-20261116`；未生成用户 task 文件或修改根 TODO。
