# shell.js

A small, safe shell engine that can sit behind any web terminal UI.

```html
<script src="https://cdn.jsdelivr.net/gh/keys-i/shell.js@v0.1.0/javascripts/shell.min.js"></script>
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

ES modules expose the same headless API:

```js
import { createShell, createManuals, mountShell, profiles } from "./javascripts/index.js";

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
custom command receives only the virtual capabilities passed to it; shell.js
never uses `eval`, the host filesystem, or implicit network execution.
It deliberately omits field splitting, globbing, command substitution,
subshells, and job control.

`mountShell()` is an unstyled, accessible adapter. Applications can ignore it
and call `exec()` from any UI. The classic build exports `globalThis.ShellJS`;
the readable modules remain the source of truth.

## Kernels and WebAssembly

FreeBSD and Linux are identity/manual/command profiles, not browser kernel
emulators. Real kernel execution needs a separately sandboxed VM image and is
deliberately outside this small library.

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
npm run benchmark
```

The release-plz workflow owns SemVer tags and GitHub releases, including the
classic JavaScript and Wasm assets. npm publishing stays disabled until the
package has a trusted publisher; tags and version-pinned GitHub CDN URLs are
the public distribution contract.

Each major line has one verb-animal codename: v0 is **Hatch Koala**; the v1
release changes the single release title setting to **Boot Koala**.
