# Contributing

Open an issue before a large change. Keep pull requests focused, use
Conventional Commits, and include the smallest test or benchmark that would
catch a regression.

```sh
npm ci
npm run validate
npm run build
git diff --exit-code -- javascripts/shell.min.js wasm/shell.wasm
```

Do not add runtime dependencies, kernel-emulation claims, network access, or a
terminal framework without measurements and a concrete consumer. Manual
updates must preserve pinned revisions, digests, paths, and license headers.
Use `!` or a `BREAKING CHANGE:` footer when a public JavaScript API is not
backward-compatible; release-plz derives SemVer from those commits.
