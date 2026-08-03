import { FLAGS, LinearMemory, RegisterFile, setAddFlags, setLogicalFlags, setSubFlags, u64 } from "./memory.js";

const read32 = (memory, pc) => memory.u32(pc);

export class ArmCpu {
  #memory;
  #regs = new RegisterFile();
  #syscall;
  #halted = false;
  #steps = 0;

  constructor({ memory = new LinearMemory(), onSyscall } = {}) {
    this.#memory = memory;
    this.#syscall = onSyscall ?? (() => 0n);
    this.reset();
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

  registers() {
    return this.#regs.snapshot();
  }

  reset({ pc = 0n, sp = BigInt(this.#memory.size - 16) } = {}) {
    this.#regs = new RegisterFile();
    this.#regs.rip = u64(pc);
    this.#regs.set(31, 0n); // XZR/SP handled specially
    this.#regs.set(16, u64(sp)); // use X16 as SP stand-in for toys; also keep x31 via rsp slot
    this.#regs.set(4, u64(sp));
    this.#halted = false;
    this.#steps = 0;
  }

  load(bytes, address = 0n) {
    this.#memory.load(bytes, address);
    this.#regs.rip = u64(address);
  }

  #x(index) {
    return index === 31 ? 0n : this.#regs.get(index);
  }

  #setX(index, value) {
    if (index !== 31) this.#regs.set(index, u64(value));
  }

  #sp() {
    return this.#regs.get(4);
  }

  #setSp(value) {
    this.#regs.set(4, u64(value));
  }

  #nzcv(result, kind, left = 0n, right = 0n) {
    if (kind === "add") setAddFlags(this.#regs, left, right, result);
    else if (kind === "sub") setSubFlags(this.#regs, left, right, result);
    else setLogicalFlags(this.#regs, result);
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

    // RET (X30)
    if (word === 0xd65f03c0) {
      this.#regs.rip = this.#x(30);
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
      if (result === null || result === undefined) this.#halted = true;
      else this.#setX(0, result);
      this.#steps += 1;
      return !this.#halted;
    }

    // MOVZ Xd, #imm16, LSL #shift
    if ((word & 0xff800000) >>> 0 === 0xd2800000) {
      const rd = word & 31;
      const imm16 = (word >> 5) & 0xffff;
      const hw = (word >> 21) & 3;
      this.#setX(rd, BigInt(imm16) << BigInt(hw * 16));
      this.#steps += 1;
      return true;
    }

    // MOVK Xd, #imm16, LSL #shift
    if ((word & 0xff800000) >>> 0 === 0xf2800000) {
      const rd = word & 31;
      const imm16 = (word >> 5) & 0xffff;
      const hw = (word >> 21) & 3;
      const shift = BigInt(hw * 16);
      const mask = 0xffffn << shift;
      this.#setX(rd, (this.#x(rd) & ~mask) | (BigInt(imm16) << shift));
      this.#steps += 1;
      return true;
    }

    // ADD/SUB Xd, Xn, #imm12
    if ((word & 0x7f000000) === 0x11000000 || (word & 0x7f000000) === 0x51000000) {
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const imm = BigInt((word >> 10) & 0xfff);
      const shift = (word >> 22) & 3;
      const value = imm << BigInt(shift === 1 ? 12 : 0);
      const left = rn === 31 ? this.#sp() : this.#x(rn);
      const isSub = (word & 0x40000000) !== 0;
      const result = isSub ? u64(left - value) : u64(left + value);
      if ((word & 0x20000000) !== 0) this.#nzcv(result, isSub ? "sub" : "add", left, value);
      if (rd === 31) this.#setSp(result);
      else this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // ADD/SUB Xd, Xn, Xm
    if ((word & 0x7fe0fc00) === 0x0b000000 || (word & 0x7fe0fc00) === 0x4b000000) {
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const rm = (word >> 16) & 31;
      const left = this.#x(rn);
      const right = this.#x(rm);
      const isSub = (word & 0x40000000) !== 0;
      const result = isSub ? u64(left - right) : u64(left + right);
      if ((word & 0x20000000) !== 0) this.#nzcv(result, isSub ? "sub" : "add", left, right);
      this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // AND/ORR/EOR Xd, Xn, Xm
    if (
      (word & 0x7fe0fc00) === 0x0a000000 ||
      (word & 0x7fe0fc00) === 0x2a000000 ||
      (word & 0x7fe0fc00) === 0x4a000000
    ) {
      const rd = word & 31;
      const rn = (word >> 5) & 31;
      const rm = (word >> 16) & 31;
      const left = this.#x(rn);
      const right = this.#x(rm);
      let result;
      if ((word & 0x7fe0fc00) === 0x0a000000) result = left & right;
      else if ((word & 0x7fe0fc00) === 0x2a000000) result = left | right;
      else result = left ^ right;
      this.#nzcv(result, "logic");
      this.#setX(rd, result);
      this.#steps += 1;
      return true;
    }

    // LDR/STR Xt, [Xn, #imm12*8]
    if ((word & 0xffc00000) >>> 0 === 0xf9400000 || (word & 0xffc00000) >>> 0 === 0xf9000000) {
      const rt = word & 31;
      const rn = (word >> 5) & 31;
      const imm = BigInt((word >> 10) & 0xfff) << 3n;
      const base = rn === 31 ? this.#sp() : this.#x(rn);
      const address = u64(base + imm);
      if ((word & 0xffc00000) >>> 0 === 0xf9400000) this.#setX(rt, this.#memory.u64(address));
      else this.#memory.u64(address, this.#x(rt));
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

  run({ maxSteps = 100_000 } = {}) {
    while (!this.#halted && this.#steps < maxSteps) {
      if (!this.step()) break;
    }
    if (!this.#halted && this.#steps >= maxSteps) throw new Error("CPU step limit exceeded");
    return this.registers();
  }
}

export const createArm = (options) => new ArmCpu(options);
