<!-- Microsoft license findings, bounded evidence, and unresolved distributor decisions. -->
# Windows 运行库许可核实

- 时间：2026-11-16 02:49:23（北京时间）；执行者：Codex。
- 范围：核实 0.3.6 Windows 候选中三个 MSVC DLL 的原始发布来源与可适用再分发条款；未更换运行时/引擎、未代用户接受许可。

## 结果

**来源/未修改字节问题已收口；公开再分发许可条件尚未闭环。** `licenseCompliance=unknown`、对应源码状态 `partial` 保持不变，不把技术完整性当作法律授权。

1. 两枚 VCRUNTIME 14.44.35211.0 精确匹配微软 14.44 CRT base VSIX；Hyperscan 私有 MSVCP 14.40.33810.0 与微软对应 VC_redist EXE 内 CAB 原始文件逐字节相同。该 MSVCP 仅改文件名，内容未变。远端三文件的 Authenticode 均为 `Valid`。
2. Windows 唯一 VS 实例是完整、可启动、非预发布的 **Community 2026 18.9.2 / 18.9.12120.119**，不是仅装 Build Tools。当前安装的 14.51 CRT 不是目标 DLL 的字节来源。安装事实不代替用户资格、许可接受或合同权限；不自动把 vswhere `expirationDate` 判成许可到期。
3. 按安装产品元数据的官方链接读取 Community 2026 原始协议。实际 **Distributable Code 为第 8 条**，不同于已保留的 Community 2022 第 4 条。原始 DOCX 的 Word 自动编号也已核对，协议文件未改写。2026 原始 DOCX SHA256：`02ac07637f4a513a807cd3721c7620433fc483bc049d25784b0c10c54b05e1fb`。
4. Community 为合格个人/开源开发者提供条件性使用/分发路径，不需要把问题自动升级成购买商业版。Build Tools 2022（2024-03 更新）和 2026 的有限 OSI 依赖构建使用权没有独立 Distributable Code 授权；Runtime 2015–2022 及当前 v14 使用 EULA 均不是独立再分发授权。

## 尚未实现／需用户确认

- 用户需确认合法许可/分发者资格并接受适用分发条件。Community 2026 第 8 条 **Distribution Requirements** 包括应用相关分发/使用索赔的补偿、辩护和使微软免责义务（含律师费），但以索赔完全仅基于微软 Distributable Code 的范围为例外。未代用户作此法律承诺。
- 分发者和外部终端用户必须同意至少同等保护微软代码的条款。当前 addon 只附 notice/许可原件，不能据此认定已有同意。本轮未私自引入点击接受行为；待用户确认路线后补齐微软 DLL 范围内的协议/同意路径、相应发货材料并重建候选，不把限制扩展给整个 AGPL 项目。
- 未标记 Windows 公开分发许可已通过；GPL/AGPL/Berkeley DB 对应源码交付义务未在本次被宣称关闭。没有要求 Microsoft DLL 源码、原编译器或原轮子的逐字节重建。

## 已修改

- `docs/windows-msvc-redistribution.md`：合法路径、实际安装版条款、分发条件和用户决策边界。
- `docs/windows-msvc-evidence-0.3.6.json`：三个 DLL、微软归档、五份新核官方文件及安装身份的 hash/URL/边界。
- `docs/licensing.md`、`docs/candidate-delivery-0.3.6.json`：将“具体原始 DLL 尚未确认”收口为“分发条件待确认”，保持旧包及验收身份。
- `MEMORY.md`：更新当前真实基线和未解决风险，不放调试流水。
- GitHub TODO #1：原 MSVC 项拆成已核来源/完整性与待确认分发条件两行；没有勾选整体许可闭环，没有改其他范围或根 TODO。

## 验证与公开同步

- 五份新核微软原始文档/页面及两个微软归档的 bytes/SHA 均与证据 JSON 一致。
- 三 DLL 的当前 Windows 签名记录及两模式 XPI 内实际发货 bytes/SHA 与新证据一致。
- 四个冻结 XPI 与原 source ZIP 全量 SHA 重核均未改变；源码 ZIP 再核 **24,373 文件、303 源归档**，SHA `838ad271f4179fae3cce09dc28fcc4349247360affd7a917401f33fc5decaa77`。原源码快照 `d637701b862184b66c49e995059aa08c388b7f8d` 不回填成新文档 commit。
- 新文档是单独补充，**不在旧 XPI/source ZIP 中**。addon/backend/依赖/许可发货原件未改；没有重跑或借用旧原生测试给新包身份，也未为纯文档改动重跑功能测试。
- `git diff --cached --check` 通过。文档 commit **`e64bb73668b321722059f38a391dbc2eef50bef1`** 已普通快进推送 `master`，公开 origin 复核一致；没有建分支/worktree 或 force push。
- TODO #1 保存后 API GET 再核一致，正文 SHA256 **`aaeee67009d9b839caa54704474c0767ca83cebf8059650650ae97aff4291a37`**；更新时间 `2026-11-15T18:47:33Z`。此报告与来源报告随后同步到同一 master。
- Windows 原工程 HEAD、工作状态和 stash 指纹前后相同；仅读取既有 GCM 凭据到内存，未输出/落盘 token。Session-0 wincredman 持久化警告没有被当作推送失败；真实 remote/API 结果均已核实。
- 未改日常 Zotero/profile/NSS/数据库、同步设置；没有新付费翻译请求。四条 Linux/Windows 稳定 feed 仍为 0.3.4，macOS 发布物/Latest 未改。

## 原始证据位置

- 主线原始许可文件、验证和 source/TODO receipt：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-license-20261116/`（不随源码提交）。
- 来源原件/签名/逐文件 SHA 清单：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/`（不随源码提交）。
- 独立来源报告：`/home/scq/PaperBridge-zotero-plugin/agent/report/report-codex-20261116-023549-MSVC来源核实.md`。
- channel→catalog hash/size 不一致、非匹配 14.40.33816 VSIX 和单独当前时间离线证书检查的限制均如实保留，不声称整条供应链核验已通过。
