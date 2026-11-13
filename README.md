# PaperBridge · 论文对照翻译

<img width="1907" height="1024" alt="image" src="https://github.com/user-attachments/assets/e0ea2cbd-b021-4434-994b-a96a472f7b4f" />

Zotero 9 / 10 的一体化论文翻译插件。默认使用 `deepseek-flash` 翻译正文，中文嵌入宋体；保留原始图表、公式和页面结构，在同一标签页左右对照阅读。支持串行批量、可恢复的任务记录和独立打开已保存译文。

## 安装

请按平台选择已发布安装包。当前源码为 **0.3.2**：增加可靠任务、串行批量、详细进度与双配置，尚未创建对应 Release，开发者可自行构建。

| 平台 | 已发布安装包 |
|---|---|
| macOS Apple Silicon（arm64） | [0.4.2 自带 Python 版](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.4.2/paperbridge-0.4.2-macos-arm64.xpi) |
| Windows x64 | [0.3.1 自带 Python 版](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.3.1/paperbridge-0.3.1-windows-x64.xpi) |
| Linux amd64（glibc ≥ 2.34；Ubuntu 24.04 已验证） | [0.3.1 安装与构建说明](docs/linux.md) |

**源码与发布包范围不同**：macOS 0.4.2 发布包另有译文原生批注、长公式 LaTeX 复制与持久公式缓存，详见 [发布说明](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.4.2)。这些专属源码尚未合入本分支；不要用当前 0.3.2 源码构建包覆盖该版本并期待保留这些功能。

安装方法如下：
1. Zotero → **工具 → 插件 → 齿轮 → 从文件安装插件**，选择上述 XPI。
2. **工具 → PaperBridge → 设置**，填写 DeepSeek API Key，点击“保存设置”。
3. 打开 PDF，点击 **译 / 分屏**，或右键论文选择 **PaperBridge：翻译并分屏**。

安装包包含独立 Python、BabelDOC、版面模型和 tokenizer。**无需安装 uv/Python，无需工程目录、`.env` 或终端命令。** 首次使用自动解包内置引擎，之后随 Zotero 自动启动和退出。每个安装包只支持文件名对应的平台；Intel Mac 与 Windows ARM64 暂未提供预编译包，需按下方“开发与构建”自行打包。

密钥通过插件界面保存到 Zotero 登录管理器，重启后仍可使用。默认 DeepSeek 配置采用非思考模式；高级设置可另存一个 OpenAI Chat Completions 兼容配置，独立设置 HTTPS 端点、模型、JSON 模式和输出 token 上限。兼容配置不发送 DeepSeek 思考参数，不承诺任意模型可用；“检查引擎”也不验证服务商。`.env` 仅供隔离测试，正式插件不读取它。

## 阅读与翻译

- 页码范围可填写 `2-4`、`1-3,5`；留空翻译全文。未选中的页面保留英文，原译文页码一致。
- 单篇命令完成后保存为 Zotero PDF 附件，并自动打开左右分屏。
- 在文献库多选论文或原 PDF，使用 **批量翻译所选论文（仅保存）**；每篇取第一个非译文 PDF，串行执行，不自动打开阅读器。
- **工具 → PaperBridge → 任务列表** 分别显示执行、结果质量和保存状态，支持逐项取消、显式重试翻译和单独重试保存。某一项失败不阻止其余项。
- 入队时固定源文件快照和模型配置。重启后的中断任务不会自动重发；重试翻译可能重复计费，重试保存不调用模型。
- 默认双向同步翻页、滚动位置和缩放；右下角可切换为独立阅读。
- 拖动中间分隔线调整宽度，“关闭分屏”恢复原生阅读器。
- 右侧为只读阅读；需要批注时，直接打开保存的译文附件。
- **工具 → PaperBridge → 取消当前论文翻译** 可终止任务。

## 排版与宋体

正文、标题及图注按原布局重排。图片、表格和独立公式区域不发送 API 翻译，输出时从原 PDF 复制矢量、字形和位置。图内及表内英文保留原样。

中文按实际使用从系统衬线字体提取字形并嵌入译文 PDF，系统字体不随插件分发：

- macOS：系统“宋体-简”（`Songti.ttc`）的常规、粗体字面。
- Windows：系统“宋体”（`SimSun`）；粗体优先取 `Noto Serif SC`，缺失时回退到微软雅黑 Bold。
- Linux：通过 fontconfig 查找思源宋体（`Noto Serif CJK SC` / `Source Han Serif SC` 等），提取简体中文常规、粗体字面；字体未随插件分发。

扫描件未作为本版验证范围。

## 数据与用量

内置引擎位于 **Zotero 数据目录 / paperbridge / engine**；段落缓存和任务状态分别保存在同级 `cache/`、`.runtime/`。升级或切换版本仅保留一个引擎，模型及缓存继续共用；成功任务自动删除临时 PDF 和过程文件。设置页“数据目录”可直接打开该位置。不依赖开发工程；关闭或禁用插件时停止引擎和未完成的任务。

