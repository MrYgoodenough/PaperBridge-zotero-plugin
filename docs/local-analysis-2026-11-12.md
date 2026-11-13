# PaperBridge 本机接续分析与验证

日期：2026-11-12（Asia/Shanghai）。基线为 `master` 的
`37b4f0b35220c6c682472843768250fe17f34d8c`，插件版本 0.3.1。
逐项结果见 [本机验证记录](local-verification-2026-11-12.json)。

## 1. 当前已经完成什么

- 仓库已克隆，项目内的独立 Python 开发环境已准备好，不依赖修改系统 Python。
- 本机安装了 Zotero **10.0.8**，启动器为 `~/.local/bin/zotero`，应用菜单中有 Zotero 入口。
- Zotero 已使用正常用户配置启动；PaperBridge **仅安装在工程内的隔离测试配置**，尚未安装到日常配置。
- 已构建 Linux amd64 自带 Python 的 XPI，大小 **272.81 MiB**；工程 `dist/` 和工作区 `outputs/` 中的副本均通过 SHA-256 校验。
- 本机为 Ubuntu 24.04.4 / glibc 2.39，并可通过 fontconfig 找到 `Noto Serif CJK SC`。

日常使用可以从应用菜单打开 Zotero，也可在终端运行：

```sh
~/.local/bin/zotero
```

若要将 PaperBridge 安装到日常配置：Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件，选择工作区 `outputs/` 中的 Linux XPI；再到工具 → PaperBridge → 设置填写自己的 API Key。当前没有代填真实 Key，也没有发起收费翻译。

## 2. 现有能力：不是只有一个翻译按钮

| 能力 | 源码入口 | 范围与限制 |
|---|---|---|
| 英文论文正文翻译 | `backend/engine.py`、`backend/deepseek.py` | BabelDOC 0.6.4 排版，默认模型 `deepseek-flash`；正文会发送给配置的 API 服务 |
| 选页翻译 | `addon/content/paperbridge.js`、`backend/engine.py` | 支持页码范围，未选页保留原文；正文、图注等重排，图内及表内英文不翻译 |
| 公式、图表及参考文献保护 | `backend/preserve.py`、`backend/references.py` | 检测并保留保护区域；扫描件不在现有验证范围内 |
| 同标签页对照阅读 | `addon/content/paperbridge.js` | 双向同步翻页、滚动和缩放，可切换独立阅读；右侧只读，不是双栏批注编辑器 |
| 译文正式归属 | `addon/content/library.js`、`backend/library_cache.py` | 译文导入 Zotero PDF 附件，记录论文、原 PDF 和译文的关联 |
| 重用已有结果 | `backend/server.py`、`backend/deepseek.py` | 已有 PDF 与段落缓存减少重复 API 请求；删除时按文献归属清理 |
| 取消与生命周期管理 | `addon/content/runtime.js`、`backend/server.py` | 支持任务取消，插件关闭时停止本地引擎 |
| 独立打包运行 | `scripts/stage_runtime.py`、`scripts/build.py` | Linux XPI 自带 Python、排版依赖与模型；仍需系统中文字体 |
| 密钥与本地通信 | `addon/content/settings.js`、`backend/server.py` | Key 交给 Zotero 登录管理器；本地服务仅监听回环地址并校验 Bearer token |

上述“能力”来自源码与已有文档；不代表本次逐项进行了真实论文翻译。既有平台验证记录应与本次本机无付费验证区分阅读。

## 3. 本次实际验证范围

| 检查 | 结果 |
|---|---|
| Python 测试 `pytest tests` | **35 通过，1 跳过**；跳过项缺少参考文献 PDF 样本 |
| PDF 坐标映射和页码限制测试 | 通过 |
| 测试助手非阻塞启动、超时报告回归测试 | 通过 |
| 插件与测试 JavaScript 语法检查 | 通过 |
| 实际 Linux XPI 解包与内置 Python 启动 | 通过；引擎健康接口返回 BabelDOC 0.6.4 |
| 隔离配置重启后的测试 Key 持久化、菜单存在 | 通过；Key 是无效的测试字符串，不是真实凭证 |
| 隔离 Zotero 退出后的后端进程 | 已停止 |
| 隔离数据库 `PRAGMA integrity_check` | `ok` |
| 本轮真实翻译任务数 | **0** |

