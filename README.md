# PaperBridge · 论文对照翻译

<img width="1907" height="1024" alt="image" src="https://github.com/user-attachments/assets/e0ea2cbd-b021-4434-994b-a96a472f7b4f" />

Zotero 9 的一体化论文翻译插件。目前使用 `deepseek-flash` 翻译正文，中文嵌入宋体；保留原始图表、公式和页面结构，在同一标签页左右对照阅读。平均一篇论文的完整对照翻译花费不到0.1元🤩

## 安装

0.3.1 为两个平台各提供一个自带 Python 的安装包，按系统下载对应文件：

| 平台 | 安装包 |
|---|---|
| macOS Apple Silicon（arm64） | `paperbridge-0.3.1-macos-arm64.xpi` |
| Windows x64 | `paperbridge-0.3.1-windows-x64.xpi` |

安装方法如下：
1. Zotero → **工具 → 插件 → 齿轮 → 从文件安装插件**，选择上述 XPI。
2. **工具 → PaperBridge → 设置**，填写 DeepSeek API Key，点击“保存设置”。
3. 打开 PDF，点击 **译 / 分屏**，或右键论文选择 **DeepSeek 翻译并分屏**。

安装包包含独立 Python、BabelDOC、版面模型和 tokenizer。**无需安装 uv/Python，无需工程目录、`.env` 或终端命令。** 首次使用自动解包内置引擎，之后随 Zotero 自动启动和退出。每个安装包只支持文件名对应的平台；Intel Mac 与 Windows ARM64 暂未提供预编译包，需按下方“开发与构建”自行打包。

密钥通过插件界面保存到 Zotero 登录管理器，重启后仍可使用。模型默认并固定为 `deepseek-flash`，采用非思考模式处理翻译。`.env` 仅作为隔离测试的密钥输入，生产时插件并不会不读取它。

## 阅读与翻译

- 页码范围可填写 `2-4`、`1-3,5`；留空翻译全文。未选中的页面保留英文，原译文页码一致。
- 翻译完成后保存为 Zotero PDF 附件，并自动打开左右分屏。
- 默认双向同步翻页、滚动位置和缩放；右下角可切换为独立阅读。
- 拖动中间分隔线调整宽度，“关闭分屏”恢复原生阅读器。
- 右侧为只读阅读；需要批注时，直接打开保存的译文附件。
- **工具 → PaperBridge → 取消当前论文翻译** 可终止任务。

## 排版与宋体

正文、标题及图注按原布局重排。图片、表格和独立公式区域不发送 API 翻译，输出时从原 PDF 复制矢量、字形和位置。图内及表内英文保留原样。

中文按实际使用从系统衬线字体提取字形并嵌入译文 PDF，系统字体不随插件分发：

- macOS：系统“宋体-简”（`Songti.ttc`）的常规、粗体字面。
- Windows：系统“宋体”（`SimSun`）；粗体优先取 `Noto Serif SC`，缺失时回退到微软雅黑 Bold。

扫描件未作为本版验证范围。

## 数据与用量

内置引擎位于 **Zotero 数据目录 / paperbridge / engine**；段落缓存和任务状态分别保存在同级 `cache/`、`.runtime/`。升级或切换版本仅保留一个引擎，模型及缓存继续共用；成功任务自动删除临时 PDF 和过程文件。设置页“数据目录”可直接打开该位置。不依赖开发工程；关闭或禁用插件时停止引擎和未完成的任务。

已保存的译文 PDF 优先复用，段落译文另有本地缓存。API 实际请求数、输入、输出、缓存命中和未命中 token 保存在任务目录的 `usage.json`，不记录密钥。

## 测试结果

使用实际 XPI 在工程内的全新 Zotero 9.0.6 配置中测试，不依赖项目 `.venv`，不操作日常文献库。

