<!-- Independent public Zotero update feeds and publication order. -->
# Update channels

Linux x64 and Windows x64 each have separate bundled- and local-Python channels.
The four stable channels point to their verified **0.3.7** release assets.
Each channel keeps its platform and Python mode; the XPI download URL and SHA-256
must match the corresponding public release asset.

Replace a channel with its verified build-output draft only after the exact-tag
XPI and matching checksum are publicly available. Do not use repository-wide
`releases/latest` as a platform fallback. See [release verification](../docs/releasing.md).

The separately released macOS 0.4.2 implementation is not merged here; its assets
and update channels are not replaced by these files.
