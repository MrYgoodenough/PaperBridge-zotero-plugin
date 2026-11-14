<!-- Linux XPI size feasibility study based on the four current 0.3.4 release archives. -->
# Linux XPI 体积：0.3.4 实测与离线自带路线

研究日期：2026-11-15。**本轮只研究，没有修改生产 runtime、XPI 或构建脚本，也没有生成已验收的瘦身安装包。** 精确到文件的原始大小、压缩大小、SHA-256、组件归属及副本实验见 [机器可读证据](linux-package-size-analysis-2026-11-15.json)。下文统一使用 MiB（1,048,576 bytes），不是下载站常用的十进制 MB。

## 结论

- Linux 自带版 **272.88 MiB**，Windows 自带版 **189.70 MiB**，相差 **83.18 MiB / 43.85%**。其中依赖差额 **58.30 MiB**、解释器差额 **24.76 MiB**；模型与词表的差额为 **0**。
- 不换模型、不删解释器、不依赖联网补资源，现有 ZIP 格式下，显式 DEFLATE 9、只处理已检查的依赖调试/普通符号，以及还原 `libpython` 别名的方案，数据预算可减少 **16.59–18.75 MiB**，约到 **256.29–254.13 MiB**。这不是把整个 83.18 MiB 差额都认定为冗余。
- 保留官方依赖全部文件，改用离线内层 `tar.xz`，副本压缩预算约 **213.96 MiB**；再还原 `libpython` 别名为 **204.17 MiB**，模型也无损 XZ 压缩则约 **201.07 MiB**。后者需要改首次解包/缓存入口，**不是当前安装器直接支持的 XPI**，还须加安装器代码和原生验收。
- 真正的大组件是 Linux OpenCV 的视频、BLAS 等原生库。后置的 image-only 自编译路线值得研究；直接删现有 `.libs` 会破坏动态加载。**一刀切 strip 当前 CPython 也已在专属副本上实测失败。**

“离线自带”指安装、解释器、排版依赖、DocLayout 模型和 tokenizer 无须联网补齐，不表示 DeepSeek 翻译本身是离线本地大模型。系统 glibc、当前系统字体发现路线等既有要求不因这些方案消失。

## 1. 基线与统计口径

| 当前 dist 的 0.3.4 XPI | 文件大小 bytes | XPI MiB | ZipInfo 未压缩合计 MiB | 条目数 |
| --- | ---: | ---: | ---: | ---: |
| `linux-x64` 自带 Python | 286,130,568 | 272.88 | 652.88 | 6,570 |
| `linux-x64-local-python` | 248,212,325 | 236.71 | 546.88 | 5,957 |
| `windows-x64` 自带 Python | 198,909,872 | 189.70 | 422.67 | 6,550 |
| `windows-x64-local-python` | 186,976,407 | 178.31 | 389.03 | 5,977 |

方法及核对：

- 直接读取四包全部 `ZipInfo`，累加 `compress_size` / `file_size`，逐文件解压读取、CRC 校验和 SHA-256；四份 XPI 校验文件匹配，研究结束时四包 SHA-256 仍与输入一致。
- 按 wheel 的 `METADATA` / `RECORD` 归属依赖，统一 Windows RECORD 的反斜杠；依赖文件没有漏归属或归属冲突。组件统计包括其 Python 源码、原生库、`.libs` 和元数据，不把共享命名空间误算成某个单独目录。
- 四包均只用 ZIP method 8（DEFLATE）。Linux 自带版 ZIP 结构开销 **1,788,812 bytes / 1.71 MiB**，Windows 为 **1,664,616 bytes / 1.59 MiB**。整包大小不是仅把压缩数据相加；JSON 将本地文件头、中央目录、22-byte EOCD 单独对账。
- `scripts/build.py` 将缓存的 runtime ZIP 直接作为 XPI 再追加 addon/backend，**不是在 XPI 中又嵌套一份 runtime.zip**。唯一 `.whl` 嵌套条目是 Linux 标准库的 ensurepip/pip。
- 以这四个已构建 XPI 的 hash 快照为准，不把工作区其他并行源码修改算进它们。JSON 同时记录初始/文稿采集时源码 hash；例如并行新增 build 的包清单导出，不是本任务修改，不能用源码 hash 的变化推断 XPI 已变化。源码读取包括 AGENTS/MEMORY 和构建、解包、离线资源入口；没有读取历史 `agent/codex` / `agent/grok`。

