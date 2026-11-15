<!-- Scoped implementation, exact-package acceptance, remaining limits and safe cleanup. -->
# 阅读资产与非 macOS 交付简报

日期：2026-11-15；agent：Codex；分支：`master`；源码：**0.3.6 候选**。

## 完成范围

| 要求 | 本轮结果 |
| --- | --- |
| P0-3 最简许可材料 | 根 NOTICE、官方 CPython 3.12.13/3.12.16 notices、模型/tokenizer 来源和固定 hash、补充 native notices 与实际 XPI 文件关联已交付。完整法律/对应源码义务仍未闭环。 |
| P1-5 删除/清理收尾 | Linux/Windows 两模式原生回收站、恢复、源附件永久删除、共享归属、实际 backend 缓存清理与冷重开通过。清理不取消活动任务，成果/映射/未知归属保留。 |
| P1-6 Linux 瘦身 | 仅替换为与既有 macOS 相同范围的 OpenCV `core/imgproc/imgcodecs/python3`。同源码每种包减少约 **55.25 MiB**；不继续 XZ/strip/别名恢复/资源拆分。 |
| 映射成为阅读资产 | 可信 sidecar 可幂等导出独立 imported JSON 附件；保存 exact 源/译 key、parent、双方 SHA、生成器/验证与有限几何，不含全文、路径或凭据。已下载附件的可信阅读不依赖 journal/worker/Python/API。 |
| 逐行高亮 | schema 2 使用最终 PDF 的可见 glyph 构建逐行 rects/quads，原生 polygon 命中/高亮/双向定位通过；行间和短末行右侧空白不命中。兼容 schema 1，不猜配跨页、移页、重复或隐藏区域。 |
| Windows 验收 | `desktop-hz` 的 `E:\PBAssets-1115` 隔离目录完成自带/本地 Python 原生新装、阅读、清理、冷重开及两次 A→B 下载验收，不修改原工程和日常 Zotero。 |

主要维护入口：`addon/content/reading-assets.js`、`alignment.js`、`library.js`、`tasks.js`；`backend/alignment.py`、`fragment_trace.py`、`library_cache.py`；`scripts/build_opencv_linux.sh`、`stage_runtime.py`、`build.py`、`package_inventory.py`。版本保持 BabelDOC **0.6.4** / PyMuPDF **1.26.7**。

## 最终验收

精确包身份、PID、检查计数与限制见 `docs/nonmac-verification-0.3.6.json`。所有最终包 CRC、SHA 和全部发货源码/许可材料字节已核对；同名旧包的验收不沿用。两个 libspatialindex 上游 notice 的原空格由定点 `.gitattributes` 保留，不为格式检查改写其 hash 绑定原文。

| 平台 / 模式 | 最终 XPI bytes | create / 冷重开 / receive 报告检查 |
| --- | ---: | --- |
| Linux 自带 Python | 228,293,495 | 90 / 47 / — |
| Linux 本地 Python | 190,375,257 | 89 / 47 / — |
| Windows 自带 Python | 199,008,856 | 89 / 47 / 85 |
| Windows 本地 Python | 187,075,395 | 89 / 47 / 85 |

- 十份最终报告共 715 项断言通过；这是混合安装/原生输入/前后端/文件系统检查，其中有 8 项 lifecycle stub 检查，不是 715 个独立功能或语义质量评分。
- 清理后两平台 full 离线各 **304 passed / 1 skipped**、**37 JS 语法检查 / 12 Node suite / 0 fail**。跳过项为缺少可选参考文献 PDF 的测试，不补造样本或结果。
- 真实旧缓存重排 sklearn 第 2 页、LIBLINEAR 第 1 页，共 18 个 verified 单元、源/译 61/47 个 quads；19 cache hits、0 miss、0 新 provider/HTTP/socket/DNS。旧重排 manifest 的 QA 命中点失败保留，修复真实 paint/polygon QA 后对同一结果重新 inspect，未付费重译。
- Linux A 保留 exact keys 的停机 metadata，Windows B 起始 storage 为空，无 A 的 journal/sidecar/engine。经 Zotero 官方 WebDAV 原生下载两 PDF 和 JSON，共 6 次成功 ZIP GET / 40,283,610 bytes；两模式双方 hash、可信对照与降级检查通过。**这是原生文件下载 + 隔离 metadata 种子，不是账号云 metadata sync/group 验收。**
- 阅读与接收阶段 **0 Python 启动、0 后端请求、0 模型 API**；生命周期清理检查按需启动自有本地 backend，不将其冒充整个任务没有运行 Python。
- 最终 Windows 原生截图目视确认逐行效果。六个最终隔离数据库正常停机后、清理前后 `integrity_check` 均 `ok`；无自有 reader/backend 残留。

