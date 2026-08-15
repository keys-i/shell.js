import { i64 } from "./cpu/memory.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

const tables = Object.freeze({
  "linux-x86_64": {
    0: "read",
    1: "write",
    2: "open",
    3: "close",
    4: "stat",
    5: "fstat",
    8: "lseek",
    9: "mmap",
    10: "mprotect",
    11: "munmap",
    12: "brk",
    17: "pread",
    19: "readv",
    20: "writev",
    39: "getpid",
    60: "exit",
    63: "uname",
    79: "getcwd",
    80: "chdir",
    102: "getuid",
    104: "getgid",
    107: "geteuid",
    108: "getegid",
    158: "arch_prctl",
    186: "gettid",
    218: "set_tid_address",
    228: "clock_gettime",
    231: "exit",
    257: "openat",
    262: "fstatat",
    318: "getrandom",
  },
  "linux-aarch64": {
    17: "getcwd",
    49: "chdir",
    56: "openat",
    57: "close",
    62: "lseek",
    63: "read",
    64: "write",
    65: "readv",
    66: "writev",
    67: "pread",
    79: "fstatat",
    80: "fstat",
    93: "exit",
    94: "exit",
    96: "set_tid_address",
    113: "clock_gettime",
    160: "uname",
    172: "getpid",
    174: "getuid",
    175: "geteuid",
    176: "getgid",
    177: "getegid",
    178: "gettid",
    214: "brk",
    215: "munmap",
    222: "mmap",
    226: "mprotect",
    278: "getrandom",
  },
  "freebsd-x86_64": {
    1: "exit",
    3: "read",
    4: "write",
    5: "open",
    6: "close",
    12: "chdir",
    17: "brk",
    20: "getpid",
    24: "getuid",
    25: "geteuid",
    43: "getegid",
    47: "getgid",
    120: "readv",
    121: "writev",
    232: "clock_gettime",
    326: "getcwd",
    478: "lseek",
    563: "getrandom",
  },
  "freebsd-aarch64": {
    1: "exit",
    3: "read",
    4: "write",
    5: "open",
    6: "close",
    12: "chdir",
    17: "brk",
    20: "getpid",
    24: "getuid",
    25: "geteuid",
    43: "getegid",
    47: "getgid",
    120: "readv",
    121: "writev",
    232: "clock_gettime",
    326: "getcwd",
    478: "lseek",
    563: "getrandom",
  },
});

const errno = Object.freeze({
  linux: {
    EACCES: 13,
    EBADF: 9,
    EDQUOT: 122,
    EFBIG: 27,
    EFAULT: 14,
    EEXIST: 17,
    EINVAL: 22,
    EIO: 5,
    EISDIR: 21,
    EMFILE: 24,
    ENAMETOOLONG: 36,
    ENOENT: 2,
    ENOMEM: 12,
    ENOSPC: 28,
    ENOSYS: 38,
    ENOTDIR: 20,
    ERANGE: 34,
    ESPIPE: 29,
  },
  freebsd: {
    EACCES: 13,
    EBADF: 9,
    EDQUOT: 69,
    EFBIG: 27,
    EFAULT: 14,
    EEXIST: 17,
    EINVAL: 22,
    EIO: 5,
    EISDIR: 21,
    EMFILE: 24,
    ENAMETOOLONG: 63,
    ENOENT: 2,
    ENOMEM: 12,
    ENOSPC: 28,
    ENOSYS: 78,
    ENOTDIR: 20,
    ERANGE: 34,
    ESPIPE: 29,
  },
});

const openFlags = Object.freeze({
  linux: { append: 0x400, create: 0x40, exclusive: 0x80, truncate: 0x200 },
  freebsd: { append: 0x8, create: 0x200, exclusive: 0x800, truncate: 0x400 },
});

const problem = (code) => Object.assign(new Error(code), { code });

const secureRandom = (bytes) => {
  if (!globalThis.crypto?.getRandomValues) throw problem("ENOSYS");
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
  }
  return bytes;
};

