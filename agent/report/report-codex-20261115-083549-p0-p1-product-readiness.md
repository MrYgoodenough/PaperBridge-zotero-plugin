<!-- Scoped implementation, verifiable package evidence and remaining product-delivery limits. -->
# P0/P1 产品推进、Linux 包体积研究与 GitHub TODO 细化

- 执行 agent：Codex；日期：2026-11-15T08:35:49+08:00，Asia/Shanghai。
- 报告前源码/文档基线：`master@fa534946dcaa2dd30249d361bae8d4025c3ff839`；本报告追加提交不改变发货源码。
- 当前共享源码与本机候选 **0.3.5**；Linux/Windows 四条公开稳定 feed 仍 **0.3.4**，仓库 Latest 仍为独立 macOS **0.4.2**。
- 用户边界：固定 BabelDOC **0.6.4**；不推进 macOS；本轮不做 Windows 原生验收；术语/规则只研究；繁体/日文只保留接口；包体积只研究并保留完整离线安装路线；不新增付费请求。

## 执行结果

1. **直接修复可靠性问题**：`saveKey()` 非空替换采用原生 `modifyLogin(old, old.clone())`，不先删除旧项；有意清空只处理当前 realm。两条实际排版/tokenizer 缺资源消息归类为 resource。核心故障检查覆盖失败保留旧值；Linux 原生检查覆盖登录项身份、非空替换和独立 realm 清空。
2. **设置与诊断**：保存、本地引擎检查、服务检查入口分离。确认后服务检查只发公开短样例，512 输出上限、30 秒、SDK retries 0，不保存草稿、任务、缓存或回退 profile。schema 2 诊断采用匿名阶段/错误码，任务事件最多 64、启动最多 32；后端不可用用 Gecko ZIP，state 不可用回退系统 temp，不导出正文、密钥、原始日志或用户路径。窄窗布局保留基本操作。
3. **阅读→笔记**：补原文→译文显式定位，双向只用可信片段映射，普通点击/拖选不抢链接或批注。实际选区和当前译文已保存批注可生成原生独立 note，绑定正确 library/parent、引用和附件/物理页回链；并发动作去重、保存与打开失败分开，不改 PDF/批注、不调用模型。直接修复新 Item 提前设置 key 的 primaryData 错误，改由 `saveTx()` 原生分配；分配前失败报告 null，不伪造 attempted key。
4. **既有质量问题**：在明确开篇 metadata 区保留作者/机构/版权的源矢量、原语言和粗斜体/断行；标题、摘要、正文仍翻译。缓存字体去掉同 glyph 的兼容汉字/空白/连字符别名，修复“机器”复制成“机器”和 soft hyphen 搜索。两篇已授权选页仅用旧缓存重排：**19 命中、0 miss；重排过程 0 provider/HTTP/DNS**；历史输入、八个未选页文本/144-dpi 像素保持。结构账本 complete 不代表人类语义接受，旧 partial 记录不改写。
5. **最小发布工程**：真实完成两种本机 Linux 重打包、inventory、独立包核对、0.3.4→0.3.5 原生文件安装/新进程升级检查；另真实运行 Linux fresh-stage 构建 CI 并下载两种产物核对 SHA、外层/内层 CRC、模型、发货源码与生成 manifest。候选小群、未公开 draft、暂停投放和递增修复前滚路线已文档化；没有发布新 release/feed，也没有声称完成真实用户试用或自动降级回滚。
6. **研究交付**：Linux 包比 Windows 大的四包逐文件证据、两档保留离线便利的瘦身路线；术语全局 CSV/translate/keep→单篇覆盖/关闭及配置快照/缓存身份路线。未实现瘦身安装器、术语、新语言或本地模型。
7. **GitHub #1**：原复合 TODO 拆为 **154 条独立检查**，**94 条勾选、60 条保留未勾选**；只表示该行的实现/验收范围，不计算项目完成百分比。仅 PATCH issue body，公开全文、中文与勾选已回读匹配，issue 仍 open；#2 正文和更新时间未变。更新时间 `2026-11-15T00:29:24Z`。[TODO #1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/issues/1)。

