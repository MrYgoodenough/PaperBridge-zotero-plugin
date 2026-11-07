# 当前开发基线

- 项目为 PaperBridge 0.3.1：Zotero 9 / 10 插件，后端固定 BabelDOC 0.6.4，默认 DeepSeek `deepseek-flash`。源码主分支为 `master`。
- Windows 自带 Python 的 0.3.1 包已按 Zotero 9 / 10 兼容声明重建：Windows Zotero 10.0.6 的解包、选页缓存翻译、宋体嵌入及双向分屏实测通过；本机正常 profile 在 Zotero 10.0.8 下已启用。摘要见 `docs/windows-compatibility-0.3.1.json`。
- 兼容声明更新后必须重建各平台 XPI；同名旧包不会跟随源码更新。当前 `update_url` 仍为占位地址，本机需重新安装 XPI。此次 Windows 重建包已替换本机安装，GitHub Release 附件尚未替换。
- 运行时按 `macos-arm64`、`windows-x64`、`linux-x64` 独立构建。Linux amd64 自带 CPython 3.12，解释器路径 `python/bin/python3.12`；当前 Linux 包的原生库要求 glibc ≥ 2.34。Ubuntu 24.04 + Zotero 10.0.8 已实测，其他发行版尚未实机验证。
- Linux 使用官方 OpenCV headless wheel，需保留各 wheel 的 `.libs`；仅 macOS 需要自编译精简 OpenCV。打包用 uv 管理的独立解释器，不用系统 Python 作为可重定位运行时。
- Linux 中文字体通过 fontconfig 查询已安装的思源宋体等中文衬线字体，选择简体中文字面并导出到插件缓存；CFF 字面以 `.ttf` 缓存名保存，但 PDF 中实际为嵌入的 OTF。系统字体不随 XPI 分发。
- 项目及插件启动的 Linux Python 清除继承的 Python 和原生库路径；不修改父环境、系统 Python、ROS2 或 shell 配置。开发环境、模型、测试状态位于项目自己的 `.tools`、`.venv`、`.cache`、`.runtime`。
- 正式译文是 Zotero 论文条目下的 PDF 附件；缓存归属依据文献库、论文 key、原 PDF key、译文 key。删除原 PDF 保留译文；删除最后一个论文归属才清理共享缓存。不要以文件系统临时 PDF 替代 Zotero 附件归属。

## Linux 接续验证

- SSH 别名 `nvidia` / `703nvidia` 使用本机专用 `703nvidia` 密钥。远端工程位于 `/home/nvidia/scq/ZoteroPlugin/PaperBridge-zotero-plugin`；Zotero 位于 `~/.local/opt/Zotero_linux-x86_64`，用户启动器 `~/.local/bin/zotero`。不得改变该主机的 ROS2 和其他项目环境。
- `scripts/prepare_packaged_test.py` 使用隔离 profile/data，实际 XPI 验证入口是 `tests/packaged.js`。首轮保存临时 Key，重启后从测试 `.env` 输入真实 Key；正式插件仍从 Zotero 登录管理器读取。不要将真实 Key 或密钥数据库提交到仓库。
- 2026-11-07 Linux 实测通过：真实三页翻译、字体嵌入、未选页保留、双向同步、独立阅读、全文缓存复用、10 项文献生命周期检查、公式/参考文献保护、运行中取消、退出后停止引擎。证据在 `docs/linux-verification-0.3.1.json`，使用说明在 `docs/linux.md`。
- `agent/codex`、`agent/grok`、`agent/dsh` 是忽略的本地过程目录；不要默认读取。`agent/report` 保存任务简报，`agent/task` 只放用户提供的任务文件。

## 仍需注意

- Linux `--python local` 可构建且平台探测已检查，但此次完整 XPI 集成验证针对自带 Python 版；Linux Zotero 9 与其他发行版未重复实机验证。
- 上游引擎在 API 错误时可能保留原文继续排版；验收不能只看任务“完成”，应检查真实 API 用量、中文字符和输出 PDF。
- 隔离测试自动退出阶段出现过 Zotero 的事务关闭警告；退出后的 `PRAGMA integrity_check` 为 `ok`，引擎已停止。快速重复文献操作后的退出仍需留意该上游警告。
