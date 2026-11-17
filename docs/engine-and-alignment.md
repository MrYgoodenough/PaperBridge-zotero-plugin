<!-- Capture, portable reading assets and geometry-maintenance entry points. -->
# 引擎与可信阅读映射

## 设计边界

生产基线为 BabelDOC **0.6.4** / PyMuPDF **1.26.7**。翻译任务、缓存、PDF 附件和映射是不同资产：阅读已有结果不依赖翻译 worker、凭据或 Python 引擎。

最小映射单位是**同身份、已应用的翻译请求片段**，不是词/句语义对齐。可信表示两份最终 PDF 的字面文本与几何证据成立，不代表译文语义正确。跨页、移页/合并、隐藏/覆盖文字、重复字面及不支持的几何继续排除，不能为提高覆盖率猜配。

## 生产采集与逐行几何

- `backend/fragment_trace.py` 在现有 IL adapter 中保留有限的源段落身份和 before-image；`engine.py` 在保护区域恢复、最终译文保存之后写 `alignment.json`，不新增模型请求。
- `backend/alignment.py` 校验实际 PDF SHA-256、已应用身份和唯一可见字面，再由最终字符/行/span 生成逐行几何。输出 **schema 2**、`generator_version: fragment-trace-2`、`coordinate_space: pdf-user-space`，`page` 从 0 开始。
- 每侧为 `{page, rects, quads}`。每个 `quad` 按 TL/TR/BR/BL 循环存 8 个坐标；`rects` 是逐个四边形的兼容包围矩形，不是整段大框。捕获全文不写入 sidecar，旧 schema 1 矩形仍可读。
- 普通横排段落用最终可见 paint glyph bounds，避免 raw ascender 框相邻行重叠；保留行间空白和短末行。确认可恢复的倾斜文字使用真实方向。不可靠字符范围 unavailable，不裁切字形或为提高覆盖率猜配。
- `preserve.py` 恢复原始出版信息、图表及参考文献时，使用原始输入与引擎工作页的真实变换映射保护框，不能混用 BabelDOC 规范化前后的 MediaBox 坐标。仅清除保护框内中心命中的文字，避免删除相邻正文的字形边缘；只合并包含或同列紧邻的源裁切区，不把双列参考文献的 L 形区域扩成整页。
- 分段前按已变换的 Form BBox 剔除完全裁掉的字形，保留边界及无法判断的字形，避免裁图内残留整页文字成为重复正文。前言识别同时支持 Abstract/Summary；机构块不能由正文中间的机构词或远处邮箱触发。`references.py` 在实际跨列共享间隙划分章节带，再按带内列顺序跟踪参考文献，不把某列上方科学正文误作下方章节的延续。
- `fonts.py` 只缩小与本地 Songti 缓存字节一致的新嵌入字体程序，保留 glyph ID、ToUnicode、编码和宽度表，不对子集化后的原出版字体重新建字典。隐式 base-14 Symbol 编码在工作副本中显式化，避免 Greek 字符以零宽 Latin 字母进入解析；原 PDF 不改。
- `batching.py` 在原分段/排版入口修正源行、嵌套图注的归属及词尾宽度/断行规则，避免 detector 边缘把词尾或 DOI 拆成独立段落。`source_formulas.py` 在原公式识别阶段合并实际源字形及已有曲线，保护完整赋值/表达式；多行源公式按行顶对齐，不生成或改写公式文字。
- 正文白色行背景保持在其整段译文字形之前；原始遮盖和受保护图表不猜改。旋转页裁切/链接操作使用未旋转的原生坐标，并恢复原页旋转和 CropBox。
- 采集上限仅限制可选映射，不限制翻译：4,096 单元、每侧 1,000,000 字符、每单元 32,768 字符。失败仅警告，继续保存 PDF/质量/用量。

## 可同步 Zotero 附件

`addon/content/reading-assets.js` 负责存储与阅读。`library.js.attach()` 在 PDF 保存成功后独立导出映射；失败提示 `mappingWarning`，不把已保存 PDF 改成导入失败。

可同步 JSON 包装版本为 1，类型 `paperbridge-alignment`，包含：

- `source_attachment_key`、`translated_attachment_key`、`owner_key` 和语言；
- `generator_version`、`validation.status: verified`、`validation.basis: captured-identity-final-pdf`；
- `mapping` 中的 schema、双方 PDF SHA、有限的片段身份/页/几何。

