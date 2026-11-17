<!-- Attachment-backed reader primary and a single legacy annotation fallback. -->
# 译文原生批注

当前共享源码优先使用绑定真实译文 PDF 附件的 `TranslationReader`，由 Zotero reader 宿主管理原生批注。只有宿主接口不支持时，才启用 `addon/content/annotations.js` 中的旧 `TranslationAnnotations` 作为单一 fallback；同一右侧 reader 不同时启用两套持久化路径，不双写。

批注是译文 PDF 附件的原生子条目，可由 Zotero 同步；原文和译文的批注不双向复制，不改动 PDF 字节。该宿主增量尚未发布，不能视为既有安装包已更新。

## 接入和保存契约

`paperbridge.js` 选择唯一宿主：支持 attachment-backed 接口时以 `TranslationReader` 为 primary，持久化交给 Zotero；不支持时才由 `TranslationAnnotations` 的回调读取/保存/删除批注并响应同附件通知。保存错误不能成为同时启用第二套写入路径的理由。使用 Zotero 官方 annotation JSON 与持久化 API，不自己写 Zotero SQLite，不替换原生 annotation manager。

旧 fallback 的保存串行进行。关闭前只读实际 `right._state.annotations`，与已持久化状态比较，补存尚未回调的变更并处理已知删除；立即重开须等待 pending writes。关闭时复制快照到宿主 realm，不能依赖已销毁 iframe 的数组。primary 遵循 Zotero 附件宿主生命周期，不再叠加这套补存。

primary 在首个 await 前截取原生 manager 的 `_unsavedAnnotations`，通过附件宿主已有回调提交保存/删除，并等待跟踪的写入及 `_flushState()`。即使快照、保存或状态 flush 失败，也须继续移除 Reader 注册、factory 包装、observer、view 和分屏布局；`uninit()` 的无等待重复 flush 不得泄漏 rejection。这里不另建批注 owner，也不重复执行旧 fallback 的差异补存。

只读条目和外部批注保持保护。DB 保存失败显示可知的错误，不阻断普通 PDF 阅读。原生通知按实际附件隔离，不把别的 reader 更新应用到当前译文。

## 原生接口边界

旧 fallback 的 reader 没有公开的关闭前 flush API，因此只读 `_state.annotations` 和现有 `_primaryView` 等兼容点需要在 Zotero 大版本变化时复核；primary 的附件宿主接口也须按目标版本验收。不修改其内部 manager 方法。官方契约入口：

- [Zotero annotation persistence](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/annotations.js)
- [Zotero reader host](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/reader.js)
- [Reader implementation](https://github.com/zotero/reader)

高亮、下划线、便签评论沿用原生工具路径。图像/绘图、标签弹窗、QuickCopy 富文本及 PDF 内嵌批注导入/导出的完整覆盖仍需按当前宿主和实际包验收；旧 fallback 的限制不等于 primary 已完成全部支持。独立笔记见[notes.md](notes.md)。

## 验证

```sh
node --test tests/test_reader.cjs tests/test_annotations.cjs tests/test_sync.cjs
```

原生入口 `tests/annotations_packaged.js`；`scripts/prepare_packaged_test.py --suite annotations --run-id <id> --phase create|reopen` 提供明确隔离 profile/data 和实际输入 PDF。create 使用可信原生工具/拖选，保存评论后立即关闭验证防抖补存，再测试删除。reopen 保留同 profile/data、已安装插件和文件，以新进程验证原生批注。

外部驱动须核对真实 UI PID、正常退出码和停机 SQLite integrity。失败用新 report label 保留旧证据；不复制/强杀进程或改库制造通过。精确 package hash 的 Linux/Windows 原生证据与 Node 替身、付费翻译及云同步分别报告。

已发布 Linux/Windows freeze07 **0.3.7** 的 create/reopen 历史验收属于当时的包及旧接入路径；完整选区使用 PDF.js controlled Range 和官方 serializer/Annotation API，不冒称物理鼠标拖选。它不能替代新 `TranslationReader` primary 的三平台合流包原生、保存或升级验收。新验证须区分 primary 与接口不支持时的单一 fallback，确认不双写。
