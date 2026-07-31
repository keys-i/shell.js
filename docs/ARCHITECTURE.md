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
                               ├─ lazy manual resolver
                               └─ lazy Wasm line filter
```

The parser implements the useful embedded subset: quotes, escapes, variables,
assignments, control operators, pipelines, and VFS-only redirects. It does not
pretend to provide host processes, job control, devices, sockets, or a real
Linux/FreeBSD kernel.

Manuals are a reproducible supply-chain input. A manifest allowlists the two
official hosts, immutable revisions, exact paths, digests, and page size.
`mandoc -T utf8` produces text, avoiding runtime roff work and HTML injection.
The browser fetches the index once and each requested page separately.

The WebAssembly module has one raw, versioned ABI and no imports, allocator,
WASI runtime, or bindings layer. JavaScript remains faster for short commands.
Wasm is loaded only after the configured threshold, fails closed to the
JavaScript implementation, and must remain within the recorded size/speed
budgets.

Release-plz tracks the Rust/Wasm package in git-only mode, applies SemVer,
updates the changelog, and creates tags/releases. JavaScript, Wasm, manuals,
tests, and benchmarks ship from the same commit. Its title setting names the
current major line once (verb + animal), without changing SemVer tags.
