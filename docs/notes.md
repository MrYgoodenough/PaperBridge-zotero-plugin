<!-- Native note module contracts, integration points, and pending acceptance boundaries. -->
# 译文批注与选区 → Zotero 独立笔记

## 模块与接入

`addon/content/notes.js` 在脚本加载作用域导出 `PaperBridgeNotes`，无启动副作用、无 UI 注册、无后端请求。`alignment.js` 的现有分屏控制器已接两个独立操作，点击时通过 `Services.scriptloader.loadSubScript()` 懒加载模块；错误只作为**文本**显示在笔记专属状态，不关闭阅读器、不禁用基本阅读或双向显式定位。

### 分屏操作与 reader 边界

- **选区存笔记**：位于默认收起的“阅读工具”中，从译文 `_primaryView._iframeWindow.document.getSelection()` 读取实际文字、Range 首尾的 `.textLayer` 和 `.page[data-page-number]`。按钮主指针按下/键盘激活时先捕获，避免之后的工具栏焦点导致选区丢失；不设置 Range、不恢复或注入 Selection、不从原文或映射猜文字。只接受一个连接中的单页范围，跨页/多范围明确提示分开保存。
- 页索引取实际选区 DOM 所在页，不用 viewer 当前页号猜。可用时通过 PDFDocumentProxy `getPageLabels()` 读取真实页标签；标签查询失败退回物理页号，不阻止笔记。当前有限 UI 不推断或传入 unitID。
- **批注汇总笔记**：参数为 `state.translated` 和 `state.source`，只导出译文附件自己的已保存 native children。先等待 `state.annotations.pending`；在现有公开源码 reader `_state.annotations` 可读时，用 native JSON 只读比较 key、类型、文字/评论、位置、页标签与颜色。仍在原生防抖保存中的变化会提示稍后重试；绝不手动补写、复制或移动批注。`_state` 不是稳定承诺 API，是沿用现有 adapter 的只读兼容边界，Zotero/reader 升级须复核。
- 定位/高亮映射缺失不影响笔记操作。两个笔记按钮在完整“保存＋打开”动作期间都禁用，直接重复调用也返回当前同一 Promise。动作结束后的新明确请求允许另建 note。
- 保存成功显示“笔记已保存”，再调用正式 `Zotero.Notes.open(note.id, null, { openInWindow: true })` 打开独立原生窗口，保留阅读器标签。打开失败仍显示“已保存”，提示到库中手动打开、勿重复保存；不伪装成创建失败或重发保存。只有保存结果不确定时才显示 native key 和“未确认”，不自动重试。
- 分屏关闭前尚未开始保存的异步请求会取消；已交给 note 模块保存的操作不删除或回滚其成果。旧请求不能改动重新打开的分屏控件。单独笔记窗口由 Zotero 原生管理。

两个入口均返回 `Promise<Zotero.Item>`，成功结果为已保存的原生 `note`：

```js
const note = await PaperBridgeNotes.createFromAnnotations({
  translatedAttachment,
  sourceAttachment, // Optional, explicit provenance link only.
  annotationIDs: [nativeAnnotationItem.id, nativeAnnotationItem.key]
});

const selectionNote = await PaperBridgeNotes.createFromSelection({
  translatedAttachment,
  sourceAttachment, // Optional; never infer a source page.
  text: actualSelectionText,
  pageIndex: actualTranslatedPageIndex, // Zero-based physical PDF page.
  pageLabel: actualTranslatedPageLabel, // Optional; otherwise physical pageIndex + 1.
  unitID: verifiedUnitID // Optional plain-text provenance, not a lookup or persistent index.
});
```

- 附件参数是已保存的 native Zotero PDF item，不是路径、reader JSON 或批注对象。模块用 `Zotero.Items.get()` 核对当前条目；依赖原生 item 数据加载接口。
- `annotationIDs` 支持数值 item ID 或字符串 native key；省略表示导出当前附件全部未删除批注，空数组报错。混合/重复 ID 与 key 按条目去重。只读取译文附件自己的 `getAnnotations()` 子条目，跨附件、已删除或不存在的指定 ID 报错，不静默漏掉。
- 主代理应先等待译文批注 adapter 的待保存操作完成，再调用入口。尚在 reader 内存、没有成为 native 子条目的批注不在本模块范围内；不得为笔记功能复制批注至原文附件。
- 片段必须传入**实际选区文字**与实际译文页索引。不从悬停、缓存、语义或源文猜测正文，不自动翻译、不调用模型。传入真实 PDF page label 可保留罗马页码等标签；省略时记录的是物理页号，不声称是印刷页码。
- 可选源附件须属于同库、同论文父项（两份均独立的 PDF 也可显式传入）。仅加源附件回链，不推定其页码，不证明片段对齐。
- 已挂论文的译文附件生成论文父项下的独立 note，绝不把 note 挂在 PDF 下或修改 PDF 自带 note 字段。独立 PDF 生成同库根 note，不隐式归入分类。