Linux 本地 Python 包仍比 Windows 同模式大 **61,235,918 bytes / 58.40 MiB / 32.75%**。同平台两模式的依赖和模型逐文件相同，只有 `manifest.json`、`runtime.json` 内容随模式改变；自带版另有 Linux **613** / Windows **573** 个解释器文件。去掉这些文件分别减少整包 **36.16 / 11.38 MiB**，但 **local 模式要求用户已有合适 Python，不能当作相同一键便利的瘦身答案**。

## 2. Linux 比 Windows 大在哪里

下表为自带版的**压缩数据**，不含 ZIP 文件头。`@python` 包括可执行文件、标准库、动态模块和 libpython。

| 组件 | Linux MiB | Windows MiB | Linux−Windows MiB | 差额 bytes |
| --- | ---: | ---: | ---: | ---: |
| opencv-python-headless | 58.36 | 29.39 | 28.97 | 30,374,159 |
| @python | 36.04 | 11.28 | 24.76 | 25,964,184 |
| onnxruntime | 22.60 | 14.14 | 8.46 | 8,868,028 |
| PyMuPDF | 22.50 | 17.05 | 5.45 | 5,712,203 |
| numpy | 14.17 | 10.19 | 3.98 | 4,169,325 |
| fonttools | 4.28 | 1.51 | 2.78 | 2,911,893 |
| RapidFuzz | 3.01 | 1.64 | 1.37 | 1,436,142 |
| lxml | 4.75 | 3.56 | 1.19 | 1,247,897 |
| cryptography | 4.51 | 3.52 | 0.99 | 1,042,602 |
| onnx | 3.18 | 2.21 | 0.97 | 1,013,718 |
| hyperscan | 2.62 | 1.87 | 0.75 | 790,800 |
| PyYAML | 0.77 | 0.14 | 0.62 | 653,404 |

全部组件及正、负差额在 JSON 的 `component_deltas`，合计依赖差额 **61,132,327 bytes**；解释器差额 **25,964,184 bytes**；addon/后端/元数据合计差额 **−11 bytes**；ZIP 结构差额 **124,196 bytes**。四项严格相加为 **87,220,696 bytes**。原生 ELF/PE 条目压缩合计分别 **184.76 / 102.93 MiB**，也说明差额主要不是 JS/Python 文本。

解释器并非同一个发行构建：Linux 包为 CPython **3.12.16**，Windows 为 **3.12.13**；同名依赖的版本一致，Windows 另有 `colorama 0.4.6`。因此这是当前 wheel/解释器构建和 staging 取舍的比较，不能概括为“Linux 天生必须大这么多”。

### 按实际文件看主要差额

路径以下均相对各自的 site-packages；不同平台库的拆分不同，单文件配对是包装对照，组件合计才是完整比较。

| 对应文件/作用 | Linux 压缩 bytes | Windows 压缩 bytes | 差额 bytes |
| --- | ---: | ---: | ---: |
| `cv2/cv2.abi3.so` / `cv2/cv2.pyd` | 31,379,056 | 30,656,224 | 722,832 |
| `onnxruntime/capi/onnxruntime_pybind11_state.*` | 11,623,753 | 7,110,696 | 4,513,057 |
| `libonnxruntime.so.1.31.1` / `onnxruntime.dll` | 11,172,316 | 6,799,425 | 4,372,891 |
| `pymupdf/libmupdf.so.26.12` / `mupdfcpp64.dll` | 19,137,421 | 13,531,240 | 5,606,181 |
| `numpy/_core/_multiarray_umath.*` | 3,275,241 | 1,251,200 | 2,024,041 |
| NumPy `libscipy_openblas64_*` | 7,474,763 | 6,571,865 | 902,898 |
| `fontTools/misc/bezierTools.*` | 1,289,460 | 140,807 | 1,148,653 |
| `cryptography/.../_rust.*` | 4,600,568 | 3,557,991 | 1,042,577 |

