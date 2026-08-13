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
import { createV86 } from "../../javascripts/machine.js";
import { createNetwork } from "../../javascripts/network.js";
import { BlockDevice, BlockFS, openBlockFS } from "../../javascripts/block.js";
import { createArm } from "../../javascripts/cpu/arm.js";
import { FLAGS, createX86 } from "../../javascripts/cpu/x86.js";
import { loadElf } from "../../javascripts/elf.js";
import { MemoryFS, createShell, profiles } from "../../javascripts/shell.js";
import { createSyscalls } from "../../javascripts/syscall.js";
import { runElf, runElfAsync } from "../../javascripts/vm.js";
import { createWasm } from "../../javascripts/wasm.js";
import { buildManuals, licenseHeader, validateManual } from "./manuals.js";

const run = async (shell, command) => {
  const output = await shell.exec(command);
  assert.equal(output.stderr, "", `${command}: ${output.stderr}`);
  return output;
};

const armBytes = (words) => {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => {
    view.setUint32(index * 4, word, true);
  });
  return bytes;
};

const shell = createShell({
  profile: "freebsd",
  files: { "/etc/motd": "web shell\n", "/home/rad/.hidden": "secret\n" },
});
const capable = createShell({
  capabilities: {
    answer: async (value, { signal }) => {
      assert.equal(signal.aborted, false);
      return value;
    },
  },
  commands: {
    capability: async (_args, { capabilities, signal }) => `${await capabilities.answer(42, { signal })}\n`,
  },
});
assert.equal((await capable.exec("capability")).stdout, "42\n");
assert.throws(() => createShell({ capabilities: null }), /capabilities must be an object/);

{
  let instance;
  class V86 {
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      instance = this;
    }
    add_listener(event, listener) {
      this.listeners.set(event, listener);
    }
    async destroy() {
      this.destroyed = true;
    }
    remove_listener(event, listener) {
      assert.equal(this.listeners.get(event), listener);
      this.listeners.delete(event);
    }
    async run() {
      this.running = true;
    }
    serial0_send(value) {
      this.input = value;
    }
    async stop() {
      this.running = false;
    }
  }
  const output = [];
  const pc = createV86({ V86, autostart: true, hda: { url: "root.img" }, onSerial: (byte) => output.push(byte) });
  assert.equal(instance.options.autostart, false);
  assert.deepEqual(instance.options.hda, { url: "root.img" });
  instance.listeners.get("serial0-output-byte")(65);
  assert.deepEqual(output, [65]);
  pc.write("hi");
  assert.equal(instance.input, "hi");
  assert.throws(() => pc.write(Uint8Array.of(1)), /must be a string/);
  await pc.run();
  assert.equal(instance.running, true);
  await pc.stop();
  assert.equal(instance.running, false);
  await pc.destroy();
  await pc.destroy();
  assert.equal(instance.destroyed, true);
  assert.throws(() => pc.write("late"), /destroyed/);
  let finishDestroy;
  class SlowV86 extends V86 {
    async destroy() {
      await new Promise((resolve) => {
        finishDestroy = resolve;
      });
      this.destroyed = true;
    }
  }
  const slow = createV86({ V86: SlowV86 });
  const destroying = slow.destroy();
  assert.throws(() => slow.run(), /being destroyed/);
  finishDestroy();
  await destroying;
  let destroyCalls = 0;
  class BrokenV86 extends V86 {
    async destroy() {
      destroyCalls++;
      throw new Error("teardown failed");
    }
  }
  const broken = createV86({ V86: BrokenV86 });
  await assert.rejects(broken.destroy(), /teardown failed/);
  await assert.rejects(broken.destroy(), /teardown failed/);
  assert.equal(destroyCalls, 2);
  assert.equal(instance.listeners.has("serial0-output-byte"), true);
  broken.write("still live");
  assert.equal(instance.input, "still live");
  assert.throws(() => createV86(), /must be a constructor/);
  assert.throws(() => createV86({ V86: class {} }), /incompatible V86 constructor/);
}

{
  let request;
  let lastSocket;
  class Socket {
    constructor(url) {
      this.url = url.href;
      this.protocol = "test";
      this.readyState = 1;
      this.sent = [];
      this.listeners = new Map();
      lastSocket = this;
    }
    addEventListener(type, listener) {
      type = String(type);
      let listeners = this.listeners.get(type);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(type, listeners);
      }
      listeners.add(listener);
    }
    close(...args) {
      this.closed = args;
    }
    removeEventListener(type, listener, options) {
      type = String(type);
      this.removed = {
        capture: typeof options === "boolean" ? options : Boolean(options?.capture),
        type,
      };
      const listeners = this.listeners.get(type);
      listeners?.delete(listener);
      if (!listeners?.size) this.listeners.delete(type);
    }
    send(value) {
      this.sent.push(value);
    }
    emit(type, event) {
      type = String(type);
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const network = createNetwork({
    origins: ["https://api.example", "wss://socket.example"],
    fetch: async (url, options) => {
      request = { options, url: url.href };
      return new Response("okay", { headers: { "content-length": "4" }, status: 200 });
    },
    WebSocket: Socket,
    maxMessageBytes: 4,
  });
  const response = await network.fetch("https://api.example/data", { credentials: "include" });
  assert.equal(new TextDecoder().decode(response.body), "okay");
  assert.equal(request.url, "https://api.example/data");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  await assert.rejects(() => network.fetch("https://denied.example"), /origin denied/);
  await assert.rejects(() => network.fetch("https://user:secret@api.example/data"), /credentials are denied/);
  assert.throws(() => createNetwork({ origins: ["https://user:secret@api.example"] }), /cannot contain credentials/);
  let bodyReads = 0;
  const changingBody = {};
  Object.defineProperty(changingBody, "body", {
    enumerable: true,
    get() {
      bodyReads++;
      return bodyReads === 1 ? "okay" : "too large";
    },
  });
  const snapshotted = createNetwork({
    origins: ["https://api.example"],
    fetch: async (_url, options) => {
      assert.equal(options.body, "okay");
      return new Response();
    },
    maxRequestBytes: 4,
  });
  await snapshotted.fetch("https://api.example", changingBody);
  assert.equal(bodyReads, 1);
  const socket = network.websocket("wss://socket.example/terminal");
  socket.send("ping");
  assert.throws(() => socket.send("large"), /message is too large/);
  let safeMessage;
  const receive = (event) => {
    safeMessage = event;
  };
  socket.addEventListener("message", receive);
  socket.addEventListener("message", receive);
  lastSocket.emit("message", { data: "ping", target: lastSocket, timeStamp: 1 });
  assert.equal(safeMessage.target, socket);
  assert.equal(safeMessage.currentTarget, socket);
  assert.equal(safeMessage.data, "ping");
  assert.equal(Object.isFrozen(safeMessage), true);
  assert.throws(() => safeMessage.target.send("large"), /message is too large/);
  socket.removeEventListener("message", receive);
  assert.equal(lastSocket.listeners.has("message"), false);
  let firstCalls = 0;
  let secondCalls = 0;
  const first = () => firstCalls++;
  const second = () => secondCalls++;
  socket.addEventListener("message", first);
  socket.addEventListener("message", second);
  socket.removeEventListener("message", first);
  lastSocket.emit("message", { data: "ping" });
  assert.deepEqual([firstCalls, secondCalls], [0, 1]);
  socket.removeEventListener("message", second);
  let onceCalls = 0;
  const once = () => onceCalls++;
  socket.addEventListener("message", once, { once: true });
  lastSocket.emit("message", { data: "ping" });
  lastSocket.emit("message", { data: "ping" });
  socket.addEventListener("message", once, { once: true });
  lastSocket.emit("message", { data: "ping" });
  assert.equal(onceCalls, 2);
  let abortCalls = 0;
  const aborted = () => abortCalls++;
  const controller = new AbortController();
  socket.addEventListener("message", aborted, { signal: controller.signal });
  controller.abort();
  lastSocket.emit("message", { data: "ping" });
  socket.addEventListener("message", aborted);
  lastSocket.emit("message", { data: "ping" });
  assert.equal(abortCalls, 1);
  socket.removeEventListener("message", aborted);
  let safeOpen;
  socket.addEventListener("open", (event) => {
    safeOpen = event;
  });
  lastSocket.emit("open", { target: lastSocket, timeStamp: 2 });
  assert.equal(safeOpen.target, socket);
  const mutableOptions = { capture: false, once: true };
  socket.addEventListener("open", () => {}, mutableOptions);
  mutableOptions.capture = true;
  lastSocket.emit("open", {});
  assert.deepEqual(lastSocket.removed, { capture: false, type: "open" });
  socket.addEventListener("message", () => assert.fail("oversized message was delivered"));
  lastSocket.emit("message", { data: "large" });
  assert.deepEqual(lastSocket.closed, [1009, "message too large"]);
  const boxedSocket = network.websocket("wss://socket.example/terminal");
  boxedSocket.addEventListener(Object("message"), () => assert.fail("boxed event type bypassed the limit"));
  lastSocket.emit("message", { data: "large" });
  assert.deepEqual(lastSocket.closed, [1009, "message too large"]);
  assert.throws(() => network.websocket("wss://denied.example"), /origin denied/);
  const bounded = createNetwork({
    origins: ["https://api.example"],
    fetch: async () => new Response("large"),
    maxResponseBytes: 4,
  });
  await assert.rejects(() => bounded.fetch("https://api.example"), /response is too large/);
  let cancelled = false;
  const declared = createNetwork({
    origins: ["https://api.example"],
    fetch: async () => ({
      body: {
        async cancel() {
          cancelled = true;
        },
      },
      headers: new Headers({ "content-length": "5" }),
    }),
    maxResponseBytes: 4,
  });
  await assert.rejects(() => declared.fetch("https://api.example"), /response is too large/);
  assert.equal(cancelled, true);
}

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
  const classicX86 = context.ShellJS.createX86({ onSyscall: () => null });
  classicX86.load(Uint8Array.of(0x0f, 0x05));
  classicX86.run();
  assert.equal(classicX86.halted, true);
  const classicArm = context.ShellJS.createArm({ onSyscall: () => null });
  classicArm.load(Uint8Array.of(1, 0, 0, 0xd4));
  classicArm.run();
  assert.equal(classicArm.halted, true);
  assert.equal(context.ShellJS.createNetwork, undefined);
  assert.equal(context.ShellJS.runElf, undefined);
}
const demo = readFileSync("demo/index.html", "utf8");
assert.match(demo, /Content-Security-Policy/);
assert.match(demo, /src="\.\/demo\.js"/);
assert.match(demo, /href="\.\/demo\.css"/);
assert.doesNotMatch(demo, /<style[ >]/);
assert.doesNotMatch(demo, /<script type="module">/);

