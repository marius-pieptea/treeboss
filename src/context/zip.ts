/**
 * A small, defensive zip reader and extractor (no dependency: node:zlib does the inflating).
 *
 * Archives attached to a message are untrusted. The rules, all enforced here and all tested with hostile
 * archives:
 *  - zip-slip: an entry whose normalised path is absolute, has a `..` segment, a drive letter or a NUL is refused;
 *    extraction also re-checks that the final path stays inside the destination;
 *  - symlinks and other non-regular entries (devices, fifos) are refused, never created;
 *  - encrypted entries and ZIP64 archives are refused;
 *  - limits: entry count, per-entry and total uncompressed size, compression ratio (zip bombs), path depth;
 *  - declared sizes are not trusted: inflation is capped at the remaining budget and the real size must match;
 *  - nesting: an archive inside an archive is written out as an ordinary file and never opened.
 * Extracted files get mode 0600 (no executable bits), folders 0700.
 */
import fs from "fs";
import path from "path";
import { inflateRawSync } from "zlib";

export const ZIP_LIMITS = {
  maxEntries: 2_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 150 * 1024 * 1024,
  /** Uncompressed / compressed above this, for entries over `ratioFloor`, is treated as a bomb. */
  maxRatio: 200,
  ratioFloor: 1024 * 1024,
  maxDepth: 16,
  maxPathChars: 240,
};

export type ZipLimits = typeof ZIP_LIMITS;

export class ZipError extends Error {}

export interface ZipEntryInfo {
  /** Normalised, forward-slash relative path (folders end in `/`). */
  name: string;
  isDir: boolean;
  size: number;
  csize: number;
  method: number;
  flags: number;
  offset: number;
  /** Unix file type bits from the external attributes (0 when the archive was not made on Unix). */
  unixType: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Read the central directory. Throws a ZipError for anything malformed or over a limit. */
export function readZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntryInfo[] {
  if (buf.length < 22) throw new ZipError("not a zip archive");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive (no end-of-directory record)");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (total > limits.maxEntries) throw new ZipError(`too many entries (${total}, the limit is ${limits.maxEntries})`);
  if (cdOff + cdSize > eocd) throw new ZipError("corrupt central directory");
  const out: ZipEntryInfo[] = [];
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt central directory");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipError("corrupt central directory");
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    const unixType = madeBy >> 8 === 3 ? ((ext >>> 16) & S_IFMT) : 0;
    const name = rawName.replace(/\\/g, "/");
    out.push({ name, isDir: name.endsWith("/") || unixType === S_IFDIR, size, csize, method, flags, offset, unixType });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Why an entry's name cannot be extracted, or null when it is a safe relative path. */
export function unsafeName(name: string, limits: ZipLimits = ZIP_LIMITS): string | null {
  if (!name) return "empty name";
  if (name.includes("\0")) return "NUL in name";
  if (name.length > limits.maxPathChars) return "name too long";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "absolute path";
  const parts = name.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "..")) return "path escapes the archive (..)";
  if (parts.length > limits.maxDepth) return "nested too deep";
  return null;
}

export interface Extracted {
  /** Files written, relative to the destination, with their sizes. */
  files: Array<{ path: string; bytes: number }>;
  /** Entries that were refused or skipped, each with the reason. */
  refused: Array<{ name: string; why: string }>;
  totalBytes: number;
}

function inflateEntry(buf: Buffer, e: ZipEntryInfo, room: number, limits: ZipLimits): Buffer {
  if (buf.length < e.offset + 30 || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError("bad local header");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (raw.length !== e.csize) throw new ZipError("truncated entry");
  if (e.size > limits.maxEntryBytes) throw new ZipError(`larger than ${limits.maxEntryBytes / 1024 / 1024} MB`);
  if (e.size > room) throw new ZipError("archive is larger than the unpacking budget");
  if (e.size > limits.ratioFloor && e.csize > 0 && e.size / e.csize > limits.maxRatio) throw new ZipError("suspicious compression ratio (zip bomb)");
  let data: Buffer;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      // Never inflate past what was declared (+1 to notice a lie): a bomb cannot outgrow its own header.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size + 1) });
    } catch {
      throw new ZipError("corrupt or lying about its size");
    }
  } else throw new ZipError(`unsupported compression method ${e.method}`);
  if (data.length !== e.size) throw new ZipError("size does not match the header");
  return data;
}

/** Read one entry's bytes by name (used for .docx), under the same limits. */
export function readEntry(buf: Buffer, name: string, limits: ZipLimits = ZIP_LIMITS): Buffer | null {
  const e = readZip(buf, limits).find((x) => x.name === name && !x.isDir);
  if (!e || (e.flags & 1)) return null;
  return inflateEntry(buf, e, limits.maxEntryBytes, limits);
}

/** Unpack into `dest` (created fresh by the caller). Never throws for a bad entry: it is listed in `refused`. */
export function extractZip(buf: Buffer, dest: string, limits: ZipLimits = ZIP_LIMITS): Extracted {
  const entries = readZip(buf, limits);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const res: Extracted = { files: [], refused: [], totalBytes: 0 };
  const seen = new Set<string>();
  // The central directory is trusted for nothing: the declared total is checked up front, the real one as we go.
  const declared = entries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
  if (declared > limits.maxTotalBytes) throw new ZipError(`unpacks to more than ${limits.maxTotalBytes / 1024 / 1024} MB`);
  for (const e of entries) {
    const bad = unsafeName(e.name, limits);
    if (bad) {
      res.refused.push({ name: e.name.slice(0, 120), why: bad });
      continue;
    }
    if (e.unixType && e.unixType !== S_IFREG && e.unixType !== S_IFDIR) {
      res.refused.push({ name: e.name, why: e.unixType === 0o120000 ? "symbolic link" : "not a regular file" });
      continue;
    }
    if (e.flags & 1) {
      res.refused.push({ name: e.name, why: "encrypted" });
      continue;
    }
    const rel = path.posix.normalize(e.name.replace(/\/+$/, ""));
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.refused.push({ name: e.name, why: "path escapes the archive" });
      continue;
    }
    if (e.isDir) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    if (seen.has(rel)) {
      res.refused.push({ name: e.name, why: "duplicate entry" });
      continue;
    }
    try {
      const data = inflateEntry(buf, e, limits.maxTotalBytes - res.totalBytes, limits);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // A real folder must be on the path: never write through anything that is a link.
      for (let d = path.dirname(target); d !== root; d = path.dirname(d)) if (fs.lstatSync(d).isSymbolicLink()) throw new ZipError("path crosses a link");
      fs.writeFileSync(target, data, { mode: 0o600, flag: "wx" });
      seen.add(rel);
      res.totalBytes += data.length;
      res.files.push({ path: rel, bytes: data.length });
    } catch (err: any) {
      res.refused.push({ name: e.name, why: err instanceof ZipError ? err.message : "could not be written" });
    }
  }
  return res;
}
