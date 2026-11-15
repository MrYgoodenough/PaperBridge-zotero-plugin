<!-- Scoped continuation results, exact source delivery, and unresolved account/release requirements. -->
# P0/P1 许可与 Windows 验收接续简报

## 结果

- P0-1：原始许可补充及对应源码交付工具已整合，四个新候选包与源码 ZIP 字节绑定通过；法律合规仍 unknown、对应源码义务闭环 partial，不能宣布许可完成。
- P1-3：最终 Windows bundled/local 两模式在实际 150% 下完成 0.3.4→0.3.6 原生文件安装、新 note/批注汇总、保存 URI 路由、诊断隐私与冷重开。旧包 100% 证据另列，未借给最终 hash；物理权限/缺资源等剩余场景未完成。
- P1-4：真实账号两设备 metadata、文件下载、多译本/group 未完成。Windows 日常测试助手未成功注册，插件仍 0.3.4；没有把脚本或原生输入派发当作同步成功。
- P1-5：未发布 0.3.6 资产，四条 Linux/Windows 稳定 feed 仍 0.3.4；macOS 0.4.2 及 Latest 未改动。
- 已通过 GitHub API 更新 TODO issue #1，随后公开 GET 核对正文完全一致；只勾选明确范围，许可、账号、发布缺口保留。根 TODO 文件未修改。
- 源码已普通快进同步 master，源码交付快照为 d637701b862184b66c49e995059aa08c388b7f8d。本报告与最终 delivery 身份为同轮文档补充，不改变该快照的构建/发货源码。

## 改动与交付

- 保留原始第三方许可、Microsoft 官方文档及固定源归档；补齐全部 243 个历史 Cargo.lock registry 候选。tiktoken 官方 wheel 的 native bytes 匹配不等于恢复其原始完整传递依赖图，也不单凭缺 lock 制造重建门槛。
- source generator 对 manifest 只应用 build.py 明确的平台/模式 update_url 转换，其他字段和发货源码继续核对；修复平台重写导致的误报。
- 四包许可重打包后分别核 SHA；Windows 运行时 6535/5962 个文件内容与旧基线逐个相同，但 ZIP 属性使 payload hash/build ID 改变，不能借用旧身份。
- 账号 helper 增加独立输出目录及显式文件上传授权；metadata 的 fileLibraries/fullTextLibraries 为空。恢复偏好、写最终报告、正常 quit 之间不异步让出给背景同步。
- Windows 验收 helper 保留原生安装/冷重开分阶段；直接修复 views 丢失 note state 与鼠标预移动未释放按键的问题。辅助修正有 focused/smoke 检查，不扩大为新原生场景通过。
- 新增 Windows 精确范围文档、四包/source delivery JSON，维护路线图和 MEMORY；详细输入/阶段证据保留在 agent/codex/continuation-20261116，未写入 README。

### 最终本地源码交付

- ZIP：dist/candidate-20261116/paperbridge-0.3.6-linux-windows-source.zip；887,263,096 bytes。
- SHA-256：838ad271f4179fae3cce09dc28fcc4349247360affd7a917401f33fc5decaa77。
- 303 个固定归档、24,373 个 indexed files 全部重 hash；internal manifest 与外部 sidecar 相同，外部 SHA 另核。
- projectSnapshot 从已提交源码生成：无包含未跟踪文件或修改的 tracked source；四包 deliveryFilesMissingOrChanged 与 projectSourceSnapshotMismatches 均为空。
- 精确四包 SHA/build ID 与上述记录见 docs/candidate-delivery-0.3.6.json；历史阅读/清理 identity 仍保留在原 verification 文档，不回填新 hash。源码 ZIP 仅本地准备，未作公开交付。

## 实际检查

| 检查 | 结果与边界 |
| --- | --- |
| 合并后 full 离线 | 304 passed、1 skipped；39 JS 语法检查、24 Node suites；0 failures，不代表账号/人类质量接受 |
| manifest source matching | 四个实际新 XPI 及错误 version/name/update URL 共 16 checks，通过 |
| 最终 Windows bundled | create/install/reopen-native/reopen-cold：7/17/300/231 checks；各 ok/complete，四个真实不同 PID |
| 最终 Windows local | 同四阶段：7/17/304/235 checks；各 ok/complete，四个真实不同 PID |
| 安装身份 | install 候选输入 SHA 与 reopen 实际落盘 XPI SHA 分开核，均匹配最终包；未把安装前顶层字段冒充新版本 |
| Windows 证据整合 | 107 份隔离证据远端/本地 SHA 一致；6 个诊断 ZIP 的 entries/CRC/schema/privacy 检查通过 |
| focused 辅助检查 | Node 26 passed、Python 29 passed；prepare/helper smoke 与语法检查通过 |
| 停机完整性 | Windows 隔离最终 SQLite/cache integrity ok；日常失败安装清理后 SQLite integrity ok |
| whitespace | 自写源码/文档通过；全范围原始许可有既存尾空格/换行，刻意保留原文与 hash，不改写原许可凑通过 |

## 账号、安全与接续限制

- 两端账号 LostPatrol 的停机备份留在各自宿主；未跨设备传输日常数据库/NSS/凭据，未发起新翻译或付费探测。
- Windows 日常安装尝试明确失败，随后仅正常关闭本轮窗口，未强杀；user.js 移除、autoSync 的无 user value/default true 恢复，文件同步仍 false，原 0.3.4 XPI SHA 未变、helperRegistered=false。
- Linux 本轮日常 PID 2185669 仍待用户正常退出，autoSync 临时 false 尚未清理；原值为无 user value/default true。已有清理进程等待正常退出，确认 first-launch-cleanup.json/user.js/偏好恢复后才能再次启动；不强杀或修改运行中数据库/NSS。
- 免费 Zotero Storage 300 MB 不用于全库附件上传。metadata 与文件下载是不同验收；无明确授权文件方案时，真实文件/多译本/group 继续未完成。
- MSVC 14.44.35211.0/14.40.33810.0 的适用分发者许可与具体未改 DLL 分发依据、AGPL/GPL/Berkeley DB 源码/交付及适用服务源码义务仍待闭环。Runtime 使用 EULA 不是再分发授权。
- 人类双语/视觉接受、最终包 100% 独立重跑、真实物理错误与编辑器链接鼠标点击等未完成范围如实保留；原生普通路由、注入故障和合成凭据不替代这些要求。
- 同步使用 Windows 既有 GCM 与 Git bundle，token 仅宿主内存使用；原 Windows checkout HEAD、工作文件状态与 stash 指纹保持，不签出/重置/清 stash，不建分支/worktree、不强推。
