import { createBuiltins } from "./commands.js";
import { createFS, MemoryFS } from "./fs.js";
import { createManuals } from "./man.js";
import { completionStart, expandWord, parse } from "./parser.js";
import { profiles, resolveProfile } from "./profiles.js";
import { createWasm } from "./wasm.js";

const commandName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const encoder = new TextEncoder();
const defaults = Object.freeze({
  maxArgs: 128,
  maxCommands: 128,
  maxFileBytes: 1_048_576,
  maxFiles: 2048,
  maxHistory: 500,
  maxOutput: 1_048_576,
  maxPipelines: 64,
  maxRuntimeMs: 5000,
  maxSource: 16_384,
  maxTokens: 1024,
  maxTotalBytes: 8_388_608,
});

const limitOptions = (values = {}) => {
  const limits = { ...defaults, ...values };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
  }
  return Object.freeze(limits);
};

const normalized = (value) => {
  if (value == null) return { code: 0, stdout: "", stderr: "" };
  if (typeof value === "string") return { code: 0, stdout: value, stderr: "" };
  if (typeof value === "number") value = { code: value };
  if (typeof value !== "object") throw new TypeError("command returned an invalid result");
  const result = { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  if (!Number.isInteger(result.code) || result.code < 0 || result.code > 255) {
    throw new TypeError("command status must be an integer from 0 to 255");
  }
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new TypeError("command output must be a string");
  }
  return result;
};

const failed = (error, signal, code = 1) => {
  const timedOut = signal.aborted && signal.reason?.name === "TimeoutError";
  return {
    code: timedOut ? 124 : signal.aborted ? 130 : code,
    stdout: "",
    stderr: `shell: ${timedOut ? "timed out" : signal.aborted ? "aborted" : (error?.message ?? error)}\n`,
  };
};

const aborted = (promise, signal) => {
  if (signal.aborted) return Promise.reject(signal.reason);
  let reject;
  const stopped = new Promise((_, fail) => {
    reject = () => fail(signal.reason);
    signal.addEventListener("abort", reject, { once: true });
  });
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener("abort", reject));
};

