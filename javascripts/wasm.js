const encoder = new TextEncoder();
const decoder = new TextDecoder();
const kradAddDigest = "d6f47a8df8691ada08f49fac71b77f3b8dbb061c92041acf00988d34e25d8bcf";
const script =
  typeof document === "undefined" ? globalThis.location?.href : (document.currentScript?.src ?? import.meta.url);
const defaultURL = (name = "shell.wasm") => {
  const base = script || globalThis.location?.href;
  if (!base) throw new TypeError("WebAssembly URL is required outside a browser");
  return new URL(`../wasm/${name}`, base);
};

const instantiate = async (source, fetcher) => {
  const response = await fetcher(source);
  if (!response.ok) throw new Error(`WebAssembly request failed: ${response.status}`);
  const module = response.headers.get("content-type")?.includes("application/wasm")
    ? await WebAssembly.instantiateStreaming(response, {})
    : await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const exports = module.instance.exports;
  if (exports.abi?.() !== 1 || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("unsupported shell.js WebAssembly ABI");
  }
  return exports;
};

export const createWasm = (setting, options = {}) => {
  if (!setting) return null;
  if (typeof setting === "object" && !(setting instanceof URL)) options = setting;
  const { fetch: fetcher = globalThis.fetch, threshold = 262_144 } = options;
  const source = setting === true || setting === "auto" ? defaultURL() : (options.url ?? setting);
  if (typeof fetcher !== "function") throw new TypeError("WebAssembly requires fetch");
  let loading;
  let exports;
  let failed = false;
  const prepare = () => {
    if (exports) return Promise.resolve(true);
    if (failed) return Promise.resolve(false);
    if (!loading) {
      loading = instantiate(source, fetcher)
        .then((value) => {
          exports = value;
          return true;
        })
        .catch(() => {
          failed = true;
          return false;
        });
    }
    return loading;
  };
  const filter = (text, needle, invert = false) => {
    if (text.length < threshold) return null;
    if (!exports) {
      void prepare();
      return null;
    }
    const input = encoder.encode(text);
    const match = encoder.encode(needle);
    const pointer = exports.buffer_ptr();
    if (input.length + match.length > exports.capacity()) return null;
    const memory = new Uint8Array(exports.memory.buffer);
    memory.set(input, pointer);
    memory.set(match, pointer + input.length);
    const output = decoder.decode(
      memory.subarray(pointer, pointer + exports.filter_lines(input.length, input.length, match.length, invert)),
    );
    return output && !output.endsWith("\n") ? `${output}\n` : output;
  };
  return Object.freeze({
    filter,
    prepare,
    get ready() {
      return Boolean(exports);
    },
  });
};

export const createKradAdd = ({ url, fetch: fetcher = globalThis.fetch } = {}) => {
  if (typeof fetcher !== "function") throw new TypeError("Krad requires fetch");
  const source = url ?? defaultURL("krad-add.wasm");
  let loading;
  const load = (signal) => {
    if (!loading) {
      loading = (async () => {
        const response = await fetcher(source, {
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal,
        });
        if (!response.ok) throw new Error(`Krad request failed: ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Krad response has no body");
        const buffer = new Uint8Array(4096);
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (length + value.byteLength > buffer.byteLength) {
              await reader.cancel().catch(() => {});
              throw new RangeError("Krad module is too large");
            }
            buffer.set(value, length);
            length += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = buffer.subarray(0, length);
        const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== kradAddDigest) throw new Error("Krad module failed integrity verification");
        const module = await WebAssembly.compile(bytes);
        if (WebAssembly.Module.imports(module).length) throw new Error("Krad module imports are not allowed");
        const instance = await WebAssembly.instantiate(module);
        if (typeof instance.exports.krad_add !== "function") throw new Error("unsupported Krad ABI");
        return instance.exports.krad_add;
      })().catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  };
  return async (args, { signal } = {}) => {
    if (
      !Array.isArray(args) ||
      args.length !== 2 ||
      args.some((value) => !/^[+-]?\d+$/.test(value) || Number(value) < -2147483648 || Number(value) > 2147483647)
    ) {
      return { code: 2, stderr: "usage: krad-add INTEGER INTEGER\n" };
    }
    return `${(await load(signal))(Number(args[0]), Number(args[1]))}\n`;
  };
};