const countOf = (value) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw problem("EINVAL");
  return Number(value);
};

const memoryRange = (memory, address, length) => {
  const at = countOf(address);
  const count = countOf(length);
  if (at > memory.size || count > memory.size - at) throw problem("EFAULT");
  return { at, count };
};

const vectorsAt = (memory, address, count) => {
  count = countOf(count);
  if (count > 1024) throw problem("EINVAL");
  const table = memoryRange(memory, address, count * 16);
  const vectors = [];
  for (let index = 0; index < count; index++) {
    const at = BigInt(table.at + index * 16);
    const pointer = memory.u64(at);
    const length = memory.u64(at + 8n);
    memoryRange(memory, pointer, length);
    vectors.push([pointer, length]);
  }
  return vectors;
};

const pathAt = (memory, address, limit) => {
  const at = countOf(address);
  if (at >= memory.size) throw problem("EFAULT");
  const available = memory.size - at;
  const bytes = memory.read(BigInt(at), Math.min(limit, available));
  const end = bytes.indexOf(0);
  if (end < 0) throw problem(available < limit ? "EFAULT" : "ENAMETOOLONG");
  try {
    return decoder.decode(bytes.subarray(0, end));
  } catch {
    throw problem("EINVAL");
  }
};

const inputBytes = (value) => {
  if (value instanceof Uint8Array) return value.slice();
  if (typeof value === "string") return encoder.encode(value);
  throw new TypeError("stdin must be a string or Uint8Array");
};

const cStringBytes = (value) => {
  const encoded = encoder.encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return bytes;
};

