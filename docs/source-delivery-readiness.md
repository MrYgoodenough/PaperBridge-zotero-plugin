<!-- Source and notice delivery bound to exact Linux/Windows artifacts. -->
# Linux/Windows corresponding-source delivery

For frozen **0.3.7** Linux/Windows bundled + local-Python packages, not a claim of
build/native/publication success. No macOS integration/replacement; preserve its
assets/channels and repository-wide Latest.

## Deliver the actual inputs

`addon/licenses/source-manifest.json` declares **303 pinned archives** and **four
Linux build inputs** for BabelDOC **0.6.4** / PyMuPDF **1.26.7**. Verify hashes,
sizes and required-member probes for the four XPIs; count alone is not coverage.

- Deliver project/dependency sources, modifications, interfaces, licenses and build
  inputs. Commit required project sources/tests/docs/workflows before freezing. Review
  `projectSnapshot`'s modified/missing and untracked membership; HEAD alone is not
  the delivered byte identity. Retain AGPL/GPL project/dependency licenses.
- Retain populated MuPDF/native/font source and notice trees. Linux OpenCV inputs:
  `CMakeCache.txt`,
  `opencv-native-gcc10.cmake`, `toolchain-provenance.json` and `opencv-build.json`.
  Match each `localBuildInputs` hash/size using originals or
  `addon/licenses/supplemental/build-inputs/linux-opencv/` copies.
- Ship `LICENSE`, `NOTICE.md`, all `addon/licenses/` and dependency notices/`.libs`.
  Match actual CPython/native/model/tokenizer hashes and source-tree/shipped notices,
  not names/versions alone.
- Berkeley DB **6.0.19 clause 3** requires access information for DB/accompanying
  software sources, including executable modules with its normal-OS-components exception.
  Retain CPython/standalone recipes, linked-library sources and modifications.
  Unused functionality is not an exemption; deliver full sources, not an unspecified offer.
- Provide applicable AGPL section 13 source access to users of a modified network
  service. Loopback/private operation does not automatically waive obligations.

### Existing Microsoft responsibilities

The user confirmed lawful Community 2026 use and section 8 responsibilities; do not
re-request. Retain application-related indemnity/defense/hold-harmless (including
attorneys' fees), except claims based solely on Distributable Code. Preserve original
DLLs/terms and DLL-only downstream/end-user terms at least as protective as Microsoft's
agreement, without restricting AGPL/other open-source code. End users need no Visual
Studio/purchased license for consent. EULAs/consent do not grant redistribution:
[Windows MSVC](windows-msvc-redistribution.md).

## Generate against the frozen four XPIs

Use project Python and four frozen XPIs in `FINAL`. These commands reuse the pinned
cache without downloads/provider requests.

Linux:

```sh
set -e
export FINAL=/absolute/path/to/frozen-four-package-directory
export OUT="$FINAL/paperbridge-0.3.7-linux-windows-source.zip"
.venv/bin/python -B scripts/package_sources.py \
  --cache agent/codex/licensing-p0-1-20261116-003659/source-cache \
  --xpi "$FINAL/paperbridge-0.3.7-linux-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.3.7-linux-x64-local-python.xpi" \
  --xpi "$FINAL/paperbridge-0.3.7-windows-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.3.7-windows-x64-local-python.xpi" --output "$OUT"
.venv/bin/python -B scripts/package_sources.py --verify "$OUT"
```

Windows PowerShell:

```powershell
$env:FINAL = (Resolve-Path 'dist/release-0.3.7').Path
$env:OUT = Join-Path $env:FINAL 'paperbridge-0.3.7-linux-windows-source.zip'
$py = '.\.venv\Scripts\python.exe'
$sourceArgs = @('-B', 'scripts/package_sources.py', '--cache',
  'agent/codex/licensing-p0-1-20261116-003659/source-cache')
foreach ($channel in @('linux-x64', 'linux-x64-local-python', 'windows-x64', 'windows-x64-local-python')) {
  $sourceArgs += @('--xpi', (Join-Path $env:FINAL "paperbridge-0.3.7-$channel.xpi"))
}
& $py @sourceArgs --output $env:OUT
if ($LASTEXITCODE -ne 0) { throw 'Source generation failed' }
& $py -B scripts/package_sources.py --verify $env:OUT
if ($LASTEXITCODE -ne 0) { throw 'Source verification failed' }
```

The source ZIP excludes XPIs. Only build.py's manifest `update_url`/JSON serialization
change is exempt from exact addon/backend membership and byte matching.

## Verify the complete handoff

`--verify` rehashes the internal index. Also check external sidecars/fresh XPI bytes
with project Python (Linux heredoc or PowerShell here-string to `& $py -B -`):

```python
"""Verify local sidecars and executable bytes."""
import hashlib, json, os, zipfile
from pathlib import Path

p = Path(os.environ['OUT'])
with zipfile.ZipFile(p) as z:
    m = json.loads(z.read('bundle-manifest.json'))
assert json.loads(Path(str(p) + '.manifest.json').read_bytes()) == m
with p.open('rb') as f:
    sha = hashlib.file_digest(f, 'sha256').hexdigest()
assert Path(str(p) + '.sha256').read_text().strip() == f'{sha}  {p.name}'
for x in m['xpis']:
    path = Path(os.environ['FINAL']) / x['name']
    with path.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == x['sha256']
    assert path.stat().st_size == x['bytes']
```

Check four platform/mode pairs, `fromCommitOnly`, **303** verified sources and
**four** retained Linux inputs. Require zero
`projectSourceSnapshotMismatches`/`deliveryFilesMissingOrChanged` and matching native
artifacts/source-tree/shipped notices. Fonts need byte-specific grant/modification/
reserved-name review, not filename/header-based permission.

`licenseCompliance=unknown` and partial/unready flags are **not legal clearance or
proof of missing obligations**. Resolve identified source/input/notice omissions.
Compiler options, optional Rust linkage/tiktoken locks, SBOM or bit-identical rebuild
evidence gaps are not extra gates by themselves.

Rebind after source/doc or XPI changes. With authorization, publish ZIP/manifest/
checksum beside exact XPIs at the same download location, without extra source
charges: [releasing](releasing.md). Use **`make_latest=false`**, preserving unrelated
assets/channels and Latest.
