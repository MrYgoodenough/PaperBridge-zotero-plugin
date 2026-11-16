<!-- Separate paid-paper, structural, visual and native acceptance evidence. -->
# 质量测试与验收

生产基线固定 BabelDOC **0.6.4** / PyMuPDF **1.26.7**。不通过换引擎、免费重排或降低全文标准冒充问题修复。

## 离线入口

```sh
env -u PYTHONPATH -u PYTHONHOME -u LD_LIBRARY_PATH -u LD_PRELOAD   .venv/bin/python -B scripts/check_offline.py --mode full
```

Windows 使用本项目的 `.venv\Scripts\python.exe` 和 PowerShell，清除继承的 Python/native 环境。`--mode lightweight` 仅检查小依赖合约，不能代替完整引擎或原生 Zotero。入口阻止外部网络、禁用 pytest 外部插件，不允许离线测试偷偷产生费用。

核心测试维护在现有 `tests/test_*.py` / `tests/test_*.cjs`，只为重要修复保留必要断言；运行结果保存到 `agent/report` 或本轮私有过程目录，开发文档不存测试流水账。

## 真实文献与费用

`docs/quality-corpus.json` 是一个小型固定公共样本，不是代表性语义基准。扩大抽样时记录平台、标题、公开来源、原始 PDF hash、总页数和测试重点，包含双栏、长篇、公式、表格、图像密集和非 ASCII 文字。原 PDF 及译文保留在私有测试目录，公开文档只存必要元数据；不能规避付费墙、认证或下载限制。

默认按全文执行；选页诊断明确标为选页，不计作整篇成功。记录每次实际请求的返回 ID、token 用量、计费未知及账户观察。官方价格估算不是账单，余额差额为账户级、可能四舍五入/延迟结算且存在并行使用。条件预算只有在可核验的累计用量成立时才授权额外样本。

冻结版本、XPI hash、后端模块和源 PDF hash。基线、问题诊断、修复重测和额外样本分别保留，不覆盖失败、不自动重发未知请求。已有段落缓存的重排是免费/部分费用修复验证，不是新调用或新论文语义验收。

## 四种不同结论

| 证据 | 能说明什么 | 不能替代什么 |
| --- | --- | --- |
| `usage.json` | 物理调用和服务商返回用量 | 最终发票/语义质量 |
| `quality.json` | 固定引擎段落是否验证并真正应用 | 整篇人类双语接受 |
| PDF/text/视觉比较 | 公式、表格、字形、剪裁、阅读顺序和抽样含义 | 所有未读段落的语义认证 |
| 原生 Zotero | 精确 XPI 的安装、保存、映射、笔记/批注和重开 | 真实云同步或另一包身份 |

`complete` 表示观察到的段落应用覆盖完整，仍可能有语言错误；`partial`、`unknown` 和 `unusable` 如实呈现。保留参考文献/图表文字不属于正文漏译，但不能把误保护的研究正文算作允许跳过。

## 文本与视觉复核

`scripts/review_quality.py` 读取显式原/译 PDF 和真实质量证据，检查页数、字面、字体、链接及异常，并生成需人工判断的项目。对标题/摘要/方法/结果/参考文献和复杂页做双语抽样，重点核对否定、数值、单位、科学维度、限定语和公式附近解释。

图片先裁剪或组合少量 source/target 面板，限制分辨率，避免把大量全尺寸页面一次送入模型。只有实际渲染可检查覆盖/剪裁；只看提取文本不能证明版式正常。字体子集修复需同时复核复制/搜索文本和渲染，不以文件变小推定正确。

## 原生包与发布

`prepare_nonmac_test.py` 的 assets/upgrade/runtime-terms suites 与相应 `tests/*_packaged.js` 使用新隔离 profile/data、原生 AddonManager、具体 PDF/mapping。新 PID 冷重开保留原数据，外部驱动采集正常退出和 SQLite integrity。已有日常库另需明确授权和停机备份。

每个 Linux/Windows Python 模式有独立包和更新通道。真实同步、其他 DPI、未测原生工具和 macOS 专属源码范围不得借用既有通过结论。发布的 artifact/source/更新检查见[releasing.md](releasing.md)。