## 原生 API 与安全边界

实现依据 Zotero **10.0.8 官方公开源码**，使用 `Annotations.toJSON()`、`EditorInstanceUtilities.serializeAnnotations(json, true)`、`URI.getItemURI/getLibraryPath()` 和 `Item.setNote/saveTx()`。原生 serializer 保留附件 URI/key、真实批注 key、译文位置与页标签、论文 citation/locator；完整 note 用原生 `data-citation-items` 容器和 schema 10。

- 选区作为临时序列化输入，没有 `id/annotationKey`，不生成虚假 annotation 子条目。其位置仅包含明确提供的 `pageIndex`，不杜撰矩形；另有显式 `zotero://open-pdf/...?...page=` 回链保证可回到译文物理页。真实批注回链同时带 `annotation=`。个人未同步库与 group 库走官方协议路径，group 使用 group ID 而非 library ID。
- 引用是论文父项引用；独立 PDF 无论文 CSL citation，保留附件回链和页码。显式链接显示“译文 · 第 N 页”和“原文”，不展示内部 key；可选 unitID 仅作非显示元数据。即便自定义 native note 模板省略引用区域，显式附件链接仍保留。原生 `data-annotation` 保存引用/位置，实际选区文字在引用 span 的内容中，不应假设元数据内有 `text` 字段。
- 可读的只读/外部/他人批注可以复制；目标 library 必须可写、父论文必须可编辑且未删除。`filesEditable=false` 不禁止独立文本笔记，因为没有修改附件文件。真正只读库、feed、删除父项或非法附件会在保存前报错。异步读取后复核目标归属和权限。
- 原生 HTML 先在标准 DOM 的 **inert template** 内解析，再白名单重建。只保留基础排版、native span/img citation/annotation 元数据，以及缓存 PNG/JPEG 的 base64 图像；去掉脚本、SVG、iframe、事件属性、style 和任意模板链接。模块自建标题、unitID、可见页码、附件链接均 HTML 转义，不接受外部图片 URL 或 SVG data URI。不提供任意富 HTML 输入接口。
- 高亮、下划线、便签、文字、区域、绘图走原生序列化。区域/绘图只使用 `toJSON()` 已提供的缓存图像，不启动 PDFWorker、不新建图像附件。没有文字/评论且缺缓存的条目会明确失败，不保存看似成功的空笔记。缓存图像采用 inline data URI，其真实编辑器/重开表现仍须原生验收。
- 单段选区/单条批注文字或评论上限 200,000 JS 字符，页标签和 unitID 上限 256 字符，完整 HTML 上限 8,000,000 字符。超限和异常控制字符明确报错，绝不悄悄截断。

源码参考（只使用官方公开源码，未读取私有 reverse 资产）：

- [editorInstance.js：createNoteFromAnnotations / serializeAnnotations](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/editorInstance.js)
- [annotations.js：toJSON](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/annotations.js)
- [item.js：getAnnotations / setNote / isEditable](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/data/item.js)
- [uri.js：getLibraryPath / getItemURI](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/uri.js)
- [ZoteroProtocolHandler.mjs：open-pdf 路由](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/ZoteroProtocolHandler.mjs)
- [data/notes.js：Notes.open](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/data/notes.js)
- [zoteroPane.js：loadURI](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/zoteroPane.js)
- [data/dataObject.js：reload](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/data/dataObject.js)

## 一次保存与失败处理

不直接使用默认 `createNoteFromAnnotations()`：其 10.0.8 实现先保存空 note、再保存正文。本模块在读取、序列化、过滤和复核全部成功后创建 note，**每次操作仅调用一次 `saveTx()`**；没有预保存、写后补存、自动重试或额外 DB/index。