**OpenCV 差额几乎全是额外库，不是 cv2 主文件翻倍。** Linux cv2 主文件未压缩 **73,874,137 bytes**，反而小于 Windows 的 **85,848,064 bytes**；压缩后只差 **0.69 MiB**。Linux wheel 另携带 15 个 `.libs` 文件，共 **84,747,319 bytes 原始 / 29,651,498 bytes 压缩（28.28 MiB）**：

| 原生库组 | 例子 | 压缩 MiB |
| --- | --- | ---: |
| BLAS / Fortran / quadmath | `libopenblasp*`、`libgfortran*`、`libquadmath*` | 11.70 |
| 视频/传输及其依赖 | avcodec、avformat、avutil、swscale、swresample、VPX、OpenSSL、DRM | 12.99 |
| AVIF / AOM | `libavif*`、`libaom*` | 3.21 |
| PNG | `libpng16*` | 0.38 |

当前 Linux `cv2.abi3.so` 的 `DT_NEEDED` 直接引用 OpenBLAS、AVIF、PNG、avcodec/avformat/avutil/swscale 等。即使不调用视频 API，装载 cv2 仍需满足这些链接。`stage_runtime.py` 已剔除 Windows 独立 `opencv_videoio_ffmpeg*.dll`，却必须保留 Linux wheel 的链接依赖。NumPy 自己的 `openblas64_` 与 OpenCV 的 OpenBLAS 不是同 hash 的资源，不能按名字相似合并；统一 BLAS 需要 ABI/编译验证。

### 模型与重复资源

- 四包主模型均为同一 SHA-256 `fece9af02f61…`，**75,324,598 bytes 原始 / 64,827,402 bytes 压缩（61.82 MiB）**；词表 `fb374d…` 均为 SHA-256 `446a9538cb6c…`，**3,613,922 / 1,694,468 bytes（1.62 MiB）**。这 **63.44 MiB** 是每个独立包的一键离线资源，不是 Linux 独有冗余。依赖中另有三个 ONNX 示例文件，总原始大小仅 **903 bytes**，没有第二个大模型。
- 四包均无独立 `.ttf/.otf/.ttc`、`.pyc` 或 `__pycache__` 条目。不能再以“清字体缓存、清 pyc、删 scipy”等估算大收益：staging 已排除这些主要负担，并通过既有 compact_math 路线省掉多个科学工具包。
- Linux 自带版有 **57 组**非空逐字节重复，所有组只留一份的 ZIP 存储上界为 **10,466,982 bytes / 9.98 MiB**；本地 Python 版仅 **0.12 MiB**。主要重复就是 `python/lib/libpython3.12.so` 与 `.so.1.0`：两份各 **32,817,872 bytes**，各压缩 **10,330,633 bytes**。
- 项目 uv 解释器原始 `.so` 确为指向 `.so.1.0` 的符号链接；`stage_interpreter()` 的默认 `copytree` 解引用，build 再按普通文件读出，故两份实体进包。保留版本化库、在安装时还原未版本化别名可回收原 ZIP **10,330,819 bytes / 9.85 MiB**；两种名字都保留，不能直接删掉唯一库。只改 `copytree(symlinks=True)` 不够：build 读文件仍会跟随链接，Gecko 也不能据此假定还原链接。
- Windows 最大重复是六个 wheel 私有目录里的同 hash `msvcp140-*.dll`，只留一份的 ZIP 存储上界 **927,996 bytes / 0.89 MiB**。私有 DLL 搜索路径仍需要它们；本轮未在 Windows 执行，也不建议跨 wheel 直接挪库。许可证、INSTALLER、兼容模块等其他重复很小，保留其合规与路径语义优先。

## 3. 保留现有 ZIP 的可回收预算

以下来自真实逐文件 DEFLATE 和 strip **副本**，保留所有模型、词表、依赖运行代码、许可证及 Python 解释器。表内沿用旧 ZIP 文件头；别名方案尚未实现安装时还原，新元数据/还原代码的少量 bytes 未计入。

