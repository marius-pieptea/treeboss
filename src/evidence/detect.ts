/**
 * What kind of target an investigation studies, worked out from the target alone: a URL, a bare domain, or a path on
 * this computer. Pure and synchronous. It reads at most a few KB of any one file, checks a fixed list of markers and
 * never recurses, so it is cheap to run when an investigation is created and again when its run starts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { TargetKind } from "./investigations";

export interface DetectedKind {
  kind: TargetKind;
  /** One line for the operator: which marker decided it. */
  reason: string;
}

/** The most of any one file detection reads: enough for an Info.plist's executable key and a package.json's dependencies. */
const READ_CAP = 8 * 1024;
const MAGIC_BYTES = 4;

const APK_EXTENSIONS = [".apk", ".aab", ".xapk"];
/** A name ending in one of these is a file, not a domain: app.apk, Acme.app, notes.md. */
const FILE_EXTENSIONS = new Set(["apk", "aab", "xapk", "asar", "wasm", "app", "jar", "zip", "dmg", "pkg", "exe", "dll", "so", "bin", "json", "plist", "txt", "md", "js", "ts", "html", "png", "jpg", "pdf"]);
const BARE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#:].*)?$/i;
const ELECTRON_DEPENDENCY = /"(?:dev|peer|optional)?[Dd]ependencies"\s*:\s*\{[^}]*"electron"\s*:/;
const MAC_EXECUTABLE_KEY = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/;
/** Files at the start of an Electron .app bundle, relative to Contents/. */
const ELECTRON_MARKERS = ["Resources/app.asar", "Resources/app", "Frameworks/Electron Framework.framework"];

export const isWebUrl = (target: string): boolean => /^https?:\/\//i.test(target.trim());

/** `~` or `~/…` as the home directory. Anything else is returned as given. */
export const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** A bare domain such as example.com or example.com/pricing: no scheme, no path prefix, and not a file name. */
function isBareDomain(target: string): boolean {
  if (/^(\/|~|\.|[A-Za-z]:[\\/])/.test(target) || /\s/.test(target) || !BARE_DOMAIN.test(target)) return false;
  const host = target.split(/[/?#:]/)[0]!;
  return !FILE_EXTENSIONS.has(host.split(".").pop()!.toLowerCase());
}

/** The first `n` bytes of a file, or fewer when it is shorter. Never more. */
function head(file: string, n: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The executable of a macOS app, as a path under Contents/MacOS: the one Info.plist names, else (when the key is past
 * the read cap, or the plist is binary) the binary named like the app, or the only file there. Null when neither is known.
 */
export function macExecutable(app: string): string | null {
  const macos = path.join(app, "Contents", "MacOS");
  const plist = path.join(app, "Contents", "Info.plist");
  const text = fs.existsSync(plist) ? head(plist, READ_CAP).toString("utf-8") : "";
  let name = text.startsWith("bplist00") ? undefined : text.match(MAC_EXECUTABLE_KEY)?.[1]?.trim();
  if (!name && fs.existsSync(macos)) {
    const files = fs.readdirSync(macos);
    const bundleName = path.basename(app, ".app");
    name = files.includes(bundleName) ? bundleName : files.length === 1 ? files[0] : undefined;
  }
  return name && !name.includes("/") ? path.join(macos, name) : null;
}

/** A macOS app bundle: Electron when its code is an Electron one, otherwise a native app. */
function macAppKind(app: string): DetectedKind {
  const marker = ELECTRON_MARKERS.find((m) => fs.existsSync(path.join(app, "Contents", m)));
  if (marker) return { kind: "electron", reason: `Electron app: Contents/${marker}` };
  const exe = macExecutable(app);
  return { kind: "binary", reason: exe ? `native macOS app; executable ${path.relative(app, exe)}` : "native macOS app" };
}

function folderKind(dir: string): DetectedKind {
  if (path.basename(dir).endsWith(".app") || fs.existsSync(path.join(dir, "Contents", "Info.plist"))) return macAppKind(dir);
  const pkg = path.join(dir, "package.json");
  if (fs.existsSync(pkg) && ELECTRON_DEPENDENCY.test(head(pkg, READ_CAP).toString("utf-8"))) return { kind: "electron", reason: "package.json depends on electron" };
  return { kind: "other", reason: "a folder; REA inspect_artifact will classify it" };
}

/** Decided by extension first, then by the magic number of the first four bytes. */
function fileKind(file: string): DetectedKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".asar") return { kind: "electron", reason: "asar archive: Electron app code" };
  if (APK_EXTENSIONS.includes(ext)) return { kind: "android", reason: `Android package (${ext})` };
  const magic = head(file, MAGIC_BYTES);
  const hex = magic.toString("hex");
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(hex)) return { kind: "binary", reason: "Mach-O binary" };
  if (hex === "cafebabe") return { kind: "binary", reason: "Mach-O universal or Java class" };
  if (hex === "7f454c46") return { kind: "binary", reason: "ELF executable or shared library" };
  if (magic.subarray(0, 2).toString("latin1") === "MZ") return { kind: "binary", reason: "Windows PE executable" };
  if (hex === "504b0304" && ext === ".jar") return { kind: "other", reason: "Java archive; REA inspect_artifact will classify it" };
  if (hex === "504b0304") return { kind: "other", reason: "zip archive; REA inspect_artifact will classify it" };
  if (hex === "0061736d") return { kind: "other", reason: "WebAssembly module (REA inspect_artifact reads it)" };
  return { kind: "other", reason: "REA inspect_artifact will classify it" };
}

/**
 * The kind of a target: a URL or bare domain is web; a path is an app, an APK, a binary or a folder by what is on
 * disk. A path that does not exist is `other` ("not found"): the run preflight refuses it with a clearer message.
 */
export function detectTargetKind(target: string): DetectedKind {
  const t = target.trim();
  if (!t) return { kind: "other", reason: "no target given" };
  if (isWebUrl(t)) return { kind: "web", reason: "http(s) URL" };
  const p = expandHome(t);
  if (!fs.existsSync(p)) {
    if (isBareDomain(t)) return { kind: "web", reason: "bare domain: read as a web address" };
    return { kind: "other", reason: "not found" };
  }
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory() ? folderKind(p) : fileKind(p);
  } catch {
    return { kind: "other", reason: "could not read it" };
  }
}