同模块实例内、相同参数的并发动作共用进行中的 Promise/结果；批注 ID/key 别名与重复标识会归一化。整个 native 数据读取阶段也在去重范围内。省略批注列表与显式列表不视作同一请求。完成后清除内存记录：之后新的明确动作允许生成新的 note，不永久封禁同样内容。UI 仍应在等待期间禁用按钮，成功后显示/打开返回的 note，不能自动重发命令。

新 note 不预设 key，由 `saveTx()` 原生分配；提前标记身份会让 `setNote()` 要求尚未加载的 `primaryData`。保存失败抛出 `error.code === 'NOTE_SAVE_FAILED'`，携带 `noteKey`、`libraryID`、`cause`，只报告实际已分配的 key；分配前失败为 `null`，消息要求检查论文笔记后再决定是否重试。原生事务或通知异常可能使调用方无法确认提交结果；本模块不把异常伪装为成功，也不自动再建一份。仅有 key 时可用 `Zotero.Items.getByLibraryAndKey(error.libraryID, error.noteKey)` 检查候选；不能仅凭内存缓存存在就声称 DB 已提交。读取、权限、HTML 或内容失败均发生在保存前，不生成空 note。

## 离线测试与 Linux 待验收契约

```sh
node --test tests/test_notes.cjs
node --test tests/test_notes.cjs tests/test_annotations.cjs tests/test_sync.cjs
node --test tests/test_alignment.cjs tests/test_notes.cjs tests/test_annotations.cjs tests/test_sync.cjs
```

`test_notes.cjs` 检查入口编排、元数据形状、父项/根 note 与 group 链接、选区转义、并发去重、只读处理、输入错误、白名单、缓存图像，以及原生 key 分配前/后保存失败。采用小型 native-item、serializer、inert-DOM 替身；**不是实际 Zotero 编辑器、Gecko HTML 解析或数据库事务验收**，不启动 Zotero、不触碰日常 profile、不请求模型。

`test_alignment.cjs` 另加 6 项笔记 controller 检查：真实选区接口/焦点捕获与页标签、并发禁用、无效范围、原生保存队列/防抖状态、保存和打开的独立错误、关闭/复用后的迟到结果；加 2 项 native harness 隔离拒绝/配置路由检查，覆盖新 run 路径、指定报告、显式拒绝、路径不匹配和旧调用默认值。原有双向定位/hover 检查保留。替身不能认证 Gecko 跨 compartment DOM/Selection 包装或真实原生编辑器行为。

`tests/alignment_packaged.js` 已在 Linux Zotero 10.0.8 的两种重建 0.3.5 包执行原生步骤：可信拖选 → 实际笔记按钮；原生高亮工具拖选 → 实际汇总按钮；快速重复点击、正式 `Notes.open` 与实际编辑器 item、citation/annotation 元数据和回链、PDF/批注不变，以及真正进程冷重开。父级 PDF/映射是合成 fixture，选区、高亮、保存和编辑器均为原生动作；不冒充模型质量验收，见[限定证据](linux-verification-0.3.5.json)。原生高亮文字的 NFKC 规范化与 PDF 实际字面分开保留，不能将规范化差异或 JSON 位置字段误当功能失败。profile/data 不匹配时不写报告、不导入也不退出 Zotero。

Runner 可在 harness 加载作用域传入以下配置；新验收须使用新的 run ID，不复用有历史数据的默认目录：

```js
PAPERBRIDGE_ALIGNMENT_TEST = {
  isolated: true,
  phase: "create", // Use "reopen" in the next native process.
  expectedVersion: "0.3.5",
  expectedXpiSha256: "<actual XPI SHA-256>", // prepare_nonmac_test.py fills this from the explicit XPI.
  expectedProfileDirectory: "/absolute/new-run/profile",
  expectedDataDirectory: "/absolute/new-run/data",
  statePath: "/absolute/new-run/alignment-state.json",
  reportPath: "/absolute/new-run/alignment-create.json"
};
```

新配置须提供实际期望版本与 XPI hash（或 helper 的 `baselineXpiSha256`），并显式 `isolated: true`；实际 profile/data 分别与期望路径一致才允许执行和写报告。使用 `prepare_nonmac_test.py` 自动生成这些字段，避免把当前源码或同名旧包当作安装证据。未传配置时保留旧目录调用：`.runtime/alignment-profile`、`.runtime/alignment-data`、`.runtime/alignment-test.json`；默认 `phase: "create"`、state 为 `.runtime/alignment-state.json`。缺省路径字段也使用这些旧值，fixture 位置不变。

