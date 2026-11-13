# 译文原生批注（独立 P1）

本实现来自当前分支和 Zotero 官方开源接口，**不是 macOS 0.4.2 源码合并**，不包含其公式 LaTeX 或公式缓存功能。

## 使用与存储

打开已有译文分屏后，右侧使用原有 Zotero `createReader` 对象及其原生高亮、下划线、笔记、文本、区域和绘图工具。窄窗右侧工具栏可水平滚动，不再隐藏批注工具；颜色、编辑、删除等菜单由该 reader 自己渲染。可从原生侧栏查看批注。

批注是 **Zotero `annotation` 子条目**，父条目是正式译文 PDF 附件；不是临时 DOM 高亮、独立批注数据库或 PDF 二进制修改。图像/绘图缩略图使用 Zotero 自己的缓存。关闭分屏、重新打开或重启后从该附件读取。普通独立 Zotero 阅读器也能看到同一批注。没有原文↔译文批注复制、坐标映射或双侧批注同步；已有页级阅读同步不变。

附件、库、外部批注的原生只读权限仍有效。写入失败在右侧显示错误，只停用该侧批注编辑；两份 PDF 和任务功能不被关闭。损坏的单个批注记录错误并跳过加载，不删除。

## 维护入口

- `addon/content/annotations.js`：原生 JSON 读写、删除、通知、图片缓存和关闭前持久化。
- `addon/content/paperbridge.js`：`translatedAnnotationOptions()` 在 `loadSplit()` 中惰性加载辅助模块，直接覆盖原 `createReader` 的批注回调；不需改 bootstrap。
- `closeSplit()` 只增加关闭前快照和 `state.annotationSave`；布局恢复与旧 split 销毁流程保持。`annotationWrites` 使立即重开等待前一个写入，插件关闭也等待这些写入。
- 使用 Zotero item notifier 更新**同一译文附件**的批注和权限，不监听原文批注以生成译文批注。
- 原生 `setReadOnly` 会重置当前工具，只在权限变化时调用。iframe 销毁后不再调用其保存完成 callback，但排队写入和关闭快照仍须完成。

优先调用 `Zotero.Annotations.toJSON/saveFromJSON/saveCacheImage`、`Item.getAnnotations/eraseTx/isEditable`、`Notifier`，以及 reader 的 `setAnnotations/unsetAnnotations/setReadOnly/openContextMenu`。菜单使用官方 reader 的内置渲染器，不再另建批注动作。

### 已核对的官方契约与兼容点

核对基线为 Zotero **10.0.8**：

