<!-- Third-party attribution and the separate source-delivery boundary. -->
# PaperBridge — third-party notices

PaperBridge includes third-party software and offline assets. Each component
retains its own license; this notice does not relicense it or certify compliance.
PaperBridge is licensed under **AGPLv3**; the full text is in `LICENSE`. Bundled copies are under `licenses/`
in the XPI (`addon/licenses/` in the source tree).

- **BabelDOC 0.6.4, PyMuPDF 1.26.7 / MuPDF 1.26.12, and pymupdf4llm 0.2.9:**
  retain their packaged notices and full AGPL text. No Artifex commercial
  license is supplied. Complete MuPDF source/font/third-party trees are in the
  separate source archive; retained notices are in `licenses/supplemental/`.
- **Levenshtein 0.27.5:** retain its GPL-2.0-or-later notice/full GPL text and
  its vendored RapidFuzz C++ MIT notice in `licenses/supplemental/`.
- **CPython 3.12.16 (Linux) / 3.12.13 (Windows):** retain the shared Python
  Software Foundation/historical notices in `licenses/CPython-3.12.txt` and
  `licenses/CPython-3.12-third-party.rst`. Original standalone build metadata
  and native-library notices for both platforms are under
  `licenses/supplemental/python-build-standalone/`. They include the actual
  Berkeley DB source-availability conditions, not an invented SPDX substitute.
  Staging removes selected resources and sanitizes build paths; this is not
  represented as an unmodified upstream interpreter distribution.
- **DocLayout-YOLO DocStructBench ONNX:** the conversion publisher and base-model
  publisher declare Apache-2.0. Their model cards and the full license are in
  `licenses/doclayout/`. These weight declarations are distinct from the
  DocLayout-YOLO source-code repository's license.
- **tiktoken `o200k_base` encoding:** retain the MIT copyright and permission
  notice in `licenses/tiktoken/MIT.txt`. The upstream maintainer's clarification
  that the license also applies to encoding files is preserved alongside it.
- **Native libraries:** retain shipped distribution/module licenses,
  `ThirdPartyNotices.txt`, `LICENSE-3RD-PARTY.txt` and wheel-private `.libs`
  material. Supplemental notices cover FreeType 2.13.2, its build-recipe
  HarfBuzz 8.3.0, uharfbuzz's HarfBuzz 15.0.0, Linux Vectorscan 5.4.12,
  Windows Intel Hyperscan 5.4.2, recipe PCRE 8.45, libspatialindex 2.1.0,
  OpenSSL and MuPDF. Rust lockfile/vendor notices are a conservative superset,
  not a declaration of every linked crate. All 243 lockfile registry candidates
  are retained, including checksum-matched crossbeam-deque 0.8.7. Additional
  tiktoken-declared dependency notices are public source candidates, not a
  recovered original-wheel graph. Keep actual OpenCV codec notices.
- **Microsoft Windows runtimes:** exact DLL versions/hashes/copyright are in
  `licenses/supplemental/MSVC-runtime-attribution.txt`. Attribution is **not**
  a redistribution grant. Official Runtime use terms, VS2022 Community terms
  and REDIST list are retained in `licenses/supplemental/msvc/`. The Runtime
  use terms do not permit redistribution; the separate VS2022 REDIST grant is
  conditional. This distributor's applicable license/exact DLL-release basis
  remains unconfirmed.

This software uses the FreeType Project. This software is based in part on the
work of the Independent JPEG Group. OpenSSL is developed by the OpenSSL Project.

`licenses/provenance.json` retains the earlier inventory associations;
`licenses/source-manifest.json` adds pinned source archives, native hashes,
build inputs and specific unresolved scope. The separate source ZIP binds only
the exact XPI hashes in its `bundle-manifest.json`; it does not contain an XPI
or certify legal compliance. Publish a regenerated source ZIP, manifest and
checksum beside the completed packages, without an extra source charge.
Full sources alongside the executable are the delivery method, not repository
links or a written offer. Preserve AGPL/GPL and Berkeley DB clause-3 required
sources/build inputs and any applicable modified-service source access.
Missing original compiler metadata or byte-identical wheel reproduction is not
itself a proven missing-license/source violation. See `docs/licensing.md` and
`licenses/supplemental/public-source-evidence.json`; `licenseCompliance`
remains `unknown`.
