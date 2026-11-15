<!-- Candidate builds, package evidence, and independent update-channel rollout. -->
# Packaging and update channels

`scripts/build.py` is the packaging entry point. It produces an XPI, its
`.xpi.sha256` sidecar, `.xpi.inventory.json`, and a **local draft** under `dist/updates/`.
`scripts/verify_release.py` inspects these explicit files; it never builds,
installs, uploads, changes versions or writes public feeds.

## Platform and source scope

Shared source **0.3.6** is a **Linux/Windows candidate**, not a public stable
release. All four stable Linux/Windows channels remain **0.3.4**. The independently
released macOS 0.4.2 implementation has not been merged; no macOS build or release
replacement is included here. Target-OS acceptance is scoped to its exact XPI hash.
Prior 0.3.4 acceptance does not transfer to rebuilt 0.3.6 bytes. Offline/cache replay
of quality changes (including metadata source-vector protection) does not certify
semantics, provider compatibility, font extraction/search or native reading.
The lightweight three-platform CI checks shared-source contracts, not native
Zotero, complete runtime builds or the missing macOS implementation.

Keep `backend/server.py`'s public health version, `addon/manifest.json`,
`pyproject.toml` and the package entry in `uv.lock` consistent. The focused
`tests/test_bridge.py` version check guards this release contract.

## Build an existing native stage

Normally stage and build on the target platform. `--platform` can select an
already existing `.cache/package/<platform>/` stage with matching
`runtime.json.platform`; it is repackaging, **not cross-compilation or native
execution**:

For a real Linux candidate, use the existing setup and stage first (installed
Chinese fonts are required), then build both variants:

```sh
sh scripts/setup.sh
.venv/bin/python scripts/stage_runtime.py
.venv/bin/python scripts/build.py --python bundled
.venv/bin/python scripts/build.py --python local
```

Use `.venv\Scripts\python.exe` on Windows. Keep old installers before rebuilding
same-version filenames. Any production addon/backend change requires rebuilding
the affected XPIs. A frontend-only change need not change the backend build ID,
so bind acceptance to the completed **XPI SHA-256**, not build ID alone.

## Package inventory and license evidence

Every build reads the **finished XPI**, not stage size estimates. Its indented JSON
records actual archive bytes, compressed entry bytes, summed expanded bytes,
entry/file counts, all entry paths/sizes, and shipped addon/backend source hashes.
Expanded bytes are ZIP contents, not filesystem allocation after installation.
Runtime version/platform/Python mode, interpreter version, build ID and payload
hash remain separate from the final XPI hash.

Dependency versions come from packaged `.dist-info/METADATA`, with the runtime's
declared versions alongside them. License fields/classifiers, located notice files
and their hashes are evidence only; `RECORD` also associates module-local notices
with their distribution. Missing metadata/files, empty files and uncertain evidence
are `unknown` or advisory warnings. `addon/licenses/provenance.json` binds the
minimum notices to actual CPython/native/model/tokenizer hashes and upstream
evidence; see [NOTICE](../NOTICE.md) and [licensing.md](licensing.md). It does not
establish exhaustive static/vendored composition or corresponding-source delivery.
`licenseCompliance` stays **unknown**. Review remaining obligations before public
distribution; filenames or successful builds are not permission to ship.

Both build and verifier accept `--previous-inventory PATH`. A same-platform/mode
baseline yields byte/percentage deltas; growth, missing or mismatched baselines
only warn. There is no size gate or automatic dependency-pruning policy.

## Inspect a completed artifact

Use the project interpreter and the actual target/version filenames:

```sh
.venv/bin/python scripts/verify_release.py \
  --xpi dist/paperbridge-0.3.6-linux-x64.xpi \
  --sha256 dist/paperbridge-0.3.6-linux-x64.xpi.sha256 \
  --feed dist/updates/linux-x64.json \
  --report dist/paperbridge-0.3.6-linux-x64.xpi.verification.json
```

Remove inherited `PYTHONHOME`, `PYTHONPATH`, and platform native-library overrides
for this process if needed. `--source-manifest PATH` optionally supplies the
expected addon manifest; otherwise it uses `addon/manifest.json`.

The checker compares versions, addon ID, Zotero compatibility, target/Python
mode, runtime identity, required files and completed-XPI hashes. It also rejects
mixed platforms and common private/unsafe archive entries. This is a practical
packaging audit, not exhaustive dependency/secret or native execution analysis.
Required production files include `notes.js`, `diagnostics.js`, `provider_check.py`
and the backend trace module. `--report` writes the recomputed inventory and separate
local/publication/automatic-update statuses; it cannot overwrite explicit inputs.

| Result | Meaning |
| --- | --- |
| `LOCAL-CONSISTENT` | Selected XPI, checksum and draft agree. |
| `PUBLICATION-NOT-CHECKED` | Public assets/feed were not inspected. |
| `PUBLISHED-METADATA-VERIFIED` | With `--online`, public feed, exact-tag asset metadata/download and sidecar agree. |
| `PUBLICATION-NOT-VERIFIED` | The public resource is absent or differs from this draft; do not overwrite a valid channel just to make the check pass. |
| `AUTOMATIC-UPDATE-NOT-TESTED` | Native Zotero delivery/install remains a separate check. |

