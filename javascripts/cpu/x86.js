import { FLAGS, LinearMemory, RegisterFile, setAddFlags, setLogicalFlags, setSubFlags, u64 } from "./memory.js";

const REG = Object.freeze({
  rax: 0,
  rcx: 1,
  rdx: 2,
  rbx: 3,
  rsp: 4,
  rbp: 5,
  rsi: 6,
  rdi: 7,
  r8: 8,
  r9: 9,
  r10: 10,
  r11: 11,
  r12: 12,
  r13: 13,
  r14: 14,
  r15: 15,
});

const readImm8 = (mem, regs) => {
  const value = mem.u8(regs.rip);
  regs.rip += 1n;
  return value;
};

const readImm32 = (mem, regs) => {
  const value = mem.u32(regs.rip);
  regs.rip += 4n;
  return value;
};

const readImm64 = (mem, regs) => {
  const value = mem.u64(regs.rip);
  regs.rip += 8n;
  return value;
};

const sign8 = (value) => BigInt.asIntN(8, BigInt(value));
const sign32 = (value) => BigInt.asIntN(32, BigInt(value));

export class X86Cpu {
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

  reset({ rip = 0n, rsp = BigInt(this.#memory.size - 8) } = {}) {
    this.#regs = new RegisterFile();
    this.#regs.rip = u64(rip);
    this.#regs.set(REG.rsp, u64(rsp));
    this.#halted = false;
    this.#steps = 0;
  }

  load(bytes, address = 0n) {
    this.#memory.load(bytes, address);
    this.#regs.rip = u64(address);
  }

  #modrm(rex) {
    const modrm = readImm8(this.#memory, this.#regs);
    const mod = modrm >> 6;
    const reg = (rex.r ? 8 : 0) | ((modrm >> 3) & 7);
    const rm = (rex.b ? 8 : 0) | (modrm & 7);
    if (mod === 3) return { reg, rm, mode: "reg" };
    if (rm === 4 || rm === 12) throw new Error("SIB addressing is not in the documented subset");
    let address = this.#regs.get(rm);
    if (mod === 1) address = u64(address + sign8(readImm8(this.#memory, this.#regs)));
    if (mod === 2) address = u64(address + sign32(readImm32(this.#memory, this.#regs)));
    if (mod === 0 && (rm === 5 || rm === 13)) {
      address = u64(this.#regs.rip + sign32(readImm32(this.#memory, this.#regs)));
    }
    return { reg, rm, mode: "mem", address };
  }

  #readOp(op) {
    return op.mode === "reg" ? this.#regs.get(op.rm) : this.#memory.u64(op.address);
  }

  #writeOp(op, value) {
    if (op.mode === "reg") this.#regs.set(op.rm, value);
    else this.#memory.u64(op.address, value);
  }

  step() {
    if (this.#halted) return false;
    const start = this.#regs.rip;
    let rex = { w: false, r: false, x: false, b: false };
    let opcode = readImm8(this.#memory, this.#regs);
    if ((opcode & 0xf0) === 0x40) {
      rex = { w: Boolean(opcode & 8), r: Boolean(opcode & 4), x: Boolean(opcode & 2), b: Boolean(opcode & 1) };
      opcode = readImm8(this.#memory, this.#regs);
    }

    if (opcode === 0x90) {
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xc3) {
      this.#regs.rip = this.#memory.u64(this.#regs.get(REG.rsp));
      this.#regs.set(REG.rsp, this.#regs.get(REG.rsp) + 8n);
      this.#steps += 1;
      return true;
    }

    if (opcode >= 0x50 && opcode <= 0x57) {
      const reg = (rex.b ? 8 : 0) | (opcode & 7);
      const rsp = this.#regs.get(REG.rsp) - 8n;
      this.#regs.set(REG.rsp, rsp);
      this.#memory.u64(rsp, this.#regs.get(reg));
      this.#steps += 1;
      return true;
    }

    if (opcode >= 0x58 && opcode <= 0x5f) {
      const reg = (rex.b ? 8 : 0) | (opcode & 7);
      const rsp = this.#regs.get(REG.rsp);
      this.#regs.set(reg, this.#memory.u64(rsp));
      this.#regs.set(REG.rsp, rsp + 8n);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x68) {
      const imm = sign32(readImm32(this.#memory, this.#regs));
      const rsp = this.#regs.get(REG.rsp) - 8n;
      this.#regs.set(REG.rsp, rsp);
      this.#memory.u64(rsp, u64(imm));
      this.#steps += 1;
      return true;
    }

    if (opcode >= 0xb8 && opcode <= 0xbf) {
      const reg = (rex.b ? 8 : 0) | (opcode & 7);
      this.#regs.set(reg, rex.w ? readImm64(this.#memory, this.#regs) : u64(readImm32(this.#memory, this.#regs)));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xe8) {
      const rel = sign32(readImm32(this.#memory, this.#regs));
      const rsp = this.#regs.get(REG.rsp) - 8n;
      this.#regs.set(REG.rsp, rsp);
      this.#memory.u64(rsp, this.#regs.rip);
      this.#regs.rip = u64(this.#regs.rip + rel);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xe9) {
      this.#regs.rip = u64(this.#regs.rip + sign32(readImm32(this.#memory, this.#regs)));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xeb) {
      this.#regs.rip = u64(this.#regs.rip + sign8(readImm8(this.#memory, this.#regs)));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x0f) {
      const second = readImm8(this.#memory, this.#regs);
      if (second >= 0x80 && second <= 0x8f) {
        const rel = sign32(readImm32(this.#memory, this.#regs));
        if (this.#condition(second & 0xf)) this.#regs.rip = u64(this.#regs.rip + rel);
        this.#steps += 1;
        return true;
      }
      if (second === 0x05) {
        const result = this.#syscall({
          nr: this.#regs.get(REG.rax),
          args: [
            this.#regs.get(REG.rdi),
            this.#regs.get(REG.rsi),
            this.#regs.get(REG.rdx),
            this.#regs.get(REG.r10),
            this.#regs.get(REG.r8),
            this.#regs.get(REG.r9),
          ],
          cpu: this,
        });
        if (result === null || result === undefined) this.#halted = true;
        else this.#regs.set(REG.rax, u64(result));
        this.#steps += 1;
        return !this.#halted;
      }
      throw new Error(`unsupported opcode 0f ${second.toString(16)} at ${start}`);
    }

    if (opcode >= 0x70 && opcode <= 0x7f) {
      const rel = sign8(readImm8(this.#memory, this.#regs));
      if (this.#condition(opcode & 0xf)) this.#regs.rip = u64(this.#regs.rip + rel);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x89 || opcode === 0x8b) {
      const op = this.#modrm(rex);
      if (opcode === 0x89) this.#writeOp(op, this.#regs.get(op.reg));
      else this.#regs.set(op.reg, this.#readOp(op));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x8d) {
      const op = this.#modrm(rex);
      if (op.mode !== "mem") throw new Error("LEA requires memory operand");
      this.#regs.set(op.reg, op.address);
      this.#steps += 1;
      return true;
    }

    if (
      opcode === 0x01 ||
      opcode === 0x03 ||
      opcode === 0x29 ||
      opcode === 0x2b ||
      opcode === 0x21 ||
      opcode === 0x23 ||
      opcode === 0x09 ||
      opcode === 0x0b ||
      opcode === 0x31 ||
      opcode === 0x33 ||
      opcode === 0x39 ||
      opcode === 0x3b
    ) {
      const op = this.#modrm(rex);
      const regValue = this.#regs.get(op.reg);
      const rmValue = this.#readOp(op);
      const dstIsReg = (opcode & 2) !== 0;
      const left = dstIsReg ? regValue : rmValue;
      const right = dstIsReg ? rmValue : regValue;
      let result;
      switch (opcode & 0xfd) {
        case 0x01:
          result = u64(left + right);
          setAddFlags(this.#regs, left, right, result);
          break;
        case 0x29:
          result = u64(left - right);
          setSubFlags(this.#regs, left, right, result);
          break;
        case 0x21:
          result = left & right;
          setLogicalFlags(this.#regs, result);
          break;
        case 0x09:
          result = left | right;
          setLogicalFlags(this.#regs, result);
          break;
        case 0x31:
          result = left ^ right;
          setLogicalFlags(this.#regs, result);
          break;
        case 0x39:
          result = u64(left - right);
          setSubFlags(this.#regs, left, right, result);
          this.#steps += 1;
          return true;
        default:
          throw new Error(`unhandled alu ${opcode.toString(16)}`);
      }
      if (dstIsReg) this.#regs.set(op.reg, result);
      else this.#writeOp(op, result);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x81 || opcode === 0x83) {
      const op = this.#modrm(rex);
      const imm =
        opcode === 0x83 ? sign8(readImm8(this.#memory, this.#regs)) : sign32(readImm32(this.#memory, this.#regs));
      const left = this.#readOp(op);
      const group = op.reg & 7;
      let result;
      if (group === 0) {
        result = u64(left + imm);
        setAddFlags(this.#regs, left, imm, result);
      } else if (group === 4) {
        result = left & u64(imm);
        setLogicalFlags(this.#regs, result);
      } else if (group === 1) {
        result = left | u64(imm);
        setLogicalFlags(this.#regs, result);
      } else if (group === 5) {
        result = u64(left - imm);
        setSubFlags(this.#regs, left, imm, result);
      } else if (group === 6) {
        result = left ^ u64(imm);
        setLogicalFlags(this.#regs, result);
      } else if (group === 7) {
        result = u64(left - imm);
        setSubFlags(this.#regs, left, imm, result);
        this.#steps += 1;
        return true;
      } else throw new Error(`unsupported group1 /${group}`);
      this.#writeOp(op, result);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xff) {
      const op = this.#modrm(rex);
      const group = op.reg & 7;
      if (group === 0) {
        const before = this.#readOp(op);
        const value = u64(before + 1n);
        setAddFlags(this.#regs, before, 1n, value);
        this.#writeOp(op, value);
      } else if (group === 1) {
        const before = this.#readOp(op);
        const value = u64(before - 1n);
        setSubFlags(this.#regs, before, 1n, value);
        this.#writeOp(op, value);
      } else if (group === 4) {
        this.#regs.rip = this.#readOp(op);
      } else throw new Error(`unsupported ff /${group}`);
      this.#steps += 1;
      return true;
    }

    throw new Error(`unsupported opcode ${opcode.toString(16)} at ${start}`);
  }

  #condition(code) {
    const z = (this.#regs.rflags & FLAGS.ZF) !== 0n;
    const s = (this.#regs.rflags & FLAGS.SF) !== 0n;
    const c = (this.#regs.rflags & FLAGS.CF) !== 0n;
    const o = (this.#regs.rflags & FLAGS.OF) !== 0n;
    switch (code) {
      case 0x0:
        return o;
      case 0x1:
        return !o;
      case 0x2:
        return c;
      case 0x3:
        return !c;
      case 0x4:
        return z;
      case 0x5:
        return !z;
      case 0x6:
        return c || z;
      case 0x7:
        return !c && !z;
      case 0x8:
        return s;
      case 0x9:
        return !s;
      case 0xc:
        return s !== o;
      case 0xd:
        return s === o;
      case 0xe:
        return z || s !== o;
      case 0xf:
        return !z && s === o;
      default:
        return false;
    }
  }

  run({ maxSteps = 100_000 } = {}) {
    while (!this.#halted && this.#steps < maxSteps) {
      if (!this.step()) break;
    }
    if (!this.#halted && this.#steps >= maxSteps) throw new Error("CPU step limit exceeded");
    return this.registers();
  }
}

export const createX86 = (options) => new X86Cpu(options);
export { REG, FLAGS, LinearMemory, RegisterFile };
