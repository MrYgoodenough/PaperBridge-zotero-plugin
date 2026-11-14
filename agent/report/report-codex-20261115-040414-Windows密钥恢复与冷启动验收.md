<!-- Scoped Windows repair/cold acceptance, retained failures, and verified native credential/shutdown contracts. -->
# Windows 密钥恢复与冷启动验收

## 结论

在用户明确授权下，**只恢复 PaperBridge 原始密钥并完成 desktop-hz 的限定 Windows 验收**。同一日常 profile 的真实冷启动、实际插件/后端、文献库及批注保留通过；非 macOS 功能交付收尾完成。生产代码、已发布 0.3.4 包及更新通道未改动，本次不重建或覆盖资产，macOS 未操作。

原验收误触“保存设置”导致的真实 PaperBridge 密钥变化是操作失败，**没有改写成“原来就通过”**。原始失败 index、driver、报告及加密备份仍保持；修复后结果为新的限定验收。

## 原生实测

| 项目 | 结果 |
|---|---|
| 只恢复 PaperBridge 密码 | 原生 LoginManager `modifyLogin` 一次；保留当前记录身份，不回滚整库 |
| 恢复直接非干扰 | 其他两条凭据全部存储字段与紧邻恢复前快照一致 |
| 正常退出与冷重开 | 原生 PID 16716 正常退出 0，原后端 39348 已结束；所有 Zotero 进程实际消失后审计，再原配置启动 PID 35104，无重装/重置 |
| 冷启动后实际密钥 | PaperBridge 默认及显式 DeepSeek getter 与原始备份严格相等 |
| Zotero 同步密钥 | 原始/恢复前/停机/当前的实际值相等；加密镜像经 native NSS **及** `Zotero.OSKeyStore.decrypt()` 解密后相等 |
| 当前原生插件/后端 | 0.3.4 激活；XPI SHA-256 与公开包一致；health/service/marker 均 0.3.4，build ID 一致，后端 PID 42772 的实际父 PID 为 35104 |
| 文献库 | `integrity_check=ok`；698 条 items、285 条附件、19 条批注；六个核心表哈希与原始停机库完全一致 |
| 用户状态 | PaperBridge 非秘密设置、账号身份/设置、NSS key 文件、任务记录保持；任务数 0 |
| 副作用与交接 | 未提交翻译或服务商请求，未装 helper；自有临时任务 0；日常 Zotero 和原生后端留运行 |

最终活跃后端检查时间为 **2026-11-15 04:00:02（Asia/Shanghai）**，不是沿用此前已经结束的 health。

## 两项核查更正

1. **Zotero 镜像不是实际密钥变化。** 官方 Zotero 10.0.8 的 `getAPIKey()` 优先读取 `Zotero Web API`，可能将相同 key 重新加密写入 `Zotero Web API (encrypted)`。它不是纯只读接口。原生已明确匹配这两个 realm，并对原始和当前镜像解密比较，证明实际 key 不变；此前“原因未明”的变更可限定为与官方重镜像行为一致的密文变化，不声称追踪到具体启动调用者。最后的逻辑密钥审计没有调用该可能写镜像的 getter。
2. **Windows 自有后端退出 127 符合现有契约。** addon 正常 shutdown 调用已有 `Subprocess.kill()/wait()`；Gecko Windows worker 用 `TerminateJobObject(..., 0x7f)`，所以 OS 句柄观察到 127，而 JS wait 会归一化为 -9。原生 app 退出码确实为 0；不是外部测试器强杀，也不能称为后端 watcher 自然退出 0。即时观察仍有子进程且严格谓词为 false，随后独立核对全进程消失才查 SQLite。原始日常两次退出未保留 native 句柄，因此旧报告所列 `[0,0]` 已在当前摘要纠正为 `[null,null]`，不拿验证脚本退出码冒充原生退出码。

相关官方源码：[Zotero 10.0.8 同步密钥](https://github.com/zotero/zotero/blob/3b17983092c48dba35588ae088d09ea360252a34/chrome/content/zotero/xpcom/sync/syncLocal.js#L63-L105)、[OSKeyStore 封装](https://github.com/zotero/zotero/blob/3b17983092c48dba35588ae088d09ea360252a34/chrome/content/zotero/xpcom/osKeyStore.js)、[Gecko 140.17.0esr Windows 终止契约](https://github.com/mozilla-firefox/firefox/blob/6fed6a98fa2b24fe2dcb9bd3e7f13569ce24aeea/toolkit/modules/subprocess/subprocess_win.worker.js#L413-L426)。仅核对公开源码，未逆向二进制或调用账号/服务商 API。

## 证据与仍为 false 的检查

- 新限定 index：`agent/codex/nonmac-finish-20261114-201038/windows-daily-034/repair-20261115-0324/repair-accepted-index.json`，SHA-256 **`f87fe943651b851fc5afefcf6404483d97ea15fa98c2f988e416d2420f56facb`**；Windows 独立复核 **240** 个公开证据引用的大小/哈希完全一致。
- 原始失败 index/driver/report SHA-256 分别为 `6c89faf03edcb779989d3e3743d86f4cf648be4e766096b90f4b72129dad8880` / `46df97fe03a0c1ff1b24741cb9e45bdce46e434b8b9cfbaad83a848d8797e6b3` / `3519a7f907ca5469e435f60743f43c7fd6d28ebd41a703fede289857e255fb78`，本次实机仍一致。
- 原始全库、prefs、login 文件的字节完全相同仍为 false；库差异仅为 `libraries.lastSync`、`version.version` 的已列字段，六个核心表不变。加密镜像的存储字符串完全相同及其冷启动严格谓词仍为 false；新的逻辑密钥比较不覆盖这些 false。
- 首次最终 host 验证脚本把未设置的 PowerShell `$LASTEXITCODE` 当健康失败，未写 final-host；health 本身为 true。保留该任务脚本失败记录后，在原对象上改为读取新 health JSON 的 `accepted`，新文件验证通过；无用户 profile/进程修复动作。
- 既有 **20** 份四种包原生读取/悬停/自动更新报告再次核对哈希及全部断言，没有重跑或提交新的翻译。原生产 XPI 四份哈希仍一致。

## 范围限制

- 悬停功能仍按可追溯请求片段映射：独立右下开关、默认关闭、双向浅色背景、非法区域跳过、原生批注与选择层不改写。既有 38 个真实请求单元和合成排除探针结果保持；跨页/移动/合并身份只排除，不猜配；分离多岛矩形仅是 fixture，非新增生产能力。
- 代表页结构与批注/冷启动已验收，不是全文人工语义验收；历史机构名断行、版权字形、作者层级等质量仍 partial。未添加句词映射，未测试服务商端密钥、余额或兼容服务，不提交付费请求。
- macOS 原生及其专属 0.4.2 源码/资产未触及；BabelDOC 0.6.4 既有安全/升级风险仍未解决。

当前公开摘要为 `docs/nonmac-verification-2026-11-15.json`；只更新真实现状和维护要点，不改 `TODO.md`、README、生产实现或发布通道。
