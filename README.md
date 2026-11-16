# PaperBridge 0.4.2 · macOS 发布源码

此分支保存独立 **macOS Apple Silicon（arm64）0.4.2 XPI** 对应的源码，基于 `b51a82f`，兼容声明为 Zotero 9.0–10.*，已在 Zotero 10.0.9 中实测。

- [下载 0.4.2 安装包](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.4.2)
- [0.4.2 更新与缓存规则](docs/update-0.4.2.md)
- [0.4.2 验证记录](docs/verification-0.4.2.json)
- [共享跨平台开发主线](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/tree/master)

## 功能

- DeepSeek 论文翻译，保留排版、图片、表格和公式，译文保存为 Zotero 附件，支持双栏阅读与页码/滚动/缩放同步。
- 右侧支持原生高亮、下划线、笔记注释、文字、区域和绘图；标注保存在译文附件中。
- 长公式悬停显示复制图标，复制为 `$$…$$`；短公式保留选中复制为 `$…$`。
- 每篇原 PDF 与关联译文共用一个持久 JSON，命中后不重复请求；设置和工具菜单中可查看、按篇或全部清除公式缓存。
- 论文引用决定缓存保留与清理，关闭、重启和升级保留；手动清除不动 PDF、标注、笔记或全文翻译缓存。

首次未缓存公式的 LaTeX 转写需要有效 DeepSeek Key。长公式区域在本地识别，悬停不调用 API；复杂转写结果需核对，扫描公式不提供图像 OCR。两侧标注自动对应后置。

## 安装与开发

在 Zotero「工具 → 插件 → 从文件安装插件」选择发布页的 XPI。自带 Python、依赖和模型，无需开发环境。

本源码快照的运行时构建目标为 macOS arm64。Windows/Linux 的共享实现、独立更新通道及维护记录请查看上面的主线分支。

开发与构建：

```sh
./scripts/setup.sh
.venv/bin/python scripts/warmup.py
curl -L --fail --output .cache/opencv-4.12.0.tar.gz https://github.com/opencv/opencv/archive/refs/tags/4.12.0.tar.gz
sh scripts/build_opencv.sh
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py
```

引擎基线为 BabelDOC 0.6.4 / PyMuPDF 1.26.7。开发环境、密钥、隔离文献库、测试过程文件和 XPI 均不进入 Git。

验证覆盖 61 项后端测试、47 项 Zotero 集成检查和 6 项实际重启/引擎升级检查。公式转写使用可计数模拟响应验证缓存与请求次数，不以此声称真实识别准确率。

项目采用 AGPL-3.0，见 [LICENSE](LICENSE)；内置依赖保留原有许可文件。
