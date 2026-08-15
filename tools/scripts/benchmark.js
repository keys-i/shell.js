import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createShell } from "../../javascripts/shell.js";
import { createArm } from "../../javascripts/cpu/arm.js";
import { createX86 } from "../../javascripts/cpu/x86.js";
import { createWasm } from "../../javascripts/wasm.js";

const rounds = Number(process.env.BENCH_ROUNDS ?? 1000);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100_000) throw new TypeError("invalid BENCH_ROUNDS");
const armBytes = (words) => {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => {
    view.setUint32(index * 4, word, true);
  });
  return bytes;
};
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
const pattern = "koala kernel\npanic trace\ndingo module\n";
const text = pattern.repeat(Math.ceil(1_048_576 / pattern.length)).slice(0, 1_048_576);
const javascript = () =>
  `${text
    .split("\n")
    .filter((line) => line.includes("koala"))
    .join("\n")}\n`;
if (wasm.filter(text, "koala") !== javascript()) throw new Error("JavaScript/WebAssembly output mismatch");
const jsTime = await measure("literal-js-1MiB", javascript, 20);
const wasmTime = await measure("literal-wasm-1MiB", () => wasm.filter(text, "koala"), 20);
console.log(`warm Wasm speedup: ${((jsTime / wasmTime - 1) * 100).toFixed(1)}%`);

const loopCount = 200_000;
const x86Loop = Uint8Array.from([
  0x48, 0xb9, 0x40, 0x0d, 3, 0, 0, 0, 0, 0, 0x48, 0x83, 0xe9, 1, 0x75, 0xfa, 0x48, 0xb8, 60, 0, 0, 0, 0, 0, 0, 0, 0x0f,
  0x05,
]);
const armLoop = armBytes([0xd281a800, 0xf2a00060, 0xf1000400, 0x54ffffe1, 0xd2800ba8, 0xd4000001]);
const cpuSample = (create, program, jit, counter) => {
  let syscalls = 0;
  const cpu = create({
    jit,
    onSyscall: () => {
      syscalls++;
      return null;
    },
  });
  cpu.load(program);
  const start = performance.now();
  const registers = cpu.run({ maxSteps: loopCount * 2 + 10 });
  const elapsed = performance.now() - start;
  assert.equal(cpu.halted, true);
  assert.equal(syscalls, 1);
  assert.equal(registers[counter], 0n);
  return elapsed;
};
const cpuMedian = (create, program, jit, counter) => {
  const samples = Array.from({ length: 7 }, () => cpuSample(create, program, jit, counter)).sort((a, b) => a - b);
  return { median: samples[3], min: samples[0], max: samples[6] };
};
for (const [name, create, program, counter] of [
  ["x86-64", createX86, x86Loop, "rcx"],
  ["aarch64", createArm, armLoop, "x0"],
]) {
  const interpreter = cpuMedian(create, program, false, counter);
  const jit = cpuMedian(create, program, true, counter);
  console.log(
    `${name} ${loopCount}-iteration decrement/branch loop: interpreter ${interpreter.median.toFixed(2)} ms (${interpreter.min.toFixed(2)}-${interpreter.max.toFixed(2)}), JIT ${jit.median.toFixed(2)} ms (${jit.min.toFixed(2)}-${jit.max.toFixed(2)}), speedup ${(interpreter.median / jit.median).toFixed(2)}x`,
  );
}

const sizes = ["javascripts/shell.min.js", "wasm/shell.wasm"].map((path) => {
  const bytes = readFileSync(path);
  return { path, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
});
for (const size of sizes) console.log(`${size.path}: ${size.raw} B raw / ${size.gzip} B gzip`);
if (sizes[0].gzip > 24 * 1024 || sizes[1].raw > 16 * 1024 || sizes[1].gzip > 8 * 1024) {
  throw new Error("distribution size budget exceeded");
}
