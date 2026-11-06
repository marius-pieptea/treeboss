/** The installer on a faked fetcher and real temp folders: idempotent, resumable, checksum-checked, and never touching an SDK it does not own. */
import { beforeEach, describe, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import type { Deps } from "../src/emulator/deps";
import { STAMP, ChecksumError, createInstaller, renderAvd, runInstall } from "../src/emulator/install";
import { avdSpecFor, licenseHash } from "../src/emulator/manifest";
import { unzip } from "../src/emulator/unzip";
import type { InstallPlan, InstallStep, PackageArchive } from "../src/emulator/types";
import { makeDir } from "./helpers";

/** A minimal zip writer (deflate, or stored for folders) so the tests extract real archives. */
function makeZip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = name.endsWith("/") ? Buffer.alloc(0) : zlib.deflateRawSync(data);
    const method = packed.length ? 8 : 0;
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(zlib.crc32(data), 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(head, n, packed);
    central.push(cd, n);
    offset += 30 + n.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");
const IMAGE = "system-images;android-35;google_apis;x86_64" as const;
const archives = {
  "platform-tools": makeZip({ "platform-tools/": "", "platform-tools/adb.exe": "adb" }),
  emulator: makeZip({ "emulator/emulator.exe": "emu", "emulator/lib/a.dll": "lib" }),
  [IMAGE]: makeZip({ "x86_64/system.img": "image", "x86_64/source.properties": "p" }),
};
const pkg = (p: keyof typeof archives): PackageArchive => ({ path: p, revision: "1.2.3", url: `https://dl.test/${p}`, sha1: sha1(archives[p]), size: archives[p].length, licenseId: "android-sdk-license", destDir: p.split(";").join("/") });

let dir: string;
let deps: Deps;
let downloads: string[];
/** Runs after the first half of each download has been written. */
let onHalf: (url: string) => void;
/** Same size as the real archive but the wrong bytes, and a truncated one. */
let corrupt: Set<string>;
let short: Set<string>;
const plan = (): InstallPlan => ({
  root: deps.paths.root,
  avdHome: deps.paths.avdHome,
  packages: [pkg("platform-tools"), pkg("emulator"), pkg(IMAGE)],
  licenses: [
    { id: "android-sdk-license", text: "terms & <conditions>", hash: licenseHash("terms & <conditions>") },
    { id: "other-license", text: "more", hash: licenseHash("more") },
  ],
  avd: avdSpecFor("x86_64"),
});

beforeEach(() => {
  dir = makeDir();
  downloads = [];
  corrupt = new Set();
  short = new Set();
  onHalf = () => {};
  deps = {
    exec: {
      run: async () => {
        throw new Error("no exec");
      },
      spawn: () => {
        throw new Error("no spawn");
      },
    },
    fetch: {
      text: async () => {
        throw new Error("no network");
      },
      async download(url, dest, onBytes) {
        downloads.push(url);
        const key = url.slice("https://dl.test/".length) as keyof typeof archives;
        const bytes = corrupt.has(key) ? Buffer.alloc(archives[key].length, 7) : short.has(key) ? Buffer.from("garbage") : archives[key];
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const half = Math.floor(bytes.length / 2);
        fs.writeFileSync(dest, bytes.subarray(0, half));
        onBytes(half);
        onHalf(url);
        fs.writeFileSync(dest, bytes);
        onBytes(bytes.length);
      },
    },
    now: () => 0,
    paths: { root: path.join(dir, "sdk"), avdHome: path.join(dir, "avd"), tmp: path.join(dir, "tmp") },
  };
});

const ok = new AbortController().signal;
const noop = () => {};

describe("runInstall", () => {
  test("installs every package into its destDir with a stamp and package.xml, then creates the AVD", async () => {
    const seen: [InstallStep, number, number][] = [];
    await runInstall(plan(), deps, (s, d, t) => void seen.push([s, d, t]), ok);
    const sdk = deps.paths.root;
    expect(fs.readFileSync(path.join(sdk, "platform-tools", "adb.exe"), "utf-8")).toBe("adb");
    expect(fs.readFileSync(path.join(sdk, "emulator", "lib", "a.dll"), "utf-8")).toBe("lib");
    const image = path.join(sdk, "system-images", "android-35", "google_apis", "x86_64");
    expect(fs.readFileSync(path.join(image, "system.img"), "utf-8")).toBe("image");
    expect(fs.readFileSync(path.join(image, STAMP), "utf-8").trim()).toBe(pkg(IMAGE).sha1);
    const xml = fs.readFileSync(path.join(image, "package.xml"), "utf-8");
    expect(xml).toContain(`<localPackage path="${IMAGE}"`);
    expect(xml).toContain("<abi>x86_64</abi>");
    expect(xml).toContain("terms &amp; &lt;conditions&gt;");
    expect(fs.existsSync(path.join(deps.paths.avdHome, "trb.ini"))).toBe(true);
    expect(fs.readFileSync(path.join(deps.paths.avdHome, "trb.avd", "config.ini"), "utf-8")).toContain("hw.lcd.width=720");
    expect(fs.readdirSync(deps.paths.tmp)).toEqual([]);
    const total = plan().packages.reduce((s, p) => s + p.size, 0);
    expect(seen.at(-1)).toEqual([{ pkg: "avd", phase: "create" }, total, total]);
    expect(seen.map(([s]) => s.phase)).toEqual(expect.arrayContaining(["download", "verify", "extract", "create"]));
  });

  test("a second run downloads nothing and changes nothing", async () => {
    await runInstall(plan(), deps, noop, ok);
    expect(downloads).toHaveLength(3);
    const stampFile = path.join(deps.paths.root, "emulator", STAMP);
    const before = fs.statSync(stampFile).mtimeMs;
    await runInstall(plan(), deps, noop, ok);
    expect(downloads).toHaveLength(3);
    expect(fs.statSync(stampFile).mtimeMs).toBe(before);
  });

  test("a run aborted mid-download leaves resumable state, and the next run only fetches what is missing", async () => {
    const controller = new AbortController();
    onHalf = (url) => url.endsWith("emulator") && controller.abort();
    await expect(runInstall(plan(), deps, noop, controller.signal)).rejects.toThrow();
    expect(downloads).toEqual(["https://dl.test/platform-tools", "https://dl.test/emulator"]);
    expect(fs.existsSync(path.join(deps.paths.root, "platform-tools", STAMP))).toBe(true);
    expect(fs.existsSync(path.join(deps.paths.root, "emulator"))).toBe(false);
    onHalf = noop;
    await runInstall(plan(), deps, noop, ok);
    expect(downloads.slice(2)).toEqual(["https://dl.test/emulator", `https://dl.test/${IMAGE}`]);
    expect(fs.readFileSync(path.join(deps.paths.root, "emulator", "emulator.exe"), "utf-8")).toBe("emu");
  });

  test("a verified archive left by a crash before extraction is extracted without downloading again", async () => {
    const p = plan();
    const sha = p.packages[0]!.sha1;
    fs.mkdirSync(path.join(deps.paths.tmp, `${sha}.x`, "stale"), { recursive: true });
    fs.writeFileSync(path.join(deps.paths.tmp, `${sha}.zip`), archives["platform-tools"]);
    await runInstall(p, deps, noop, ok);
    expect(downloads).not.toContain("https://dl.test/platform-tools");
    expect(fs.existsSync(path.join(deps.paths.root, "platform-tools", "adb.exe"))).toBe(true);
    expect(fs.existsSync(path.join(deps.paths.root, "platform-tools", "stale"))).toBe(false);
  });

  test("a reused archive of the right size but the wrong bytes is not trusted: it is downloaded again", async () => {
    const p = plan();
    fs.mkdirSync(deps.paths.tmp, { recursive: true });
    fs.writeFileSync(path.join(deps.paths.tmp, `${p.packages[0]!.sha1}.zip`), Buffer.alloc(archives["platform-tools"].length, 7));
    await runInstall(p, deps, noop, ok);
    expect(downloads).toContain("https://dl.test/platform-tools");
    expect(fs.readFileSync(path.join(deps.paths.root, "platform-tools", "adb.exe"), "utf-8")).toBe("adb");
  });

  test("a bad sha1 throws a ChecksumError and leaves nothing in destDir or tmp", async () => {
    corrupt.add("emulator");
    await expect(runInstall(plan(), deps, noop, ok)).rejects.toBeInstanceOf(ChecksumError);
    expect(fs.existsSync(path.join(deps.paths.root, "emulator"))).toBe(false);
    expect(fs.readdirSync(deps.paths.tmp)).toEqual([]);
    expect(fs.existsSync(path.join(deps.paths.avdHome, "trb.ini"))).toBe(false);
    corrupt.clear();
    await runInstall(plan(), deps, noop, ok);
    expect(fs.existsSync(path.join(deps.paths.root, "emulator", STAMP))).toBe(true);
  });

  test("a download of the wrong size is refused too", async () => {
    short.add("platform-tools");
    await expect(runInstall(plan(), deps, noop, ok)).rejects.toBeInstanceOf(ChecksumError);
    expect(fs.existsSync(path.join(deps.paths.root, "platform-tools"))).toBe(false);
  });

  test("it refuses to install into a root it does not own", async () => {
    await expect(runInstall({ ...plan(), root: path.join(dir, "someone-elses-sdk") }, deps, noop, ok)).rejects.toThrow("does not own");
    expect(fs.existsSync(path.join(dir, "someone-elses-sdk"))).toBe(false);
  });
});

describe("createInstaller", () => {
  const seams = (extra = {}) => ({ os: "windows", arch: "x64", env: {}, ...extra }) as const;

  test("accept writes only the license ids it is given, each with its hash", async () => {
    await createInstaller(deps, seams()).accept(plan(), ["android-sdk-license"]);
    expect(fs.readdirSync(path.join(deps.paths.root, "licenses"))).toEqual(["android-sdk-license"]);
    expect(fs.readFileSync(path.join(deps.paths.root, "licenses", "android-sdk-license"), "utf-8").trim()).toBe(licenseHash("terms & <conditions>"));
  });

  test("accept refuses ids that are not plain names, even when the plan lists them", async () => {
    const installer = createInstaller(deps, seams());
    for (const id of [".", "..", ".hidden", "-x", "a/b", "a\b"]) {
      const hostile = { ...plan(), licenses: [{ id, text: "t", hash: licenseHash("t") }] };
      await expect(installer.accept(hostile, [id])).rejects.toThrow("not a license");
    }
    expect(fs.existsSync(deps.paths.root)).toBe(false);
  });

  test("accept refuses an unknown id before writing anything, and never writes into a reused SDK", async () => {
    const installer = createInstaller(deps, seams());
    await expect(installer.accept(plan(), ["android-sdk-license", "nope"])).rejects.toThrow("nope");
    expect(fs.existsSync(path.join(deps.paths.root, "licenses"))).toBe(false);
    const reused = path.join(dir, "studio-sdk");
    await expect(installer.accept({ ...plan(), root: reused }, ["android-sdk-license"])).rejects.toThrow("does not own");
    expect(fs.existsSync(reused)).toBe(false);
  });

  test("reconcile reads the disk: absent, installed and owned once everything is stamped, absent again if a stamp is missing", async () => {
    const installer = createInstaller(deps, seams());
    expect(await installer.reconcile()).toEqual({ kind: "absent" });
    await runInstall(plan(), deps, noop, ok);
    expect(await installer.reconcile()).toEqual({ kind: "installed", root: deps.paths.root, owned: true, avd: avdSpecFor("x86_64") });
    fs.rmSync(path.join(deps.paths.root, "emulator", STAMP));
    expect(await installer.reconcile()).toEqual({ kind: "absent" });
  });

  test("a reused SDK is planned with no download, gets only our AVD, and reads back as not owned", async () => {
    const studio = path.join(dir, "studio-sdk");
    const files = [path.join(studio, "emulator", "emulator.exe"), path.join(studio, "system-images", "android-35", "google_apis", "x86_64", "package.xml")];
    for (const f of files) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "");
    }
    const installer = createInstaller(deps, seams({ env: { ANDROID_HOME: studio } }));
    const probe = await installer.probe();
    expect(probe.existingSdk).toBe(studio);
    const p = await installer.plan(probe);
    expect(p).toMatchObject({ root: studio, packages: [], licenses: [] });
    await installer.run(p, noop, ok);
    expect(downloads).toEqual([]);
    expect(fs.existsSync(path.join(studio, "licenses"))).toBe(false);
    expect(await installer.reconcile()).toMatchObject({ kind: "installed", root: studio, owned: false });
  });

  test("remove deletes only the owned folders, never a reused SDK, and is safe to run twice", async () => {
    const studio = path.join(dir, "studio-sdk");
    fs.mkdirSync(path.join(studio, "emulator"), { recursive: true });
    fs.writeFileSync(path.join(studio, "emulator", "emulator.exe"), "mine");
    const installer = createInstaller(deps, seams({ env: { ANDROID_HOME: studio } }));
    await runInstall(plan(), deps, noop, ok);
    await installer.remove();
    for (const p of Object.values(deps.paths)) expect(fs.existsSync(p)).toBe(false);
    expect(fs.readFileSync(path.join(studio, "emulator", "emulator.exe"), "utf-8")).toBe("mine");
    await installer.remove();
    expect(await installer.reconcile()).toEqual({ kind: "absent" });
  });

  test("bin has .exe paths on Windows and bare names elsewhere", () => {
    expect(createInstaller(deps, seams()).bin("C:\\sdk")).toEqual({ adb: "C:\\sdk\\platform-tools\\adb.exe", emulator: "C:\\sdk\\emulator\\emulator.exe" });
    expect(createInstaller(deps, seams({ os: "linux" })).bin("/sdk")).toEqual({ adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator" });
  });
});

describe("renderAvd", () => {
  test("720x1600 at 320 dpi, software GPU, image path relative to the SDK root", () => {
    const { ini, config } = renderAvd(avdSpecFor("x86_64"), "/h/avd");
    expect(ini).toContain(`path=${path.join("/h/avd", "trb.avd")}`);
    expect(ini).toContain("target=android-35");
    const lines = config.split("\n");
    for (const line of ["AvdId=trb", "abi.type=x86_64", "hw.lcd.width=720", "hw.lcd.height=1600", "hw.lcd.density=320", "hw.ramSize=2048", "hw.gpu.mode=swiftshader_indirect", "image.sysdir.1=system-images/android-35/google_apis/x86_64/", "tag.id=google_apis"]) expect(lines).toContain(line);
    expect(renderAvd(avdSpecFor("arm64-v8a"), "/h/avd").config).toContain("hw.cpu.arch=arm64");
  });
});

describe("unzip", () => {
  test("refuses an entry that would land outside the destination", async () => {
    const zip = path.join(dir, "evil.zip");
    fs.writeFileSync(zip, makeZip({ "../evil.txt": "x" }));
    await expect(unzip(zip, path.join(dir, "out"))).rejects.toThrow("outside");
    expect(fs.existsSync(path.join(dir, "evil.txt"))).toBe(false);
  });
});
