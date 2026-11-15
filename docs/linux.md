<!-- Linux installation requirements and native development entry points. -->
# Linux 安装与开发

Linux amd64 使用 `paperbridge-0.3.4-linux-x64.xpi`，支持 Zotero 9 / 10，实测环境为 Ubuntu 24.04 amd64、Zotero 10.0.8。安装包包含独立 CPython 3.12、CPU 版面引擎、模型和 tokenizer，运行时不依赖系统 Python、CUDA 或 ROS2。当前预编译包的 ELF 依赖要求 **glibc ≥ 2.34**，不使用 Ubuntu 24.04 专用接口；满足该基线的其他发行版尚未逐一实机验证。未提供 musl/Alpine 和 ARM64 安装包。

## 使用

1. 安装 Zotero 的官方 Linux amd64 版本。官方压缩包可直接解压到 `~/.local/opt` 等用户目录，再运行其中的 `zotero`；不需要覆盖系统文件。
2. 确认系统装有中文衬线字体和 fontconfig。Ubuntu 的 `fonts-noto-cjk` 提供所需的思源宋体；也支持已安装的 `Source Han Serif SC`、`Noto Serif SC` 或 `AR PL UMing CN`。插件不会自动改动系统字体包。
3. Zotero → 工具 → 插件 → 从文件安装插件，选择 Linux XPI。
4. 工具 → PaperBridge → 设置，保存 DeepSeek Key；打开论文 PDF 后点击「译 / 分屏」。

引擎解包至 Zotero 数据目录的 `paperbridge/engine`，缓存至 `paperbridge/cache`，任务状态至 `paperbridge/.runtime`。译文保存为论文条目下的 Zotero PDF 附件。中文字体从本机已安装的字体提取并嵌入译文 PDF，系统字体不会打入 XPI。

## 从源码构建

在 Linux amd64 检出源码后执行：

```sh
sh scripts/setup.sh
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py
# 可选：只打包依赖，使用本机 Python 3.12。
.venv/bin/python scripts/build.py --python local
```

`setup.sh` 优先使用已有 uv；没有时下载至 `.tools/bin`。独立 Python、虚拟环境、依赖缓存和模型均保存在项目内的 `.tools`、`.venv`、`.cache`、`.runtime`，不调用系统 pip 安装依赖，不修改 shell 配置。

0.3.6 Linux 候选使用 OpenCV 4.12.0 的 `core/imgproc/imgcodecs/python3` 源码构建，与既有 macOS 修剪范围相同；不再进一步精简。构建需 C/C++ 工具链、binutils 及项目 CMake/Ninja。Ubuntu 24.04 默认工具链会提高 glibc 下限，发布构建须使用兼容工具链/sysroot，详见 [Linux 包体积与构建](linux-package-size.md)。不运行 macOS 构建脚本，也不删除其他组件的 `.libs`、libpython、模型或词表。

开发服务通过 `sh scripts/serve.sh` 启动。Linux 服务和插件启动的 Python 子进程清除继承的 `PYTHONHOME`、`PYTHONPATH`、`LD_LIBRARY_PATH`、`LD_PRELOAD`，避免其他开发环境干扰；父进程的环境设置保持不变。

## 修改入口与验证

- 平台标识 `linux-x64`、解释器 `python/bin/python3.12`：`addon/content/runtime.js`、`scripts/stage_runtime.py`、`scripts/build.py`。
- 字体发现、简体字面提取：`backend/fonts.py`。通过 fontconfig 查询真实已安装的字体，避免将缺失字体的无关替代字面当作中文字体。
- 可同步映射与不启动 Python 的阅读：`addon/content/reading-assets.js`；存储/hash/降级契约见 [映射架构](engine-and-alignment.md)。
- 隔离映射、逐行高亮、删除清理与冷重开：`scripts/prepare_nonmac_test.py --suite assets`、`tests/assets_packaged.js`、`tests/lifecycle_asset_packaged.js`。缓存复用及合成归属检查不调用付费服务，不代表语义质量接受。
- 真实论文/跨栏几何与冷启动：`scripts/prepare_nonmac_test.py --suite reading`、`tests/reading_packaged.js`；原生更新与冷启动持久化：同一 helper 的 `--suite update`、`tests/update_packaged.js`。`--phase reopen` 只更新外部测试参数，不替换插件或清空缓存。

```sh
.venv/bin/python -B scripts/check_offline.py --mode full
# Start only the explicitly prepared, disposable native profile.
/path/to/zotero -no-remote -profile /absolute/path/to/isolated-profile
```

`--phase reopen` 使用同一 profile/data 和真新进程，不复制已安装 XPI、不清空缓存；失败重试用新 `--report-label` 保留原证据。测试辅助插件不会进入正式安装包。历史 `tests/packaged.js` 默认可能调用付费服务，不属于无费用原生验收入口，须另获明确授权。

历史 0.3.1 的翻译、字体、缓存与生命周期范围见 [linux-verification-0.3.1.json](linux-verification-0.3.1.json)，不能替代新包的原生或全文质量验收。段落高亮以可追溯翻译请求为单位；重排、跨页或多义区域不猜配，接口缺失只停用高亮。
