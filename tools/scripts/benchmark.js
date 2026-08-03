import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createShell } from "../../javascripts/shell.js";
import { createWasm } from "../../javascripts/wasm.js";

const rounds = Number(process.env.BENCH_ROUNDS ?? 1000);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100_000) throw new TypeError("invalid BENCH_ROUNDS");
const shell = createShell({ limits: { maxHistory: rounds * 2 + 2, maxRuntimeMs: 60_000 } });
const measure = async (name, task, count = rounds) => {
  const start = performance.now();
  for (let index = 0; index < count; index++) await task();
  const elapsed = performance.now() - start;
  console.log(`${name}: ${((count * 1000) / elapsed).toFixed(0)} ops/s`);
  return elapsed;
};

const simple = () => shell.exec("echo koala | grep koa");
const control = () => shell.exec("A=1; true && printf '%s\\n' \"$A\" | wc -c");
assert.deepEqual(await simple(), { code: 0, stdout: "koala\n", stderr: "" });
assert.equal((await control()).stdout.trim(), "2");
await measure("simple", simple);
await measure("parse", control);

const binary = readFileSync("wasm/shell.wasm");
const wasm = createWasm({
  url: "memory:shell.wasm",
  threshold: 1,
  fetch: async () => new Response(binary, { headers: { "content-type": "application/wasm" } }),
});
await wasm.prepare();
const text = "koala kernel\npanic trace\ndingo module\n".repeat(27_000);
const javascript = () =>
  `${text
    .split("\n")
    .filter((line) => line.includes("koala"))
    .join("\n")}\n`;
if (wasm.filter(text, "koala") !== javascript()) throw new Error("JavaScript/WebAssembly output mismatch");
const jsTime = await measure("literal-js-1MiB", javascript, 20);
const wasmTime = await measure("literal-wasm-1MiB", () => wasm.filter(text, "koala"), 20);
console.log(`warm Wasm speedup: ${((jsTime / wasmTime - 1) * 100).toFixed(1)}%`);

const sizes = ["javascripts/shell.min.js", "wasm/shell.wasm"].map((path) => {
  const bytes = readFileSync(path);
  return { path, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
});
for (const size of sizes) console.log(`${size.path}: ${size.raw} B raw / ${size.gzip} B gzip`);
if (sizes[0].gzip > 24 * 1024 || sizes[1].raw > 16 * 1024 || sizes[1].gzip > 8 * 1024) {
  throw new Error("distribution size budget exceeded");
}
