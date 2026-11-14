<!-- Verified delivery summary and an unresolved Windows daily credential-preservation failure. -->
# 非 macOS 收尾阶段报告：Windows 密钥保留未通过

## 结论

**尚不能宣布整个收尾完成。** 段落高亮的四模式原生验收、代表性片段与排除策略、真正冷启动、公开 Release/自动更新和 Linux 日常安装已完成。Windows 日常的原生安装、冷启动后端、文献库与 19 条批注检查通过，但验收点击误触“保存设置”，实际写变了 PaperBridge 密钥，密钥保留检查失败。

原始加密凭据、插件和数据库备份保留；没有替换 baseline、改写失败记录或回滚全套 NSS 来制造通过。已向用户说明操作失误，并请求**仅恢复 PaperBridge 密钥**、其他 Zotero 凭据不动，再做冷启动验收。授权前不执行恢复，不建议用 Windows 日常环境提交翻译。

公开的限定范围索引：[nonmac-verification-2026-11-15.json](../../docs/nonmac-verification-2026-11-15.json)。它明确保留整体未完成及 Windows 凭据失败，不能用安装/渲染通过替代密钥保留。

## 已完成的代码、构建与交付

- 可见字形匹配采用 NFKC 非空白序列；仅 U+2010/U+2011 与 `-` 等价，大小写、数学负号、长破折号、缺字和 NUL 可见性断点保持严格。真实应用身份、PDF hash 和几何要求不放宽，不使用语义/模糊猜配。
- 发现 0.3.3 原生自动更新安装后 health 仍为 0.3.2；直接修正 `backend/server.py VERSION` 并同步 addon manifest、pyproject、uv.lock，以独立 **0.3.4** 发布。`tests/test_bridge.py` 新增必要的公开版本一致性检查；没有覆盖已发布的 0.3.3。
- `scripts/prepare_representative_hover.py`、`create_hover_geometry_fixture.py`、`prepare_nonmac_test.py` 与 `tests/reading_packaged.js`、`update_packaged.js` 提供有界原生/缓存/冷进程验收，不增加 provider 请求或运行依赖。
- 四种 0.3.4 XPI 与各自 29 个发货源码文件核对，包含构建时确定的平台/模式 update URL；最终 XPI SHA-256 绑定公开资产、实际下载及停机安装文件，不能只凭 build ID 或同名文件。
- 发货源码：`8b2cd663288621dec2e0026be4632b4887e20c15`；非空公共通道提交：`0c4a7a8de44ce5128331c8ce209d275996704eea`。本阶段的文档/任务证据没有再修改生产 addon/backend。

## 原生与离线验收

| 平台 / Python | 原生读取 create | 同 profile 真冷重开 | 悬停/批注/降级 | 公共更新安装 / 冷重开 |
| --- | ---: | ---: | ---: | ---: |
| Linux / bundled | 290 | 304 | 112 | 18 / 14 |
| Linux / local | 290 | 304 | 112 | 18 / 14 |
| Windows / bundled | 290 | 304 | 112 | 18 / 14 |
| Windows / local | 290 | 304 | 112 | 18 / 14 |

- Ubuntu 24.04 / Win11 `desktop-hz`、Zotero 10.0.8。数字是检查项，不是论文数或语义准确率。20 份最终原生报告、全部断言、driver/hash 与原生截图已由主线程重新核对；实际停机 XPI 与相应包一致，隔离进程正常退出、库完整性 `ok`、引擎自然清理。
- 两端完整离线均 **231 passed、1 skipped**，7 个 Node 套件、26 个 JS 语法检查通过；跳过项缺少可选本地科学参考 PDF。主线程最终 Linux full 离线重跑及四条精确公开 URL 的在线发布核验通过，不调用模型。
- [GitHub CI 43613934143](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43613934143) 对应发货源码：Linux/Windows/macOS 三个轻量 job 和所有步骤 success。轻量共享源码 CI 不替代 macOS 原生或完整运行时验收。

## 代表性输入与结构边界

- 两篇历史授权译文的生产段落缓存：sklearn 第 2 页 **16 单元**、LIBLINEAR 第 1 页 **22 单元**，共 38 个真实请求片段，包含两份摘要和四个长正文请求。39 次缓存命中，零 miss、provider/HTTP/DNS/socket 尝试；八个未选页文本和像素保持。
- 原生读取另含两页、两单元合成几何夹具和 12 个真正可见的不合法区域探针。生产每侧仍只输出 **一个 bounding rectangle**；同页分离矩形是同身份的 fixture-only 变体，不宣称生产支持多岛拆分。
- 跨页、移页、合并、版权或其他无法可靠追踪的片段只验证“不误映射”。第二页的单页命中不是跨页段落对应。最小单位仍是请求片段，不做句词对齐。
- CSS Custom Highlights 在原生文本范围上以 `priority=-1` 叠加；悬停不修改 PDF、canvas、text span、批注或 selection，不导航或触发翻译。原生批注叠加/拖选/降级独立验收通过。
- 历史翻译质量仍 **partial**，机构名断行、版权字形重构、作者字体层级未修复；不是整篇语义或人类质量验收。本轮没有新增付费请求。

