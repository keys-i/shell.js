import {
  FLAGS,
  LinearMemory,
  RegisterFile,
  applySyscallResult,
  setAddFlags,
  setLogicalFlags,
  setSubFlags,
  u64,
} from "./memory.js";
import { createHotJit } from "./jit.js";

const read32 = (memory, pc) => memory.u32(pc);
const width = (value, bits) => BigInt.asUintN(bits, BigInt(value));
const yieldThread = () => new Promise((resolve) => setTimeout(resolve, 0));
const PAIR = new Map([
  [0xa9000000, [64, false, 0]],
  [0xa9400000, [64, true, 0]],
  [0xa9800000, [64, false, 1]],
  [0xa9c00000, [64, true, 1]],
  [0xa8800000, [64, false, 2]],
  [0xa8c00000, [64, true, 2]],
  [0x29000000, [32, false, 0]],
  [0x29400000, [32, true, 0]],
  [0x29800000, [32, false, 1]],
  [0x29c00000, [32, true, 1]],
  [0x28800000, [32, false, 2]],
  [0x28c00000, [32, true, 2]],
]);

export class ArmCpu {
  #memory;
  #regs = new RegisterFile(31);
  #stack = 0n;
  #syscall;
  #jit;
  #tls = 0n;
  #halted = false;
  #steps = 0;

  constructor({ memory = new LinearMemory(), onSyscall, jit = true } = {}) {
    this.#memory = memory;
    this.#syscall = onSyscall ?? (() => 0n);
    this.reset();
    this.#jit = createHotJit({ memory, registers: this.#regs, architecture: "arm", enabled: jit });
  }

  get memory() {
    return this.#memory;
  }

  get halted() {
    return this.#halted;
  }

  get steps() {
    return this.#steps;
  }

  get jit() {
    return this.#jit.stats();
  }

  registers() {
    const registers = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [`x${index}`, this.#regs.get(index)]),
    );
    const flags = this.#regs.rflags;
    return {
      ...registers,
      sp: this.#stack,
      pc: this.#regs.rip,
      nzcv:
        ((flags & FLAGS.SF) !== 0n ? 1n << 31n : 0n) |
        ((flags & FLAGS.ZF) !== 0n ? 1n << 30n : 0n) |
        ((flags & FLAGS.CF) !== 0n ? 1n << 29n : 0n) |
        ((flags & FLAGS.OF) !== 0n ? 1n << 28n : 0n),
      tpidr_el0: this.#tls,
    };
  }

  reset({ pc = 0n, sp = BigInt(this.#memory.size - 16) } = {}) {
    this.#regs.clear();
    this.#regs.rip = u64(pc);
    this.#stack = u64(sp);
    this.#tls = 0n;
    this.#halted = false;
    this.#steps = 0;
  }

  load(bytes, address = 0n) {
    this.#memory.load(bytes, address);
    this.#regs.rip = u64(address);
  }

  #x(index, bits = 64) {
    return index === 31 ? 0n : width(this.#regs.get(index), bits);
  }

  #setX(index, value) {
    if (index !== 31) this.#regs.set(index, u64(value));
  }

  #sp() {
    return this.#stack;
  }

