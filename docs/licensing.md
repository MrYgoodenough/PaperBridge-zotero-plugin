<!-- Minimal licensing evidence and the maintenance points for rebuilt packages. -->
# Bundled licensing evidence

This is an engineering record for a personal/internal product, **not a legal
opinion or redistribution clearance**. `licenseCompliance` remains `unknown`.
Private use does not waive obligations when a package is shared or published.
The engine baseline remains BabelDOC **0.6.4** / PyMuPDF **1.26.7**.

## Verified evidence and scope

| Shipped item | Evidence retained | Boundary |
| --- | --- | --- |
| Linux CPython 3.12.16 | Actual `python/lib/python3.12/LICENSE.txt`, identical to upstream `v3.12.16/LICENSE`; CPython's incorporated-code notices; standalone build declarations and native-library license texts | Interpreter archive digest and staged executable match the official 20261026 install-only build. The separate full-build `PYTHON.json` supplies license paths; its full archive digest is publisher-reported, not locally recomputed. |
| Windows CPython 3.12.13 | Read-only clone `runtime.json` and executable/DLL file versions agree; exact executable/DLL hashes; official `v3.12.13/LICENSE` and `Doc/license.rst` | Both official notice texts are byte-identical to 3.12.16 and shared under generic 3.12 filenames. Original Windows standalone full-build metadata and native DLL attribution remain unverified. |
| Wheel-native dependencies | Packaged `METADATA`, `WHEEL` tags, `RECORD` ownership, actual native-file hashes, declared/discovered notices | Distribution license fields are not a complete inventory of statically linked constituents. Missing declared files remain warnings. |
| Supplemental native notices | FreeType 2.13.2 / its HarfBuzz 8.3.0, uharfbuzz's HarfBuzz 15.0.0, Vectorscan 5.4.12 / build-recipe PCRE 8.45, libspatialindex 2.1.0, cryptography's OpenSSL 4.0.3, MuPDF 1.26.12 and font notices | Associations require the inspected Linux binary bytes and distribution versions to match. Public version APIs and pinned upstream build sources identify these versions; this is not a symbol/link audit. |
| DocLayout-YOLO DocStructBench ONNX | Fixed conversion and base-model cards both declare Apache-2.0; full Apache text; ONNX hash matches the conversion repository's LFS object and BabelDOC's expected SHA3-256 | The publisher's weight-license declaration is distinct from the DocLayout-YOLO code repository's AGPL license. No training dataset or source-code integration is implied. |
| `o200k_base` tokenizer vocabulary | tiktoken 0.14.0 MIT text and [upstream collaborator's encoding-license clarification](https://github.com/openai/tiktoken/issues/92#issuecomment-1497875652); actual hash matches `tiktoken_ext/openai_public.py` and BabelDOC's cache declaration | The clarification states that the repository license also applies to encoding files; it is not a separate blob-specific license. |

The verified Linux interpreter archive is
`cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`:
SHA-256 `ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20`.
The staged executable also matches the interpreter in that local archive.
Its recorded build commit is
`fa506e0858ac9f2cc5b289c137b888a2aa24d1ee` in
[python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026).
The checked license paths include Berkeley DB and `_tkinter`'s static libraries:
unused functionality does not make those shipped native bytes disappear.
The OpenSSL license text is shared rather than duplicated.

The exact offline assets are:

- `doclayout_yolo_docstructbench_imgsz1024.onnx`, 75,324,598 bytes:
  SHA-256 `fece9af02f618b603ff7921ccec6861d13e7e1f9830e091dfb7e8ad9311e5b21`;
  conversion revision `ee7c3d744e5c47c58e267044ac825f95abe69653`.
- `fb374d419588a4632f3f557e76b4b70aebbca790`, 3,613,922 bytes:
  SHA-256 `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`;
  the URL/cache identity is tiktoken's `o200k_base.tiktoken`.

Upstream text is retained with terminal-newline normalization only. The FreeType
zlib, libspatialindex and OpenSSL copyright/license headers are identified
excerpts, not rewritten grants. Their full source URLs and source hashes are
recorded with bundled-file hashes and available source hashes. The old
version-specific Python notice filename was replaced with `CPython-3.12.txt`;
its license text was not changed. Official incorporated-code notices shared by
3.12.13 and 3.12.16 are in `CPython-3.12-third-party.rst`.

The Windows evidence hashes were read without modifying the native stage clone
`E:\PBAssets-1115\.cache\package\windows-x64`: `python.exe` is
`f598fb950a86a895d8f9b4755fc9b38c48adc7a15732a342e55c17a3c3499602`, and
`python312.dll` is
`70713cbbbcacd1ca70f802e87683d85aea185da1aae9bd31d6c02be51cfee819`.
Both report **3.12.13**, not 3.12.14. This identifies the inspected bytes; it does
not recover their complete original standalone-build/native-library evidence.

## Maintenance and packaging

- Keep root `NOTICE.md` in the XPI and copy `addon/licenses/` as `licenses/`.
  Preserve wheel `.dist-info/licenses/`, module-local notices and private `.libs`
  material when staging or reducing package size.
- Change evidence in `addon/licenses/provenance.json`, not a list of invented
  SPDX labels. Entries name a component or distribution, optionally constrain
  platform/Python/distribution version, and hash both runtime-relative
  `artifacts` and archive-root notice `files`. Sources are stored references;
  the inventory makes **no network calls**.
- `scripts/package_inventory.py` reports a supplemental entry as `matched` only
  when its artifacts and nonempty notice files match. Missing/stale evidence is
  advisory and does not prevent unrelated runtime functionality. This status
  describes bytes, not satisfaction of the license's conditions.
- Source-compiled OpenCV is not a wheel: a runtime `build` declaration with a
  matching extension hash/version identifies its module-local notices. Keep the
  actual OpenCV and enabled third-party notices in `cv2`; do not reuse a removed
  official wheel's build identity or assume its notices describe the new build.
- Rebuild and inspect the **completed XPI** after updating notices. Old artifacts
  do not acquire new evidence. Focused offline checks use the project Python:
  `.venv/bin/python -B -m pytest -q -p no:cacheprovider tests/test_package_inventory.py`.

## Remaining redistribution checks

1. Make the exact applicable corresponding source and modification/build material
   available when distributing AGPL/GPL components (including BabelDOC,
   PyMuPDF/MuPDF, pymupdf4llm and Levenshtein). The actual bundled Berkeley DB
   notice also contains source-availability conditions. Project/source links
   alone are not proof of a compliant source delivery or a written offer. A
   modified AGPL network service may have additional source-access obligations.
2. PyMuPDF's packaged `COPYING` is only a dual-license label. The project supplies
   full AGPL text and supplemental MuPDF copyright/font notices, **not a
   commercial license**. MuPDF's complete compiled third-party/font provenance
   is still unverified; its source submodule revisions and build flags must be
   checked before claiming complete notice coverage. Likewise this minimal
   inventory does not audit every vendored Rust crate or linker runtime, or
   independently prove the Hyperscan build recipe's static PCRE composition.
3. A reduced Linux OpenCV build must retain the notices for its actual enabled
   codecs. `libjpeg-turbo/LICENSE.md` can refer to further notices; preserve the
   relevant copyright/IJG material too. The Independent JPEG Group and FreeType
   acknowledgements are already in the root NOTICE. Recheck the completed new
   `cv2` artifact, not just the presence of any file named LICENSE.
4. Linux interpreter/native provenance is not Windows or macOS validation.
   Windows 3.12.13 has matching official Python notices, but its original
   full-build metadata and native DLL attribution/notices remain unverified.
   Verify native distributions separately. Shared inventory code supports their paths;
   no macOS-specific source integration or engine migration is performed here.
