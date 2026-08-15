# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- add a verified standalone Krad WebAssembly command
- run bounded Linux ELF64 guests with generated-Wasm x86-64/AArch64 hot blocks and separately composable Linux/FreeBSD syscall subsets
- load ET_EXEC/ET_DYN images, resolve PT_INTERP, and support cancellable cooperative execution
- persist the block filesystem through explicit OPFS flushes and expose an allowlisted browser network capability
- run unmodified 32-bit x86 PC images through an optional injected v86 backend

## [0.3.0](https://github.com/keys-i/shell.js/compare/v0.2.0...v0.3.0) - 2026-08-01

### Added

- add real browser conformance

### Fixed

- cancel teardown probe navigation
- retry firefox document handoff
- bound cold browser startup

## [0.2.0](https://github.com/keys-i/shell.js/compare/v0.1.0...v0.2.0) - 2026-08-01

### Added

- expand pinned manual packs
- improve directory compatibility

### Other

- protect release artifacts

## [0.1.0](https://github.com/keys-i/shell.js/releases/tag/v0.1.0) - 2026-07-31

### Added

- add the Hatch Koala shell engine

### Fixed

- make completion scans linear

### Other

- add checks security and releases
- bootstrap shell.js
# Changelog

Release-plz maintains this file from Conventional Commits.
