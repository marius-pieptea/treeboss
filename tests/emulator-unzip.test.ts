/** The streaming zip extractor on small real archives: path and symlink containment, integrity checks, and backslash names. */
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { unzip } from "../src/emulator/unzip";
import { makeDir } from "./helpers";

interface Spec {
  name: string;
  data?: string;
  /** A unix symlink whose target is `data`. */
  symlink?: boolean;
  /** Overrides, to write an archive whose headers lie about the bytes. */
  crc?: number;
  usize?: number;
  /** Replaces the deflate stream, which makes the entry corrupt. */
  packed?: Buffer;
}

function makeZip(entries: Spec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const dir = e.name.endsWith("/");
    const packed = e.packed ?? (dir ? Buffer.alloc(0) : zlib.deflateRawSync(data));
    const method = packed.length ? 8 : 0;
    const crc = e.crc ?? zlib.crc32(data);
    const usize = e.usize ?? data.length;
    const n = Buffer.from(e.name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(usize, 22);
    head.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.symlink ? (3 << 8) | 20 : 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(n.length, 28);
    if (e.symlink) cd.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(head, n, packed);
    central.push(cd, n);
    offset += 30 + n.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

let dir: string;
let out: string;
let outside: string;
beforeEach(() => {
  dir = makeDir();
  out = path.join(dir, "out");
  outside = path.join(dir, "outside");
  fs.mkdirSync(out);
  fs.mkdirSync(outside);
});

const extract = (entries: Spec[]) => {
  const zip = path.join(dir, "a.zip");
  fs.writeFileSync(zip, makeZip(entries));
  return unzip(zip, out);
};

describe("unzip", () => {
  test("extracts files, folders and nested names", async () => {
    await extract([{ name: "d/" }, { name: "d/a.txt", data: "hello" }, { name: "empty.txt" }]);
    expect(fs.readFileSync(path.join(out, "d", "a.txt"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(out, "empty.txt"), "utf-8")).toBe("");
  });

  test("backslash names (PowerShell Compress-Archive) extract as folders and files", async () => {
    await extract([{ name: "nested\\" }, { name: "nested\\a\\" }, { name: "nested\\a\\b.txt", data: "x" }]);
    expect(fs.readFileSync(path.join(out, "nested", "a", "b.txt"), "utf-8")).toBe("x");
    expect(fs.statSync(path.join(out, "nested", "a")).isDirectory()).toBe(true);
  });

  test("a backslash name still cannot climb out of the destination", async () => {
    await expect(extract([{ name: "..\\evil.txt", data: "x" }])).rejects.toThrow("outside");
    expect(fs.existsSync(path.join(dir, "evil.txt"))).toBe(false);
  });

  test("a corrupt deflate stream is an error, not silently wrong bytes", async () => {
    const good = zlib.deflateRawSync(Buffer.from("hello world"));
    const bad = Buffer.from(zlib.deflateRawSync(Buffer.from("HELLO WORLD")));
    expect(bad.length).toBe(good.length);
    await expect(extract([{ name: "a.txt", data: "hello world", packed: bad }])).rejects.toThrow(/crc/i);
  });

  test("an entry whose size differs from its header is an error", async () => {
    await expect(extract([{ name: "a.txt", data: "hello", usize: 99 }])).rejects.toThrow(/size/i);
  });

  test("a stored empty entry with a nonzero crc is an error", async () => {
    await expect(extract([{ name: "a.txt", data: "", crc: 123 }])).rejects.toThrow(/crc/i);
  });

  test("refuses a symlink whose target is outside the destination", async () => {
    await expect(extract([{ name: "lnk", data: "../outside", symlink: true }])).rejects.toThrow("outside");
    await expect(extract([{ name: "abs", data: outside, symlink: true }])).rejects.toThrow("outside");
    expect(fs.existsSync(path.join(out, "lnk"))).toBe(false);
  });

  test("never writes an entry through a link that leads outside the destination", async () => {
    // A junction is a directory link Windows lets anyone make; on POSIX a plain symlink does the same.
    fs.symlinkSync(outside, path.join(out, "lnk"), "junction");
    await expect(extract([{ name: "lnk/pwned.txt", data: "x" }])).rejects.toThrow("outside");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("never creates folders through such a link either", async () => {
    fs.symlinkSync(outside, path.join(out, "lnk"), "junction");
    await expect(extract([{ name: "lnk/sub/" }])).rejects.toThrow("outside");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("keeps a symlink that points inside the tree", async () => {
    await extract([{ name: "bin/real.sh", data: "#!/bin/sh" }, { name: "bin/alias", data: "real.sh", symlink: true }, { name: "lib/up", data: "../bin", symlink: true }]);
    expect(fs.readlinkSync(path.join(out, "bin", "alias"))).toBe("real.sh");
    expect(fs.readFileSync(path.join(out, "lib", "up", "real.sh"), "utf-8")).toBe("#!/bin/sh");
  });

  test.skipIf(process.platform === "win32")("an in-tree symlink entry cannot be used to write outside afterwards", async () => {
    await expect(extract([{ name: "lnk", data: "../outside", symlink: true }, { name: "lnk/pwned.txt", data: "x" }])).rejects.toThrow("outside");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
