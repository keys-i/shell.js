import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createManuals, readLimited } from "./man.js";
import { licenseHeader, validateManual } from "./manuals.js";
import { MemoryFS, createShell, profiles } from "./shell.js";
import { createWasm } from "./wasm.js";

const run = async (shell, command) => {
  const output = await shell.exec(command);
  assert.equal(output.stderr, "", `${command}: ${output.stderr}`);
  return output;
};

const shell = createShell({
  profile: "freebsd",
  files: { "/etc/motd": "web shell\n", "/home/rad/.hidden": "secret\n" },
});

assert.equal(
  (await run(shell, String.raw`NAME=world; echo "hello $NAME" '$NAME' escaped\ value # ignored`)).stdout,
  "hello world $NAME escaped value\n",
);
assert.equal(
  (await run(shell, `printf "alpha\\nbeta\\n" > /tmp.txt; grep beta < /tmp.txt | wc -l`)).stdout.trim(),
  "1",
);
assert.equal((await run(shell, "head -1 /tmp.txt")).stdout, "alpha\n");
assert.equal((await run(shell, "false && echo no; true || echo no; echo yes")).stdout, "yes\n");
assert.equal((await run(shell, "true &&\necho continued")).stdout, "continued\n");
assert.equal((await run(shell, "echo first > log; echo second >> log; cat log")).stdout, "first\nsecond\n");
assert.match((await run(shell, "cat missing 2> error.log; cat error.log")).stdout, /No such file/);
assert.deepEqual(await shell.exec("echo kept; cat < missing"), {
  code: 1,
  stdout: "kept\n",
  stderr: "shell: /home/rad/missing: No such file or directory\n",
});
assert.equal((await run(shell, "mkdir -p work/sub; cd work; touch a; ls")).stdout, "a  sub\n");
assert.equal((await run(shell, "export COLOR=blue; env COLOR=red echo $COLOR; echo $COLOR")).stdout, "blue\nblue\n");
assert.equal((await run(shell, "uname -s; freebsd-version; whoami")).stdout, "FreeBSD\n14.2-RELEASE\nrad\n");
assert.match((await run(shell, "sysctl kern.ostype; kldload koala; kldstat")).stdout, /FreeBSD[\s\S]*koala\.ko/);
assert.equal((await shell.exec("sysctl constructor")).code, 1);
assert.match((await run(createShell({ profile: "linux" }), "modprobe koala; lsmod")).stdout, /koala/);
assert.equal(profiles.linux.sysname, "Linux");
assert.throws(() => profiles.freebsd.modules.push("bad"), TypeError);
assert.deepEqual(shell.complete("un"), ["uname", "unset"]);
assert.deepEqual(shell.complete("cat s"), ["sub/"]);
assert.deepEqual(shell.complete(`echo ${"x".repeat(16_384)}`), []);

shell.register("upper", async (args, { stdin, signal }) => {
  await Promise.resolve();
  assert.equal(signal.aborted, false);
  return (stdin || args.join(" ")).toUpperCase();
});
assert.equal((await run(shell, "echo koala | upper")).stdout, "KOALA\n");

const fs = new MemoryFS({ "/safe/file": "ok" }, { maxFiles: 8, maxFileBytes: 8, maxTotalBytes: 8 });
assert.equal(fs.read("/safe/file"), "ok");
assert.throws(() => fs.read("../../etc/passwd", "/safe"), /escapes root/);
assert.throws(() => fs.write("/safe/large", "123456789"), /file quota/);

const limited = createShell({
  limits: { maxOutput: 4, maxRuntimeMs: 100 },
  commands: { flood: () => "12345" },
});
assert.notEqual((await limited.exec("flood")).code, 0);
assert.equal((await limited.exec("echo 1 2 3", { signal: AbortSignal.abort() })).code, 130);

const timed = createShell({
  limits: { maxRuntimeMs: 5 },
  commands: { wait: () => new Promise(() => {}) },
});
assert.equal((await timed.exec("wait")).code, 124);
assert.equal((await shell.exec("echo x ".repeat(129))).code, 2);
assert.match((await shell.exec("echo ok 2< file")).stderr, /unsupported redirect/);
assert.equal((await run(shell, "echo \\\n hi")).stdout, "hi\n");

const serial = createShell({
  commands: {
    slow: async (_args, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.setenv("ORDER", "done");
    },
  },
});
const first = serial.exec("slow");
const second = serial.exec("echo $ORDER");
await first;
assert.equal((await second).stdout, "done\n");

const documents = new Map([
  [
    "/manuals/freebsd/index.json",
    JSON.stringify({
      pages: { man: { section: "1", path: "1/man.txt", description: "display manual pages" } },
    }),
  ],
  ["/manuals/freebsd/1/man.txt", "MAN(1)\nNAME\n     man - display manual pages\n"],
]);
const manuals = createManuals({
  base: "https://example.test/manuals/",
  fetch: async (url) =>
    documents.has(new URL(url).pathname)
      ? new Response(documents.get(new URL(url).pathname))
      : new Response("", { status: 404 }),
});
const documented = createShell({ profile: "freebsd", manuals });
assert.match((await run(documented, "man 1 man")).stdout, /display manual pages/);
assert.match((await run(documented, "apropos display")).stdout, /man\(1\)/);
assert.equal((await documented.exec("man missing")).code, 1);
const emptyManuals = createManuals({
  base: "https://example.test/manuals/",
  fetch: async () => new Response('{"pages":{}}'),
});
assert.equal(await emptyManuals.read("constructor"), null);
await assert.rejects(readLimited(new Response("12345"), 4), RangeError);
assert.equal(
  licenseHeader('.\\" SPDX-License-Identifier: BSD-2-Clause\n.Dd July 31, 2026\n'),
  '.\\" SPDX-License-Identifier: BSD-2-Clause',
);
assert.throws(
  () =>
    validateManual("freebsd", "0".repeat(40), { name: "bad", section: "1", path: "../bad.1", sha256: "0".repeat(64) }),
  /invalid manual/,
);

const manifest = JSON.parse(readFileSync("manuals/manifest.json", "utf8"));
for (const [profile, config] of Object.entries(manifest.profiles)) {
  const index = JSON.parse(readFileSync(`manuals/${profile}/index.json`, "utf8"));
  assert.equal(index.revision, config.revision);
  for (const entry of config.pages) {
    const value = index.pages[entry.name];
    const record = (Array.isArray(value) ? value : [value]).find(({ section }) => section === entry.section);
    assert.equal(record.sha256, entry.sha256);
    assert.ok(existsSync(`manuals/${profile}/${record.path}`));
  }
  for (const entry of config.licenses ?? []) {
    assert.equal(index.licenses[entry.name].sha256, entry.sha256);
    assert.ok(existsSync(`manuals/${profile}/${index.licenses[entry.name].path}`));
  }
}

if (existsSync("wasm/shell.wasm")) {
  const bytes = readFileSync("wasm/shell.wasm");
  const wasm = createWasm({
    url: "memory:shell.wasm",
    threshold: 1,
    fetch: async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }),
  });
  assert.equal(await wasm.prepare(), true);
  assert.equal(wasm.filter("koala\ndingo\n", "koa"), "koala\n");
  assert.equal(wasm.filter("koala", "koa"), "koala\n");
}

if (existsSync("javascripts/shell.min.js")) {
  const context = {
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    WebAssembly,
    clearTimeout,
    setTimeout,
  };
  runInNewContext(readFileSync("javascripts/shell.min.js", "utf8"), context);
  assert.equal(typeof context.ShellJS.createShell, "function");
}

console.log("shell.js core: ok");
