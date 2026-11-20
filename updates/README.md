<!-- Independent public Zotero update feeds and publication order. -->
# Update channels

Linux x64 and Windows x64 each have separate bundled- and local-Python channels.
The four stable channels point to their verified **0.3.7** release assets.
Each channel keeps its platform and Python mode; the XPI download URL and SHA-256
must match the corresponding public release asset.

Replace a channel with its verified build-output draft only after the exact-tag
XPI is publicly available with a matching GitHub asset digest. Keep checksum files
local; do not upload independent `.sha256` assets. Do not use repository-wide
`releases/latest` as a platform fallback. See [release verification](../docs/releasing.md).

The macOS 0.4.2 source increment has been absorbed into the unpublished 0.4.3
candidate. Its existing assets/channels are not replaced by these files.
Candidate feeds stay under the build output directory until their exact packages
are accepted and public release is authorized; never enable a missing Mac asset.
