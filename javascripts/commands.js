const encoder = new TextEncoder();
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
const error = (name, message, code = 1) => result("", code, `${name}: ${message}\n`);
const paths = (args, ctx) =>
  (args.length ? args : ["-"]).map((path) => ({
    path,
    text: path === "-" ? ctx.stdin : ctx.fs.read(path, ctx.cwd),
  }));

const cat = (args, ctx) =>
  result(
    paths(args, ctx)
      .map(({ text }) => text)
      .join(""),
  );

const cd = (args, ctx) => {
  if (args.length > 1) return error("cd", "too many arguments");
  const target = args[0] === "-" ? ctx.env.OLDPWD : (args[0] ?? ctx.env.HOME ?? "/");
  if (!target) return error("cd", "OLDPWD not set");
  ctx.chdir(target);
  return result(args[0] === "-" ? `${ctx.cwd}\n` : "");
};

const echo = (args) => {
  const newline = args[0] !== "-n";
  if (!newline) args = args.slice(1);
  return result(`${args.join(" ")}${newline ? "\n" : ""}`);
};

const env = async (args, ctx) => {
  const values = { ...ctx.env };
  while (args[0]?.match(assigned)) {
    const [, key, value] = args.shift().match(assigned);
    values[key] = value;
  }
  return args.length
    ? ctx.invoke(args[0], args.slice(1), { env: values, stdin: ctx.stdin })
    : result(
        Object.keys(values)
          .sort()
          .map((key) => `${key}=${values[key]}\n`)
          .join(""),
      );
};

const printenv = (args, ctx) => {
  if (!args.length) return env(args, ctx);
  let stdout = "";
  let code = 0;
  for (const key of args) {
    if (Object.hasOwn(ctx.env, key)) stdout += `${ctx.env[key]}\n`;
    else code = 1;
  }
  return result(stdout, code);
};

const exportVariables = (args, ctx) => {
  if (!args.length) {
    return result(
      Object.keys(ctx.env)
        .sort()
        .map((key) => `export ${key}=${JSON.stringify(ctx.env[key])}\n`)
        .join(""),
    );
  }
  for (const value of args) {
    const match = value.match(assigned);
    if (match) ctx.setenv(match[1], match[2]);
    else if (variable.test(value)) ctx.setenv(value, ctx.env[value] ?? "");
    else return error("export", `${value}: invalid name`, 2);
  }
  return result();
};

const unset = (args, ctx) => {
  for (const key of args) {
    if (!variable.test(key)) return error("unset", `${key}: invalid name`, 2);
    ctx.unsetenv(key);
  }
  return result();
};

const grep = (args, ctx) => {
  let insensitive = false;
  let invert = false;
  let numbered = false;
  let quiet = false;
  while (/^-[ivnq]+$/.test(args[0] ?? "")) {
    for (const flag of args.shift().slice(1)) {
      if (flag === "i") insensitive = true;
      if (flag === "v") invert = true;
      if (flag === "n") numbered = true;
      if (flag === "q") quiet = true;
    }
  }
  if (!args.length) return error("grep", "missing pattern", 2);
  let pattern = args.shift();
  if (insensitive) pattern = pattern.toLocaleLowerCase();
  let stdout = "";
  let matched = false;
  const inputs = paths(args, ctx);
  if (!insensitive && !numbered && !quiet && inputs.length === 1) {
    const filtered = ctx.wasm?.filter(inputs[0].text, pattern, invert);
    if (filtered != null) return result(filtered, filtered ? 0 : 1);
  }
  for (const { path, text } of inputs) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((line, index) => {
      const hit = (insensitive ? line.toLocaleLowerCase() : line).includes(pattern) !== invert;
      if (!hit) return;
      matched = true;
      if (!quiet) stdout += `${inputs.length > 1 ? `${path}:` : ""}${numbered ? `${index + 1}:` : ""}${line}\n`;
    });
  }
  return result(stdout, matched ? 0 : 1);
};

