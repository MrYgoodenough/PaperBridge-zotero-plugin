<!-- Candidate build and release policy while preserving frozen packages and platform channels. -->
# Three-platform packaging and release

Published baseline: Linux/Windows **freeze07 0.3.7**, **bundled** and **local-Python**
variants, plus the separate macOS **0.4.2** release. Their packages, tags and feeds
remain unchanged; do not compare version numbers across platforms or replace the
macOS assets/channels or repository-wide **Latest**.

`master` has absorbed PR #3's formula selection/hover copying and local JSON cache,
plus attachment-backed `TranslationReader` primary with one unsupported-interface
`TranslationAnnotations` fallback, never dual writes. Task recovery, sync markers,
reading assets and existing reading controls remain. This is **unpublished source**;
source metadata is **0.4.3 candidate**, not a published replacement. A candidate
build is not three-platform merged-package native/upgrade or paid formula-quality
acceptance. Formula conversion remains paired DeepSeek-only Key/URL,
fixed `deepseek-flash`, with native/cached results preferred.

Before authorizing a new release, align `addon/manifest.json`, `backend/server.py`'s
health version, `pyproject.toml` and the project's `uv.lock` entry to the approved
version; never rewrite the frozen v0.3.7 artifacts. Keep BabelDOC **0.6.4** /
PyMuPDF **1.26.7**; this source increment adds no dependencies or engine migration.

## Build on the target OS

Use the project's `.venv`. Remove interfering `PYTHONHOME`, `PYTHONPATH` or
native-library overrides; `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` avoids foreign test
plugins. Host Chinese fonts are required; machine font caches are not shipped.

Examples below build local candidates with the current 0.4.3 source metadata, not
published freeze07 replacements. Use the approved new identity before publication.

Linux:

```sh
set -e
sh scripts/setup.sh
.venv/bin/python -B scripts/stage_runtime.py
for mode in bundled local; do
  .venv/bin/python -B scripts/build.py --python "$mode" --output-dir dist/candidate-pr3
done
```

For actual macOS installation/backend and reader acceptance, run
`scripts/check_native_macos.sh` with `--bundled-xpi` and `--local-xpi` pointing at
those completed packages. It uses a private official Zotero installation and fresh
profiles, verifies native file installation, real health/build/mode, Microsoft-terms
exemption, cold restart and persisted native annotations. It blocks fee-bearing
requests and never kills a timed-out client; it does not certify translation semantics.

Windows PowerShell:

```powershell
& .\scripts\setup.ps1
$py = '.\.venv\Scripts\python.exe'
& $py -B scripts/stage_runtime.py
if ($LASTEXITCODE -ne 0) { throw 'Runtime staging failed' }
foreach ($mode in @('bundled', 'local')) {
  & $py -B scripts/build.py --python $mode --output-dir dist/candidate-pr3
  if ($LASTEXITCODE -ne 0) { throw 'Package build failed' }
}
```

macOS Apple Silicon:

```sh
set -e
sh scripts/setup.sh
sh scripts/build_opencv.sh
.venv/bin/python -B scripts/stage_runtime.py
for mode in bundled local; do
  .venv/bin/python -B scripts/build.py --python "$mode" --output-dir dist/candidate-pr3
done
```

Channels: `linux-x64`, `linux-x64-local-python`, `windows-x64`,
`windows-x64-local-python`, `macos-arm64`, `macos-arm64-local-python`.
Outputs: `paperbridge-0.4.3-<channel>.xpi`, its
`.sha256`/`.inventory.json`, and **local draft** `updates/<channel>.json`.
The `.sha256` and `.inventory.json` files stay local, not GitHub Release assets.
Local mode ships dependencies/assets but uses an installed Python 3.12 interpreter.

`--stage-dir PATH` selects a separate stage. `--platform` selects an existing
Linux/Windows/macOS stage with matching `runtime.json.platform`: **not
cross-compilation/native acceptance**. Preserve installers before reusing names;
budget disk space for both variants.

Manual `.github/workflows/release-candidate.yml` accepts `target_os=linux`, `windows`,
`macos` or `all` (the three supported native architectures). It checks native
dependencies and builds both modes, without provider requests or public release/feed
writes. Mac also runs the unchanged annotation create/cold-reopen suite in official
Zotero 10.0.8 with separate native receipts. These are controlled Gecko inputs, not
physical mouse/keyboard or translation-semantic acceptance. Save artifacts before expiry.
Optional `reuse_macos_run` restores a prior attempt-1 Mac bundled XPI's exact runtime
and original build inputs, then rebuilds current source/notices and repeats real native
checks. It does not substitute Linux repackaging for Mac execution; each receipt still
belongs to its finished XPI hash. Lightweight/source CI alone is not native acceptance.

## Verify completed bytes

Collect the selected platform/mode packages and drafts, then verify from the frozen source checkout:

```sh
set -e
for channel in linux-x64 linux-x64-local-python windows-x64 windows-x64-local-python macos-arm64 macos-arm64-local-python; do
  xpi="dist/candidate-pr3/paperbridge-0.4.3-$channel.xpi"
  .venv/bin/python -B scripts/verify_release.py \
    --xpi "$xpi" --sha256 "$xpi.sha256" \
    --feed "dist/candidate-pr3/updates/$channel.json" --report "$xpi.verification.json"
done
```

