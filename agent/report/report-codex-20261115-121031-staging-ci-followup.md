<!-- Direct staging-test portability repair and final shared-source CI evidence. -->
# Staging CI 接续简报

日期：2026-11-15；agent：Codex；分支：`master`。

## 原因与修复

主交付提交 `9989e2e` 的轻量 CI 中 Linux/Windows 通过，macOS runner 的既有新增 staging 模拟测试失败：读取 sysconfig 的真实解释器 ABI 时，`sys.platform` 已被模拟为 Linux，导致懒初始化查询不存在的 `_sysconfigdata__linux_darwin`。

直接修改 `tests/test_linux_staging.py`：在模拟其他宿主前读取真实 ABI，测试 fixture 使用该值。没有跳过/删除测试、放宽 provenance 校验或改动产品实现；修复提交为 `45f75d9d5bf40d93e164952f28cbfc55e22b115c`。macOS 专属源码、运行时和发布物没有推进。

## 验证与交付

- Linux/Windows 项目环境的 full 离线重新执行，各 **304 passed / 1 skipped**、37 JS 语法检查、12 Node suite、0 fail。
- 新共享源码轻量 [CI run 43675453766](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43675453766) 已 completed/success；ubuntu、windows、macos 三个 job 及步骤全部通过。原失败 [run 43675051703](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43675051703) 保留，不改写成通过。
- 后续修改只涉及不发货的测试/证据/记忆/本简报；四个已验收 0.3.6 XPI 的 addon/backend/notice/runtime 字节、SHA 与原生验收结论不变，未用同名重建包替换它们。
- `docs/nonmac-verification-0.3.6.json` 补入准确 CI 范围及首次失败，MEMORY 保留可复用的宿主模拟/真实 ABI 区分，未新增过程流水。
- GitHub master 普通快进同步，Windows 原工程 HEAD/stash 不变；Linux/Windows 稳定 feeds 仍 0.3.4，没有发布 release 或改 macOS Latest。

本简报接续而非覆盖 `report-codex-20261115-120015-reading-assets-and-nonmac-delivery.md`。主任务的映射、逐行高亮、NOTICE、原生清理、Windows 验收与安全清理范围仍以该报告和当前机器证据为准。

CI 是共享源码合约，不是 macOS 原生产品验收。完整许可义务、真实账号 metadata sync、人类双语接受及 Windows 升级/诊断/凭据/note/缩放专项依然未完成，不因本次 CI 通过而勾选。
