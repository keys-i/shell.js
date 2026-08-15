import { createArm } from "./cpu/arm.js";
import { LinearMemory } from "./cpu/memory.js";
import { createX86 } from "./cpu/x86.js";
import { loadElf } from "./elf.js";
import { createSyscalls } from "./syscall.js";

const join = (chunks) => {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

const prepare = (
  image,
  {
    argv = [],
    env = {},
    executableBase,
    execfn,
    fs,
    gid = 1000,
    interpreterBase,
    jit = true,
    maxOutputBytes = 1_048_576,
    memorySize = 64 * 1024 * 1024,
    random,
    resolveInterpreter,
    stdin,
    uid = 1000,
    write,
  } = {},
) => {
  if (resolveInterpreter !== undefined && typeof resolveInterpreter !== "function") {
    throw new TypeError("resolveInterpreter must be a function");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError("maxOutputBytes must be a positive integer");
  }
  const memory = new LinearMemory(memorySize);
  let executable = loadElf(image, memory, { base: executableBase, stack: false });
  let interpreter = null;
  if (executable.interpreter) {
    const interpreterImage = resolveInterpreter?.(executable.interpreter) ?? fs?.readBytes?.(executable.interpreter);
    if (interpreterImage?.then) throw new TypeError("resolveInterpreter must be synchronous");
    if (!(interpreterImage instanceof Uint8Array)) {
      throw new Error(`ELF interpreter not found: ${executable.interpreter}`);
    }
    const base = BigInt(interpreterBase ?? ((BigInt(memorySize) * 3n) / 4n) & ~4095n);
    interpreter = loadElf(interpreterImage, memory, { base, stack: false });
    if (interpreter.architecture !== executable.architecture) throw new Error("ELF interpreter architecture mismatch");
    if (interpreter.interpreter) throw new Error("nested ELF interpreter is not supported");
    if (
      interpreter.segments.some((loader) =>
        executable.segments.some(
          (main) =>
            loader.address < main.address + BigInt(main.memorySize) &&
            main.address < loader.address + BigInt(loader.memorySize),
        ),
      )
    ) {
      throw new Error("ELF interpreter overlaps executable");
    }
  }
  executable = loadElf(image, memory, {
    argv,
    base: executable.base,
    env,
    execfn,
    gid,
    interpreterBase: interpreter?.base,
    random,
    stackFloor: interpreter && interpreter.brk > executable.brk ? interpreter.brk : executable.brk,
    uid,
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  const emit = (fd, bytes) => {
    if (bytes.length > maxOutputBytes - outputBytes) throw new RangeError("guest output limit exceeded");
    outputBytes += bytes.length;
    (fd === 2 ? stderr : stdout).push(bytes.slice());
    return write?.(fd, bytes);
  };
  let syscalls;
  const cpuOptions = { jit, memory, onSyscall: (call) => syscalls.handle(call) };
  const cpu = executable.architecture === "x86_64" ? createX86(cpuOptions) : createArm(cpuOptions);
  syscalls = createSyscalls({
    addressLimit:
      interpreter?.segments.reduce(
        (lowest, segment) => (segment.address < lowest ? segment.address : lowest),
        executable.stackPointer,
      ) ?? executable.stackPointer,
    abi: `linux-${executable.architecture}`,
    fs,
    gid,
    heapBase: executable.brk,
    stdin,
    uid,
    write: emit,
  });
  if (executable.architecture === "x86_64") {
    cpu.reset({ rip: interpreter?.entry ?? executable.entry, rsp: executable.stackPointer });
  } else {
    cpu.reset({ pc: interpreter?.entry ?? executable.entry, sp: executable.stackPointer });
  }
  return { cpu, executable, interpreter, memory, stderr, stdout, syscalls };
};

const resultOf = ({ cpu, executable, interpreter, memory, stderr, stdout, syscalls }, registers) =>
  Object.freeze({
    architecture: executable.architecture,
    executable,
    exitCode: syscalls.exitCode,
    jit: cpu.jit,
    interpreter,
    memory,
    registers,
    stderr: join(stderr),
    stdout: join(stdout),
    steps: cpu.steps,
  });

export const runElf = (image, options = {}) => {
  const state = prepare(image, options);
  return resultOf(state, state.cpu.run({ maxSteps: options.maxSteps ?? 100_000 }));
};

export const runElfAsync = async (image, options = {}) => {
  const state = prepare(image, options);
  const registers = await state.cpu.runAsync({
    maxSteps: options.maxSteps ?? 100_000,
    quantum: options.quantum ?? 10_000,
    signal: options.signal,
    yield: options.yield,
  });
  return resultOf(state, registers);
};
