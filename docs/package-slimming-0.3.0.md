# 0.3.0 安装包精简

两个版本都随包提供全部第三方依赖、版面模型和 tokenizer，运行时不下载引擎或依赖，不调用 uv/pip，不修改本机 Python 环境。

| 版本 | XPI 大小 | 相比 0.2.2 |
|---|---:|---:|
| 0.2.2 完整包 | 266.60 MiB | 基准 |
| 0.3.0 自带 Python | 173.03 MiB | 减少 35.10% |
| 0.3.0 本机 Python | 161.54 MiB | 减少 39.41% |

第三方依赖压缩体积从 178.87 MiB 降到 96.47 MiB，减少约 46.1%。模型与 tokenizer 保持 63.44 MiB，未量化或替换识别模型。

## 实施

- 从 OpenCV 4.12.0 官方源码构建，只包含 core、imgproc、imgcodecs、Python 绑定；移除视频编解码、GUI 模块、DNN、相机与其他未用功能。原包 cv2 目录压缩后约 46 MiB，新模块解包后约 7.2 MiB。重写 loader 配置为相对路径，保留许可。
- BabelDOC 0.6.4 只从 scikit-learn 使用 min_samples=1 的 DBSCAN，只从 scikit-image 使用默认灰度 SSIM。以 NumPy/OpenCV 实现这两项特定运算，在构建时替换两处导入，不模拟完整第三方库接口。与原始库的多组随机输入对照通过；实际三页重排的像素结果相同。
- 不打包 SciPy、scikit-learn、scikit-image、Hugging Face 下载客户端及其闲置依赖。开发环境保留原始库供对照测试。
- 自带版 Python 是静态链接解释器，去掉未使用的第二份 libpython 动态库、Tcl/Tk、IDLE 等。保留所需标准库和编译扩展。
- 本机版不携带解释器或标准库；用 `-I -S -B` 启动已有 arm64 CPython 3.12，再显式加载 XPI 中的依赖。子进程继续使用同一个解释器，不读取用户 site-packages，不安装包。
- 模型、字体缺失或 tokenizer 损坏时直接报告资源错误，不走下载分支。ONNX 遥测在导入前关闭。

## 本机 Python 要求

本机版支持 macOS Apple Silicon 的 CPython 3.12，需包含标准库 ssl、sqlite3。在设置里填写解释器绝对路径，或留空检测 Homebrew、python.org 等常见路径。界面“保存并检查引擎”显示实际使用路径。3.9、3.11、3.13 或 Intel 解释器不适用随包提供的 CPython 3.12 arm64 扩展。

系统自带的 Python 可能不符合版本要求，不能假设 `/usr/bin/python3` 可直接使用。本机 Python 版需要兼容的 arm64 CPython 3.12；若没有兼容解释器，使用自带 Python 版即可。

## 磁盘位置

全部插件数据位于 `Zotero 数据目录/paperbridge/`；设置页“数据目录”可直接打开：

- `engine/`：仅一个已解包引擎。升级或切换包时替换它，清除带有本插件安装标记的旧版本引擎目录。
- `cache/`：仅一份模型、系统宋体提取结果和翻译缓存，两种包及升级共用。
- `.runtime/`：本地服务状态、任务。成功任务只保留 translated.pdf 与 usage.json，删除输入副本、修复版、排版工作目录及模型编译临时目录。已有成功任务也在启动时整理。

Zotero 必须保留已安装的压缩 XPI，原生引擎需要解包后运行，二者仍会同时占用磁盘；译文缓存与保存到文献库的译文附件也分别保留。这里没有把资源下载到其他全局缓存目录，也没有声称可以消除所有副本。

工程构建资源仍在本项目 `.cache/`、`.runtime/`、`.venv/`，不会随插件进入用户环境。

## 验证

- 20 项单元测试、JS 语法及 PDF 坐标映射检查通过。
- 两种完整 XPI 在隔离 Zotero 9.0.6 中完成密钥保存、后台启动、译文附件、双向同步、独立阅读和重开缓存测试。旧版本引擎目录清理后数量为 0。
- 三页真实论文用精简依赖重新执行版面识别、翻译缓存读取、排版和字体子进程；自带版和本机版与 0.2.1 的每页平均像素误差均为 0，宋体嵌入，页面尺寸一致。
- 验证期间 Python 网络连接明确禁用，0 次 API 和资源下载；译文来自既有缓存，没有为精简重新支付翻译费用。
- 第 5 页补充两个独立公式和一幅图：保护区域文字一致，像素误差为 0、0.225、0.210（0–255 色阶，字体抗锯齿差异），0 次 API。
- 本机版通过 Zotero 启动的真实后台任务再排版三页，状态 done，0 次 API；任务目录只剩 translated.pdf、usage.json。

记录见 package-sizes-0.3.0.json、slim-reflow-bundled-0.3.0.json、slim-reflow-local-0.3.0.json、server-job-local-0.3.0.json、zotero-packaged-bundled-0.3.0.json、zotero-packaged-local-0.3.0.json。