const head = (args, ctx) => {
  let count = 10;
  if (args[0] === "-n") {
    count = Number(args[1]);
    args = args.slice(2);
  } else if (/^-\d+$/.test(args[0] ?? "")) count = Number(args.shift().slice(1));
  if (!Number.isSafeInteger(count) || count < 0) return error("head", "invalid line count", 2);
  const inputs = paths(args, ctx);
  return result(
    inputs
      .map(({ path, text }) => {
        const body = count ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(0, count).join("") : "";
        return `${inputs.length > 1 ? `==> ${path} <==\n` : ""}${body}`;
      })
      .join(inputs.length > 1 ? "\n" : ""),
  );
};

const history = (args, ctx) => {
  if (args[0] === "-c") {
    ctx.clearHistory();
    return result();
  }
  if (args.length) return error("history", "usage: history [-c]", 2);
  return result(ctx.history.map((line, index) => `${String(index + 1).padStart(5)}  ${line}\n`).join(""));
};

const ls = (args, ctx) => {
  let all = false;
  let long = false;
  while (/^-[al]+$/.test(args[0] ?? "")) {
    for (const flag of args.shift().slice(1)) {
      if (flag === "a") all = true;
      if (flag === "l") long = true;
    }
  }
  args = args.length ? args : ["."];
  let stdout = "";
  args.forEach((path, index) => {
    const stat = ctx.fs.stat(path, ctx.cwd);
    let entries =
      stat.type === "directory" ? ctx.fs.list(path, ctx.cwd) : [{ ...stat, name: ctx.fs.basename(stat.path) }];
    if (!all) entries = entries.filter(({ name }) => !name.startsWith("."));
    if (args.length > 1) stdout += `${index ? "\n" : ""}${path}:\n`;
    if (all && stat.type === "directory") {
      entries.unshift({ name: ".", type: "directory", size: 0 }, { name: "..", type: "directory", size: 0 });
    }
    stdout += long
      ? entries
          .map(
            (entry) =>
              `${entry.type === "directory" ? "d" : "-"}rw------- ${String(entry.size).padStart(8)} ${entry.name}\n`,
          )
          .join("")
      : `${entries.map(({ name }) => name).join("  ")}${entries.length ? "\n" : ""}`;
  });
  return result(stdout);
};

const mkdir = (args, ctx) => {
  const parents = args[0] === "-p";
  if (parents) args = args.slice(1);
  if (!args.length) return error("mkdir", "missing operand", 2);
  for (const path of args) ctx.fs.mkdir(path, { cwd: ctx.cwd, parents });
  return result();
};

const printf = (args) => {
  if (!args.length) return error("printf", "missing format", 2);
  const format = args.shift().replace(/\\([nrt\\])/g, (_, char) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[char]);
  let index = 0;
  let invalid = false;
  const render = () =>
    format.replace(/%([%sdi])/g, (_, type) => {
      if (type === "%") return "%";
      const value = args[index++] ?? "";
      if (type === "s") return value;
      const number = Number.parseInt(value, 10);
      if (Number.isNaN(number)) invalid = true;
      return Number.isNaN(number) ? "0" : String(number);
    });
  let stdout = render();
  while (index < args.length) {
    const before = index;
    stdout += render();
    if (index === before) break;
  }
  return invalid ? result(stdout, 1, "printf: expected a number\n") : result(stdout);
};

const pwd = (args, ctx) => (args.length ? error("pwd", "too many arguments", 2) : result(`${ctx.cwd}\n`));

const rm = (args, ctx) => {
  let force = false;
  let recursive = false;
  while (/^-[fRr]+$/.test(args[0] ?? "")) {
    for (const flag of args.shift().slice(1)) {
      if (flag === "f") force = true;
      if (flag === "r" || flag === "R") recursive = true;
    }
  }
  if (!args.length) return force ? result() : error("rm", "missing operand", 2);
  for (const path of args) {
    try {
      if (!recursive && ctx.fs.stat(path, ctx.cwd).type === "directory") {
        return error("rm", `${path}: is a directory`);
      }
      ctx.fs.remove(path, { cwd: ctx.cwd, recursive });
    } catch (caught) {
      if (!force || caught.code !== "ENOENT") throw caught;
    }
  }
  return result();
};

