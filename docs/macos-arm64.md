# macOS Apple Silicon 构建与验收

在原生 arm64 终端中构建。需要 Xcode Command Line Tools 和支持 CPython 3.12.16 的 `uv`（候选 CI 使用 0.13.7）。首次准备依赖、版面模型和 OpenCV 源码需联网。

```sh
export UV_PYTHON_INSTALL_DIR="$PWD/.tools/python"
uv python install 3.12.16 --no-bin
uv sync --locked --managed-python --python 3.12.16
.venv/bin/python -B scripts/warmup.py
sh scripts/build_opencv.sh
.venv/bin/python -B scripts/stage_runtime.py
.venv/bin/python -B scripts/build.py --python bundled
.venv/bin/python -B scripts/build.py --python local
```

`dist/` 中的 `paperbridge-0.4.3-macos-arm64.xpi` 自带 Python。`-local-python.xpi` 需要本机 arm64 Python 3.12，依赖和版面模型仍随包提供。Zotero 的 **工具 → 插件 → 从文件安装** 可安装 XPI。两个变体使用同一个插件 ID，按需选择一个。构建时生成的更新清单位于 `dist/updates/`。

## 实际 Zotero 验收

在可打开 Zotero 窗口的 macOS 会话中运行。默认下载 CI 固定的 Zotero 10.0.8，也可用 `--zotero-app` 指定已安装的官方客户端。传入独立 macOS 0.4.2 XPI，额外测试其到自带 Python 候选包的文件安装升级。

```sh
bash scripts/check_native_macos.sh \
  --zotero-app /Applications/Zotero.app \
  --baseline-xpi /path/to/paperbridge-0.4.2-macos-arm64.xpi
```

测试使用独立 profile 和合成 PDF。两个变体验证原生安装、引擎启动、分屏渲染、批注保存与删除，以及进程退出后重开。升级测试使用 Zotero AddonManager，核对两个 XPI 的 SHA-256，并确认旧译文、批注、笔记、公式缓存及测试凭据保留。重开后还验证普通和窄窗设置，以及本地引擎检查。报告保存在 `dist/candidate-native-zotero/`。

验收范围为本地文件安装、原生交互和持久化。真实论文翻译质量、物理鼠标输入、公开自动更新仍需独立验收。 [上游 TODO #1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/issues/1)
