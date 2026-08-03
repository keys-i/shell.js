import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readLimited } from "../../javascripts/man.js";

const names = /^[a-z0-9_][a-z0-9_.+-]*$/;
const files = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
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
    !files.test(entry?.name) ||
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

const render = (source, entry, profile, config) => {
  if (/^\.so\s+/m.test(source)) throw new Error(`${entry.path}: unresolved .so alias; pin its target explicitly`);
  const args = ["-T", "utf8"];
  if (profile === "freebsd") args.push("-I", `os=FreeBSD ${config.release}`);
  if (profile === "linux") {
    const version = config.release.match(/^man-pages-(\d+\.\d+)$/)?.[1];
    if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(config.date)) throw new TypeError("invalid Linux release metadata");
    const built = source.replace(
      /^(\.TH\s+\S+\s+\S+\s+)\(date\)\s+"Linux man-pages \(unreleased\)"$/m,
      `$1${config.date} "Linux man-pages ${version}"`,
    );
    if (built === source) throw new Error(`${entry.path}: missing Linux release placeholders`);
    source = built;
  }
  const process = spawnSync("mandoc", args, { encoding: "utf8", input: source, maxBuffer: 4_194_304 });
  if (process.error) throw process.error;
  if (process.status) throw new Error(`${entry.path}: mandoc failed\n${process.stderr}`);
  return `${process.stdout.replace(backspace, "").replace(ansi, "").trimEnd()}\n`;
};

const backup = (target) => target.replace(/\/([^/]+)$/, "/.$1.previous");
const recover = async (target) => {
  try {
    await rename(backup(target), target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    await rm(backup(target), { force: true, recursive: true });
  }
};
const replace = async (source, target) => {
  const previous = backup(target);
  let moved = false;
  await recover(target);
  try {
    await rename(target, previous);
    moved = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(source, target);
  } catch (error) {
    if (moved) await rename(previous, target);
    throw error;
  }
  if (moved) await rm(previous, { force: true, recursive: true });
};

export const buildManuals = async (manifestPath = "manuals/manifest.json") => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [profile, config] of Object.entries(manifest.profiles ?? {})) {
    if (!Object.hasOwn(roots, profile)) throw new TypeError(`invalid manual profile: ${profile}`);
    await recover(`manuals/${profile}`);
    const output = await mkdtemp(`manuals/.${profile}-`);
    const pages = Object.create(null);
    const provenance = Object.create(null);
    const licenses = Object.create(null);
    try {
      for (const value of config.licenses ?? []) {
        const entry = validateLicense(profile, config.revision, value);
        const { source, url } = await fetchSource(profile, config.revision, entry);
        await mkdir(`${output}/LICENSES`, { recursive: true });
        await writeFile(`${output}/LICENSES/${entry.name}`, source);
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
        const text = render(source, entry, profile, config);
        const license = licenseHeader(source);
        const identifier = license.match(/^\.\\?" SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)\s*$/m)?.[1];
        if (profile === "linux" && (!identifier || !Object.hasOwn(licenses, `${identifier}.txt`))) {
          throw new Error(`${entry.path}: missing pinned license text for ${identifier ?? "unknown SPDX license"}`);
        }
        const relative = `${entry.section}/${entry.name}.txt`;
        await mkdir(`${output}/${entry.section}`, { recursive: true });
        await writeFile(`${output}/${relative}`, text);
        const current = Object.hasOwn(pages, entry.name)
          ? Array.isArray(pages[entry.name])
            ? pages[entry.name]
            : [pages[entry.name]]
          : [];
        if (current.some(({ section }) => section === entry.section)) {
          throw new TypeError(`duplicate manual manifest entry: ${profile}/${entry.name}(${entry.section})`);
        }
        const runtime = {
          section: entry.section,
          description: description(text, entry.name),
          path: relative,
          sha256: createHash("sha256").update(text).digest("hex"),
        };
        const audit = {
          section: entry.section,
          path: relative,
          source: url,
          sourcePath: entry.path,
          revision: config.revision,
          sha256: entry.sha256,
          license,
        };
        pages[entry.name] = current.length ? [...current, runtime] : runtime;
        provenance[entry.name] = current.length
          ? [...(Array.isArray(provenance[entry.name]) ? provenance[entry.name] : [provenance[entry.name]]), audit]
          : audit;
      }
      const aliases = Object.create(null);
      for (const [alias, target] of Object.entries(config.aliases ?? {})) {
        const value = target && Object.hasOwn(pages, target.name) ? pages[target.name] : null;
        const entries = Array.isArray(value) ? value : value ? [value] : [];
        if (
          !names.test(alias) ||
          Object.hasOwn(pages, alias) ||
          !names.test(target?.name ?? "") ||
          !sections.test(target?.section ?? "") ||
          !entries.some(({ section }) => section === target.section)
        ) {
          throw new TypeError(`invalid manual alias: ${profile}/${alias}`);
        }
        aliases[alias] = { name: target.name, section: target.section };
      }
      await writeFile(
        `${output}/index.json`,
        `${JSON.stringify({ profile, release: config.release, aliases, pages })}\n`,
      );
      await writeFile(
        `${output}/provenance.json`,
        `${JSON.stringify({
          profile,
          release: config.release,
          origin: config.origin,
          revision: config.revision,
          licenses,
          pages: provenance,
        })}\n`,
      );
      await replace(output, `manuals/${profile}`);
    } finally {
      await rm(output, { force: true, recursive: true });
    }
    console.log(`${profile}: ${(config.pages ?? []).length} pages`);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildManuals();
