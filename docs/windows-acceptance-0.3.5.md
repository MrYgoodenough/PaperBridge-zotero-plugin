<!-- Existing issue link retained; current native scope and remaining Windows checks are separate. -->
# Windows 当前验收范围与剩余项

共享源码已推进到 **0.3.6 候选**；稳定包/通道仍为 **0.3.4**。旧 0.3.5 全量交接清单不再作为本轮执行说明，以下按当前范围拆分，避免“部分通过”被误写成全量 Windows 验收。

## 当前交付范围

原生两种包的安装、映射附件保存、双向逐行高亮、行间/短末行空白不命中、删除/回收站/恢复、共享归属、真实缓存清理、真进程冷重开及 A→B 无引擎阅读，绑定 [0.3.6 机器可读证据](nonmac-verification-0.3.6.json)。

阅读全过程不启动 Python/不调用翻译 API；生命周期 suite 可启动安装包自有后端处理本地 cache APIs。活动/未知索引的前端故障注入标明 stub-only，不冒充收费引擎任务。隔离 WebDAV 文件下载不代表真实账号云 metadata sync。

## 尚需专项验收

- [ ] 两种模式的 **0.3.4→0.3.6** 原生文件安装升级：不清任务、缓存、preferences 或 NSS；停止后备份，确认 old data、key/归属、配置与段落缓存保留。
- [ ] 两种升级后的同 profile/data 真新进程冷重开；核健康版本/marker/build ID/精确落盘 XPI hash、数据保留、库 integrity 及自有引擎退出。
- [ ] Windows 原生实际选区→独立 note、已保存批注→汇总 note、新 note 的冷重开、正确引用和 PDF 回链。删除 suite 中的独立 note/批注保留不代替生成 note 的 UI 验收。
- [ ] Windows 原生诊断故障交互：资源缺失、长路径/占用、后端不可用 ZIP、state 不可写时系统 temp 回退；匿名包不得含正文/凭据/用户路径。
- [ ] 两套虚拟凭据在非空 `modifyLogin` 替换/明确清空/写入失败后的身份与保留；只测隔离 realm，不读写日常 Zotero 同步密钥。
- [ ] 设置/任务/诊断 UI 在 Windows **100%/150% 系统缩放**、原始错位场景及窄窗下的可读性。只调窗宽不算系统缩放专项。
- [ ] 另获发布授权后，按目标资产→feed 次序执行实际原生公共更新与冷重开，不改变 macOS Latest。

## 执行边界

使用 [Windows 开发与原生入口](windows.md)；固定 BabelDOC 0.6.4 / PyMuPDF 1.26.7。原生 UI 在登录的交互 Session，两个模式串行或确保焦点独立；启动器 PID 不一定是 UI PID。失败保留原报告，用新 report label，不强杀日常进程、清空数据库或注入批注假装通过。

新功能改变 addon/backend/资源后重建包，旧的同名 XPI 和历史验收不沿用。实际 provider 请求、真实云账号同步或系统设置变更须另获相应授权。
