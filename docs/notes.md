<!-- Native note serialization, attachment backlinks and narrow reader integration. -->
# 选区与批注 → Zotero 独立笔记

`addon/content/notes.js` 将译文选区或已保存批注转换为独立 Zotero note；`alignment.js` 接入现有分屏工具栏。笔记、批注和 PDF 是独立阅读资产，不调用模型，不修改 PDF。

## 使用与维护入口

- **选区存笔记**：只读当前右侧 PDF.js 选区，以实际译文附件和物理页创建笔记。
- **批注汇总笔记**：读取译文附件原生批注，生成独立笔记。普通文本提取、格式序列化和引用交给 Zotero API。
- `notes.js` 负责校验、序列化和保存；`alignment.js` 负责按钮、单次进行中的 UI 锁和明确成功/失败提示。
- `paperbridge.js` 负责现有右侧 reader 边界；`annotations.js` 负责批注持久化，见[批注说明](annotations.md)。

新 `Zotero.Item("note")` **不预设 key**，由原生保存生成；通过官方 serializer 创建 citation/annotation 元数据，再调用一次 `saveTx()`。页标签可能是罗马数字或出版页码，但附件回链使用实际物理页，不把标签直接当页索引。笔记属于正确 library/parent，原生链接指向正确译文附件。

## 边界与失败处理

- 不复制原文批注到译文，不做语义匹配或双向批注同步。
- 选区必须来自当前目标 reader，不使用过期 iframe、其他标签页或来源不明的 HTML。
- 对输入 HTML 只保留所需结构，避免事件属性和非预期外链进入 note；普通选区文本仍使用 Zotero 序列化契约。
- 快速重复点击共享一次保存；失败释放锁并明确显示，不以 UI 成功文本代替实际保存。
- reader 关闭/替换后不继续持有其可变数组；必要快照复制到宿主 realm。
- 无选区、只读条目或缺失接口只让该操作不可用，原有 PDF 阅读继续。

笔记编辑器和原生链接由 Zotero 打开；不要另外创建假编辑器、伪造点击或通过改动笔记 URI 绕过失败。对 PDF.js/reader 私有接口的使用保持局部，升级 Zotero 时复核真实选区、序列化、附件回链和编辑器 item。

## 验证入口

```sh
node --test tests/test_notes.cjs tests/test_annotations.cjs
.venv/bin/python -B scripts/check_offline.py --mode full
```

原生检查由 `alignment_packaged.js` 和 `windows_supplement_packaged.js` 接入已有隔离测试：实际选区/高亮、正式 note 编辑器、可信回链、关闭前保存，以及同 profile/data 新 PID 冷重开。使用明确的原/译 PDF 与当前包 hash。合成数据、Node 替身和真实论文语义质量是不同证据；不在维护文档堆叠运行日志。
