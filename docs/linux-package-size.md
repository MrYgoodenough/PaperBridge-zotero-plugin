<!-- Current Linux image-only package measurements and native build entry points. -->
# Linux 0.3.6 安装包体积与原生构建

P1-6 只把 Linux 修剪到共享源码中已有的 macOS 范围：**image-only OpenCV、既有 compact_math 替代、既有标准库测试/UI/开发文件清理**。BabelDOC 仍固定 0.6.4，模型、tokenizer 和其他必要原生库保留。不推进 macOS 专属源码，也不重建或覆盖其发布包。

## 实测结果

日期：2026-11-15；1 MiB = 1,048,576 bytes。下表的前后包使用**同一份 0.3.6 addon/backend 快照**，分别配旧官方 wheel runtime 和新 image-only runtime，重新生成 ZIP payload；没有用压缩参数微调冒充原生裁剪。

| 测量包 | 旧 runtime bytes / MiB | image-only bytes / MiB | 减少 |
| --- | ---: | ---: | ---: |
| 自带 Python | 286,157,409 / 272.90 | 228,221,290 / 217.65 | 57,936,119 bytes / 55.25 MiB |
| 本机 Python | 248,239,170 / 236.74 | 190,303,052 / 181.49 | 57,936,118 bytes / 55.25 MiB |

这些是体积对照包，**不是最终发布或 Zotero 验收包**：快照早于最终 `NOTICE.md`/addon 统合。最终已重建并在 Linux/Windows 原生验收的 Linux 两包分别为 **228,293,495 / 190,375,257 bytes**，精确 SHA 与范围见 [当前验收](nonmac-verification-0.3.6.json)。历史 0.3.4 Linux 自带包为 286,130,568 bytes / 272.88 MiB，不能把源码快照变化也计作 runtime 裁剪。

| 自带包组件 | 旧未压缩 / ZIP 压缩 MiB | 新未压缩 / ZIP 压缩 MiB |
| --- | ---: | ---: |
| OpenCV 与其所属库/元数据 | 152.10 / 58.36 | 9.64 / 3.12 |
| 其他依赖 | 319.13 / 113.22 | 319.13 / 113.22 |
| 解释器与标准库 | 106.00 / 36.04 | 106.00 / 36.04 |
| 原版面模型 | 71.84 / 61.82 | 71.84 / 61.82 |
| 原 tokenizer | 3.45 / 1.62 | 3.45 / 1.62 |

OpenCV 从 63 个发货文件变为 18 个；其新扩展本体为 **10,064,816 bytes**，cv2 全目录为 **10,113,320 bytes**。减少的是原生功能和独属库，不是模型量化或词表缩减。完整 bytes、SHA-256、文件排除、许可材料及验证范围见 [0.3.6 机器可读记录](linux-package-size-analysis-0.3.6.json)。

## 当前实现

- `scripts/build_opencv_linux.sh` 独立构建 OpenCV 4.12.0，只含 `core/imgproc/imgcodecs/python3`，使用与 macOS 相同的 MinSizeRel、静态模块和安装方法；不做后置 strip。原 macOS 脚本不变，Windows 继续保留官方 wheel。
- 关闭视频、GUI、DNN、IPP、LAPACK 和其他非目标功能；PNG/JPEG/zlib 静态随 cv2 链入。因此仅去掉 **OpenCV-owned** FFmpeg、AVIF/AOM/VPX、BLAS/Fortran、SSL 等库，不按库名删除其他依赖的 `.libs`。NumPy 的 OpenBLAS、ONNX、PyMuPDF 等原生库保留。
- `stage_runtime.py` 在替换 stage 前检查 Linux source-build 的版本、模块、ABI 和扩展 hash，再复制 cv2、改写相对 loader 路径。缺少源码构建时明确报错，不静默回退大 wheel。
- scipy/sklearn/skimage/model-hub 及闲置依赖的省略属于原有 `compact_math` 设计，本任务没有新增替代接口。标准库的原有清理规则不扩大。
- 自带版的 **613 个发货解释器/标准库文件逐字节不变**，包括 libpython 的两份别名文件和扩展。旧 stage 的 31 个标准库 bytecode 缓存仍按原规则不发货，不算额外瘦身。
- 不引入 XZ、安装 bootstrap、libpython 别名还原、模型/tokenizer 删除或运行期下载。字体继续从已安装系统字体发现/提取，不把开发机字体缓存发货。

## 构建与 staging

Linux `setup.sh` 现在在开发环境准备后取得官方 OpenCV 4.12.0 源码并调用新脚本；下载只发生在**开发构建阶段**。构建本身可在禁网环境运行。需要已有项目 `.venv`、锁定的 CMake/Ninja dev tools，以及本机 C/C++ 工具链和 binutils；无需新增 Python 运行时依赖。

