const page = /^[a-z0-9_][a-z0-9_.+-]*$/;
const section = /^[1-9][A-Za-z0-9]*$/;
const digest = /^[a-f0-9]{64}$/;
const entries = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const safePath = (value) => {
  if (
    typeof value !== "string" ||
    value.startsWith("/") ||
    value.split("/").some((part) => !/^[A-Za-z0-9._+-]+$/.test(part) || part === "." || part === "..")
  ) {
    throw new TypeError("invalid manual path");
  }
  return value;
};

export const readLimited = async (response, limit) => {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) throw new RangeError("manual response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new RangeError("manual response is too large");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
};

const request = async (fetcher, url, limit, json = false, signal) => {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`manual request failed: ${response.status}`);
  const text = await readLimited(response, limit);
  return json ? JSON.parse(text) : text;
};

const validateIndex = (data) => {
  if (!data || typeof data !== "object" || !data.pages || typeof data.pages !== "object") {
    throw new TypeError("invalid manual index");
  }
  const pages = Object.create(null);
  for (const [name, value] of Object.entries(data.pages)) {
    if (!page.test(name)) throw new TypeError("invalid manual index");
    const entries = Array.isArray(value) ? value : [value];
    if (
      !entries.length ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          !section.test(entry.section) ||
          typeof entry.path !== "string" ||
          !digest.test(entry.sha256) ||
          (entry.description != null && typeof entry.description !== "string"),
      )
    ) {
      throw new TypeError("invalid manual index");
    }
    if (new Set(entries.map((entry) => entry.section)).size !== entries.length) {
      throw new TypeError("invalid manual index");
    }
    const valid = Object.freeze(entries.map((entry) => Object.freeze({ ...entry, path: safePath(entry.path) })));
    pages[name] = Array.isArray(value) ? valid : valid[0];
  }
  const aliases = Object.create(null);
  for (const [alias, target] of Object.entries(data.aliases ?? {})) {
    const value = target && Object.hasOwn(pages, target.name) ? pages[target.name] : null;
    if (
      !page.test(alias) ||
      Object.hasOwn(pages, alias) ||
      !page.test(target?.name ?? "") ||
      !section.test(target?.section ?? "") ||
      !entries(value).some((entry) => entry.section === target.section)
    ) {
      throw new TypeError("invalid manual index");
    }
    aliases[alias] = Object.freeze({ name: target.name, section: target.section });
  }
  return Object.freeze({ ...data, aliases: Object.freeze(aliases), pages: Object.freeze(pages) });
};

export const createManuals = ({
  base = "./manuals/",
  profile = "freebsd",
  fetch: fetcher = globalThis.fetch,
  crypto = globalThis.crypto,
  maxPage = 1_048_576,
} = {}) => {
  if (typeof fetcher !== "function") throw new TypeError("manuals require fetch");
  if (!crypto?.subtle) throw new TypeError("manuals require Web Crypto");
  if (!Number.isSafeInteger(maxPage) || maxPage < 1) throw new TypeError("maxPage must be a positive integer");
  const root = new URL(`${safePath(profile)}/`, new URL(base, globalThis.location?.href ?? "http://localhost/"));
  let loading;
  const index = async (signal) => {
    if (!loading) {
      loading = request(fetcher, new URL("index.json", root), maxPage, true, signal)
        .then(validateIndex)
        .catch((error) => {
          loading = null;
          throw error;
        });
    }
    return loading;
  };
  const find = async (name, wanted, signal) => {
    name = name.toLowerCase();
    if (!page.test(name) || (wanted && !section.test(wanted))) return null;
    const data = await index(signal);
    if (Object.hasOwn(data.aliases, name)) {
      const target = data.aliases[name];
      if (wanted && wanted !== target.section) return null;
      name = target.name;
      wanted = target.section;
    }
    const value = Object.hasOwn(data.pages, name) ? data.pages[name] : null;
    return entries(value).find((entry) => !wanted || entry.section === wanted) ?? null;
  };
  const read = async (name, wanted, signal) => {
    const entry = await find(name, wanted, signal);
    if (!entry) return null;
    const text = await request(fetcher, new URL(safePath(entry.path), root), maxPage, false, signal);
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    let hash = "";
    for (const byte of bytes) hash += byte.toString(16).padStart(2, "0");
    if (hash !== entry.sha256) throw new Error("manual integrity check failed");
    return text;
  };
  const search = async (query, signal) => {
    query = query.trim().toLowerCase();
    if (!query) return [];
    const data = await index(signal);
    const aliases = Object.entries(data.aliases).map(([name, target]) => [
      name,
      entries(data.pages[target.name]).find((entry) => entry.section === target.section),
    ]);
    return [...Object.entries(data.pages), ...aliases].flatMap(([name, value]) =>
      entries(value)
        .filter((entry) => `${name} ${entry.description ?? ""}`.toLowerCase().includes(query))
        .map((entry) => ({ name, ...entry })),
    );
  };
  return Object.freeze({ index, find, read, search });
};
