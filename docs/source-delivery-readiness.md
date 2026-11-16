<!-- Concrete source-delivery controls for frozen Linux/Windows candidates, not legal clearance. -->
# Linux/Windows corresponding-source delivery

This is the release-owner checklist for the **0.3.6 shared-source candidate**,
not legal clearance. Keep BabelDOC **0.6.4** and existing original licenses.
No macOS release or source integration is included.

## Established inputs and the identity boundary

- All **303** pinned upstream archives pass SHA256, size and required-member
  verification. The four pinned Linux OpenCV build inputs have matching staged
  copies as well as matching original local copies.
- The historical source ZIP in `dist/candidate-20261116-msvc` has SHA256
  `c8970aa12d824c2aea1270df57c25c3747347ce40a864102a996079eec5558ff`;
  its 24,408 indexed files and external manifest/checksum pass verification.
  Its project snapshot is commit `0082d6f874b61dd65a661ac2a0ab8047649142bf`.
  It accompanies **only its listed older XPI hashes**.
- The current four candidates include native-page protection and synced marker
  repairs. Their addon/backend modules match current source bytes; the frontend
  marker change does not change the v10 engine build identity. They still
  require a fresh source binding, not the historical ZIP or consent manifests.
  No specifically missing selected copyleft source/notice or standalone font
  blob was found in the bounded upstream review.

Current private candidate identities below reside in
`agent/codex/continuation-quality-20261116/candidates/native-regions-v10-sync-tags-20261116`.
These are not publication authorization; any further executable change requires
new hashes, native acceptance and corresponding-source binding.

| XPI | SHA256 |
| --- | --- |
| `paperbridge-0.3.6-linux-x64.xpi` | `79a22bcf94e4dd168d2a0de870aada044c5bdc0fa0f015c4f4ffc8d5c68e7083` |
| `paperbridge-0.3.6-linux-x64-local-python.xpi` | `144fb0b0899c34f0731294700994d39ecac316977f3664180d420a1f10757ad5` |
| `paperbridge-0.3.6-windows-x64.xpi` | `aed5e0cd062d326bf5b4293383efee36439c32f2a80aef637b7932c157b695f9` |
| `paperbridge-0.3.6-windows-x64-local-python.xpi` | `f1ce4fac806e8b1a17e44d114f685ccf76d12202d478881740ec231f28ff35c9` |

## Necessary closure, not an expanding audit

1. **Complete the actual modification/build inputs.** Deliver AGPL project
   sources and retained AGPL/GPL dependency sources, actual modifications,
   interfaces, licenses and build/install scripts. The generator includes
   Git-tracked `tests/` and developer `docs/`, keeping the delivered build checks
   and README-linked maintenance instructions available. Stage/commit
   all required new source/test files before freezing. `projectSnapshot` must
   not conceal required files in `excludedUntrackedSourceFiles`; a commit hash
   alone cannot identify changing working-tree bytes.
2. **Bind to the frozen executable.** After the release owner's final source fixes and
   package acceptance, generate a new source ZIP against the exact completed
   four XPIs. Require zero project-source mismatches, zero missing/changed
   delivery files, matched declared native artifacts and shipped notices, and
   all applicable pinned archives/build inputs. Any later source/XPI change
   requires rebinding. Preserve older delivery/consent records under their own
   identities; do not overwrite them with current or future hashes.
3. **Keep the Berkeley DB clause-3 delivery explicit.** The original **6.0.19**
   license requires information on obtaining DB and accompanying software
   sources; an executable's source includes all its modules, with the stated
   normal-OS-components exception. The Linux bundled interpreter selection
   includes DB, CPython and standalone build recipes/linked-library inputs.
   Keep these full sources and actual project modifications in the download,
   not just the DB source or an unused-functionality assertion. Current full
   source/recipe coverage has no specifically identified missing constituent;
   this is not a recovered static-link audit.
4. **Provide source access for the actual distribution/operation.** Publish the
   new ZIP, manifest and checksum beside the approved XPIs at the same download
   location, without an extra source charge, and retain license/build guidance.
   Full-source delivery is the chosen method, not an unspecified written offer.
   `backend/server.py` currently binds to loopback `127.0.0.1`; there is no remote
   hosted service delivery in this scope. Do not infer that loopback/private use
   waives AGPL section 13: supply the delivered source access to users, and if a
   modified service is operated for remote interacting users, expose its actual
   corresponding source to those users as well.

**Release gate:** require a committed project snapshot with all needed tests,
a freshly verified source ZIP/manifest/checksum bound to the exact four XPIs,
and approved source/executable assets available at the same download location.
Local generation alone is not public delivery. Native/product acceptance,
ordinary evidence limits and publication authorization remain separate scopes.