原生库的 glibc 下限由**构建工具链**决定。本机 Ubuntu 24.04 默认工具链会引入 glibc 2.38 符号，不能直接拿该产物替换现有 glibc 2.34 基线。本轮采用构建专用 GCC 10.2.1 / glibc 2.31 sysroot；新 cv2 实际最高要求 **glibc 2.30 / GLIBCXX 3.4.26**，RUNPATH 为 `$ORIGIN`。sysroot 不进入 runtime，全包既有 glibc 2.34 基线不因此改变。

在兼容基线的 Linux 主机上直接构建，或用 `OPENCV_TOOLCHAIN_FILE` 选择现有兼容 native sysroot。脚本记录实际 glibc 要求；新工具链若提高下限会告警，发布前必须检查。

```sh
# Source archive is local; only developer setup downloads it if absent.
OPENCV_SOURCE_ARCHIVE="$PWD/.cache/opencv-4.12.0.tar.gz" \
OPENCV_TOOLCHAIN_FILE="$PWD/.cache/opencv-linux-x64/tools/opencv-native-gcc10.cmake" \
sh scripts/build_opencv_linux.sh

.venv/bin/python -B scripts/stage_runtime.py \
  --stage-dir "$PWD/.cache/package-candidate/linux-x64" \
  --opencv-install "$PWD/.cache/opencv-linux-x64/install"

.venv/bin/python -B scripts/build.py \
  --stage-dir "$PWD/.cache/package-candidate/linux-x64" \
  --output-dir "$PWD/.cache/package-candidate/xpi"
```

`OPENCV_LINUX_WORK_DIR` 可独立指定源码/编译/安装目录；默认安装为 `.cache/opencv-linux-x64/install`，与 macOS `.cache/opencv-install` 分离。构建记录为安装目录中的 `opencv-build.json`，包含源码 archive hash、ABI、NumPy/CMake、扩展 hash、CMake cache hash 和可选 toolchain hash。

上述 toolchain 路径是本机保留的 GCC 10/sysroot 构建输入，不由源码自动提供；其他机器须准备等价环境或使用满足基线的原生主机。本机源码包、兼容 install、toolchain/sysroot 与构建证据均在 `.cache` 下保留。

通过验收的 stage 已移至默认 `.cache/package/linux-x64`，旧 wheel stage 保留在 `.cache/package-baselines/linux-x64-before-image-only-20261115`。后续候选 staging 仍应使用独立 `--stage-dir`，避免直接重建覆盖基线。`build.py` 每次重新生成当前 payload，`--output-dir` 避免覆盖旧 dist。

安装目录记录源码编译的原始 cv2 hash；staging/build 的本机路径净化会改变该 hash。最终 XPI `runtime.json` 同时记录原始 hash、实际发货 hash 和 `pathSanitized`，不把两者当成同一字节产物。默认 stage 的 cv2 字节与已验收包一致。

## 许可与验证范围

cv2 保留 OpenCV 原 `LICENSE`/`COPYRIGHT`，libjpeg-turbo、libpng、zlib 许可，IJG 的 `README.ijg` 与要求的归属声明，以及 core 中 SoftFloat/fdlibm 的原始许可头。其实际源文件/hash 记录供许可 worker 统合；本任务不把所有其他组件的许可状态擅自标为已解决。

已完成：

- staging/build/font 检查 **16 passed**；用新 cv2 对照开发环境原始数学工具库 **3 passed**。
- 自带和本机 Python 均用 `-I -S -B`、独立缓存及内核禁网环境运行；依赖导入、ssl/sqlite3/ctypes/多进程相关标准库、tokenizer、PNG/JPEG、字体真实子进程 subset、PDF 字体嵌入/复制提取/渲染通过。
- 保留模型对真实 scikit-learn 论文第一页执行 CPU 推理，**29 个检测结果与旧 wheel 完全相同**；SSIM、token IDs、字体 PDF 像素 hash 也相同。网络尝试和 provider 调用均为 **0**。
- 四份测量 XPI 的全量 CRC 通过；其他发货依赖、解释器、模型、词表的字节/压缩体积不变；任务结束核对时原 stage 与 46 个受保护旧输出 hash 未变。

这些检查不替代 main 对最终 0.3.6 addon/许可包的 Linux/Windows 原生验收。仅在 Ubuntu 24.04 执行本任务原生检查；旧发行版下限由 ELF 核对，未冒充其他发行版、Windows 或 macOS 实机认证。
