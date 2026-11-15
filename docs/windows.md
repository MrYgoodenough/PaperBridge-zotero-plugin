<!-- Windows runtime/build boundaries and isolated native verification entry points. -->
# Windows 安装与开发

Windows x64 稳定包仍为 **0.3.4**；共享源码 **0.3.6 候选**不自动更新公开通道。支持范围由 manifest 声明 Zotero 9/10，本轮原生环境为 Win11 / Zotero 10.0.8。Windows ARM64 尚未提供。独立 macOS 0.4.2 专属源码不在本轮合流/重建范围。

一般用户选择自带 Python XPI。`--python local` 仅借用本机 x64 CPython **3.12**，依赖、模型和 tokenizer 仍随包提供；在高级设置指定解释器，不把其他产品的 Python 当作已验证环境。安装已有译文/映射后，可信阅读不要求 Python。

## 从源码构建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
.\.venv\Scripts\python.exe -B scripts\stage_runtime.py
.\.venv\Scripts\python.exe -B scripts\build.py
.\.venv\Scripts\python.exe -B scripts\build.py --python local
```

`setup.ps1` 只在开发构建阶段准备 Python、依赖和模型/tokenizer。运行期不联网补引擎资源；中文字体从已安装宋体、可用粗体提取，不把系统字体缓存发货。Windows 继续使用官方 OpenCV headless wheel，仅沿用原有 FFmpeg shim 排除；Linux 的同 macOS 范围源码修剪不改变 Windows。

使用独立 `--stage-dir` / `--output-dir` 可避免覆盖已验收的 stage/XPI。每次生产源码/资源变更后重建，两种包分别记录完整 SHA-256、原生安装版本和实际 marker/health；同名旧包不会跟随源码更新。许可证据见 [licensing.md](licensing.md)，完整法律合规仍为 unknown。

## 平台维护入口

| 功能 | 入口与边界 |
| --- | --- |
| 平台与解释器 | `addon/content/runtime.js`、`scripts/stage_runtime.py`、`scripts/build.py`；Windows 使用 `python/python.exe`、`python/Lib/site-packages` |
| Gecko 路径 | 使用 `PathUtils.join(root, "folder", "file")`，避免混合分隔符；`PathUtils.normalize()` 会访问实际文件系统，不是纯字符串规范化 |
| Python 启动与退出 | `backend/launcher.py` / `server.py`；UTF-8、清理继承 Python/native 环境，父进程判断使用 Windows 句柄，不用 `os.kill(pid, 0)` |
| 字体 | `backend/fonts.py`；宋体和可用粗体，缺失只令相关功能失败并显示错误 |
| 保存与清理 | [任务和成果](tasks-and-results.md)；保留旧 PDF/映射/未知归属，缓存清理不取消任务 |
| 可同步映射 | [映射和阅读](engine-and-alignment.md)；Gecko hash、真实 PDF.js 页界与 exact keys，无 Python/backend 读取 |

常规任务尝试目录为 `jobs/attempts/<job-id>-<number>/`；旧布局仍读，不主动迁移。过深的数据路径仍可能触发 Gecko/Windows 解包限制；使用合理路径，失败给出诊断，不修改系统长路径设置或承诺所有极端路径可用。

## 原生验收

- 离线入口：项目 Python 执行 `scripts/check_offline.py --mode full`；Node 使用该项目工具。轻量 CI 不替代原生 Zotero。
- 合并 suite：`scripts/prepare_nonmac_test.py --suite assets --run-id <name> --phase create|reopen|receive`；调用 `tests/assets_packaged.js` 与独立 lifecycle helper，一次核对映射、双向逐行高亮、删除清理及冷重开。
- A→B 读取：停止 A 后仅种子化 metadata、保持 exact keys；B 的 `storage/` 为空，无任务/sidecar/引擎，经 Zotero 原生 WebDAV ZIP 下载再校验两份 PDF 和 JSON 字节。`tests/reading_asset_webdav.js` 不使用云 API key 或复制文件回退。这是隔离文件同步检查，不是账号云 metadata 同步验收。
- 原生 UI 必须在登录的交互 Session 运行；OpenSSH Session 0 不合适。只启动自有隔离 profile，正常退出后核对实际 UI PID/引擎消失和 SQLite integrity，不强杀日常进程。
- `reopen` 保留相同 profile/data/已安装插件；新进程才算冷重开。失败用新 report label，不覆盖旧证据。公共自动更新、0.3.4 升级保留、系统 100%/150% 缩放专项是不同范围，不能用本 suite 冒充全部通过。

稳定 0.3.4 历史依据见 [nonmac-verification-2026-11-15.json](nonmac-verification-2026-11-15.json)。后续每轮验收须绑定当轮精确 XPI hash；不借用历史通过结论。
