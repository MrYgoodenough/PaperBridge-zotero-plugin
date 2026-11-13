# 当前开发基线

- 源码版本为 PaperBridge 0.3.2，主分支为 `master`；已整合可靠任务、串行批量、双配置和 Windows 的进度/恢复草稿，尚未创建 0.3.2 Release。后端固定 BabelDOC 0.6.4 / PyMuPDF 1.26.7，默认 DeepSeek `deepseek-flash`。
- Windows 历史 0.3.1 包的真实翻译/分屏证据见 `docs/windows-compatibility-0.3.1.json`。0.3.2 在 Linux / Win11 + Zotero 10.0.8 的自带/本地 Python 四种 XPI 均通过 17 项隔离集成检查，包括再次批选部分成果不重发；数据库完整性为 `ok`，测试引擎退出。最新收尾证据见 `docs/finishing-verification-2026-11-13.json`。真实 BabelDOC 禁网管线的历史成功/响应丢失及字体证据见 `docs/recovery-verification-2026-11-13.json`，不代表真实模型语义质量验收。
- 改动后必须重建各平台 XPI；同名旧包不会跟随源码更新。当前 Linux/Windows 两种包均已重建，macOS 未重建。构建包的更新 URL 按平台/Python 模式独立，`dist/updates/` 仅为草稿；匹配安装包上传后才能发布清单，源码同步不等于发布更新。旧占位地址需手动安装新版一次。
- 运行时按 `macos-arm64`、`windows-x64`、`linux-x64` 独立构建。Linux amd64 自带 CPython 3.12，解释器路径 `python/bin/python3.12`；当前 Linux 包的原生库要求 glibc ≥ 2.34。Ubuntu 24.04 + Zotero 10.0.8 已实测，其他发行版尚未实机验证。
- Linux 使用官方 OpenCV headless wheel，需保留各 wheel 的 `.libs`；仅 macOS 需要自编译精简 OpenCV。打包用 uv 管理的独立解释器，不用系统 Python 作为可重定位运行时。
- Linux 中文字体通过 fontconfig 查询已安装的思源宋体等中文衬线字体，选择简体中文字面并导出到插件缓存；CFF 字面以 `.ttf` 缓存名保存，但 PDF 中实际为嵌入的 OTF。系统字体不随 XPI 分发。
- 项目及插件启动的 Linux Python 清除继承的 Python 和原生库路径；不修改父环境、系统 Python、ROS2 或 shell 配置。开发环境、模型、测试状态位于项目自己的 `.tools`、`.venv`、`.cache`、`.runtime`。
- 正式译文是 Zotero PDF 附件；插件不再因论文进回收站或原文缺失永久删除译文。Zotero 自身的删除行为不变。可恢复成果、任务和共享归属都保留，只有已确认无归属的临时缓存可清理；损坏索引禁用清理。

## 任务与成果接口

- `backend/server.py` 使用 `.runtime/jobs/records/*.json` 与不可变尝试目录持久化串行任务。`GET /jobs` 返回 `{jobs:[...]}`；显式 `POST /jobs/{id}/retry` 传入当前凭据，返回新 ID，并链接 `previous_job_id` / `root_job_id`。重启未完成任务标为中断，不自动重发。
- 新尝试在 `jobs/attempts/<job-id>-<number>/`，记录标记 `layout: "flat"`，避免指纹与 UUID 重复嵌套造成 Windows MAX_PATH 错误。缺少布局字段的旧记录继续读取旧目录，不迁移文件。`identity.json` 是新目录的归属依据，清理必须保留；缺失或损坏身份的未知目录不猜测删除。
- 顶层用量是重试链累计，各尝试另有独立用量，不能跨任务列表再求和。响应丢失/缺少用量时账单未知。SDK 重试关闭，失败自动回退只用确认缓存；引擎父进程失联后自行退出。
- `quality.json` 区分 complete/partial/unusable/unknown，依据所选页翻译单元的结构与应用证据，不保证语义质量。仅有 PDF 不算成功；未知或不可用尝试仍保留文件与清单，不覆盖旧可用结果。
- 后台完整结果复用需核对已记录的 PDF SHA-256，旧记录可从 manifest 读取；改动过或无校验依据的 PDF 保留但不自动复用。前端部分/未知附件仅供显式打开和重试；旧版已保存附件即使没有任务 ID，也可经确认新建翻译而保留旧成果。
- `addon/content/tasks.js` 分离入队、跟踪、导入和打开阅读器。批量每篇取首个非译文 PDF，完成只保存；单篇和批量都把未变原文、相同配置的未完成/未确认成果转到任务列表，批量跳过后继续其余论文，不隐式重试。同一后端 job 的不同论文分别保存，取消一项不误取消其他归属。提交前先存归属；响应丢失按指纹或重试链找回，不自动再次调用模型。
- `library.js` 的索引版本为 2。`put/update/findAttachment/attach/forkAttempt` 管理每个归属；重试保留旧记录和附件，未导入的旧结果脱离自动保存。导入 key、record/job 关系用于恢复，未落任何标记前崩溃仍可能留下未索引副本。
- 设置保留默认 DeepSeek，加一个可选 OpenAI Chat Completions 兼容 profile；各自密钥留在登录管理器，任务固定非秘密配置。缓存身份只由 `library_cache.py` 规范化；未知服务身份的旧段落缓存保留但不复用。维护入口见 `docs/tasks-and-results.md`。
- 统一任务窗口负责启动阶段、百分比、实际段落/缓存计数及尝试用时，关闭后从阅读器重开，不建立第二个等待者或再次自动打开阅读器。引擎 `phase/counts` 使用现有质量账本；上游百分比为 0–100，小数不按比例放大。Windows 草稿中的独立 `results.py` / `progress.*` 没有并存引入，目标已合入当前结构。

