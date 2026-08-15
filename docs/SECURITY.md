# Security

Supported releases receive fixes on the latest major line. Report a
vulnerability privately with impact, reproduction steps, and affected
versions; do not open a public issue before a fix is available.

shell.js executes registered JavaScript handlers inside its host page. It is
not a security boundary for hostile handlers. The built-in engine does not use
`eval`, host processes, the host filesystem, or implicit network commands.
Applications must still enforce Content Security Policy, isolate untrusted
Wasm, cap custom command work, and treat rendered output as text.

Guest memory and file access are bounds-checked, syscall files are denied unless
explicitly granted, and unsupported calls fail closed. The instruction-subset
interpreters are defense in depth, not a browser security boundary; run hostile
guests in a dedicated Worker or sandboxed origin and keep network/model
credentials behind narrow host callbacks.

The ELF loader accepts only 64-bit little-endian ET_EXEC/ET_DYN images for
x86-64 and AArch64, validates every load range before mutating guest memory,
rejects entries outside executable segments, and validates a single PT_INTERP
before transferring control. Guest execution remains bounded by the CPU step
limit and a combined captured-output byte limit; asynchronous execution also
observes `AbortSignal` between configured instruction slices.

Guest memory is a bounded flat byte array, not an MMU. `mmap` allocations and
file copies are range-checked, but `mprotect` is a compatibility-only call and
does not enforce read/write/execute permissions. Do not treat it as W^X or
process isolation.

`createNetwork()` starts with an empty origin allowlist, rejects URL credentials,
makes Fetch omit cookies and reject redirects, and caps known request bodies,
streamed responses, and WebSocket messages. Browser WebSocket handshakes can
include ambient cookies, so use a dedicated cookieless origin. A host relay
remains a separate trusted service and must enforce its own destination policy.
Listener callbacks receive immutable event records retargeted to the bounded
wrapper, never the raw socket.

Model and language callbacks are trusted host code. Keep OpenAI, Anthropic, and
other long-lived provider credentials behind a same-origin backend; never put
them in shell environment variables, virtual files, command history, or browser
bundles. The backend must enforce its own authentication, model/endpoint
allowlist, cost/rate limits, logging policy, and request/response bounds.

`openBlockFS()` rejects images with an unexpected size, invalid geometry,
shared/cyclic block chains, or unreachable/cyclic directory entries. Failed
growth preserves existing file data. Its explicit `flush()` uses the browser
file handle's commit-on-close write path; applications must still handle
storage quota and flush failures.

JIT modules import only private register memory. Guest memory returns detached
byte/buffer snapshots, all write APIs advance code-page generations, and stale
compiled blocks fall back for recompilation.

`createV86()` accepts trusted third-party emulator code and untrusted guest
images; isolate both in a Worker or sandboxed origin. Its options can fetch
firmware, disks, and relay traffic, so applications must apply their own source
allowlist and verify artifacts before construction.
