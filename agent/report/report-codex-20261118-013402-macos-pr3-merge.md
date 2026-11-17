<!-- Source integration results, verified acceptance and remaining release boundaries. -->
# macOS PR #3 增量吸收与合并简报

- 执行者：Codex；时间：2026-11-18 01:34:02 CST。
- 任务：按用户授权吸收 macOS 增量、保留共享主线基线，真实 merge 并同步 `master`。

## 结果与身份

- [PR #3](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/pull/3) 已由 GitHub 确认为 **Merged**，不是仅本地模拟或关闭 PR。
- 合并提交：`96cbed161b64a8c04cf3db20326bc4d7bea91e91`；父提交为原共享主线 `bbf1f0d1daa9c139b8a571e2125d0c005b87544e` 与维护者头提交 `272d85e52bf653d084191e705cabe60ef1188f62`。
- 后续 CI 修正：`da3dd4b1ed11e80c4ec1e8532bafa6d869c734a3`；两项源码提交均已正常、非强制推送到 `master`。
- 当前为**未发布共享源码**，版本元数据暂仍为 0.3.7。Linux/Windows freeze07 0.3.7、独立 macOS 0.4.2 的安装包、标签、更新通道及仓库 Latest 均未覆盖或更改。

## 已吸收和修正

1. 接入公式选区/悬停复制、本机 JSON 缓存及工具菜单/设置中的缓存管理；固定转写使用配对的 DeepSeek Key/URL 与 `deepseek-flash`，不借用 compatible 配置。
2. 修正缓存存活引用、原译晚配对合并和 clear generation 隔离；可选缓存写失败不阻断已取得 LaTeX 的复制。后台区域检测非交互，临时错误不持久化为永久空页，悬停重试有界。
3. 复用 BabelDOC **0.6.4** / PyMuPDF **1.26.7** 和现有 CPU 模型。修正旋转且裁切 PDF 的原始 user-space 坐标；模型完整初始化后才发布；拒绝带明确 provider error 的部分 LaTeX。
4. 原生 `TranslationReader` 为译文附件唯一批注 owner，旧 `TranslationAnnotations` 只在接口不支持时作为单一 fallback。关闭前同步截取 debounce 编辑，跟踪写入、等待状态 flush，失败时仍释放注册、factory、observer、view 和原布局；bootstrap 与 stop 清理不因某个保存失败而中断。
5. 保留 durable tasks、独立 provider 草稿/密钥、同步标记与阅读资产、v16 排版/v5 提示、source itemID 恢复、同 pair 复用、stale 初始化保护和 flex 恢复；没有用旧 PR 整文件覆盖这些主线修复，也没有停用时取消全部任务。
6. 原生测试脚本适配 primary/fallback 单一 owner 和完整异步 close；原数据、原生输入、geometry 与保存断言未降低。保留并明确标记维护者旧 macOS 发布说明及验收资料的历史范围。

## 实际验证

| 项目 | 结果与限定范围 |
| --- | --- |
| 完整离线模式 | **433 passed、1 skipped**；16 个 Node 套件及全部 JS/CJS 语法检查通过。包含新增公式后端、路由、缓存、native close/stop 错误清理与旧主线回归。 |
| 真正最小依赖环境 | 仅安装 pytest 9.1.1 / PyMuPDF 1.26.7 / httpx 0.28.1 及其依赖：**364 passed、2 skipped、14 deselected**；16 个 Node 套件通过。不是用完整 `.venv` 冒充最小依赖。 |
| [三平台 GitHub CI](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/44136856598) | Linux、Windows、macOS **3/3 success**，绑定源码修正提交 `da3dd4b`；属于最小依赖共享源码兼容性，不是三平台原生包验收。 |
| Linux 候选包原生 | 隔离 Zotero **10.0.8**：create **23/23**、新进程 reopen **9/9**；高亮/下划线/笔记评论、关闭重开、删除、唯一译文 owner、独立 reader 读取均通过。两进程正常退出 0；停机 SQLite integrity 为 `ok`。输入为可信 Gecko 事件，不冒称物理鼠标/键盘实测。 |
| 候选包源码绑定 | XPI SHA-256：`ffb9bc578ab488c504d829425fb33b0b5b46ea5ccc7b13aed5f6f687b95382e1`，228,266,921 bytes；**53** 个 addon/backend 源文件与当前源码及 inventory 哈希一致，manifest 仅有预期的平台通道转换。包仅供本地验证，未发布。 |
| 候选 bundled 依赖 smoke | 真实 CPU ONNX 加载/推理与真实 OpenAI SDK 的内存 transport mock 通过；**0 次外部 provider 请求**。合成 PDF 检测结果为 **0 个区域**，不作为公式召回率或语义质量通过。 |
| XHTML / 差异检查 | 设置及公式缓存 XHTML 解析通过；`git diff --check` 通过。 |

### CI 首轮失败及实际修复

首轮 [run 44134723137](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/44134723137) 在三个平台均因原有 `test_source_formulas.py::test_merge_keeps_wrapped_prose_and_existing_formula_owners` 直接导入 BabelDOC IL 而失败；该用例来自合流前主线，最小 CI 本来不安装 BabelDOC。已读取官方日志，并在本项目真实最小环境复现。

修复仅把这项 engine-dependent 用例纳入已有 `FULL_ONLY_CASES`。**用例与断言未修改，完整模式仍执行且 433 项通过**；没有删除失败测试、放松断言、关闭 CI 或升级引擎。

## 未完成或不能扩大声称的指标

- Windows/macOS 合流安装包的原生阅读、批注、缓存、冷重启与旧版升级，以及三平台统一新版本发布，均未完成；本轮不替代维护者旧包或既有 freeze07 验收。
- 真实 DeepSeek 公式转写质量、复杂 PDF/扫描页的检测召回、真实系统剪贴板和缓存窗口的跨平台 GUI 覆盖仍未验收；模块替身测试与 SDK mock 不是付费结果接受。
- 公式 JSON 为本机缓存，不是云同步；没有执行新的真实账号/跨设备同步或新增付费论文任务。
- Native reader 依赖 Zotero 私有宿主契约，已验证的原生版本为 Linux 10.0.8，其他平台/目标版本还需对应包验收。单一 fallback 与非致命错误处理不等于未来版本全部兼容。
- 候选 inventory 的 6 项既有许可/编译 provenance advisory 仍保留；没有发布此候选或新 corresponding-sources ZIP，也不声称法律合规已完成。

## 安全与交付维护

- 未使用日常 Zotero profile/data，未强杀或修改锁/数据库制造通过，未触发 paid provider 或重放真实任务。
- Linux 本机缺 GitHub 写入凭据，首推失败后使用 `desktop-hz` 现成 Git 凭据和独立临时 bare 对象仓库推送精确提交；没有改变 Windows 原工程工作文件/HEAD/stash，没有导出凭据。GCM 在 SSH 下的凭据持久化警告未阻断实际推送，已核对远端 SHA。
- 已维护 MEMORY 与简要开发/版本文档；根 TODO、GitHub TODO issue、生产版本号、发布资产和 feeds 未修改。未创建新开发分支或 worktree。
- 过程证据：`/home/scq/PaperBridge-zotero-plugin/agent/codex/pr3-merge-20261118-002341`；隔离 profile/data 与候选 stage/package 留作限定验收证据，不与日常数据混淆。