| 候选组合 | 数据预算 XPI bytes | 预算 MiB | 相对当前减少 MiB |
| --- | ---: | ---: | ---: |
| 仅显式 DEFLATE 9 | 285,119,943 | 271.91 | 0.96 |
| DEFLATE 9 + 25 个依赖 ELF 去 DWARF | 278,999,918 | 266.08 | 6.80 |
| DEFLATE 9 + 79 个依赖 ELF 去普通符号 | 276,736,101 | 263.92 | 8.96 |
| 去 DWARF 档 + libpython 别名还原 | 268,734,929 | 256.29 | 16.59 |
| 去普通符号档 + libpython 别名还原 | 266,471,112 | 254.13 | 18.75 |

这是**已测候选的可回收上界/预算，不是压缩算法的数学最优，也不是已发布包的大小保证**。

### 压缩级别：真实但小的收益

`scripts/build.py` 的 runtime 和 addon/backend 写入循环虽设置 `ZipFile(..., compresslevel=9)`，自建 `ZipInfo` 却没有 entry-level 级别。所有 runtime 文件的原 DEFLATE 字节流都与本机 zlib level 6 **逐字节相同**；只有用字符串写入的 LICENSE/runtime 元数据已按 9 写入。对 `pymupdf/__init__.py` 的独立 API 实验复现为 **209,493（自建 ZipInfo）/ 207,110（字符串入口的 9）bytes**。

可用公开 `writestr` 参数显式传级别，保留已有时间戳/权限；当前最大单文件约 75 MB，若选择读取整个文件应接受这项内存成本，而不是只重复修改构造器的 `9`：

```python
# Explicit entry compression; preserve the existing ZipInfo timestamp and permissions.
archive.writestr(info, path.read_bytes(), compresslevel=9)
```

同内容、同头结构下，Linux 自带/本地减少 **1,010,625 / 784,967 bytes**，Windows 自带/本地减少 **641,094 / 562,226 bytes**。生成对应 runtime-payload 缓存并重打包后才会生效；复用旧缓存不会自动变小。按当前文件大小不用强制 ZIP64 还能省约 **0.12 MiB**，但未计入上表，优先级很低。

### strip：只对已验证的依赖做，解释器必须排除

专属副本用 GNU strip **2.42**，只读 ELF 节/加载段元数据，没有反汇编或反编译：

- 25 个依赖 ELF 有 DWARF，共 **22,569,268 bytes 调试节**；`--strip-debug` 实际减少原始文件 **22,605,927 bytes**，原 level-6 压缩少 **6,170,219 bytes**；在 DEFLATE 9 基础上进一步少 **6,120,025 bytes**。主要是 fonttools（压缩少 2,749,142 bytes）、Pillow（1,027,142）、PyYAML（603,023）、regex（472,752）等。
- 对 79 个有普通符号的依赖 ELF 用 `--strip-unneeded`，相对原文件减少 **34,547,063 bytes 原始 / 8,458,991 bytes 原 level-6 压缩**；这**包含上一档**，在 DEFLATE 9 下只比去 DWARF 档多省 **2.16 MiB**。没有剥除动态导出符号、加载的代码/数据和依赖路径。普通符号删除会降低崩溃诊断能力，宜把未剥离副本留在发布者归档而非 XPI。
- 一开始对全部 142 个 ELF 统一 `--strip-debug`，**CPython 副本启动失败**。当前解释器有 BOLT 布局：首个 `PT_LOAD` 的文件范围被从 `0x1000` 缩到 `0x588`，而 `DT_STRTAB` 仍指向起点加 `0x588`；出现版本信息缺失/符号查找错误。节偏移处内容 hash 未变，并不代表真正映射进内存的 bytes 未变。该失败已保存，**不计任何收益**；后来恢复副本，限定到依赖后才通过。
- 可行档逐目标核对了 SHF_ALLOC 节、**按 PT_LOAD 地址映射的真实节 bytes**、动态依赖/路径，并通过复制解释器下的导入、PNG/PDF、NumPy、字体曲线、SSIM、XML/YAML、tokenizer 和 DocLayout 零图推理对照。输出 hash 相同不等于完整 Zotero/PDF 功能验收。

