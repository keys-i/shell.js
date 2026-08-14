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
const width = (value, bits) => BigInt.asUintN(bits, BigInt(value));
const yieldThread = () => new Promise((resolve) => setTimeout(resolve, 0));

export class X86Cpu {
  #memory;
  #regs = new RegisterFile();
  #syscall;
  #jit;
  #fsBase = 0n;
  #addressBase = 0n;
  #halted = false;
  #steps = 0;

  constructor({ memory = new LinearMemory(), onSyscall, jit = true } = {}) {
    this.#memory = memory;
    this.#syscall = onSyscall ?? (() => 0n);
    this.reset();
    this.#jit = createHotJit({ memory, registers: this.#regs, architecture: "x86", enabled: jit });
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
    return { ...this.#regs.snapshot(), fsBase: this.#fsBase };
  }

  setTls(value) {
    this.#fsBase = u64(value);
  }

  reset({ rip = 0n, rsp = BigInt(this.#memory.size - 8) } = {}) {
    this.#regs.clear();
    this.#regs.rip = u64(rip);
    this.#regs.set(REG.rsp, u64(rsp));
    this.#fsBase = 0n;
    this.#halted = false;
    this.#steps = 0;
  }

  load(bytes, address = 0n) {
    this.#memory.load(bytes, address);
    this.#regs.rip = u64(address);
  }

  #modrm(rex, addressBase = this.#addressBase) {
    const modrm = readImm8(this.#memory, this.#regs);
    const mod = modrm >> 6;
    const encodedReg = (modrm >> 3) & 7;
    const reg = (rex.r ? 8 : 0) | encodedReg;
    const encodedRm = modrm & 7;
    const rm = (rex.b ? 8 : 0) | encodedRm;
    if (mod === 3) return { encodedReg, encodedRm, reg, rm, mode: "reg" };
    let address;
    if (encodedRm === 4) {
      const sib = readImm8(this.#memory, this.#regs);
      const scale = BigInt(sib >> 6);
      const encodedIndex = (sib >> 3) & 7;
      const encodedBase = sib & 7;
      const index = (rex.x ? 8 : 0) | encodedIndex;
      const base = (rex.b ? 8 : 0) | encodedBase;
      address = encodedBase === 5 && mod === 0 ? 0n : this.#regs.get(base);
      if (encodedIndex !== 4 || rex.x) address = u64(address + (this.#regs.get(index) << scale));
      if (encodedBase === 5 && mod === 0) address = u64(address + sign32(readImm32(this.#memory, this.#regs)));
    } else if (encodedRm === 5 && mod === 0) {
      const displacement = sign32(readImm32(this.#memory, this.#regs));
      address = u64(this.#regs.rip + displacement);
    } else {
      address = this.#regs.get(rm);
    }
    if (mod === 1) address = u64(address + sign8(readImm8(this.#memory, this.#regs)));
    if (mod === 2) address = u64(address + sign32(readImm32(this.#memory, this.#regs)));
    return { encodedReg, encodedRm, reg, rm, mode: "mem", address: u64(address + addressBase) };
  }

  #readOp(op, bits = 64) {
    if (op.mode === "reg") return width(this.#regs.get(op.rm), bits);
    return bits === 64 ? this.#memory.u64(op.address) : BigInt(this.#memory.u32(op.address));
  }

  #writeOp(op, value, bits = 64) {
    value = width(value, bits);
    if (op.mode === "reg") this.#regs.set(op.rm, value);
    else if (bits === 64) this.#memory.u64(op.address, value);
    else this.#memory.u32(op.address, Number(value));
  }

  #readByte(index, encoded, rex) {
    if (!rex.present && encoded >= 4) return (this.#regs.get(encoded - 4) >> 8n) & 0xffn;
    return this.#regs.get(index) & 0xffn;
  }

  #writeByte(index, encoded, rex, value) {
    value = width(value, 8);
    if (!rex.present && encoded >= 4) {
      const target = encoded - 4;
      this.#regs.set(target, (this.#regs.get(target) & ~0xff00n) | (value << 8n));
    } else this.#regs.set(index, (this.#regs.get(index) & ~0xffn) | value);
  }

  #readByteOp(op, rex) {
    return op.mode === "mem" ? BigInt(this.#memory.u8(op.address)) : this.#readByte(op.rm, op.encodedRm, rex);
  }

  #writeByteOp(op, rex, value) {
    if (op.mode === "mem") this.#memory.u8(op.address, Number(value));
    else this.#writeByte(op.rm, op.encodedRm, rex, value);
  }

  step() {
    if (this.#halted) return false;
    const start = this.#regs.rip;
    this.#addressBase = 0n;
    let rex = { w: false, r: false, x: false, b: false, present: false };
    let opcode = readImm8(this.#memory, this.#regs);
    if (opcode === 0x64) {
      this.#addressBase = this.#fsBase;
      opcode = readImm8(this.#memory, this.#regs);
    }
    if ((opcode & 0xf0) === 0x40) {
      rex = {
        w: Boolean(opcode & 8),
        r: Boolean(opcode & 4),
        x: Boolean(opcode & 2),
        b: Boolean(opcode & 1),
        present: true,
      };
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

    if (opcode === 0xc9) {
      const rbp = this.#regs.get(REG.rbp);
      this.#regs.set(REG.rsp, rbp + 8n);
      this.#regs.set(REG.rbp, this.#memory.u64(rbp));
      this.#steps += 1;
      return true;
    }

    if (opcode >= 0x50 && opcode <= 0x57) {
      const reg = (rex.b ? 8 : 0) | (opcode & 7);
      const value = this.#regs.get(reg);
      const rsp = this.#regs.get(REG.rsp) - 8n;
      this.#regs.set(REG.rsp, rsp);
      this.#memory.u64(rsp, value);
      this.#steps += 1;
      return true;
    }

    if (opcode >= 0x58 && opcode <= 0x5f) {
      const reg = (rex.b ? 8 : 0) | (opcode & 7);
      const rsp = this.#regs.get(REG.rsp);
      const value = this.#memory.u64(rsp);
      this.#regs.set(REG.rsp, rsp + 8n);
      this.#regs.set(reg, value);
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

    if (opcode === 0x6a) {
      const imm = sign8(readImm8(this.#memory, this.#regs));
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

    if (opcode === 0xc6 || opcode === 0xc7) {
      const op = this.#modrm(rex);
      if ((op.reg & 7) !== 0) throw new Error(`unsupported mov immediate /${op.reg & 7}`);
      if (opcode === 0xc6) this.#writeByteOp(op, rex, BigInt(readImm8(this.#memory, this.#regs)));
      else {
        const immediate = readImm32(this.#memory, this.#regs);
        this.#writeOp(op, rex.w ? sign32(immediate) : BigInt(immediate), rex.w ? 64 : 32);
      }
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
      const rel = sign32(readImm32(this.#memory, this.#regs));
      this.#regs.rip = u64(this.#regs.rip + rel);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xeb) {
      const rel = sign8(readImm8(this.#memory, this.#regs));
      this.#regs.rip = u64(this.#regs.rip + rel);
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
      if (second >= 0x90 && second <= 0x9f) {
        const op = this.#modrm(rex);
        this.#writeByteOp(op, rex, this.#condition(second & 0xf) ? 1n : 0n);
        this.#steps += 1;
        return true;
      }
      if (second === 0xb6 || second === 0xbe) {
        const op = this.#modrm(rex);
        const value = this.#readByteOp(op, rex);
        const bits = rex.w ? 64 : 32;
        this.#regs.set(op.reg, second === 0xb6 ? value : width(BigInt.asIntN(8, value), bits));
        this.#steps += 1;
        return true;
      }
      if (second === 0xaf) {
        const op = this.#modrm(rex);
        const bits = rex.w ? 64 : 32;
        const product = BigInt.asIntN(bits, this.#regs.get(op.reg)) * BigInt.asIntN(bits, this.#readOp(op, bits));
        const result = width(product, bits);
        this.#regs.set(op.reg, result);
        const overflow = product !== BigInt.asIntN(bits, result);
        this.#regs.rflags = (this.#regs.rflags & ~(FLAGS.CF | FLAGS.OF)) | (overflow ? FLAGS.CF | FLAGS.OF : 0n);
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
        if (!applySyscallResult(this.#regs, REG.rax, result)) this.#halted = true;
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

    if (opcode === 0x88 || opcode === 0x8a) {
      const op = this.#modrm(rex);
      if (opcode === 0x88) {
        this.#writeByteOp(op, rex, this.#readByte(op.reg, op.encodedReg, rex));
      } else {
        this.#writeByte(op.reg, op.encodedReg, rex, this.#readByteOp(op, rex));
      }
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x84 || opcode === 0x85) {
      const op = this.#modrm(rex);
      const bits = opcode === 0x84 ? 8 : rex.w ? 64 : 32;
      const left = opcode === 0x84 ? this.#readByteOp(op, rex) : this.#readOp(op, bits);
      const right = opcode === 0x84 ? this.#readByte(op.reg, op.encodedReg, rex) : width(this.#regs.get(op.reg), bits);
      setLogicalFlags(this.#regs, left & right, bits);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xa8 || opcode === 0xa9) {
      const bits = opcode === 0xa8 ? 8 : rex.w ? 64 : 32;
      const immediate =
        opcode === 0xa8
          ? BigInt(readImm8(this.#memory, this.#regs))
          : rex.w
            ? u64(sign32(readImm32(this.#memory, this.#regs)))
            : BigInt(readImm32(this.#memory, this.#regs));
      setLogicalFlags(this.#regs, width(this.#regs.get(REG.rax), bits) & immediate, bits);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x63) {
      const op = this.#modrm(rex);
      const value = BigInt.asIntN(32, this.#readOp(op, 32));
      this.#regs.set(op.reg, width(value, rex.w ? 64 : 32));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x89 || opcode === 0x8b) {
      const op = this.#modrm(rex);
      const bits = rex.w ? 64 : 32;
      if (opcode === 0x89) this.#writeOp(op, this.#regs.get(op.reg), bits);
      else this.#regs.set(op.reg, this.#readOp(op, bits));
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x8d) {
      const op = this.#modrm(rex, 0n);
      if (op.mode !== "mem") throw new Error("LEA requires memory operand");
      this.#regs.set(op.reg, width(op.address, rex.w ? 64 : 32));
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
      const bits = rex.w ? 64 : 32;
      const regValue = width(this.#regs.get(op.reg), bits);
      const rmValue = this.#readOp(op, bits);
      const dstIsReg = (opcode & 2) !== 0;
      const left = dstIsReg ? regValue : rmValue;
      const right = dstIsReg ? rmValue : regValue;
      let result;
      switch (opcode & 0xfd) {
        case 0x01:
          result = width(left + right, bits);
          setAddFlags(this.#regs, left, right, result, bits);
          break;
        case 0x29:
          result = width(left - right, bits);
          setSubFlags(this.#regs, left, right, result, bits);
          break;
        case 0x21:
          result = left & right;
          setLogicalFlags(this.#regs, result, bits);
          break;
        case 0x09:
          result = left | right;
          setLogicalFlags(this.#regs, result, bits);
          break;
        case 0x31:
          result = left ^ right;
          setLogicalFlags(this.#regs, result, bits);
          break;
        case 0x39:
          result = width(left - right, bits);
          setSubFlags(this.#regs, left, right, result, bits);
          this.#steps += 1;
          return true;
        default:
          throw new Error(`unhandled alu ${opcode.toString(16)}`);
      }
      if (dstIsReg) this.#regs.set(op.reg, result);
      else this.#writeOp(op, result, bits);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0x81 || opcode === 0x83) {
      const op = this.#modrm(rex);
      const imm =
        opcode === 0x83 ? sign8(readImm8(this.#memory, this.#regs)) : sign32(readImm32(this.#memory, this.#regs));
      const bits = rex.w ? 64 : 32;
      const left = this.#readOp(op, bits);
      const group = op.reg & 7;
      let result;
      if (group === 0) {
        result = width(left + imm, bits);
        setAddFlags(this.#regs, left, imm, result, bits);
      } else if (group === 4) {
        result = left & width(imm, bits);
        setLogicalFlags(this.#regs, result, bits);
      } else if (group === 1) {
        result = left | width(imm, bits);
        setLogicalFlags(this.#regs, result, bits);
      } else if (group === 5) {
        result = width(left - imm, bits);
        setSubFlags(this.#regs, left, imm, result, bits);
      } else if (group === 6) {
        result = left ^ width(imm, bits);
        setLogicalFlags(this.#regs, result, bits);
      } else if (group === 7) {
        result = width(left - imm, bits);
        setSubFlags(this.#regs, left, imm, result, bits);
        this.#steps += 1;
        return true;
      } else throw new Error(`unsupported group1 /${group}`);
      this.#writeOp(op, result, bits);
      this.#steps += 1;
      return true;
    }

    if (opcode === 0xff) {
      const op = this.#modrm(rex);
      const group = op.reg & 7;
      if (group === 0) {
        const bits = rex.w ? 64 : 32;
        const before = this.#readOp(op, bits);
        const value = width(before + 1n, bits);
        const carry = this.#regs.rflags & FLAGS.CF;
        setAddFlags(this.#regs, before, 1n, value, bits);
        this.#regs.rflags = (this.#regs.rflags & ~FLAGS.CF) | carry;
        this.#writeOp(op, value, bits);
      } else if (group === 1) {
        const bits = rex.w ? 64 : 32;
        const before = this.#readOp(op, bits);
        const value = width(before - 1n, bits);
        const carry = this.#regs.rflags & FLAGS.CF;
        setSubFlags(this.#regs, before, 1n, value, bits);
        this.#regs.rflags = (this.#regs.rflags & ~FLAGS.CF) | carry;
        this.#writeOp(op, value, bits);
      } else if (group === 2) {
        const target = this.#readOp(op);
        const rsp = this.#regs.get(REG.rsp) - 8n;
        this.#regs.set(REG.rsp, rsp);
        this.#memory.u64(rsp, this.#regs.rip);
        this.#regs.rip = target;
      } else if (group === 4) {
        this.#regs.rip = this.#readOp(op);
      } else if (group === 6) {
        const value = this.#readOp(op);
        const rsp = this.#regs.get(REG.rsp) - 8n;
        this.#regs.set(REG.rsp, rsp);
        this.#memory.u64(rsp, value);
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
      case 0xa:
        return (this.#regs.rflags & FLAGS.PF) !== 0n;
      case 0xb:
        return (this.#regs.rflags & FLAGS.PF) === 0n;
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

export const createX86 = (options) => new X86Cpu(options);
export { REG, FLAGS, LinearMemory, RegisterFile };