不存原文/译文全文、密钥、任务路径或日志。附件使用 Zotero 自动标签（type 1）保存 `urn:paperbridge:alignment:1`，`dc:relation` 只保存双方原生条目 URI，与 PDF 一样采用 Zotero imported-file 存储/同步。Zotero 云端不接受关系值中的内部 URN；旧标记由 `library.js.migrateMarkers()` 经原生保存迁移，读取仍兼容旧关系。不能用同名 JSON 或相同 PDF hash 推断条目归属，也不要删除用于恢复的内部标签。

相同附件对的相同映射复用现有资产；新生成器或新译本可新增映射，旧附件不覆盖/删除。多个译本显式选择。共享 PDF 的不同文献各有独立 key/映射。

## 无引擎读取与降级

1. `paperbridge.js.openExisting()` 查本地记录及已下载的标签/旧关系标记资产；无任务记录的设备也可发现同库、同 parent 的精确附件对。
2. `AlignmentAssets.load()` 用 Gecko 重算当前两份 PDF SHA-256，检查 schema、四边形及已打开 PDF.js 的真实页边界。PDFPageProxy 的 content getter 需 `waiveXrays()` 读取，不能因 Xray 隐藏字段便跳过页界核验。不调用后端或启动 Python。
3. 优先可信同步资产；有本地旧 sidecar 且字节一致时可免费补附件。无 sidecar 的旧译文不自动重译，也不从正文猜配。
4. 缺失、损坏、未下载、换字节、错误 parent、跨库旧 key 或冲突映射只关闭精确定位/高亮，继续普通 PDF 阅读和页同步。原文已删除时，已知译文可独立打开。

文件下载由 Zotero 负责。接收端不会自动补下载或重建任务。跨库复制未保持正确身份时，旧映射明确不可用：**不按 hash 重绑、不猜归属、不删旧成果**。

## 阅读交互

- `alignment.js` 提供双向显式定位：点击/拖选松开仅记录落点，按钮才导航。普通链接、批注和选区不被抢占。
- schema 2 按四边形命中，逐行显示短暂高亮；行间空白和短末行外不命中。不同单元重叠拒绝定位；schema 1 保留旧矩形行为。
- 默认关闭的悬停采用原生 CSS Custom Highlights，按可信区域筛选完整文本项 Range，`priority=-1`。横排仅补偿原生字体上下留白，要求中心及主要高度仍在同一可信行内；不扩大横向、旋转或倾斜边界，不改变后端字面/几何验证。不改 textLayer opacity、PDF、canvas 或 selection；不跳页、不改页同步。
- 同步和悬停开关常显；显式定位、选区笔记与批注汇总集中在默认收起的“阅读工具”中。主题样式仅作用于插件控件，不重设原生 PDF 或文字层。
- 缩放/旋转/重绘撤销旧几何，关闭分屏清理自有监听、timer 和 registry。可选原生接口缺失只停用对应功能。
- 同一附件对重复打开复用分屏与初始化 promise，保留页码、缩放、宽度和同步状态；不同译本重新建立对应状态。

## 改动入口与验证

| 改什么 | 入口 |
| --- | --- |
| 捕获与排除段落 | `backend/fragment_trace.py`、`batching.py` |
| 作者、出版信息与参考文献保护 | `backend/preserve.py`、`references.py` |
| 字面证据、最终几何与 schema | `backend/alignment.py` |
| JSON 附件、接收端归属/hash | `addon/content/reading-assets.js` |
| PDF 保存、可选映射失败提示 | `addon/content/library.js`、`tasks.js` |
| 发现译本、普通阅读降级 | `addon/content/paperbridge.js` |
| 命中、逐行高亮、双向定位 | `addon/content/alignment.js` |

离线入口为 `scripts/check_offline.py`。`prepare_representative_hover.py` 只重放已授权论文缓存。原生合并套件为 `tests/assets_packaged.js` / `lifecycle_asset_packaged.js`：生产者保存附件，接收者无任务/sidecar/引擎，仅用相同附件字节阅读；故障明确降级；真进程冷重开复核。

改生产代码后须重建 XPI 并核对精确 hash。同版本旧包、引擎 build ID、mocks 或轻量 CI 不能替代对应包的原生验收。macOS 专属源码不在本轮合流/验收范围，共享实现仍保持兼容。
