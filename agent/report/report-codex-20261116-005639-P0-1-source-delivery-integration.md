<!-- Bounded licensing/source-delivery changes, verified evidence and final-generation handoff. -->
# P0-1 licensing and source-delivery integration

## Result and handoff

**NOTICE.md and addon/licenses/** shipping bytes are stable and frozen. Main
may rebuild the four candidates using the unchanged native stages now. No more
shipping-license edits are planned. This completes the bounded integration,
not licensing clearance or final rebuilt-package acceptance.

Scope stayed within NOTICE.md, docs/licensing.md, addon/licenses/source-manifest.json,
addon/licenses/supplemental/, scripts/package_sources.py and new task/report files.
No MEMORY, roadmap, repository tests, account/build/feed scripts, dependencies,
engine, macOS package, profile, paid request, upload, push or release was changed.
P1-3/P1-4/P1-5 account/upgrade/UI work remains with main and the Windows agent.

## Changes

- Generator now checks root LICENSE/NOTICE and **all** addon license files.
  Previously its delivery comparison only covered NOTICE, source-manifest and
  supplemental files, missing changes/removal of older notices such as tiktoken/MIT.txt.
- Generator carries `evidenceLimits` separately from actual delivery/permission
  blockers. Original compiler/bit-identical-wheel uncertainty is not made into
  a mandatory legal gate. Source archives/indexed members retain byte verification.
- Official crossbeam-deque 0.8.7 archive and crates index agree with locked SHA256
  `5181e0de7b61eb03a81e347d6dd8797bae9da5146707b51077e2d71a54ec0ceb`.
  Both upstream license alternatives were retained. All **243** prior registry
  lockfile candidates now have matching source archives; none remains unretained.
- Only three additional tiktoken-declared dependency source/notice candidates
  were added: fancy-regex 0.19.0 and bstr 1.13.1 are declared minima; rustc-hash
  2.1.3 is a public 2.x candidate available before the tagged wheel build.
  These are **not** a recovered original-wheel graph or confirmed linked versions.
  No runtime dependency or Cargo.lock was modified/generated.
- PyPI cp312 Linux/Windows tiktoken 0.14.0 native modules exactly match the
  existing native evidence. Original wheel MIT licenses remain identified
  separately, including their platform newline/hash differences. Public tag,
  sdist and wheels have no build lock/third-party graph. Tagged build workflow
  was retained; unauthenticated build-log download returned HTTP 403, and both
  PyPI provenance endpoints returned HTTP 404. No credentials were requested.
- Original Microsoft Runtime 2015–2022 and VS2022 Community license DOCX files
  and official VS2022 REDIST HTML were retained byte-for-byte with URLs/hashes.
  Documentation explicitly distinguishes install/use permission from the
  conditional Visual Studio redistribution grant; no grant was invented.
- Project is explicitly AGPLv3. Full-source delivery alongside executables is
  the chosen method, **not a written offer**. BabelDOC 0.6.4/PyMuPDF 1.26.7 and
  independent macOS 0.4.2 were untouched.

The suspected missing build entry was checked and disproved: build.py resides
in tracked scripts/ and was already included. No unnecessary fix was added.

## Executed verification

All Python execution used `/home/scq/PaperBridge-zotero-plugin/.venv/bin/python -B`.
No new repository test suite was added.

| Check | Actual result |
| --- | --- |
| Offline generation, pinned archive/probe verification | 303 archives; reused 299 existing archives without redownload, plus four small new crates |
| Full bundle `--verify` | 23,936 indexed member hashes/sizes verified |
| Native artifact/retained notice bindings | 26 source-manifest entries checked; zero attribution mismatches across the four old XPIs |
| Retained origin hashes | 83 files checked |
| Source-member/original-notice comparison | 44 source-linked originals compared, allowing unchanged originals or documented newline normalization |
| Standalone notice originals | Prior full-build hashes reused; retained hashes checked, no repeat full interpreter audit/download |
| Original Microsoft documents | Three retained originals byte/hash/size matched |
| Corrupt source/indexed-member tests | Rejected as expected |
| Formerly unchecked legacy notice test | Changed tiktoken/MIT.txt and missing root LICENSE reported |
| Project membership | Build, stage, inventory and new source-generator scripts present |
| Syntax/comments and whitespace | Script syntax/module-function docstrings checked; scoped git diff --check passed |
| Baseline/final separation | Four dist hashes match prior provisional evidence; no final rebuilt hashes borrowed |

The notice-origin test initially assumed every existing original had one final
newline. Its expectation was corrected to also accept unchanged original bytes;
no shipped notice wording was altered to make the test pass.

## Provisional artifact — old hashes only

Task directory:
`/home/scq/PaperBridge-zotero-plugin/agent/codex/licensing-p0-1-20261116-003659/`

ZIP: `paperbridge-0.3.6-linux-windows-source-provisional.zip`

- Bytes: **884,779,019**
- SHA256: `eac627e997c43632e1bcbf9f4534c56792c3eaef20ed4eec8fd5bfcccf7d6e3f`
- Internal bundle manifest equals external `.manifest.json`; `.sha256` matches
  the actual ZIP. Current licensing docs, script, NOTICE and source-manifest
  match its indexed project snapshot.
- `licenseCompliance=unknown`, `correspondingSourceStatus=partial`,
  `publicReleaseReady=false` remain explicit.
- Each old XPI has **110 delivery files missing/changed**, plus a changed NOTICE
  source snapshot. These are packaging deltas, **not 110 proven legal violations**.
- No missing pinned copyleft-package source was reported; no standalone shipped
  font blobs were detected. This does not prove all native/static/font boundaries.

Evidence files: `preflight-tests.json`, `bounded-tests.json`, `generation.json`,
`verification.json`, `assembly-summary.json`, public-probe JSON and
`addon/licenses/supplemental/public-source-evidence.json`.

## Remaining real obligations and decisions

1. **Microsoft redistribution basis:** confirm an applicable distributor license
   and exact unmodified release-file basis for VCRuntime 14.44.35211.0 and
   hyperscan-private MSVCP140 14.40.33810.0. The Runtime EULA grants installation/use
   and prohibits distribution to others. VS2022 terms/REDIST provide a conditional
   alternative for appropriately licensed users and listed unmodified files.
   Public family terms do not prove this distributor's rights for the exact hashes.
   No Microsoft runtime source requirement, license acceptance or replacement
   was inferred/performed. Main/user must decide the applicable distribution basis.
2. **Final delivery integration:** stage intended source membership, rebuild four
   XPIs, regenerate against those exact bytes, inspect license/native bindings and
   deliver the full source ZIP/manifest/checksum alongside them. Preserve AGPL/GPL
   required modifications/build inputs and Berkeley DB clause-3 accompanying
   executable-module sources; provide any applicable AGPL section-13 source access.
3. **Evidence limits, not established violations:** tiktoken's exact transitive
   original-wheel versions and some original compiler/static/font composition
   remain unconfirmed. Known project/MIT notices and candidate material are retained.
   Missing a lock or inability to bit-reproduce a wheel alone proves neither a
   missing mandatory notice nor a license breach. Any newly identified specific
   missing required source/notice must still be resolved. Same-version controlled
   rebuild/dependency/deployment changes require a user decision; none was done.

## Exact final generation command and cache

Complete offline cache:
`/home/scq/PaperBridge-zotero-plugin/agent/codex/licensing-p0-1-20261116-003659/source-cache`

The 299 original cache files were hardlinked into the task-owned cache, not
redownloaded/reassembled. Read them; do not modify those shared archive bytes.
The cache also contains the four new archives. No `--download` is needed for
the unchanged Linux/Windows native baseline.

Set **only CANDIDATE_DIR** to main's actual separate completed four-XPI output
directory. Do not point it to the old dist baseline. Then run:

```bash
CANDIDATE_DIR='/absolute/path/to/main-completed-four-candidate-output'
/home/scq/PaperBridge-zotero-plugin/.venv/bin/python -B \
  /home/scq/PaperBridge-zotero-plugin/scripts/package_sources.py \
  --cache /home/scq/PaperBridge-zotero-plugin/agent/codex/licensing-p0-1-20261116-003659/source-cache \
  --xpi "$CANDIDATE_DIR/paperbridge-0.3.6-linux-x64.xpi" \
  --xpi "$CANDIDATE_DIR/paperbridge-0.3.6-linux-x64-local-python.xpi" \
  --xpi "$CANDIDATE_DIR/paperbridge-0.3.6-windows-x64.xpi" \
  --xpi "$CANDIDATE_DIR/paperbridge-0.3.6-windows-x64-local-python.xpi" \
  --output "$CANDIDATE_DIR/paperbridge-0.3.6-linux-windows-source.zip"
/home/scq/PaperBridge-zotero-plugin/.venv/bin/python -B \
  /home/scq/PaperBridge-zotero-plugin/scripts/package_sources.py \
  --verify "$CANDIDATE_DIR/paperbridge-0.3.6-linux-windows-source.zip"
```

This emits ZIP, `.manifest.json` and `.sha256`; examine `projectSnapshot`,
`blockers`, `evidenceLimits`, each `deliveryFilesMissingOrChanged` list and native
attribution. Staging intended untracked main-owned source before generation
avoids its exclusion by the deliberate tracked allowlist. The provisional
snapshot currently excludes untracked scripts/prepare_account_sync.py.

No waiting for final binaries, further old-binary regeneration or legal-complete
claim is required from this task. Main owns final assembly and memory integration.
