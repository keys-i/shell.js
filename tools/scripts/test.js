import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { createManuals, readLimited } from "../../javascripts/man.js";
import { MemoryFS, createShell, profiles } from "../../javascripts/shell.js";
import { createWasm } from "../../javascripts/wasm.js";
import { buildManuals, licenseHeader, validateManual } from "./manuals.js";

const run = async (shell, command) => {
  const output = await shell.exec(command);
  assert.equal(output.stderr, "", `${command}: ${output.stderr}`);
  return output;
};

const shell = createShell({
  profile: "freebsd",
  files: { "/etc/motd": "web shell\n", "/home/rad/.hidden": "secret\n" },
});

assert.equal(shell.env.PWD, "/home/rad");
assert.notEqual((await createShell().exec("cd -")).code, 0);
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
assert.deepEqual(await run(shell, "cd /; cd -"), { code: 0, stdout: "/home/rad/work\n", stderr: "" });
assert.equal(shell.env.PWD, "/home/rad/work");
assert.equal(shell.env.OLDPWD, "/");
assert.notEqual((await shell.exec("mkdir d; mkdir d")).code, 0);
assert.equal((await run(shell, "mkdir -p d")).code, 0);
assert.notEqual((await shell.exec("rm d")).code, 0);
assert.equal(shell.fs.stat("d", shell.cwd).type, "directory");
assert.equal((await run(shell, "rmdir d")).code, 0);
assert.notEqual((await shell.exec("rmdir")).code, 0);
assert.notEqual((await shell.exec("rmdir a")).code, 0);
assert.notEqual((await shell.exec("touch sub/x; rmdir sub")).code, 0);
assert.equal((await run(shell, "rm sub/x; mkdir -p tree/leaf; rm -r tree")).code, 0);
assert.equal(shell.fs.exists("tree", shell.cwd), false);
assert.match((await run(shell, "printenv")).stdout, /^PWD=\/home\/rad\/work$/m);
assert.deepEqual(await shell.exec("printenv PWD USER MISSING"), {
  code: 1,
  stdout: "/home/rad/work\nrad\n",
  stderr: "",
});
const anchored = createShell({ cwd: "/work/sub" });
for (const command of ["rmdir .", "rm -r .."]) {
  assert.notEqual((await anchored.exec(command)).code, 0);
  assert.equal(anchored.fs.stat(".", anchored.cwd).type, "directory");
}
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
shell.register("root", (_args, ctx) => {
  ctx.chdir("/");
  assert.equal(ctx.env.PWD, "/");
});
assert.equal((await run(shell, "env TEMP=1 root")).code, 0);

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

