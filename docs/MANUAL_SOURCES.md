# Manual sources

The generated manual packs are derived from upstream documentation and retain
their upstream terms. They are not relicensed under shell.js's MIT license.

FreeBSD pages come from `cgit.freebsd.org/src` at
`d9352700f9357aa170c1e4dc144537998ec66025` (14.2-RELEASE-p4). FreeBSD's source
tree contains multiple licenses; every generated index entry preserves the
page's path, digest, source URL, revision, and detected copyright/license
header.

Linux pages come from the official `man-pages.git` repository at
`66d786852379759d22c891d70ff9311d9f193fdc` (man-pages-6.18). Linux man-pages
uses several per-file licenses, including Linux-man-pages copyleft terms; the
same per-entry provenance and header data is preserved.

The manifest is intentionally an allowlist. FreeBSD's `share/man` is not its
whole command manual collection, and Linux `man-pages.git` primarily documents
kernel and C-library interfaces rather than a distribution's userland tools.
Add a page only with its exact upstream path, immutable revision, SHA-256
digest, and a successful `mandoc` render.

Each index preserves the source page's leading notice. The Linux pack also
ships the exact, checksum-verified upstream texts for every license used by
the included pages under `manuals/linux/LICENSES/`.