`--online` is read-only. It uses GitHub asset digests and does not download or
execute the large XPI. Error messages distinguish missing feeds, releases, XPIs
and checksums without echoing signed redirects or response bodies.

## Manual real candidate workflow

`.github/workflows/release-candidate.yml` has **workflow_dispatch only**. Once the
workflow is available on the default branch, select the candidate source ref in
Actions → Release candidate → Run workflow. `target_os` is `linux` by default;
`windows` is a later explicit choice, and `all` means Linux + Windows, **never macOS**.
This round runs Linux only. Merely adding this workflow is not evidence of a run.

Ubuntu 24.04 / Windows 2022 native runners reuse setup.sh/setup.ps1 with a locked
environment and actual BabelDOC **0.6.4** / PyMuPDF **1.26.7**. Setup downloads the
real model/tokenizer; Linux installs Noto CJK, Windows obtains a pinned free Noto
font as an ephemeral runner prerequisite. Font caches are not shipped. The job
runs full offline contracts, stages real dependencies, checks the isolated staged
interpreter's native imports/model load/tokenizer, then builds and verifies both
XPIs. No provider requests, release upload or public-feed write is included.
Runner checks are not Zotero installation, translation or native reading acceptance.

Each variant artifact contains the actual XPI, checksum, inventory, verification
report, local draft and `candidate-stage.json`. Uploads use compression level 0
for already-compressed XPIs, three-day retention and no whole stage/cache upload.
Save accepted packages before expiry. The existing lightweight three-platform CI
is unchanged; its small synthetic-package tests are not these real builds.

Each XPI is hundreds of MiB; budget for **both** variants. The upload action's
500-artifacts/job limit is not approached (two here), but shared storage quota is
external and has not been checked. Before dispatch, free older candidate artifacts
or arrange approved capacity. The locked TUNA registry, model/tokenizer hosts and
runner font downloads must be reachable. If setup/upload fails, retain the failure,
fix availability/capacity and rerun the selected OS; do not substitute fixtures or
claim a summary-only artifact contains a saved real package.

## Candidate group, unpublished feed gate and forward fixes

1. Share exact candidate XPIs/checksums with a small **Linux** test group first.
   Use stopped-profile backups and native file installation in isolated profiles;
   record version, completed-XPI hash, engine health/marker and a normal-exit cold
   reopen. Font extraction/search and bilingual/layout review remain explicit checks.
2. Keep generated `dist/updates/` **unpublished** and run the local verifier for
   each accepted variant. Review channel/mode/version/hash against the test group's
   exact package. This is an executable draft-feed gate, **not private automatic
   delivery**: production XPIs still request `master/updates/`, and the current
   native update helper checks those exact public URLs, not a private-feed override.
   Do not redirect daily profiles or borrow historical update evidence to claim
   this unpublished candidate was automatically delivered.
3. Only after target-OS approval, upload the exact XPI and sidecar to its **version
   tag**, then enable only its matching public feed after assets are reachable.
   For any target-only release, preserve every other platform/mode channel and macOS assets.
   Run `--online` and then native Zotero update delivery as separate checks.
4. If a problem emerges, stop direct distribution and, with release approval,
   pause only the affected channel using `updates: []`. Keep evidence and historical
   installers; this stops new offers but does **not** downgrade installed clients.
5. Fix the source, increment all version-contract locations, rebuild/verify the
   affected target and repeat the small-group gate before **rolling forward**.
   An old package or old feed is **not automatic downgrade rollback**. Any manual
   recovery/backup restoration is a separate deliberate, validated operation.

## Publish without cross-platform mixups

Publish only the approved draft as `updates/<platform>[-local-python].json` on
`master`, after its exact assets are public. Never bulk-copy drafts for unbuilt or
unmerged platforms. Preserve historical assets and record each accepted scope;
partial translation is not semantic acceptance.

For a non-macOS release, keep `make_latest=false`: the repository-wide latest
pointer must not replace the independent macOS release. Give an already installed
development build a distinct newer version so its real update path can be tested.
`scripts/prepare_nonmac_test.py --suite update` and `tests/update_packaged.js`
exercise `AddonManager.findUpdates`, its returned installer, and a cold process
restart with the same profile/data; a manually copied XPI is not automatic delivery.

For daily profiles, retain a stopped-profile backup and use Zotero's native
**Install Add-on From File** or native update installer. File replacement alone
does not prove which version AddonManager loaded. Verify the active native addon,
installed XPI hash and lazy engine's health/installed marker; do not erase addon
metadata, preferences or NSS credentials to force a successful result.

Never use `releases/latest/download` as a platform fallback: `latest` is
repository-wide, and a newer macOS-only release does not contain Windows/Linux
assets. Same-name historical local packages may differ from published XPIs;
verify the **public** hash and compatibility rather than borrowing local results.

## Why a feed can return 404

The build writes `dist/updates/`, but installed XPIs request
`master/updates/<platform>[-local-python].json` from the public repository.
Building or syncing source alone cannot publish those files or release assets.

Before an installer is approved and published, a channel may contain `updates: []`.
This is a valid **no-update** response, not a released package or automatic-delivery
result. The four Linux/Windows channels are independent by Python mode; enable
only the exact matching draft after its version-tagged assets are public.

macOS channels and the 0.4.2 asset are not replaced here. Old installations whose
manifest used `example.invalid` need a manual newer installation once; creating
the public directory cannot redirect an already-installed placeholder URL.
