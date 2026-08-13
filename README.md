# shell.js

A small, safe shell engine that can sit behind any web terminal UI.

```html
<script src="https://cdn.jsdelivr.net/gh/keys-i/shell.js@v0.2.0/javascripts/shell.min.js"></script>
<script>
  const shell = ShellJS.createShell({
    profile: "freebsd",
    commands: {
      hello: ([name = "world"]) => `hello ${name}\n`,
    },
  });

  shell.exec("hello koala | grep koa").then(console.log);
</script>
```

ES modules expose the headless API plus optional network, syscall, and VM adapters:

```js
import {
  createManuals,
  createNetwork,
  createShell,
  createV86,
  mountShell,
  openBlockFS,
  profiles,
  runElf,
  runElfAsync,
} from "./javascripts/index.js";

const shell = createShell({
  profile: profiles.linux,
  files: { "/etc/motd": "recovery ready\n" },
  manuals: createManuals({ base: "/manuals/", profile: "linux" }),
  wasm: "auto",
});

const { code, stdout, stderr } = await shell.exec("cat /etc/motd");
```

The engine provides quotes, escapes, variables, assignments, `;`, `&&`, `||`,
pipelines, virtual-filesystem redirects, bounded output, cancellation, command
completion, portable built-ins, and configurable FreeBSD/Linux profiles. A
custom command receives a virtual context; built-ins never use `eval`, the host
filesystem, or implicit network execution. Registered JavaScript handlers are
trusted host code and can still reach browser globals.
It deliberately omits field splitting, globbing, command substitution,
subshells, and job control.

Host integrations stay explicit through `capabilities`. A command can receive
an allowlisted Fetch/WebSocket bridge, a Python or Go WebAssembly runtime, or a
Codex/Claude callback as a declared dependency. Keep model provider secrets
behind a trusted backend; do not bundle long-lived API keys in browser
JavaScript.

The capability contract is provider- and language-neutral; Shell.js does not
ship model SDKs or language runtimes. Inject the runtime or model callback the
host application already trusts:

```js
const shell = createShell({
  capabilities: {
    ai: (prompt, { signal }) => fetch("/api/ai", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).then((response) => response.text()),
    python: (source, options) => pyodide.runPythonAsync(source, options),
    go: (module, options) => goRuntime.run(module, options),
  },
  commands: {
    ai: async (args, { capabilities, signal }) => `${await capabilities.ai(args.join(" "), { signal })}\n`,
    python: (args, { capabilities, signal }) => capabilities.python(args.join(" "), { signal }),
    go: (args, { capabilities, signal }) => capabilities.go(args, { signal }),
  },
});
```

The `/api/ai` backend can route to OpenAI/Codex, Anthropic/Claude, or another
provider while keeping credentials, rate limits, audit policy, and provider
request formats outside the browser. Direct browser API keys are visible to the
page, extensions, and developer tools and are not a secure mode.

```js
const network = createNetwork({ origins: ["https://api.example", "wss://terminal.example"] });
const shell = createShell({
  capabilities: { network },
  commands: {
    fetch: async ([url], { capabilities }) =>
      new TextDecoder().decode((await capabilities.network.fetch(url)).body),
  },
});
```

The bridge denies unlisted origins and URL credentials, makes Fetch omit ambient
cookies and reject redirects, and bounds request, response, and WebSocket
message sizes. Browser WebSocket handshakes can include ambient cookies, so use
a dedicated cookieless origin. Raw TCP/UDP requires an explicit relay or VPN
endpoint; HTML does not expose raw sockets.

For persistent browser storage, pass an Origin Private File System handle to
the block filesystem and flush at transaction boundaries:

```js
const root = await navigator.storage.getDirectory();
const image = await root.getFileHandle("root.img", { create: true });
const { fs, flush } = await openBlockFS(image, { blocks: 4096 });
fs.mkdir("/etc");
fs.write("/etc/hostname", "browser\n");
await flush();
```