No additional specifically missing mandatory upstream source/notice was found
in this bounded review. Missing original compiler options, exact optional Rust
linkage, a tiktoken wheel lock, formal SBOM or byte-identical native rebuild are
**ordinary evidence limits**, not substitutes for a proven missing requirement.
Keep those limits visible; they do not warrant BabelDOC replacement, full static
reconstruction or renewed Microsoft distributor approval. New native inputs or
fonts require review of their actual source/notice/grant changes.

## Reproducible generation and verification

Run **only after source and all four completed XPIs are frozen**, from a Git
checkout containing that exact project snapshot. Do not generate while source
changes continue. `FINAL` must name the accepted package directory,
not an arbitrary historical directory. For a new version, update all names
below to its actual version; this checklist does not alter version contracts.

Linux:

```sh
FINAL=/absolute/path/to/frozen-four-package-directory
export FINAL
export OUT="$FINAL/paperbridge-0.3.6-linux-windows-source.zip"
.venv/bin/python -B scripts/package_sources.py \
  --cache agent/codex/licensing-p0-1-20261116-003659/source-cache \
  --xpi "$FINAL/paperbridge-0.3.6-linux-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.3.6-linux-x64-local-python.xpi" \
  --xpi "$FINAL/paperbridge-0.3.6-windows-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.3.6-windows-x64-local-python.xpi" \
  --output "$OUT"
.venv/bin/python -B scripts/package_sources.py --verify "$OUT"
```

Windows PowerShell, with the same prepared cache made available in the checkout
(no redownload is needed):

```powershell
$env:FINAL = 'E:\path\to\frozen-four-package-directory'
$env:OUT = Join-Path $env:FINAL 'paperbridge-0.3.6-linux-windows-source.zip'
$py = '.\.venv\Scripts\python.exe' # Use the project's working environment.
$sourceArgs = @('-B', 'scripts/package_sources.py', '--cache',
  'agent/codex/licensing-p0-1-20261116-003659/source-cache')
foreach ($name in @('linux-x64', 'linux-x64-local-python',
                    'windows-x64', 'windows-x64-local-python')) {
  $sourceArgs += @('--xpi', (Join-Path $env:FINAL "paperbridge-0.3.6-$name.xpi"))
}
& $py @sourceArgs --output $env:OUT
if ($LASTEXITCODE -ne 0) { throw 'Source generation failed' }
& $py -B scripts/package_sources.py --verify $env:OUT
if ($LASTEXITCODE -ne 0) { throw 'Source verification failed' }
```

After either generation, use the same project Python to execute this check
(Linux heredoc or PowerShell here-string piped to `& $py -B -`). It checks the
external sidecars and **fresh XPI identity**, not merely the ZIP's internal index:

```python
"""Verify the source handoff against frozen files, without publishing them."""
import hashlib
import json
import os
from pathlib import Path
import zipfile

# Environment paths must point to the frozen package set used in generation.
p = Path(os.environ['OUT'])
final = Path(os.environ['FINAL'])
with zipfile.ZipFile(p) as z:
    m = json.loads(z.read('bundle-manifest.json'))
    spec = json.loads(z.read('source-manifest.json'))
assert json.loads(Path(str(p) + '.manifest.json').read_text()) == m
with p.open('rb') as f:
    sha = hashlib.file_digest(f, 'sha256').hexdigest()
assert Path(str(p) + '.sha256').read_text().strip() == f'{sha}  {p.name}'
assert len(m['xpis']) == 4 and m['projectSnapshot']['fromCommitOnly']
assert {(x['runtime']['platform'], x['runtime']['pythonMode']) for x in m['xpis']} == {
    ('linux-x64', 'bundled'), ('linux-x64', 'local'),
    ('windows-x64', 'bundled'), ('windows-x64', 'local')}
assert len(m['sources']) == 303
assert all(s['verification']['status'] == 'verified' for s in m['sources'])
assert {b['path'] for b in m['buildInputs']} == {
    b['path'] for b in spec['localBuildInputs']}
assert 'project/tests/test_package_sources.py' in m['files']
assert 'project/docs/source-delivery-readiness.md' in m['files']
for x in m['xpis']:
    path = final / x['name']
    with path.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == x['sha256']
    assert path.stat().st_size == x['bytes']
    assert not x['projectSourceSnapshotMismatches']
    assert not x['deliveryFilesMissingOrChanged'] and not x['fonts']
    assert all(e['artifactStatus'] == 'matched' and e['sourceTreeNoticesMatch']
               and e['shippedNoticesMatch'] for e in x['nativeAttribution'])
print('Frozen file bindings passed; review declared blockers/obligations:')
print(json.dumps(m['blockers'], indent=2))
```

The generator intentionally leaves `licenseCompliance=unknown`,
`correspondingSourceStatus=partial`, and `publicReleaseReady=false`. Do not turn
them into legal approval or treat exit 0 as publication authorization. Resolve
any newly reported missing input/source/notice; document completion of the
standing delivery obligations separately. Follow `docs/releasing.md` for exact
asset publication before matching feeds, preserving macOS and other channels.
