<!-- Developer guide to durable tasks, result ownership, and recovery boundaries. -->
# 任务与成果架构

PaperBridge 保持一个本地后端、一个串行工作线程和每次翻译独立的引擎进程，不引入外部队列服务。

生产依赖仍为 BabelDOC 0.6.4 / PyMuPDF 1.26.7。引擎接口研究、直接 provider 验证 CLI 与可信定位原型的入口及限制见 [engine-and-alignment.md](engine-and-alignment.md)。

## 修改入口

- `backend/server.py`：持久化任务、源文件快照、串行执行、取消与重试。`GET /jobs` 返回列表，`POST /jobs/{id}/retry` 必须重新提供凭据，返回新 ID 并链接旧尝试；服务重启把未完成工作标为中断，不自动调用模型。
- 后端完整结果缓存由已记录的 PDF SHA-256 校验，旧记录可从 manifest 读取校验值；缺少证据或文件已改变时不自动复用，文件本身仍保留。前端只有完整质量附件可自动复用，部分/未知成果仍可显式打开。
- `backend/library_cache.py`：唯一的非秘密配置规范化、整篇指纹与段落命名空间。新增模型能力时，前后端配置、缓存键和测试应一起调整；不要把密钥加入身份。
- `backend/deepseek.py`、`usage.py`、`batching.py`：请求能力、实际用量及固定引擎的翻译单元证据。`quality.json` 的完整/部分/不可用/未知与 PDF 是否生成分开判断；完整不等于语义质量认证。
- `addon/content/tasks.js`：多选入队、恢复状态、逐项取消和保存；批量不调用分屏。单篇和批量入口都把当前配置、未变原文的未完成或未确认成果转到任务列表，不自动重发；批量跳过这些条目后继续其余论文。不同论文可共享后端 job，但各自拥有独立记录、保存状态及附件。重试必须使用返回的新 job ID 和 `forkAttempt()` 的新归属记录。
- `addon/content/tasks-window.js` / `tasks.xhtml`：任务卡片的状态、可用操作和布局。默认只显示标题、配置、状态、进行中的进度及必要提醒；段落明细、阶段原名、用量和重试次数放入折叠详情，终态隐藏进度条，不可操作按钮隐藏。完整/部分/未知成果不能合并成同一种“成功”，错误及计费未知提醒必须可见。轮询复用卡片和详情节点，保留焦点及展开状态；批量跳过原因独立折叠。
- `addon/content/library.js`：版本 2 的 `translations.json`、附件归属与恢复标记。`put()` 固定配置，`update()` 更新状态，`findAttachment()` 恢复导入，`attach()` 完成保存；`alignment_path` 保存为对应归属的 `alignmentPath`。损坏索引先备份、禁用清理，不推断其余数据可删除。
- `addon/content/settings.*`、`prefs.js`：默认 DeepSeek 加一个可选兼容 profile；凭据分别保存在 Zotero 登录管理器。切换设置只影响后续入队任务。
- `backend/errors.py`、`diagnostics.py`、`addon/content/runtime.js`：固定错误分类与安全指引、鉴权 `POST /diagnostics` 的本地 allowlist ZIP；设置页显示加载警告数量并提供导出，不采集原始日志、路径、密钥或文档内容。
- `addon/content/annotations.js`：译文附件的原生批注读写、通知和关闭前持久化；只接入现有右侧 reader，不复制原文批注，见 [annotations.md](annotations.md)。
- `backend/alignment.py`、`addon/content/alignment.js`：Schema 1 sidecar 的本地证据验证与显式片段定位。后端 `POST /alignment/validate` 核对当前两份 PDF 的 SHA-256 与几何，不提交或重试任务；前端只消费父级验证结果。
- `addon/content/paperbridge.js`：单篇入口、原有页级分屏同步与 `loadAlignment()` 父级加载入口。私有 Zotero/PDF.js 接口仍局限于阅读路径，保存失败和阅读失败不会混为同一执行状态。

进度通过引擎 `PB:` 事件传递 `progress`、`phase`、`counts`，计数沿用 `quality.json` 的字段；服务端仅接受这些非生命周期字段。任务窗口共用后台任务状态，不维护第二套临时任务系统；用尝试时间戳计算用时，已结束任务停止计时。阶段缺少百分比时不重置进度，BabelDOC 的小数百分比按 0–100 解释。

## 数据与恢复边界

任务记录、尝试目录及清单位于插件 `.runtime/jobs/`；译文附件在 Zotero `storage/`。失败尝试不能覆盖先前可用 PDF。根结果与尝试的清单、质量、用量均保留；`alignment.json` 若存在也不应被当作临时文件删掉，服务端暴露其 `alignment_path`。正式翻译流水线目前不自动生成 mapping，原型由 `scripts/probe_engine.py` 捕获同单元并验证实际文本/几何后产出，不做语义猜配；没有跨设备 sidecar 同步。

损坏的单条任务记录保留在磁盘上，加入加载警告，不阻止其他任务启动。中断尝试已有 `translated.pdf` 与完整/部分 `quality.json` 时，服务核对已有校验值和归属后复用正常 `finish()` 完成元数据；启动和显式 `POST /jobs/{id}/recover` 均不重新调用引擎。

