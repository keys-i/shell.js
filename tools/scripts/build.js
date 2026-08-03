import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
};

run("cargo", ["build", "--release", "--target", "wasm32v1-none"]);
await mkdir("wasm", { recursive: true });
await copyFile("target/wasm32v1-none/release/shell_js.wasm", "wasm/shell.wasm");
await chmod("wasm/shell.wasm", 0o644);
await build({
  entryPoints: ["javascripts/index.js"],
  bundle: true,
  define: { "import.meta.url": "globalThis.location.href" },
  format: "iife",
  globalName: "ShellJS",
  legalComments: "none",
  minify: true,
  outfile: "javascripts/shell.min.js",
  target: ["es2022"],
});

const [javascript, wasm] = await Promise.all([stat("javascripts/shell.min.js"), stat("wasm/shell.wasm")]);
console.log(`built ${javascript.size} B JS + ${wasm.size} B Wasm`);
