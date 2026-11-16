<!-- Linux image-only runtime scope, ABI requirements and native build inputs. -->
# Linux 原生构建与体积

Linux 共享版本 **0.3.7**，BabelDOC **0.6.4** / PyMuPDF **1.26.7** 不变。OpenCV 4.12.0 只保留 `core/imgproc/imgcodecs/python3`，沿用共享源码已有的 image-only 范围；不推进或重建 macOS，Windows 继续使用已有官方 wheel。

## 构成与边界

当前 Linux bundled/local XPI 为约 **217.7 / 181.7 MiB**；精确 bytes/hash 由每次构建的 `.xpi.inventory.json` 记录。仅用同 addon/backend 的旧 wheel 对照，image-only runtime 曾减少约 **55.25 MiB**；控制变量基线见 [linux-package-size-analysis-0.3.6.json](linux-package-size-analysis-0.3.6.json)。不能把源码或压缩参数变化也计作原生功能裁剪。

只移除 OpenCV 自有的视频/GUI/DNN/IPP/LAPACK 等非目标能力及独属库。PNG/JPEG/zlib 保留；其他依赖的 `.libs`、NumPy OpenBLAS、ONNX、PyMuPDF、CPython/libpython、模型及 tokenizer 不按名字删除。既有 `compact_math` 与标准库清理范围不扩大。

不引入 XZ 安装器、运行期补下载、模型量化、词表删减、后置 strip 或解释器别名还原。系统宋体/思源字体只在运行期本地提取，不随 XPI 分发；最终译文 PDF 使用实际字形子集。

## 原生 ABI

整包 Linux 基线为 **glibc ≥ 2.34**。兼容 image-only cv2 当前最高需 glibc 2.30 / GLIBCXX 3.4.26，RUNPATH 为 `$ORIGIN`。宿主 Ubuntu 24.04 默认工具链可能引入 glibc 2.38，不能直接作为较低基线发行输入。满足基线的其他发行版未逐一实机验证；musl/Alpine 和 ARM64 未提供包。

本机保留 GCC 10.2.1 / glibc 2.31 sysroot 工具链，仅用于构建，不进入 runtime。新工具链需检查实际 ELF 符号版本；源代码和编译退出成功不能证明二进制兼容性。

## 修改与构建入口

- `scripts/build_opencv_linux.sh`：源码 archive、MinSizeRel、静态模块、原生工具链和安装记录。
- `scripts/stage_runtime.py`：检查版本/模块/ABI/hash，复制 cv2 并改为相对路径；缺少正确 source-build 明确报错。
- `scripts/sanitize_runtime.py` / `build.py`：净化本机路径并每次重建 payload；原始 install hash 与净化后发货 hash 分别记录。

```sh
OPENCV_SOURCE_ARCHIVE="$PWD/.cache/opencv-4.12.0.tar.gz" \
OPENCV_TOOLCHAIN_FILE="$PWD/.cache/opencv-linux-x64/tools/opencv-native-gcc10.cmake" \
sh scripts/build_opencv_linux.sh

.venv/bin/python -B scripts/stage_runtime.py \
  --stage-dir "$PWD/.cache/package-candidate/linux-x64" \
  --opencv-install "$PWD/.cache/opencv-linux-x64/install"
.venv/bin/python -B scripts/build.py \
  --stage-dir "$PWD/.cache/package-candidate/linux-x64" \
  --output-dir "$PWD/dist/candidate"
```

`OPENCV_LINUX_WORK_DIR` 可独立指定源码/编译/安装目录；默认 `.cache/opencv-linux-x64/install`。`opencv-build.json` 保留 archive、CMake/ABI、扩展与工具链 hash。上述本机 sysroot 不自动提供给其他开发机；可准备等价环境或在满足基线的原生主机构建。

日常重打包使用已准备的 `.cache/package/linux-x64`。重新 staging 用独立路径，不覆盖已有基线；安装器作为 Release asset，构建目录不入 Git。

## 许可与验证

保留 OpenCV/codec 的原始 LICENSE/COPYRIGHT、IJG 归属以及 SoftFloat/fdlibm 源码许可头；完整源和构建输入随对应源码 ZIP 提供，见 [licensing.md](licensing.md)。不要格式化原始第三方许可。

新包需真实解释器下验证依赖导入、模型 CPU 推理、PNG/JPEG、tokenizer、字体复制/搜索和渲染，再在当前 XPI 的原生 Zotero 中检验保存/映射/冷重开。离线、ELF 分析和旧测量不替代新包、其他发行版或 Windows 原生结果，见[质量检查](quality-review.md)与[发布](releasing.md)。