- 界面保存 Key、重启后读取：通过。
- 完整 XPI 自动解包、独立 Python 启动、自动退出：通过。
- 三页均嵌入宋体，页面尺寸及可见图片位置保持一致；两个保护区域的平均像素误差均为 0。
- 双向同步、独立滚动、关闭分屏清理、译文附件保存：通过。
- 0.2.1版本对于deepseek在翻译中的未命中缓存较高问题进行了修复：实际用量：10 次请求，输入 5,610 token（缓存命中 896、未命中 4,714），输出 3,843 token。相比 0.2.0，未命中输入减少 47%，总输入减少 48.73%。
- Windows x64（Zotero 9.0.6）：完整 XPI 解包、独立 Python 启动、选页翻译、分屏与联动滚动、关闭清理均通过；构建与逐项记录见 [docs/windows.md](docs/windows.md)。

## 开发与构建

仅开发者需要独立 uv 环境。工程缓存和过程文件保存在当前目录。

```sh
./scripts/setup.sh
.venv/bin/python scripts/warmup.py
curl -L --fail --output .cache/opencv-4.12.0.tar.gz https://github.com/opencv/opencv/archive/refs/tags/4.12.0.tar.gz
sh scripts/build_opencv.sh
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py
.venv/bin/python scripts/build.py --python local
```

Windows 下的等价流程见 [docs/windows.md](docs/windows.md)（`scripts/setup.ps1`、`scripts/serve.ps1`）；自带 Python 版直接使用官方 `opencv-python-headless`，无需 `build_opencv.sh`。

`stage_runtime.py` 从 `uv.lock` 收集本平台运行依赖及公开模型资源，`build.py` 将运行时与插件合并到单个 XPI。引擎运行时加载所需的 `.pyi` 类型资源一并保留；开发测试库不打入运行时。

```sh
.venv/bin/python -m pytest tests/test_bridge.py tests/test_preserve.py tests/test_usage.py tests/test_deepseek.py --basetemp=.runtime/pytest -q
node tests/test_sync.cjs
```

`scripts/prepare_packaged_test.py` 将完整 XPI 和单独的测试辅助插件安装到工程内的隔离配置。测试辅助插件不会进入发布包。

## 参考与许可

- [Zotero 插件接口](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)：布局识别、公式保留与 PDF 重排
- [Split-View Reader](https://github.com/zerolfl/zotero-split-view-reader)：分屏交互参考
- [HJFY Split Reader](https://github.com/Infinity4B/zotero-hjfy-split-reader)：译文附件与对照阅读流程参考
- [DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)

项目采用 AGPL-3.0，见 LICENSE。内置依赖保留其原有许可文件。

## 0.3.1主要更新：文献归属、删除与参考文献

本次更新针对解决文件系统归属问题。译文保存为论文条目下的 Zotero 附件，以文献库 ID、论文 key、原 PDF key 和译文附件 key 建立归属索引；文件状态、模型、API 地址、语言、页码及翻译规则区分不同译文。

- 论文条目进入回收站或永久删除：删除 PaperBridge 生成的译文；清除不再被其他论文引用的全文和段落缓存。恢复条目不会恢复已删除的译文，需要重新生成。
- 只删除原 PDF 附件或实际文件，论文条目仍存在：保留译文及缓存。右键条目选择“PaperBridge：打开已有译文”，原 PDF 不可用时直接打开译文。
- 仅从分类移除条目：保留译文与缓存。
- 相同 PDF 对应多个论文条目：删除一篇只删除它的译文；最后一个引用删除后才清理共享缓存。
- 正在翻译时删除论文：先终止任务，再清理缓存。插件停用期间发生的删除在下次启动时补做。

正式译文位于 **Zotero 数据目录 / storage / <译文附件 key> / translated.pdf**。

参考文献章节保留原 PDF 字体与排版，不发送翻译 API；正文引用编号保留。支持常规 References、Bibliography、参考文献等标题，按单双栏阅读顺序跨页保护，遇到附录等后续章节恢复正常翻译。旧译文仍可打开；按新规则翻译时不复用旧规则的全文结果。

验证记录见 `docs/lifecycle-0.3.1.json`、`docs/references-0.3.1.json`、`docs/zotero-packaged-0.3.1.json`；更新说明见 [0.3.1](docs/update-0.3.1.md)。
