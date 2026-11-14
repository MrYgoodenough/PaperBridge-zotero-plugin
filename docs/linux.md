<!-- Linux installation requirements and native development entry points. -->
# Linux 安装与开发

Linux amd64 使用 `paperbridge-0.3.3-linux-x64.xpi`，支持 Zotero 9 / 10，实测环境为 Ubuntu 24.04 amd64、Zotero 10.0.8。安装包包含独立 CPython 3.12、CPU 版面引擎、模型和 tokenizer，运行时不依赖系统 Python、CUDA 或 ROS2。当前预编译包的 ELF 依赖要求 **glibc ≥ 2.34**，不使用 Ubuntu 24.04 专用接口；满足该基线的其他发行版尚未逐一实机验证。未提供 musl/Alpine 和 ARM64 安装包。

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

`setup.sh` 优先使用已有 uv；没有时下载至 `.tools/bin`。独立 Python、虚拟环境、依赖缓存和模型均保存在项目内的 `.tools`、`.venv`、`.cache`、`.runtime`，不调用系统 pip 安装依赖，不修改 shell 配置或 ROS2 文件。Linux 使用官方 OpenCV headless wheel；无需运行 macOS 的 `build_opencv.sh`。

开发服务通过 `sh scripts/serve.sh` 启动。Linux 服务和插件启动的 Python 子进程清除继承的 `PYTHONHOME`、`PYTHONPATH`、`LD_LIBRARY_PATH`、`LD_PRELOAD`，避免其他开发环境干扰；父进程的环境设置保持不变。

## 修改入口与验证

- 平台标识 `linux-x64`、解释器 `python/bin/python3.12`：`addon/content/runtime.js`、`scripts/stage_runtime.py`、`scripts/build.py`。
- 字体发现、简体字面提取：`backend/fonts.py`。通过 fontconfig 查询真实已安装的字体，避免将缺失字体的无关替代字面当作中文字体。
- 隔离 Zotero 配置和数据目录：`scripts/prepare_packaged_test.py`；真实 XPI 的设置、重启、翻译、阅读和缓存验证：`tests/packaged.js`；文献生命周期：`tests/lifecycle.js`。
- 真实论文/跨栏几何与冷启动：`scripts/prepare_nonmac_test.py --suite reading`、`tests/reading_packaged.js`；原生更新与冷启动持久化：同一 helper 的 `--suite update`、`tests/update_packaged.js`。`--phase reopen` 只更新外部测试参数，不替换插件或清空缓存。

```sh
.venv/bin/python -m pytest tests --basetemp=.runtime/pytest-linux -q
node tests/test_sync.cjs
.venv/bin/python scripts/prepare_packaged_test.py
xvfb-run -a /path/to/zotero -no-remote -profile "$PWD/.runtime/packaged-profile"
```

图形测试使用独立的 `.runtime/packaged-profile` 和 `.runtime/packaged-data`，不会读取或修改日常文献库。首次测试保存临时 Key 并返回 `restart-required`；再次启动从忽略的 `.env` 读取测试用 `DEEPSEEK_API_KEY`，翻译真实论文第 2–4 页。测试辅助插件不会进入正式安装包。

历史 0.3.1 的翻译、字体、缓存与生命周期范围见 [linux-verification-0.3.1.json](linux-verification-0.3.1.json)，不能替代新包的原生或全文质量验收。段落高亮以可追溯翻译请求为单位；重排、跨页或多义区域不猜配，接口缺失只停用高亮。
