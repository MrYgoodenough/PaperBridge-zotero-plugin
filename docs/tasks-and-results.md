# 任务与成果架构

PaperBridge 保持一个本地后端、一个串行工作线程和每次翻译独立的引擎进程，不引入外部队列服务。

## 修改入口

- `backend/server.py`：持久化任务、源文件快照、串行执行、取消与重试。`GET /jobs` 返回列表，`POST /jobs/{id}/retry` 必须重新提供凭据，返回新 ID 并链接旧尝试；服务重启把未完成工作标为中断，不自动调用模型。
- 后端完整结果缓存由已记录的 PDF SHA-256 校验，旧记录可从 manifest 读取校验值；缺少证据或文件已改变时不自动复用，文件本身仍保留。前端只有完整质量附件可自动复用，部分/未知成果仍可显式打开。
- `backend/library_cache.py`：唯一的非秘密配置规范化、整篇指纹与段落命名空间。新增模型能力时，前后端配置、缓存键和测试应一起调整；不要把密钥加入身份。
- `backend/deepseek.py`、`usage.py`、`batching.py`：请求能力、实际用量及固定引擎的翻译单元证据。`quality.json` 的完整/部分/不可用/未知与 PDF 是否生成分开判断；完整不等于语义质量认证。
- `addon/content/tasks.js`：多选入队、恢复状态、逐项取消和保存；批量不调用分屏。不同论文可共享后端 job，但各自拥有独立记录、保存状态及附件。重试必须使用返回的新 job ID 和 `forkAttempt()` 的新归属记录。
- `addon/content/library.js`：版本 2 的 `translations.json`、附件归属与恢复标记。`put()` 固定配置，`update()` 更新状态，`findAttachment()` 恢复导入，`attach()` 完成保存。损坏索引先备份、禁用清理，不推断其余数据可删除。
- `addon/content/settings.*`、`prefs.js`：默认 DeepSeek 加一个可选兼容 profile；凭据分别保存在 Zotero 登录管理器。切换设置只影响后续入队任务。
- `addon/content/paperbridge.js`：单篇入口及原有页级分屏同步。私有 Zotero/PDF.js 接口仍局限于阅读路径，保存失败和阅读失败不会混为同一执行状态。

进度通过引擎 `PB:` 事件传递 `progress`、`phase`、`counts`，计数沿用 `quality.json` 的字段；服务端仅接受这些非生命周期字段。任务窗口共用后台任务状态，不维护第二套临时任务系统；用尝试时间戳计算用时，已结束任务停止计时。阶段缺少百分比时不重置进度，BabelDOC 的小数百分比按 0–100 解释。

## 数据与恢复边界

任务记录、尝试目录及清单位于插件 `.runtime/jobs/`；译文附件在 Zotero `storage/`。失败尝试不能覆盖先前可用 PDF。根结果与尝试的清单、质量、用量均保留；对齐 sidecar 若存在也不应被当作临时文件删掉。这里没有实现段落映射生产或跨设备 sidecar 同步。

新尝试使用 `jobs/attempts/<job-id>-<number>/`，避免指纹与 UUID 重复嵌套触发 Windows 路径长度限制。记录中的 `layout: "flat"` 区分新布局；缺少该字段的旧尝试仍按 `jobs/<fingerprint>/attempts/...` 读取，不迁移或覆盖旧文件。新目录的 `identity.json` 独立保存指纹与文档身份，供译文反查和归属清理使用；缺失或损坏身份的目录保留，不猜测删除。源快照与当前结果别名仍在 `jobs/<fingerprint>/`。

后端用量是**重试链累计**，每次尝试也有自己的记录；不能再对任务列表直接求和。丢失响应和服务商未返回的 token 数保持未知。SDK 隐式重试关闭，引擎失败后的自动回退只允许使用已确认缓存；需要重新发送的失败单元留待显式重试。

导入后立即保存附件 key，随后保存记录/任务关系，可恢复大多数元数据或索引写入失败。导入刚完成、任何恢复标记尚未落盘就崩溃，仍可能留下未索引附件；不靠标题模糊匹配删除或合并它们。插件不会因父条目缺失永久删除 Zotero 附件，也不会对未知目录进行全量清扫。

## 验证

使用项目自己的 Python 环境运行 `python -m pytest tests -q -rs`，另运行 `node tests/test_tasks.cjs`、`node tests/test_library.cjs`、`node tests/test_sync.cjs`、`node tests/test_packaged_startup.cjs`。

完整 XPI 构建后，`scripts/prepare_packaged_test.py --suite queue` 创建独立 `queue-profile` / `queue-data`。`tests/queue_packaged.js` 检查真实 Zotero 设置、登录管理器、后端启动、批量入口和附件导入；模型结果显式模拟，不调用服务商、不验证翻译质量。测试需要在 `.runtime/queue-fixture.pdf` 放一份非敏感 PDF。默认 `packaged` 套件保持原有真实翻译测试，可能调用付费 API。

`tests/offline_quality_pipeline.py` 使用项目 Python 和已准备的 `.cache` 资源，禁网运行真实 BabelDOC 解析、排版与 PDF 输出；仅替换服务商响应，检查成功与响应丢失两条路径的质量、用量和字体嵌入。运行 `python -I -B tests/offline_quality_pipeline.py`，结果写入 `.runtime/offline-quality-report.json`；可在 Windows/Linux/macOS 原生环境运行，不代表真实模型语义质量验收。

引擎升级到 0.7.x 涉及 Python 私有阶段移除，需要独立评估，不可只改依赖版本号。段落对齐须先验证目标发布 wheel 的稳定快照接口与最终 PDF 坐标，不能将当前页级同步宣称为段落对齐。
