<!-- Microsoft runtime provenance, conditional grants, and distributor decisions. -->
# Windows MSVC redistribution

This review covers the three Microsoft DLLs in the frozen Linux/Windows 0.3.6
candidate, not Windows activation or a general license clearance. Exact original
Microsoft bytes are now identified. **Redistribution conditions remain open**;
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

Before relying on the Community 2026 route:

1. The distributor must confirm lawful licensed use and accept the applicable
   distribution conditions. Section 8, **Distribution Requirements**, requires indemnifying, defending
   and holding Microsoft harmless from claims, including attorneys' fees,
   related to distribution/use of the application, except to the extent a claim
   is based solely on the Distributable Code. This is a user decision, not an
   acceptance an agent records on the user's behalf.
2. The same **Distribution Requirements** require distributors and external end users to agree to
   terms protecting Microsoft's Distributable Code at least as much as the
   agreement. Current addon notices alone do not establish this. Add a clear
   Microsoft-DLL-only agreement/acceptance path before public Windows delivery;
   do not impose those restrictions on the AGPL project or other open-source code.
3. Keep the DLLs unmodified, ship them with the application's significant primary
   functionality, and comply with the unreleased/Insiders, trademark, excluded-
   source-license and applicable trade-law restrictions. Microsoft DLL source
   or byte-identical rebuilding of upstream Python/wheels is not requested here.

No new agreement was accepted, software installed, runtime replaced, or public
asset/feed modified during this review. The four XPI hashes, their native-test
identities and the existing source ZIP remain unchanged. The new review is a
documentation supplement, not a regenerated shipping notice or source bundle.
After the user chooses/confirms the distributor route, integrate the applicable
terms and acceptance path, rebuild affected delivery materials, and rebind the
completed packages/source ZIP without borrowing old exact-byte test results.
