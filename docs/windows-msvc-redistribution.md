<!-- Microsoft runtime provenance, conditional grants, and distributor decisions. -->
# Windows MSVC redistribution

This review covers the three Microsoft DLLs in the frozen Linux/Windows 0.3.6
candidate, not Windows activation or a general license clearance. Exact original
Microsoft bytes are now identified. **The distributor has explicitly confirmed
lawful Community 2026 use and responsibility for its section 8 distribution
conditions; the protective agreement is implemented, with final-package native acceptance pending.** This
is the user's declaration, not an independent legal audit or general clearance.
`licenseCompliance` stays `unknown`. Machine-readable hashes and references are
in `windows-msvc-evidence-0.3.6.json`.

## Original files

| Shipped file | Version | Official matching release | Scope |
| --- | --- | --- | --- |
| `python/vcruntime140.dll` | 14.44.35211.0 | Microsoft 14.44 CRT base VSIX, `VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT/` | Bundled Python only |
| `python/vcruntime140_1.dll` | 14.44.35211.0 | The same VSIX and CRT directory | Bundled Python only |
| `python/Lib/site-packages/hyperscan.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` | 14.40.33810.0 | Microsoft VC_redist 14.40.33810 EXE, embedded `vcRuntimeMinimum_amd64/cab1.cab` | Both Windows Python modes |

All three existing Windows files have a valid Microsoft Authenticode signature.
The Hyperscan wheel DLL is byte-for-byte identical to the Microsoft CAB member:
only this DLL's filename changed. This is not a general claim about all files
processed by delvewheel. The different 14.40.33816 VSIX is **not** a matching
origin. Current installed CRTs are 14.51.36247.0, not the shipped versions.

Downloaded CRT VSIX hashes match their catalog payload hashes, but channel-to-
catalog hashes/sizes and some declared payload sizes did not match the responses.
Do not claim that the entire catalog integrity chain passed. Exact DLL hashes,
Windows Authenticode, and the independently hash-bound 14.40 EXE/wheel comparison
are the bounded evidence used here.

## Applicable grant routes

- Microsoft's [deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files)
  limits runtime package, merge-module and individual-binary distribution to
  licensed Visual Studio users, subject to their license terms.
- [VS2022 REDIST](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)
  and [VS2026 REDIST](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)
  list the `VC\redist` subtree, exclude debug/nonredistributable files, prohibit
  modifying the files, and reference the official runtime downloads. Obtaining
  a file from Microsoft or an open-source wheel is not itself a distributor grant.
- [Community 2022](https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/)
  section 4 and [Community 2026](https://visualstudio.microsoft.com/license-terms/vs2026-ga-community/)
  section 8 provide conditional Distributable Code rights. Individual developers
  working on their own applications have an eligible use route; organizational
  open-source use also has a route. Eligibility and acceptance must be factual,
  not inferred solely from installed files.
- Standalone Build Tools [2022](https://visualstudio.microsoft.com/license-terms/vs2022-ga-diagnosticbuildtools/)
  and [2026](https://visualstudio.microsoft.com/license-terms/vs2026-ga-diagnostic-buildtools/)
  allow a limited third-party OSI-dependency build route without a Visual Studio
  product license. Neither contains a separate Distributable Code grant.
- The retained Runtime 2015–2022 terms and the current
  [v14 Runtime terms](https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/)
  authorize installation/use, not redistribution. Copying an EULA into an XPI
  does not establish either the distributor grant or an end-user agreement.

## Existing installation and decisions

The Windows machine has one complete, launchable, non-prerelease installation:
**Visual Studio Community 2026 18.9.2**, installation version
`18.9.12120.119`. Its installed product metadata links to
[the Community 2026 terms](https://go.microsoft.com/fwlink/?LinkId=2327616),
and its `Redist.txt` links to VS18 REDIST. It is not a BuildTools-only machine.
This inventory does not prove the user's eligibility, assent or contractual
authority. The installer `expirationDate` is not treated as license-expiry proof.
Do not silently apply the retained 2022 agreement to a 2026 installation.

Distributor confirmation and protective agreement:

1. On 2026-11-16, the user explicitly confirmed lawful use of the installed
   Community 2026 and agreed to proceed under its section 8 distribution
   conditions. That decision is recorded from the user, not accepted by an agent
   on the user's behalf or independently legally audited; the same decision
   does not need to be requested again. Section 8, **Distribution Requirements**,
   requires indemnifying, defending
   and holding Microsoft harmless from claims, including attorneys' fees,
   related to distribution/use of the application, except to the extent a claim
   is based solely on the Distributable Code. Responsibility remains with the
   distributor.
2. The same **Distribution Requirements** require distributors and external end users to agree to
   terms protecting Microsoft's Distributable Code at least as much as the
   agreement. `Microsoft-Runtime-Terms.txt` supplies a Microsoft-DLL-only
   end-user/downstream-distributor agreement, presented offline by
   `addon/content/runtime-terms.js` before the Windows engine can unpack or run.
   It does not impose restrictions on the AGPL project or other open-source code.
3. Keep the DLLs unmodified, ship them with the application's significant primary
   functionality, and comply with the unreleased/Insiders, trademark, excluded-
   source-license and applicable trade-law restrictions. Microsoft DLL source
   or byte-identical rebuilding of upstream Python/wheels is not requested here.

## End-user experience and delivery follow-up

The implementation, offline core contracts and bounded final-package native
checks are complete. Exact identities and exclusions are in
`runtime-terms-acceptance-0.3.6.json`:

- Windows bundled/local modes share offline, explicit-consent terms limited to
  the shipped Microsoft MSVC DLLs. The first active action needing the backend,
  or an explicit click in settings, presents the confirmation; background
  migration, monitoring, cleanup and diagnostic export do not open consent windows.
- Acceptance is persisted for the same terms identity, not requested again
  merely because the plugin version changes. Declining or closing disables only
  the backend, not ordinary Zotero use or reading already saved PDFs. A refused
  session does not repeatedly prompt; the settings button allows reconsideration.
- Ordinary users will notice this confirmation, but it adds no installation
  steps: no Visual Studio, Microsoft account, purchased license or separate
  Visual C++ redistributable installer is required by this consent flow. Other
  existing backend setup requirements are unchanged.
- Retain the original Visual Studio/Runtime documents without rewriting them.
  Retained terms or end-user consent do not independently grant redistribution
  rights. The DLL-only terms must not restrict the AGPL plugin as a whole or
  other open-source code.

Both Windows modes passed a real AddonManager file install, refusal, saved-PDF
reading without an engine, explicit settings acceptance, actual backend health
and a different-PID cold reopen at the existing 150% display scale. Input used
trusted Gecko `windowUtils.sendMouseEvent` in production windows, not a synthetic
DOM click; external OS mouse injection is not claimed. Linux bundled/local
checks confirmed exemption and local health without writing Windows consent.
These are synthetic-library tests, not a new translation, upgrade/notes,
account-sync or human-quality acceptance.

The four private packages are rebuilt and locally verified; all 188 shipped
project-source/notice files per package match current source, and the Microsoft
DLLs are unchanged. Hash-bound source delivery is recorded separately in
`candidate-delivery-0.3.6.json`. Public assets/feeds and macOS remain unchanged.
Earlier native reports retain their own old XPI identities. AGPL/GPL, Berkeley
DB and public-source delivery obligations remain open; overall
`licenseCompliance` is `unknown` and corresponding-source closure is `partial`.