libpython 别名在 DEFLATE 9 后可回收 **10,264,989 bytes / 9.79 MiB**，不能再把原 level-6 的 9.85 MiB 原封不动加上。副本已验证保留两种名字的 Linux hardlink；未来安装器可优先简单复制还原，支持时再用 hardlink。复制回退仍省 XPI 下载量，但**不会省两份落盘实体空间**；本表未压缩预算也不能冒充安装磁盘收益。

## 4. 不删资源的更强压缩：离线内层 XZ

专属副本将**全部 5,924 个依赖文件**打成确定性 tar，用现有本机 CLI、单线程实测；每个压缩产物均解压并核对完整 tar/model SHA-256。xz 为 **5.4.5**，zstd 为 **1.5.5**。时间是本机“压缩”及“解压+哈希/I/O 核对”，不是首次 Zotero 安装耗时。

| 输入 | 算法 | 压缩结果 bytes | MiB | 压缩秒 | 解压核对秒 |
| --- | --- | ---: | ---: | ---: | ---: |
| 原依赖 tar（498,698,240 bytes） | XZ `-6` | 124,587,064 | 118.82 | 116.91 | 5.05 |
| 同上 | zstd `-19` | 135,342,870 | 129.07 | 132.55 | 1.09 |
| 去 DWARF 依赖 tar | XZ `-6` | 120,007,592 | 114.45 | 113.18 | 4.79 |
| 同上 | zstd `-19` | 130,267,593 | 124.23 | 125.47 | 1.02 |
| 原 DocLayout 模型（75,324,598 bytes） | XZ `-6` | 61,574,416 | 58.72 | 23.30 | 2.28 |
| 同上 | zstd `-19` | 64,137,005 | 61.17 | 18.63 | 0.18 |

采用“其他条目 DEFLATE 9 + 一份 **STORED 内层压缩档**”的数据预算：

| 替换方式 | XPI 预算 MiB | 再做 libpython 别名还原 MiB |
| --- | ---: | ---: |
| 原依赖 tar.xz | 218.32 | 208.53 |
| 去 DWARF 依赖 tar.xz | 213.96 | 204.17 |
| 原依赖 tar.zst | 228.58 | 218.79 |
| 去 DWARF 依赖 tar.zst | 223.74 | 213.95 |

在 XZ 的 204.17 MiB 档上把模型也无损 XZ 存储，另外少 **3,251,482 bytes / 3.10 MiB**，约 **201.07 MiB**，比当前少约 **71.81 MiB**，但仍略大于当前 Windows 自带包。词表保持现状即可，DEFLATE 9 对其仅多省 1,958 bytes。

可行入口与代价：

1. 保持 XPI 外层为 Gecko 现用 ZIP；**不能把 ZIP entry 直接换成 LZMA/zstd method 并宣称现安装器兼容**。`addon/content/runtime.js` 当前只逐条 `nsIZipReader.extract`，不会处理 tar/内层 XZ。
2. bundled/Linux 先用现有 ZIP 解出完整 Python、标准库和小的离线 bootstrap，再由自身 `_lzma` 流式解出依赖和模型；副本已验证 `_lzma` 可导入。Python 3.12 没有标准库 zstd 解码，使用现有 backports.zstd 还得把解码依赖留在压缩档之外，收益又小于 XZ。
3. 需调整首次解包、权限、缓存播种、错误/进度和 installed marker/build ID 的完成顺序；验证临时磁盘占用、失败重试、正常重开，并清理本次压缩临时档。模型字节、库相对位置和 RPATH 都保持不变，不触发 pip 或联网下载。
4. 最小适配可只启用 Linux bundled；local 继续当前逐条 DEFLATE，避免对现有用户 Python 新增 `_lzma` 条件。Windows/macOS 留在既有路线，跨平台共享入口的改变仍需以后分别授权原生验证。

**不同组合不能直接相加。** 没有测“去普通符号后的 tar.xz”、自编译 OpenCV 的 tar.xz 或删 C-API 后的 tar.xz；不能把各自单文件 DEFLATE 收益直接叠到本节预算。

## 5. 条件候选与需编译的后置路线

### 小额或尚未完整证明的删除候选：不进入主预算

