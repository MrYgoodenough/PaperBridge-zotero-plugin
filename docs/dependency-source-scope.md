<!-- Actual DB/Runtime dependency scope and how to recheck source-delivery obligations. -->
# DB and Runtime source scope

Scope: the six unpublished **0.4.3** Linux x64 / Windows x64 / macOS arm64 XPIs,
bundled and local-Python modes, with BabelDOC **0.6.4**. This is a component-level
engineering assessment, not legal clearance, a bit-identical rebuild or permission
to publish. Keep original notices and the frozen 0.3.7 / independent Mac 0.4.2 assets.

## Berkeley DB: identified sources covered

Use the publisher's original `PYTHON.json` core/extension declarations and matching
shipped native hashes, not the presence of a license file as proof of linkage:

| Candidate | Actual bundled interpreter scope | DB source obligation identified |
| --- | --- | --- |
| Linux bundled | `_dbm` is a separate extension containing `_dbmmodule.o` and static `libdb.a`; core and other extension declarations contain no DB links. | Yes; covered below. |
| Windows bundled | No `_dbm` extension or DB link in the original core/extension records. | No DB use identified. |
| macOS bundled | `_dbm` has an empty link list; no DB link in the original core/extension records. | No DB use identified. |
| Three local-Python packages | Dependency site-packages remain, but no bundled interpreter or stdlib native DB module. | No distributed interpreter DB component identified; users' own Python is outside this package assessment. |

The Linux module uses **DB 6.0.19 / Sleepycat clause 3**, not the AGPL license of
later DB releases. Its executable-module source scope is the CPython module plus
the DB implementation. The supplied full CPython source also covers accompanying
stdlib/interpreter code; the normal-OS-component exception is not used to exclude
project or third-party application libraries. Optional/unused functionality does
not waive the source obligation for the distributed Linux extension.

The corresponding-source ZIP retains:

- `upstream/berkeley-db/db-6.0.19.tar.gz`: complete DB sources, license and configure
  input, matching the standalone recipe's download SHA-256.
- `upstream/cpython-linux/Python-3.12.16.tar.xz`: complete CPython, including
  `Modules/_dbmmodule.c` and configure/build inputs.
- `upstream/python-build-standalone-linux/`: the pinned `fa506e0…` recipe/patch
  archive, including `build-bdb.sh`, `build-cpython.sh` and `downloads.json`.
- Original platform `PYTHON.json`, retained notices, native/source hashes and
  exact XPI bindings in `bundle-manifest.json`.

No missing required DB/accompanying source was identified for these bytes. At
publication, provide this ZIP beside its bound XPIs without extra source charges,
and identify the source download in the release description as [NOTICE](../NOTICE.md)
requires. A filename or a generic `partial` flag is not the coverage check.

## ONNX Runtime: identified native-source gap

All six candidates ship **ORT 1.31.1**. Original PyPI wheel comparisons match
the shipped native/Python/notice bytes; same-platform bundled/local payloads are
identical. This dependency already existed in 0.3.7, not introduced by the Mac merge.

ORT's own MIT terms require the retained copyright/permission notice, not all native
sources in isolation. However, shipped BabelDOC's default `docvision/doclayout.py`
imports ORT in-process, creates a native `InferenceSession`, supplies a model and
tensor dictionary and calls `session.run()`. Under the current project/engine AGPLv3
section 1 assessment, this specifically-required dynamic dependency belongs in
Corresponding Source. An unmodified, generally available MIT library is not
automatically an independent tool outside this combined work. No applicable linking
exception or evidence of independent aggregation has been identified.

The ZIP covers the actual ORT Python wrappers, `LICENSE` and
`ThirdPartyNotices.txt`, but not ORT native C/C++ implementation, native interfaces
or the necessary build-control sources. **Treat that concrete gap as a release
blocker for the current six-package distribution.** This is an engineering delivery
decision for this integration, not a copyright infringement verdict or a claim that
MIT alone requires sources. A contrary combined-work interpretation would require
an applicable rights-holder exception or competent advice addressing this actual chain.

Minimum closure inputs:

1. A usable native-source snapshot corresponding to the shipped 1.31.1 wheels,
   with publisher/source identity evidence. The recorded Mac short revision
   `6af1a93` is a lead, not a verified full commit for all three wheels.
2. That source's applicable dependency pins, modifications and build/install
   scripts. Reuse existing matching source archives rather than collecting every
   optional provider or all notice-listed components.

Eigen's MPL source-availability requirement needs its actual version/patch scope;
the ZIP's other packages carry Eigen 5.0.1 and 3.3.7, which do not prove ORT coverage.
Notice mentions of GPL/LGPL in generic preambles or MPL secondary-license definitions
do not establish additional missing components. Mbed TLS explicitly selects Apache-2.0
in the shipped notice. Do not convert this into a guessed all-third-party source gate.

Preserve the original MIT/third-party notices. Add corresponding sources and required
inputs to the accompanying ZIP, or use a maintained free exact source-download location
with clear directions under AGPL section 6(d). A general repository/portal link, a
different ORT release, ONNX sources, a wheel, or changed readiness flags is not closure.
No compiler binary, full SBOM or bit-identical rebuild is demanded. Obtaining the source
is the smallest next action; changing ORT/Python requires a separate compatibility decision.

## Recheck after changing dependencies

1. Inspect all core/extension link and license declarations in
   `addon/licenses/supplemental/python-build-standalone/*-PYTHON.json` and the Mac
   `supplemental/macos/python-build-standalone/PYTHON.json`.
2. Match actual shipped native hashes with the verified publisher records in
   `source-manifest.json`; local mode retains dependency files under `python/`,
   so directory presence alone does not mean an interpreter is bundled.
3. Rehash complete source archives, source/license members and build recipes from
   the delivered ZIP, checking applicability to the selected XPI hashes.
4. Resolve a specifically identified missing required source/notice. Do not infer
   a violation solely from a missing compiler, an optional-link unknown or an
   unrelated notice copied into every package.

Use [source-delivery instructions](source-delivery-readiness.md) for ZIP generation
and verification. Source/doc changes require a new source snapshot; production
or notice changes also require rebuilding and rebinding the affected XPIs.
