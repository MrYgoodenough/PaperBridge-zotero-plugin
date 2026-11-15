<!-- Project purpose, supported use and concise build/redistribution guidance. -->
# PaperBridge · 论文对照翻译

Zotero 论文翻译插件：使用 DeepSeek 或 OpenAI Chat Completions 兼容服务，保留 PDF 排版、公式与图表，将译文保存为原生附件，并提供原文/译文分屏阅读、可信片段定位、原生批注和独立笔记。

本地 Python 负责 PDF 处理，**不是本地翻译模型**。默认简体中文；结构完整性和映射可信度不等于双语语义质量。

## 安装

按系统和 Python 模式选择 XPI，在 Zotero **工具 → 插件 → 从文件安装**。共享源码当前为 **0.3.6 候选**；源码更新不等于稳定通道更新。

| 平台 | 稳定版本 | 安装包 |
| --- | --- | --- |
| Linux x64 | 0.3.4 | [自带 Python](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.3.4/paperbridge-0.3.4-linux-x64.xpi) · [本地 Python](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.3.4/paperbridge-0.3.4-linux-x64-local-python.xpi) |
| Windows x64 | 0.3.4 | [自带 Python](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.3.4/paperbridge-0.3.4-windows-x64.xpi) · [本地 Python](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/download/v0.3.4/paperbridge-0.3.4-windows-x64-local-python.xpi) |
| macOS Apple Silicon | 独立 0.4.2 | [独立发布](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.4.2)；专属源码不在本轮合流/重建范围 |

自带版包含解释器、依赖、版面模型和 tokenizer，安装后不联网补引擎资源。本地版仅借用同架构 CPython **3.12**，依赖和模型仍随包提供，不修改系统 Python。Linux 需要 glibc ≥ 2.34，并安装思源宋体等简体中文衬线字体。

**0.3.6 候选 Windows 包**首次启用排版引擎时需同意随包提供的 Microsoft DLL 条款；相同条款只确认一次，无需安装 Visual Studio、注册微软账号或另装运行库。暂不接受仍可阅读原文和已有译文。

更新前备份 Zotero profile/数据目录，正常退出后操作。Linux/Windows 使用独立的平台/模式更新通道，不以仓库 Latest 判断适用版本。

## 翻译与阅读

1. 在 **工具 → PaperBridge → 设置** 选择服务，保存 API Key；密钥保存在 Zotero 登录管理器，不在明文配置或任务记录中。
2. 打开原 PDF，执行 **PaperBridge 翻译并分屏**；或在文献库选择论文，执行 **批量翻译所选论文（仅保存）**。
3. 任务列表显示执行、质量和保存状态，支持取消、显式重试翻译及单独重试保存。重启不自动重发；重试翻译可能重复收费，重试保存不调用模型。

页码可填 `2-4`、`1-3,5`，留空为全文；未选页保持原文。单篇完成保存并打开分屏，批量只保存。默认联动页/位置/缩放，可关闭同步、拖动分隔线、独立打开译文。

### 可信片段与笔记

- 原文或译文点击/拖选松开后，使用 **定位译文片段 / 定位原文片段** 显式导航。普通点击不抢链接、选区或批注。
- **0.3.6 候选**把 verified 映射保存为独立 Zotero JSON 附件：只含身份、PDF 哈希和有限几何，没有原/译全文。另一设备下载相同附件字节后，可不启动 Python、不调用 API 地打开可信对照。
- 新映射采用逐行四边形，减少整段大框对行间空白和短末行外区域的误命中。无法可靠追踪、跨页、歧义或无映射的区域不猜配；旧矩形兼容读取。
- 默认关闭的 **段落高亮** 使用原生 CSS 文本高亮，两侧悬停联动但不跳页、不改变选区。映射缺失、损坏、未下载或 PDF 换字节时，精确功能明确降级，普通阅读/页同步保留；不会收费补映射。
- 译文批注属于译文附件。**选区存笔记 / 批注汇总笔记**创建独立 Zotero note，带附件/物理页回链及引用。不复制原译双向批注，不修改 PDF。

详细维护边界见[映射与阅读](docs/engine-and-alignment.md)、[笔记](docs/notes.md)和[原生批注](docs/annotations.md)。

## 数据、字体与费用

插件数据位于 `Zotero 数据目录/paperbridge/`：`engine/` 是已解包引擎，`cache/` 为模型/字体/段落缓存，`.runtime/` 为任务与保留成果。译文、笔记和可同步映射另外保存为 Zotero 原生条目。

- 缓存命中可避免重复请求；服务、模型、语言及排版身份不同不会错误串用。账单未知和部分/未知质量明确显示，不用 PDF 已生成冒充翻译成功。
- 回收站、原文缺失或仅从分类移除，不会触发插件永久删除译文。清理仅针对确定无归属、无可恢复成果的临时缓存；不会以清理代替取消任务。索引损坏时保留备份并停用清理。
- macOS 使用系统宋体-简，Windows 使用宋体并选择可用粗体，Linux 经 fontconfig 找思源宋体。系统字体不随 XPI 分发。缺资源明确提示，不静默下载。
- 繁体/日文只保留语言接口，完整支持与术语规则尚未交付。服务短检查需要确认，格式通过不保证长论文任务或语义质量。

## 开发与构建

共享基线固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**，不顺带升级引擎。项目 Python 位于 `.venv`，Windows 操作使用 PowerShell。

Linux：

```sh
sh scripts/setup.sh
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py
.venv/bin/python scripts/build.py --python local
.venv/bin/python scripts/check_offline.py
```

Linux setup 在开发时准备与既有 macOS 相同范围的 image-only OpenCV；发行包不需要编译工具或联网下载。需要维持较低 glibc 基线时配置原生旧 sysroot/toolchain，见 [Linux 构建与体积](docs/linux-package-size.md)。不做 CPython 一刀切 strip、模型删减或新的 XZ 安装器。

Windows 原生构建见[Windows 指南](docs/windows.md)。平台包必须从对应原生 stage 构建，再按精确 XPI hash 验收；跨平台重打包、引擎 build ID、mocks 和轻量 CI 都不是原生通过证明。发布流程见[发布说明](docs/releasing.md)。

## 许可与参考

项目许可见 [LICENSE](LICENSE)，第三方软件/模型保留各自许可与来源，见 [NOTICE](NOTICE.md) 和[许可证据](docs/licensing.md)。证据清单不构成法律合规意见；公开分发须处理对应源码等实际义务。

感谢 [BabelDOC](https://github.com/funstory-ai/BabelDOC)、[Zotero](https://www.zotero.org/support/dev/zotero_7_for_developers)，以及 [Split-View Reader](https://github.com/zerolfl/zotero-split-view-reader)、[HJFY Split Reader](https://github.com/Infinity4B/zotero-hjfy-split-reader) 的阅读交互参考。