console.log("shell.js core: ok");

{
  const disk = new BlockDevice({ blockSize: 512, blocks: 64 });
  const fs = new BlockFS(disk);
  fs.mkdir("/home/rad", { parents: true });
  fs.write("/home/rad/note.txt", "koala\n");
  fs.append("/home/rad/note.txt", "dingo\n");
  fs.writeBytes("/home/rad/raw", Uint8Array.of(0, 255, 1));
  assert.equal(fs.read("/home/rad/note.txt"), "koala\ndingo\n");
  assert.deepEqual(fs.readBytes("/home/rad/raw"), Uint8Array.of(0, 255, 1));
  assert.equal(fs.stat("/home/rad").type, "directory");
  assert.deepEqual(
    fs.list("/home/rad").map((entry) => entry.name),
    ["note.txt", "raw"],
  );
  const remount = new BlockFS(disk, { format: false });
  assert.equal(remount.read("/home/rad/note.txt"), "koala\ndingo\n");
  assert.deepEqual(remount.readBytes("/home/rad/raw"), Uint8Array.of(0, 255, 1));
  assert.throws(() => remount.write("/😀😀😀😀😀😀", "no"), /File name too long/);
  assert.throws(() => remount.write("/", "no"), /Is a directory/);
  const tight = new BlockFS(new BlockDevice({ blockSize: 256, blocks: 8 }));
  tight.write("/keep", "old");
  tight.writeBytes("/full", new Uint8Array(4 * 252));
  assert.throws(() => tight.writeBytes("/keep", new Uint8Array(253)), /no free blocks/);
  assert.equal(tight.read("/keep"), "old");
  const aliasDisk = new BlockDevice({ blockSize: 512, blocks: 64 });
  const aliasFs = new BlockFS(aliasDisk);
  aliasFs.writeBytes(
    "/seed",
    Uint8Array.from({ length: 512 }, (_, index) => index & 0xff),
  );
  const aliasView = new DataView(aliasDisk.buffer);
  const aliasRoot = aliasView.getUint32(512 + 32 + 12, true);
  const aliasInode = aliasView.getUint32(aliasRoot * 512, true);
  const aliasBlock = aliasView.getUint32(512 + aliasInode * 32 + 12, true);
  const alias = new Uint8Array(aliasDisk.buffer, aliasBlock * 512, 512);
  const aliasSnapshot = alias.slice();
  aliasDisk.write(aliasBlock, alias);
  assert.deepEqual(alias, aliasSnapshot);
  aliasFs.writeBytes("/seed", alias);
  assert.deepEqual(aliasFs.readBytes("/seed"), aliasSnapshot);
  const mounted = createShell({ files: remount, profile: "freebsd" });
  assert.equal((await mounted.exec("cat /home/rad/note.txt")).stdout, "koala\ndingo\n");
  remount.remove("/home/rad", { recursive: true });
  assert.equal(remount.exists("/home/rad"), false);
  console.log("shell.js blockfs: ok");
}

