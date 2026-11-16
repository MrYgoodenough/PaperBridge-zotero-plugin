<!-- Persistence and close-time behavior for native annotations on the translated attachment. -->
# 译文原生批注

`addon/content/annotations.js` 只连接现有分屏的右侧 Zotero reader。批注是译文 PDF 附件的原生子条目，可由 Zotero 同步；原文和译文的批注不双向复制，不改动 PDF 字节。

## 接入和保存契约

`paperbridge.js` 创建 reader 宿主回调，`annotations.js` 读取/保存/删除批注并响应同附件通知。使用 Zotero 官方 annotation JSON 与持久化 API，不自己写 Zotero SQLite，不替换原生 annotation manager。

保存串行进行。关闭前只读实际 `right._state.annotations`，与已持久化状态比较，补存尚未回调的变更并处理已知删除；立即重开须等待 pending writes。关闭时复制快照到宿主 realm，不能依赖已销毁 iframe 的数组。

只读条目和外部批注保持保护。DB 保存失败显示可知的错误，不阻断普通 PDF 阅读。原生通知按实际附件隔离，不把别的 reader 更新应用到当前译文。

## 原生接口边界

reader 没有公开的关闭前 flush API，因此只读 `_state.annotations` 和现有 `_primaryView` 等兼容点需要在 Zotero 大版本变化时复核；不修改其内部 manager 方法。官方契约入口：

- [Zotero annotation persistence](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/annotations.js)
- [Zotero reader host](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/reader.js)
- [Reader implementation](https://github.com/zotero/reader)

高亮、下划线、便签评论属于现有原生工具路径。图像/绘图、完整独立宿主标签弹窗、QuickCopy 富文本及 PDF 内嵌批注导入/导出不在已交付完整支持范围。独立笔记见[notes.md](notes.md)。

## 验证

```sh
node --test tests/test_annotations.cjs tests/test_sync.cjs
```

原生入口 `tests/annotations_packaged.js`；`scripts/prepare_packaged_test.py --suite annotations --run-id <id> --phase create|reopen` 提供明确隔离 profile/data 和实际输入 PDF。create 使用可信原生工具/拖选，保存评论后立即关闭验证防抖补存，再测试删除。reopen 保留同 profile/data、已安装插件和文件，以新进程验证原生批注。

外部驱动须核对真实 UI PID、正常退出码和停机 SQLite integrity。失败用新 report label 保留旧证据；不复制/强杀进程或改库制造通过。精确 package hash 的 Linux/Windows 原生证据与 Node 替身、付费翻译及云同步分别报告。
