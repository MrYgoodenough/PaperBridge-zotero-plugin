<!-- Independent public Zotero update feeds and publication order. -->
# Update channels

Linux x64 and Windows x64 each have separate bundled- and local-Python channels.
The four stable channels currently point to their exact **0.3.4** release assets.
Shared-source 0.3.5 candidates do not automatically replace these accepted feeds.
An empty `updates` array means **no published update**; it prevents a missing-feed
404 without advertising an unpublished installer.

Replace a channel with its verified `dist/updates/` draft only after the exact-tag
XPI and matching checksum are publicly available. Do not use repository-wide
`releases/latest` as a platform fallback. See [release verification](../docs/releasing.md).

The separately released macOS 0.4.2 implementation is not merged here; its assets
and update channels are not replaced by these files.
