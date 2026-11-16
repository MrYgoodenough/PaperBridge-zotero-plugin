<!-- Durable task, attempt, ownership and recovery contracts for current shared source. -->
# 任务与成果架构

一个本地后端串行执行任务，每次尝试启动独立 BabelDOC 0.6.4 引擎进程。任务执行、翻译质量、PDF 导入和映射导出是不同状态，不维护第二套临时队列。

## 修改入口

| 功能 | 入口 |
| --- | --- |
| HTTP、源快照、尝试、取消、恢复 | `backend/server.py` |
| 配置规范化、缓存身份与所有权 | `backend/library_cache.py` |
| 实际请求、验证、段落应用及计费 | `deepseek.py`、`batching.py`、`usage.py` |
| 多选入队、轮询、单独保存与显式重试 | `addon/content/tasks.js` |
| durable records、原生附件及恢复标签 | `addon/content/library.js` |
| 任务卡片与折叠详情 | `tasks-window.js`、`tasks.xhtml`、`ui.css` |
| 已有结果和分屏 | `paperbridge.js`、[映射说明](engine-and-alignment.md) |

`GET /jobs` 和 `GET /jobs/{id}` 返回非秘密状态。新尝试放在 `jobs/attempts/<job-id>-<number>/`，旧 nested 布局继续读取。`identity.json` 固定归属，结果侧包含 PDF、quality、usage、alignment 和 manifest。服务重启将未完成工作标记为中断，**不自动重新收费**。

入队冻结服务、模型、语言、页码和能力配置；凭据只在内存和 Zotero 登录管理器中。`POST /jobs/{id}/retry` 需要当前凭据，创建新 ID 并链接旧尝试。前端必须采用返回的新 ID，清空旧尝试的结果/质量/保存/映射状态；最新尝试不可用不能被旧的完整质量掩盖。

## 缓存与质量

- 段落 namespace 包含服务、端点、能力、语言、文档及 prompt。当前 prompt 为 `paperbridge-compact-v2-fragments`；不复用旧提示下的段落来证明新提示质量。
- 整篇身份还包含字体、质量版本和 `babeldoc-0.6.4-protected-v11-font-subsets`。排版变化失效旧完整 PDF 复用，**不改写已保存 PDF、不删除旧缓存**。
- 只有完成且 hash 验证成立的精确结果可自动复用；部分/未知成果可显式打开。请求重试可能收费，保存重试只使用保留文件。
- 完整/部分/不可用/未知来自真实段落应用证据；`all_pages` 与 `selected_pages` 准确记录请求范围。完整不等于语义认证。缺失的 token 用量和丢失响应保留计费未知，不估造账单。
- 空白富文本和普通词内连字符不形成虚假约束；真实公式、标记、科学维度仍校验。相邻或跨页碎片不得合并 ID、转移正文/标记或补造后文。

## 保存、阅读与清理

`library.attach()` 一次提交附件标题、原生条目 URI 与 type-1 自动恢复标签。内部 `urn:paperbridge:record:` / `job:` 不能放在 Zotero 云端拒绝的 `dc:relation` 中。旧标记经原生保存迁移，保持 keys、record/job ID 和文件。随后独立导出 JSON 映射；失败显示 `mappingWarning`，不能把已导入 PDF 改为导入失败。轮询须保留本次 `alignment_path`。

批量选择论文后只保存，不自动分屏。不同论文可共享后端工作，但各自保留原生归属。中断、未知和未确认任务转到任务列表，不隐式重发。

`translations.json` 损坏时先保留备份、禁用清理，已有 PDF 阅读继续可用。回收站、源文件缺失或移出分类不授权永久删除。只删除确认无归属且无恢复成果的临时缓存；共享、活动、未知或含结果/映射证据的目录保留。清理**不是取消**，SQLite 连接显式关闭以免锁住 Windows 文件。

保存 Python 路径不终止已有引擎。新路径用于下次正常启动；用户等待任务完成后正常重启 Zotero 才切换当前解释器。

## 验证

项目环境执行 `scripts/check_offline.py --mode full`。原生使用明确隔离 profile/data、真实 AddonManager 安装和精确 XPI hash；冷重开保留相同数据、使用新 PID，并核退出码/SQLite integrity。付费全文、缓存重排、离线测试、原生读取和真实云同步分别报告，不能相互代替。参见[质量测试](quality-review.md)与[发布](releasing.md)。
