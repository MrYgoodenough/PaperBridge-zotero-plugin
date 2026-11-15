<!-- Hash-bound source delivery, native attribution and unresolved release obligations. -->
# Source delivery and native attribution

This is technical evidence, **not legal clearance**. `licenseCompliance` is
`unknown`, corresponding-source closure is `partial`, and public-release
readiness is not established. PaperBridge's project license is **AGPLv3**;
full sources delivered beside the executable are the chosen delivery method,
not a written offer. The baseline stays BabelDOC **0.6.4** / PyMuPDF
**1.26.7** / MuPDF **1.26.12**. No engine replacement, native reverse engineering
or macOS-source integration is involved.

## Evidence and limits

`addon/licenses/source-manifest.json` pins archive URLs, versions, sizes, SHA256
and source/build/notice member probes. Its `nativeEvidence` binds supplemental
notices to actual XPI native hashes and platform/distribution versions.
`addon/licenses/supplemental/notice-origins.json` records original and retained
notice hashes; only CRLF/final-newline normalization is applied. Original
licenses are not rewritten as grants. Earlier `provenance.json` associations
remain separate; a warning there is not silently converted into clearance.

| Component | Identified inputs | Boundary |
| --- | --- | --- |
| Linux CPython 3.12.16 | Standalone release 20261026; recipe `fa506e0858ac9f2cc5b289c137b888a2aa24d1ee`; install-only and full archives locally hashed; original `PYTHON.json` and 20 full-build notices | All seven shipped interpreter-native files outside site-packages match the install archive. Many stdlib components are built into libpython; this is not a full static-link audit. |
| Windows CPython 3.12.13 | Standalone release 20260718; recipe `0e4d9c24b72d28573e622518f09b16aef4a33be8`; both archives locally hashed; original metadata and 19 full-build notices | All 45 shipped interpreter-native files outside site-packages match the install archive. Original metadata has stale OpenSSL-1_1 link names; actual files/API are OpenSSL 3.5.7. Original values are retained. |
| Interpreter dependencies | Linux OpenSSL 3.5.9 / expat 2.9.0; Windows OpenSSL 3.5.7 / expat 2.7.4; both SQLite 3.53.1; complete recipe/CPython inputs and Berkeley DB 6.0.19 source | Source/version association does not reconstruct the full original toolchain or all executable modules. Windows Tcl/Tk 8.6.12 recipe also names separately pinned cpython-bin-deps binaries. |
| Native wheels | FreeType 2.13.2 and recipe HarfBuzz 8.3.0; uharfbuzz HarfBuzz 15.0.0; Linux Vectorscan 5.4.12 / Windows Intel Hyperscan 5.4.2 and recipe PCRE 8.45; libspatialindex 2.1.0; cryptography OpenSSL 4.0.3 | Native public APIs/file hashes identify inspected bytes. Publisher sdists/build recipes and notice supersets do not prove exact static composition/compiler options. |
| Copyleft sources | Complete BabelDOC, PyMuPDF, MuPDF, pymupdf4llm 0.2.9 and Levenshtein 0.27.5 sources; full licenses; populated MuPDF third-party/font trees; vendored RapidFuzz C++ source/notice | PyMuPDF's short dual-license label is not a commercial license. Exact wheel modifications/enabled constituents and combined-work source sufficiency still need review. |
| OpenCV | Linux image-only 4.12.0 source, CMake cache/toolchain/provenance/build JSON; Windows official headless 5.0.0.93 source and observed 5.0.0 build information | Preserve actual codec notices. Linux path-sanitization hashes differ from pre-sanitization build hashes; see `docs/linux-package-size.md`. No byte-identical wheel rebuild is claimed. |
| Rust/native notices | All 243 Cargo.lock registry candidates, including checksum-matched crossbeam-deque 0.8.7; orjson's populated vendor tree; original notices | Optional/test/build/other-target crates remain a conservative superset, not shipped-linkage evidence. No prior locked registry candidate remains missing. |
| tiktoken 0.14.0 | Public tag/sdist, build workflow and both PyPI cp312 wheels; native wheel bytes exactly match the old Linux/Windows baseline; MIT license retained | No public wheel build lock/third-party graph. Additional fancy-regex 0.19.0, bstr 1.13.1 and rustc-hash 2.1.3 sources/notices are declaration/range candidates, not confirmed original-wheel dependency versions. |
| Microsoft runtimes | VCRuntime 14.44.35211.0 in bundled Python; hyperscan-private MSVCP140 14.40.33810.0 also in local-Python packages; official original license/REDIST documents | Runtime use terms are **not a redistribution grant**. VS2022 REDIST terms are conditional; this distributor's license and exact unmodified DLL-release basis remain unconfirmed. |

Both original install/full archive digests and selected native-file hashes are
in `buildEvidence`; no publisher-reported digest is passed off as a local hash.
The shared PSF/historical texts match both CPython source versions.
`supplemental/public-source-evidence.json` (under `addon/licenses/`) records
public wheel/native hashes, candidate selection bases and original Microsoft
document hashes/URLs. It does not claim that retaining an EULA grants rights.

The ONNX model remains 75,324,598 bytes, SHA256
`fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21`,
conversion revision `ee7c3d744e5c47c58e267044ac825f95abe69653`.
The conversion/base-model cards declare Apache-2.0 for weights; this is distinct
from the model code's license. `o200k_base.tiktoken` is 3,613,922 bytes, SHA256
`446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`;
the MIT notice and encoding-license clarification remain under `licenses/tiktoken/`.

## Generate and verify the separate source ZIP

