# Windows 兼容验证简报

## 结论

本轮已完成当前可靠任务、串行批量、成果保留与双配置功能的 Windows 离线兼容验证。Win11 10.0.26200 / Zotero 10.0.8 的自带 Python、本地 Python 两种 XPI 均通过隔离集成检查；同时完成 Linux 回归。版本仍为 0.3.1 开发快照，未发布新版本。

## 修复与新增验证

- **修复实际长路径错误**：Windows 首轮 Python 回归为 25 失败、63 通过、1 跳过，失败发生在任务尝试目录创建，错误为 `WinError 206`。`backend/server.py` 将新尝试从指纹嵌套目录改为 `jobs/attempts/<job-id>-<number>/`，去掉冗余的 65 字符路径段。旧记录仍使用原目录，不迁移或覆盖旧成果。
- **保持归属与清理正确**：新目录单独保留 `identity.json`。`backend/library_cache.py` 支持新旧布局的译文反查、共享/运行中任务保护和无归属清理；无法确认身份的目录不猜测删除。增加少量布局、历史记录及清理测试。
- **修复 Windows 测试入口**：`tests/queue_packaged.js` 与 `scripts/prepare_packaged_test.py` 使用 `PathUtils.join` 构造 Gecko 文件路径，避免混合分隔符；报告写入失败时也执行退出。首次旧入口无报告、未自动退出，曾终止该隔离测试进程；修复后的两种包均自行正常退出。
- **可复用禁网管线验证**：新增 `tests/offline_quality_pipeline.py`，使用合成 PDF 和真实 BabelDOC 解析、排版、质量与用量记录，仅模拟服务商响应；支持 Windows 的 asyncio 内部 socketpair，不放行外部网络。

## 最终验证

| 检查 | Windows | Linux |
| --- | --- | --- |
| Python 回归 | 94 通过，1 跳过 | 94 通过，1 跳过 |
| JS 任务、归属、坐标、启动 | 四组通过，归属组含 14 项 | 四组通过，归属组含 14 项 |
| 禁网真实 BabelDOC | 成功与响应丢失两条路径通过 | 成功与响应丢失两条路径通过 |
| 自带 Python XPI / Zotero 10.0.8 | 13 项通过 | 重建后 13 项通过 |
| 本地 Python XPI / Zotero 10.0.8 | 13 项通过 | 本轮仅重建及源码校验 |
| 最终测试库完整性 | 两种模式均 `ok` | `ok` |
| 最终隔离进程残留 | 无 | 无 |

Windows 修复后仍使用原隔离工作区和原 pytest basetemp，未缩短测试根路径、跳过失败项或修改系统长路径设置。另在生产尝试路径构造器生成的目录运行真实 BabelDOC，成功/响应丢失及译文身份反查通过。

成功管线确认 PDF 中存在中文标记与嵌入字体：Windows 为 SimSun，Linux 为 Noto Serif CJK SC。响应丢失时即使生成 PDF，质量仍为 `unusable`；每条路径只观察到一次模拟 completion，没有自动重发，缺少服务商用量时保留账单未知。

## 环境、产物与隔离

- Windows 原生 Python 3.12.13、BabelDOC 0.6.4、PyMuPDF 1.26.7、OpenAI SDK 2.54.0；Node 24.22.2 仅用于测试。参考算法测试依赖仅安装到隔离开发环境，不进入产品运行时。
- Windows 使用 `E:\ZoteroPlugin\PaperBridge-zotero-plugin\.runtime\windows-validation-20261113`，未改动原工程的独立未提交源码，也未使用正常 Zotero profile/文献库。原工程已有运行时被复制到隔离目录使用，未修补原 `.venv` 或其他项目环境。
- GUI 验证在已登录 Windows 交互 session 内执行，一次性 Task Scheduler 启动项已删除。隔离 profile/data 留作复核，不自动安装到日常环境。
- Linux/Windows 两种模式共四个 XPI 已重建；Windows 包已取回本地 `dist/`。校验 `.sha256`，逐一核对每个包的 23 个 addon/backend 源文件，并核对 Windows 两种模式实际解包后的后端源码。
- 机器可读证据与完整包哈希：`docs/windows-task-verification-2026-11-13.json`。开发入口文档与 `MEMORY.md` 已更新；未修改根目录 TODO，未提交、推送或更新 GitHub Release。

## 未验收项

- 所有服务商响应均为模拟，实际付费 API 调用数为 0；不能据此声明真实模型语义质量或真实服务商通信已验收。XPI 批量检查模拟任务结果，实际引擎另行禁网验证。
- 两平台均因缺少可选 `.cache/references/pi0-v3.pdf` 跳过一项样本测试，未伪造通过。
- 无 macOS 实机，本轮未重建 macOS 包；也不保证任意深度的自定义 Windows 数据目录均不受操作系统路径限制。