const manualPage = "MAN(1)\nNAME\n     man - display manual pages\n";
const documents = new Map([
  [
    "/manuals/freebsd/index.json",
    JSON.stringify({
      pages: {
        man: {
          section: "1",
          path: "1/man.txt",
          description: "display manual pages",
          sha256: createHash("sha256").update(manualPage).digest("hex"),
        },
      },
    }),
  ],
  ["/manuals/freebsd/1/man.txt", manualPage],
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

const generated = mkdtempSync(join(tmpdir(), "shelljs-manuals-"));
const original = { cwd: process.cwd(), fetch: globalThis.fetch, path: process.env.PATH };
const source = '.\\" SPDX-License-Identifier: BSD-2-Clause\n.Dd July 31, 2026\n.Dt TEST 1\n.Os\n';
try {
  mkdirSync(join(generated, "bin"));
  writeFileSync(join(generated, "bin/mandoc"), "#!/bin/sh\ncat\n");
  chmodSync(join(generated, "bin/mandoc"), 0o755);
  mkdirSync(join(generated, "work/manuals/freebsd/1"), { recursive: true });
  writeFileSync(join(generated, "work/manuals/freebsd/1/stale.txt"), "stale");
  writeFileSync(
    join(generated, "work/manuals/manifest.json"),
    JSON.stringify({
      profiles: {
        freebsd: {
          release: "14.2-RELEASE-p4",
          origin: "https://cgit.freebsd.org/src",
          revision: "0".repeat(40),
          pages: [
            {
              name: "test",
              section: "1",
              path: "share/man/man1/test.1",
              sha256: createHash("sha256").update(source).digest("hex"),
            },
          ],
        },
      },
    }),
  );
  process.chdir(join(generated, "work"));
  process.env.PATH = `${join(generated, "bin")}:${original.path}`;
  globalThis.fetch = async () => new Response(source, { headers: { "content-type": "text/plain" } });
  await buildManuals();
  assert.equal(existsSync("manuals/freebsd/1/stale.txt"), false);
  const before = readFileSync("manuals/freebsd/1/test.txt", "utf8");
  writeFileSync(
    "manuals/manifest.json",
    readFileSync("manuals/manifest.json", "utf8").replace(
      createHash("sha256").update(source).digest("hex"),
      "0".repeat(64),
    ),
  );
  renameSync("manuals/freebsd", "manuals/.freebsd.previous");
  await assert.rejects(buildManuals());
  assert.equal(readFileSync("manuals/freebsd/1/test.txt", "utf8"), before);
} finally {
  process.chdir(original.cwd);
  process.env.PATH = original.path;
  globalThis.fetch = original.fetch;
  rmSync(generated, { force: true, recursive: true });
}

const manifest = JSON.parse(readFileSync("manuals/manifest.json", "utf8"));
const flatten = (pages) =>
  Object.entries(pages).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((record) => ({ name, ...record })),
  );
for (const [profile, config] of Object.entries(manifest.profiles)) {
  const root = `manuals/${profile}`;
  const index = JSON.parse(readFileSync(`manuals/${profile}/index.json`, "utf8"));
  const audit = JSON.parse(readFileSync(`manuals/${profile}/provenance.json`, "utf8"));
  assert.equal(index.profile, profile);
  assert.equal(index.release, config.release);
  assert.equal(audit.profile, profile);
  assert.equal(audit.release, config.release);
  assert.equal(audit.origin, config.origin);
  assert.equal(audit.revision, config.revision);
  assert.deepEqual(index.aliases, config.aliases ?? {});
  const expected = new Map(config.pages.map((entry) => [`${entry.name}\0${entry.section}`, entry]));
  const records = flatten(index.pages);
  const sources = new Map(flatten(audit.pages).map((record) => [`${record.name}\0${record.section}`, record]));
  assert.equal(records.length, expected.size);
  assert.equal(sources.size, expected.size);
  for (const record of records) {
    const key = `${record.name}\0${record.section}`;
    const entry = expected.get(key);
    const sourceRecord = sources.get(key);
    assert.ok(entry && expected.delete(key));
    assert.ok(sourceRecord && sources.delete(key));
    assert.deepEqual(
      {
        section: sourceRecord.section,
        sourcePath: sourceRecord.sourcePath,
        revision: sourceRecord.revision,
        sha256: sourceRecord.sha256,
      },
      {
        section: entry.section,
        sourcePath: entry.path,
        revision: config.revision,
        sha256: entry.sha256,
      },
    );
    const source = new URL(sourceRecord.source);
    assert.equal(source.origin, new URL(config.origin).origin);
    assert.ok(source.pathname.endsWith(`/${entry.path}`));
    assert.equal(source.searchParams.get("id"), config.revision);
    assert.ok(sourceRecord.license);
    const text = readFileSync(`${root}/${record.path}`, "utf8");
    assert.equal(createHash("sha256").update(text).digest("hex"), record.sha256);
    if (profile === "linux") assert.doesNotMatch(text, /\(date\)|\(unreleased\)/);
    else {
      assert.doesNotMatch(text, /macOS/);
      assert.match(text, /FreeBSD 14\.2-RELEASE-p4/);
    }
  }
  assert.equal(expected.size, 0);
  assert.equal(sources.size, 0);
  for (const target of Object.values(config.aliases ?? {})) {
    const value = index.pages[target.name];
    assert.ok((Array.isArray(value) ? value : [value]).some((entry) => entry?.section === target.section));
  }
  assert.deepEqual(Object.keys(audit.licenses).sort(), (config.licenses ?? []).map(({ name }) => name).sort());
  for (const entry of config.licenses ?? []) {
    const record = audit.licenses[entry.name];
    assert.deepEqual(
      {
        sourcePath: record.sourcePath,
        revision: record.revision,
        sha256: record.sha256,
      },
      {
        sourcePath: entry.path,
        revision: config.revision,
        sha256: entry.sha256,
      },
    );
    const path = `${root}/${record.path}`;
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), entry.sha256);
  }
  if (profile === "linux") {
    for (const { license } of flatten(audit.pages)) {
      const identifier = license.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/)?.[1];
      assert.ok(identifier && audit.licenses[`${identifier}.txt`]);
    }
  }
  assert.deepEqual(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)))
      .sort(),
    [...records.map(({ path }) => path), ...Object.values(audit.licenses).map(({ path }) => path)].sort(),
  );
}

const localManuals = (profile, requests) =>
  createManuals({
    base: "https://example.test/manuals/",
    profile,
    fetch: async (url) => {
      const path = new URL(url).pathname.slice(1);
      requests.push(path);
      return existsSync(path) ? new Response(readFileSync(path)) : new Response("", { status: 404 });
    },
  });
const freebsdRequests = [];
const freebsdManuals = localManuals("freebsd", freebsdRequests);
assert.match(await freebsdManuals.read("bt"), /^DDB\(4\)/);
assert.deepEqual(freebsdRequests, ["manuals/freebsd/index.json", "manuals/freebsd/4/ddb.txt"]);
assert.equal(await freebsdManuals.find("bt", "1"), null);

const linuxRequests = [];
const linuxManuals = localManuals("linux", linuxRequests);
assert.match(await linuxManuals.read("signal", "2"), /^signal\(2\)/i);
assert.match(await linuxManuals.read("signal", "7"), /^signal\(7\)/i);
assert.equal((await linuxManuals.find("openat")).path, "2/open.txt");
assert.equal((await linuxManuals.find("__clone2")).path, "2/clone.txt");
assert.deepEqual(
  (await linuxManuals.search("openat")).map(({ name, section }) => [name, section]),
  [["openat", "2"]],
);
assert.deepEqual(linuxRequests, [
  "manuals/linux/index.json",
  "manuals/linux/2/signal.txt",
  "manuals/linux/7/signal.txt",
]);

const invalidAliasManuals = createManuals({
  base: "https://example.test/manuals/",
  fetch: async () =>
    new Response(
      `{"pages":{"man":{"section":"1","path":"1/man.txt","sha256":"${"0".repeat(64)}"}},"aliases":{"help":{"name":"missing","section":"1"}}}`,
    ),
});
await assert.rejects(invalidAliasManuals.index(), /invalid manual index/);

const corruptedManuals = createManuals({
  base: "https://example.test/manuals/",
  fetch: async (url) =>
    new Response(
      new URL(url).pathname.endsWith("index.json")
        ? `{"pages":{"man":{"section":"1","path":"1/man.txt","sha256":"${"0".repeat(64)}"}}}`
        : "changed",
    ),
});
await assert.rejects(corruptedManuals.read("man"), /integrity/);

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