After source integration and the **completed** four-package rebuild, run from
the repository root (Windows uses the project's `.venv\\Scripts\\python.exe`):

```sh
.venv/bin/python -B scripts/package_sources.py --download \
  --xpi dist/paperbridge-0.3.6-linux-x64.xpi \
  --xpi dist/paperbridge-0.3.6-linux-x64-local-python.xpi \
  --xpi dist/paperbridge-0.3.6-windows-x64.xpi \
  --xpi dist/paperbridge-0.3.6-windows-x64-local-python.xpi \
  --output dist/paperbridge-0.3.6-linux-windows-source.zip
.venv/bin/python -B scripts/package_sources.py \
  --verify dist/paperbridge-0.3.6-linux-windows-source.zip
```

The cache defaults to `agent/codex/package-source-cache`; use `--cache PATH`
for an existing verified cache and omit `--download` for offline generation.
Do not redownload a complete cache merely to refresh XPI bindings.
The script emits the ZIP plus `.manifest.json` and `.sha256` sidecars. It hashes
actual XPIs, verifies archive bytes/member probes, streams without executing
packaged code, then rehashes every indexed ZIP member. Success means **byte
delivery verified**, not a passed licensing gate. Protect the external ZIP
checksum: an internal index alone does not authenticate its own manifest.

- `upstream/`: complete pinned compressed archives, not binaries or placeholder
  links. Cache can also use the same `<source-id>/<filename>` layout.
- `project/`: tracked working-tree addon/backend/build/setup/configuration files
  plus explicitly included `scripts/package_sources.py` and `addon/licenses/`.
  `projectSnapshot` discloses Git HEAD, modified tracked files, included untracked
  delivery files and excluded unrelated untracked source files. HEAD alone does
  **not** identify uncommitted bytes. Stage/commit required source membership
  before final release; the new script is included even in provisional runs.
- `shipped/<xpi-name>/`: exact delivered project/Python/interface sources,
  notices, metadata and runtime declarations, including Windows RECORD paths
  with backslash separators. They are retained even if the current tree differs.
  Manifest comparison applies only build.py's expected platform/mode `update_url`
  and JSON serialization; other manifest fields and source bytes must still match.
- `build-inputs/`: hash-verified Linux OpenCV configuration. A retained
  supplemental copy works when the original private cache is absent.
- `xpis/` and `bundle-manifest.json`: fresh byte inventories, all observed native
  hashes/RECORD owners, separate source-tree vs shipped-notice matching, source
  selection/probe verification and explicit blockers. Native binaries are not
  placed in the source ZIP.

Keep root `NOTICE.md` and all `addon/licenses/` in every rebuilt XPI, along with
root `LICENSE`, wheel/module notices and `.libs` material. The generator checks
all addon license files, not just new supplemental notices. Old XPIs are missing
the new delivery files; a provisional source ZIP certifies **only its listed old hashes**. Main
must rebuild, reaccept native packages as needed, and regenerate against new
hashes; prior-package hashes cannot be borrowed.

## Delivery obligations and remaining evidence limits

1. **Microsoft redistribution basis — decision needed:** the original Runtime
   use and VS2022 Community terms plus REDIST page are in `supplemental/msvc/`.
   Runtime terms permit installation/use but prohibit sharing/distribution to
   others. VS2022 provides a separate conditional route for listed unmodified
   files by validly licensed users, with distribution conditions. Confirm the
   applicable distributor license and release-file basis for these exact DLLs
   before redistribution; retaining PSF notices or Microsoft's EULA is not enough.
   No runtime replacement or dependency change is authorized by this evidence.
2. **Source delivery:** retain the AGPLv3 project and the supplied AGPL/GPL
   dependency sources, modifications and build/install inputs alongside the
   executable. Berkeley DB's actual clause 3 extends
   to DB and accompanying software using it, with executable-module source
   requirements; unused functionality is not an automatic exemption. This ZIP
   is not a written offer. For a modified AGPL network service, assess and supply
   applicable source access to interacting users (AGPL section 13).
3. **tiktoken — evidence limit, not an automatic gate:** public tag/sdist/wheels
   do not contain a build lock/third-party graph. Unauthenticated tag-build log
   download returned HTTP 403; PyPI provenance endpoints returned 404. Identified wheel MIT
   notices and supplemental declared-dependency notices are retained. Exact
   transitive wheel versions remain unconfirmed; no specifically missing
   mandatory notice is established by absence of a lock alone. Obtain original
   build metadata if needed, but do not require a controlled rebuild solely to
   achieve byte identity. Any same-version rebuild remains a user decision.
4. **Native/static/font evidence limits:** full sources/notices are a superset,
   not a recovered original-wheel compiler/link/enabled-font audit. Resolve
   specifically identified missing required sources/notices/build controls;
   original compiler/byte-identical reproduction uncertainty alone is not a
   release gate or a proven license breach. These limits are separately listed
   in `evidenceLimits`, not disguised as confirmed missing licenses.
   Standalone font scanning does not extract compiled font data. Local
   Songti/Noto/Source Han names or OS/2 `fsType` do not establish redistribution
   permission. Do not add cache fonts without byte-specific grant/derivative/
   reserved-name review; PDF embedding has its own applicable conditions.
5. **Release integration/delivery:** finalize source membership, inspect all four
   new XPIs/notices, regenerate and verify source bindings, then publish ZIP,
   manifest and checksum at the same download location without an extra source
   charge. Keep licenses, populated source trees and build/install instructions
   available. No push, publication, native-account/profile mutation or release
   approval is performed by the source script.
