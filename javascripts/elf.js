const ELF_HEADER = 64;
const PROGRAM_HEADER = 56;
const LOAD = 1;
const INTERP = 3;
const EXECUTE = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const safe = (value, name) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds JavaScript address space`);
  return Number(value);
};

const cString = (value, name) => {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError(`${name} must be a string without NUL`);
  const bytes = encoder.encode(value);
  const terminated = new Uint8Array(bytes.length + 1);
  terminated.set(bytes);
  return terminated;
};

const linuxStack = (memory, executable, options) => {
  const argv = options.argv ?? [];
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const environment = options.env ?? {};
  if (!environment || Array.isArray(environment) || typeof environment !== "object") {
    throw new TypeError("env must be an object");
  }
  const env = Object.entries(environment).map(([key, value]) => {
    if (!key || key.includes("=") || key.includes("\0")) throw new TypeError("invalid environment name");
    return `${key}=${value}`;
  });
  const uid = options.uid ?? 1000;
  const gid = options.gid ?? 1000;
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
  const top = options.stackTop === undefined ? memory.size : safe(BigInt(options.stackTop), "stack top");
  if (top < 0 || top > memory.size) throw new RangeError("stack top exceeds guest memory");
  let cursor = top;
  const writes = [];
  const push = (bytes) => {
    cursor -= bytes.length;
    if (cursor < 0) throw new RangeError("process stack exceeds guest memory");
    writes.push([BigInt(cursor), bytes]);
    return BigInt(cursor);
  };
  const argvPointers = argv.map((value, index) => push(cString(value, `argv[${index}]`)));
  const envPointers = env.map((value, index) => push(cString(value, `env[${index}]`)));
  const execfn = options.execfn ?? argv[0] ?? "";
  const execfnPointer =
    execfn === argv[0] ? (argvPointers[0] ?? push(cString("", "execfn"))) : push(cString(execfn, "execfn"));
  const platformPointer = push(cString(executable.architecture, "platform"));
  let random = options.random;
  if (random === undefined) {
    if (!globalThis.crypto?.getRandomValues) throw new Error("secure random source unavailable");
    random = globalThis.crypto.getRandomValues(new Uint8Array(16));
  }
  if (!(random instanceof Uint8Array) || random.length !== 16) throw new TypeError("random must be 16 bytes");
  const randomPointer = push(random.slice());
  const aux = [
    3n,
    executable.phdr,
    4n,
    BigInt(PROGRAM_HEADER),
    5n,
    BigInt(executable.programCount),
    6n,
    4096n,
    7n,
    BigInt(options.interpreterBase ?? 0),
    8n,
    0n,
    9n,
    executable.entry,
    11n,
    BigInt(uid),
    12n,
    BigInt(uid),
    13n,
    BigInt(gid),
    14n,
    BigInt(gid),
    15n,
    platformPointer,
    16n,
    0n,
    17n,
    100n,
    23n,
    0n,
    25n,
    randomPointer,
    31n,
    execfnPointer,
    0n,
    0n,
  ];
  const words = [BigInt(argvPointers.length), ...argvPointers, 0n, ...envPointers, 0n, ...aux];
  cursor -= words.length * 8;
  cursor -= cursor % 16;
  // ponytail: one descending stack assumes low contiguous ELF mappings; replace with a page map when an MMU lands.
  const stackFloor = Math.max(
    safe(executable.brk, "ELF break"),
    safe(BigInt(options.stackFloor ?? executable.brk), "stack floor"),
  );
  if (cursor < stackFloor) {
    throw new RangeError("process stack overlaps ELF image");
  }
  const table = new Uint8Array(words.length * 8);
  const view = new DataView(table.buffer);
  words.forEach((word, index) => {
    view.setBigUint64(index * 8, word, true);
  });
  writes.push([BigInt(cursor), table]);
  return { pointer: BigInt(cursor), writes };
};

export const loadElf = (image, memory, startup) => {
  if (!(image instanceof Uint8Array)) throw new TypeError("ELF image must be Uint8Array");
  if (!memory?.write || !Number.isSafeInteger(memory.size)) throw new TypeError("ELF loader requires guest memory");
  if (startup !== undefined && (!startup || Array.isArray(startup) || typeof startup !== "object")) {
    throw new TypeError("startup must be an object");
  }
  if (image.length < ELF_HEADER) throw new Error("truncated ELF header");
  if (image[0] !== 0x7f || image[1] !== 0x45 || image[2] !== 0x4c || image[3] !== 0x46) {
    throw new Error("invalid ELF magic");
  }
  if (image[4] !== 2 || image[5] !== 1 || image[6] !== 1) throw new Error("ELF must be 64-bit little-endian version 1");

  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const type = view.getUint16(16, true);
  if ((type !== 2 && type !== 3) || view.getUint32(20, true) !== 1) {
    throw new Error("ELF must be an executable or position-independent image");
  }
  const machine = view.getUint16(18, true);
  const architecture = machine === 62 ? "x86_64" : machine === 183 ? "aarch64" : null;
  if (!architecture) throw new Error(`unsupported ELF machine: ${machine}`);
  const base = BigInt(startup?.base ?? (type === 3 ? 0x400000 : 0));
  if (base < 0n || base & 4095n || (type === 2 && base !== 0n)) throw new Error("invalid ELF load base");
  const entry = base + view.getBigUint64(24, true);
  const programOffset = safe(view.getBigUint64(32, true), "program header offset");
  const headerSize = view.getUint16(52, true);
  const programSize = view.getUint16(54, true);
  const programCount = view.getUint16(56, true);
  if (headerSize !== ELF_HEADER || programSize !== PROGRAM_HEADER) throw new Error("unsupported ELF header layout");
  if (programOffset > image.length || programCount > Math.floor((image.length - programOffset) / programSize)) {
    throw new Error("truncated ELF program headers");
  }

  const loads = [];
  let brk = 0n;
  let executableEntry = false;
  let interpreter = null;
  let phdr;
  for (let index = 0; index < programCount; index++) {
    const at = programOffset + index * programSize;
    const type = view.getUint32(at, true);
    if (type === INTERP) {
      if (interpreter !== null) throw new Error("multiple ELF interpreters are not supported");
      const offset = safe(view.getBigUint64(at + 8, true), "interpreter offset");
      const size = safe(view.getBigUint64(at + 32, true), "interpreter size");
      if (size < 2 || offset > image.length - size || image[offset + size - 1] !== 0) {
        throw new Error("invalid ELF interpreter");
      }
      const path = image.subarray(offset, offset + size - 1);
      if (path.includes(0)) throw new Error("invalid ELF interpreter");
      try {
        interpreter = decoder.decode(path);
      } catch {
        throw new Error("invalid ELF interpreter");
      }
    }
    if (type !== LOAD) continue;
    const flags = view.getUint32(at + 4, true);
    const fileOffset = safe(view.getBigUint64(at + 8, true), "segment file offset");
    const rawAddress = view.getBigUint64(at + 16, true);
    const virtualAddress = base + rawAddress;
    const fileSize = safe(view.getBigUint64(at + 32, true), "segment file size");
    const memorySize = safe(view.getBigUint64(at + 40, true), "segment memory size");
    const alignment = view.getBigUint64(at + 48, true);
    if (
      alignment > 1n &&
      ((alignment & (alignment - 1n)) !== 0n ||
        rawAddress % alignment !== BigInt(fileOffset) % alignment ||
        base % alignment)
    ) {
      throw new Error("invalid ELF load alignment");
    }
    if (fileSize > memorySize || fileOffset > image.length - fileSize) throw new Error("invalid ELF load segment");
    const address = safe(virtualAddress, "segment address");
    if (address > memory.size - memorySize) throw new RangeError("ELF segment exceeds guest memory");
    const end = virtualAddress + BigInt(memorySize);
    if (end > brk) brk = end;
    const headersEnd = programOffset + programCount * programSize;
    if (programOffset >= fileOffset && headersEnd <= fileOffset + fileSize) {
      phdr = virtualAddress + BigInt(programOffset - fileOffset);
    }
    if (flags & EXECUTE && entry >= virtualAddress && entry < end) executableEntry = true;
    loads.push({ address: virtualAddress, fileOffset, fileSize, flags, memorySize });
  }
  if (!loads.length) throw new Error("ELF has no loadable segments");
  if (
    [...loads]
      .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0))
      .some(
        (segment, index, ordered) =>
          index > 0 && segment.address < ordered[index - 1].address + BigInt(ordered[index - 1].memorySize),
      )
  ) {
    throw new Error("ELF load segments overlap");
  }
  if (!executableEntry) throw new Error("ELF entry is not executable");
  if (phdr === undefined) throw new Error("ELF program headers are not mapped");
  const executable = {
    architecture,
    base,
    brk,
    entry,
    interpreter,
    osabi: image[7],
    phdr,
    programCount,
    segments: Object.freeze(
      loads.map(({ address, fileSize, flags, memorySize }) => Object.freeze({ address, fileSize, flags, memorySize })),
    ),
    type: type === 2 ? "exec" : "dyn",
  };
  const buildStack = startup !== undefined && startup.stack !== false;
  if (buildStack && interpreter && startup.interpreterBase === undefined) {
    throw new Error(`ELF interpreter is not supported: ${interpreter}`);
  }
  const stack = buildStack ? linuxStack(memory, executable, startup) : null;
  for (const { address, fileOffset, fileSize, memorySize } of loads) {
    memory.write(address, image.subarray(fileOffset, fileOffset + fileSize));
    if (memorySize > fileSize) memory.write(address + BigInt(fileSize), new Uint8Array(memorySize - fileSize));
  }
  for (const [address, bytes] of stack?.writes ?? []) memory.write(address, bytes);
  return Object.freeze({ ...executable, stackPointer: stack?.pointer ?? null });
};
