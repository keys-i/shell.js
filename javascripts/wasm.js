const encoder = new TextEncoder();
const decoder = new TextDecoder();
const script =
  typeof document === "undefined" ? globalThis.location?.href : (document.currentScript?.src ?? import.meta.url);
const defaultURL = () => {
  const base = script || globalThis.location?.href;
  if (!base) throw new TypeError("WebAssembly URL is required outside a browser");
  return new URL("../wasm/shell.wasm", base);
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