已保存的译文 PDF 优先复用，段落缓存按端点、模型和配置隔离。任务目录保存版本化记录、各次尝试、成果清单、`quality.json` 和 `usage.json`，不记录密钥。任务表用量为重试链累计值；丢失响应或缺失用量的请求明确标为未知，不能将记录当成最终账单。

进度窗口显示当前阶段、百分比、已处理段落、缓存复用和用时，支持取消、显式重试与打开译文。关闭窗口不会取消任务，可从阅读器或工具菜单重开。部分及未确认译文始终可显式打开，但不会作为完整成果自动复用。

“完整”表示所选页面的可翻译单元已通过结构及应用检查，不保证语言质量。部分译文会明确标注，旧结果没有证据时显示“未确认”；未选页、图表、公式及参考文献仍按规则保留。成果附属记录是本地数据，不保证随 Zotero PDF 跨设备同步。

平台说明见 [Linux](docs/linux.md)、[Windows](docs/windows.md)。历史发布包的验证不等于当前开发源码已完成跨平台验收。

## 开发与构建

仅开发者需要独立 uv 环境。工程缓存和过程文件保存在当前目录。

```sh
./scripts/setup.sh
.venv/bin/python scripts/warmup.py
# macOS 构建需先按下文准备精简 OpenCV。
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py
.venv/bin/python scripts/build.py --python local
```

Linux 开发与安装见 [docs/linux.md](docs/linux.md)；`setup.sh` 使用项目内的独立 Python，不改动系统 Python 或 ROS2 环境。Linux 与 Windows 使用官方 `opencv-python-headless`，无需编译 OpenCV。

macOS 在打包前运行 `curl -L --fail --output .cache/opencv-4.12.0.tar.gz https://github.com/opencv/opencv/archive/refs/tags/4.12.0.tar.gz` 和 `sh scripts/build_opencv.sh`。Windows 等价流程见 [docs/windows.md](docs/windows.md)（`scripts/setup.ps1`、`scripts/serve.ps1`）。

`stage_runtime.py` 从 `uv.lock` 收集本平台运行依赖及公开模型资源，`build.py` 将运行时与插件合并到单个 XPI。引擎运行时加载所需的 `.pyi` 类型资源一并保留；开发测试库不打入运行时。

构建还会在 `dist/updates/` 生成分平台、分 Python 模式的 Zotero 更新清单。先上传匹配的 XPI，再发布对应清单至仓库 `updates/`；单纯构建或同步源码不会发布更新。旧版占位更新地址仍需手动安装新版一次。

```sh
.venv/bin/python -m pytest tests/test_bridge.py tests/test_preserve.py tests/test_usage.py tests/test_deepseek.py --basetemp=.runtime/pytest -q
node tests/test_sync.cjs
node tests/test_packaged_startup.cjs
node tests/test_tasks.cjs
node tests/test_library.cjs
```

`scripts/prepare_packaged_test.py` 将完整 XPI 和单独的测试辅助插件安装到工程内的隔离配置。测试辅助插件不会进入发布包。

## 参考与许可

- [Zotero 插件接口](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：布局识别、公式保留与 PDF 重排
- [Split-View Reader](https://github.com/zerolfl/zotero-split-view-reader)：分屏交互参考
- [HJFY Split Reader](https://github.com/Infinity4B/zotero-hjfy-split-reader)：译文附件与对照阅读流程参考
- [DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)

项目采用 AGPL-3.0，见 LICENSE。内置依赖保留其原有许可文件。

## 成果保存与清理

译文保存为论文条目下的 Zotero 附件，以文献库 ID、论文 key、原 PDF key 和译文附件 key 建立归属索引；文件状态、模型、API 地址、语言、页码及翻译规则区分不同译文。

- 论文条目进入回收站或原文缺失：插件不再永久删除译文附件；Zotero 自身的回收站/删除行为仍然适用。恢复条目后可继续打开保留的成果。
- 只删除原 PDF 附件或实际文件，论文条目仍存在：保留译文及缓存。右键条目选择“PaperBridge：打开已有译文”，原 PDF 不可用时直接打开译文。
- 仅从分类移除条目：保留译文与缓存。
- 相同 PDF 对应多个论文条目：共享引擎工作，但各自保存附件；取消一项不影响仍引用该任务的其他项。
- 正在翻译时删除论文：保留执行和成果记录，不往已删除的论文下自动导入。恢复条目后可重试保存。
- 只清理能够确认没有归属或可恢复成果的临时缓存；索引损坏时保留备份并停止清理，不影响其他基本功能。

正式译文位于 **Zotero 数据目录 / storage / <译文附件 key> / translated.pdf**。

参考文献章节保留原 PDF 字体与排版，不发送翻译 API；正文引用编号保留。支持常规 References、Bibliography、参考文献等标题，按单双栏阅读顺序跨页保护，遇到附录等后续章节恢复正常翻译。旧译文仍可打开；按新规则翻译时不复用旧规则的全文结果。

开发边界及修改入口见 [任务与成果架构](docs/tasks-and-results.md)。目前仍固定 BabelDOC 0.6.4；上游已披露旧版解析安全问题，勿将本地任务隔离视为修复，建议只处理可信来源的 PDF。段落精确对齐与引擎大版本迁移不在当前功能范围。