const rmdir = (args, ctx) => {
  if (!args.length) return error("rmdir", "missing operand", 2);
  for (const path of args) {
    if (ctx.fs.stat(path, ctx.cwd).type !== "directory") return error("rmdir", `${path}: Not a directory`);
    ctx.fs.remove(path, { cwd: ctx.cwd });
  }
  return result();
};

const touch = (args, ctx) => {
  if (!args.length) return error("touch", "missing operand", 2);
  for (const path of args) ctx.fs.touch(path, ctx.cwd);
  return result();
};

const man = async (args, ctx) => {
  if (!ctx.manuals) return error("man", "manual provider unavailable");
  let wanted = "";
  if (/^[1-9][A-Za-z0-9]*$/.test(args[0] ?? "")) wanted = args.shift();
  if (!args.length) return error("man", "what manual page do you want?", 2);
  const pages = [];
  const missing = [];
  for (const name of args) {
    const text = await ctx.manuals.read(name, wanted, ctx.signal);
    if (text) pages.push(text);
    else missing.push(`No manual entry for ${name}${wanted ? ` in section ${wanted}` : ""}\n`);
  }
  return result(pages.join("\n"), missing.length ? 1 : 0, missing.join(""));
};

const apropos = async (args, ctx) => {
  if (!ctx.manuals) return error("apropos", "manual provider unavailable");
  if (!args.length) return error("apropos", "missing keyword", 2);
  const matches = await ctx.manuals.search(args.join(" "), ctx.signal);
  return result(
    matches.length
      ? matches
          .map(
            ({ name, section, description = "" }) => `${name}(${section})${description ? ` - ${description}` : ""}\n`,
          )
          .join("")
      : `${args.join(" ")}: nothing appropriate\n`,
    matches.length ? 0 : 1,
  );
};

const sysctl = (args, ctx) => {
  const values = ctx.kernel.sysctls;
  if (!args.length || args[0] === "-a") {
    return result(
      Object.keys(values)
        .sort()
        .map((key) => `${key}: ${values[key]}\n`)
        .join(""),
    );
  }
  let stdout = "";
  for (const item of args) {
    const equal = item.indexOf("=");
    const key = equal < 0 ? item : item.slice(0, equal);
    if (!Object.hasOwn(values, key)) return error("sysctl", `unknown oid '${key}'`);
    if (equal >= 0) values[key] = item.slice(equal + 1);
    stdout += `${key}: ${values[key]}\n`;
  }
  return result(stdout);
};

const moduleName = (value) => {
  value = value.split("/").pop();
  if (!/^[A-Za-z0-9_.-]+$/.test(value ?? "")) return "";
  return value === "kernel" || value.endsWith(".ko") ? value : `${value}.ko`;
};

const kldstat = (args, ctx) =>
  args.length
    ? error("kldstat", "usage: kldstat")
    : result(
        `${[
          "Id Refs Address            Size Name",
          ...[...ctx.kernel.modules].map(
            (name, index) =>
              `${String(index + 1).padStart(2)}    1 0xffffffff${(0x81000000 + index * 0x100000).toString(16)} 1000 ${name}`,
          ),
        ].join("\n")}\n`,
      );

const kldload = (args, ctx) => {
  if (!args.length) return error("kldload", "missing module", 2);
  for (const value of args) {
    const name = moduleName(value);
    if (!name) return error("kldload", `${value}: invalid module`, 2);
    ctx.kernel.modules.add(name);
  }
  return result();
};

const kldunload = (args, ctx) => {
  if (!args.length) return error("kldunload", "missing module", 2);
  for (const value of args) {
    const name = moduleName(value);
    if (!name) return error("kldunload", `${value}: invalid module`, 2);
    if (name === "kernel") return error("kldunload", "can't unload kernel");
    if (!ctx.kernel.modules.delete(name)) return error("kldunload", `${name}: module not loaded`);
  }
  return result();
};

