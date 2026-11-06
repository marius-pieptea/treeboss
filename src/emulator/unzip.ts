/**
 * Extracts a zip with node:zlib and fs, so the installer needs no archive dependency and no `unzip`/`tar` on
 * the PATH (Windows has no unzip, Linux has no zip-capable tar). Entries stream from disk to disk, so the
 * 1.7 GB system image never sits in memory. Handles the stored and deflate methods, zip64, and unix modes.
 *
 * The archive is Google's, already checked against its sha1, but a path is still never allowed out of `dest`.
 */
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import zlib from "zlib";

interface Entry {
  name: string;
  method: number;
  csize: number;
  usize: number;
  crc: number;
  offset: number;
  mode: number;
  unixMode: boolean;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) throw new Error("zip: unexpected end of file");
    got += n;
  }
  return buf;
}

function centralDirectory(fd: number, size: number): { offset: number; length: number } {
  const tailLen = Math.min(size, 0xffff + 22);
  const tail = readAt(fd, tailLen, size - tailLen);
  let at = tail.length - 22;
  while (at >= 0 && tail.readUInt32LE(at) !== EOCD) at--;
  if (at < 0) throw new Error("zip: not a zip file (no end-of-central-directory record)");
  let length = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  if (length === 0xffffffff || offset === 0xffffffff) {
    if (at < 20 || tail.readUInt32LE(at - 20) !== EOCD64_LOCATOR) throw new Error("zip: zip64 locator missing");
    const eocd64At = Number(tail.readBigUInt64LE(at - 20 + 8));
    const rec = readAt(fd, 56, eocd64At);
    if (rec.readUInt32LE(0) !== EOCD64) throw new Error("zip: bad zip64 end record");
    length = Number(rec.readBigUInt64LE(40));
    offset = Number(rec.readBigUInt64LE(48));
  }
  return { offset, length };
}

function entries(cd: Buffer): Entry[] {
  const out: Entry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === CENTRAL; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const e: Entry = {
      name: cd.toString("utf-8", p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      crc: cd.readUInt32LE(p + 16),
      offset: cd.readUInt32LE(p + 42),
      mode: cd.readUInt32LE(p + 38) >>> 16,
      unixMode: cd.readUInt16LE(p + 4) >> 8 === 3,
    };
    // zip64: the fields that did not fit in 32 bits are in the 0x0001 extra, in this order.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; x += 4 + cd.readUInt16LE(x + 2)) {
      if (cd.readUInt16LE(x) !== 1) continue;
      let q = x + 4;
      if (e.usize === 0xffffffff) (e.usize = Number(cd.readBigUInt64LE(q))), (q += 8);
      if (e.csize === 0xffffffff) (e.csize = Number(cd.readBigUInt64LE(q))), (q += 8);
      if (e.offset === 0xffffffff) e.offset = Number(cd.readBigUInt64LE(q));
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Resolves an entry name under `dest`, refusing anything that would land outside it. */
function target(dest: string, name: string): string {
  if (name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw new Error(`zip: refusing entry outside the destination: ${name}`);
  return path.join(dest, name);
}

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** The real path of the deepest part of `p` that exists, so a link an earlier entry (or an earlier run) made is followed before anything is written. */
function realExisting(p: string): string {
  for (let at = p; ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync(at), path.relative(at, p));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(at) === at) throw e;
    }
  }
}

function assertInside(root: string, p: string, name: string): void {
  if (!within(root, realExisting(p))) throw new Error(`zip: refusing entry outside the destination: ${name}`);
}

export async function unzip(zipPath: string, dest: string, signal?: AbortSignal): Promise<void> {
  const fd = fs.openSync(zipPath, "r");
  try {
    fs.mkdirSync(dest, { recursive: true });
    const root = fs.realpathSync(dest);
    const { offset, length } = centralDirectory(fd, fs.fstatSync(fd).size);
    for (const e of entries(readAt(fd, length, offset))) {
      signal?.throwIfAborted();
      // PowerShell's Compress-Archive writes backslashes; every path decision below is made on the normalised name.
      const name = e.name.replace(/\\/g, "/");
      const out = target(dest, name);
      const parent = name.endsWith("/") ? out : path.dirname(out);
      assertInside(root, parent, e.name);
      fs.mkdirSync(parent, { recursive: true });
      if (name.endsWith("/")) continue;
      // A link already at `out` (an earlier symlink entry) must not be written through.
      if (fs.lstatSync(out, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`zip: refusing to write through a link: ${e.name}`);
      const local = readAt(fd, 30, e.offset);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error(`zip: bad local header for ${e.name}`);
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (e.method !== 0 && e.method !== 8) throw new Error(`zip: unsupported compression method ${e.method} for ${e.name}`);
      if (e.unixMode && (e.mode & 0o170000) === 0o120000) {
        // A symlink entry holds its target as the data. Windows cannot make one without privileges, and those builds have none.
        const raw = readAt(fd, e.csize, start);
        const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
        check(e, data.length, zlib.crc32(data));
        const link = data.toString("utf-8");
        if (!within(root, path.resolve(path.dirname(realExisting(out)), link))) throw new Error(`zip: refusing a link outside the destination: ${e.name} -> ${link}`);
        if (process.platform !== "win32") fs.symlinkSync(link, out);
        continue;
      }
      let size = 0;
      let crc = 0;
      if (e.csize > 0) {
        const body = fs.createReadStream(zipPath, { start, end: start + e.csize - 1 });
        const sink = fs.createWriteStream(out);
        const tally = async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            size += chunk.length;
            crc = zlib.crc32(chunk, crc);
            yield chunk;
          }
        };
        await (e.method === 8 ? pipeline(body, zlib.createInflateRaw(), tally, sink, { signal }) : pipeline(body, tally, sink, { signal }));
      } else {
        fs.writeFileSync(out, "");
      }
      try {
        check(e, size, crc);
      } catch (err) {
        fs.rmSync(out, { force: true });
        throw err;
      }
      if (e.unixMode && process.platform !== "win32" && e.mode & 0o777) fs.chmodSync(out, e.mode & 0o777);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The central directory's CRC-32 and size are what the entry must have produced, or the stream was corrupt or truncated. */
function check(e: Entry, size: number, crc: number): void {
  if (size !== e.usize) throw new Error(`zip: wrong size for ${e.name}: ${size} bytes, expected ${e.usize}`);
  if (crc !== e.crc) throw new Error(`zip: CRC-32 mismatch for ${e.name}`);
}
