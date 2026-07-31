# Benchmarks

The benchmark covers command execution, parsing, warm 1 MiB literal filtering,
and compressed artifact sizes. It checks JavaScript/WebAssembly output parity
before timing either implementation.

Release budgets:

- `shell.min.js`: at most 24 KiB gzip
- `shell.wasm`: at most 16 KiB raw and 8 KiB gzip
- no Wasm request for inputs below 256 KiB
- keep automatic Wasm use only while warm 1 MiB filtering is measurably faster

Run `npm run build && npm run benchmark` on the target browser/device before
changing the threshold. CI size gates are deterministic; timing is reported
instead of treated as a noisy shared-runner pass/fail signal.

Representative range on Node 26.5.0 / Apple Silicon (2026-07-31):

- simple pipeline: 80,000–82,000 operations/second
- parse/control pipeline: 63,000–66,000 operations/second
- 1 MiB literal filter: JavaScript 314–320, Wasm 1,050–1,080 operations/second
- warm Wasm improvement: 229–245%
- classic build: 29,048 bytes raw / 10,957 bytes gzip
- Wasm accelerator: 3,842 bytes raw / 1,945 bytes gzip