export const createShell = ({
  profile: selected = "posix",
  cwd,
  env = {},
  files = {},
  commands: custom = {},
  manuals,
  wasm,
  limits: configured,
  signal: lifetime,
} = {}) => {
  const profile = resolveProfile(selected);
  const limits = limitOptions(configured);
  const fs = files instanceof MemoryFS ? files : createFS(files, limits);
  const state = {
    cwd: "/",
    env: {
      HOME: profile.home,
      HOSTNAME: profile.hostname,
      LOGNAME: profile.user,
      OSTYPE: profile.ostype ?? profile.name,
      PATH: profile.path,
      SHELL: profile.shell,
      USER: profile.user,
      ...env,
    },
    history: [],
    status: 0,
  };
  fs.mkdir(state.env.HOME, { parents: true });
  fs.mkdir(cwd ?? state.env.HOME, { parents: true });
  state.cwd = fs.resolve("/", cwd ?? state.env.HOME);
  state.env.PWD = state.cwd;
  const builtins = createBuiltins(profile);
  const registry = new Map(Object.entries(builtins.commands));
  manuals =
    manuals?.read && manuals?.search ? manuals : manuals ? createManuals({ profile: profile.name, ...manuals }) : null;
  wasm = wasm?.filter && wasm?.prepare ? wasm : createWasm(wasm);
  let api;
  const register = (name, handler) => {
    if (!commandName.test(name) || typeof handler !== "function") {
      throw new TypeError("register requires a valid name and function");
    }
    registry.set(name, handler);
    return api;
  };
  for (const [name, handler] of custom instanceof Map ? custom : Object.entries(custom)) register(name, handler);

  const checkOutput = ({ stdout, stderr }) => {
    if (encoder.encode(stdout).length + encoder.encode(stderr).length > limits.maxOutput) {
      throw new RangeError("output limit exceeded");
    }
  };

  const chdir = (path, environment = state.env) => {
    const target = fs.resolve(state.cwd, path);
    if (fs.stat(target).type !== "directory") throw new Error(`${path}: Not a directory`);
    const previous = state.cwd;
    state.cwd = target;
    Object.assign(state.env, { OLDPWD: previous, PWD: target });
    if (environment !== state.env) Object.assign(environment, { OLDPWD: previous, PWD: target });
  };

  const invoke = async (name, args, environment, stdin, signal) => {
    const handler = registry.get(name);
    if (!handler) return { code: 127, stdout: "", stderr: `${name}: command not found\n` };
    const context = {
      fs,
      profile,
      kernel: builtins.kernel,
      manuals,
      wasm,
      signal,
      stdin,
      env: environment,
      get cwd() {
        return state.cwd;
      },
      chdir: (path) => chdir(path, environment),
      setenv: (key, value) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`invalid variable: ${key}`);
        environment[key] = String(value);
      },
      unsetenv: (key) => delete environment[key],
      history: state.history,
      clearHistory: () => state.history.splice(0),
      hasCommand: (value) => registry.has(value),
      commands: () => [...registry.keys()].sort(),
      invoke: (command, argv = [], options = {}) =>
        invoke(command, argv, options.env ?? environment, options.stdin ?? "", signal),
    };
    try {
      const output = normalized(
        await aborted(
          Promise.resolve().then(() => handler(args, context)),
          signal,
        ),
      );
      checkOutput(output);
      return output;
    } catch (error) {
      if (signal.aborted) throw error;
      return { code: 1, stdout: "", stderr: `${name}: ${error?.message ?? error}\n` };
    }
  };

  const execute = async (command, stdin, signal) => {
    const expansion = { ...state.env, "?": state.status };
    const argv = command.argv.map((word) => expandWord(word, expansion));
    const assignments = command.assignments.map(([key, word]) => [
      key,
      expandWord(word, expansion).slice(key.length + 1),
    ]);
    const redirects = command.redirects.map(({ type, path }) => ({
      type,
      path: expandWord(path, expansion),
    }));
    const environment =
      argv.length && assignments.length ? { ...state.env, ...Object.fromEntries(assignments) } : state.env;
    if (!argv.length) {
      for (const [key, value] of assignments) state.env[key] = value;
    }
    let stdout;
    let stderr;
    for (const redirect of redirects) {
      if (redirect.type === "<" || redirect.type === "0<") stdin = fs.read(redirect.path, state.cwd);
      if ([">", "1>", "2>"].includes(redirect.type)) fs.write(redirect.path, "", state.cwd);
      if (redirect.type.endsWith(">>") && !fs.exists(redirect.path, state.cwd)) {
        fs.write(redirect.path, "", state.cwd);
      }
      if ([">", ">>", "1>", "1>>"].includes(redirect.type)) stdout = redirect;
      if (["2>", "2>>"].includes(redirect.type)) stderr = redirect;
    }
    let output = argv.length
      ? await invoke(argv[0], argv.slice(1), environment, stdin, signal)
      : { code: 0, stdout: "", stderr: "" };
    if (stdout) {
      if (stdout.type.endsWith(">>")) fs.append(stdout.path, output.stdout, state.cwd);
      else fs.write(stdout.path, output.stdout, state.cwd);
      output = { ...output, stdout: "" };
    }
    if (stderr) {
      if (stderr.type.endsWith(">>")) fs.append(stderr.path, output.stderr, state.cwd);
      else fs.write(stderr.path, output.stderr, state.cwd);
      output = { ...output, stderr: "" };
    }
    return output;
  };

  const pipeline = async (commands, signal) => {
    let stdin = "";
    let stderr = "";
    let code = 0;
    try {
      for (const command of commands) {
        const output = await execute(command, stdin, signal);
        stdin = output.stdout;
        stderr += output.stderr;
        code = output.code;
        checkOutput({ stdout: stdin, stderr });
      }
      return { code, stdout: stdin, stderr };
    } catch (error) {
      const output = failed(error, signal);
      try {
        checkOutput({ stdout: "", stderr: stderr + output.stderr });
        output.stderr = stderr + output.stderr;
      } catch {
        // Keep the bounded error and discard oversized intermediate diagnostics.
      }
      return output;
    }
  };

  const run = async (source, options = {}) => {
    if (typeof source !== "string") return { code: 2, stdout: "", stderr: "shell: command must be a string\n" };
    if (source.trim()) {
      state.history.push(source);
      if (state.history.length > limits.maxHistory) state.history.splice(0, state.history.length - limits.maxHistory);
    }
    const controller = new AbortController();
    const external = [lifetime, options.signal].filter(Boolean);
    const stop = (event) => controller.abort(event.target.reason);
    for (const signal of external) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", stop, { once: true });
    }
    const timeout = setTimeout(() => {
      const reason = new Error("timed out");
      reason.name = "TimeoutError";
      controller.abort(reason);
    }, limits.maxRuntimeMs);
    let output = { code: 0, stdout: "", stderr: "" };
    try {
      const jobs = parse(source, {}, limits);
      for (const job of jobs) {
        if (job.link === "&&" && output.code !== 0) continue;
        if (job.link === "||" && output.code === 0) continue;
        const next = await pipeline(job.pipeline, controller.signal);
        state.status = next.code;
        output = {
          code: next.code,
          stdout: output.stdout + next.stdout,
          stderr: output.stderr + next.stderr,
        };
        checkOutput(output);
      }
      state.status = output.code;
    } catch (error) {
      const problem = failed(error, controller.signal, 2);
      if (
        encoder.encode(output.stdout).length +
          encoder.encode(output.stderr).length +
          encoder.encode(problem.stderr).length >
        limits.maxOutput
      ) {
        output = problem;
      } else {
        output = { code: problem.code, stdout: output.stdout, stderr: output.stderr + problem.stderr };
      }
      state.status = output.code;
    } finally {
      clearTimeout(timeout);
      for (const signal of external) signal.removeEventListener("abort", stop);
    }
    return output;
  };

  let pending = Promise.resolve();
  const exec = (source, options) => {
    const next = pending.then(() => run(source, options));
    pending = next.catch(() => {});
    return next;
  };

  const complete = (line = "") => {
    if (typeof line !== "string" || line.length > limits.maxSource) return [];
    const start = completionStart(line);
    const fragment = line.slice(start);
    if (fragment.startsWith("$")) {
      return Object.keys(state.env)
        .filter((key) => key.startsWith(fragment.slice(1)))
        .sort()
        .map((key) => `$${key}`);
    }
    const before = line.slice(0, start);
    if (!before.trim() || ";|&".includes(before.trimEnd().at(-1))) {
      return [...registry.keys()].filter((name) => name.startsWith(fragment)).sort();
    }
    return fs.complete(state.cwd, fragment);
  };

  api = {
    exec,
    complete,
    register,
    prepare: (feature = "wasm") =>
      feature === "wasm"
        ? (wasm?.prepare() ?? Promise.resolve(false))
        : Promise.reject(new TypeError(`unknown feature: ${feature}`)),
    fs,
    profile,
    kernel: builtins.kernel,
    env: state.env,
    get cwd() {
      return state.cwd;
    },
  };
  return api;
};

export { MemoryFS, profiles };
