const fail = (path, message, code = "EINVAL") => {
  const error = new Error(`${path}: ${message}`);
  error.code = code;
  throw error;
};

const SUPER = 0;
const MAGIC = 0x53484c42; // SHLB
const VERSION = 1;
const INODE_FREE = 0;
const INODE_FILE = 1;
const INODE_DIR = 2;
const ROOT_INODE = 1;
const INODE_BYTES = 32;
const DIR_ENTRY_BYTES = 32;
const NAME_BYTES = 24;

const u32 = (view, at, value) => {
  if (value === undefined) return view.getUint32(at, true);
  view.setUint32(at, value >>> 0, true);
};

const u16 = (view, at, value) => {
  if (value === undefined) return view.getUint16(at, true);
  view.setUint16(at, value, true);
};

export class BlockDevice {
  #blocks;
  #blockSize;
  #view;

  constructor({ blockSize = 4096, blocks = 256, buffer } = {}) {
    if (!Number.isSafeInteger(blockSize) || blockSize < 256 || (blockSize & (blockSize - 1)) !== 0) {
      throw new TypeError("blockSize must be a power of two >= 256");
    }
    if (!Number.isSafeInteger(blocks) || blocks < 8) throw new TypeError("blocks must be an integer >= 8");
    this.#blockSize = blockSize;
    this.#blocks = blocks;
    const bytes = buffer ?? new ArrayBuffer(blockSize * blocks);
    if (bytes.byteLength < blockSize * blocks) throw new TypeError("buffer too small for device");
    this.#view = new DataView(bytes);
  }

  get blockSize() {
    return this.#blockSize;
  }

  get blocks() {
    return this.#blocks;
  }

  get buffer() {
    return this.#view.buffer;
  }