- Linux `ensurepip` 和 `pydoc_data` 共 7 个文件，当前压缩 **1,912,652 bytes**，DEFLATE 9 后连文件头可回收上界 **1,913,606 bytes / 1.82 MiB**。Windows staging 已排除这些开发/帮助资源。它们不是引擎启动必需，但移除会失去相应 Python 安装包/帮助能力；本轮只统计，没有做删除验收，默认主档保留完整现状。
- ORT 独立 `libonnxruntime.so.1.31.1` 当前压缩 **10.65 MiB**；Python pybind 的 `DT_NEEDED` 不引用它，ORT Python 源码没有其字面路径引用。仅从专属副本临时移走它，已测导入和同一 DocLayout 推理仍相同。去符号/DEFLATE 9 后单文件及头预算约 **10.61 MiB**，但它并非字节重复；Python 推理之外的 C API/工具/延迟装载路径未全部认证，**不列已批准删除，不计主预算**。

### Linux image-only OpenCV：大收益优先研究对象

保持 BabelDOC **0.6.4** 基线，不借升级引擎或改联网安装获得缩小。针对当前兼容的 OpenCV 版本编译 `core,imgproc,imgcodecs,python3`，关闭视频/FFmpeg、dnn、高级 GUI、可选 BLAS及不用的图像格式，再用新 ELF 的 `DT_NEEDED` 决定哪些 `.libs` 真正可以不带。

- 公开 Python 源码实际需要 resize、copyMakeBorder、cvtColor、boxFilter、PNG/JPEG 编解码、文字/矩形调试绘图等；不要裁掉 `imgproc/imgcodecs`、字体/PDF能力或 NumPy 的 BLAS。
- 现有非 PNG 的 OpenCV `.libs` 份额为 **29,255,029 bytes / 27.90 MiB**。这是**重编译后可能消除的现有链接链上界**，不是可直接删除量；主 cv2 的未用模块还可能减少。开发排期可先以**约 30–45 MiB 的待测收益**评估，当前没有编译实测，不能据此承诺某个成包指标。整个 58.36 MiB 组件也不能全算收益，因为必要图像实现必须留下。
- 保留锁定版本/构建身份、许可证、NumPy ABI、CPU 通用指令集和当前 glibc ≥ 2.34 基线，避免 Ubuntu 24.04 本机编译无意提高运行门槛。不要使用 `-march=native`，也不要把现有 macOS 4.12 构建冒名当 Linux 当前 wheel。
- 入口是 `scripts/stage_runtime.py` 的 Linux 分支及独立原生构建脚本；安装器仍可沿用普通 ZIP，Windows 官方 wheel 和现有 macOS 路线不变。需后续补可复现工具链/构建说明。

更精简的 ORT/MuPDF/CPython 编译可再研究，但当前无体积实测，且涉及模型算子、PDF字体/图像能力或解释器布局，排在上述路线之后。FP16/INT8 模型量化、换模型或删 tokenizer 会改变模型/行为，**不算本轮同资源无损压缩空间**；联网下载必要资源、外部 Python 安装器同样不算。

## 6. 建议顺序、风险和工期

工期为实现加 Linux 侧检查的粗估工作时间，不含本轮未执行的 Windows/macOS 原生验收，不是保证交付日期。

| 顺序 | 路线/收益口径 | 风险与耦合 | 预计工期 |
| --- | --- | --- | --- |
| 1 | 显式 entry-level 9；Linux 自带少 0.96 MiB | 低，不改运行内容；重建对应 payload 缓存、更新最终 hash | 1–2 小时 |
| 2 | 只对 25 个已测依赖去 DWARF；与 9 合计少 6.80 MiB | 低至中，仅 stage 副本处理；保留加载段/动态符号，禁用解释器统一 strip | 0.5–1 天 |
| 3 | libpython 只存一份、安装还原两名字；再少 9.79 MiB | 中，改 staging/build 与 unpack 元数据；先用复制回退，hardlink 为可选磁盘优化 | 0.5–1 天 |
| 4，可选 | 79 个已测依赖去普通符号；比 DWARF 档再少 2.16 MiB | 中，诊断信息变少；须补完整管线与原生重开 | 0.5–1.5 天 |
| 5，二选一先做原型 | 保持官方依赖的内层 XZ；完整无损预算到约 201.07 MiB | 中至高，无新增原生编译，但耦合首次解包、缓存和 marker；增加解压与临时空间 | 2–4 天 |
| 5，后置编译备选 | Linux image-only OpenCV；约 30–45 MiB **未测估计** | 中至高，需要维护可复现编译、ABI/发行版兼容；安装路径耦合较低 | 2–4 天 |
| 后置/条件 | 开发资源小额裁剪、ORT C-API 必要性或更多原生编译 | 删除能力或未覆盖路径不能假定安全；不叠加为承诺收益 | 小额 0.25–0.5 天；C-API 1–2 天；更多编译 3–7 天 |

