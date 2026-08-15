const CF = 1n;
const PF = 1n << 2n;
const ZF = 1n << 6n;
const SF = 1n << 7n;
const OF = 1n << 11n;
const FLAG_MASK = CF | PF | ZF | SF | OF;
const X86_ALU = new Map([
  [0x01, "add"],
  [0x03, "add"],
  [0x09, "or"],
  [0x0b, "or"],
  [0x21, "and"],
  [0x23, "and"],
  [0x29, "sub"],
  [0x2b, "sub"],
  [0x31, "xor"],
  [0x33, "xor"],
  [0x39, "sub"],
  [0x3b, "sub"],
]);

const u64 = (value) => BigInt.asUintN(64, BigInt(value));
const sign8 = (value) => BigInt.asIntN(8, BigInt(value));
const sign32 = (value) => BigInt.asIntN(32, BigInt(value));

const unsigned = (value) => {
  const bytes = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const signed = (value) => {
  value = BigInt(value);
  const bytes = [];
  for (;;) {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    const done = (value === 0n && !(byte & 0x40)) || (value === -1n && Boolean(byte & 0x40));
    if (!done) byte |= 0x80;
    bytes.push(byte);
    if (done) return bytes;
  }
};

const text = (value) => {
  const bytes = new TextEncoder().encode(value);
  return [...unsigned(BigInt(bytes.length)), ...bytes];
};

const section = (id, bytes) => [id, ...unsigned(BigInt(bytes.length)), ...bytes];

class Code {
  bytes = [];

  emit(...bytes) {
    this.bytes.push(...bytes);
  }

  i32(value) {
    this.emit(0x41, ...signed(BigInt(value)));
  }

  i64(value) {
    this.emit(0x42, ...signed(BigInt.asIntN(64, BigInt(value))));
  }

  localGet(index) {
    this.emit(0x20, ...unsigned(BigInt(index)));
  }

  localSet(index) {
    this.emit(0x21, ...unsigned(BigInt(index)));
  }

  load(address) {
    this.i32(address);
    this.emit(0x29, 3, 0);
  }

  store(address, value) {
    this.i32(address);
    value();
    this.emit(0x37, 3, 0);
  }
}

const operand = (code, value) => {
  if (value.reg === 31) code.i64(0n);
  else if (value.reg !== undefined) code.load(value.reg * 8);
  else code.i64(value.value);
};

const resultOperator = Object.freeze({ add: 0x7c, sub: 0x7d, and: 0x83, or: 0x84, xor: 0x85 });

const emitOverflow = (code, kind, local) => {
  code.localGet(local);
  code.localGet(local + 1);
  code.emit(0x85); // left ^ right
  if (kind === "add") {
    code.i64(-1n);
    code.emit(0x85); // ~(left ^ right)
  }
  code.localGet(local);
  code.localGet(local + 2);
  code.emit(0x85, 0x83); // & (left ^ result)
  code.i64(63n);
  code.emit(0x88); // >> 63
};

const emitFlags = (code, kind, arm, local) => {
  const flagsAddress = arm ? 32 * 8 : 17 * 8;
  code.i32(flagsAddress);
  code.load(flagsAddress);
  code.i64(~FLAG_MASK);
  code.emit(0x83);
  if (kind === "add" || kind === "sub") {
    code.localGet(local + (kind === "add" ? 2 : 0));
    code.localGet(local + 1);
    code.emit(kind === "add" ? 0x54 : arm ? 0x5a : 0x54); // carry, or AArch64 NOT-borrow
    code.emit(0xad, 0x84);
  }
  code.localGet(local + 2);
  code.i64(0xffn);
  code.emit(0x83, 0x7b);
  code.i64(1n);
  code.emit(0x83, 0x50, 0xad);
  code.i64(2n);
  code.emit(0x86, 0x84);
  code.localGet(local + 2);
  code.emit(0x50, 0xad);
  code.i64(6n);
  code.emit(0x86, 0x84);
  code.localGet(local + 2);
  code.i64(63n);
  code.emit(0x88);
  code.i64(7n);
  code.emit(0x86, 0x84);
  if (kind === "add" || kind === "sub") {
    emitOverflow(code, kind, local);
    code.i64(11n);
    code.emit(0x86, 0x84);
  }
  code.emit(0x37, 3, 0);
};

const emitOperation = (code, operation, arm, local) => {
  if (operation.kind === "set") {
    code.store(operation.dst * 8, () => code.i64(operation.value));
    return;
  }
  if (operation.kind === "insert") {
    code.store(operation.dst * 8, () => {
      code.load(operation.dst * 8);
      code.i64(~operation.mask);
      code.emit(0x83);
      code.i64(operation.value);
      code.emit(0x84);
    });
    return;
  }
  operand(code, operation.left);
  code.localSet(local);
  operand(code, operation.right);
  code.localSet(local + 1);
  code.localGet(local);
  code.localGet(local + 1);
  code.emit(resultOperator[operation.kind]);
  code.localSet(local + 2);
  if (operation.dst !== null) code.store(operation.dst * 8, () => code.localGet(local + 2));
  if (operation.flags) emitFlags(code, operation.kind, arm, local);
};

const emitFlag = (code, address, mask, set = true) => {
  code.load(address);
  code.i64(mask);
  code.emit(0x83, 0x50);
  if (set) code.emit(0x45);
};

const emitX86Condition = (code, condition, address) => {
  const flag = (mask, set = true) => emitFlag(code, address, mask, set);
  switch (condition) {
    case 0x0:
      flag(OF);
      break;
    case 0x1:
      flag(OF, false);
      break;
    case 0x2:
      flag(CF);
      break;
    case 0x3:
      flag(CF, false);
      break;
    case 0x4:
      flag(ZF);
      break;
    case 0x5:
      flag(ZF, false);
      break;
    case 0x6:
      flag(CF);
      flag(ZF);
      code.emit(0x72);
      break;
    case 0x7:
      flag(CF, false);
      flag(ZF, false);
      code.emit(0x71);
      break;
    case 0x8:
      flag(SF);
      break;
    case 0x9:
      flag(SF, false);
      break;
    case 0xa:
      flag(PF);
      break;
    case 0xb:
      flag(PF, false);
      break;
    case 0xc:
      flag(SF);
      flag(OF);
      code.emit(0x47);
      break;
    case 0xd:
      flag(SF);
      flag(OF);
      code.emit(0x46);
      break;
    case 0xe:
      flag(ZF);
      flag(SF);
      flag(OF);
      code.emit(0x47, 0x72);
      break;
    case 0xf:
      flag(ZF, false);
      flag(SF);
      flag(OF);
      code.emit(0x46, 0x71);
      break;
    default:
      code.i32(0);
  }
};

const emitArmCondition = (code, condition, address) => {
  const flag = (mask, set = true) => emitFlag(code, address, mask, set);
  switch (condition) {
    case 0x0:
      flag(ZF);
      break;
    case 0x1:
      flag(ZF, false);
      break;
    case 0x2:
      flag(CF);
      break;
    case 0x3:
      flag(CF, false);
      break;
    case 0x4:
      flag(SF);
      break;
    case 0x5:
      flag(SF, false);
      break;
    case 0x6:
      flag(OF);
      break;
    case 0x7:
      flag(OF, false);
      break;
    case 0x8:
      flag(CF);
      flag(ZF, false);
      code.emit(0x71);
      break;
    case 0x9:
      flag(CF, false);
      flag(ZF);
      code.emit(0x72);
      break;
    case 0xa:
      flag(SF);
      flag(OF);
      code.emit(0x46);
      break;
    case 0xb:
      flag(SF);
      flag(OF);
      code.emit(0x47);
      break;
    case 0xc:
      flag(ZF, false);
      flag(SF);
      flag(OF);
      code.emit(0x46, 0x71);
      break;
    case 0xd:
      flag(ZF);
      flag(SF);
      flag(OF);
      code.emit(0x47, 0x72);
      break;
    case 0xe:
      code.i32(1);
      break;
    default:
      code.i32(0);
  }
};

const moduleFor = (program, state) => {
  const code = new Code();
  const loop = program.condition !== undefined && program.taken === program.start;
  const local = loop ? 1 : 0;
  const ripAddress = (program.arm ? 31 : 16) * 8;
  const condition = () => {
    const flagsAddress = (program.arm ? 32 : 17) * 8;
    if (program.arm) emitArmCondition(code, program.condition, flagsAddress);
    else emitX86Condition(code, program.condition, flagsAddress);
  };
  const setRip = (conditionLocal) => {
    code.i32(ripAddress);
    if (program.condition === undefined) code.i64(program.taken ?? program.fallthrough);
    else {
      code.i64(program.taken);
      code.i64(program.fallthrough);
      if (conditionLocal === undefined) condition();
      else code.localGet(conditionLocal);
      code.emit(0x1b);
    }
    code.emit(0x37, 3, 0);
  };
  if (loop) {
    code.emit(0x03, 0x40); // loop
    for (const operation of program.operations) emitOperation(code, operation, program.arm, local);
    condition();
    code.localSet(5);
    setRip(5);
    code.localGet(4);
    code.i32(program.count);
    code.emit(0x6a);
    code.localSet(4);
    code.localGet(5);
    code.localGet(4);
    code.i32(program.count);
    code.emit(0x6a);
    code.localGet(0);
    code.emit(0x4d, 0x71, 0x0d, 0);
    code.emit(0x0b);
    code.localGet(4);
  } else {
    for (const operation of program.operations) emitOperation(code, operation, program.arm, local);
    setRip();
    code.i32(program.count);
  }
  code.emit(0x0b);

  const type = section(1, [1, 0x60, ...(loop ? [1, 0x7f] : [0]), 1, 0x7f]);
  const imported = section(2, [1, ...text("env"), ...text("memory"), 2, 0, 1]);
  const functions = section(3, [1, 0]);
  const exported = section(7, [1, ...text("run"), 0, 0]);
  const body = loop ? [2, 3, 0x7e, 2, 0x7f, ...code.bytes] : [1, 3, 0x7e, ...code.bytes];
  const bodies = section(10, [1, ...unsigned(BigInt(body.length)), ...body]);
  const bytes = Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...type,
    ...imported,
    ...functions,
    ...exported,
    ...bodies,
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: state } }).exports.run;
};

