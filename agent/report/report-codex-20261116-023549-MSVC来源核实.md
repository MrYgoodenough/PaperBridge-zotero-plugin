<!-- Read-only toolchain inventory and exact Microsoft runtime byte provenance. -->
# MSVC 来源核实

北京时间：2026-11-16 02:35:49。执行者：Codex 来源 sidecar。

## 结论与边界

**三个目标 DLL 均已找到微软官方归档中的相同原始字节；Hyperscan 的 hash 后缀 DLL 与标准 MSVCP DLL 逐字节相同。** 远端三个现存文件的 Authenticode 均为 `Valid`。

**存在 Community 2026 安装，不是仅有 Build Tools。** 这些事实是安装身份、来源及完整性证据，**不是用户授权资格、许可接受或旧 CRT 再分发权的证明**。法律适用由主线另行核定；本报告不关闭项目许可阻塞项。

远端仅使用既有 PowerShell/vswhere、文件/哈希/签名 API，查询公开 VS 安装目录、有限 CRT 目录、System32/SysWOW64，以及隔离工程已知缓存路径。未安装、升级、启动 VS/安装器/Windows EXE/DLL，未访问日常 Zotero profile、数据库或 NSS，未改变原工程 Git 状态。微软下载 EXE 仅在本机新证据目录中提取标准 CAB 归档；未逆向或执行 DLL。

按明确写集限制，未修改 tracked 文件、MEMORY、NOTICE、清单或项目许可文件；未提交、推送、修改 GitHub 或发布。

## 1. 已安装工具链

`vswhere -all -products * -format json -utf8` 返回 **1 个实例**：

| 字段 | 原始值 |
|---|---|
| productId | `Microsoft.VisualStudio.Product.Community` |
| displayName / productDisplayVersion | `Visual Studio Community 2026` / `18.9.2` |
| installationVersion | `18.9.12120.119` |
| installationName | `VisualStudio/18.9.2+12120.119` |
| installationPath | `C:\Program Files\Microsoft Visual Studio\18\Community` |
| isPrerelease / isComplete / isLaunchable | `false` / `true` / `true` |
| isRebootRequired / state | `false` / `4294967295` |

未发现其他 Pro、Enterprise 或独立 BuildTools 实例。VC Tools/Redist 目录为 `14.51.36231`，其中实际 CRT DLL 版本为 `14.51.36247.0`。对 VS Redist 下 desktop/onecore、x64/x86 及系统目录的 **15 个有限候选**查询均不匹配目标三个 hash，签名均为 `Valid`。不能用当前已安装 CRT 替代旧 DLL 来源匹配。

原始 JSON：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/remote-msvc-inventory.json`。

安装元数据中的 `expirationDate` 已保留原值，**不能据此自动认定软件许可到期**。

## 2. 原始 DLL 字节匹配

| 目标 | bytes | SHA-256 | 微软来源 |
|---|---:|---|---|
| `vcruntime140.dll` | 124544 | `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066` | 14.44 VSIX 的 `Contents/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT/vcruntime140.dll` |
| `vcruntime140_1.dll` | 49792 | `1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f` | 同一 VSIX、同一 CRT 目录 |
| `hyperscan.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` | 575056 | `a4c2229bdc2a2a630acdc095b4d86008e5c3e3bc7773174354f3da4f5beb9cde` | VC Redist 14.40.33810 EXE → `packages\vcRuntimeMinimum_amd64\cab1.cab` → `msvcp140.dll_amd64` |

VCRUNTIME 的正确大小为 **124544**，不是任务提示中的待核近似数 120400。

### 14.44 官方 VSIX

[Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix](https://download.visualstudio.microsoft.com/download/pr/45d3b8dd-bced-4b37-9974-142f748d710c/4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5/Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix)

归档实际 3224191 bytes，SHA `4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5`，与微软 catalog payload 的 sha256 及下载 URL 中的 hash 相同。两个目标 VCRUNTIME 内容精确匹配。

原始归档/比较：
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/official-vs1444-dlls.json`

### 14.40：不要混淆不同发布物