- **create**：保留完整双向定位、真实选区/原生高亮存 note、重复点击和分屏关闭/重开检查。全部动作完成后从 native item 重新读取已保存正文，保存两条 `noteRecords` 的 HTML/key/library/parent/实际文字/页码、citation/annotation 元数据及实际回链；另存父论文身份、子 note keys、两个附件身份/路径/PDF SHA-256、原生批注 JSON snapshot 和 `Services.appinfo.processID`。这是验收 state 文件，不是生产索引或数据库。继续前须确认 create 报告 `ok: true`。
- **reopen**：正常退出 create 后，在同一 profile/data 的**新 native 进程**传入 `phase: "reopen"`，保留同一 `statePath`，换用新 `reportPath`。只读取 state，核对不同 PID、父论文/附件/note 归属、精确正文/引用/页码/回链、PDF bytes、批注 snapshot 和 note 数量。通过正式 `Zotero.Notes.open()` 打开已有 note，通过 `ZoteroPane.loadURI()` 路由**实际存下的译文回链**，只读观察正确译文页和已有批注选中；不调用 controller、不重新建 note/导入附件/注入批注，也不通过补设目标页掩盖回链失败。打开后再核对正文、附件和批注未变，写报告并正常 quit。state 不重写。

两阶段均正常 quit；准备 create 新 run ID 和同 profile reopen 使用 `prepare_nonmac_test.py`，harness 不复制/重写 XPI、不修改 restart 或安装 metadata。分屏重开和真实进程冷重开是不同检查；后者已在上述两种 Linux 包执行，Windows/macOS 未认证。

宿主私有接口仍有兼容风险：生产 UI 借用 `_internalReader._primaryView._iframeWindow` / `right._primaryView._iframeWindow` 取得 iframe，另只读 `right._state.annotations` 判断防抖是否保存；这些是官方源码实现字段，不是稳定扩展 API。iframe 的 `PDFViewerApplication`、textLayer/page DOM 和 JSON 结构差异可能影响选区或使汇总提示“仍在保存”。测试另依赖 `zotero:note` window type、`zotero-note-editor` ID；生产打开使用正式 `Zotero.Notes.open()`，核心 notes 模块没有这些私有字段依赖。Linux Zotero 10.0.8 已覆盖该路径，其他平台/版本仍须原生复核。

冷重开 harness 的额外契约：`loadURI()` 返回 void，必须等实际 reader/页渲染，不能将返回视为导航成功；tab 使用已有 `Reader.getByTabID()`，原生独立 reader 窗口只读 `zotero:reader` 的 `window.reader`。观察批注选中依赖 reader 私有 `_state.selectedAnnotationIDs`，已对照 Zotero 10.0.8 对应的[官方 reader 源码](https://github.com/zotero/reader/blob/c3d467bfcb9e3a8cacfbbe04c5c7fd1369030a36/src/common/reader.js)，不是稳定扩展 API。原生 note window unload 的 `saveSync()` 实际启动异步保存，harness 等待正式 `Zotero.DB.waitForTransaction()` 后用 `note.reload(["note"], true)` 读持久化正文；若正常编辑器打开/关闭规范化 HTML 而改变正文，精确比较会明确失败，不重写 checkpoint 假装保留。实际回链观察不声称每次都发生了物理位移（reader 可能已在该页），也不替代人工点击 citation preview / inline 图像验收。

## 验证边界

Linux 两种包已验证实际选区/高亮新建 note、正确 parent/library、原生引用元数据、页码/批注回链、编辑器打开、并发去重和新进程持久化，停机数据库完整性为 `ok`。详情集中在上述证据文件，不把小替身或 CI 产物核对当作原生通过。

独立 PDF 根 note、真实 group 权限、图像/绘图和 citation preview 的 UI、复杂恶意模板/特殊文本等扩展场景仍须单独授权验证；现有核心测试不代替这些原生场景。各候选包按精确 XPI hash 验收，macOS 专属源码暂不推进。任何缺接口/权限/缓存错误只影响该笔记动作，不阻断普通 PDF 阅读，不隐式收费或重试。