export const createSyscalls = ({
  addressLimit,
  abi = "linux-x86_64",
  clock,
  fs,
  cwd = "/",
  gid = 1000,
  stdin = new Uint8Array(),
  write = () => {},
  heapBase = 0n,
  maxFileBytes = 1_048_576,
  maxFiles = 256,
  pid = 1,
  random = secureRandom,
  uid = 1000,
} = {}) => {
  const table = tables[abi];
  if (!table) throw new TypeError(`unsupported ABI: ${abi}`);
  if (typeof write !== "function") throw new TypeError("write must be a function");
  if (clock !== undefined && typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof random !== "function") throw new TypeError("random must be a function");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new TypeError("maxFileBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 4) throw new TypeError("maxFiles must be an integer >= 4");
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("pid must be a positive integer");
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    uid > 0xffffffff ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    gid > 0xffffffff
  ) {
    throw new TypeError("uid and gid must be unsigned 32-bit integers");
  }
  heapBase = BigInt(heapBase);
  if (heapBase < 0n) throw new TypeError("heapBase must not be negative");
  addressLimit = addressLimit === undefined ? null : BigInt(addressLimit);
  if (addressLimit !== null && addressLimit <= heapBase) throw new TypeError("addressLimit must exceed heapBase");

  const family = abi.startsWith("freebsd") ? "freebsd" : "linux";
  const pathname = (memory, address) => pathAt(memory, address, family === "freebsd" ? 1024 : 4096);
  const clockSource =
    clock ??
    ((id) => {
      if (id === 0) return Date.now();
      if ((family === "linux" && (id === 1 || id === 4)) || (family === "freebsd" && id === 4)) {
        return globalThis.performance?.now?.() ?? Date.now();
      }
      return null;
    });
  const descriptors = new Map([
    [0, { bytes: inputBytes(stdin), offset: 0 }],
    [1, { output: 1 }],
    [2, { output: 2 }],
  ]);
  let workingDirectory = cwd;
  let brk = heapBase;
  let clearTid = 0n;
  let exitCode = null;
  const mappings = [];

  const result = (value, error = false) =>
    family === "freebsd" ? { value: BigInt(value), error } : error ? -BigInt(value) : BigInt(value);
  const failure = (code) => result(errno[family][code] ?? errno[family].EIO, true);
  const filesystem = () => {
    if (!fs?.readBytes || !fs?.writeBytes) throw problem("EACCES");
    return fs;
  };
  const descriptor = (fd) => {
    const entry = descriptors.get(countOf(fd));
    if (!entry) throw problem("EBADF");
    return entry;
  };
  const availableDescriptor = () => {
    for (let fd = 0; fd < maxFiles; fd++) {
      if (!descriptors.has(fd)) return fd;
    }
    throw problem("EMFILE");
  };
  const open = (memory, pathPointer, rawFlags) => {
    const filesystemCapability = filesystem();
    const path = pathname(memory, pathPointer);
    if (!path) throw problem("ENOENT");
    const flags = Number(rawFlags & 0xffffffffn);
    const access = flags & 3;
    if (access === 3) throw problem("EINVAL");
    const writable = access === 1 || access === 2;
    const readable = access === 0 || access === 2;
    const bits = openFlags[family];
    if (flags & bits.truncate && !writable) throw problem("EACCES");
    const fd = availableDescriptor();
    descriptors.set(fd, null);
    try {
      const target = filesystemCapability.resolve(workingDirectory, path);
      if (!filesystemCapability.exists(target)) {
        if (!(flags & bits.create)) throw problem("ENOENT");
        filesystemCapability.writeBytes(target, new Uint8Array());
      } else {
        if (flags & bits.create && flags & bits.exclusive) throw problem("EEXIST");
        if (filesystemCapability.stat(target).type !== "file") throw problem("EISDIR");
      }
      if (flags & bits.truncate) filesystemCapability.writeBytes(target, new Uint8Array());
      const bytes = filesystemCapability.readBytes(target);
      descriptors.set(fd, {
        path: target,
        readable,
        writable,
        append: Boolean(flags & bits.append),
        offset: 0,
        size: bytes.length,
      });
      return fd;
    } catch (error) {
      descriptors.delete(fd);
      throw error;
    }
  };
  const infoFor = (entry) =>
    entry.path ? filesystem().stat(entry.path) : { inode: 1, mtime: 0, size: 0, type: "character" };
  const writeStat = (memory, pointer, info) => {
    const x86 = abi === "linux-x86_64";
    const bytes = new Uint8Array(x86 ? 144 : 128);
    const view = new DataView(bytes.buffer);
    const mode = info.type === "directory" ? 0o040755 : info.type === "file" ? 0o100644 : 0o020666;
    const seconds = Math.floor((info.mtime ?? 0) / 1000);
    const nanoseconds = Math.floor(((info.mtime ?? 0) - seconds * 1000) * 1_000_000);
    view.setBigUint64(8, BigInt(info.inode ?? 1), true);
    if (x86) {
      view.setBigUint64(16, 1n, true);
      view.setUint32(24, mode, true);
      view.setUint32(28, uid, true);
      view.setUint32(32, gid, true);
      view.setBigUint64(56, 4096n, true);
    } else {
      view.setUint32(16, mode, true);
      view.setUint32(20, 1, true);
      view.setUint32(24, uid, true);
      view.setUint32(28, gid, true);
      view.setUint32(56, 4096, true);
    }
    view.setBigUint64(48, BigInt(info.size), true);
    view.setBigUint64(64, BigInt(Math.ceil(info.size / 512)), true);
    for (const at of [72, 88, 104]) {
      view.setBigUint64(at, BigInt(seconds), true);
      view.setBigUint64(at + 8, BigInt(nanoseconds), true);
    }
    memoryRange(memory, pointer, bytes.length);
    memory.write(pointer, bytes);
    return 0;
  };
  const pageRange = (memory, address, length) => {
    const at = BigInt(address);
    const count = countOf(length);
    if (at & 4095n || count < 1) throw problem("EINVAL");
    const size = Math.ceil(count / 4096) * 4096;
    const limit = addressLimit === null || addressLimit > BigInt(memory.size) ? BigInt(memory.size) : addressLimit;
    if (at < 0n || at + BigInt(size) > limit) throw problem("ENOMEM");
    return { at, limit, size };
  };
  const overlaps = (start, end) => mappings.some((mapping) => start < mapping.end && end > mapping.start);
  const removeMappings = (start, end) => {
    const retained = [];
    for (const mapping of mappings) {
      if (mapping.end <= start || mapping.start >= end) retained.push(mapping);
      else {
        if (mapping.start < start) retained.push({ start: mapping.start, end: start });
        if (mapping.end > end) retained.push({ start: end, end: mapping.end });
      }
    }
    mappings.splice(0, mappings.length, ...retained);
  };
  const availableMapping = (memory, size) => {
    const limit = addressLimit === null || addressLimit > BigInt(memory.size) ? BigInt(memory.size) : addressLimit;
    let ceiling = (limit - (limit - heapBase) / 4n) & ~4095n;
    const ordered = [...mappings].sort((left, right) =>
      left.start > right.start ? -1 : left.start < right.start ? 1 : 0,
    );
    for (const mapping of ordered) {
      if (mapping.start >= ceiling) continue;
      const start = (ceiling - BigInt(size)) & ~4095n;
      if (start >= brk && start >= mapping.end) return start;
      ceiling = mapping.start;
    }
    const start = (ceiling - BigInt(size)) & ~4095n;
    if (start < brk) throw problem("ENOMEM");
    return start;
  };

  const operations = {
    read(memory, [fd, pointer, length]) {
      const entry = descriptor(fd);
      const target = memoryRange(memory, pointer, length);
      let source;
      if (entry.bytes) source = entry.bytes;
      else {
        if (entry.output) throw problem("EBADF");
        if (!entry.readable) throw problem("EBADF");
        source = filesystem().readBytes(entry.path);
      }
      const count = Math.min(target.count, source.length - entry.offset);
      if (count > 0) memory.write(BigInt(target.at), source.subarray(entry.offset, entry.offset + count));
      entry.offset += Math.max(0, count);
      return Math.max(0, count);
    },
    write(memory, [fd, pointer, length]) {
      const entry = descriptor(fd);
      const target = memoryRange(memory, pointer, length);
      const source = memory.read(BigInt(target.at), target.count);
      if (entry.output) {
        const emitted = write(entry.output, source);
        if (emitted?.then) throw problem("EIO");
        return source.length;
      }
      if (!entry.writable) throw problem("EBADF");
      const filesystemCapability = filesystem();
      const previous = filesystemCapability.readBytes(entry.path);
      const at = entry.append ? previous.length : entry.offset;
      if (previous.length > maxFileBytes || source.length > maxFileBytes || at > maxFileBytes - source.length) {
        throw problem("EFBIG");
      }
      const next = new Uint8Array(Math.max(previous.length, at + source.length));
      next.set(previous);
      next.set(source, at);
      filesystemCapability.writeBytes(entry.path, next);
      entry.offset = at + source.length;
      entry.size = next.length;
      return source.length;
    },
    readv(memory, [fd, pointer, count]) {
      let total = 0;
      for (const [base, length] of vectorsAt(memory, pointer, count)) {
        try {
          const read = operations.read(memory, [fd, base, length]);
          total += read;
          if (read < Number(length)) break;
        } catch (error) {
          if (total) return total;
          throw error;
        }
      }
      return total;
    },
    writev(memory, [fd, pointer, count]) {
      let total = 0;
      for (const [base, length] of vectorsAt(memory, pointer, count)) {
        try {
          total += operations.write(memory, [fd, base, length]);
        } catch (error) {
          if (total) return total;
          throw error;
        }
      }
      return total;
    },
    pread(memory, [fd, pointer, length, rawOffset]) {
      const entry = descriptor(fd);
      if (!entry.path || !entry.readable) throw problem(entry.bytes || entry.output ? "ESPIPE" : "EBADF");
      const target = memoryRange(memory, pointer, length);
      const offset = countOf(rawOffset);
      const source = filesystem().readBytes(entry.path);
      const count = Math.min(target.count, Math.max(0, source.length - offset));
      if (count) memory.write(pointer, source.subarray(offset, offset + count));
      return count;
    },
    stat(memory, [pathPointer, pointer]) {
      const filesystemCapability = filesystem();
      const name = pathname(memory, pathPointer);
      if (!name) throw problem("ENOENT");
      const path = filesystemCapability.resolve(workingDirectory, name);
      return writeStat(memory, pointer, filesystemCapability.stat(path));
    },
    fstat(memory, [fd, pointer]) {
      return writeStat(memory, pointer, infoFor(descriptor(fd)));
    },
    fstatat(memory, [fd, pathPointer, pointer, rawFlags]) {
      const flags = Number(rawFlags & 0xffffffffn);
      if (flags & ~(0x100 | 0x1000)) throw problem("EINVAL");
      const path = pathname(memory, pathPointer);
      if (!path && flags & 0x1000) return writeStat(memory, pointer, infoFor(descriptor(fd)));
      if (!path) throw problem("ENOENT");
      if (!path.startsWith("/") && i64(fd) !== -100n) throw problem("EBADF");
      const filesystemCapability = filesystem();
      return writeStat(
        memory,
        pointer,
        filesystemCapability.stat(filesystemCapability.resolve(workingDirectory, path)),
      );
    },
    getcwd(memory, [pointer, length]) {
      const target = memoryRange(memory, pointer, length);
      const bytes = cStringBytes(workingDirectory);
      if (target.count < bytes.length) throw problem("ERANGE");
      memory.write(pointer, bytes);
      return family === "freebsd" ? 0 : bytes.length;
    },
    chdir(memory, [pointer]) {
      const filesystemCapability = filesystem();
      const name = pathname(memory, pointer);
      if (!name) throw problem("ENOENT");
      const path = filesystemCapability.resolve(workingDirectory, name);
      if (filesystemCapability.stat(path).type !== "directory") throw problem("ENOTDIR");
      workingDirectory = path;
      return 0;
    },
    getpid() {
      return pid;
    },
    gettid() {
      return pid;
    },
    getuid() {
      return uid;
    },
    geteuid() {
      return uid;
    },
    getgid() {
      return gid;
    },
    getegid() {
      return gid;
    },
    arch_prctl(memory, [operation, value], cpu) {
      if (operation === 0x1002n) {
        cpu.setTls(value);
        return 0;
      }
      if (operation === 0x1003n) {
        memoryRange(memory, value, 8n);
        memory.u64(value, cpu.registers().fsBase);
        return 0;
      }
      throw problem("EINVAL");
    },
    set_tid_address(memory, [pointer]) {
      if (pointer !== 0n) memoryRange(memory, pointer, 4n);
      clearTid = pointer;
      return pid;
    },
    clock_gettime(memory, [rawId, pointer]) {
      const id = countOf(rawId);
      const milliseconds = clockSource(id);
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw problem("EINVAL");
      memoryRange(memory, pointer, 16n);
      const seconds = Math.floor(milliseconds / 1000);
      const nanoseconds = Math.floor((milliseconds - seconds * 1000) * 1_000_000);
      memory.u64(pointer, BigInt(seconds));
      memory.u64(pointer + 8n, BigInt(nanoseconds));
      return 0;
    },
    uname(memory, [pointer]) {
      const bytes = new Uint8Array(65 * 6);
      const values = ["Linux", "shell.js", "6.0.0-krad", "#1", abi.endsWith("x86_64") ? "x86_64" : "aarch64", "(none)"];
      values.forEach((value, index) => {
        bytes.set(encoder.encode(value).subarray(0, 64), index * 65);
      });
      memoryRange(memory, pointer, bytes.length);
      memory.write(pointer, bytes);
      return 0;
    },
    getrandom(memory, [pointer, length, rawFlags]) {
      const target = memoryRange(memory, pointer, length);
      if (rawFlags & ~7n) throw problem("EINVAL");
      let bytes = new Uint8Array(target.count);
      const filled = random(bytes);
      if (filled?.then) throw problem("EIO");
      if (filled !== undefined) bytes = filled;
      if (!(bytes instanceof Uint8Array) || bytes.length !== target.count) throw problem("EIO");
      memory.write(BigInt(target.at), bytes);
      return bytes.length;
    },
    mmap(memory, [requested, length, _protection, rawFlags, fd, rawOffset]) {
      const count = countOf(length);
      if (!count) throw problem("EINVAL");
      const size = Math.ceil(count / 4096) * 4096;
      const flags = Number(rawFlags & 0xffffffffn);
      if ((flags & 3) !== 2) throw problem("EINVAL");
      const fixed = Boolean(flags & (0x10 | 0x100000));
      let start;
      if (fixed) start = pageRange(memory, requested, BigInt(size)).at;
      else start = availableMapping(memory, size);
      const end = start + BigInt(size);
      if (fixed && start < brk) throw problem("ENOMEM");
      if (flags & 0x100000 && overlaps(start, end)) throw problem("EEXIST");
      const range = pageRange(memory, start, BigInt(size));
      const bytes = new Uint8Array(range.size);
      if (!(flags & 0x20)) {
        const entry = descriptor(fd);
        if (entry.output || !entry.readable) throw problem("EBADF");
        const offset = countOf(rawOffset);
        if (offset & 4095) throw problem("EINVAL");
        const source = filesystem().readBytes(entry.path);
        bytes.set(source.subarray(offset, offset + range.size));
      }
      if (flags & 0x10) removeMappings(start, end);
      memory.write(start, bytes);
      mappings.push({ end, start });
      return start;
    },
    mprotect(memory, [address, length]) {
      pageRange(memory, address, length);
      return 0;
    },
    munmap(memory, [address, length]) {
      const range = pageRange(memory, address, length);
      const end = range.at + BigInt(range.size);
      memory.write(range.at, new Uint8Array(range.size));
      removeMappings(range.at, end);
      return 0;
    },
    open(memory, args) {
      return open(memory, args[0], args[1]);
    },
    openat(memory, args) {
      const path = pathname(memory, args[1]);
      if (!path.startsWith("/") && i64(args[0]) !== -100n) throw problem("EBADF");
      return open(memory, args[1], args[2]);
    },
    close(_memory, [fd]) {
      const number = countOf(fd);
      if (!descriptors.delete(number)) throw problem("EBADF");
      return 0;
    },
    lseek(_memory, [fd, rawOffset, rawWhence]) {
      const entry = descriptor(fd);
      if (entry.bytes || entry.output) throw problem("ESPIPE");
      const offset = i64(rawOffset);
      const whence = countOf(rawWhence);
      const base =
        whence === 0
          ? 0n
          : whence === 1
            ? BigInt(entry.offset)
            : whence === 2
              ? BigInt(filesystem().stat(entry.path).size)
              : null;
      if (base === null || base + offset < 0n || base + offset > BigInt(Number.MAX_SAFE_INTEGER))
        throw problem("EINVAL");
      entry.offset = Number(base + offset);
      return entry.offset;
    },
    brk(memory, [target]) {
      if (target === 0n) return brk;
      const firstMapping = mappings.reduce(
        (lowest, mapping) => (mapping.start >= heapBase && mapping.start < lowest ? mapping.start : lowest),
        addressLimit === null || addressLimit > BigInt(memory.size) ? BigInt(memory.size) : addressLimit,
      );
      if (target < heapBase || target > firstMapping) {
        if (family === "freebsd") throw problem("ENOMEM");
        return brk;
      }
      brk = target;
      return family === "freebsd" ? 0 : brk;
    },
  };

  const handle = ({ nr, args, cpu }) => {
    const operation = table[nr.toString()];
    if (operation === "exit") {
      exitCode = Number(args[0] & 0xffn);
      if (clearTid) cpu.memory.u32(clearTid, 0);
      return null;
    }
    if (!operation) return failure("ENOSYS");
    try {
      return result(operations[operation](cpu.memory, args, cpu));
    } catch (error) {
      return failure(error?.code ?? "EIO");
    }
  };

  return Object.freeze({
    abi,
    handle,
    get cwd() {
      return workingDirectory;
    },
    get exitCode() {
      return exitCode;
    },
  });
};

export { tables as syscallTables };
