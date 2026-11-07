# Linux amd64 适配执行简报

执行者：Codex；日期：2026-11-07（Asia/Shanghai）。

## 完成内容

- 通过 Tailscale 连接 nvidia，为本机生成专用 Ed25519 密钥 `~/.ssh/703nvidia`，追加远端 authorized_keys；配置 `ssh nvidia` / `ssh 703nvidia` 免密登录。不改动 sshd 配置。
- 从用户下载的 `Zotero-10.0.8_linux-x86_64.tar.xz` 安装 Zotero 到远端用户目录 `~/.local/opt/Zotero_linux-x86_64`，添加用户级命令和桌面启动器。
- 在 `/home/nvidia/scq/ZoteroPlugin/PaperBridge-zotero-plugin` 建立独立 uv / CPython 3.12.16 环境，构建 Linux 自带 Python XPI。没有安装系统软件包、修改系统 Python、更新操作系统或改动 ROS2。
- 直接扩展原有平台识别、打包和字体来源：`linux-x64`、Linux 解释器及依赖目录、思源宋体简体字面、官方 OpenCV wheel、Zotero 10 兼容声明。
- Linux 子进程清除继承的 Python/原生库路径，避免 ROS/Conda 环境干扰；Linux shell 文件使用 LF。
- 补充 Linux 使用说明、验证数据和当前 MEMORY；忽略 agent 过程目录。没有新建分支或 worktree，没有修改 TODO。

## 验证结果

实测：Ubuntu 24.04.4 amd64、Zotero 10.0.8、BabelDOC 0.6.4、打包 CPython 3.12.16。

| 项目 | 实际结果 |
|---|---|
| Python 现有测试 | Linux 36 通过、0 跳过；Windows 35 通过、1 个缺少样例的跳过 |
| 分屏同步脚本 | 通过 |
| 实际 XPI 自动解包及独立解释器 | 通过，包含原生库导入及 ssl/sqlite3 |
| 设置保存及 Key 重启读取 | 通过，Key 未显示在输出或报告中 |
| 真实 DeepSeek 第 2–4 页翻译 | 10 次 API；输入 5,610 token，缓存命中 768、未命中 4,842；输出 3,883 token |
| PDF 中文及字体 | 三页 1,360 / 1,572 / 1,109 个中文字符；嵌入 Noto Serif CJK SC 常规/粗体 |
| 页面及未选页 | 总计 17 页，全部页面尺寸和未选页原文保持一致 |
| 阅读功能 | 双向同步、独立阅读、关闭清理、保存 Zotero 附件均通过 |
| 再次打开译文 | 全文缓存复用，0 次 API |
| 文献生命周期 | 10 项通过：删除原 PDF 保留译文、删除论文清理、共享缓存及分类移除、启动补做清理等 |
| 公式保护 | 第 5 页 3 个区域文本匹配，平均像素误差 0 / 0.2247 / 0.2105（0–255） |
| 参考文献保护 | 35 条未发送 LLM；文本匹配，5 个保护区域像素误差均为 0；正文和附录继续翻译 |
| 运行中取消 | 实际引擎子进程启动后取消，子进程停止，0 次完成 API 请求 |
| Zotero 退出 | 引擎停止，数据库完整性检查 `ok` |
| 环境保护 | `.bashrc`、`.profile`、ROS2 Jazzy setup/local_setup 哈希前后相同 |

## 产物与兼容范围

- 远端安装包：`/home/nvidia/scq/ZoteroPlugin/PaperBridge-zotero-plugin/dist/paperbridge-0.3.1-linux-x64.xpi`，286,058,710 bytes。
- SHA-256：`300e6cde36f9dd6629ad451ba5a8170a10403cd5418af9612ab3d782360a2239`。
- Linux amd64，当前 ELF 基线 glibc ≥ 2.34；不使用 Ubuntu 24.04 专用接口。其他发行版、Linux Zotero 9、Linux 本机 Python 完整集成未实机复测；ARM64/musl 未提供包。
- 实测数据：`docs/linux-verification-0.3.1.json`；使用说明：`docs/linux.md`。测试 profile/data 和过程文件均位于工程内。

## 限制与执行情况

- Tailscale 走香港中继，较大 XPI 回传本机未完成；安装包已在 nvidia 构建并实测，可直接在其 Zotero 中安装。部分下载不作为完整安装包交付。
- 离线排版日志出现上游 MuPDF charstring 警告；保护区域检查通过。隔离测试自动退出阶段有 Zotero 事务关闭警告，退出后的数据库完整性和引擎停止检查通过。
- dsh CLI 在默认及官方 npm registry 均返回 ETARGET，未能承担文档等辅助工作；该部分由主代理完成。两个独立代码子任务由 6.1-sol medium 子代理处理，主代理整合并实机验证。
- 本机界面操作被用户 Escape 中止后未继续；通过 Zotero 自带 NSS API 从隔离数据库副本读取已有测试 Key，没有改动日常文献库。
