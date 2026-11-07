# Windows Zotero 10 兼容性更新

执行者：codex；日期：2026-11-07（Asia/Shanghai）。

## 结果与修改

截图的问题来自已安装的 Windows 0.3.1 XPI 内 `strict_max_version: 9.*`，
本机插件状态为 `appDisabled: true`。当前 master 源码已声明 `10.*`，
因此直接按现有源码重建 Windows 包，没有增加另一套插件实现或修改 Zotero 的兼容判定。

- 重建自带 Python 和本机 Python 两种 Windows XPI，更新各自 SHA256 文件。
- 修正 `tests/packaged.js` 的旧引擎目录过滤，使用 `PathUtils.filename` 兼容 Windows 反斜杠。
- 安装完整包前备份旧包；将完整新包替换到本机正常 profile，插件管理器显示 Enabled，原红色不兼容提示消失。
- 更新 README、Windows 说明、结构化验证摘要及 MEMORY；未修改 TODO。

## 验证

- 项目 Python 测试：35 通过、1 因缺少可选参考文献 PDF 样例跳过；坐标同步测试与 JS 语法检查通过。
- 两种 XPI 的 ZIP CRC 通过；完整包内 addon/backend 与当前源码逐文件一致。
- 使用独立的 Zotero 10.0.6 程序副本、profile 和数据目录验证完整 XPI，没有用测试操作日常文献库。
- 菜单与阅读器按钮、设置保存、引擎解包（13.7 秒）、独立 Python 启动和模型播种通过。
- 真实论文第 1 页重排耗时 36 秒，17 条段落缓存命中、0 次 API；译文保存为 Zotero 附件。
- 第 1 页含 798 个中文字符并嵌入 SimSun；15 页尺寸一致，未选中的 14 页文字与原文一致。
- 前向同步、反向同步、独立阅读、关闭分屏清理均通过。隔离库 SQLite integrity_check 为 ok。
- 正常启动时 Zotero 自动应用其已预下载的 10.0.8 更新；正常 profile 插件 active=true、appDisabled=false，
  工具菜单与「译 / 分屏」可见，实际插件管理器显示 Enabled。

## 交付与范围

- 完整包：`dist/paperbridge-0.3.1-windows-x64.xpi`，198,838,084 bytes（189.63 MiB）。
  SHA256：`40c42ca37466b381d086e9d4ee8bf983060b9714dc69ed7a2d4528ce0fecf037`。
- 本机 Python 包：`dist/paperbridge-0.3.1-windows-x64-local-python.xpi`，186,904,616 bytes（178.25 MiB）。
  SHA256：`d8ab08f69aac5921402660380aa8a906602ba824f43bef9644b48119e79e79bf`。
- 验证摘要：`docs/windows-compatibility-0.3.1.json`。
- 本机旧安装包备份：`agent/codex/windows-zotero10-backup/installed-paperbridge-zotero9.xpi`。
- 详细隔离验收结果与过程文件：`agent/codex/windows-zotero10/`。

本轮未验证新的 DeepSeek API 请求、重启后的 Key 持久化或本机 Python 包的完整集成；
10.0.8 仅检查正常加载，完整功能验证在 10.0.6 上完成。GitHub Release 附件未替换，
当前插件 update_url 为占位地址，已有安装需从新 XPI 手动更新。XPI 版本保持 0.3.1。

隔离程序副本的 Windows 界面抓取曾报 `window id ... no longer belongs to Zotero.Zotero.9.0.6; current owner is Zotero.Zotero.9.0.6`；
该工具未能绑定复制的程序窗口。隔离验收使用 Zotero 内的测试辅助插件输出，
正常安装程序的界面抓取恢复正常并确认插件 Enabled。隔离程序进程已停止，正常 Zotero 保持打开。
