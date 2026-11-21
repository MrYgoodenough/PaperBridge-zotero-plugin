<!-- Source and notice delivery bound to exact platform/mode artifacts. -->
# Corresponding-source delivery

Prepare **unpublished 0.4.3** Linux x64 / Windows x64 / macOS arm64 candidates,
each in bundled and local-Python modes. Deliver only the platforms/modes actually
bound to the ZIP; a four-package Linux/Windows handoff cannot certify macOS.
This is not native acceptance or publication authorization. Preserve frozen
**0.3.7**, independent macOS **0.4.2**, their assets/channels and repository Latest;
do not regenerate their historical source ZIPs from current working-tree sources.

## Deliver the actual inputs

`addon/licenses/source-manifest.json` declares pinned archives and platform-specific
native/build evidence for BabelDOC **0.6.4** / PyMuPDF **1.26.7**. The frozen
Linux/Windows baseline used 303 archives and four Linux inputs. New macOS scope
must follow its actual distributions, interpreter and OpenCV build, not a blanket
platform addition. Verify hashes, sizes and required-member probes for every
selected XPI; count alone is not coverage.

- Deliver project/dependency sources, modifications, interfaces, licenses and build
  inputs. Commit required project sources/tests/docs/workflows before freezing. Review
  `projectSnapshot`'s modified/missing and untracked membership; HEAD alone is not
  the delivered byte identity. Retain AGPL/GPL project/dependency licenses.
- Retain populated MuPDF/native/font source and notice trees. Linux OpenCV inputs:
  `CMakeCache.txt`,
  `opencv-native-gcc10.cmake`, `toolchain-provenance.json` and `opencv-build.json`.
  Match each `localBuildInputs` hash/size using originals or
  `addon/licenses/supplemental/build-inputs/linux-opencv/` copies.
- For macOS, retain the original standalone CPython metadata/notices and exact
  source recipes, plus actual image-only OpenCV configuration/build evidence.
  Match sanitized/signed shipped native hashes separately from original build outputs.
- Ship `LICENSE`, `NOTICE.md`, all `addon/licenses/` and dependency notices/`.libs`.
  Match actual CPython/native/model/tokenizer hashes and source-tree/shipped notices,
  not names/versions alone.
- Berkeley DB **6.0.19 clause 3** requires access information for DB/accompanying
  software sources, including executable modules with its normal-OS-components exception.
  Retain CPython/standalone recipes, linked-library sources and modifications.
  Unused functionality is not an exemption; deliver full sources, not an unspecified offer.
  The current Linux bundled `_dbm` source scope is covered; original build metadata
  identifies no distributed DB interpreter component in the other five candidates.
  Recheck actual declarations/bytes on dependency changes:
  [dependency source scope](dependency-source-scope.md).
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

## Generate against completed candidate XPIs

Freeze committed source/notices first, rebuild affected XPIs, then use project
Python and the completed candidates in `FINAL`. Populate `CACHE` with verified
archives (existing Linux/Windows cache can be reused). The six-package commands
below need actual macOS packages and matching evidence; do not substitute an old
macOS release. They do not download archives or make provider requests.

Linux:

```sh
set -e
export FINAL=/absolute/path/to/completed-candidate-directory
export CACHE=/absolute/path/to/verified-source-cache
export OUT="$FINAL/paperbridge-0.4.3-corresponding-sources.zip"
.venv/bin/python -B scripts/package_sources.py \
  --cache "$CACHE" \
  --xpi "$FINAL/paperbridge-0.4.3-linux-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.4.3-linux-x64-local-python.xpi" \
  --xpi "$FINAL/paperbridge-0.4.3-windows-x64.xpi" \
  --xpi "$FINAL/paperbridge-0.4.3-windows-x64-local-python.xpi" \
  --xpi "$FINAL/paperbridge-0.4.3-macos-arm64.xpi" \
  --xpi "$FINAL/paperbridge-0.4.3-macos-arm64-local-python.xpi" --output "$OUT"
.venv/bin/python -B scripts/package_sources.py --verify "$OUT"
```

Windows PowerShell:

```powershell
$env:FINAL = (Resolve-Path 'dist/candidate-0.4.3').Path
$env:CACHE = 'C:\absolute\path\to\verified-source-cache'
$env:OUT = Join-Path $env:FINAL 'paperbridge-0.4.3-corresponding-sources.zip'
$py = '.\.venv\Scripts\python.exe'
$sourceArgs = @('-B', 'scripts/package_sources.py', '--cache', $env:CACHE)
foreach ($channel in @('linux-x64', 'linux-x64-local-python', 'windows-x64',
                       'windows-x64-local-python', 'macos-arm64', 'macos-arm64-local-python')) {
  $sourceArgs += @('--xpi', (Join-Path $env:FINAL "paperbridge-0.4.3-$channel.xpi"))
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

Check all **six** selected platform/mode pairs and `fromCommitOnly`. The current
three-platform manifest binds **319** verified sources and **15** retained build
inputs; the original Linux/Windows 303 archives keep their identities. Require zero
`projectSourceSnapshotMismatches`/`deliveryFilesMissingOrChanged` and matching native
artifacts/source-tree/shipped notices. Fonts need byte-specific grant/modification/
reserved-name review, not filename/header-based permission.

`licenseCompliance=unknown` and partial/unready flags are **not legal clearance or
proof of missing obligations**. Resolve identified source/input/notice omissions.
Compiler options, optional Rust linkage/tiktoken locks, SBOM or bit-identical rebuild
evidence gaps are not extra gates by themselves.

The [current component assessment](dependency-source-scope.md) closes the identified
Linux bundled DB/accompanying source scope. It identifies a specific ORT 1.31.1
native-source/build-input gap under the actual in-process AGPL integration; that
gap must be closed before publishing the current six-package distribution. Verified
archive/file integrity does not close an archive that is absent from the delivery.

Rebind after source/doc or XPI changes. With authorization, publish the source ZIP
beside exact XPIs at the same download location, without extra source
charges: [releasing](releasing.md). Use **`make_latest=false`**, preserving unrelated
assets/channels and Latest.
Keep generated `.sha256`, XPI inventories and the external `.manifest.json` local.
The ZIP retains `bundle-manifest.json` and all selected XPI inventories; public integrity
uses GitHub asset digests and the internal manifest, not standalone sidecars.
