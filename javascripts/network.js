const HTTP = new Set(["http:", "https:"]);
const SOCKET = new Set(["ws:", "wss:"]);

const byteLength = (value) => {
  if (value == null) return 0;
  if (typeof value === "string") return new TextEncoder().encode(value).length;
  if (value instanceof URLSearchParams) return new TextEncoder().encode(value.toString()).length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob === "function" && value instanceof Blob) return value.size;
  throw new TypeError("network body must have a bounded byte length");
};

const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
};

const readBody = async (response, limit) => {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    try {
      await response.body?.cancel?.();
    } catch {}
    throw new RangeError("network response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw new RangeError("network response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
};

export const createNetwork = ({
  origins = [],
  fetch: hostFetch = globalThis.fetch,
  WebSocket: HostWebSocket = globalThis.WebSocket,
  base = globalThis.location?.href,
  maxRequestBytes = 1_048_576,
  maxResponseBytes = 1_048_576,
  maxMessageBytes = 1_048_576,
} = {}) => {
  if (!Array.isArray(origins)) throw new TypeError("origins must be an array");
  maxRequestBytes = positive(maxRequestBytes, "maxRequestBytes");
  maxResponseBytes = positive(maxResponseBytes, "maxResponseBytes");
  maxMessageBytes = positive(maxMessageBytes, "maxMessageBytes");
  const allowed = new Set(
    origins.map((origin) => {
      const url = new URL(origin, base);
      if (!HTTP.has(url.protocol) && !SOCKET.has(url.protocol))
        throw new TypeError(`unsupported network origin: ${origin}`);
      if (url.username || url.password) throw new TypeError("network origins cannot contain credentials");
      return url.origin;
    }),
  );
  const address = (input, protocols) => {
    const url = new URL(input, base);
    if (!protocols.has(url.protocol) || !allowed.has(url.origin))
      throw new Error(`network origin denied: ${url.origin}`);
    if (url.username || url.password) throw new Error("network URL credentials are denied");
    return url;
  };

  return Object.freeze({
    async fetch(input, options = {}) {
      if (typeof hostFetch !== "function") throw new TypeError("Fetch is unavailable");
      const url = address(input, HTTP);
      const request = { ...options };
      if (byteLength(request.body) > maxRequestBytes) throw new RangeError("network request is too large");
      const response = await hostFetch(url, {
        ...request,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (response.url) address(response.url, HTTP);
      const body = await readBody(response, maxResponseBytes);
      return Object.freeze({
        body,
        headers: Object.freeze([...response.headers]),
        status: response.status,
        statusText: response.statusText,
        url: response.url || url.href,
      });
    },
    websocket(input, protocols) {
      if (typeof HostWebSocket !== "function") throw new TypeError("WebSocket is unavailable");
      const url = address(input, SOCKET);
      const socket = protocols === undefined ? new HostWebSocket(url) : new HostWebSocket(url, protocols);
      const listeners = new WeakMap();
      let api;
      const safeEvent = (type, event) =>
        Object.freeze({
          ...(type === "close" ? { code: event.code, reason: event.reason, wasClean: event.wasClean } : {}),
          ...(type === "message" ? { data: event.data, origin: event.origin } : {}),
          currentTarget: api,
          target: api,
          type,
        });
      api = Object.freeze({
        addEventListener(type, listener, options) {
          if (listener == null) {
            return;
          }
          type = String(type);
          let byType = listeners.get(listener);
          if (!byType) {
            byType = new Map();
            listeners.set(listener, byType);
          }
          const settings = options && typeof options === "object" ? options : null;
          const capture = typeof options === "boolean" ? options : Boolean(settings?.capture);
          const key = `${type}\0${capture}`;
          if (byType.has(key)) return;
          const once = Boolean(settings?.once);
          const signal = settings?.signal;
          if (signal?.aborted) return;
          const cleanup = () => {
            const record = byType.get(key);
            if (!record) return;
            socket.removeEventListener(type, record.wrapped, capture);
            record.signal?.removeEventListener("abort", cleanup);
            byType.delete(key);
            if (!byType.size) listeners.delete(listener);
          };
          const wrapped = (event) => {
            if (once) cleanup();
            if (type === "message" && byteLength(event.data) > maxMessageBytes) {
              socket.close(1009, "message too large");
              return;
            }
            const safe = safeEvent(type, event);
            if (typeof listener === "function") listener.call(api, safe);
            else listener.handleEvent(safe);
          };
          byType.set(key, { cleanup, signal, wrapped });
          try {
            socket.addEventListener(type, wrapped, capture);
            signal?.addEventListener("abort", cleanup, { once: true });
          } catch (error) {
            cleanup();
            throw error;
          }
        },
        close: (...args) => socket.close(...args),
        get protocol() {
          return socket.protocol;
        },
        get readyState() {
          return socket.readyState;
        },
        removeEventListener(type, listener, options) {
          type = String(type);
          const byType = listener == null ? null : listeners.get(listener);
          const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
          const key = `${type}\0${capture}`;
          const record = byType?.get(key);
          if (record) record.cleanup();
          else socket.removeEventListener(type, listener, capture);
        },
        send(value) {
          if (byteLength(value) > maxMessageBytes) throw new RangeError("WebSocket message is too large");
          socket.send(value);
        },
        get url() {
          return socket.url;
        },
      });
      return api;
    },
  });
};
