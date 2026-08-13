const u64 = (value) => BigInt.asUintN(64, BigInt(value));
const i64 = (value) => BigInt.asIntN(64, BigInt(value));

export class LinearMemory {
  #bytes;
  #pages;
  #version = 0;

  constructor(size = 65536) {
    if (!Number.isSafeInteger(size) || size < 4096 || size % 4096) {
      throw new TypeError("memory size must be a 4096-aligned integer >= 4096");
    }
    this.#bytes = new Uint8Array(size);
    this.#pages = new Uint32Array(size / 4096);
  }

  get size() {
    return this.#bytes.length;
  }

  get buffer() {
    return this.#bytes.buffer.slice(0);
  }

  get version() {
    return this.#version;
  }

  generation(address) {
    const at = Number(u64(address));
    if (at >= this.#bytes.length) throw new RangeError("memory fault");
    return this.#pages[at >> 12];
  }

  bytes() {
    return this.#bytes.slice();
  }

  read(address, length) {
    const at = Number(u64(address));
    if (!Number.isSafeInteger(length) || length < 0 || at > this.#bytes.length - length)
      throw new RangeError("memory fault");
    return this.#bytes.slice(at, at + length);
  }

  write(address, source) {
    const at = Number(u64(address));
    if (!(source instanceof Uint8Array)) throw new TypeError("source must be Uint8Array");
    if (at > this.#bytes.length - source.length) throw new RangeError("memory fault");
    this.#bytes.set(source, at);
    this.#changed(at, source.length);
  }

  load(path, address = 0n) {
    const at = Number(u64(address));
    if (at < 0 || at + path.length > this.#bytes.length) throw new RangeError("image exceeds memory");
    this.#bytes.set(path, at);
    this.#changed(at, path.length);
  }

  u8(address, value) {
    const at = Number(u64(address));
    if (at >= this.#bytes.length) throw new RangeError("memory fault");
    if (value === undefined) return this.#bytes[at];
    this.#bytes[at] = value & 0xff;
    this.#changed(at, 1);
  }

  u16(address, value) {
    const at = Number(u64(address));
    if (at + 2 > this.#bytes.length) throw new RangeError("memory fault");
    const view = new DataView(this.#bytes.buffer, at, 2);
    if (value === undefined) return view.getUint16(0, true);
    view.setUint16(0, value & 0xffff, true);
    this.#changed(at, 2);
  }

  u32(address, value) {
    const at = Number(u64(address));
    if (at + 4 > this.#bytes.length) throw new RangeError("memory fault");
    const view = new DataView(this.#bytes.buffer, at, 4);
    if (value === undefined) return view.getUint32(0, true);
    view.setUint32(0, value >>> 0, true);
    this.#changed(at, 4);
  }

  u64(address, value) {
    const at = Number(u64(address));
    if (at + 8 > this.#bytes.length) throw new RangeError("memory fault");
    const view = new DataView(this.#bytes.buffer, at, 8);
    if (value === undefined) return view.getBigUint64(0, true);
    view.setBigUint64(0, u64(value), true);
    this.#changed(at, 8);
  }

  #changed(at, length) {
    if (!length) return;
    this.#version++;
    const last = (at + length - 1) >> 12;
    for (let page = at >> 12; page <= last; page++) this.#pages[page]++;
  }
}

export const FLAGS = Object.freeze({ CF: 1n << 0n, PF: 1n << 2n, ZF: 1n << 6n, SF: 1n << 7n, OF: 1n << 11n });

const parityFlag = (value) => {
  let byte = Number(u64(value) & 0xffn);
  let odd = 0;
  while (byte) {
    odd ^= 1;
    byte &= byte - 1;
  }
  return odd ? 0n : FLAGS.PF;
};

const width = (value, bits) => BigInt.asUintN(bits, BigInt(value));

export class RegisterFile {
  #count;
  #memory;
  #regs;

  constructor(count = 16) {
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("register count must be a positive integer");
    this.#count = count;
    this.#memory = typeof WebAssembly === "object" ? new WebAssembly.Memory({ initial: 1, maximum: 1 }) : null;
    this.#regs = new BigUint64Array(this.#memory?.buffer ?? new ArrayBuffer((count + 2) * 8), 0, count + 2);
  }

  get count() {
    return this.#count;
  }

  get memory() {
    return this.#memory;
  }

  get rip() {
    return this.#regs[this.#count];
  }

  set rip(value) {
    this.#regs[this.#count] = u64(value);
  }

  get rflags() {
    return this.#regs[this.#count + 1];
  }

  set rflags(value) {
    this.#regs[this.#count + 1] = u64(value);
  }

  clear() {
    this.#regs.fill(0n);
  }

  get(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) throw new RangeError("invalid register");
    return this.#regs[index];
  }

  set(index, value) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) throw new RangeError("invalid register");
    this.#regs[index] = u64(value);
  }

  snapshot() {
    return {
      rax: this.#regs[0],
      rcx: this.#regs[1],
      rdx: this.#regs[2],
      rbx: this.#regs[3],
      rsp: this.#regs[4],
      rbp: this.#regs[5],
      rsi: this.#regs[6],
      rdi: this.#regs[7],
      r8: this.#regs[8],
      r9: this.#regs[9],
      r10: this.#regs[10],
      r11: this.#regs[11],
      r12: this.#regs[12],
      r13: this.#regs[13],
      r14: this.#regs[14],
      r15: this.#regs[15],
      rip: this.rip,
      rflags: this.rflags,
    };
  }
}

export const setLogicalFlags = (regs, result, bits = 64) => {
  const value = width(result, bits);
  const sign = 1n << BigInt(bits - 1);
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.PF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    parityFlag(value) |
    (value === 0n ? FLAGS.ZF : 0n) |
    (value & sign ? FLAGS.SF : 0n);
};

export const setAddFlags = (regs, left, right, result, bits = 64) => {
  const lhs = width(left, bits);
  const rhs = width(right, bits);
  const value = width(result, bits);
  const sign = 1n << BigInt(bits - 1);
  const mask = (1n << BigInt(bits)) - 1n;
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.PF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    (lhs + rhs > mask ? FLAGS.CF : 0n) |
    parityFlag(value) |
    (value === 0n ? FLAGS.ZF : 0n) |
    (value & sign ? FLAGS.SF : 0n) |
    (~(lhs ^ rhs) & (lhs ^ value) & sign ? FLAGS.OF : 0n);
};

export const setSubFlags = (regs, left, right, result, bits = 64) => {
  const lhs = width(left, bits);
  const rhs = width(right, bits);
  const value = width(result, bits);
  const sign = 1n << BigInt(bits - 1);
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.PF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    (lhs < rhs ? FLAGS.CF : 0n) |
    parityFlag(value) |
    (value === 0n ? FLAGS.ZF : 0n) |
    (value & sign ? FLAGS.SF : 0n) |
    ((lhs ^ rhs) & (lhs ^ value) & sign ? FLAGS.OF : 0n);
};

export const applySyscallResult = (regs, index, result) => {
  if (result === null || result === undefined) return false;
  if (typeof result === "object") {
    regs.set(index, result.value);
    if (result.error === true) regs.rflags |= FLAGS.CF;
    else if (result.error === false) regs.rflags &= ~FLAGS.CF;
  } else regs.set(index, result);
  return true;
};

export { u64, i64 };