const readX86 = (memory, start) => {
  let pc = Number(start);
  const operations = [];
  let count = 0;
  let condition;
  let taken;
  const byte = () => memory.u8(BigInt(pc++));
  const dword = () => {
    const value = memory.u32(BigInt(pc));
    pc += 4;
    return value;
  };
  const qword = () => {
    const value = memory.u64(BigInt(pc));
    pc += 8;
    return value;
  };

  while (count < 32) {
    const before = pc;
    let rex = 0;
    let opcode = byte();
    if ((opcode & 0xf0) === 0x40) {
      rex = opcode;
      opcode = byte();
    }
    if (opcode === 0x90) {
      count++;
      continue;
    }
    if (rex & 8 && opcode >= 0xb8 && opcode <= 0xbf) {
      operations.push({ kind: "set", dst: (rex & 1 ? 8 : 0) | (opcode & 7), value: qword() });
      count++;
      continue;
    }
    if (rex & 8 && opcode === 0x83) {
      const modrm = byte();
      if (modrm >> 6 !== 3) {
        pc = before;
        break;
      }
      const group = (modrm >> 3) & 7;
      const kinds = { 0: "add", 1: "or", 4: "and", 5: "sub", 6: "xor", 7: "sub" };
      const kind = kinds[group];
      if (!kind) {
        pc = before;
        break;
      }
      const register = (rex & 1 ? 8 : 0) | (modrm & 7);
      operations.push({
        kind,
        dst: group === 7 ? null : register,
        left: { reg: register },
        right: { value: u64(sign8(byte())) },
        flags: true,
      });
      count++;
      continue;
    }
    const alu = X86_ALU.get(opcode);
    if (rex & 8 && alu) {
      const modrm = byte();
      if (modrm >> 6 !== 3) {
        pc = before;
        break;
      }
      const reg = (rex & 4 ? 8 : 0) | ((modrm >> 3) & 7);
      const rm = (rex & 1 ? 8 : 0) | (modrm & 7);
      const destinationIsReg = Boolean(opcode & 2);
      const compare = (opcode & 0xfd) === 0x39;
      operations.push({
        kind: alu,
        dst: compare ? null : destinationIsReg ? reg : rm,
        left: { reg: destinationIsReg ? reg : rm },
        right: { reg: destinationIsReg ? rm : reg },
        flags: true,
      });
      count++;
      continue;
    }
    if (opcode >= 0x70 && opcode <= 0x7f) {
      const relative = sign8(byte());
      condition = opcode & 15;
      taken = u64(BigInt(pc) + relative);
      count++;
      break;
    }
    if (opcode === 0x0f) {
      const second = byte();
      if (second >= 0x80 && second <= 0x8f) {
        const relative = sign32(dword());
        condition = second & 15;
        taken = u64(BigInt(pc) + relative);
        count++;
      } else pc = before;
      break;
    }
    if (opcode === 0xeb || opcode === 0xe9) {
      const relative = opcode === 0xeb ? sign8(byte()) : sign32(dword());
      taken = u64(BigInt(pc) + relative);
      count++;
      break;
    }
    pc = before;
    break;
  }
  if (count < 2) return null;
  return { operations, count, condition, taken, fallthrough: BigInt(pc), start, arm: false };
};

