const u64 = (value) => BigInt.asUintN(64, BigInt(value));
const i64 = (value) => BigInt.asIntN(64, BigInt(value));

export class LinearMemory {
  #bytes;

  constructor(size = 65536) {
    if (!Number.isSafeInteger(size) || size < 4096 || size % 4096) {
      throw new TypeError("memory size must be a 4096-aligned integer >= 4096");
    }
    this.#bytes = new Uint8Array(size);
  }

  get size() {
    return this.#bytes.length;
  }

  get buffer() {
    return this.#bytes.buffer;
  }

  bytes() {
    return this.#bytes;
  }

  load(path, address = 0n) {
    const at = Number(u64(address));
    if (at < 0 || at + path.length > this.#bytes.length) throw new RangeError("image exceeds memory");
    this.#bytes.set(path, at);
  }

  u8(address, value) {
    const at = Number(u64(address));
    if (at >= this.#bytes.length) throw new RangeError("memory fault");
    if (value === undefined) return this.#bytes[at];
    this.#bytes[at] = value & 0xff;
  }

  u32(address, value) {
    const at = Number(u64(address));
    if (at + 4 > this.#bytes.length) throw new RangeError("memory fault");
    const view = new DataView(this.#bytes.buffer, at, 4);
    if (value === undefined) return view.getUint32(0, true);
    view.setUint32(0, value >>> 0, true);
  }

  u64(address, value) {
    const at = Number(u64(address));
    if (at + 8 > this.#bytes.length) throw new RangeError("memory fault");
    const view = new DataView(this.#bytes.buffer, at, 8);
    if (value === undefined) return view.getBigUint64(0, true);
    view.setBigUint64(0, u64(value), true);
  }
}

export const FLAGS = Object.freeze({ CF: 1n << 0n, ZF: 1n << 6n, SF: 1n << 7n, OF: 1n << 11n });

export class RegisterFile {
  #regs = new BigUint64Array(16);
  rip = 0n;
  rflags = 0n;

  get(index) {
    return this.#regs[index];
  }

  set(index, value) {
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

export const setLogicalFlags = (regs, result) => {
  const value = u64(result);
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    (value === 0n ? FLAGS.ZF : 0n) |
    ((value >> 63n) & 1n ? FLAGS.SF : 0n);
};

export const setAddFlags = (regs, left, right, result) => {
  const value = u64(result);
  const signed = i64(result);
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    (u64(left) + u64(right) > 0xffffffffffffffffn ? FLAGS.CF : 0n) |
    (value === 0n ? FLAGS.ZF : 0n) |
    ((value >> 63n) & 1n ? FLAGS.SF : 0n) |
    (i64(left) >= 0 === i64(right) >= 0 && i64(left) >= 0 !== signed >= 0 ? FLAGS.OF : 0n);
};

export const setSubFlags = (regs, left, right, result) => {
  const value = u64(result);
  regs.rflags =
    (regs.rflags & ~(FLAGS.CF | FLAGS.ZF | FLAGS.SF | FLAGS.OF)) |
    (u64(left) < u64(right) ? FLAGS.CF : 0n) |
    (value === 0n ? FLAGS.ZF : 0n) |
    ((value >> 63n) & 1n ? FLAGS.SF : 0n) |
    (i64(left) >= 0 !== i64(right) >= 0 && i64(left) >= 0 !== i64(result) >= 0 ? FLAGS.OF : 0n);
};

export { u64, i64 };