  read(block, target = new Uint8Array(this.#blockSize)) {
    if (!Number.isInteger(block) || block < 0 || block >= this.#blocks) fail("/", "bad block", "EIO");
    const start = block * this.#blockSize;
    target.set(new Uint8Array(this.#view.buffer, start, Math.min(target.length, this.#blockSize)));
    return target;
  }

  write(block, source) {
    if (!Number.isInteger(block) || block < 0 || block >= this.#blocks) fail("/", "bad block", "EIO");
    if (!(source instanceof Uint8Array)) throw new TypeError("source must be Uint8Array");
    const start = block * this.#blockSize;
    const slice = new Uint8Array(this.#view.buffer, start, this.#blockSize);
    slice.fill(0);
    slice.set(source.subarray(0, this.#blockSize));
  }

  zero(block) {
    this.write(block, new Uint8Array(this.#blockSize));
  }
}

const inodeAt = (inode) => inode * INODE_BYTES;

export class BlockFS {
  #device;
  #view;
  #inodeBlocks;
  #inodeCount;
  #dataStart;
  #free = new Set();
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();

  constructor(device = new BlockDevice(), { format = true } = {}) {
    this.#device = device instanceof BlockDevice ? device : new BlockDevice(device);
    this.#view = new DataView(this.#device.buffer);
    this.#inodeBlocks = Math.max(1, Math.ceil(this.#device.blocks / 64));
    this.#inodeCount = Math.floor((this.#inodeBlocks * this.#device.blockSize) / INODE_BYTES);
    this.#dataStart = 1 + this.#inodeBlocks;
    if (format || u32(this.#view, SUPER) !== MAGIC) this.#format();
    else this.#rebuildFree();
  }

  get device() {
    return this.#device;
  }

  #format() {
    for (let block = 0; block < this.#device.blocks; block++) this.#device.zero(block);
    u32(this.#view, 0, MAGIC);
    u32(this.#view, 4, VERSION);
    u32(this.#view, 8, this.#device.blockSize);
    u32(this.#view, 12, this.#device.blocks);
    u32(this.#view, 16, this.#inodeBlocks);
    u32(this.#view, 20, this.#inodeCount);
    u32(this.#view, 24, this.#dataStart);
    this.#free = new Set();
    for (let block = this.#dataStart; block < this.#device.blocks; block++) this.#free.add(block);
    const rootData = this.#allocBlock();
    this.#writeInode(ROOT_INODE, {
      type: INODE_DIR,
      size: 0,
      links: 1,
      mtime: Date.now() >>> 0,
      direct: rootData,
    });
    this.#writeDirEntries(ROOT_INODE, []);
  }

  #rebuildFree() {
    this.#inodeBlocks = u32(this.#view, 16);
    this.#inodeCount = u32(this.#view, 20);
    this.#dataStart = u32(this.#view, 24);
    this.#free = new Set();
    for (let block = this.#dataStart; block < this.#device.blocks; block++) this.#free.add(block);
    for (let inode = ROOT_INODE; inode < this.#inodeCount; inode++) {
      const node = this.#readInode(inode);
      if (node.type === INODE_FREE) continue;
      for (let current = node.direct; current; ) {
        this.#free.delete(current);
        current = u32(this.#view, current * this.#device.blockSize + this.#device.blockSize - 4);
      }
    }
  }

  #inodeView(inode) {
    if (!Number.isInteger(inode) || inode < 1 || inode >= this.#inodeCount) fail("/", "bad inode", "EIO");
    return this.#device.blockSize + inodeAt(inode);
  }

  #readInode(inode) {
    const at = this.#inodeView(inode);
    return {
      type: u16(this.#view, at),
      links: u16(this.#view, at + 2),
      size: u32(this.#view, at + 4),
      mtime: u32(this.#view, at + 8),
      direct: u32(this.#view, at + 12),
      next: u32(this.#view, at + 16),
    };
  }

  #writeInode(inode, value) {
    const at = this.#inodeView(inode);
    u16(this.#view, at, value.type);
    u16(this.#view, at + 2, value.links);
    u32(this.#view, at + 4, value.size);
    u32(this.#view, at + 8, value.mtime);
    u32(this.#view, at + 12, value.direct);
    u32(this.#view, at + 16, value.next ?? 0);
  }

  #allocInode(type) {
    for (let inode = ROOT_INODE; inode < this.#inodeCount; inode++) {
      if (this.#readInode(inode).type === INODE_FREE) {
        this.#writeInode(inode, { type, size: 0, links: 1, mtime: Date.now() >>> 0, direct: 0 });
        return inode;
      }
    }
    fail("/", "inode table full", "ENOSPC");
  }

  #allocBlock() {
    const block = this.#free.values().next().value;
    if (block === undefined) fail("/", "no free blocks", "ENOSPC");
    this.#free.delete(block);
    this.#device.zero(block);
    return block;
  }

  #releaseChain(start) {
    let current = start;
    while (current) {
      const next = u32(this.#view, current * this.#device.blockSize + this.#device.blockSize - 4);
      this.#device.zero(current);
      this.#free.add(current);
      current = next;
    }
  }

  #readFileBytes(inode) {
    const node = this.#readInode(inode);
    const out = new Uint8Array(node.size);
    let offset = 0;
    let current = node.direct;
    const payload = this.#device.blockSize - 4;
    while (current && offset < node.size) {
      const chunk = this.#device.read(current).subarray(0, payload);
      const take = Math.min(payload, node.size - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      current = u32(this.#view, current * this.#device.blockSize + this.#device.blockSize - 4);
    }
    return out;
  }

  #writeFileBytes(inode, bytes) {
    const previous = this.#readInode(inode);
    this.#releaseChain(previous.direct);
    if (!bytes.length) {
      this.#writeInode(inode, { ...previous, size: 0, direct: 0, mtime: Date.now() >>> 0 });
      return;
    }
    const payload = this.#device.blockSize - 4;
    let remaining = bytes.length;
    let offset = 0;
    let first = 0;
    let prev = 0;
    while (remaining > 0) {
      const block = this.#allocBlock();
      if (!first) first = block;
      const buf = new Uint8Array(this.#device.blockSize);
      const take = Math.min(payload, remaining);
      buf.set(bytes.subarray(offset, offset + take));
      if (prev) {
        const linked = this.#device.read(prev);
        u32(new DataView(linked.buffer, linked.byteOffset, linked.byteLength), this.#device.blockSize - 4, block);
        this.#device.write(prev, linked);
      }
      this.#device.write(block, buf);
      prev = block;
      offset += take;
      remaining -= take;
    }
    this.#writeInode(inode, { ...previous, size: bytes.length, direct: first, mtime: Date.now() >>> 0 });
  }

  #dirEntries(inode) {
    const bytes = this.#readFileBytes(inode);
    const entries = [];
    for (let at = 0; at + DIR_ENTRY_BYTES <= bytes.length; at += DIR_ENTRY_BYTES) {
      const child = u32(new DataView(bytes.buffer, bytes.byteOffset + at, 4), 0);
      if (!child) continue;
      const nameBytes = bytes.subarray(at + 4, at + 4 + NAME_BYTES);
      const end = nameBytes.indexOf(0);
      const name = this.#decoder.decode(end < 0 ? nameBytes : nameBytes.subarray(0, end));
      if (name) entries.push({ name, inode: child });
    }
    return entries;
  }

  #writeDirEntries(inode, entries) {
    const bytes = new Uint8Array(Math.max(DIR_ENTRY_BYTES, entries.length * DIR_ENTRY_BYTES));
    entries.forEach((entry, index) => {
      const at = index * DIR_ENTRY_BYTES;
      u32(new DataView(bytes.buffer, bytes.byteOffset + at, DIR_ENTRY_BYTES), 0, entry.inode);
      bytes.set(this.#encoder.encode(entry.name).subarray(0, NAME_BYTES - 1), at + 4);
    });
    this.#writeFileBytes(inode, bytes);
  }

  resolve(cwd = "/", input = ".") {
    if (typeof cwd !== "string" || typeof input !== "string" || input.includes("\0")) {
      fail(String(input), "invalid path");
    }
    const parts = input.startsWith("/") ? [] : cwd.split("/").filter(Boolean);
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) fail(input, "path escapes root", "EACCES");
        parts.pop();
      } else parts.push(part);
    }
    return `/${parts.join("/")}`;
  }

  parent(path) {
    const parts = path.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  basename(path) {
    return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  }

  #lookup(path) {
    path = this.resolve("/", path);
    if (path === "/") return ROOT_INODE;
    let inode = ROOT_INODE;
    for (const part of path.split("/").filter(Boolean)) {
      if (this.#readInode(inode).type !== INODE_DIR) fail(path, "Not a directory", "ENOTDIR");
      const hit = this.#dirEntries(inode).find((entry) => entry.name === part);
      if (!hit) fail(path, "No such file or directory", "ENOENT");
      inode = hit.inode;
    }
    return inode;
  }

  exists(path, cwd = "/") {
    try {
      this.#lookup(this.resolve(cwd, path));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  stat(path, cwd = "/") {
    path = this.resolve(cwd, path);
    const inode = this.#lookup(path);
    const node = this.#readInode(inode);
    return {
      path,
      type: node.type === INODE_DIR ? "directory" : "file",
      size: node.size,
      mtime: node.mtime * 1000,
      inode,
    };
  }

  read(path, cwd = "/") {
    path = this.resolve(cwd, path);
    const inode = this.#lookup(path);
    if (this.#readInode(inode).type === INODE_DIR) fail(path, "Is a directory", "EISDIR");
    return this.#decoder.decode(this.#readFileBytes(inode));
  }

  write(path, value, cwd = "/") {
    path = this.resolve(cwd, path);
    value = String(value);
    const parentPath = this.parent(path);
    const name = this.basename(path);
    if (name.length >= NAME_BYTES) fail(path, "File name too long", "ENAMETOOLONG");
    const parent = this.#lookup(parentPath);
    if (this.#readInode(parent).type !== INODE_DIR) fail(path, "Not a directory", "ENOTDIR");
    const entries = this.#dirEntries(parent);
    let inode = entries.find((entry) => entry.name === name)?.inode;
    if (inode) {
      if (this.#readInode(inode).type === INODE_DIR) fail(path, "Is a directory", "EISDIR");
    } else {
      inode = this.#allocInode(INODE_FILE);
      entries.push({ name, inode });
      this.#writeDirEntries(parent, entries);
    }
    this.#writeFileBytes(inode, this.#encoder.encode(value));
    return path;
  }

  append(path, value, cwd = "/") {
    path = this.resolve(cwd, path);
    return this.write(path, (this.exists(path) ? this.read(path) : "") + value);
  }

  mkdir(path, { cwd = "/", parents = false } = {}) {
    path = this.resolve(cwd, path);
    if (path === "/") return path;
    if (this.exists(path)) {
      if (parents && this.stat(path).type === "directory") return path;
      fail(path, "File exists", "EEXIST");
    }
    const parentPath = this.parent(path);
    if (!this.exists(parentPath)) {
      if (!parents) fail(path, "No such directory", "ENOENT");
      this.mkdir(parentPath, { parents: true });
    }
    const name = this.basename(path);
    if (name.length >= NAME_BYTES) fail(path, "File name too long", "ENAMETOOLONG");
    const parent = this.#lookup(parentPath);
    const inode = this.#allocInode(INODE_DIR);
    this.#writeDirEntries(parent, [...this.#dirEntries(parent), { name, inode }]);
    this.#writeDirEntries(inode, []);
    return path;
  }

  list(path = ".", cwd = "/") {
    path = this.resolve(cwd, path);
    const info = this.stat(path);
    if (info.type === "file") return [{ ...info, name: this.basename(path) }];
    return this.#dirEntries(this.#lookup(path))
      .map((entry) => {
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        return { ...this.stat(child), name: entry.name };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(path, { cwd = "/", recursive = false } = {}) {
    cwd = this.resolve("/", cwd);
    path = this.resolve(cwd, path);
    if (path === "/") fail(path, "cannot remove root", "EPERM");
    if (path === cwd || cwd.startsWith(`${path}/`)) fail(path, "Device busy", "EBUSY");
    const inode = this.#lookup(path);
    const node = this.#readInode(inode);
    if (node.type === INODE_DIR) {
      const children = this.#dirEntries(inode);
      if (children.length && !recursive) fail(path, "Directory not empty", "ENOTEMPTY");
      for (const child of children) {
        this.remove(path === "/" ? `/${child.name}` : `${path}/${child.name}`, { recursive: true });
      }
    }
    const parent = this.#lookup(this.parent(path));
    const name = this.basename(path);
    this.#writeDirEntries(
      parent,
      this.#dirEntries(parent).filter((entry) => entry.name !== name),
    );
    this.#releaseChain(this.#readInode(inode).direct);
    this.#writeInode(inode, { type: INODE_FREE, size: 0, links: 0, mtime: 0, direct: 0 });
  }

  touch(path, cwd = "/") {
    path = this.resolve(cwd, path);
    if (!this.exists(path)) return this.write(path, "");
    const inode = this.#lookup(path);
    this.#writeInode(inode, { ...this.#readInode(inode), mtime: Date.now() >>> 0 });
    return path;
  }

  complete(cwd, fragment) {
    const slash = fragment.lastIndexOf("/");
    const directory = slash < 0 ? "." : fragment.slice(0, slash) || "/";
    const prefix = slash < 0 ? fragment : fragment.slice(slash + 1);
    const lead = slash < 0 ? "" : fragment.slice(0, slash + 1);
    try {
      return this.list(directory, cwd)
        .filter(({ name }) => name.startsWith(prefix))
        .map(({ name, type }) => `${lead}${name}${type === "directory" ? "/" : ""}`);
    } catch {
      return [];
    }
  }
}

export const createBlockFS = (options) => new BlockFS(options?.device ?? options, options);