## 验证结果与产物身份

| 范围 | 实际结果 | 限制 |
| --- | --- | --- |
| 本机完整离线入口 | **243 passed / 1 skipped**；**22 Node 套件、32 JS 语法检查**通过 | skip 是缺少可选参考 PDF，不包装为全 pass；没有真实云服务请求 |
| 三平台轻量 CI | [43656077025](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43656077025)，`5e8e471` 三 jobs/必要 steps success | 不是 Windows/macOS 原生 Zotero 验收 |
| Linux 自带 Python 候选 | 定位/笔记 **128+37**、真实缓存阅读 **123+133**、升级 **6+49**；合计 **476** | 本机现有原生 stage 重打包；原生 note 的 PDF/映射输入为明确合成 fixture |
| Linux 本地 Python 候选 | 同范围 **476**；真实项目 Python 3.12 | 依赖仍来自 XPI，不是本地翻译模型 |
| 六套隔离库收尾 | 十二个阶段正常退出；真实不同 PID 冷重开；SQLite integrity `ok`、两份历史缓存字节保持；无自有进程残留 | 不触碰或强杀日常 Zotero；没有认证其他 Linux 发行版/Zotero 版本 |
| Linux 真实候选构建 CI | [43656079515](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43656079515)，fresh native stage、禁网 imports/model/tokenizer、两种 XPI 构建/下载独立核对通过 | **这些 CI 字节未装入 Zotero**；不能沿用本机不同 hash 的原生验收 |

本机已原生验收的最终包（不是早期同名候选）：

| 模式 | XPI bytes | 完整 SHA-256 |
| --- | ---: | --- |
| 自带 Python | 286,148,057 | `1a8bbe96685067041b0653d7110d8db752eaf3a2793b8b20ef20c14f728ad604` |
| 本地 Python | 248,229,817 | `90ea2bc98e79f0daac6d68eab41835744b1a27c332c300b1c74045f9e0b2bea9` |

发货身份核对为 **30 个原始文件字节 hash + 1 个按平台/模式生成的 manifest**，并非把生成 manifest 冒充原始源码字节一致。引擎 build ID 来源于 payload/后端，不能单独证明 addon JS 已更新。

集中证据：[Linux 0.3.5 验证](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/linux-verification-0.3.5.json)、[质量证据](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/quality-verification-0.3.5.json)。原生 profile、PDF/缓存和原始失败日志保留在隔离目录/本轮过程目录，不提交用户库、密钥或原始诊断。

## Linux 体积研究结论

- 对照 0.3.4 完整包：Linux **272.88 MiB**、Windows **189.70 MiB**，差 **83.18 MiB**；主要为依赖 **58.30 MiB**、Python **24.76 MiB**，不是模型/tokenizer 差异。
- 第一档 ZIP/debug-symbol/别名路线的组合预算节省 **16.59–18.75 MiB**；仅提高压缩级别约 **0.96 MiB**，不能夸大为全部收益。依赖 `.libs`、必要模型和 tokenizer 保留。
- 内层 XZ/别名/模型压缩预算约 **201.07 MiB**；新首次解包/恢复与 `_lzma` 自举安装器尚未实现/验收，不能称作已可安装的小包。
- CPython 一刀切 strip 的副本实测失败，排除该路线；四个输入 XPI 未改。不用联网补资源伪造瘦身。
- 逐项数据与风险/工作量见[体积研究](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/linux-package-size.md)；本轮只研究。

## 失败、告警与未达到的指标

