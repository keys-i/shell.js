const page = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const section = /^[1-9][A-Za-z0-9]*$/;
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
          (entry.description != null && typeof entry.description !== "string"),
      )
    ) {
      throw new TypeError("invalid manual index");
    }
    const valid = Object.freeze(entries.map((entry) => Object.freeze({ ...entry, path: safePath(entry.path) })));
    pages[name] = Array.isArray(value) ? valid : valid[0];
  }
  return Object.freeze({ ...data, pages: Object.freeze(pages) });
};

export const createManuals = ({
  base = "./manuals/",
  profile = "freebsd",
  fetch: fetcher = globalThis.fetch,
  maxPage = 1_048_576,
} = {}) => {
  if (typeof fetcher !== "function") throw new TypeError("manuals require fetch");
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
    const value = Object.hasOwn(data.pages, name) ? data.pages[name] : null;
    const entries = Array.isArray(value) ? value : value ? [value] : [];
    return entries.find((entry) => !wanted || entry.section === wanted) ?? null;
  };
  const read = async (name, wanted, signal) => {
    const entry = await find(name, wanted, signal);
    return entry ? request(fetcher, new URL(safePath(entry.path), root), maxPage, false, signal) : null;
  };
  const search = async (query, signal) => {
    query = query.trim().toLowerCase();
    if (!query) return [];
    const data = await index(signal);
    return Object.entries(data.pages).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value])
        .filter((entry) => `${name} ${entry.description ?? ""}`.toLowerCase().includes(query))
        .map((entry) => ({ name, ...entry })),
    );
  };
  return Object.freeze({ index, find, read, search });
};