建议先完成 1–3；是否值得为额外 2.16 MiB 删除普通符号可独立决定。若目标只是不浪费空间，到 **256 MiB 左右**即可保持当前安装结构和全部必要内容；若必须接近 **200 MiB**，再在“官方 wheel + XZ 安装层”和“原生 image-only 编译”之间做取舍，不为小收益先建立复杂通用去重/解码框架。

## 7. 验证要求与本轮证据

**本轮已完成：** 四包全文件 CRC/SHA-256、ZipInfo/组件/结构对账、两模式等价核对、两平台逐文件 DEFLATE 6/9 对照、专属 Linux ELF/硬链接/条件 C-API 副本实验、六组 codec 的字节级解压核对，以及复制解释器下的限定导入/推理对照。主模型和 tokenizer hash 未变；DocLayout 推理输出 `[1,300,6]` float32 的 SHA-256 为 `dc4c21868b8316ca16db325dbdcda62b80ccfcf25d3aa8f77c94566bce3e83aa`。

**实施之后仍必须验证：**

1. 对所有实际新 XPI 重新统计完整文件/依赖/模型清单、许可、CRC/hash 和安装模式，核对 ELF 地址映射、`DT_NEEDED`、RPATH/动态导出，不把 strip 文件大小或节 hash 单独当通过。
2. Linux bundled 在**没有外部 Python、没有预存模型/词表缓存、禁止资源下载**的隔离环境，从 Zotero 原生 XPI 安装、首次准备到健康接口；local 另核对仍只要求原来的用户 Python。保留现有最低 glibc/CPU兼容范围并另测目标发行版。
3. 用禁网、非付费的完整 BabelDOC 管线检查真实 PDF 图像/文字/字体、扫描检测、保护区域、tokenizer、缓存、任务取消、错误可知和正常退出；不是只做零图推理。所有裁剪/编译需要覆盖其实际 API。
4. 真冷重开、升级/失败重试、installed marker/build ID/资源 hash、正常停止及用户数据/凭据保留；内层压缩另测部分解包、权限、临时空间和 `_lzma` 入口，不用联网补齐来“通过”。
5. 共享 build/unpack 变更后，Windows/macOS 的构建与原生验收应分别另行授权；本轮**没有执行 Windows/macOS 程序、没有 Zotero 安装验收、没有付费服务调用、没有安装全局依赖**。

证据入口：

- 可提交的完整统计：[linux-package-size-analysis-2026-11-15.json](linux-package-size-analysis-2026-11-15.json)，`file_inventory` 用列定义 + 单行记录保存两平台、四模式的全部文件数据；`projections` 明确哪些是预算及未批准删除。
- 本机过程证据仅在 `agent/codex/p0-p1-20261115/size-research/`：`inventory-full.json`、`prototype-results.json`、四份 `smoke-*.json`、首轮 strip 失败 stderr、ELF 元数据对照及 tar/XZ/zstd 专属副本。没有改生产库来做实验。
- 同目录 `analyze_packages.py`、`prototype_copies.py`、`smoke_runtime.py`、`finalize_evidence.py` 和 README 说明复现。分析用项目 `.venv/bin/python -I -B`；原生操作用 XPI 解出的**本任务自己的 Python 副本**。文件内保留源包 hash 与当前构建脚本 hash，研究成果没有写入 MEMORY/TODO 或覆盖其他报告。
