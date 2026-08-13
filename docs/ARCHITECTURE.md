# Architecture

`createShell()` owns parsing, environment state, command dispatch, limits, and
an in-memory filesystem. Portable built-ins and named OS profiles sit above
that core. Manual packs, the DOM adapter, and WebAssembly are optional edges,
so a headless consumer pays for none of them until used.

```text
custom UI ── mountShell() ── createShell()
                               ├─ parser
                               ├─ bounded MemoryFS
                               ├─ commands + OS profile
                               ├─ explicit host capabilities
                               ├─ lazy manual resolver
                               └─ lazy Wasm line filter

ELF64 loader ── x86-64/AArch64 subset CPU ── hot-block Wasm JIT ── Linux/FreeBSD syscalls ── byte-safe VFS
                                     optional v86 ── full x86 PC images
```

The parser implements the useful embedded subset: quotes, escapes, variables,
assignments, control operators, pipelines, and VFS-only redirects. It does not
pretend to provide host processes, job control, devices, sockets, or a real
Linux/FreeBSD kernel.

The guest CPU path is separate and experimental. Its synchronous syscall table
supports bounded files and standard streams; unsupported calls return the
guest ABI's `ENOSYS`. Browser network and model/language integrations remain
async custom-command capabilities because browsers do not expose raw sockets
and secret provider credentials are not safe ambient guest state.

AI and language runtimes use the same host callback boundary: Shell.js owns no
provider key, SDK, model registry, Python VM, or Go toolchain. A trusted host
injects a bounded callback and decides whether it targets a same-origin model
gateway, Pyodide, a precompiled Go Wasm module, or another runtime. This keeps
provider churn and large optional downloads outside the shell core.

`loadElf()` validates all ELF headers and segment bounds before writing guest
memory, maps ET_EXEC or ET_DYN segments, zeroes BSS, and optionally builds a
16-byte-aligned Linux entry stack. `runElf()` is the Linux-only synchronous
composition boundary; it can resolve and transfer control to one PT_INTERP image while
preserving the main executable's auxv metadata and bounds combined captured
output. `runElfAsync()` executes the same VM in bounded cooperative slices and
observes `AbortSignal` between them.
FreeBSD tables remain available to callers directly composing a subset CPU with
`createSyscalls()`; the VM helpers do not construct a FreeBSD process stack.
Relocation coverage, page permissions, signals, and threads remain outside the
verified boundary.

`createNetwork()` is the browser transport boundary: exact HTTP(S)/WS(S)
origins, omitted Fetch credentials, rejected Fetch redirects, and byte limits.
WebSocket handshakes can include ambient cookies, so callers must use a
dedicated cookieless origin. It does not disguise a relay as serverless raw
networking.

`createV86()` is an ESM-only lifecycle/serial adapter around an injected v86
constructor. It reuses v86's PC hardware and x86-to-Wasm JIT for unmodified
32-bit images without bundling it or coupling the small ELF subset VM to PC
devices. Disk, screen, 9p, snapshot, and network configuration pass directly to
v86; callers retain its underlying emulator for the rest of that public API.

`BlockFS` is synchronous so CPU syscalls do not cross an async boundary.
`openBlockFS()` restores its fixed-size block image from an OPFS file handle and
returns an explicit async `flush()`; OPFS persistence stays outside instruction
execution and requires no server.

The JIT lowers supported register-only basic blocks directly to small Wasm
modules, sharing a private register-state `WebAssembly.Memory`. It caches only
after a hotness threshold, validates every code page before reuse, and fails
closed to single-step interpretation. Data-page writes do not evict unrelated
code; writes through guest memory APIs advance per-page generations. Supported
backward conditional branches stay inside compiled blocks while respecting the
caller's exact remaining instruction budget.

Manuals are a reproducible supply-chain input. A manifest allowlists the two
official hosts, immutable revisions, exact paths, digests, and page size.
`mandoc -T utf8` produces text, avoiding runtime roff work and HTML injection.
The browser fetches the index once and each requested page separately.

The WebAssembly module has one raw, versioned ABI and no imports, allocator,
WASI runtime, or bindings layer. JavaScript remains faster for short commands.
Wasm is loaded only after the configured threshold, fails closed to the
JavaScript implementation, and must remain within the recorded size/speed
budgets.

`classic.js` is the explicit size boundary for the global IIFE. The package's
ES-module index statically exports ELF, syscall, composed VM, machine, and
network APIs; consumers can import individual source modules when they need a
smaller native module graph.

Release-plz tracks the Rust/Wasm package in git-only mode, applies SemVer,
updates the changelog, and creates tags/releases. JavaScript, Wasm, manuals,
tests, and benchmarks ship from the same commit. Its title setting names the
current major line once (verb + animal), without changing SemVer tags.