前端 `submissionState` 区分已接受、已拒绝、响应未知和本次未找到。已拒绝可修正配置后显式重试；响应未知先刷新找回后端任务，确实未找到时也必须确认重复计费风险后新建任务。后端不可用或记录缺失时，显式保存仍可读取保留的本地 PDF，确认后作为“质量未确认”导入，不覆盖旧附件；已确认不可用的结果不能提升为未知质量成功。原论文不可用时仅提供保留文件位置，不自动导入。

旧成果无 mapping 或验证失败时，定位控件显示降级原因，普通阅读与页级同步仍可用；不删除旧附件，不为补 mapping 自动重发。sidecar 使用零基页码、未旋转的 PDF user space，并绑定原文/译文 PDF 字节 SHA-256，不是屏幕坐标缓存。

新尝试使用 `jobs/attempts/<job-id>-<number>/`，避免指纹与 UUID 重复嵌套触发 Windows 路径长度限制。记录中的 `layout: "flat"` 区分新布局；缺少该字段的旧尝试仍按 `jobs/<fingerprint>/attempts/...` 读取，不迁移或覆盖旧文件。新目录的 `identity.json` 独立保存指纹与文档身份，供译文反查和归属清理使用；缺失或损坏身份的目录保留，不猜测删除。源快照与当前结果别名仍在 `jobs/<fingerprint>/`。

后端用量是**重试链累计**，每次尝试也有自己的记录；不能再对任务列表直接求和。丢失响应和服务商未返回的 token 数保持未知。SDK 隐式重试关闭，引擎失败后的自动回退只允许使用已确认缓存；需要重新发送的失败单元留待显式重试。

导入后立即保存附件 key，随后保存记录/任务关系，可恢复大多数元数据或索引写入失败。导入刚完成、任何恢复标记尚未落盘就崩溃，仍可能留下未索引附件；不靠标题模糊匹配删除或合并它们。插件不会因父条目缺失永久删除 Zotero 附件，也不会对未知目录进行全量清扫。

## 验证

使用项目自己的 Python 环境运行 `python -m pytest tests -q -rs`，另运行 `node tests/test_tasks.cjs`、`node tests/test_library.cjs`、`node tests/test_sync.cjs`、`node tests/test_packaged_startup.cjs`。

可信定位和 provider CLI 的离线入口为 `python -m pytest tests/test_alignment.py tests/test_verify_providers.py -q` 与 `node tests/test_alignment.cjs`；provider 测试使用临时模拟输入。直接运行 `scripts/verify_providers.py` 即使不加 `--run` 也会读取具名输入及已知明文 key，禁密钥任务不要运行；实际请求必须显式 `--run`，每个 ready profile 最多一次，输出 token 上限 512，无重试或回退。

完整 XPI 构建后，`scripts/prepare_packaged_test.py --suite queue` 创建独立 `queue-profile` / `queue-data`。`tests/queue_packaged.js` 检查真实 Zotero 设置、登录管理器、后端启动、批量入口和附件导入；模型结果显式模拟，不调用服务商、不验证翻译质量。测试需要在 `.runtime/queue-fixture.pdf` 放一份非敏感 PDF。默认 `packaged` 套件保持原有真实翻译测试，可能调用付费 API。

`--suite alignment` 使用独立 `.runtime/alignment-profile` / `.runtime/alignment-data`，只允许隔离 profile，由 `tests/alignment_packaged.js` 测试真实阅读器及本地 mapping 验证，不调用 providers、不提交或重试任务。fixture 需预先置于 `.runtime/alignment-fixture/`：`source.pdf`、`translated.pdf`、同次原型产出的 `alignment.json`；准备脚本不生成 mapping。启动方式与静态测试边界见 [engine-and-alignment.md](engine-and-alignment.md)。

`tests/offline_quality_pipeline.py` 使用项目 Python 和已准备的 `.cache` 资源，禁网运行真实 BabelDOC 解析、排版与 PDF 输出；仅替换服务商响应，检查成功与响应丢失两条路径的质量、用量、字体嵌入和链接。合成两页样本只翻译第一页：删除重排正文的旧热点、保留未选页外链，将未验证的正文目标降为真实页级 `/Fit`。运行 `python -I -B tests/offline_quality_pipeline.py`，结果写入 `.runtime/offline-quality-report.json`；不代表真实模型语义质量或原生点击验收。

`--suite annotations --run-id <名称> --phase create|reopen` 在同一隔离环境的两次真实进程中检查批注。`--suite upgrade --run-id <名称> --phase create --xpi <旧包>` 保存非敏感合成附件、原生批注、配置及缓存；进程退出后，用 `--phase reopen` 准备当前包并再次启动同一 profile，核对字节哈希、归属、凭据持久化及设置页诊断 ZIP。两套入口不调用模型，详情见 [annotations.md](annotations.md)、[releasing.md](releasing.md)。

正式 0.7.1 wheel 的 `stage_capture_enabled=False`，旧 `ILTranslatorLLMOnly` 移除、保护适配与 `PageProjection` 不兼容，以及系统字体 hash/profile 均阻碍迁移，不能只改依赖版本号。`--official-fonts` 的 public pipeline 成功只使用模拟 response，不表示升级完成；当前可信定位是原型，不能将页级同步宣称为段落对齐。