## Linux 接续验证

- SSH 别名 `nvidia` / `703nvidia` 使用本机专用 `703nvidia` 密钥。远端工程位于 `/home/nvidia/scq/ZoteroPlugin/PaperBridge-zotero-plugin`；Zotero 位于 `~/.local/opt/Zotero_linux-x86_64`，用户启动器 `~/.local/bin/zotero`。不得改变该主机的 ROS2 和其他项目环境。
- `scripts/prepare_packaged_test.py` 使用隔离 profile/data，实际 XPI 验证入口是 `tests/packaged.js`。首轮保存临时 Key，重启后从测试 `.env` 输入真实 Key；正式插件仍从 Zotero 登录管理器读取。不要将真实 Key 或密钥数据库提交到仓库。
- `--suite queue` 使用独立 queue-profile/data，入口 `tests/queue_packaged.js`。已在 Linux Zotero 10.0.8 验证真实设置、凭据隔离、后端启动、批量/任务界面、附件导入与保守删除；模型结果显式模拟，不是付费模型翻译验收。实际 BabelDOC 管线另经禁网合成 PDF 验证成功与响应丢失两条路径。
- 当前 Linux/Windows 离线基线均为 Python `108 passed, 1 skipped`（缺少 `.cache/references/pi0-v3.pdf`），另有 JS 任务、任务窗口、归属（15 项）、坐标和测试启动检查。运行 `pytest tests`，不要从根目录收集独立测试脚本；Linux 有 ROS 等外部环境时，清除继承的 Python/原生库路径并设置 `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`，不改系统环境。`tests/offline_quality_pipeline.py` 用预置 `.cache` 资源运行跨平台禁网管线；不调用服务商。
- 2026-11-07 Linux 实测通过：真实三页翻译、字体嵌入、未选页保留、双向同步、独立阅读、全文缓存复用、10 项文献生命周期检查、公式/参考文献保护、运行中取消、退出后停止引擎。证据在 `docs/linux-verification-0.3.1.json`，使用说明在 `docs/linux.md`。
- `agent/codex`、`agent/grok`、`agent/dsh` 是忽略的本地过程目录；不要默认读取。`agent/report` 保存任务简报，`agent/task` 只放用户提供的任务文件。

## Windows 接续验证

- SSH 别名 `desktop-hz` 已恢复；Zotero 为 `D:\Zotero\zotero.exe`。远端工程为 `E:\ZoteroPlugin\PaperBridge-zotero-plugin`，已与 GitHub / Linux 的 `master` 同步。原 Windows 草稿意图由其 `docs/update-0.3.2.md` 和差异确认，已合入当前实现；原始备份为该工程 `.runtime/windows-wip-before-takeover-20261113.zip`，另保留 stash `1585dab3ddd69ff0d22c8a2a787914b1fc717d85`，不要再次盲目套用旧差异。Windows `dist` 已同步重建包，原同名草稿保存在 `.runtime/dist-before-takeover-sync-20261113-195420`。
- 本次使用原工程下 `.runtime\windows-validation-20261113` 隔离源码、Python、profile/data；未安装到日常 Zotero profile。原工程 `.venv` 不可直接使用，隔离环境通过复制原有 Windows 原生运行时建立。两种包退出后均无测试引擎残留，测试库完整性为 `ok`。
- OpenSSH 进程在 session 0，Zotero UI 要在已登录的交互 session 启动。本次一次性启动任务已删除；不要改系统长路径设置或依赖其他产品的 Python/Node。Gecko 文件接口需使用 `PathUtils.join`，避免 Windows 混用路径分隔符导致测试无报告/不退出。

## 仍需注意

- GitHub 已发布 macOS `v0.4.2`（原生译文批注、公式 LaTeX 与缓存），但发布说明明确其源码待同步，该 tag 中 manifest 仍为 0.3.1。本分支 0.3.2 不含这些专属源码，不要冒充 0.4.2 或用本分支重建包覆盖该 macOS 发布产物；需另行取得对应开发源码再合并。
- Linux 自带 / 本地 Python 两种 0.3.2 包已在 Zotero 10.0.8 实测；Linux Zotero 9 与其他发行版未重复实机验证。
- BabelDOC 0.6.4 有上游已披露的解析安全问题；进程隔离和父进程监测不是漏洞修复。0.7.x 移除了本项目依赖的旧 Python 阶段，升级及段落精确对齐需单独验证接口与样本，当前未实现。
- 新功能未做真实服务商翻译或 macOS 实机验收；Windows 的新增离线管线与 XPI 集成结果不能替代真实模型语义质量验证。成果 sidecar 是本地数据，不保证随 Zotero PDF 同步。
- 隔离测试自动退出阶段出现过 Zotero 的事务关闭警告；退出后的 `PRAGMA integrity_check` 为 `ok`，引擎已停止。快速重复文献操作后的退出仍需留意该上游警告。