`mountShell()` is an unstyled, accessible adapter. Applications can ignore it
and call `exec()` from any UI. The size-gated classic build exports the shell,
UI, block filesystem, and subset CPUs/JIT as
`globalThis.ShellJS`. The native ES-module entry statically exports the optional
ELF, syscall, composed VM, machine, and network adapters; import their source
modules directly when a page should fetch less code. CI exercises both forms in
current Chromium and Firefox, plus a CPU-throttled mobile Chromium profile.

## Kernels and WebAssembly

FreeBSD and Linux remain identity/manual/command profiles for the shell engine.
The separate guest path emulates bounded Linux/FreeBSD ABI subsets in browser
memory; it is not a complete kernel or distribution boot environment.

The experimental `createX86()` and `createArm()` interpreters run bounded
x86-64 and AArch64 instruction subsets. `createSyscalls()` connects their
`SYSCALL`/`SVC` traps to byte-safe virtual files. Linux and FreeBSD maps cover
standard I/O, paths, vectors, seeking, clocks, identity, randomness, and the
program break. Linux additionally covers metadata, positional reads, and
anonymous/file-backed mappings; Linux x86-64 also exposes `arch_prctl` TLS.
Unsupported calls return the guest ABI's `ENOSYS`; `mprotect` is currently a
compatibility check and does not enforce page permissions.

The implemented instruction contract is:

- x86-64: REX and FS prefixes; `NOP`, `MOV`, `MOVZX`, `MOVSX`, `MOVSXD`,
  `LEA`, `ADD`, `SUB`, `AND`, `OR`, `XOR`, `CMP`, `TEST`, `INC`, `DEC`,
  two-operand `IMUL`, `PUSH`, `POP`, `CALL`, `RET`, `LEAVE`, `JMP`, `Jcc`,
  `SETcc`, and `SYSCALL`, using the implemented register, immediate, and
  ModR/M/SIB memory forms.
- AArch64: `NOP`, `MRS`/`MSR TPIDR_EL0`, `RET`, `SVC`, `MOVZ`, `MOVK`,
  `ADD`, `SUB`, `ADDS`, `SUBS`, `AND`, `ORR`, `EOR`, `ANDS`, `MADD`, `MSUB`,
  `UDIV`, `SDIV`, `LSL`/`LSR`/`ASR` aliases, `CSEL`, `TBZ`/`TBNZ`, `ADR`,
  `ADRP`, `CBZ`/`CBNZ`, literal and scaled/unscaled `LDR`/`STR`,
  `LDRB`/`STRB`, `LDRH`/`STRH`, `LDRSW`, offset/pre/post `LDP`/`STP`, `B`,
  `B.cond`, and `BL` for the implemented 32- and 64-bit forms.

The exact syscall-number contracts are:

- Linux x86-64: `read(0)`, `write(1)`, `open(2)`, `close(3)`, `stat(4)`,
  `fstat(5)`, `lseek(8)`, `mmap(9)`, `mprotect(10)`, `munmap(11)`, `brk(12)`,
  `pread64(17)`, `readv(19)`, `writev(20)`, `getpid(39)`, `exit(60)`,
  `uname(63)`, `getcwd(79)`, `chdir(80)`, `getuid(102)`, `getgid(104)`,
  `geteuid(107)`, `getegid(108)`, `arch_prctl(158)`, `gettid(186)`,
  `set_tid_address(218)`, `clock_gettime(228)`, `exit_group(231)`,
  `openat(257)`, `newfstatat(262)`, and `getrandom(318)`.
- Linux AArch64: `getcwd(17)`, `chdir(49)`, `openat(56)`, `close(57)`,
  `lseek(62)`, `read(63)`, `write(64)`, `readv(65)`, `writev(66)`,
  `pread64(67)`, `newfstatat(79)`, `fstat(80)`, `exit(93)`, `exit_group(94)`,
  `set_tid_address(96)`, `clock_gettime(113)`, `uname(160)`, `getpid(172)`,
  `getuid(174)`, `geteuid(175)`, `getgid(176)`, `getegid(177)`, `gettid(178)`,
  `brk(214)`, `munmap(215)`, `mmap(222)`, `mprotect(226)`, and
  `getrandom(278)`.