本轮也取得微软当前 [14.40.17.10 CRT base VSIX](https://download.visualstudio.microsoft.com/download/pr/8e1ea566-8bfc-4707-b05e-bee74606db7d/8b1db85a80ed5ff9c031de38176bf5f108e3f796919c817eb0106445a8a218a6/Microsoft.VC.14.40.17.10.CRT.Redist.X64.base.vsix)：其 package version 为 **14.40.33816**，归档 SHA `8b1db85a80ed5ff9c031de38176bf5f108e3f796919c817eb0106445a8a218a6`。

这个 VSIX 的 `msvcp140.dll` 虽也是 575056 bytes，但 SHA 为 **`7b8a6f283884e6448559dcf510b00c1a885bfb8e598ea05cd2c290c874657326`，不匹配目标**。不得把它写成已匹配 14.40.33810。

真正精确匹配来自微软 [VC_redist.x64.exe 14.40.33810.0](https://download.visualstudio.microsoft.com/download/pr/1754ea58-11a6-44ab-a262-696e194ce543/3642E3F95D50CC193E4B5A0B0FFBF7FE2C08801517758B4C8AEB7105A091208A/VC_redist.x64.exe)。下载地址与固定 SHA 由 [Microsoft winget-pkgs 对应版本清单](https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/m/Microsoft/VCRedist/2015+/x64/14.40.33810.0/Microsoft.VCRedist.2015+.x64.installer.yaml) 给出。

- 整个 EXE：25397512 bytes，SHA **`3642e3f95d50cc193e4b5a0b0ffbf7fe2c08801517758b4c8aeb7105a091208a`**，匹配清单。
- Burn archive 原始 manifest 将 `packages\vcRuntimeMinimum_amd64\cab1.cab` 映射到嵌入文件 `a12`；该 CAB 为 985344 bytes，SHA **`8fafd6d0754ee53125902df1b67ef2db86eb7af4c097522f2fb58443501fecdd`**。
- CAB 的 `msvcp140.dll_amd64` 与 Hyperscan wheel、当前 bundled/local ZIP、远端现有重命名 DLL **逐字节相同**；不仅是版本号或大小一致。

原始证据：
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/VC_redist.x64.14.40.33810.exe`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/winget-vcredist-14.40.33810.installer.yaml`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/redistributable-container-0/0`（原始 Burn manifest）
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/redistributable-container-1/a12`（原始 CAB）
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/runtime-minimum-1440/msvcp140.dll_amd64`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/official-vcredist1440-dlls.json`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/official-vs1440-dlls.json`（明确不匹配的 VSIX）

## 3. 远端现存文件签名

三个路径均位于 `E:\PBAssets-1115\.cache\package\windows-x64\python`，查询只读取文件，不装载 DLL。

- 两个 VCRUNTIME：`14.44.35211.0`，`Valid`，主体 `CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`。链：Microsoft Windows → Microsoft Windows Production PCA 2026 RSA2048-SHA256 → Microsoft Root Certificate Authority 2010。
- MSVCP：`14.40.33810.0`，`Valid`，主体 `CN=Microsoft Windows Software Compatibility Publisher, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`。链：该主体 → Microsoft Windows Third Party Component CA 2013 → Microsoft Root Certificate Authority 2011。

单独进行的当前时钟 `X509Chain` / `NoCheck` 检查：VCRUNTIME 为 true；MSVCP 为 false / `NotTimeValid`。这与带签名时间戳语义的 Windows Authenticode `Valid` 不是同一检查，不能混报失败或成功。

原始结果：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/remote-exact-payloads.json`。本机当前两个交付 ZIP 的四个相关 DLL 记录也已独立逐字节核对：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/current-payload-comparison.json`。

## 4. 固定 recipe 与 wheel repair

只读使用允许的现有 source-cache；四个相关源码归档均重新计算 SHA 并通过固定来源比对，未修改缓存。

### Python standalone

[固定 recipe 0e4d9c24b72d28573e622518f09b16aef4a33be8](https://github.com/astral-sh/python-build-standalone/tree/0e4d9c24b72d28573e622518f09b16aef4a33be8) 归档 SHA：`ee2198ba38c22e05e9b0781c1fad93e9f8ead81194f873130af4ca6bcefb9d31`。

- `ci-targets.yaml:397–410`：x86_64 Windows、包含 Python 3.12，`vs_version: "2022"`；VS 2026 条件覆盖从 Python 3.15 才生效。
- `.github/workflows/windows.yml:159–169`：相应调用 `C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\...`，并将 matrix VS 版本传给 `build.py --vs`。
- CPython 3.12.13 `PCbuild/pyproject.props:221–239`：`$(VCInstallDir)\Redist\MSVC\$(VCToolsRedistVersion)\`，选择架构后取 `Microsoft.VC*.CRT\vcruntime*.dll`。
- `PCbuild/pythoncore.vcxproj:635–638`：`<Copy SourceFiles="%(VCRuntimeDLL.FullPath)" DestinationFolder="$(OutDir)" />`。
- recipe `src/release.rs:640–646`：`vcruntime140.dll` / `_1.dll` 列入不执行 llvm strip 的例外。

此路径是**从已有 VS 安装的 Redist 获取 runtime**；未找到 recipe 为这两枚 runtime 明示的独立 Microsoft acquisition URL，也不能声称 recipe 固定了完整 VS 小版本。官方相同字节另由上述 VSIX 匹配建立。

原 source-manifest 已有 CPython Windows 3.12.13、release 20260718 的 install-only 归档身份及 upstream hash 对照。本轮只保留该字段选择并重新核 recipe/当前 DLL；**未重新下载或独立校验整份 standalone binary tar**，不把继承的 buildEvidence 写成此次重跑。

### Hyperscan

[官方发布 wheel](https://files.pythonhosted.org/packages/31/b9/38f4f926f1beb102df476dbac08ad4fe5fab2d6da916fb0259e41d0fbee1/hyperscan-0.9.1-cp312-cp312-win_amd64.whl)：1973007 bytes，SHA **`13241b1d3338818d45c37ffc18620326d5a88eab71ec32d01639ad0aa84469a0`**，匹配 PyPI 发布元数据。

- Hyperscan 0.9.1 源码 `pyproject.toml:142–145`：`before-build = "uv pip install delvewheel"` 与 `delvewheel repair -v --wheel-dir={dest_dir} {wheel}`。
- `.github/workflows/build.yml:450–453`：cp312 / win_amd64，`windows-2025` runner。`CMakeLists.txt:239–258` 给出 Windows native runtime / Visual Studio 17 2022 generator 路径。
- wheel 原始 `hyperscan-0.9.1.dist-info/DELVEWHEEL` 明示 **`Version: 1.13.1`** 和实际 repair 命令；不是按源码中的最低要求 `>=1.10.0` 猜测。
- delvewheel 1.13.1 公开源码 `_wheel_repair.py:925–929,950–984` 对依赖进行复制、hash 命名及 rename。repair 也可能修改其他对象的依赖名，因此不泛化成“delvewheel 永远只改文件名”。**本目标 MSVCP 只改名、内容未变的结论，来自微软 CAB 与 wheel 的全字节比较。**

原始 wheel、DELVEWHEEL 记录与比较分别位于：
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/hyperscan-0.9.1-cp312-cp312-win_amd64.whl`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/wheel-hyperscan-0.9.1.dist-info--DELVEWHEEL`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/hyperscan-wheel-comparison.json`
- `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/source-recipe-evidence.json`（原始源码副本路径、hash、行号及引句）

## 5. 安装产品关联许可来源

已安装 Community 产品 `_package.json` 所有 `localizedResources[].license` 均为 [LinkId 2327616](https://go.microsoft.com/fwlink/?LinkId=2327616)。本轮没有跟随链接重复主线法律正文研究，也没有代用户接受许可。

远端原始文件：`C:\ProgramData\Microsoft\VisualStudio\Packages\Microsoft.VisualStudio.Product.Community,version=18.9.12120.119,chip=x64,productarch=x64\_package.json`。

副本：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/installed-community-package.json`。

安装 `Licenses\2052\Redist.txt`（190 bytes，SHA `2d69e3b0ac782d5513b503bafdf269a93c4fec0f1f8efac82bfbfa4b6296aef5`）原文：

> Distributable Code for Microsoft Visual Studio (Includes Utilities & BuildServer Files)
>
> For the latest version of this Redist.txt file, please visit https://aka.ms/vs/18/redistribution.

副本：`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/installed-vs18-Redist.txt`。已安装 CRT Resources 的 VSIX 只有 manifest/签名元数据，未发现其中包含 license.rtf。未扩大为完整编译器/全部第三方原始授权审计。

## 6. 证据完整性注意事项与新增文件

微软 channel 指向的两个 catalog 下载内容，其实际 SHA/bytes 与 channel payload 的声明**不相同**，不能声称整条 channel→catalog 完整性检查通过。实际值与响应头均已保留在 `vs17-channel-runtime-packages.json`、`vs1710-channel-runtime-packages.json`。三个已下载 CRT VSIX 的实际 hash 均匹配各自 catalog payload 的 sha256/URL；catalog 声明的 size 同样与实际归档长度不同，不以 size 一致美化结果。14.40 EXE 的固定 Microsoft winget 清单 hash、实际整包 hash、内部 CAB 和 DLL 匹配是独立证据链。

全部新增脚本、raw 下载、只读远端结果、原始源码副本、归档提取物及比较结果均仅在 `/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/`。逐文件绝对路径、bytes 和 SHA 清单见：

`/home/scq/PaperBridge-zotero-plugin/agent/codex/msvc-origin-20261116/new-files.sha256.json`。

另一新增文件只有本报告。所有可执行调查脚本在本机使用项目 `.venv/bin/python`；Windows DLL/安装器未执行。完成时工作树 tracked 状态保持不变。
