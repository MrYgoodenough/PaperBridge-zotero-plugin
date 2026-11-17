<!-- Public release families and installation-file selection, not a test history. -->
# 版本与下载选择

Linux/Windows 与独立 macOS 版本分别维护，**不能仅按版本号大小或仓库 Latest 选包**。

| Release | 平台与用途 |
| --- | --- |
| [0.3.7](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.3.7) | 当前 Linux x64 / Windows x64 稳定版本；集中修复任务、保存、字体、公式保护、排版与阅读，并交付对应源码。 |
| [0.3.4](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.3.4) | Linux/Windows 历史修正版；修复 0.3.3 后端 health 仍报告 0.3.2 的版本不一致。新安装优先 0.3.7。 |
| [0.3.3](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.3.3) | Linux/Windows 历史版本；加入双侧段落悬停高亮，改善抽取空白/连字符差异。新安装优先 0.3.7。 |
| [0.4.2](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.4.2) | 独立 macOS Apple Silicon 自带 Python 版，当前仓库 Latest；包含原生批注与公式 LaTeX 转写/缓存。专属源码尚未合入共享分支，**不是 Windows/Linux 0.3.7 的跨平台后继版**。 |
| [0.3.1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.3.1) | 早期版本；实际资产含 macOS arm64 和 Windows x64 XPI，旧说明主要描述 macOS。现分别选择 macOS 0.4.2、Windows 0.3.7。 |

0.3.5 / 0.3.6 为开发/候选阶段，不是当前公开 Release 列表中的独立版本。
共享分支的新功能不自动代表独立 macOS 包已有同样行为，反之亦然。

## 同一 Release 为什么有多个文件

- `linux-x64.xpi` / `windows-x64.xpi`：对应系统的自带 Python 版，通常选它。
- `*-local-python.xpi`：借用本机同架构 CPython 3.12；依赖和模型仍随包提供，不是本地翻译模型。
- `*.xpi.inventory.json`：开发者用的安装包成员/哈希/依赖清单，不是另一个插件。
- `*-corresponding-sources.zip` 与 `*.manifest.json`：对应源码与交付清单，不用于 Zotero 插件安装。
- GitHub 自动生成的 **Source code (zip/tar.gz)**：标签处的仓库快照，不等同于包含固定上游归档和构建输入的 corresponding-sources ZIP。

Release 不提供独立 `.sha256` 文件；构建仍保留本地校验文件。发布验证使用
实际包哈希、平台 feed 的 `update_hash`、GitHub asset digest 及交付清单。
更新前正常退出并备份 Zotero；具体支持边界与验包流程见[发布指南](releasing.md)。