- FreeBSD amd64 and AArch64: `exit(1)`, `read(3)`, `write(4)`, `open(5)`,
  `close(6)`, `chdir(12)`, `break(17)`, `getpid(20)`, `getuid(24)`,
  `geteuid(25)`, `getegid(43)`, `getgid(47)`, `readv(120)`, `writev(121)`,
  `clock_gettime(232)`, `__getcwd(326)`, `lseek(478)`, and `getrandom(563)`.

Hot register-only basic blocks are profiled, compiled to generated WebAssembly
after 64 executions, cached by 4 KiB code-page generation, and otherwise fall
back to the interpreter; pass `{ jit: false }` for comparison. `loadElf()`
validates and maps little-endian ELF64 ET_EXEC/ET_DYN images and builds a Linux
System V `argv`/`envp`/auxv entry stack. `runElf()` composes that loader, guest
memory, the matching CPU/JIT, Linux syscalls, captured byte streams, and an
optional PT_INTERP resolver. `runElfAsync()` runs the same VM in cooperative
slices with `AbortSignal` cancellation for Worker-friendly execution. Combined
captured guest output defaults to a 1 MiB limit and is configurable with
`maxOutputBytes`.
FreeBSD syscall tables are available for direct CPU/`createSyscalls()`
composition; `runElf()` and `runElfAsync()` currently construct Linux guests.

Complete ISAs, relocations and a verified dynamic linker, page-permission
enforcement, signals, threads, and Fedora/FreeBSD/Debian boot remain unfinished.

Compiler and libc source provenance lives in the separate
[`krad`](https://github.com/keys-i/krad) package graph (`krad-clang`,
`krad-utils`, `krad-musl`, and `krad-libs`). Shell.js does not yet consume
browser compiler artifacts from those packages.

For unmodified x86 PC images, inject v86's official `V86` constructor instead
of growing the subset decoder. Shell.js does not depend on v86; the host must
install and pin it separately. The adapter keeps v86 optional, attaches serial
before boot, and exposes the underlying emulator for disks, 9p, snapshots, and
screen integration:

```js
import { V86 } from "v86";

const pc = createV86({
  V86,
  wasm_path: "/v86/v86.wasm",
  bios: { url: "/v86/seabios.bin" },
  hda: { url: "/images/root.img" },
  net_device: { type: "virtio", relay_url: "fetch" },
  onSerial: (byte) => terminal.write(String.fromCharCode(byte)),
});
await pc.run();
pc.write("uname -a\n");
```

The v86 backend is 32-bit x86 and separately licensed; it does not complete the
AArch64 or current 64-bit distribution target. Its in-browser network backend
is local-only, Fetch is HTTP/CORS-limited, and general TCP/UDP still needs a
WISP/WebSocket relay.

The optional Rust WebAssembly module accelerates large literal line filters.
It is lazy, import-free, and has a JavaScript fallback. Short commands do not
fetch or instantiate Wasm. `await shell.prepare("wasm")` warms it explicitly.

## Manuals

`npm run manuals` downloads commit-pinned roff from the official FreeBSD cgit
and Linux man-pages repositories, verifies each source, renders plain text
with `mandoc`, and writes sharded local packs. Browsers load one compact index
and only the requested page; upstream CORS policies prevent reliable direct
runtime rendering.

Every generated entry records its source path, revision, digest, and license
header. The upstream manual text is not covered by this repository's MIT
license; see [manual sources](docs/MANUAL_SOURCES.md).

Manual reads use Web Crypto to verify each lazily fetched rendered page.

## Development

Requires Node 22+, rustup, and `mandoc`; `rust-toolchain.toml` pins Rust and
the Wasm target.

```sh
npm ci
npm run validate
npm run build
npm run browser
npm run benchmark
```

The release-plz workflow owns SemVer tags and GitHub releases, including the
classic JavaScript and Wasm assets. npm publishing stays disabled until the
package has a trusted publisher; tags and version-pinned GitHub CDN URLs are
the public distribution contract.

Each major line has one verb-animal codename: v0 is **Hatch Koala**; the v1
release changes the single release title setting to **Boot Koala**.