早期原生页界 Xray 访问、已有 reader 返回值、屏幕外点击和 trash 恢复后 reader 失效问题已直接修复；原失败报告未覆盖，不追溯改成通过。Ubuntu 默认 GCC 输出的 glibc 2.38 cv2 被拒绝，最终使用 GCC 10/glibc 2.31 sysroot，cv2 最高需 glibc 2.30 / GLIBCXX 3.4.26，不提高全包 glibc 2.34 基线。旧发行版实机执行未因此宣称已验收。

## 清理与接续

- 移除 **90 个 Linux / 4 个 Windows** 已停机、身份 marker 有效的隔离解包引擎；先保留 backend/marker/runtime 身份快照，不删除旁边的 storage、任务、翻译缓存、profile/NSS 或失败报告。
- 移除本轮 **12 个**重复/过时 build/probe 目录、`dist` 中 **12 个**过时 0.3.1/0.3.2/0.3.3 XPI；先保留 SHA 与小证据。三个明确生成的字体测试 PDF 归档，不属于原文。
- 本机文件系统约回收 **55.18 GiB**，Windows 隔离目录约 **1.34 GiB**；并非压缩包大小收益。保留 0.3.4 升级基线、0.3.5 仍有参考价值的验收包及四个最终 0.3.6 包。
- 已验收 Linux stage 移至 `.cache/package/linux-x64`，6494 个发货 stage 文件与最终 bundled XPI 逐字节一致；保留一份旧 stage 于 `.cache/package-baselines/linux-x64-before-image-only-20261115`，兼容 OpenCV install/toolchain/sysroot/source 在 `.cache`。
- Windows 三个本轮自有 Ready 计划任务已删除，先保留其实际结果，其中历史 batch 失败仍为失败；没有结束日常进程或修改系统设置。
- MEMORY 整理为当前基线/维护入口/少量历史风险；README 和技术说明更新为当前契约。删除过时重复叙述 `docs/local-analysis-2026-11-12.md`、`package-slimming-0.3.0.md`、`update-0.3.1.md`，保留 Git 历史和机器证据；旧路线改为当前文档入口。根 TODO 未修改，未生成用户任务文件。

定向本地证据保留于 `agent/codex/reading-assets-20261115`；GitHub 上不宣称 ignored 路径可在线读取。清理 helper 的路径错误与字体探针保护拒绝均发生在删除前，修正后单独执行并核对；不据此声称首次执行成功。

## GitHub 与未完成边界

[GitHub TODO #1](https://github.com/MrYgoodenough/PaperBridge-zotero-plugin/issues/1) 已经 API 读改写并公开精确回读，保留其他未完成事项；正文 SHA 为 `ab714e930d6b6bb309d8e96d07c781a5210182a174fb0f66ed69cba185484e16`。

下一步风险/收益/人日见 `docs/product-roadmap-0.3.6.md`，依次为：

1. 发布前许可证与对应源码义务：1–3 日起，可能需要外部答复；最简 NOTICE 不代表 clearance。
2. 人类双语/视觉接受：旧样本 0.5–1 日；新增公式/表图及修复 2–4 日，新增模型费用另获授权。
3. Windows 两模式旧版升级、诊断/凭据、新 note/回链和系统缩放专项：1–2 日；本轮新装阅读/清理不覆盖这些旧待办。
4. 专用账号真实 metadata + 文件同步/按需下载与多译本：1–2 日，须有测试账号/两设备授权。
5. 必要项闭环后按授权公开精确资产、启用 feed 并验真实更新：0.5–1 日加观察。

**没有公开 0.3.6 release 或修改稳定 feed**：Linux/Windows 四条稳定通道仍为 **0.3.4**。macOS 专属源码/发布物未推进，不反向提取，不覆盖 0.4.2 或更改 Latest。暂不继续 Linux 瘦身，也不新增引擎迁移 TODO。
