<!-- Artifact-bound packaging, native acceptance, and independent update channel rules. -->
# Packaging and update channels

`scripts/build.py` is the packaging entry point. It produces an XPI, its
`.xpi.sha256` sidecar, and a **local draft** under `dist/updates/`.
`scripts/verify_release.py` inspects these explicit files; it never builds,
installs, uploads, changes versions or writes public feeds.

## Platform and source scope

Shared source is **0.3.3**. The independently released macOS 0.4.2 implementation
has not been merged, so do not rebuild or replace that release using this branch.
Linux/Windows acceptance does not certify macOS or translation semantics.
The lightweight three-platform CI checks shared-source contracts, not native
Zotero, complete runtime builds or the missing macOS implementation.

## Build an existing native stage

Normally stage and build on the target platform. `--platform` can select an
already existing `.cache/package/<platform>/` stage with matching
`runtime.json.platform`; it is repackaging, **not cross-compilation or native
execution**:

```sh
.venv/bin/python scripts/build.py --platform windows-x64 --python bundled
.venv/bin/python scripts/build.py --platform windows-x64 --python local
```

Use `.venv\Scripts\python.exe` on Windows. Keep old installers before rebuilding
same-version filenames. Any production addon/backend change requires rebuilding
the affected XPIs. A frontend-only change need not change the backend build ID,
so bind acceptance to the completed **XPI SHA-256**, not build ID alone.

## Inspect a completed artifact

Use the project interpreter and the actual target/version filenames:

```sh
.venv/bin/python scripts/verify_release.py \
  --xpi dist/paperbridge-0.3.3-linux-x64.xpi \
  --sha256 dist/paperbridge-0.3.3-linux-x64.xpi.sha256 \
  --feed dist/updates/linux-x64.json
```

Remove inherited `PYTHONHOME`, `PYTHONPATH`, and platform native-library overrides
for this process if needed. `--source-manifest PATH` optionally supplies the
expected addon manifest; otherwise it uses `addon/manifest.json`.

The checker compares versions, addon ID, Zotero compatibility, target/Python
mode, runtime identity, required files and completed-XPI hashes. It also rejects
mixed platforms and common private/unsafe archive entries. This is a practical
packaging audit, not exhaustive dependency/secret or native execution analysis.

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

## Publish without cross-platform mixups

1. Verify the package on its target OS and record the accepted scope. Human
   bilingual/layout review is separate; partial translation is not semantic acceptance.
2. Upload that exact XPI and its matching sidecar to the intended **version tag**.
   Preserve historical assets and do not advertise packages still under review.
3. Publish only its matching draft as `updates/<platform>[-local-python].json`
   on `master`, after both assets are publicly reachable. Do not bulk-copy feeds
   for unbuilt or unmerged platforms.
4. Run the public check and then test native Zotero update delivery separately.

For a non-macOS release, keep `make_latest=false`: the repository-wide latest
pointer must not replace the independent macOS release. Give an already installed
development build a distinct newer version so its real update path can be tested.
`scripts/prepare_nonmac_test.py --suite update` and `tests/update_packaged.js`
exercise `AddonManager.findUpdates`, its returned installer, and a cold process
restart with the same profile/data; a manually copied XPI is not automatic delivery.

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
