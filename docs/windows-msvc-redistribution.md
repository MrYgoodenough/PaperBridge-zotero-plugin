<!-- Microsoft runtime byte origins, confirmed distributor duties and isolated consent. -->
# Windows MSVC redistribution

Scope: **0.3.7 Linux/Windows bundled + local-Python**; these DLLs apply only to
Windows. Byte evidence/user confirmation are **not current build/native/publication
acceptance or legal clearance**. No runtime replacement or macOS integration/replacement.

## Exact original DLLs

| XPI member | Version | Matching Microsoft origin | Scope |
| --- | --- | --- | --- |
| `python/vcruntime140.dll` | 14.44.35211.0 | 14.44 CRT base VSIX, `VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT/` | Bundled Python only |
| `python/vcruntime140_1.dll` | 14.44.35211.0 | Same VSIX and CRT directory | Bundled Python only |
| `python/Lib/site-packages/hyperscan.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` | 14.40.33810.0 | VC_redist 14.40.33810 EXE, `vcRuntimeMinimum_amd64/cab1.cab` | Both Windows modes |

The [DLL-origin inventory](windows-msvc-evidence-0.3.6.json) binds inspected samples
to original bytes and valid Authenticode, **not 0.3.7 acceptance**. Hyperscan's DLL
was only renamed; this does not cover all delvewheel output. **14.40.33816 VSIX is
not a matching origin**. Installed CRTs do not prove shipped-file identity.

CRT VSIX payload hashes matched catalog payload hashes, but some channel/catalog
hashes and sizes differed from responses: **no complete catalog integrity chain
is claimed**. Retain these limits and the hash-bound EXE/CAB comparison. Match
finished-XPI native files/notices to [source-manifest.json](../addon/licenses/source-manifest.json);
versions/signatures alone do not establish rights or source sufficiency.

## Grant route and original materials

Microsoft's [deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files)
limits runtime/merge-module/binary distribution to licensed Visual Studio users.
[Community 2026 agreement](https://visualstudio.microsoft.com/license-terms/vs2026-ga-community/)
section 8 provides conditional Distributable Code rights. REDIST excludes
debug/nonredistributable files. Microsoft downloads/open-source wheels are not grants.

Keep the original Community 2026 agreement, VS2026 REDIST, Runtime documents and
retained 2022 texts under [supplemental/msvc](../addon/licenses/supplemental/msvc/),
plus [attribution](../addon/licenses/supplemental/MSVC-runtime-attribution.txt),
byte-for-byte; do not apply the 2022 agreement silently to 2026. Runtime EULAs grant
use, not redistribution. Free Build Tools' OSI-build rights, EULAs and consent are
not standalone redistribution grants.

## Existing distributor confirmation

On **2026-11-16**, the user explicitly confirmed lawful use of installed
**Visual Studio Community 2026 18.9.2** and agreed to proceed under its **section 8**
distribution conditions. This is the user's declaration, not an agent's acceptance
on the user's behalf or an independent legal audit. **Do not request the same
decision again.** Installation alone does not prove eligibility/assent.

Preserve the confirmed duties under the original agreement:

- Indemnify, defend and hold Microsoft harmless from application distribution/use
  claims, including attorneys' fees, **except to the extent a claim is based solely
  on Distributable Code**. This duty belongs to distributors, not ordinary users.
- Require downstream distributors and external end users to agree to terms at
  least as protective of Microsoft Code as Microsoft's agreement.
- Keep DLLs unmodified with significant primary application functionality; retain
  unreleased/Insiders, trademark, excluded-source-license and trade-law restrictions.
  DLLs are not relicensed under AGPL; DLL-only terms must not restrict AGPL/other
  open-source code, PDFs or translated output.

## One-time isolated DLL agreement

[runtime-terms.js](../addon/content/runtime-terms.js) presents the unchanged offline
[Microsoft-Runtime-Terms.txt](../addon/licenses/supplemental/msvc/Microsoft-Runtime-Terms.txt),
identity **`msvc-community-2026-v1`**. Maintain this behavior in both Windows modes:

- Prompt on the first active backend action or explicit settings action, before
  engine unpack/run. Background migration, monitoring, cleanup and diagnostic
  export do not open consent windows.
- Persist explicit acceptance locally by terms identity, not plugin version;
  collect/upload no account or document data.
- Refusal/close is not acceptance and disables **only the backend**. Ordinary
  Zotero and saved-PDF reading remain usable. A refused session does not repeatedly
  prompt; settings allow reconsideration.
- Linux is exempt. Consent requires no Visual Studio, Microsoft account, purchased
  license or separate CRT installer; existing backend setup is unchanged.

This DLL-only protective agreement operates under the user's confirmed route,
not as a standalone redistribution grant or AGPL-wide end-user license.

## Verify and deliver exact packages

Follow [releasing](releasing.md): native AddonManager install/update, Windows refusal,
saved-PDF reading without an engine, settings acceptance, actual backend health,
same-profile/data new-PID cold reopen and Linux exemption without Windows consent.
Bind results to **finished XPI SHA256**, never previous runs/version labels.

Keep original notices/terms and dependency `.libs` material in both Windows modes.
Local omits the interpreter, **not** the Hyperscan DLL or its duties.
Use the [source-delivery guide](source-delivery-readiness.md) for **303 archives**,
**four Linux build inputs**, project `.venv` commands and pinned cache reuse.
Rebind after source/notice/native changes; check source-tree/shipped notices and
external source sidecars separately.

`licenseCompliance=unknown` is not legal clearance or proof of missing obligations;
resolve concrete omissions under [licensing](licensing.md). Authorized publication
uses **`make_latest=false`**, preserving repository-wide Latest and unrelated assets/
channels.