{
  let stored = new ArrayBuffer(0);
  const fileHandle = {
    async createWritable() {
      let pending;
      return {
        async close() {
          stored = pending;
        },
        async write(value) {
          pending = value.slice(0);
        },
      };
    },
    async getFile() {
      return { arrayBuffer: async () => stored.slice(0), size: stored.byteLength };
    },
  };
  const persistent = await openBlockFS(fileHandle, { blockSize: 512, blocks: 64 });
  persistent.fs.writeBytes("/binary", Uint8Array.of(0, 255, 1));
  await persistent.flush();
  const reopened = await openBlockFS(fileHandle, { blockSize: 512, blocks: 64 });
  assert.deepEqual(reopened.fs.readBytes("/binary"), Uint8Array.of(0, 255, 1));

  let releaseFirst;
  let firstCloseStarted;
  const firstClosing = new Promise((resolve) => {
    firstCloseStarted = resolve;
  });
  let orderedStored = new ArrayBuffer(0);
  let writer = 0;
  const orderedHandle = {
    async createWritable() {
      const index = writer++;
      let image;
      return {
        async close() {
          if (index === 0) {
            firstCloseStarted();
            await new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
          orderedStored = image;
        },
        async write(value) {
          image = value.slice(0);
        },
      };
    },
    async getFile() {
      return { arrayBuffer: async () => orderedStored.slice(0), size: orderedStored.byteLength };
    },
  };
  const ordered = await openBlockFS(orderedHandle, { blockSize: 512, blocks: 64 });
  ordered.fs.write("/version", "old");
  const olderFlush = ordered.flush();
  await firstClosing;
  ordered.fs.write("/version", "new");
  const newerFlush = ordered.flush();
  releaseFirst();
  await Promise.all([olderFlush, newerFlush]);
  assert.equal((await openBlockFS(orderedHandle, { blockSize: 512, blocks: 64 })).fs.read("/version"), "new");

  await assert.rejects(() => openBlockFS({}), /fileHandle must be writable/);
  const validImage = stored.slice(0);
  stored = new ArrayBuffer(512 * 64);
  await assert.rejects(() => openBlockFS(fileHandle, { blockSize: 512, blocks: 64 }), /invalid block image/);
  stored = validImage.slice(0);
  new DataView(stored).setUint32(512 + 32 + 4, 33, true);
  await assert.rejects(() => openBlockFS(fileHandle, { blockSize: 512, blocks: 64 }), /invalid block image/);
  stored = validImage.slice(0);
  let imageView = new DataView(stored);
  let rootBlock = imageView.getUint32(512 + 32 + 12, true);
  imageView.setUint32(rootBlock * 512, 1, true);
  await assert.rejects(() => openBlockFS(fileHandle, { blockSize: 512, blocks: 64 }), /invalid block image/);
  stored = validImage.slice(0);
  imageView = new DataView(stored);
  rootBlock = imageView.getUint32(512 + 32 + 12, true);
  imageView.setUint32(rootBlock * 512 + 508, rootBlock, true);
  await assert.rejects(() => openBlockFS(fileHandle, { blockSize: 512, blocks: 64 }), /invalid block image/);
  stored = validImage.slice(0);
  imageView = new DataView(stored);
  rootBlock = imageView.getUint32(512 + 32 + 12, true);
  const childInode = imageView.getUint32(rootBlock * 512, true);
  const childBlock = imageView.getUint32(512 + childInode * 32 + 12, true);
  imageView.setUint32(childBlock * 512 + 508, childBlock + 1, true);
  await assert.rejects(() => openBlockFS(fileHandle, { blockSize: 512, blocks: 64 }), /invalid block image/);
  console.log("shell.js opfs: ok");
}

{
  // movabs rax, 1; movabs rdi, 42; syscall  (exit-style halt via null syscall result)
  const program = Uint8Array.from([
    0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 42, 0, 0, 0, 0, 0, 0, 0, 0x48, 0x83, 0xc0, 7, 0x48, 0x83, 0xe8, 3,
    0x0f, 0x05,
  ]);
  let saw = null;
  const cpu = createX86({
    onSyscall: ({ nr, args }) => {
      saw = { nr, args: [...args] };
      return null;
    },
  });
  cpu.load(program);
  cpu.run();
  assert.equal(saw?.nr, 5n);
  assert.equal(saw?.args[0], 42n);
  assert.equal(cpu.halted, true);
  console.log("shell.js x86: ok");
}

{
  const sib = createX86();
  sib.load(Uint8Array.from([0x48, 0x8b, 0x04, 0x24])); // mov rax, [rsp]
  sib.memory.u64(65_528n, 42n);
  sib.step();
  assert.equal(sib.registers().rax, 42n);

  const relative = createX86();
  relative.load(Uint8Array.from([0x48, 0x8b, 0x05, 0, 0, 0, 0])); // mov rax, [rip]
  relative.memory.u64(7n, 43n);
  relative.step();
  assert.equal(relative.registers().rax, 43n);

  const flags = createX86();
  flags.load(
    Uint8Array.from([
      0x48, 0xb8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x48, 0x83, 0xc0, 1, 0x48, 0xb8, 0, 0, 0, 0, 0, 0, 0,
      0, 0x48, 0x83, 0xe8, 1, 0x48, 0xff, 0xc0,
    ]),
  );
  flags.step();
  flags.step();
  assert.notEqual(flags.registers().rflags & FLAGS.OF, 0n);
  flags.step();
  flags.step();
  assert.notEqual(flags.registers().rflags & FLAGS.CF, 0n);
  flags.step();
  assert.notEqual(flags.registers().rflags & FLAGS.CF, 0n);

  const narrow = createX86();
  narrow.load(
    Uint8Array.from([
      0x48, 0xb8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xb8, 1, 0, 0, 0, 0x83, 0xe8, 1, 0x83, 0xe8, 1,
    ]),
  );
  narrow.step();
  narrow.step();
  assert.equal(narrow.registers().rax, 1n);
  narrow.step();
  assert.notEqual(narrow.registers().rflags & FLAGS.ZF, 0n);
  assert.notEqual(narrow.registers().rflags & FLAGS.PF, 0n);
  narrow.step();
  assert.equal(narrow.registers().rax, 0xffffffffn);
  assert.notEqual(narrow.registers().rflags & FLAGS.CF, 0n);
  assert.notEqual(narrow.registers().rflags & FLAGS.SF, 0n);

  const narrowMemory = createX86();
  narrowMemory.load(
    Uint8Array.from([0x48, 0xb8, 0, 2, 0, 0, 0, 0, 0, 0, 0xb9, 0x44, 0x33, 0x22, 0x11, 0x89, 0x08, 0x8b, 0x10]),
  );
  narrowMemory.memory.u64(512n, 0xaaaaaaaaaaaaaaaan);
  for (let step = 0; step < 4; step++) narrowMemory.step();
  assert.equal(narrowMemory.memory.u64(512n), 0xaaaaaaaa11223344n);
  assert.equal(narrowMemory.registers().rdx, 0x11223344n);

  const bytes = createX86();
  bytes.load(
    Uint8Array.from([
      0xb8, 0x78, 0x56, 0x34, 0x12, 0xb9, 0xab, 0, 0, 0, 0x88, 0xc8, 0x0f, 0xb6, 0xd0, 0x88, 0xcc, 0x0f, 0xbe, 0xf0,
    ]),
  );
  for (let step = 0; step < 6; step++) bytes.step();
  assert.equal(bytes.registers().rax, 0x1234ababn);
  assert.equal(bytes.registers().rdx, 0xabn);
  assert.equal(bytes.registers().rsi, 0xffffffabn);

  const predicates = createX86();
  predicates.load(
    Uint8Array.from([
      0xb8, 0, 0, 0, 0, 0x85, 0xc0, 0x0f, 0x94, 0xc1, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff, 0xa9, 1, 0, 0, 0, 0x0f, 0x95,
      0xc2,
    ]),
  );
  for (let step = 0; step < 6; step++) predicates.step();
  assert.equal(predicates.registers().rcx, 1n);
  assert.equal(predicates.registers().rdx, 1n);

  const multiply = createX86();
  multiply.load(Uint8Array.from([0xb8, 0xff, 0xff, 0xff, 0x7f, 0xb9, 2, 0, 0, 0, 0x0f, 0xaf, 0xc1]));
  multiply.step();
  multiply.step();
  multiply.step();
  assert.equal(multiply.registers().rax, 0xfffffffen);
  assert.notEqual(multiply.registers().rflags & FLAGS.CF, 0n);
  assert.notEqual(multiply.registers().rflags & FLAGS.OF, 0n);

  const indirect = createX86();
  indirect.load(
    Uint8Array.from([0x48, 0xb8, 16, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd0, 0x90, 0x90, 0x90, 0x90, 0xb8, 7, 0, 0, 0, 0xc3]),
  );
  const stack = indirect.registers().rsp;
  for (let step = 0; step < 5; step++) indirect.step();
  assert.equal(indirect.registers().rax, 7n);
  assert.equal(indirect.registers().rsp, stack);

  const tls = createX86();
  const tlsCalls = createSyscalls();
  assert.equal(tlsCalls.handle({ nr: 158n, args: [0x1002n, 512n], cpu: tls }), 0n);
  tls.memory.u64(520n, 0x1122334455667788n);
  tls.load(Uint8Array.from([0x64, 0x48, 0x8b, 0x04, 0x25, 8, 0, 0, 0]));
  tls.step();
  assert.equal(tls.registers().rax, 0x1122334455667788n);
  tls.load(Uint8Array.from([0x64, 0x48, 0x8d, 0x04, 0x25, 8, 0, 0, 0]));
  tls.step();
  assert.equal(tls.registers().rax, 8n);
  assert.equal(tlsCalls.handle({ nr: 158n, args: [0x1003n, 600n], cpu: tls }), 0n);
  assert.equal(tls.memory.u64(600n), 512n);

  const frame = createX86();
  frame.load(Uint8Array.from([0x55, 0x48, 0x89, 0xe5, 0xc9, 0x6a, 0xff, 0x58]));
  const frameStack = frame.registers().rsp;
  for (let step = 0; step < 3; step++) frame.step();
  assert.equal(frame.registers().rbp, 0n);
  assert.equal(frame.registers().rsp, frameStack);
  frame.step();
  assert.equal(frame.registers().rsp, frameStack - 8n);
  frame.step();
  assert.equal(frame.registers().rax, 0xffffffffffffffffn);
  assert.equal(frame.registers().rsp, frameStack);
}

{
  // movz x0, #42; movz x8, #1; add x8, x8, #4; svc #0
  const program = Uint8Array.from([
    0x40, 0x05, 0x80, 0xd2, 0x28, 0x00, 0x80, 0xd2, 0x08, 0x11, 0x00, 0x91, 0x01, 0x00, 0x00, 0xd4,
  ]);
  let saw = null;
  const cpu = createArm({
    onSyscall: ({ nr, args }) => {
      saw = { nr, args: [...args] };
      return null;
    },
  });
  cpu.load(program);
  cpu.run();
  assert.equal(saw?.nr, 5n);
  assert.equal(saw?.args[0], 42n);
  assert.equal(cpu.halted, true);
  console.log("shell.js arm: ok");
}

{
  // movz x16, #42; add x16, x16, #1; cmp x16, #43; add sp, sp, #16
  const cpu = createArm();
  cpu.load(
    Uint8Array.from([0x50, 0x05, 0x80, 0xd2, 0x10, 0x06, 0x00, 0x91, 0x1f, 0xae, 0x00, 0xf1, 0xff, 0x43, 0x00, 0x91]),
  );
  for (let step = 0; step < 4; step++) cpu.step();
  assert.equal(cpu.registers().x16, 43n);
  assert.equal(cpu.registers().x4, 0n);
  assert.equal(cpu.registers().sp, 65_536n);
  assert.notEqual(cpu.registers().nzcv & (1n << 30n), 0n);
  assert.notEqual(cpu.registers().nzcv & (1n << 29n), 0n);

  const reservedImmediate = createArm();
  reservedImmediate.load(armBytes([0x91800400]));
  assert.throws(() => reservedImmediate.step(), /invalid ADD\/SUB immediate/);
  const reservedBitfield = createArm();
  reservedBitfield.load(armBytes([0x53207c00]));
  assert.throws(() => reservedBitfield.step(), /invalid 32-bit bitfield/);

  const returned = createArm();
  returned.load(Uint8Array.from([0x10, 0x01, 0x80, 0xd2, 0x00, 0x02, 0x5f, 0xd6, 0x1f, 0x20, 0x03, 0xd5]));
  returned.step();
  returned.step();
  assert.equal(returned.registers().pc, 8n);

  const narrow = createArm();
  const narrowProgram = armBytes([
    0x529fffe0, // movz w0, #0xffff
    0x72a24680, // movk w0, #0x1234, lsl #16
    0x31000401, // adds w1, w0, #1
    0xd2804002, // movz x2, #512
    0xb9000040, // str w0, [x2]
    0xb9400043, // ldr w3, [x2]
  ]);
  narrow.load(narrowProgram);
  narrow.memory.u64(512n, 0xaaaaaaaaaaaaaaaan);
  for (let step = 0; step < 6; step++) narrow.step();
  assert.equal(narrow.registers().x0, 0x1234ffffn);
  assert.equal(narrow.registers().x1, 0x12350000n);
  assert.equal(narrow.registers().x3, 0x1234ffffn);
  assert.equal(narrow.memory.u64(512n), 0xaaaaaaaa1234ffffn);

  const carry = createArm();
  const carryProgram = armBytes([0x529fffe0, 0x72bfffe0, 0x31000401]);
  carry.load(carryProgram);
  carry.step();
  carry.step();
  carry.step();
  assert.equal(carry.registers().x1, 0n);
  assert.notEqual(carry.registers().nzcv & (1n << 30n), 0n);
  assert.notEqual(carry.registers().nzcv & (1n << 29n), 0n);

  const frame = createArm();
  const frameProgram = armBytes([
    0xd282223d, // movz x29, #0x1111
    0xd284445e, // movz x30, #0x2222
    0xa9bf7bfd, // stp x29, x30, [sp, #-16]!
    0xd280001d, // movz x29, #0
    0xd280001e, // movz x30, #0
    0xa8c17bfd, // ldp x29, x30, [sp], #16
  ]);
  frame.load(frameProgram);
  const frameStack = frame.registers().sp;
  for (let step = 0; step < 6; step++) frame.step();
  assert.equal(frame.registers().x29, 0x1111n);
  assert.equal(frame.registers().x30, 0x2222n);
  assert.equal(frame.registers().sp, frameStack);

  const pairOffset = createArm();
  pairOffset.load(
    armBytes([
      0xd2822220, // movz x0, #0x1111
      0xd2844441, // movz x1, #0x2222
      0xd2804002, // movz x2, #512
      0xa9010440, // stp x0, x1, [x2, #16]
      0xa9411043, // ldp x3, x4, [x2, #16]
    ]),
  );
  for (let step = 0; step < 5; step++) pairOffset.step();
  assert.equal(pairOffset.memory.u64(512n), 0n);
  assert.equal(pairOffset.registers().x3, 0x1111n);
  assert.equal(pairOffset.registers().x4, 0x2222n);

  const relative = createArm();
  const relativeProgram = armBytes([
    0x10000040, // adr x0, #8
    0xb4000041, // cbz x1, +8
    0xd2800022, // movz x2, #1
    0xd2800042, // movz x2, #2
  ]);
  relative.load(relativeProgram);
  relative.step();
  relative.step();
  relative.step();
  assert.equal(relative.registers().x0, 8n);
  assert.equal(relative.registers().x2, 2n);

  const literal = createArm();
  literal.load(
    Uint8Array.from([0x40, 0x00, 0x00, 0x58, 0x1f, 0x20, 0x03, 0xd5, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]),
  );
  literal.step();
  assert.equal(literal.registers().x0, 0x1122334455667788n);

  const tls = createArm();
  const tlsProgram = armBytes([0xd2804000, 0xd51bd040, 0xd53bd041]);
  tls.load(tlsProgram);
  tls.step();
  tls.step();
  tls.step();
  assert.equal(tls.registers().x1, 512n);
  assert.equal(tls.registers().tpidr_el0, 512n);

  const arithmetic = createArm();
  const arithmeticProgram = armBytes([
    0xd28000c1,
    0xd28000e2,
    0x9b027c20, // mul x0, x1, x2
    0xd2800a84,
    0xd2800045,
    0x9ac50883, // udiv x3, x4, x5
    0xd280006a,
    0xd37df149, // lsl x9, x10, #3
    0x5280200c,
    0x53057d8b, // lsr w11, w12, #5
    0xd2800030,
    0xd2800051,
    0xf100a81f, // cmp x0, #42
    0x9a91020f, // csel x15, x16, x17, eq
  ]);
  arithmetic.load(arithmeticProgram);
  for (let step = 0; step < 14; step++) arithmetic.step();
  assert.equal(arithmetic.registers().x0, 42n);
  assert.equal(arithmetic.registers().x3, 42n);
  assert.equal(arithmetic.registers().x9, 24n);
  assert.equal(arithmetic.registers().x11, 8n);
  assert.equal(arithmetic.registers().x15, 1n);

  const bitBranch = createArm();
  const bitBranchProgram = armBytes([0x36280052, 0xd2800033, 0xd2800053]);
  bitBranch.load(bitBranchProgram);
  bitBranch.step();
  bitBranch.step();
  assert.equal(bitBranch.registers().x19, 2n);

  const smallMemory = createArm();
  const smallMemoryProgram = armBytes([
    0xd2824680,
    0xd2804101,
    0xf81f8020, // stur x0, [x1, #-8]
    0xd2803f83,
    0xb8404062, // ldur w2, [x3, #4]
    0x52801564,
    0xd2804b05,
    0x390008a4, // strb w4, [x5, #2]
    0xd2804ae7,
    0x39400ce6, // ldrb w6, [x7, #3]
  ]);
  smallMemory.load(smallMemoryProgram);
  smallMemory.memory.u64(512n, 0n);
  for (let step = 0; step < 10; step++) smallMemory.step();
  assert.equal(smallMemory.memory.u64(512n), 0x1234n);
  assert.equal(smallMemory.registers().x2, 0x1234n);
  assert.equal(smallMemory.memory.u8(602n), 0xab);
  assert.equal(smallMemory.registers().x6, 0xabn);
}

{
  const program = Uint8Array.from([
    0x48,
    0xb9,
    0xe8,
    3,
    0,
    0,
    0,
    0,
    0,
    0, // mov rcx, 1000
    0x48,
    0x83,
    0xe9,
    1, // sub rcx, 1
    0x75,
    0xfa, // jne -6
    0x48,
    0xb8,
    60,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // mov rax, 60
    0x0f,
    0x05, // syscall
  ]);
  const interpreted = createX86({ jit: false, onSyscall: () => null });
  interpreted.load(program);
  interpreted.run();
  const compiled = createX86({ onSyscall: () => null });
  compiled.load(program);
  compiled.run();
  assert.deepEqual(compiled.registers(), interpreted.registers());
  assert.equal(compiled.steps, interpreted.steps);
  assert.ok(compiled.jit.compiled > 0 && compiled.jit.executions > 0);
  const compiledBlocks = compiled.jit.compiled;
  compiled.memory.u8(8192n, 1);
  compiled.reset();
  compiled.run();
  assert.equal(compiled.jit.compiled, compiledBlocks);
  const detached = compiled.memory.bytes();
  detached[0] = 0;
  assert.equal(compiled.memory.u8(0n), 0x48);
  compiled.memory.u8(2n, 2);
  compiled.memory.u8(3n, 0);
  compiled.reset();
  compiled.run();
  assert.equal(compiled.steps, 7);
  assert.equal(compiled.registers().rcx, 0n);

  const armProgram = armBytes([0xd2807d00, 0xf1000400, 0x54ffffe1, 0xd2800ba8, 0xd4000001]);
  const armInterpreted = createArm({ jit: false, onSyscall: () => null });
  armInterpreted.load(armProgram);
  armInterpreted.run();
  const armCompiled = createArm({ onSyscall: () => null });
  armCompiled.load(armProgram);
  armCompiled.run();
  assert.deepEqual(armCompiled.registers(), armInterpreted.registers());
  assert.equal(armCompiled.steps, armInterpreted.steps);
  assert.ok(armCompiled.jit.compiled > 0 && armCompiled.jit.executions > 0);

  const x86Alu = Uint8Array.from([
    0x48, 0xb8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x48, 0xb9, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0x01, 0xc8,
    0x48, 0x09, 0xc8, 0x48, 0x21, 0xc8, 0x48, 0x31, 0xc8, 0x48, 0x29, 0xc8, 0x48, 0x39, 0xc8, 0x48, 0xb8, 60, 0, 0, 0,
    0, 0, 0, 0, 0x0f, 0x05,
  ]);
  const coldAlu = createX86({ jit: false, onSyscall: () => null });
  coldAlu.load(x86Alu);
  coldAlu.run();
  const hotAlu = createX86({ onSyscall: () => null });
  hotAlu.load(x86Alu);
  for (let run = 0; run < 70; run++) {
    hotAlu.reset();
    hotAlu.run();
  }
  assert.deepEqual(hotAlu.registers(), coldAlu.registers());
  assert.ok(hotAlu.jit.compiled > 0);

  const immediate64 = (value) =>
    Array.from({ length: 8 }, (_, index) => Number((BigInt.asUintN(64, value) >> BigInt(index * 8)) & 0xffn));
  const compareHotX86 = (condition, left, right) => {
    const branch = Uint8Array.from([
      0x48,
      0xb8,
      ...immediate64(left),
      0x48,
      0xb9,
      ...immediate64(right),
      0x48,
      0x39,
      0xc8,
      0x70 | condition,
      12,
      0x48,
      0xbb,
      ...immediate64(1n),
      0xeb,
      10,
      0x48,
      0xbb,
      ...immediate64(2n),
      0x48,
      0xb8,
      ...immediate64(60n),
      0x0f,
      0x05,
    ]);
    const cold = createX86({ jit: false, onSyscall: () => null });
    cold.load(branch);
    cold.run();
    const hot = createX86({ onSyscall: () => null });
    hot.load(branch);
    for (let run = 0; run < 65; run++) {
      hot.reset();
      hot.run();
    }
    assert.deepEqual(hot.registers(), cold.registers(), `x86 Jcc ${condition.toString(16)}`);
    assert.ok(hot.jit.executions > 0, `x86 Jcc ${condition.toString(16)} did not compile`);
    return cold.registers().rbx;
  };
  for (const [left, right] of [
    [0n, 0n],
    [0n, 1n],
    [1n, 0n],
    [0x7fffffffffffffffn, 0xffffffffffffffffn],
  ]) {
    for (let condition = 0; condition < 16; condition++) compareHotX86(condition, left, right);
  }
  assert.equal(compareHotX86(0xa, 0n, 0n), 2n);
  assert.equal(compareHotX86(0xb, 0n, 0n), 1n);
  assert.equal(compareHotX86(0xa, 1n, 0n), 1n);
  assert.equal(compareHotX86(0xb, 1n, 0n), 2n);

  const armImmediate = (register, value) => [
    0xd2800000 | (Number(value & 0xffffn) << 5) | register,
    0xf2a00000 | (Number((value >> 16n) & 0xffffn) << 5) | register,
    0xf2c00000 | (Number((value >> 32n) & 0xffffn) << 5) | register,
    0xf2e00000 | (Number((value >> 48n) & 0xffffn) << 5) | register,
  ];
  const compareHotArm = (condition, left, right) => {
    const branch = armBytes([
      ...armImmediate(0, left),
      ...armImmediate(1, right),
      0xeb01001f,
      0x54000060 | condition,
      0xd2800022,
      0x14000002,
      0xd2800042,
      0xd2800ba8,
      0xd4000001,
    ]);
    const cold = createArm({ jit: false, onSyscall: () => null });
    cold.load(branch);
    cold.run();
    const hot = createArm({ onSyscall: () => null });
    hot.load(branch);
    for (let run = 0; run < 65; run++) {
      hot.reset();
      hot.run();
    }
    assert.deepEqual(hot.registers(), cold.registers(), `AArch64 B.cond ${condition.toString(16)}`);
    assert.ok(hot.jit.executions > 0, `AArch64 B.cond ${condition.toString(16)} did not compile`);
  };
  for (const [left, right] of [
    [0n, 0n],
    [0n, 1n],
    [0x7fffffffffffffffn, 0xffffffffffffffffn],
  ]) {
    for (let condition = 0; condition < 16; condition++) compareHotArm(condition, left, right);
  }

  const x86Add = Uint8Array.from([
    0x48,
    0xb8,
    ...immediate64(0xffffffffffffffffn),
    0x48,
    0xb9,
    ...immediate64(1n),
    0x48,
    0x01,
    0xc8,
    0x48,
    0xb8,
    ...immediate64(60n),
    0x0f,
    0x05,
  ]);
  const coldAdd = createX86({ jit: false, onSyscall: () => null });
  coldAdd.load(x86Add);
  coldAdd.run();
  const hotAdd = createX86({ onSyscall: () => null });
  hotAdd.load(x86Add);
  for (let run = 0; run < 65; run++) {
    hotAdd.reset();
    hotAdd.run();
  }
  assert.deepEqual(hotAdd.registers(), coldAdd.registers());

  const armAdd = armBytes([
    ...armImmediate(0, 0xffffffffffffffffn),
    ...armImmediate(1, 1n),
    0xab010002,
    0xd2800ba8,
    0xd4000001,
  ]);
  const coldArmAdd = createArm({ jit: false, onSyscall: () => null });
  coldArmAdd.load(armAdd);
  coldArmAdd.run();
  const hotArmAdd = createArm({ onSyscall: () => null });
  hotArmAdd.load(armAdd);
  for (let run = 0; run < 65; run++) {
    hotArmAdd.reset();
    hotArmAdd.run();
  }
  assert.deepEqual(hotArmAdd.registers(), coldArmAdd.registers());

  const boundedLoop = createX86();
  boundedLoop.load(Uint8Array.from([0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0x83, 0xe8, 0, 0x75, 0xfa]));
  assert.throws(() => boundedLoop.run({ maxSteps: 131 }), /step limit exceeded/);
  assert.equal(boundedLoop.steps, 131);
  assert.ok(boundedLoop.jit.instructions > 0);

  const asynchronous = createX86({ onSyscall: () => null });
  asynchronous.load(program);
  let yields = 0;
  await asynchronous.runAsync({
    maxSteps: 3000,
    quantum: 100,
    yield: async () => {
      yields++;
    },
  });
  assert.ok(yields > 0);
  assert.equal(asynchronous.halted, true);

  const interrupted = createX86();
  interrupted.load(Uint8Array.from([0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0x83, 0xe8, 0, 0x75, 0xfa]));
  const controller = new AbortController();
  await assert.rejects(
    interrupted.runAsync({
      maxSteps: 10_000,
      quantum: 10,
      signal: controller.signal,
      yield: async () => controller.abort(new Error("stopped")),
    }),
    /stopped/,
  );
  console.log("shell.js jit: ok");
}

{
  const output = [];
  const system = createSyscalls({
    abi: "linux-x86_64",
    write: (_fd, bytes) => output.push(...bytes),
  });
  const cpu = createX86({ onSyscall: system.handle });
  cpu.load(
    Uint8Array.from([
      0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbe, 64, 0, 0, 0, 0, 0, 0, 0, 0x48,
      0xba, 3, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05, 0x48, 0xb8, 60, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 7, 0, 0, 0, 0, 0, 0, 0,
      0x0f, 0x05, 104, 105, 10,
    ]),
  );
  cpu.run();
  assert.equal(new TextDecoder().decode(Uint8Array.from(output)), "hi\n");
  assert.equal(system.exitCode, 7);
}

{
  const output = [];
  const system = createSyscalls({
    abi: "linux-aarch64",
    write: (_fd, bytes) => output.push(...bytes),
  });
  const cpu = createArm({ onSyscall: system.handle });
  cpu.load(
    Uint8Array.from([
      0x20, 0x00, 0x80, 0xd2, 0x01, 0x04, 0x80, 0xd2, 0x62, 0x00, 0x80, 0xd2, 0x08, 0x08, 0x80, 0xd2, 0x01, 0x00, 0x00,
      0xd4, 0xe0, 0x00, 0x80, 0xd2, 0xa8, 0x0b, 0x80, 0xd2, 0x01, 0x00, 0x00, 0xd4, 104, 105, 10,
    ]),
  );
  cpu.run();
  assert.equal(new TextDecoder().decode(Uint8Array.from(output)), "hi\n");
  assert.equal(system.exitCode, 7);
}

{
  const files = new MemoryFS({ "/note": "abc" });
  files.writeBytes("/raw", Uint8Array.of(0, 255, 1));
  assert.deepEqual(files.readBytes("/raw"), Uint8Array.of(0, 255, 1));
  const system = createSyscalls({ fs: files });
  const cpu = createX86();
  cpu.memory.load(new TextEncoder().encode("/note\0"), 128n);
  const fd = system.handle({ nr: 2n, args: [128n, 0n], cpu });
  assert.equal(fd, 3n);
  assert.equal(system.handle({ nr: 0n, args: [fd, 256n, 3n], cpu }), 3n);
  assert.equal(new TextDecoder().decode(cpu.memory.bytes().subarray(256, 259)), "abc");
  assert.equal(system.handle({ nr: 8n, args: [fd, 0n, 0n], cpu }), 0n);
  assert.equal(system.handle({ nr: 3n, args: [fd], cpu }), 0n);
  assert.equal(system.handle({ nr: 0n, args: [fd, 0n, 1n], cpu }), -9n);
  assert.equal(system.handle({ nr: 1n, args: [1n, 65_535n, 2n], cpu }), -14n);
  cpu.memory.u8(65_535n, 97);
  assert.equal(system.handle({ nr: 2n, args: [65_535n, 0n], cpu }), -14n);
  assert.equal(system.handle({ nr: 2n, args: [65_536n, 0n], cpu }), -14n);
  assert.equal(system.handle({ nr: 999n, args: [], cpu }), -38n);
  assert.equal(createSyscalls().handle({ nr: 2n, args: [128n, 0n], cpu }), -13n);

  let pathReadBytes;
  const boundedPath = createSyscalls({ fs: files });
  const boundedMemory = {
    size: 64 * 1024 * 1024,
    read(_address, length) {
      pathReadBytes = length;
      const bytes = new Uint8Array(length);
      bytes.set(new TextEncoder().encode("/note\0"));
      return bytes;
    },
  };
  assert.equal(boundedPath.handle({ nr: 2n, args: [0n, 0n], cpu: { memory: boundedMemory } }), 3n);
  assert.equal(pathReadBytes, 4096);

  const pathOffset = 4000n;
  cpu.memory.write(pathOffset, new TextEncoder().encode(`/${"a".repeat(4094)}\0`));
  assert.equal(createSyscalls({ fs: files }).handle({ nr: 2n, args: [pathOffset, 0n], cpu }), -2n);
  cpu.memory.write(pathOffset, new TextEncoder().encode(`/${"a".repeat(4095)}\0`));
  assert.equal(createSyscalls({ fs: files }).handle({ nr: 2n, args: [pathOffset, 0n], cpu }), -36n);
  cpu.memory.write(pathOffset, new TextEncoder().encode(`/${"a".repeat(1022)}\0`));
  assert.deepEqual(
    createSyscalls({ abi: "freebsd-x86_64", fs: files }).handle({ nr: 5n, args: [pathOffset, 0n], cpu }),
    {
      value: 2n,
      error: true,
    },
  );
  cpu.memory.write(pathOffset, new TextEncoder().encode(`/${"a".repeat(1023)}\0`));
  assert.deepEqual(
    createSyscalls({ abi: "freebsd-x86_64", fs: files }).handle({ nr: 5n, args: [pathOffset, 0n], cpu }),
    {
      value: 63n,
      error: true,
    },
  );

  const descriptorFiles = new MemoryFS({ "/keep": "old" });
  const descriptorLimit = createSyscalls({ fs: descriptorFiles, maxFiles: 4 });
  cpu.memory.write(1800n, new TextEncoder().encode("/keep\0/new\0"));
  assert.equal(descriptorLimit.handle({ nr: 2n, args: [1800n, 0n], cpu }), 3n);
  assert.equal(descriptorLimit.handle({ nr: 2n, args: [1806n, 0x41n], cpu }), -24n);
  assert.equal(descriptorFiles.exists("/new"), false);
  assert.equal(descriptorLimit.handle({ nr: 2n, args: [1800n, 0x201n], cpu }), -24n);
  assert.equal(descriptorFiles.read("/keep"), "old");
  assert.equal(descriptorLimit.handle({ nr: 2n, args: [1800n, 0x200n], cpu }), -13n);
  assert.equal(descriptorFiles.read("/keep"), "old");
  const recoveredDescriptor = createSyscalls({ fs: descriptorFiles, maxFiles: 4 });
  assert.equal(recoveredDescriptor.handle({ nr: 2n, args: [1806n, 0n], cpu }), -2n);
  assert.equal(recoveredDescriptor.handle({ nr: 2n, args: [1800n, 0n], cpu }), 3n);
  assert.equal(createSyscalls({ fs: descriptorFiles }).handle({ nr: 2n, args: [1800n, 0xc0n], cpu }), -17n);
  assert.deepEqual(
    createSyscalls({ abi: "freebsd-x86_64", fs: descriptorFiles }).handle({ nr: 5n, args: [1800n, 0xa00n], cpu }),
    { value: 17n, error: true },
  );

  const sparseFiles = new MemoryFS({ "/sparse": "old" });
  const sparse = createSyscalls({ fs: sparseFiles, maxFileBytes: 4 });
  cpu.memory.write(2100n, new TextEncoder().encode("/sparse\0x"));
  const sparseFd = sparse.handle({ nr: 2n, args: [2100n, 1n], cpu });
  assert.equal(
    sparse.handle({ nr: 8n, args: [sparseFd, BigInt(Number.MAX_SAFE_INTEGER), 0n], cpu }),
    9_007_199_254_740_991n,
  );
  assert.equal(sparse.handle({ nr: 1n, args: [sparseFd, 2108n, 1n], cpu }), -27n);
  assert.equal(sparseFiles.read("/sparse"), "old");

  const quotaFiles = new MemoryFS({ "/full": "x" }, { maxFiles: 2, maxFileBytes: 1, maxTotalBytes: 1 });
  cpu.memory.write(1900n, new TextEncoder().encode("/full\0yz"));
  const linuxQuota = createSyscalls({ fs: quotaFiles });
  const linuxQuotaFd = linuxQuota.handle({ nr: 2n, args: [1900n, 1n], cpu });
  assert.equal(linuxQuota.handle({ nr: 1n, args: [linuxQuotaFd, 1906n, 2n], cpu }), -122n);
  const freebsdQuota = createSyscalls({ abi: "freebsd-x86_64", fs: quotaFiles });
  const freebsdQuotaFd = freebsdQuota.handle({ nr: 5n, args: [1900n, 1n], cpu });
  assert.deepEqual(freebsdQuota.handle({ nr: 4n, args: [freebsdQuotaFd.value, 1906n, 2n], cpu }), {
    value: 69n,
    error: true,
  });
  assert.equal(quotaFiles.read("/full"), "x");

  const metadata = createSyscalls({ fs: files });
  const metadataFd = metadata.handle({ nr: 2n, args: [128n, 0n], cpu });
  assert.equal(metadata.handle({ nr: 17n, args: [metadataFd, 2600n, 2n, 1n], cpu }), 2n);
  assert.equal(new TextDecoder().decode(cpu.memory.read(2600n, 2)), "bc");
  assert.equal(metadata.handle({ nr: 0n, args: [metadataFd, 2602n, 1n], cpu }), 1n);
  assert.equal(new TextDecoder().decode(cpu.memory.read(2602n, 1)), "a");
  assert.equal(metadata.handle({ nr: 5n, args: [metadataFd, 3000n], cpu }), 0n);
  assert.equal(metadata.handle({ nr: 262n, args: [-100n, 128n, 3200n, 0n], cpu }), 0n);
  cpu.memory.u8(3600n, 0);
  assert.equal(metadata.handle({ nr: 262n, args: [-100n, 3600n, 3200n, 0n], cpu }), -2n);
  assert.equal(metadata.handle({ nr: 4n, args: [3600n, 3200n], cpu }), -2n);
  const metadataView = new DataView(cpu.memory.buffer);
  assert.equal(metadataView.getUint32(3024, true) & 0o170000, 0o100000);
  assert.equal(metadataView.getBigUint64(3048, true), 3n);

  const armMetadata = createSyscalls({ abi: "linux-aarch64", fs: files });
  assert.equal(armMetadata.handle({ nr: 79n, args: [-100n, 128n, 3400n, 0n], cpu }), 0n);
  assert.equal(new DataView(cpu.memory.buffer).getUint32(3416, true) & 0o170000, 0o100000);

  files.mkdir("/work");
  cpu.memory.write(1400n, new TextEncoder().encode("/work\0"));
  assert.equal(metadata.handle({ nr: 80n, args: [1400n], cpu }), 0n);
  assert.equal(metadata.cwd, "/work");
  assert.equal(metadata.handle({ nr: 79n, args: [1500n, 16n], cpu }), 6n);
  assert.equal(new TextDecoder().decode(cpu.memory.read(1500n, 5)), "/work");
  assert.equal(metadata.handle({ nr: 79n, args: [1500n, 2n], cpu }), -34n);
  assert.equal(metadata.handle({ nr: 80n, args: [3600n], cpu }), -2n);
  const freebsdMetadata = createSyscalls({ abi: "freebsd-x86_64", fs: files, cwd: "/work" });
  assert.deepEqual(freebsdMetadata.handle({ nr: 326n, args: [1500n, 16n], cpu }), {
    value: 0n,
    error: false,
  });
  assert.equal(new TextDecoder().decode(cpu.memory.read(1500n, 5)), "/work");

  const chunks = [];
  const vectors = createSyscalls({ write: (_fd, bytes) => chunks.push(bytes.slice()) });
  cpu.memory.write(320n, new TextEncoder().encode("hello"));
  cpu.memory.write(400n, new TextEncoder().encode(" world"));
  cpu.memory.u64(256n, 320n);
  cpu.memory.u64(264n, 5n);
  cpu.memory.u64(272n, 400n);
  cpu.memory.u64(280n, 6n);
  assert.equal(vectors.handle({ nr: 20n, args: [1n, 256n, 2n], cpu }), 11n);
  assert.equal(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))), "hello world");
  assert.equal(vectors.handle({ nr: 20n, args: [1n, 256n, 1025n], cpu }), -22n);

  const inputVectors = createSyscalls({ stdin: "abcdef" });
  assert.equal(inputVectors.handle({ nr: 19n, args: [0n, 256n, 2n], cpu }), 6n);
  assert.equal(new TextDecoder().decode(cpu.memory.read(320n, 5)), "abcde");
  assert.equal(new TextDecoder().decode(cpu.memory.read(400n, 1)), "f");

  const processCalls = createSyscalls({
    clock: () => 1234.5,
    gid: 2000,
    pid: 42,
    random: (bytes) => bytes.fill(0x5a),
    uid: 1000,
  });
  assert.equal(processCalls.handle({ nr: 39n, args: [], cpu }), 42n);
  assert.equal(processCalls.handle({ nr: 102n, args: [], cpu }), 1000n);
  assert.equal(processCalls.handle({ nr: 104n, args: [], cpu }), 2000n);
  assert.equal(processCalls.handle({ nr: 228n, args: [0n, 1024n], cpu }), 0n);
  assert.equal(cpu.memory.u64(1024n), 1n);
  assert.equal(cpu.memory.u64(1032n), 234_500_000n);
  assert.equal(processCalls.handle({ nr: 318n, args: [1100n, 16n, 0n], cpu }), 16n);
  assert.deepEqual(cpu.memory.read(1100n, 16), new Uint8Array(16).fill(0x5a));
  assert.equal(processCalls.handle({ nr: 318n, args: [1100n, 1n, 8n], cpu }), -22n);
  assert.equal(processCalls.handle({ nr: 63n, args: [1200n], cpu }), 0n);
  assert.equal(new TextDecoder().decode(cpu.memory.read(1200n, 5)), "Linux");
  assert.equal(new TextDecoder().decode(cpu.memory.read(1200n + 65n * 4n, 6)), "x86_64");
  cpu.memory.u32(2000n, 99);
  assert.equal(processCalls.handle({ nr: 218n, args: [2000n], cpu }), 42n);
  assert.equal(processCalls.handle({ nr: 60n, args: [3n], cpu }), null);
  assert.equal(cpu.memory.u32(2000n), 0);

  const virtualMemory = createSyscalls({ addressLimit: 60_000n, heapBase: 4096n });
  const mapping = virtualMemory.handle({ nr: 9n, args: [0n, 4096n, 3n, 0x22n, -1n, 0n], cpu });
  assert.equal(mapping, 40_960n);
  cpu.memory.u8(mapping, 0xff);
  assert.equal(virtualMemory.handle({ nr: 10n, args: [mapping, 4096n, 1n], cpu }), 0n);
  assert.equal(virtualMemory.handle({ nr: 9n, args: [mapping, 4096n, 3n, 0x100022n, -1n, 0n], cpu }), -17n);
  assert.equal(virtualMemory.handle({ nr: 12n, args: [8192n], cpu }), 8192n);
  assert.equal(virtualMemory.handle({ nr: 11n, args: [mapping, 4096n], cpu }), 0n);
  assert.equal(cpu.memory.u8(mapping), 0);
  assert.equal(virtualMemory.handle({ nr: 9n, args: [0n, 4096n, 3n, 0x22n, -1n, 0n], cpu }), mapping);

  const replacedMappings = createSyscalls({ addressLimit: 60_000n, heapBase: 4096n });
  assert.equal(replacedMappings.handle({ nr: 9n, args: [0n, 8192n, 3n, 0x22n, -1n, 0n], cpu }), 36_864n);
  assert.equal(replacedMappings.handle({ nr: 9n, args: [40_960n, 4096n, 3n, 0x32n, -1n, 0n], cpu }), 40_960n);
  cpu.memory.u8(40_960n, 0xaa);
  assert.equal(replacedMappings.handle({ nr: 11n, args: [36_864n, 4096n], cpu }), 0n);
  assert.equal(replacedMappings.handle({ nr: 9n, args: [0n, 4096n, 3n, 0x22n, -1n, 0n], cpu }), 36_864n);
  assert.equal(cpu.memory.u8(40_960n), 0xaa);

  const recoveringMappings = createSyscalls({ addressLimit: 60_000n, heapBase: 4096n });
  assert.equal(recoveringMappings.handle({ nr: 9n, args: [0n, 4096n, 1n, 2n, 99n, 0n], cpu }), -9n);
  assert.equal(recoveringMappings.handle({ nr: 9n, args: [0n, 4096n, 3n, 0x22n, -1n, 0n], cpu }), 40_960n);
  assert.equal(recoveringMappings.handle({ nr: 9n, args: [0n, 4096n, 3n, 0x21n, -1n, 0n], cpu }), -22n);

  const mappedFiles = new MemoryFS({ "/image": "map" });
  const fileMappings = createSyscalls({ addressLimit: 60_000n, fs: mappedFiles, heapBase: 4096n });
  cpu.memory.write(3000n, new TextEncoder().encode("/image\0"));
  const mappedFd = fileMappings.handle({ nr: 2n, args: [3000n, 0n], cpu });
  const fileMapping = fileMappings.handle({ nr: 9n, args: [0n, 4096n, 1n, 2n, mappedFd, 0n], cpu });
  assert.equal(new TextDecoder().decode(cpu.memory.read(fileMapping, 3)), "map");

  const armMemory = createSyscalls({ abi: "linux-aarch64", addressLimit: 60_000n, heapBase: 4096n });
  assert.equal(armMemory.handle({ nr: 222n, args: [0n, 4096n, 3n, 0x22n, -1n, 0n], cpu }), 40_960n);

  const freebsd = createSyscalls({ abi: "freebsd-x86_64" });
  assert.deepEqual(freebsd.handle({ nr: 999n, args: [], cpu }), { value: 78n, error: true });
  const trapped = createX86({ onSyscall: freebsd.handle });
  trapped.load(Uint8Array.from([0x48, 0xb8, 0xe7, 3, 0, 0, 0, 0, 0, 0, 0x0f, 0x05]));
  trapped.step();
  trapped.step();
  assert.equal(trapped.registers().rax, 78n);
  assert.notEqual(trapped.registers().rflags & FLAGS.CF, 0n);

  const flags = createX86({ onSyscall: () => ({ value: 0n, error: false }) });
  flags.load(Uint8Array.from([0x48, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0x48, 0x83, 0xe8, 1, 0x0f, 0x05]));
  flags.step();
  flags.step();
  assert.notEqual(flags.registers().rflags & FLAGS.CF, 0n);
  flags.step();
  assert.equal(flags.registers().rflags & FLAGS.CF, 0n);
  console.log("shell.js syscalls: ok");
}

