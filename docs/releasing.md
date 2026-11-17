<!-- Build, verify and publish exact Linux/Windows artifacts without changing unrelated channels. -->
# Linux/Windows packaging and release

Target **0.3.7**: Linux/Windows **bundled** and **local-Python** variants. This guide
does not assert completed builds, native tests or publication. No macOS integration,
build or replacement: preserve its assets/channels and repository-wide **Latest**.

Before building, align `addon/manifest.json`, `backend/server.py`'s health version,
`pyproject.toml` and the project's `uv.lock` entry. Keep BabelDOC **0.6.4** /
PyMuPDF **1.26.7**; no engine migration.

## Build on the target OS

Use the project's `.venv`. Remove interfering `PYTHONHOME`, `PYTHONPATH` or
native-library overrides; `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` avoids foreign test
plugins. Host Chinese fonts are required; machine font caches are not shipped.

Linux:

```sh
set -e
sh scripts/setup.sh
.venv/bin/python -B scripts/stage_runtime.py
for mode in bundled local; do
  .venv/bin/python -B scripts/build.py --python "$mode" --output-dir dist/release-0.3.7
done
```

Windows PowerShell:

```powershell
& .\scripts\setup.ps1
$py = '.\.venv\Scripts\python.exe'
& $py -B scripts/stage_runtime.py
if ($LASTEXITCODE -ne 0) { throw 'Runtime staging failed' }
foreach ($mode in @('bundled', 'local')) {
  & $py -B scripts/build.py --python $mode --output-dir dist/release-0.3.7
  if ($LASTEXITCODE -ne 0) { throw 'Package build failed' }
}
```

Channels: `linux-x64`, `linux-x64-local-python`, `windows-x64`,
`windows-x64-local-python`. Outputs: `paperbridge-0.3.7-<channel>.xpi`, its
`.sha256`/`.inventory.json`, and **local draft** `updates/<channel>.json`.
The `.sha256` and `.inventory.json` files stay local, not GitHub Release assets.
Local mode ships dependencies/assets but uses an installed Python 3.12 interpreter.

`--stage-dir PATH` selects a separate stage. `--platform` selects an existing
Linux/Windows stage with matching `runtime.json.platform`: **not
cross-compilation/native acceptance**. Preserve installers before reusing names;
budget disk space for both variants.

Manual `.github/workflows/release-candidate.yml` accepts `target_os=linux`, `windows`
or `all` (Linux + Windows only). It checks native dependencies/builds both modes,
without provider requests or public release/feed writes. Save artifacts before
expiry; runner checks/lightweight CI do not certify native Zotero or translation.

## Verify completed bytes

Collect all four packages/drafts together and verify from the frozen source checkout:

```sh
set -e
for channel in linux-x64 linux-x64-local-python windows-x64 windows-x64-local-python; do
  xpi="dist/release-0.3.7/paperbridge-0.3.7-$channel.xpi"
  .venv/bin/python -B scripts/verify_release.py \
    --xpi "$xpi" --sha256 "$xpi.sha256" \
    --feed "dist/release-0.3.7/updates/$channel.json" --report "$xpi.verification.json"
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

1. Freeze shipped source/notices/native inputs. Rebuild affected XPIs after changes;
   acceptance belongs to exact hashes, not filenames/version or earlier runs.
2. Use native AddonManager file installation/update with stopped-profile backups.
   Check active addon/XPI, backend health/marker, translation/layout, font extraction/search,
   reading/notes/annotations and normal-exit cold reopen with the same profile/data,
   new PID. Paid requests need authorization; fixtures/cache replay are not quality acceptance.
   Check Windows DLL consent/refusal; Linux must stay exempt.
3. Complete [corresponding-source delivery](source-delivery-readiness.md): the
   **303 archives**, **four Linux build inputs**, modifications, native evidence and
   original notices for the exact four XPIs. Keep user-confirmed Community 2026
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
