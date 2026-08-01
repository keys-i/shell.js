import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";

const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const executable = (variable, name) => (process.env[variable] ? join(process.env[variable], name) : name);
const drivers = [
  {
    command: executable("CHROMEWEBDRIVER", "chromedriver"),
    name: "chromium",
    port: 9515,
    sessions: [
      { name: "chromium", mobile: false },
      { name: "chromium-mobile", mobile: true },
    ],
    options: {
      browserName: "chrome",
      "goog:chromeOptions": {
        args: ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"],
        binary: process.env.CHROMIUM_BIN,
      },
    },
  },
  {
    command: executable("GECKOWEBDRIVER", "geckodriver"),
    name: "firefox",
    port: 4444,
    sessions: [{ name: "firefox", mobile: false }],
    options: {
      browserName: "firefox",
      "moz:firefoxOptions": { args: ["--headless"] },
    },
  },
];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const serve = async () => {
  const root = process.cwd();
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}${sep}`)) throw Object.assign(new Error("forbidden"), { code: "EACCES" });
      const body = await readFile(path);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === "EACCES" ? 403 : 404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};

const run = async (driver, fixture) => {
  const child = spawn(driver.command, [`--port=${driver.port}`], { stdio: ["ignore", "pipe", "pipe"] });
  let problem;
  let diagnostics = "";
  child.once("error", (error) => {
    problem = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-8_192);
    });
  }
  const base = `http://127.0.0.1:${driver.port}`;
  const send = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(25_000),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.value?.error) {
      throw new Error(`${driver.name}: ${data.value?.message ?? response.statusText}\n${diagnostics}`);
    }
    return data.value;
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (problem) throw problem;
      try {
        await send("/status");
        break;
      } catch {
        if (attempt === 99 || child.exitCode !== null) throw new Error(`${driver.name} did not start\n${diagnostics}`);
        await pause(100);
      }
    }
    for (const suite of driver.sessions) {
      let session;
      try {
        const options = structuredClone(driver.options);
        if (suite.mobile) {
          options["goog:chromeOptions"].mobileEmulation = {
            clientHints: { mobile: true, platform: "Android" },
            deviceMetrics: { height: 844, mobile: true, pixelRatio: 3, touch: true, width: 390 },
          };
        }
        const created = await send("/session", { capabilities: { alwaysMatch: options } });
        session = created.sessionId;
        await send(`/session/${session}/timeouts`, { implicit: 0, pageLoad: 20_000, script: 20_000 });
        if (suite.mobile) {
          await send(`/session/${session}/goog/cdp/execute`, {
            cmd: "Emulation.setCPUThrottlingRate",
            params: { rate: 4 },
          });
        } else {
          await send(`/session/${session}/window/rect`, { height: 900, width: 1280 });
        }
        await send(`/session/${session}/url`, {
          url: `${fixture}/javascripts/browser.fixture.html?run=${suite.name}-${Date.now()}`,
        });
        const report = await send(`/session/${session}/execute/async`, {
          args: [],
          script:
            "const done=arguments[arguments.length-1];window.browserReport?window.browserReport.then(done):done({ok:false,error:'fixture did not start'});",
        });
        assert.equal(report.ok, true, `${suite.name}: ${report.error ?? "failed"}\n${report.stack ?? ""}`);
        const metrics = report.metrics;
        if (suite.mobile) assert.match(metrics.userAgent, /Android|Mobile/, "mobile emulation did not set a mobile UA");
        console.log(
          `${suite.name}: cold ${metrics.coldMs.toFixed(1)} ms, navigation ${metrics.navigationMs.toFixed(1)} ms, warm ${metrics.warmCommandMs.toFixed(3)} ms/command`,
        );
      } finally {
        if (session) await send(`/session/${session}`, undefined, "DELETE").catch(() => {});
      }
    }
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), pause(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
};

const fixture = await serve();
try {
  for (const driver of drivers) await run(driver, fixture.url);
  console.log("shell.js browsers: ok");
} finally {
  await new Promise((done) => fixture.server.close(done));
}