- [Zotero 原生 reader 接入与批注回调](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/reader.js)
- [Zotero 批注 JSON 与附件持久化](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/annotations.js)
- [10.0.8 引用的 reader 子模块](https://github.com/zotero/reader/tree/c3d467bfcb9e3a8cacfbbe04c5c7fd1369030a36)
- [iframe 保存完成 callback / 菜单入口](https://github.com/zotero/reader/blob/c3d467bfcb9e3a8cacfbbe04c5c7fd1369030a36/src/index.zotero.js)
- [原生保存防抖](https://github.com/zotero/reader/blob/c3d467bfcb9e3a8cacfbbe04c5c7fd1369030a36/src/common/annotation-manager.js)

reader 没有公开的关闭前 flush API。辅助模块在销毁前**只读** `right._state.annotations`，与已持久化内容比较，只补存变更并删除已知被移除的批注；不调用/修改 `_annotationManager`，不替换原生方法。`contextMenuParams` 同样来自官方 `createReader` 的 Zotero 入口。上述源码公开但未保证稳定的兼容点，以及现有 split 使用的 `_primaryView`，需在 Zotero 大版本变化时复核。

未实现完整独立 reader 宿主的标签弹窗、添加到 Zotero 笔记、QuickCopy 富文本导出、PDF 内嵌批注导入/导出；这些原先为空的宿主回调没有扩展。普通文字复制和 `zotero/annotation` 拖放标识保留。图像/绘图走原生路径，但尚未完成实机工具验收。没有声称 Zotero 9、Windows、macOS 原生集成验证完成。

## 测试与验收

离线核心检查：

```sh
node --test tests/test_annotations.cjs tests/test_sync.cjs
```

涵盖原生 JSON 契约、译文附件归属、读写删除、关闭前未回调状态、立即重开等待、只读与外部批注保护、DB 失败的可见降级、同附件通知及原 split 复用。Node 内存替身验证逻辑，不是实际 Zotero UI 验收。

`tests/annotations_packaged.js` 是隔离原生入口。`prepare_packaged_test.py --suite annotations --run-id --phase` 安装真实 XPI 和独立 harness，注入以下全局 `PAPERBRIDGE_ANNOTATIONS_TEST`。只运行隔离 profile，不读取或启动日常 profile：

```js
{
  isolated: true,
  expectedProfileDirectory: "/absolute/disposable/annotations-profile",
  expectedDataDirectory: "/absolute/disposable/annotations-data",
  phase: "create", // Restart the same isolated profile with phase "reopen".
  sourcePDF: "/absolute/synthetic/source.pdf",
  translatedPDF: "/absolute/synthetic/translated.pdf",
  statePath: "/absolute/disposable/annotations-state.json",
  reportPath: "/absolute/disposable/annotations-create.json",
  quit: true
}
```

入口先精确核对实际 profile/data 与显式隔离目录；不匹配时不导入附件、不写测试报告，也不退出 Zotero。fixture 使用合成单页 PDF：至少两段独立、可划选的英文 text span，页面中部留白供笔记点击。路径按平台提供绝对路径。

`create` 通过原生工具栏和 Gecko trusted 鼠标划选创建高亮/下划线/笔记，实际输入完整评论后立刻关闭验证防抖补存，再经原生接口删除下划线，保存附件 key。`reopen` 必须在实际退出并重启**同一隔离 profile/data** 后运行，验证剩余批注、评论和独立 Zotero 阅读器。两阶段分别输出 pass/fail，不调用模型；还须核对进程退出和数据库完整性。

输入快照必须复制到 harness 自己的 JS realm，不能持有已销毁 iframe 的数组。保存前检查真实编辑器焦点和 trusted input；不构造批注状态来替代原生操作。

Linux 准备入口（在项目根目录执行，Python 使用项目环境）：

```sh
# First prepare source.pdf and translated.pdf under .runtime/annotations-fixture/.
.venv/bin/python scripts/prepare_packaged_test.py --suite annotations --run-id smoke --phase create
# Clear inherited Python/native-library overrides, then launch the printed isolated profile.
# Zotero -no-remote -profile <absolute-profile>; never launch the default profile for this suite.
# After the create process exits, retain the same profile/data and prepare phase reopen.
.venv/bin/python scripts/prepare_packaged_test.py --suite annotations --run-id smoke --phase reopen
# For a separate local-Python run, use another run-id and add --local-python <absolute-Python-3.12>.
```

### 当前验证摘要（2026-11-14）

- Linux Zotero **10.0.8** 的自带/本地 Python 两种当前 XPI，各完成 **21 项 create + 8 项实际进程重启**检查：完整文本高亮/下划线、便签评论、关闭前保存/删除、重开复用及独立阅读器查看同一批注。
- 四个最终进程均退出 0，两个测试库完整性均为 `ok`；实际安装 XPI 的哈希与当前构建一致。汇总与逐阶段证据索引见 `.runtime/p0-p1-native-verification.json`，核心离线批注检查为 **10 passed**。
- 合成 fixture 验证的是原生读写和生命周期，不是论文翻译质量。Zotero 9、Windows/macOS、区域/绘图工具及完整标签/QuickCopy 等能力尚未完成原生验收；旧的失败/未完成检查不计入通过结果。