const readArm = (memory, start) => {
  let pc = Number(start);
  const operations = [];
  let count = 0;
  let condition;
  let taken;

  while (count < 32) {
    const before = pc;
    const word = memory.u32(BigInt(pc)) >>> 0;
    pc += 4;
    if (word === 0xd503201f) {
      count++;
      continue;
    }
    if ((word & 0xff800000) >>> 0 === 0xd2800000) {
      const dst = word & 31;
      if (dst !== 31)
        operations.push({
          kind: "set",
          dst,
          value: BigInt((word >> 5) & 0xffff) << BigInt(((word >> 21) & 3) * 16),
        });
      count++;
      continue;
    }
    if ((word & 0xff800000) >>> 0 === 0xf2800000) {
      const shift = BigInt(((word >> 21) & 3) * 16);
      const mask = 0xffffn << shift;
      const dst = word & 31;
      if (dst !== 31) operations.push({ kind: "insert", dst, mask, value: BigInt((word >> 5) & 0xffff) << shift });
      count++;
      continue;
    }
    if ((word & 0x1f000000) === 0x11000000 && !(word & 0x00800000)) {
      if (!(word & 0x80000000)) {
        pc = before;
        break;
      }
      const dst = word & 31;
      const source = (word >> 5) & 31;
      const flags = Boolean(word & 0x20000000);
      if (source === 31 || (dst === 31 && !flags)) {
        pc = before;
        break;
      }
      const value = BigInt((word >> 10) & 0xfff) << BigInt(word & 0x00400000 ? 12 : 0);
      operations.push({
        kind: word & 0x40000000 ? "sub" : "add",
        dst: dst === 31 ? null : dst,
        left: { reg: source },
        right: { value },
        flags,
      });
      count++;
      continue;
    }
    if ((word & 0x1fe0fc00) === 0x0b000000) {
      if (!(word & 0x80000000)) {
        pc = before;
        break;
      }
      const dst = word & 31;
      const flags = Boolean(word & 0x20000000);
      operations.push({
        kind: word & 0x40000000 ? "sub" : "add",
        dst: dst === 31 ? null : dst,
        left: { reg: (word >> 5) & 31 },
        right: { reg: (word >> 16) & 31 },
        flags,
      });
      count++;
      continue;
    }
    if ((word & 0x1fe0fc00) === 0x0a000000) {
      if (!(word & 0x80000000)) {
        pc = before;
        break;
      }
      const operation = (word >> 29) & 3;
      operations.push({
        kind: operation === 0 || operation === 3 ? "and" : operation === 1 ? "or" : "xor",
        dst: (word & 31) === 31 ? null : word & 31,
        left: { reg: (word >> 5) & 31 },
        right: { reg: (word >> 16) & 31 },
        flags: operation === 3,
      });
      count++;
      continue;
    }
    if ((word & 0xff000010) >>> 0 === 0x54000000) {
      let immediate = (word >> 5) & 0x7ffff;
      if (immediate & 0x40000) immediate |= ~0x7ffff;
      condition = word & 15;
      taken = u64(BigInt(before) + BigInt(immediate) * 4n);
      count++;
      break;
    }
    if ((word & 0x7c000000) >>> 0 === 0x14000000) {
      let immediate = word & 0x03ffffff;
      if (immediate & 0x02000000) immediate |= ~0x03ffffff;
      if (word & 0x80000000) operations.push({ kind: "set", dst: 30, value: BigInt(pc) });
      taken = u64(BigInt(before) + BigInt(immediate) * 4n);
      count++;
      break;
    }
    pc = before;
    break;
  }
  if (count < 2) return null;
  return { operations, count, condition, taken, fallthrough: BigInt(pc), start, arm: true };
};

