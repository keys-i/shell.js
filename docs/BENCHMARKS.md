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

`npm run browser` reports cold-load, navigation, and warm-command timings in
Chromium, Firefox, and a 4× CPU-throttled mobile Chromium profile. Its
correctness assertions gate CI; shared-runner timings remain informational.

`npm run benchmark` also reports seven-sample median/range timings for equivalent
200,000-iteration decrement/branch loops in x86-64 and AArch64 with the
interpreter and hot-block JIT. These subset microbenchmarks are not full-system
or competitor claims.

Node 26.7.0 on Apple Silicon (2026-08-13), after hot backward branches were
linked inside generated Wasm:

- simple command: 80,219 operations/second
- parse/control pipeline: 64,874 operations/second
- 1 MiB literal filter: JavaScript 284, Wasm 964 operations/second (239.7% faster)
- x86-64: 50.02 ms (49.74–63.06) interpreter vs 0.65 ms (0.62–1.47) JIT (76.59×)
- AArch64: 53.59 ms (52.93–62.39) interpreter vs 0.63 ms (0.61–1.07) JIT (84.84×)
- classic build: 71,745 bytes raw / 23,543 bytes gzip

Representative range on Node 26.5.0 / Apple Silicon (2026-07-31):

- simple pipeline: 80,000–82,000 operations/second
- parse/control pipeline: 63,000–66,000 operations/second
- 1 MiB literal filter: JavaScript 314–320, Wasm 1,050–1,080 operations/second
- warm Wasm improvement: 229–245%
- classic build: 29,048 bytes raw / 10,957 bytes gzip
- Wasm accelerator: 3,842 bytes raw / 1,945 bytes gzip