const lsmod = (args, ctx) =>
  args.length
    ? error("lsmod", "usage: lsmod")
    : result(
        `${[
          "Module                  Size  Used by",
          ...[...ctx.kernel.modules].map((name) => `${name.replace(/\.ko$/, "").padEnd(20)} 4096  0`),
        ].join("\n")}\n`,
      );

const modprobe = (args, ctx) => {
  const remove = args[0] === "-r";
  if (remove) args.shift();
  if (!args.length) return error("modprobe", "missing module", 2);
  for (const value of args) {
    const name = moduleName(value);
    if (!name) return error("modprobe", `${value}: invalid module`, 2);
    if (remove) ctx.kernel.modules.delete(name);
    else ctx.kernel.modules.add(name);
  }
  return result();
};

const uname = (args, { profile }) => {
  const fields = {
    s: profile.sysname,
    n: profile.hostname,
    r: profile.release,
    v: `${profile.sysname} ${profile.release}`,
    m: profile.machine,
  };
  if (!args.length) return result(`${fields.s}\n`);
  const flags = args.join("").replaceAll("-", "");
  if (flags.includes("a")) return result(`${fields.s} ${fields.n} ${fields.r} ${fields.v} ${fields.m}\n`);
  if ([...flags].some((flag) => !(flag in fields))) return error("uname", "invalid option", 2);
  return result(`${[...flags].map((flag) => fields[flag]).join(" ")}\n`);
};

const wc = (args, ctx) => {
  let flags = "";
  while (/^-[lwc]+$/.test(args[0] ?? "")) flags += args.shift().slice(1);
  flags = [...new Set(flags || "lwc")].join("");
  const inputs = paths(args, ctx);
  const totals = { l: 0, w: 0, c: 0 };
  const rows = inputs.map(({ path, text }) => {
    const counts = {
      l: (text.match(/\n/g) ?? []).length,
      w: (text.match(/\S+/g) ?? []).length,
      c: encoder.encode(text).length,
    };
    for (const flag of flags) totals[flag] += counts[flag];
    return `${[...flags].map((flag) => String(counts[flag]).padStart(7)).join("")}${inputs.length > 1 || path !== "-" ? ` ${path}` : ""}\n`;
  });
  if (inputs.length > 1) rows.push(`${[...flags].map((flag) => String(totals[flag]).padStart(7)).join("")} total\n`);
  return result(rows.join(""));
};

const which = (args, ctx) => {
  if (!args.length) return error("which", "missing command", 2);
  const found = args.filter(ctx.hasCommand);
  return result(found.map((name) => `/bin/${name}\n`).join(""), found.length === args.length ? 0 : 1);
};

export const createBuiltins = (profile) => {
  const kernel = {
    messages: [...profile.messages],
    modules: new Set(profile.modules),
    sysctls: Object.assign(Object.create(null), profile.sysctls),
  };
  const commands = {
    apropos,
    cat,
    cd,
    clear: () => result(),
    date: () => result(`${new Date().toString()}\n`),
    dmesg: () => result(`${kernel.messages.join("\n")}\n`),
    echo,
    env,
    export: exportVariables,
    false: () => result("", 1),
    grep,
    head,
    help: (_args, ctx) => result(`${ctx.commands().join("  ")}\n`),
    history,
    hostname: () => result(`${profile.hostname}\n`),
    id: () => result(`uid=${profile.uid}(${profile.user}) gid=${profile.gid}(${profile.group})\n`),
    ls,
    man,
    mkdir,
    printenv,
    printf,
    pwd,
    rm,
    rmdir,
    touch,
    true: () => result(),
    uname,
    unset,
    wc,
    whatis: apropos,
    which,
    whoami: () => result(`${profile.user}\n`),
  };
  if (profile.name === "freebsd")
    Object.assign(commands, {
      "freebsd-version": () => result(`${profile.release}\n`),
      kldload,
      kldstat,
      kldunload,
      sysctl,
    });
  if (profile.name === "linux")
    Object.assign(commands, {
      "linux-version": () => result(`${profile.release}\n`),
      lsmod,
      modprobe,
      sysctl,
    });
  return { commands, kernel };
};