- 早期 0.3.5 原生 note 新建真实失败：手动 key 提前令 Item identified，primaryData 未加载。直接修该对象的初始化顺序，而非另建笔记存储或绕过；旧包/hash/失败报告保留，修复后两种包重新构建并完整复验。
- 原生汇总测试曾把 Zotero 的 NFKC 文本和 JSON 位置字段当成原始 PDF 字节/对象字段，导致断言失败；改按官方 `Annotations.toJSON()` 契约核对并记录两边实际文字，不注入选区、不跳过失败输入。早期复制焦点失败报告也保留；最终以新包真实拖选和搜索证明通过。
- 首次真实候选 CI [43654402305](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/actions/runs/43654402305) 因新包核对改变 isolation-routing 测试的预期报错顺序失败。修复 harness 路由后，下一次实际 CI 全步骤成功；没有将 skipped stage/build 写成完成。
- Windows GCM 反复报告 `Unable to persist credentials with the wincredman credential store`，但 push/API 返回成功且公开 SHA/body 已确认；未擅自更换凭据后端或导出 token。Windows PowerShell 大 artifact 下载曾 EOF，改用 curl 私有 stdin 配置流式下载并按 API digest 复核；没有关闭 TLS 证书验证。Windows HEAD/worktree 始终保留 `06eea7c83e90b3cad893e5e3875357f9d0a6e5de`，SSH 仅作 GitHub 鉴权/运输，不是 Windows 验收。
- **仍未完成**：两页的人类双语/视觉接受、更广公式/图表质量样本、真实兼容服务验证、Windows 0.3.5 原生验收、真实候选群反馈、暂停/恢复实际演练、新版本公开投放、完整许可/SBOM。CPython/模型/tokenizer 来源许可仍 unknown，不把 inventory 当法律审计。
- 按用户要求不做：macOS 合流/重建/原生验收、BabelDOC 新版迁移、术语实现、繁体/日文完整支持、包体积实际瘦身。迁移低优先级且不列 TODO/当前优先事项的政策已同步 AGENTS/MEMORY。

## 下一步建议与交接

优先收尾“当前包可用、译文可信、数据保留”，再增加功能：

1. **P0 — Windows 独立验收：1–3 人日，高可行性。** 两种包原生构建/新装/0.3.4 升级、真正进程冷重开、密钥/诊断/笔记/复制搜索；收益高，失败保留旧 feed，避免日常 NSS/库风险。
2. **P0 — 两篇既有选页人工双语复核：0.5–1 人日，中高。** 核心价值收益最高；不新增付费样本，不以结构 complete 代替语义接受。
3. **P0 — 最简许可证据补齐：0.5–2 人日，高。** 低投入降低新候选公开分发的不确定性；unknown 交用户判断，不杜撰或删除必要资源。
4. **P1 — 小群候选与可控投放：1–2 人日 + 观察时间，高。** 依赖对应平台/质量/许可核查；先资产后 feed，暂停不能自动降级，用递增修复前滚。
5. **P1 — 删除/缓存清理最小原生收尾：1–2 人日，高。** 仅隔离样本，不触日常数据；比再加功能更有利于产品可靠性。
6. **P1 — 第一档 ZIP 瘦身：压缩级别 0.5 日、依赖处理 1–3 日、别名恢复另 1–2 日，高/中高。** 先小收益低风险档，不拖延稳定发布；更大 XZ 原型 **4–7 日、中**，仅在体积仍为主要痛点时做。
7. 有需求且费用授权后，再做单一真实兼容服务 **0.5–1 日、高**；术语下一轮 **全局 3–5 日、含单篇 4–7 日、高**。OCR/Windows ARM64/真正增量排版与双向批注继续按收益成本后排，不引入庞大治理框架。

交接：[Windows 验收清单](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/windows-acceptance-0.3.5.md)、[完整风险排序](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/product-roadmap-0.3.5.md)、[术语技术路线](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/blob/master/docs/terminology-design.md)。

无新分支/worktree；按 master 普通快进推送。未修改根 TODO.md，未生成 agent/task 用户任务文件；本报告为全新文件，MEMORY 仅维护当前基线、关键接口与未解决风险，过程材料位于 `agent/codex/p0-p1-20261115`。