本次不能据此声称“真实译文质量已验证”。API 可用性、中文覆盖率、字体实际嵌入、真实费用和各种论文版式，需要后续用样本与真实 Key 单独验收。

### 修复了什么

Zotero 会顺序等待各插件的 `startup()`。隔离测试助手此前在自己的异步启动中等待 PaperBridge，可能阻塞 PaperBridge 本身启动，最终误报失败。

现有工作区修复让测试助手的 `startup()` 立即返回，后台再等待 Zotero 初始化、界面和目标插件；目标插件缺失时有有界轮询和错误报告。补充的 `tests/test_packaged_startup.cjs` 验证启动不阻塞、依赖准备顺序以及超时报错。**未改动正式插件功能代码，测试助手也不会进入发布 XPI。**

可复跑的无 API 单元测试：

```sh
env -u PYTHONHOME -u PYTHONPATH -u LD_LIBRARY_PATH -u LD_PRELOAD \
  .venv/bin/python -m pytest tests --basetemp=.runtime/pytest -q -rs
node tests/test_sync.cjs
node tests/test_packaged_startup.cjs
```

注意：完整 `tests/packaged.js` 流程包含真实翻译阶段，不应当作无费用测试直接运行。本轮重启检查只调用本地健康接口，未提交任务。

## 4. 现在最值得做的事情

以下是建议，不是本轮已经实现的功能。

### 第一优先：发布可用性与翻译失败可观测性

1. **补齐 Linux 发布附件与更新流程。** 2026-11-12 查询 GitHub Releases API，公开的 `v0.3.1` 为 2026-10-27 发布的预发行版，附件只有 macOS、Windows XPI 和 Windows 校验文件，未包含 README 中列出的 Linux 包。本机已构建 Linux 包，但没有上传。`addon/manifest.json` 的 `update_url` 仍指向 `example.invalid` 占位地址；仅填写真实地址还不够，需同时实现并验证更新元数据服务。应逐平台提供 XPI、校验文件和真实兼容范围。
2. **防止“任务结束但正文仍是英文”被误判成功。** 当前已有错误事件处理、段落编号和公式占位符检查，且设置了 `disable_same_text_fallback=True`，但尚无统一的最终译文质量报告。建议补充 401 / 429 / 超时 / 空译文的无付费测试，结合实际用量、可翻译段落覆盖率和输出检查给出失败或警告；不要用单一中文比例误伤公式密集论文。
3. **让集成验证可重复、默认无付费。** 将健康检查与 mock API 集成测试变成明确入口，提供可分发的参考文献样本，补充 CI。真实 Key 验证应显式开启，不能混在默认测试里。

### 第二优先：日常使用体验

- 文献库多选批量翻译、任务队列和失败重试。当前选择入口只取第一个条目；需要先设计并发、取消和跨论文费用限制，而不是简单循环提交。
- 翻译前给出页数 / 缓存命中 / 粗略费用提示，翻译后集中展示请求数及用量。现有 `usage.json` 可以作为数据基础；价格需要可维护的来源，不能保证每篇固定低于某个金额。
- 将“打开已有译文”“重新翻译”“删除缓存”做成明确操作，并解释删除论文、原 PDF 和分类移除的区别。
- 加入字体缺失、包不支持本平台、密钥未配置等安装诊断，降低首次使用成本。

### 后续扩展

扫描件 OCR、图表内文字翻译、多模型选择、译文批注与原文定位关联都可作为独立方向；它们不是当前简单开关能开启的能力，尤其需要重新定义缓存版本和保护区域规则。

## 5. 本轮交付边界

- 没有使用真实 API Key、发送真实论文正文或提交翻译任务。
- 没有将测试插件安装进日常配置；正常配置没有 PaperBridge。
- 没有修改系统 Python / ROS2 / shell 环境，也没有执行 Git 提交、推送或上传 Release。
- 本机记录只覆盖上述 Ubuntu 与 Zotero 版本，不推断其他发行版、Zotero 9 或其他平台均通过。