export const createHotJit = ({ memory, registers, architecture, enabled = true, threshold = 64 }) => {
  if (!enabled || !registers.memory || typeof WebAssembly !== "object") {
    return Object.freeze({ execute: () => 0, stats: () => ({ compiled: 0, executions: 0, instructions: 0 }) });
  }
  const compile = architecture === "arm" ? readArm : readX86;
  const counts = new Map();
  const cache = new Map();
  let compiled = 0;
  let executions = 0;
  let instructions = 0;
  // ponytail: 4 KiB generations invalidate a whole code page; use sub-page generations only if cache churn is measured.
  const pagesFor = (start, end) => {
    const pages = [];
    for (let address = Number(start) & ~4095; address < Number(end); address += 4096) {
      pages.push([address, memory.generation(BigInt(address))]);
    }
    return pages;
  };
  const current = (pages) => pages.every(([address, generation]) => memory.generation(BigInt(address)) === generation);

  return Object.freeze({
    execute(remaining) {
      const pc = registers.rip;
      const version = memory.generation(pc);
      let entry = cache.get(pc);
      if (entry && current(entry.pages) && entry.count <= remaining) {
        const executed = entry.run(Math.min(remaining, 0x7fffffff));
        executions++;
        instructions += executed;
        return executed;
      }
      const profile = counts.get(pc);
      const hits = profile?.version === version ? profile.hits + 1 : 1;
      counts.set(pc, { version, hits });
      if (hits < threshold) return 0;
      try {
        const program = compile(memory, pc);
        if (!program) {
          counts.set(pc, { version, hits: Number.NEGATIVE_INFINITY });
          return 0;
        }
        if (program.count > remaining) return 0;
        entry = {
          count: program.count,
          pages: pagesFor(pc, program.fallthrough),
          run: moduleFor(program, registers.memory),
        };
        cache.set(pc, entry);
        compiled++;
        const executed = entry.run(Math.min(remaining, 0x7fffffff));
        executions++;
        instructions += executed;
        return executed;
      } catch {
        counts.set(pc, { version, hits: Number.NEGATIVE_INFINITY });
        return 0;
      }
    },
    stats: () => ({ compiled, executions, instructions }),
  });
};