## 日常安装与真实差异

### Linux

通过 Zotero 原生插件管理器公共更新安装 bundled 0.3.4，并同 profile 真冷重开。实际包、health、installed marker/build ID 一致，插件设置、NSS 凭据和任务记录保持，原始备份保留，无测试 helper，日常应用留运行。

**不宣称所有库表或数据库字节不变。** 原始检查保留 `libraryRecordsUnchanged:false`；只读逐列/引用核对证明变化限于附件阅读时间、客户端元数据，以及一条原/现均无引用的 metadata 值清理。文献/附件归属与内容、批注、标签及引用中元数据保持，完整性 `ok`，检查脚本不写用户库。

### Windows

- 原 0.3.1 占位更新 URL 不能自动送达，使用原生 **Install Add-on From File** 安装已发布 bundled 0.3.4。真实冷启动 addon/hash、health/build/原生父 PID、非秘密设置、任务记录、六个核心文献/批注表和 **19 条批注**通过；正常退出两次、无强杀，完整性 `ok`。
- **密钥保留失败**：误触原生“保存设置”的操作及保存状态截图与新凭据创建时间对应；唯一原生身份比较确认 PaperBridge 密钥值改变，非仅 GUID/序列化/空白修剪变化。误触前比较曾通过，不能拿它替代冷启动后的失败。
- 另有一个 Zotero API-like realm 的凭据值变化，原因未明；原生账号身份及当前 API-key getter 对应记录保持。没有联网验证账号或导出凭据值，不能声称所有真实凭据不变或擅自回滚该条目。
- 完整 preferences、所有凭据文件和全库 raw hash 的一致性均保留为 false；独立的核心文献/批注内容比较不把这些 false 改成 true。
- 原始加密 baseline 与最初停机 audit 的 hash 绑定一致，没有换新 baseline。没有恢复/抹去失误；最终 Windows daily `accepted:false` / `overallAccepted:false`。
- 所有自有临时任务已删除，旧 native/engine 自然退出，日常 app 留运行。最后一次为正常的 lazy engine 未启动状态；此前已经验证的冷启动 health 不冒充当前实时服务。

## 公开发布及历史失败保留

- [v0.3.4 Release](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/releases/tag/v0.3.4)：四个 XPI 和四份 SHA256 sidecar，先公开资产再启用四条独立平台/模式通道。精确公开 URL、资产大小/digest、sidecar bytes、feed 内容均核验，不加 query 绕缓存。
- 四模式实际执行 `AddonManager.findUpdates` → 返回安装器 → 真实下载/hash/安装事件 → 同 profile 真冷重开；0.3.2→0.3.4，只有 reopen 阶段将 `automaticUpdateVerified` 置 true。包元数据 checker 自身仍正确声明它不证明原生自动安装。
- macOS `v0.4.2` tag、资产、通道及仓库 Latest 均保持不变，0.3.3 公开资产未覆盖；本次没有 macOS 原生工作。
- 重启中断的旧 Windows run、0.3.3 health 版本失败、早期 Windows 可见性失败以及 Linux 日常直接复制 XPI 后实际加载不符均保留，不计入通过。
- 跨主机平铺文件收集发生过同名覆盖：Linux 权威报告来自原始 `.runtime`、driver 来自原始 console，按主机 namespace 保留；混合平铺文件和被覆盖的 Linux OS 截图不当作验收输入。Windows update 使用原主机重新收集的独立 namespace。

## 接续与证据

本机保留证据位于忽略的 `agent/codex/nonmac-finish-20261114-201038/`：Linux 的 reading/hover/update 三个 `*-034/accepted-index.json`、Windows reading/hover/update 独立索引、公开发布/CI/保护核对，以及 `windows-daily-034/windows-daily-034-final-accepted-index.json` 和真实失败报告。私有数据库、NSS、密钥、正文及原始日志不进入此次公开文档提交。

下一步必须先取得用户对仅恢复 PaperBridge 密钥的同意，再经原生登录管理器只恢复这一项、比较实际读到的值、正常退出和同 profile 冷重开。保留此次失败和全部 raw false，不宣称从未发生保存，也不为此重写其他凭据或重跑付费翻译。

生产 BabelDOC 0.6.4 的已披露解析安全问题、引擎迁移障碍、全文人类质量验收、Zotero 9/其他发行版及 macOS 原生覆盖仍不在本次通过结论内。`TODO.md` 未修改，没有新建分支或 worktree。
