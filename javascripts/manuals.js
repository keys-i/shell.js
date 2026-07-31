import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readLimited } from "./man.js";

const names = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;
const sections = /^[1-9][A-Za-z0-9]*$/;
const revisions = /^[a-f0-9]{40}$/;
const digests = /^[a-f0-9]{64}$/;
// biome-ignore lint/complexity/useRegexLiterals: avoids literal control characters.
const backspace = new RegExp("[^\\n]\\u0008", "g");
// biome-ignore lint/complexity/useRegexLiterals: avoids literal control characters.
const ansi = new RegExp("\\u001b\\[[0-9;]*m", "g");
const roots = {
  freebsd: "https://cgit.freebsd.org/src/plain/",
  linux: "https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/",
};

const safePath = (value) =>
  typeof value === "string" &&
  !value.startsWith("/") &&
  value.split("/").every((part) => /^[A-Za-z0-9._+-]+$/.test(part) && part !== "." && part !== "..");

export const validateManual = (profile, revision, entry) => {
  if (
    !Object.hasOwn(roots, profile) ||
    !revisions.test(revision) ||
    !names.test(entry?.name) ||
    !sections.test(entry?.section) ||
    !safePath(entry?.path) ||
    !digests.test(entry?.sha256)
  ) {
    throw new TypeError(`invalid manual manifest entry: ${profile}/${entry?.name ?? "unknown"}`);
  }
  return entry;
};

const validateLicense = (profile, revision, entry) => {
  if (
    !Object.hasOwn(roots, profile) ||
    !revisions.test(revision) ||
    !names.test(entry?.name) ||
    !safePath(entry?.path) ||
    !digests.test(entry?.sha256)
  ) {
    throw new TypeError(`invalid license manifest entry: ${profile}/${entry?.name ?? "unknown"}`);
  }
  return entry;
};

export const licenseHeader = (source) => {
  const comments = [];
  for (const line of source.split("\n").slice(0, 120)) {
    if (/^\.\\?"/.test(line)) comments.push(line);
    else if (comments.length) break;
  }
  return comments.join("\n").slice(0, 8192);
};

const description = (text, fallback) => {
  const match = text.match(/\nNAME\n([\s\S]*?)(?:\n\n[A-Z][A-Z ]+\n|$)/);
  return (
    match?.[1]
      .replace(/\s+/g, " ")
      .match(/\s[-–—]\s(.+)$/)?.[1]
      ?.trim() ?? fallback
  );
};

const fetchSource = async (profile, revision, entry) => {
  const url = new URL(entry.path, roots[profile]);
  url.searchParams.set("id", revision);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("text/plain")) {
    throw new Error(`${entry.path}: upstream returned ${response.status} ${response.headers.get("content-type")}`);
  }
  let source;
  try {
    source = await readLimited(response, 1_048_576);
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError(`${entry.path}: source is too large`);
    throw error;
  }
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== entry.sha256) throw new Error(`${entry.path}: expected ${entry.sha256}, received ${digest}`);
  return { source, url: url.href };
};

const render = (source, entry) => {
  if (/^\.so\s+/m.test(source)) throw new Error(`${entry.path}: unresolved .so alias; pin its target explicitly`);
  const process = spawnSync("mandoc", ["-T", "utf8"], { encoding: "utf8", input: source, maxBuffer: 4_194_304 });
  if (process.error) throw process.error;
  if (process.status) throw new Error(`${entry.path}: mandoc failed\n${process.stderr}`);
  return `${process.stdout.replace(backspace, "").replace(ansi, "").trimEnd()}\n`;
};

export const buildManuals = async (manifestPath = "manuals/manifest.json") => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [profile, config] of Object.entries(manifest.profiles ?? {})) {
    const pages = {};
    const licenses = {};
    for (const value of config.licenses ?? []) {
      const entry = validateLicense(profile, config.revision, value);
      const { source, url } = await fetchSource(profile, config.revision, entry);
      await mkdir(`manuals/${profile}/LICENSES`, { recursive: true });
      await writeFile(`manuals/${profile}/LICENSES/${entry.name}`, source);
      licenses[entry.name] = {
        path: `LICENSES/${entry.name}`,
        source: url,
        sourcePath: entry.path,
        revision: config.revision,
        sha256: entry.sha256,
      };
    }
    for (const value of config.pages ?? []) {
      const entry = validateManual(profile, config.revision, value);
      const { source, url } = await fetchSource(profile, config.revision, entry);
      const text = render(source, entry);
      const relative = `${entry.section}/${entry.name}.txt`;
      await mkdir(`manuals/${profile}/${entry.section}`, { recursive: true });
      await writeFile(`manuals/${profile}/${relative}`, text);
      const record = {
        section: entry.section,
        description: description(text, entry.name),
        path: relative,
        source: url,
        sourcePath: entry.path,
        revision: config.revision,
        sha256: entry.sha256,
        license: licenseHeader(source),
      };
      pages[entry.name] = pages[entry.name] ? [pages[entry.name], record].flat() : record;
    }
    const index = {
      profile,
      release: config.release,
      origin: config.origin,
      revision: config.revision,
      licenses,
      pages,
    };
    await writeFile(`manuals/${profile}/index.json`, `${JSON.stringify(index)}\n`);
    console.log(`${profile}: ${Object.keys(pages).length} pages`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildManuals();