{
  const elf = (machine, code, flags = 5) => {
    const image = new Uint8Array(0x100 + code.length);
    const view = new DataView(image.buffer);
    image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    view.setUint16(16, 2, true);
    view.setUint16(18, machine, true);
    view.setUint32(20, 1, true);
    view.setBigUint64(24, 0x1000n, true);
    view.setBigUint64(32, 64n, true);
    view.setUint16(52, 64, true);
    view.setUint16(54, 56, true);
    view.setUint16(56, 1, true);
    view.setUint32(64, 1, true);
    view.setUint32(68, flags, true);
    view.setBigUint64(72, 0n, true);
    view.setBigUint64(80, 0xf00n, true);
    view.setBigUint64(88, 0xf00n, true);
    view.setBigUint64(96, BigInt(image.length), true);
    view.setBigUint64(104, BigInt(image.length + 16), true);
    view.setBigUint64(112, 0x100n, true);
    image.set(code, 0x100);
    return image;
  };

  const x86Image = elf(
    62,
    Uint8Array.from([0x48, 0xb8, 60, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 7, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05]),
  );
  const x86System = createSyscalls({ abi: "linux-x86_64" });
  const x86 = createX86({ onSyscall: x86System.handle });
  const x86Executable = loadElf(x86Image, x86.memory);
  assert.equal(x86Executable.architecture, "x86_64");
  assert.equal(x86Executable.stackPointer, null);
  assert.deepEqual(x86.memory.read(0x1000n + 22n, 16), new Uint8Array(16));
  x86.reset({ rip: x86Executable.entry });
  x86.run();
  assert.equal(x86System.exitCode, 7);

  const processCpu = createX86();
  const process = loadElf(x86Image, processCpu.memory, {
    argv: ["/bin/test", "arg"],
    env: { LANG: "C" },
    random: Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  assert.equal(process.stackPointer % 16n, 0n);
  assert.equal(processCpu.memory.u64(process.stackPointer), 2n);
  const argv0 = processCpu.memory.u64(process.stackPointer + 8n);
  const env0 = processCpu.memory.u64(process.stackPointer + 32n);
  const stringAt = (address) => {
    const bytes = processCpu.memory.bytes();
    const start = Number(address);
    return new TextDecoder().decode(bytes.subarray(start, bytes.indexOf(0, start)));
  };
  assert.equal(stringAt(argv0), "/bin/test");
  assert.equal(stringAt(env0), "LANG=C");
  const aux = new Map();
  for (let at = process.stackPointer + 48n; ; at += 16n) {
    const type = processCpu.memory.u64(at);
    const value = processCpu.memory.u64(at + 8n);
    if (type === 0n) break;
    aux.set(type, value);
  }
  assert.equal(aux.get(3n), process.phdr);
  assert.notEqual(aux.get(3n), 0n);
  assert.deepEqual(processCpu.memory.read(aux.get(3n), 56), x86Image.subarray(64, 120));
  assert.equal(aux.get(9n), process.entry);
  assert.equal(aux.get(11n), 1000n);
  assert.equal(aux.get(12n), 1000n);
  assert.equal(aux.get(13n), 1000n);
  assert.equal(aux.get(14n), 1000n);
  assert.deepEqual(
    processCpu.memory.read(aux.get(25n), 16),
    Uint8Array.from({ length: 16 }, (_, index) => index),
  );
  const largeProcess = loadElf(x86Image, { size: 0x80002000, write() {} }, { random: new Uint8Array(16) });
  assert.equal(largeProcess.stackPointer % 16n, 0n);
  assert.ok(largeProcess.stackPointer > 0x80000000n);
  assert.throws(
    () =>
      loadElf(x86Image, createX86().memory, {
        random: new Uint8Array(16),
        stackFloor: 0,
        stackTop: Number(x86Executable.brk) + 256,
      }),
    /stack overlaps ELF image/,
  );
  assert.throws(
    () => loadElf(x86Image, createX86().memory, { random: new Uint8Array(16), uid: 0x1_0000_0000 }),
    /unsigned 32-bit/,
  );

  const armImage = elf(183, armBytes([0xd28000e0, 0xd2800ba8, 0xd4000001]));
  const armSystem = createSyscalls({ abi: "linux-aarch64" });
  const arm = createArm({ onSyscall: armSystem.handle });
  const armExecutable = loadElf(armImage, arm.memory);
  assert.equal(armExecutable.architecture, "aarch64");
  arm.reset({ pc: armExecutable.entry });
  arm.run();
  assert.equal(armSystem.exitCode, 7);

  const badMagic = x86Image.slice();
  badMagic[0] = 0;
  assert.throws(() => loadElf(badMagic, createX86().memory), /invalid ELF magic/);
  assert.throws(() => loadElf(x86Image.slice(0, 100), createX86().memory), /truncated ELF program headers/);
  assert.throws(() => loadElf(elf(62, Uint8Array.of(0x90), 4), createX86().memory), /entry is not executable/);
  const oversized = x86Image.slice();
  new DataView(oversized.buffer).setBigUint64(80, 65_536n, true);
  assert.throws(() => loadElf(oversized, createX86().memory), /exceeds guest memory/);
  const nonPowerAlignment = x86Image.slice();
  new DataView(nonPowerAlignment.buffer).setBigUint64(112, 3n, true);
  assert.throws(() => loadElf(nonPowerAlignment, createX86().memory), /invalid ELF load alignment/);
  const incongruentAlignment = x86Image.slice();
  new DataView(incongruentAlignment.buffer).setBigUint64(112, 512n, true);
  assert.throws(() => loadElf(incongruentAlignment, createX86().memory), /invalid ELF load alignment/);
  const unmappedHeaders = x86Image.slice();
  const unmappedView = new DataView(unmappedHeaders.buffer);
  unmappedView.setBigUint64(72, 0x100n, true);
  unmappedView.setBigUint64(80, 0x1000n, true);
  unmappedView.setBigUint64(88, 0x1000n, true);
  unmappedView.setBigUint64(96, BigInt(unmappedHeaders.length - 0x100), true);
  unmappedView.setBigUint64(104, BigInt(unmappedHeaders.length - 0x100 + 16), true);
  assert.throws(() => loadElf(unmappedHeaders, createX86().memory), /program headers are not mapped/);
  const overlapping = x86Image.slice();
  const overlappingView = new DataView(overlapping.buffer);
  overlappingView.setUint16(56, 2, true);
  overlappingView.setUint32(120, 1, true);
  overlappingView.setUint32(124, 4, true);
  overlappingView.setBigUint64(128, 0x100n, true);
  overlappingView.setBigUint64(136, 0x1000n, true);
  overlappingView.setBigUint64(144, 0x1000n, true);
  overlappingView.setBigUint64(152, 1n, true);
  overlappingView.setBigUint64(160, 16n, true);
  overlappingView.setBigUint64(168, 0x100n, true);
  assert.throws(() => loadElf(overlapping, createX86().memory), /load segments overlap/);
  assert.throws(() => loadElf(x86Image, createX86().memory, { argv: ["bad\0arg"] }), /without NUL/);
  const interpreted = x86Image.slice();
  const interpretedView = new DataView(interpreted.buffer);
  interpretedView.setUint16(56, 2, true);
  interpretedView.setUint32(120, 3, true);
  interpretedView.setBigUint64(128, 0xe0n, true);
  interpretedView.setBigUint64(152, 11n, true);
  interpreted.set(new TextEncoder().encode("/lib/ld.so\0"), 0xe0);
  assert.equal(loadElf(interpreted, createX86().memory).interpreter, "/lib/ld.so");
  const duplicateInterpreter = interpreted.slice();
  const duplicateView = new DataView(duplicateInterpreter.buffer);
  duplicateView.setUint16(56, 3, true);
  duplicateView.setUint32(176, 3, true);
  duplicateView.setBigUint64(184, 0xe0n, true);
  duplicateView.setBigUint64(208, 11n, true);
  assert.throws(() => loadElf(duplicateInterpreter, createX86().memory), /multiple ELF interpreters/);
  assert.throws(
    () => loadElf(interpreted, createX86().memory, { random: new Uint8Array(16) }),
    /interpreter is not supported/,
  );
  const loader = elf(
    62,
    Uint8Array.from([0x48, 0xb8, 60, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 9, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05]),
  );
  const loaderView = new DataView(loader.buffer);
  loaderView.setUint16(16, 3, true);
  loaderView.setBigUint64(24, 0x100n, true);
  loaderView.setBigUint64(80, 0n, true);
  loaderView.setBigUint64(88, 0n, true);
  const relocated = loadElf(loader, createX86().memory, { base: 0x2000n, stack: false });
  assert.equal(relocated.type, "dyn");
  assert.equal(relocated.entry, 0x2100n);
  const compensated = loader.slice();
  const compensatedView = new DataView(compensated.buffer);
  compensatedView.setBigUint64(24, 0x1000n, true);
  compensatedView.setBigUint64(80, 0x1000n, true);
  compensatedView.setBigUint64(88, 0x1000n, true);
  compensatedView.setBigUint64(112, 0x2000n, true);
  assert.throws(
    () => loadElf(compensated, createX86().memory, { base: 0x1000n, stack: false }),
    /invalid ELF load alignment/,
  );
  const misalignedBase = loader.slice();
  new DataView(misalignedBase.buffer).setBigUint64(112, 0x2000n, true);
  assert.throws(
    () => loadElf(misalignedBase, createX86().memory, { base: 0x1000n, stack: false }),
    /invalid ELF load alignment/,
  );
  const dynamic = runElf(interpreted, {
    interpreterBase: 65_536n,
    memorySize: 131_072,
    random: new Uint8Array(16),
    resolveInterpreter: (path) => {
      assert.equal(path, "/lib/ld.so");
      return loader;
    },
  });
  assert.equal(dynamic.exitCode, 9);
  assert.equal(dynamic.interpreter.base, 65_536n);
  assert.throws(
    () =>
      runElf(interpreted, {
        interpreterBase: 4096n,
        memorySize: 131_072,
        random: new Uint8Array(16),
        resolveInterpreter: () => loader,
      }),
    /overlaps executable/,
  );
  const dynamicAux = new Map();
  for (let at = dynamic.executable.stackPointer + 24n; ; at += 16n) {
    const type = dynamic.memory.u64(at);
    const value = dynamic.memory.u64(at + 8n);
    if (type === 0n) break;
    dynamicAux.set(type, value);
  }
  assert.equal(dynamicAux.get(3n), dynamic.executable.phdr);
  assert.notEqual(dynamicAux.get(3n), 0n);
  assert.deepEqual(dynamic.memory.read(dynamicAux.get(3n), 112), interpreted.subarray(64, 176));
  assert.equal(dynamicAux.get(7n), 65_536n);
  const result = runElf(x86Image, {
    argv: ["/bin/test"],
    memorySize: 65_536,
    random: new Uint8Array(16),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.architecture, "x86_64");
  const identified = runElf(x86Image, {
    gid: 7,
    memorySize: 65_536,
    random: new Uint8Array(16),
    uid: 42,
  });
  const identityAux = new Map();
  for (let at = identified.executable.stackPointer + 24n; ; at += 16n) {
    const type = identified.memory.u64(at);
    const value = identified.memory.u64(at + 8n);
    if (type === 0n) break;
    identityAux.set(type, value);
  }
  assert.equal(identityAux.get(11n), 42n);
  assert.equal(identityAux.get(12n), 42n);
  assert.equal(identityAux.get(13n), 7n);
  assert.equal(identityAux.get(14n), 7n);
  const outputImage = elf(
    62,
    Uint8Array.from([
      0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbf, 1, 0, 0, 0, 0, 0, 0, 0, 0x48, 0xbe, 0x50, 0x10, 0, 0, 0, 0, 0, 0,
      0x48, 0xba, 3, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05, 0x48, 0xb8, 1, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05, 0x48, 0xb8, 60, 0,
      0, 0, 0, 0, 0, 0, 0x48, 0xbf, 0, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x05, 0x90, 0x90, 0x90, 0x90, 97, 98, 99,
    ]),
  );
  const limited = runElf(outputImage, {
    maxOutputBytes: 4,
    memorySize: 65_536,
    random: new Uint8Array(16),
  });
  assert.equal(new TextDecoder().decode(limited.stdout), "abc");
  assert.throws(() => runElf(outputImage, { maxOutputBytes: 0 }), /maxOutputBytes must be a positive integer/);
  let asynchronousYields = 0;
  const asynchronousResult = await runElfAsync(x86Image, {
    argv: ["/bin/test"],
    memorySize: 65_536,
    quantum: 1,
    random: new Uint8Array(16),
    yield: async () => {
      asynchronousYields++;
    },
  });
  assert.equal(asynchronousResult.exitCode, 7);
  assert.equal(asynchronousYields, 2);
  console.log("shell.js elf: ok");
}