On Windows use `$py` with the same arguments. `--source-manifest PATH` overrides
the default `addon/manifest.json`. Checks cover version/ID, Zotero compatibility,
mode/channel, required files/interpreter, backend identity, archive paths and
XPI/checksum/feed hashes. Reports cannot overwrite explicit inputs.

- `LOCAL-CONSISTENT`: local artifacts agree; not legal/native approval.
- Without `--online`: `PUBLICATION-NOT-CHECKED`. With it:
  `PUBLISHED-METADATA-VERIFIED` or `PUBLICATION-NOT-VERIFIED`, using exact-tag
  asset digests/availability and public feed, not an XPI download/execution.
  A mismatch/404 is not permission to replace a valid channel just to pass.
- `AUTOMATIC-UPDATE-NOT-TESTED`: real Zotero update delivery is still separate.

Inventory records actual archive/compressed/expanded sizes, paths, source hashes,
dependency metadata and native/notice evidence. Expanded bytes are ZIP contents,
not disk allocation. `--previous-inventory PATH` gives same-platform/mode deltas;
growth/missing baselines only warn, with no size gate. Fixed ZIP metadata/compression
does not prove native reproducibility. Bind to **finished XPI SHA256**, not build ID.

## Acceptance and authorized publication

### Which work blocks a release?

- Exact source/version/package identity, required corresponding sources/notices and
  working installation/backend/reader persistence on each advertised platform are
  necessary. A successful build or an old package's receipt does not replace them.
- Automatic delivery must be checked before enabling that stable feed. It is not
  required for a clearly documented manual-install release. An old Mac package with
  a placeholder update URL needs one manual newer install to join the new channel;
  publishing a feed cannot rewrite an installed add-on's URL.
- Paid formula conversion quality and full-text semantic acceptance remain explicit
  limits until authorized and tested. Native/cache-first copying can be checked
  without provider calls; untested quality must not be advertised as accepted.
- Intel Mac, every long-term TODO, bit-identical native reproduction and generic
  `licenseCompliance=unknown` are not new gates for the currently supported scope.
  Specifically identified missing source/input/notice coverage remains actionable.
- Candidate builds/draft feeds are executable preparation. Public asset upload and
  stable-feed replacement require separate release authorization.

Existing freeze07 Linux/Windows create/reopen evidence remains scoped to those exact
packages and their earlier reader integration; controlled PDF.js selections are not
physical mouse/drag proof. It does not certify the new primary/fallback, formula cache,
three-platform merged packages or genuine old-to-new upgrades.

1. Freeze shipped source/notices/native inputs. Rebuild affected XPIs after changes;
   acceptance belongs to exact hashes, not filenames/version or earlier runs.
2. Use native AddonManager file installation/update with stopped-profile backups.
   Check active addon/XPI, backend health/marker, translation/layout, font extraction/search,
   reading/notes/annotations and normal-exit cold reopen with the same profile/data,
   new PID. Paid requests need authorization; fixtures/cache replay are not quality acceptance.
   Check Windows DLL consent/refusal; Linux must stay exempt.
   For this increment, distinguish attachment-backed primary from the single
   unsupported-interface fallback, check no dual writes, and exercise native/cache-first
   formula copying separately from explicitly authorized paid conversion quality.
3. Complete [corresponding-source delivery](source-delivery-readiness.md): the
   applicable pinned archives, platform-specific build inputs, modifications,
   native evidence and original notices for every selected platform/mode XPI.
   A Linux/Windows-only handoff does not cover the new macOS candidate.
   Keep user-confirmed Community 2026
   section 8 responsibilities/DLL-only consent. `licenseCompliance=unknown` is not
   legal clearance; resolve identified omissions, not speculative new obligations.
4. Only with release authorization, publish exact XPI and corresponding-source
   ZIP assets at the matching version tag, then enable only matching approved
   `master/updates/<channel>.json` drafts after the assets are reachable. Release
   creation/update must explicitly use **`make_latest=false`** (GitHub API field
   `"make_latest": "false"`). Preserve repository-wide Latest and all unrelated assets/feeds.
   Keep checksums, XPI inventories and the external source manifest local; the source
   ZIP already contains `bundle-manifest.json` and inventories. Preserve GitHub's
   automatic Source code archives; never wildcard-upload the whole output directory.
   Verify public XPI digests against feed hashes.
   Update the GitHub TODO issue with delivered scope and remaining limitations.
5. Run `--online`, then test `AddonManager.findUpdates`, installation and cold restart
   (`scripts/prepare_nonmac_test.py --suite update`). Use a genuinely newer version;
   same-version file installs are not automatic-update proof.

Never use `releases/latest/download` as a platform fallback. Placeholder update
URLs require a manual newer installation; publishing a feed cannot redirect them.
With authorization, `updates: []` pauses only the affected channel; it does not
downgrade installed clients. Fix forward with aligned versions and rebuilt artifacts.
