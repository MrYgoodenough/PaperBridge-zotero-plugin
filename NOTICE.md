<!-- Redistribution notices; located evidence is not a legal compliance opinion. -->
# PaperBridge — third-party notices

PaperBridge includes third-party software and offline assets. Each component
retains its own license; this notice does not relicense it or certify compliance.
The full project license is in `LICENSE`. Bundled copies are under `licenses/`
in the XPI (`addon/licenses/` in the source tree).

- **BabelDOC 0.6.4, PyMuPDF 1.26.7 / MuPDF, and pymupdf4llm:** retain their
  packaged license files and the full AGPL text. No Artifex commercial license
  is supplied. MuPDF copyright and license notices are in
  `licenses/native/MuPDF-1.26.12-README.txt`.
- **CPython 3.12:** retain the Python Software Foundation and historical notices
  in `licenses/CPython-3.12.txt` and `licenses/CPython-3.12-third-party.rst`.
  These official notices match both inspected 3.12.13 and 3.12.16 sources.
  Linux standalone native-library notices are included separately; Windows
  native DLL/full-build attribution remains unverified.
  PaperBridge omits development/test/GUI resources and sanitizes local build
  paths when staging Python; it does not claim an unmodified upstream bundle.
- **DocLayout-YOLO DocStructBench ONNX:** the conversion publisher and base-model
  publisher declare Apache-2.0. Their model cards and the full license are in
  `licenses/doclayout/`. These weight declarations are distinct from the
  DocLayout-YOLO source-code repository's license.
- **tiktoken `o200k_base` encoding:** retain the MIT copyright and permission
  notice in `licenses/tiktoken/MIT.txt`. The upstream maintainer's clarification
  that the license also applies to encoding files is preserved alongside it.
- **Wheel-native libraries:** retain the shipped distribution/module licenses,
  `ThirdPartyNotices.txt`, `LICENSE-3RD-PARTY.txt`, and wheel-private `.libs`
  notices. Supplemental FreeType, HarfBuzz, Vectorscan/PCRE, libspatialindex, OpenSSL
  and MuPDF notices are in `licenses/native/`.

This software uses the FreeType Project. This software is based in part on the
work of the Independent JPEG Group. OpenSSL is developed by the OpenSSL Project.

Exact version/byte associations and upstream sources are recorded in
`licenses/provenance.json`; only matching shipped artifacts receive those
associations. Its scope is evidence, not a complete vendored-code audit.
Redistribution may require corresponding source and additional obligations,
including AGPL/GPL and Berkeley DB's source-availability conditions. Source
links alone are not a written source offer. See `docs/licensing.md` in the source
tree for the remaining checks before publishing a rebuilt package.
