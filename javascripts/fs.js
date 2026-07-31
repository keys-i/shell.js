const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).length;
const fail = (path, message, code = "EINVAL") => {
  const error = new Error(`${path}: ${message}`);
  error.code = code;
  throw error;
};

const limitsOf = (limits) => ({
  maxFileBytes: limits.maxFileBytes ?? 1_048_576,
  maxFiles: limits.maxFiles ?? 2048,
  maxTotalBytes: limits.maxTotalBytes ?? 8_388_608,
});

export class MemoryFS {
  #dirs = new Set(["/"]);
  #files = new Map();
  #times = new Map([["/", Date.now()]]);
  #limits;
  #total = 0;

  constructor(seed = {}, limits = {}) {
    this.#limits = limitsOf(limits);
    const entries = seed instanceof Map ? seed : Object.entries(seed);
    for (const [path, value] of entries) {
      if (value === null || path.endsWith("/")) this.mkdir(path, { parents: true });
      else {
        this.mkdir(this.parent(this.resolve("/", path)), { parents: true });
        this.write(path, String(value));
      }
    }
  }

  resolve(cwd = "/", input = ".") {
    if (typeof cwd !== "string" || typeof input !== "string" || input.includes("\0")) {
      fail(String(input), "invalid path");
    }
    const parts = input.startsWith("/") ? [] : cwd.split("/").filter(Boolean);
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) fail(input, "path escapes root", "EACCES");
        parts.pop();
      } else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  parent(path) {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  basename(path) {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  exists(path, cwd = "/") {
    path = this.resolve(cwd, path);
    return this.#dirs.has(path) || this.#files.has(path);
  }

  stat(path, cwd = "/") {
    path = this.resolve(cwd, path);
    if (this.#dirs.has(path)) return { path, type: "directory", size: 0, mtime: this.#times.get(path) };
    if (this.#files.has(path)) {
      return { path, type: "file", size: bytes(this.#files.get(path)), mtime: this.#times.get(path) };
    }
    fail(path, "No such file or directory", "ENOENT");
  }

  read(path, cwd = "/") {
    path = this.resolve(cwd, path);
    if (this.#dirs.has(path)) fail(path, "Is a directory", "EISDIR");
    if (!this.#files.has(path)) fail(path, "No such file or directory", "ENOENT");
    return this.#files.get(path);
  }

  write(path, value, cwd = "/") {
    path = this.resolve(cwd, path);
    value = String(value);
    const size = bytes(value);
    if (size > this.#limits.maxFileBytes) fail(path, "file quota exceeded", "EDQUOT");
    if (this.#dirs.has(path)) fail(path, "Is a directory", "EISDIR");
    if (!this.#dirs.has(this.parent(path))) fail(path, "No such directory", "ENOENT");
    const previous = this.#files.has(path) ? bytes(this.#files.get(path)) : 0;
    if (!this.#files.has(path)) this.#reserve(1);
    if (this.#total - previous + size > this.#limits.maxTotalBytes) {
      fail(path, "filesystem quota exceeded", "EDQUOT");
    }
    this.#files.set(path, value);
    this.#times.set(path, Date.now());
    this.#total += size - previous;
    return path;
  }

  append(path, value, cwd = "/") {
    path = this.resolve(cwd, path);
    return this.write(path, (this.#files.get(path) ?? "") + value);
  }

  mkdir(path, { cwd = "/", parents = false } = {}) {
    path = this.resolve(cwd, path);
    if (this.#files.has(path)) fail(path, "Not a directory", "ENOTDIR");
    if (this.#dirs.has(path)) {
      if (parents) return path;
      fail(path, "File exists", "EEXIST");
    }
    const missing = [];
    for (let current = path; !this.#dirs.has(current); current = this.parent(current)) {
      missing.push(current);
      if (current === "/") break;
    }
    if (!parents && missing.length > 1) fail(path, "No such directory", "ENOENT");
    this.#reserve(missing.length);
    for (const directory of missing.reverse()) {
      this.#dirs.add(directory);
      this.#times.set(directory, Date.now());
    }
    return path;
  }

  list(path = ".", cwd = "/") {
    path = this.resolve(cwd, path);
    const stat = this.stat(path);
    if (stat.type === "file") return [{ ...stat, name: this.basename(path) }];
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = new Map();
    for (const item of [...this.#dirs, ...this.#files.keys()]) {
      if (item === path || !item.startsWith(prefix)) continue;
      const name = item.slice(prefix.length).split("/")[0];
      const child = `${prefix}${name}`;
      if (!children.has(name)) children.set(name, { ...this.stat(child), name });
    }
    return [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(path, { cwd = "/", recursive = false } = {}) {
    cwd = this.resolve("/", cwd);
    path = this.resolve(cwd, path);
    if (path === "/") fail(path, "cannot remove root", "EPERM");
    if (path === cwd || cwd.startsWith(`${path}/`)) fail(path, "Device busy", "EBUSY");
    if (this.#files.has(path)) {
      this.#total -= bytes(this.#files.get(path));
      this.#files.delete(path);
      this.#times.delete(path);
      return;
    }
    if (!this.#dirs.has(path)) fail(path, "No such file or directory", "ENOENT");
    const prefix = `${path}/`;
    const children = [...this.#dirs, ...this.#files.keys()].filter((item) => item.startsWith(prefix));
    if (children.length && !recursive) fail(path, "Directory not empty", "ENOTEMPTY");
    for (const file of [...this.#files.keys()]) {
      if (file.startsWith(prefix)) {
        this.#total -= bytes(this.#files.get(file));
        this.#files.delete(file);
        this.#times.delete(file);
      }
    }
    for (const directory of [...this.#dirs]) {
      if (directory === path || directory.startsWith(prefix)) {
        this.#dirs.delete(directory);
        this.#times.delete(directory);
      }
    }
  }

  touch(path, cwd = "/") {
    path = this.resolve(cwd, path);
    if (!this.exists(path)) return this.write(path, "");
    this.#times.set(path, Date.now());
    return path;
  }

  complete(cwd, fragment) {
    const slash = fragment.lastIndexOf("/");
    const directory = slash < 0 ? "." : fragment.slice(0, slash) || "/";
    const prefix = slash < 0 ? fragment : fragment.slice(slash + 1);
    const lead = slash < 0 ? "" : fragment.slice(0, slash + 1);
    try {
      return this.list(directory, cwd)
        .filter(({ name }) => name.startsWith(prefix))
        .map(({ name, type }) => `${lead}${name}${type === "directory" ? "/" : ""}`);
    } catch {
      return [];
    }
  }

  #reserve(count) {
    if (this.#dirs.size + this.#files.size - 1 + count > this.#limits.maxFiles) {
      fail("/", "file count quota exceeded", "EDQUOT");
    }
  }
}

export const createFS = (files, limits) => new MemoryFS(files, limits);
