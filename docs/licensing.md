<!-- License scope, exact-byte source delivery and original native notices. -->
# Licensing and native attribution

Scope: **0.3.7 Linux/Windows bundled + local-Python**; **AGPLv3** project,
BabelDOC **0.6.4**, PyMuPDF **1.26.7**, MuPDF **1.26.12** baseline. This is
**not legal clearance** or current build/native/publication acceptance. No macOS
integration/replacement, engine migration or native reverse engineering.

## Evidence entry points

- [Source manifest](../addon/licenses/source-manifest.json): **303 pinned archives**,
  hashes/sizes, member probes, native artifacts and **four Linux build inputs**.
  Counts/labels are not source coverage.
- [Provenance](../addon/licenses/provenance.json) records component associations;
  [public-source evidence](../addon/licenses/supplemental/public-source-evidence.json)
  pins wheel/native bytes and Microsoft document hashes/URLs, not grants.
- [Notice origins](../addon/licenses/supplemental/notice-origins.json) binds original
  and retained hashes. Its documented line-ending/final-newline normalization is
  an origin-comparison rule, not permission to rewrite shipping terms.

Keep [LICENSE](../LICENSE), [NOTICE.md](../NOTICE.md), all
[addon/licenses](../addon/licenses/), wheel/module notices and `.libs` license
material in each XPI. Do not change original terms, notice bytes or approval text
to reconcile warnings. Check source-tree and shipped notices separately.

## Corresponding-source responsibilities

Deliver complete sources, modifications, interfaces and build/install inputs beside
exact executables, without extra source charges: **not** an unspecified written
offer or repository link alone. Include required sources/tests/docs/workflows;
review `projectSnapshot`'s modified/missing/untracked membership. HEAD alone does
not identify delivered bytes.

- Retain AGPL/GPL sources and full licenses for BabelDOC, PyMuPDF, MuPDF,
  pymupdf4llm and Levenshtein, populated MuPDF third-party/font trees and vendored
  RapidFuzz C++ sources/notices. PyMuPDF's dual-license label proves neither a
  commercial license nor combined-work source sufficiency.
- [Berkeley DB 6.0.19 clause 3](../addon/licenses/supplemental/python-build-standalone/linux/LICENSE.bdb.txt)
  requires access information for complete sources of DB and accompanying software
  using it, under its availability/redistributability conditions. Executable sources
  include all contained modules, with its normal-OS-components exception. Retain
  CPython/standalone recipes, selected linked-library sources and modifications;
  unused DB functionality is not an exemption.
- Provide applicable **AGPL section 13** source access to users of a modified
  network service. Loopback/private operation is not an automatic waiver.

## Selected inputs and original notices

- Linux CPython **3.12.16** / Windows **3.12.13** install-only/full archives,
  standalone recipes, original `PYTHON.json` and selected full-build notices
  (Berkeley DB, OpenSSL, expat, SQLite, Tcl/Tk). Preserve stale Windows
  OpenSSL-1_1 metadata names despite observed OpenSSL 3.
- FreeType/HarfBuzz, Vectorscan/Hyperscan/PCRE, libspatialindex,
  cryptography/OpenSSL and actual OpenCV codec sources/notices; orjson's populated
  vendor tree and original crate notices. The **243** checksum-matched Cargo.lock
  registry archives are a superset, not proof of optional/test/other-target linkage.
- Hash-bound ONNX weight/model cards and tiktoken encoding notices/clarification.
  Apache-2.0 weight declarations and MIT encoding terms are distinct from code
  licenses; filenames do not identify licensed bytes.

Linux OpenCV inputs are `CMakeCache.txt`, `opencv-native-gcc10.cmake`,
`toolchain-provenance.json` and `opencv-build.json`. Match `localBuildInputs`
hashes/sizes using originals or unchanged
[retained copies](../addon/licenses/supplemental/build-inputs/linux-opencv/).

## Exact binding and evidence limits

[package_inventory.py](../scripts/package_inventory.py) records native hashes/owners;
[package_sources.py](../scripts/package_sources.py) generates the source ZIP/index.
Bind four platform/mode pairs to **finished XPI SHA256**, not labels/prior acceptance.
Match exact addon/backend membership/bytes; only build-time manifest
`update_url`/JSON serialization is exempt.

Use project `.venv` Python and the pinned cache via the
[source-generation commands](source-delivery-readiness.md#generate-against-the-frozen-four-xpis),
then [verify the handoff](source-delivery-readiness.md#verify-the-complete-handoff),
including the external ZIP/manifest and local checksum. Do not upload independent
`.sha256` files to Releases. Retain original archives,
project/shipped sources, notices and inputs, not XPIs/extracted native binaries.
Rebind after source/doc/notice/XPI changes.

`licenseCompliance=unknown` and partial/unready metadata are **not legal clearance
or proof of missing obligations**. Resolve any identified required source/notice/build
input omissions. Sources/notices do not reconstruct compiler/static-link/font choices.
Optional Rust linkage, tiktoken's unavailable wheel lock/third-party graph, SBOM or
bit-identical rebuild gaps are not extra gates. Tiktoken dependency candidates are
not confirmed original-wheel versions.

Fonts need byte-specific grants, modification/reserved-name review and applicable
embedding conditions. Names, headers, OS/2 `fsType` or an OFL copy alone do not
establish redistribution permission; do not silently add host/cache fonts.

Preserve the user's confirmed lawful Community 2026 use/section 8 duties, original
Microsoft materials and DLL-only terms; do not re-request approval or restrict
AGPL/other open-source code: [Windows MSVC](windows-msvc-redistribution.md).
Runtime EULAs, free Build Tools rights and consent are not redistribution grants.

[Releasing](releasing.md) covers authorized source/sidecar delivery beside exact
XPIs with **`make_latest=false`**, preserving repository-wide Latest and unrelated
assets/channels.
