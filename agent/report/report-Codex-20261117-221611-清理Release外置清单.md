<!-- Outcome report for the authorized removal of standalone developer release metadata. -->
# 清理 Release 外置清单

- 执行者：Codex；时间：2026-11-17（Asia/Shanghai）。
- 用户确认：保留对应源码 ZIP，删除普通用户无需下载的外置清单；所有 XPI 与 GitHub 自动 Source code 保留。

## 执行结果

- 从 0.3.7 删除 **4 个 `.xpi.inventory.json` 和 1 个源码 ZIP 的外置 `.manifest.json`**。删除前按 GitHub size/digest 核对并备份，未删除本地构建产物。
- 0.3.7 现在只有 **四个 Linux/Windows 自带/本地 Python XPI + 一份对应源码 ZIP**，共 5 个上传资产。其他公开 Release 本来仅剩 XPI，未改动。
- 对应源码 ZIP asset ID `758847951`、大小 `888343444` bytes、SHA256 `32058bd249042450a390f5b49989d65cc4300f4dd7e9bb667b8a4d20d07ff60c` 保持不变。
- 源码 ZIP 内 `bundle-manifest.json` 与原外置 manifest **逐字节相同**，内部四个 XPI inventory 全部保留；未重建 ZIP、修改依赖/许可证字节或移动冻结标签。
- 逐项回读确认所有保留 XPI/源码包的 ID、名称、大小、digest、下载地址和上传状态均未改变。macOS 0.4.2 仍为 Latest，无关 Release/issue 不变，GitHub 自动源码档案不受资产删除 API 影响。
- 更新 0.3.7 Release notes 和 TODO #1 的发布材料说明；TODO 仍 open，勾选与未完成项数量均未变，未改 Experience Improvement #2。
- 更新 AGENTS、MEMORY、发布/源码交付/版本选择指南及根 NOTICE 的未来发布说明：Release 只上传 XPI 与必要对应源码 ZIP，外置 checksum/inventory/manifest 只本地保留。构建/验包仍照常生成使用本地清单，不削弱校验，不改动已有冻结安装包内的 notices。

## 验证

- 全量离线入口 `check_offline.py --mode full`：**402 passed / 1 skipped**；现有 JS/Node 检查通过，0 failures，无付费 API 请求。
- 删除后对四个冻结包执行现有 verifier 的匿名在线检查：全部 `LOCAL-CONSISTENT` / `PUBLISHED-METADATA-VERIFIED`；当前 master feed 与已验草稿一致。
- `git diff --check` 通过。工程改动仅为规范/文档，不改 addon/backend、版本、引擎或更新通道。
- 本次未发布子代理、未操作日常 Zotero profile/库、未创建分支/worktree。Git 同步采用 master 普通提交/推送，不强推，冻结 `v0.3.7` 保持原生产提交。

## 边界与接续

- 源码 ZIP 的保留承接现有对应源码交付安排，不代表完整法律审查通过；原合规证据的 unknown 边界不改变。
- 未新增全文语义、物理鼠标、跨设备文件同步或旧→新自动更新投递的验收结论。
- 本次前后快照、逐步删除/PATCH 回执、备份与在线/离线报告位于 `agent/codex/release-assets-20261117-221217/`；不提交过程目录。
- 本地冻结产物仍位于 `dist/release-0.3.7-freeze07/`，外置清单/校验文件保留用于后续复核。