  #setSp(value) {
    this.#stack = u64(value);
  }

  #nzcv(result, kind, left = 0n, right = 0n, bits = 64) {
    if (kind === "add") setAddFlags(this.#regs, left, right, result, bits);
    else if (kind === "sub") {
      setSubFlags(this.#regs, left, right, result, bits);
      this.#regs.rflags ^= FLAGS.CF; // AArch64 C is NOT-borrow for subtraction.
    } else setLogicalFlags(this.#regs, result, bits);
  }

  #cond(code) {
    const z = (this.#regs.rflags & FLAGS.ZF) !== 0n;
    const n = (this.#regs.rflags & FLAGS.SF) !== 0n;
    const c = (this.#regs.rflags & FLAGS.CF) !== 0n;
    const v = (this.#regs.rflags & FLAGS.OF) !== 0n;
    switch (code) {
      case 0x0:
        return z; // EQ
      case 0x1:
        return !z; // NE
      case 0x2:
        return c; // CS/HS
      case 0x3:
        return !c; // CC/LO
      case 0x4:
        return n; // MI
      case 0x5:
        return !n; // PL
      case 0x6:
        return v; // VS
      case 0x7:
        return !v; // VC
      case 0x8:
        return c && !z; // HI
      case 0x9:
        return !c || z; // LS
      case 0xa:
        return n === v; // GE
      case 0xb:
        return n !== v; // LT
      case 0xc:
        return !z && n === v; // GT
      case 0xd:
        return z || n !== v; // LE
      case 0xe:
        return true; // AL
      default:
        return false;
    }
  }

  step() {
    if (this.#halted) return false;
    const pc = this.#regs.rip;
    const word = read32(this.#memory, pc) >>> 0;
    this.#regs.rip = u64(pc + 4n);

    // NOP: d503201f
    if (word === 0xd503201f) {
      this.#steps += 1;
      return true;
    }

    // MSR/MRS TPIDR_EL0, Xt
    if ((word & 0xffffffe0) >>> 0 === 0xd51bd040) {
      this.#tls = this.#x(word & 31);
      this.#steps += 1;
      return true;
    }
    if ((word & 0xffffffe0) >>> 0 === 0xd53bd040) {
      this.#setX(word & 31, this.#tls);
      this.#steps += 1;
      return true;
    }

    // RET Xn
    if ((word & 0xfffffc1f) >>> 0 === 0xd65f0000) {
      this.#regs.rip = this.#x((word >> 5) & 31);
      this.#steps += 1;
      return true;
    }

    // SVC #imm: d4000001 | (imm16 << 5)
    if ((word & 0xffe0001f) >>> 0 === 0xd4000001) {
      const result = this.#syscall({
        nr: this.#x(8),
        args: [this.#x(0), this.#x(1), this.#x(2), this.#x(3), this.#x(4), this.#x(5)],
        cpu: this,
      });
      if (!applySyscallResult(this.#regs, 0, result)) this.#halted = true;
      this.#steps += 1;
      return !this.#halted;
    }

    // MOVZ Xd/Wd, #imm16, LSL #shift
    if ((word & 0x7f800000) === 0x52800000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const imm16 = (word >> 5) & 0xffff;
      const hw = (word >> 21) & 3;
      if (bits === 32 && hw > 1) throw new Error(`invalid 32-bit MOVZ at ${pc}`);
      this.#setX(rd, width(BigInt(imm16) << BigInt(hw * 16), bits));
      this.#steps += 1;
      return true;
    }

    // MOVK Xd/Wd, #imm16, LSL #shift
    if ((word & 0x7f800000) === 0x72800000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const imm16 = (word >> 5) & 0xffff;
      const hw = (word >> 21) & 3;
      if (bits === 32 && hw > 1) throw new Error(`invalid 32-bit MOVK at ${pc}`);
      const shift = BigInt(hw * 16);
      const mask = 0xffffn << shift;
      this.#setX(rd, width((this.#x(rd, bits) & ~mask) | (BigInt(imm16) << shift), bits));
      this.#steps += 1;
      return true;
    }

    // ADD/SUB{S} Xd, Xn, #imm12
    if ((word & 0x1f000000) === 0x11000000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const imm = BigInt((word >> 10) & 0xfff);
      const shift = (word >> 22) & 3;
      if (shift > 1) throw new Error(`invalid ADD/SUB immediate at ${pc}`);
      const value = imm << BigInt(shift === 1 ? 12 : 0);
      const left = width(rn === 31 ? this.#sp() : this.#x(rn), bits);
      const isSub = (word & 0x40000000) !== 0;
      const setFlags = (word & 0x20000000) !== 0;
      const result = width(isSub ? left - value : left + value, bits);
      if (setFlags) this.#nzcv(result, isSub ? "sub" : "add", left, value, bits);
      if (rd === 31 && !setFlags) this.#setSp(result);
      else this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // ADD/SUB{S} Xd, Xn, Xm (unshifted)
    if ((word & 0x1fe0fc00) === 0x0b000000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const rm = (word >> 16) & 31;
      const left = this.#x(rn, bits);
      const right = this.#x(rm, bits);
      const isSub = (word & 0x40000000) !== 0;
      const setFlags = (word & 0x20000000) !== 0;
      const result = width(isSub ? left - right : left + right, bits);
      if (setFlags) this.#nzcv(result, isSub ? "sub" : "add", left, right, bits);
      this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // AND/ORR/EOR/ANDS Xd, Xn, Xm (unshifted)
    if ((word & 0x1fe0fc00) === 0x0a000000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const rm = (word >> 16) & 31;
      const left = this.#x(rn, bits);
      const right = this.#x(rm, bits);
      const operation = (word >> 29) & 3;
      let result;
      if (operation === 0 || operation === 3) result = left & right;
      else if (operation === 1) result = left | right;
      else result = left ^ right;
      result = width(result, bits);
      if (operation === 3) this.#nzcv(result, "logic", 0n, 0n, bits);
      this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // MADD/MSUB Xd/Wd, Xn/Wn, Xm/Wm, Xa/Wa (MUL is MADD with ZR)
    const multiply = (word & 0x7fe08000) >>> 0;
    if (multiply === 0x1b000000 || multiply === 0x1b008000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const ra = (word >> 10) & 31;
      const rm = (word >> 16) & 31;
      const product = this.#x(rn, bits) * this.#x(rm, bits);
      const result = multiply === 0x1b008000 ? this.#x(ra, bits) - product : this.#x(ra, bits) + product;
      this.#setX(rd, width(result, bits));
      this.#steps += 1;
      return true;
    }

    // UDIV/SDIV Xd/Wd, Xn/Wn, Xm/Wm
    const divide = (word & 0x7fe0fc00) >>> 0;
    if (divide === 0x1ac00800 || divide === 0x1ac00c00) {
      const bits = word & 0x80000000 ? 64 : 32;
      const rd = word & 31;
      const left = this.#x((word >> 5) & 31, bits);
      const right = this.#x((word >> 16) & 31, bits);
      let result = 0n;
      if (right !== 0n) {
        result = divide === 0x1ac00800 ? left / right : BigInt.asIntN(bits, left) / BigInt.asIntN(bits, right);
      }
      this.#setX(rd, width(result, bits));
      this.#steps += 1;
      return true;
    }

    // Common UBFM/SBFM shift aliases: LSL, LSR, ASR
    const bitfield = word & 0x7f800000;
    if (bitfield === 0x53000000 || bitfield === 0x13000000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const n = Boolean(word & 0x00400000);
      if (n !== (bits === 64)) throw new Error(`invalid bitfield width at ${pc}`);
      const source = this.#x((word >> 5) & 31, bits);
      const immr = (word >> 16) & 63;
      const imms = (word >> 10) & 63;
      if (bits === 32 && (immr > 31 || imms > 31)) throw new Error(`invalid 32-bit bitfield at ${pc}`);
      let result;
      if (imms === bits - 1) {
        result = bitfield === 0x13000000 ? BigInt.asIntN(bits, source) >> BigInt(immr) : source >> BigInt(immr);
      } else if (bitfield === 0x53000000 && imms + 1 === immr) {
        result = source << BigInt(bits - immr);
      } else throw new Error(`unsupported aarch64 bitfield at ${pc}`);
      this.#setX(word & 31, width(result, bits));
      this.#steps += 1;
      return true;
    }

    // CSEL Xd/Wd, Xn/Wn, Xm/Wm, cond
    if ((word & 0x7fe00c00) === 0x1a800000) {
      const bits = word & 0x80000000 ? 64 : 32;
      const source = this.#cond((word >> 12) & 15) ? (word >> 5) & 31 : (word >> 16) & 31;
      this.#setX(word & 31, this.#x(source, bits));
      this.#steps += 1;
      return true;
    }

    // TBZ/TBNZ Xt, #bit, label
    if ((word & 0x7e000000) === 0x36000000) {
      const bit = ((word >>> 31) << 5) | ((word >> 19) & 31);
      let immediate = (word >> 5) & 0x3fff;
      if (immediate & 0x2000) immediate |= ~0x3fff;
      const zero = (this.#x(word & 31) & (1n << BigInt(bit))) === 0n;
      if (zero !== Boolean(word & 0x01000000)) this.#regs.rip = u64(pc + BigInt(immediate) * 4n);
      this.#steps += 1;
      return true;
    }

    // ADR/ADRP Xd, label
    const pcRelative = (word & 0x9f000000) >>> 0;
    if (pcRelative === 0x10000000 || pcRelative === 0x90000000) {
      const rd = word & 31;
      const immediate = BigInt.asIntN(21, BigInt(((word >> 5) & 0x7ffff) * 4 + ((word >> 29) & 3)));
      const value = pcRelative === 0x90000000 ? (pc & ~0xfffn) + (immediate << 12n) : pc + immediate;
      this.#setX(rd, value);
      this.#steps += 1;
      return true;
    }

    // CBZ/CBNZ Xt/Wt, label
    if ((word & 0x7e000000) === 0x34000000) {
      const bits = word & 0x80000000 ? 64 : 32;
      let immediate = (word >> 5) & 0x7ffff;
      if (immediate & 0x40000) immediate |= ~0x7ffff;
      const zero = this.#x(word & 31, bits) === 0n;
      if (zero !== Boolean(word & 0x01000000)) this.#regs.rip = u64(pc + BigInt(immediate) * 4n);
      this.#steps += 1;
      return true;
    }

    // LDR Xt/Wt or LDRSW Xt, label
    const literal = (word & 0xff000000) >>> 0;
    if (literal === 0x18000000 || literal === 0x58000000 || literal === 0x98000000) {
      let immediate = (word >> 5) & 0x7ffff;
      if (immediate & 0x40000) immediate |= ~0x7ffff;
      const address = u64(pc + BigInt(immediate) * 4n);
      const value = this.#memory.u32(address);
      this.#setX(
        word & 31,
        literal === 0x58000000
          ? this.#memory.u64(address)
          : literal === 0x98000000
            ? BigInt.asIntN(32, BigInt(value))
            : BigInt(value),
      );
      this.#steps += 1;
      return true;
    }

    // LDP/STP Xt/Wt, [Xn|SP, #imm] with offset, pre-index, or post-index
    const pair = (word & 0xffc00000) >>> 0;
    const pairMode = PAIR.get(pair);
    if (pairMode) {
      const [bits, load, mode] = pairMode;
      const rt = word & 31;
      const rn = (word >> 5) & 31;
      const rt2 = (word >> 10) & 31;
      const immediate = BigInt.asIntN(7, BigInt((word >> 15) & 0x7f)) * BigInt(bits / 8);
      const base = rn === 31 ? this.#sp() : this.#x(rn);
      const address = mode === 2 ? base : u64(base + immediate);
      if (load) {
        this.#setX(rt, bits === 64 ? this.#memory.u64(address) : BigInt(this.#memory.u32(address)));
        this.#setX(rt2, bits === 64 ? this.#memory.u64(address + 8n) : BigInt(this.#memory.u32(address + 4n)));
      } else {
        if (bits === 64) {
          this.#memory.u64(address, this.#x(rt));
          this.#memory.u64(address + 8n, this.#x(rt2));
        } else {
          this.#memory.u32(address, Number(this.#x(rt, 32)));
          this.#memory.u32(address + 4n, Number(this.#x(rt2, 32)));
        }
      }
      if (mode) {
        const next = mode === 1 ? address : u64(base + immediate);
        if (rn === 31) this.#setSp(next);
        else this.#setX(rn, next);
      }
      this.#steps += 1;
      return true;
    }

    // LDUR/STUR Xt/Wt, [Xn|SP, #simm9]
    const unscaled = (word & 0xffe00c00) >>> 0;
    if (unscaled === 0xf8000000 || unscaled === 0xf8400000 || unscaled === 0xb8000000 || unscaled === 0xb8400000) {
      const bits = word & 0x40000000 ? 64 : 32;
      const rt = word & 31;
      const rn = (word >> 5) & 31;
      const immediate = BigInt.asIntN(9, BigInt((word >> 12) & 0x1ff));
      const address = u64((rn === 31 ? this.#sp() : this.#x(rn)) + immediate);
      if (unscaled === 0xf8400000) this.#setX(rt, this.#memory.u64(address));
      else if (unscaled === 0xb8400000) this.#setX(rt, BigInt(this.#memory.u32(address)));
      else if (bits === 64) this.#memory.u64(address, this.#x(rt));
      else this.#memory.u32(address, Number(this.#x(rt, 32)));
      this.#steps += 1;
      return true;
    }

    // LDRB/STRB and LDRH/STRH with unsigned scaled offsets
    const smallTransfer = (word & 0xffc00000) >>> 0;
    if (
      smallTransfer === 0x39400000 ||
      smallTransfer === 0x39000000 ||
      smallTransfer === 0x79400000 ||
      smallTransfer === 0x79000000
    ) {
      const bytes = word & 0x40000000 ? 2 : 1;
      const rt = word & 31;
      const rn = (word >> 5) & 31;
      const address = u64((rn === 31 ? this.#sp() : this.#x(rn)) + BigInt((word >> 10) & 0xfff) * BigInt(bytes));
      const load = Boolean(word & 0x00400000);
      if (load) {
        const value = bytes === 1 ? this.#memory.u8(address) : this.#memory.u16(address);
        this.#setX(rt, BigInt(value));
      } else if (bytes === 1) this.#memory.u8(address, Number(this.#x(rt, 32)));
      else this.#memory.u16(address, Number(this.#x(rt, 32)));
      this.#steps += 1;
      return true;
    }

    // LDR/STR Xt/Wt, [Xn, #imm12*size]
    const transfer = (word & 0xffc00000) >>> 0;
    if (transfer === 0xf9400000 || transfer === 0xf9000000 || transfer === 0xb9400000 || transfer === 0xb9000000) {
      const bits = word & 0x40000000 ? 64 : 32;
      const rt = word & 31;
      const rn = (word >> 5) & 31;
      const imm = BigInt((word >> 10) & 0xfff) * BigInt(bits / 8);
      const base = rn === 31 ? this.#sp() : this.#x(rn);
      const address = u64(base + imm);
      if (transfer === 0xf9400000) this.#setX(rt, this.#memory.u64(address));
      else if (transfer === 0xb9400000) this.#setX(rt, BigInt(this.#memory.u32(address)));
      else if (transfer === 0xf9000000) this.#memory.u64(address, this.#x(rt));
      else this.#memory.u32(address, Number(this.#x(rt, 32)));
      this.#steps += 1;
      return true;
    }

    // B imm26
    if ((word & 0xfc000000) >>> 0 === 0x14000000) {
      let imm = word & 0x03ffffff;
      if (imm & 0x02000000) imm |= ~0x03ffffff;
      this.#regs.rip = u64(pc + BigInt(imm) * 4n);
      this.#steps += 1;
      return true;
    }

    // B.cond
    if ((word & 0xff000010) >>> 0 === 0x54000000) {
      let imm = (word >> 5) & 0x7ffff;
      if (imm & 0x40000) imm |= ~0x7ffff;
      if (this.#cond(word & 0xf)) this.#regs.rip = u64(pc + BigInt(imm) * 4n);
      this.#steps += 1;
      return true;
    }

    // BL imm26
    if ((word & 0xfc000000) >>> 0 === 0x94000000) {
      let imm = word & 0x03ffffff;
      if (imm & 0x02000000) imm |= ~0x03ffffff;
      this.#setX(30, this.#regs.rip);
      this.#regs.rip = u64(pc + BigInt(imm) * 4n);
      this.#steps += 1;
      return true;
    }

    throw new Error(`unsupported aarch64 word ${word.toString(16)} at ${pc}`);
  }

  #runUntil(limit) {
    while (!this.#halted && this.#steps < limit) {
      const compiled = this.#jit.execute(limit - this.#steps);
      if (compiled) {
        this.#steps += compiled;
        continue;
      }
      if (!this.step()) break;
    }
  }

  run({ maxSteps = 100_000 } = {}) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new TypeError("maxSteps must be a positive integer");
    this.#runUntil(maxSteps);
    if (!this.#halted && this.#steps >= maxSteps) throw new Error("CPU step limit exceeded");
    return this.registers();
  }

  async runAsync({ maxSteps = 100_000, quantum = 10_000, signal, yield: hostYield = yieldThread } = {}) {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new TypeError("maxSteps must be a positive integer");
    if (!Number.isSafeInteger(quantum) || quantum < 1) throw new TypeError("quantum must be a positive integer");
    if (typeof hostYield !== "function") throw new TypeError("yield must be a function");
    while (!this.#halted && this.#steps < maxSteps) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("CPU execution aborted");
      this.#runUntil(Math.min(maxSteps, this.#steps + quantum));
      if (!this.#halted && this.#steps < maxSteps) await hostYield();
    }
    if (!this.#halted) throw new Error("CPU step limit exceeded");
    return this.registers();
  }
}

export const createArm = (options) => new ArmCpu(options);
