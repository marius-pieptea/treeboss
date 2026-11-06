/**
 * What REA can and cannot do on this computer: its launcher, the native engine it needs for binaries (Ghidra, Hopper
 * or IDA) and the JDK that engine runs on, the APK tools (apktool, the jadx headless jar), adb, and firmware inspection
 * (Linux only in REA 6.4.0). Deep, it also runs REA's own `doctor`. Never "fail": REA is optional, so every gap is a
 * warning or an info line with the command that closes it.
 *
 * `reaEnv()` is what the REA server is started with: the absolute paths of what was found, for the variables REA reads
 * (GHIDRA_INSTALL_DIR, JAVA_HOME, REA_APKTOOL_COMMAND, REA_ADB_PATH, REA_JADX_MCP_JAR, REA_BINWALK_COMMAND on Linux).
 *
 * Shallow checks are filesystem and PATH lookups, cheap enough to run on each call. Deep also runs REA's own doctor,
 * which may download the pinned npm package, so only `trb doctor` and the Check button ask for it.
 * Reports are cached for ten minutes; `fresh` bypasses the cache. The env detection is cached for a minute.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { runCmd } from "../git/run";
import { REA_VERSION, prefixBin, reaLaunch, type ReaLaunch } from "./rea";

export type ReadinessLevel = "ok" | "warn" | "info";

export interface ReadinessCheck {
  id: string;
  level: ReadinessLevel;
  text: string;
  /** The command or setting that closes the gap. */
  fix?: string;
}

export interface ReadinessReport {
  checks: ReadinessCheck[];
  /** When the report was made (ISO). A cached report keeps its original time. */
  at: string;
  deep: boolean;
}

/** What the checks look at. Tests inject a fake one; the default reads this machine. */
export interface Probe {
  env: Record<string, string | undefined>;
  /** An absolute path for a command, from PATH or a Homebrew prefix's bin folder (a GUI app may not have Homebrew on PATH). */
  which: (bin: string) => string | null;
  /** The folder of macOS app bundles. */
  appsDir: string;
  /** Homebrew prefixes: their opt, Cellar and Caskroom folders hold the formulas and casks. */
  brewPrefixes: string[];
  /** Where the jadx jar lives under ~/.local/share/rea. */
  homeDir: string;
  platform: NodeJS.Platform;
  /** macOS's `java_home -v <range>` (`21` for exactly 21, `17+` for 17 or newer): the JDK home, or null. */
  javaHomeTool: (range: string) => string | null;
  /** The version apktool reports, or null. */
  apktoolVersion: (bin: string) => string | null;
}

/** Ghidra 12.1 runs on JDK 21; jadx needs 17. REA 6.4.0 audits: GhidraInstallationPolicy.js, JadxConfiguration.js. */
const GHIDRA_JDK = 21;
const JADX_JDK = 17;
/** REA 6.4.0 wants at least this apktool (apktool/ApktoolConfiguration.js). */
const APKTOOL_MIN = "2.7.0";
/** The jadx headless bridge REA 6.4.0 pins, from dist/android/JadxRelease.js. REA does not download it. */
const JADX = {
  version: "0.7.1",
  url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar",
  sha256: "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75",
};
const JADX_DIR = "$HOME/.local/share/rea/jadx/0.7.1";
const JADX_FIX = `mkdir -p "${JADX_DIR}" && curl -fL -o "${JADX_DIR}/jadx-headless-mcp-${JADX.version}-all.jar" ${JADX.url} && echo "${JADX.sha256}  ${JADX_DIR}/jadx-headless-mcp-${JADX.version}-all.jar" | shasum -a 256 -c -`;

const DEEP_TIMEOUT_MS = 90_000;
const CACHE_MS = 10 * 60 * 1000;
const ENV_CACHE_MS = 60 * 1000;
const MAX_OWN_LINES = 12;
const MAX_TEXT = 200;

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Versions of a Cellar or Caskroom folder, newest name first. */
const versionsIn = (dir: string): string[] => listDir(dir).sort().reverse();

/** The install folder, given a folder that is one (it holds support/analyzeHeadless) or holds one (the cask's ghidra_<ver>_PUBLIC). */
function ghidraIn(dir: string): string | null {
  const has = (d: string) => fs.existsSync(path.join(d, "support", "analyzeHeadless"));
  if (has(dir)) return dir;
  for (const e of listDir(dir)) {
    if (e.startsWith("ghidra_") && has(path.join(dir, e))) return path.join(dir, e);
  }
  return null;
}

/**
 * Where Ghidra is installed, or null: GHIDRA_INSTALL_DIR first, then the Homebrew formula (opt, then the Cellar), the
 * cask's Caskroom, and /Applications.
 */
export function findGhidra(probe: Probe): string | null {
  const fromEnv = probe.env.GHIDRA_INSTALL_DIR?.trim();
  if (fromEnv) {
    const dir = ghidraIn(fromEnv);
    if (dir) return dir;
  }
  for (const prefix of probe.brewPrefixes) {
    const formula = [path.join(prefix, "opt", "ghidra", "libexec"), ...versionsIn(path.join(prefix, "Cellar", "ghidra")).map((v) => path.join(prefix, "Cellar", "ghidra", v, "libexec"))];
    for (const dir of formula) {
      const found = ghidraIn(dir);
      if (found) return found;
    }
    const caskroom = path.join(prefix, "Caskroom", "ghidra");
    for (const version of versionsIn(caskroom)) {
      const dir = ghidraIn(path.join(caskroom, version));
      if (dir) return dir;
    }
  }
  for (const e of listDir(probe.appsDir)) {
    if (/^ghidra/i.test(e)) {
      const dir = ghidraIn(path.join(probe.appsDir, e));
      if (dir) return dir;
    }
  }
  return null;
}

/** A JDK's major version from its `release` file (JAVA_VERSION="21.0.1"; "1.8" is 8). 0 when it is not a JDK. */
export function javaMajor(home: string): number {
  try {
    const m = /JAVA_VERSION="([^"]+)"/.exec(fs.readFileSync(path.join(home, "release"), "utf-8"));
    if (!m) return 0;
    const [a = "0", b = "0"] = m[1]!.split(".");
    return Number(a) === 1 ? Number(b) : Number(a) || 0;
  } catch {
    return 0;
  }
}

/**
 * A JDK home at least `min` major, or null. The JDK of exactly `min` wins over a newer one: Ghidra's verified line runs on
 * 21 and REA admits other majors only by the bounds Ghidra publishes. Candidates: JAVA_HOME, macOS's java_home, then the
 * keg-only openjdk installs (Homebrew does not link them onto PATH, so /usr/bin/java stays the macOS stub).
 */
export function findJdk(probe: Probe, min: number): string | null {
  const candidates: string[] = [];
  if (probe.env.JAVA_HOME) candidates.push(probe.env.JAVA_HOME);
  const exact = probe.javaHomeTool(String(min));
  if (exact) candidates.push(exact);
  const contents = path.join("libexec", "openjdk.jdk", "Contents", "Home");
  for (const prefix of probe.brewPrefixes) {
    const opt = path.join(prefix, "opt");
    for (const e of listDir(opt).filter((x) => /^openjdk/.test(x)).sort().reverse()) candidates.push(path.join(opt, e, contents));
    const cellar = path.join(prefix, "Cellar");
    for (const e of listDir(cellar).filter((x) => /^openjdk/.test(x)).sort().reverse()) {
      for (const v of versionsIn(path.join(cellar, e))) candidates.push(path.join(cellar, e, v, contents));
    }
  }
  const newer = probe.javaHomeTool(`${min}+`);
  if (newer) candidates.push(newer);
  return candidates.find((home) => javaMajor(home) === min) ?? candidates.find((home) => javaMajor(home) >= min) ?? null;
}

/** The jadx headless jar: the pinned version under ~/.local/share/rea/jadx, else any other version found there. */
function jadxJar(probe: Probe): { path: string; pinned: boolean } | null {
  const root = path.join(probe.homeDir, ".local", "share", "rea", "jadx");
  const pinned = path.join(root, JADX.version, `jadx-headless-mcp-${JADX.version}-all.jar`);
  if (fs.existsSync(pinned)) return { path: pinned, pinned: true };
  for (const v of versionsIn(root)) {
    const jar = listDir(path.join(root, v)).find((f) => /^jadx-headless-mcp-.*-all\.jar$/.test(f));
    if (jar) return { path: path.join(root, v, jar), pinned: false };
  }
  return null;
}

/** The first dotted version in a tool's `--version` output. */
export function apktoolVersionOf(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  return /\d+\.\d+(?:\.\d+)?/.exec(`${r.stdout ?? ""}${r.stderr ?? ""}`)?.[0] ?? null;
}

/** Whether a dotted version is below a minimum (2.6.1 < 2.7.0). */
const olderThan = (v: string, min: string): boolean => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
};

function defaultJavaHome(range: string): string | null {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("/usr/libexec/java_home", ["-v", range], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function defaultProbe(): Probe {
  const brew = Bun.which("brew");
  const prefixes = [...new Set([brew ? path.dirname(path.dirname(brew)) : null, "/opt/homebrew", "/usr/local"].filter((p): p is string => Boolean(p) && fs.existsSync(p!)))];
  return {
    env: process.env,
    which: (bin) => Bun.which(bin) ?? prefixBin(bin, prefixes),
    appsDir: "/Applications",
    brewPrefixes: prefixes,
    homeDir: os.homedir(),
    platform: process.platform,
    javaHomeTool: defaultJavaHome,
    apktoolVersion: apktoolVersionOf,
  };
}

const appBundle = (probe: Probe, re: RegExp): boolean => listDir(probe.appsDir).some((e) => re.test(e));

interface Native {
  ghidra: string | null;
  hopper: boolean;
  ida: boolean;
}

function detectNative(probe: Probe): Native {
  return {
    ghidra: findGhidra(probe),
    hopper: Boolean(probe.which("hopper")) || appBundle(probe, /^Hopper Disassembler.*\.app$/),
    ida: Boolean(probe.which("idat64") || probe.which("ida64")) || appBundle(probe, /^IDA.*\.app$/),
  };
}

/**
 * Every env value REA needs that this machine can supply, as absolute paths. A key is absent when it was not found.
 * JAVA_HOME is the JDK Ghidra needs (21) when Ghidra is here, else the one jadx needs (17).
 */
export function detectEnv(probe: Probe): Record<string, string> {
  const out: Record<string, string> = {};
  const ghidra = findGhidra(probe);
  if (ghidra) out.GHIDRA_INSTALL_DIR = ghidra;
  const jdk = findJdk(probe, ghidra ? GHIDRA_JDK : JADX_JDK);
  if (jdk) out.JAVA_HOME = jdk;
  const apktool = probe.which("apktool");
  if (apktool) out.REA_APKTOOL_COMMAND = apktool;
  const adb = probe.which("adb");
  if (adb) out.REA_ADB_PATH = adb;
  const jar = jadxJar(probe);
  if (jar) out.REA_JADX_MCP_JAR = jar.path;
  const binwalk = probe.which("binwalk");
  if (binwalk && probe.platform === "linux") out.REA_BINWALK_COMMAND = binwalk;
  return out;
}

/**
 * The PATH REA's process needs: the given env's PATH with the directories that hold npx and node appended, when they are
 * not on it already. npx is a `#!/usr/bin/env node` script, so node must be found too. Null when nothing is missing.
 */
function pathWith(env: Record<string, string | undefined>, probe: Probe, launch: ReaLaunch | null): string | null {
  const onPath = new Set((env.PATH ?? "").split(":").filter(Boolean));
  const bins = [launch && launch.source !== "override" ? launch.command : null, probe.which("node")].filter((b): b is string => Boolean(b));
  const extra = [...new Set(bins.map((b) => path.dirname(b)))].filter((dir) => !onPath.has(dir));
  return extra.length ? [env.PATH ?? "/usr/bin:/bin", ...extra].join(":") : null;
}

/** REA's env for a probe: the detected values, minus any the operator already set in that env, and the PATH it needs. */
export function reaEnvFor(probe: Probe): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(Object.entries(detectEnv(probe)).filter(([key]) => !probe.env[key]));
  const PATH = pathWith(probe.env, probe, reaLaunch(probe.which, probe.brewPrefixes));
  if (PATH) out.PATH = PATH;
  return out;
}

let envSeen: { at: number; env: Record<string, string> } | null = null;

/** The env the REA server is started with, on this machine. Cached a minute; a value the operator set is left alone. */
export function reaEnv(): Record<string, string> {
  if (!envSeen || Date.now() - envSeen.at >= ENV_CACHE_MS) envSeen = { at: Date.now(), env: detectEnv(defaultProbe()) };
  const out: Record<string, string> = Object.fromEntries(Object.entries(envSeen.env).filter(([key]) => !process.env[key]));
  const probe = defaultProbe();
  const PATH = pathWith(process.env, probe, reaLaunch(probe.which, probe.brewPrefixes));
  if (PATH) out.PATH = PATH;
  return out;
}

const firstLine = (s: string | undefined): string => (s ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, MAX_TEXT) ?? "";

/** REA's doctor prints JSON, maybe after a line of npm noise. Undefined when no JSON can be read. */
function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const start = Math.max(0, t.search(/^[{[]/m));
  for (const candidate of [t, t.slice(start)]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return undefined;
}

const BAD = new Set(["fail", "failed", "failure", "error", "warn", "warning", "missing", "critical"]);

interface Failure {
  name: string;
  message: string;
  fix: string;
}

/** One object is a failure when its status, level or severity says so, or its ok or passed flag is false. Any other object is not. */
function asFailure(o: Record<string, unknown>): Failure | null {
  const word = (k: string) => (typeof o[k] === "string" ? (o[k] as string).toLowerCase() : null);
  const status = word("status") ?? word("level") ?? word("severity");
  const failed = status ? BAD.has(status) : o.ok === false || o.passed === false;
  if (!failed) return null;
  const pick = (keys: string[]) => keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim() ?? "";
  return { name: pick(["name", "id", "check", "title", "label"]) || "check", message: pick(["message", "detail", "details", "text", "summary", "reason"]), fix: pick(["remediation", "fix", "hint"]) };
}

/** Walk any JSON shape for arrays of objects that carry a failure: the shape is REA's, not ours, so look anywhere. */
function failures(v: unknown, out: Failure[] = [], depth = 0): Failure[] {
  if (!v || typeof v !== "object" || depth > 6) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const f = asFailure(item as Record<string, unknown>);
        if (f) out.push(f);
      }
    }
  }
  for (const child of Object.values(v)) failures(child, out, depth + 1);
  return out;
}

/** REA installs itself into other AI clients (`registration`, `registration:<client>`, `skill:identity`); trb hands REA to its own sessions, so those lines are not about trb. */
const notOurs = (f: Failure) => /^(registration|skill:)/.test(f.name);

/** REA's own doctor, run the way its MCP server is started but with `doctor --json` in place of `mcp`. Its failures come back as warnings prefixed "REA:". */
async function ownDoctor(launch: ReaLaunch, env: Record<string, string>): Promise<ReadinessCheck[]> {
  const args = launch.args[launch.args.length - 1] === "mcp" ? launch.args.slice(0, -1) : launch.args;
  const cannot = (why: string): ReadinessCheck => ({ id: "own", level: "info", text: `REA's own check could not run: ${why}` });
  let res;
  try {
    res = await runCmd(launch.command, [...args, "doctor", "--json"], { cwd: os.homedir(), timeoutMs: DEEP_TIMEOUT_MS, env });
  } catch (err: any) {
    return [cannot(firstLine(err?.message) || "it did not start")];
  }
  if (res.timedOut) return [cannot(`timed out after ${DEEP_TIMEOUT_MS / 1000} s`)];
  const data = parseJson(res.stdout.toString());
  if (data === undefined) return [cannot(firstLine(res.stderr.toString()) || `exit ${res.code}, no JSON on stdout`)];
  // REA repeats a finding under more than one name (a check list and its configuration list), so one line per message, the first seen.
  const byMessage = new Map<string, Failure>();
  for (const f of failures(data)) if (!notOurs(f) && !byMessage.has(f.message || f.name)) byMessage.set(f.message || f.name, f);
  const rows = [...byMessage.values()];
  if (rows.length === 0) return [{ id: "own", level: "ok", text: "REA's own check ran: no failing checks that affect trb" }];
  const shown = rows.slice(0, MAX_OWN_LINES);
  const out: ReadinessCheck[] = shown.map((f, i) => ({ id: `own:${i + 1}`, level: "warn", text: `REA: ${f.name}${f.message ? `: ${f.message}` : ""}`.slice(0, MAX_TEXT), fix: f.fix || undefined }));
  const more = rows.length - shown.length;
  if (more > 0) out.push({ id: "own:more", level: "info", text: `${more} more failing REA checks, not shown`, fix: `${[launch.command, ...args].join(" ")} doctor --json` });
  return out;
}

/** The checks against a probe. Deep also runs REA's own doctor. Never throws: a check that cannot run becomes an info line. */
export async function checkReadiness(probe: Probe, deep: boolean): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const launch = reaLaunch(probe.which, probe.brewPrefixes);
  if (launch) {
    // Found in a Homebrew prefix while the daemon's PATH lacks it: say so, since the REA server is then started with that PATH extended.
    const off = launch.source !== "override" && !(probe.env.PATH ?? "").split(":").includes(path.dirname(launch.command));
    const text = launch.source === "npx" ? `REA starts through npx (rea-agents@${REA_VERSION})${off ? ` via ${launch.command} (not on the daemon's PATH)` : ""}`
      : launch.source === "cached" ? `REA starts from the cached rea-agents@${REA_VERSION} through ${launch.command}${off ? " (not on the daemon's PATH)" : ""}`
      : `REA starts with rea_command: ${[launch.command, ...launch.args].join(" ")}`;
    checks.push({ id: "launcher", level: "ok", text });
  }
  else checks.push({ id: "launcher", level: "warn", text: "REA cannot start: npx not found", fix: "Install Node (brew install node) or set rea_command" });

  const native = detectNative(probe);
  const found = [native.ghidra ? `Ghidra at ${native.ghidra}` : null, native.hopper ? "Hopper" : null, native.ida ? "IDA" : null].filter((s): s is string => Boolean(s));
  if (found.length) checks.push({ id: "native", level: "ok", text: `Native engine found: ${found.join(", ")}` });
  else checks.push({ id: "native", level: "warn", text: "No native engine (Ghidra, Hopper or IDA): binaries and native apps get only strings, symbols and structure, no decompilation", fix: "brew install ghidra" });
  if (native.hopper) checks.push({ id: "hopper", level: "info", text: "Hopper (demo) needs one manual first launch: open Hopper Disassembler and choose the demo mode, or REA's first Hopper call fails" });

  const need = native.ghidra ? GHIDRA_JDK : JADX_JDK;
  const jdk = findJdk(probe, need);
  const envJava = probe.env.JAVA_HOME;
  if (envJava && javaMajor(envJava) < need) checks.push({ id: "java", level: "warn", text: `JAVA_HOME is set to ${envJava}, which is not a JDK ${need}+ ${native.ghidra ? "(Ghidra needs it)" : "(jadx needs it)"}`, fix: jdk ? `export JAVA_HOME="${jdk}"` : "brew install openjdk@21" });
  else if (jdk) checks.push({ id: "java", level: "ok", text: `JDK ${need}+ found at ${jdk}` });
  else checks.push({ id: "java", level: "warn", text: `No JDK ${need}+ found: REA needs JAVA_HOME set to one${native.ghidra ? " (Ghidra requires 21)" : ""}`, fix: "brew install openjdk@21" });

  const apktool = probe.which("apktool");
  if (!apktool) checks.push({ id: "android", level: "warn", text: `apktool missing: REA's APK analysis needs it (${APKTOOL_MIN} or newer)`, fix: "brew install apktool" });
  else {
    const v = probe.apktoolVersion(apktool);
    if (v && olderThan(v, APKTOOL_MIN)) checks.push({ id: "android", level: "warn", text: `apktool ${v} is older than REA's ${APKTOOL_MIN} minimum`, fix: "brew upgrade apktool" });
    else checks.push({ id: "android", level: "ok", text: `apktool${v ? ` ${v}` : ""} found` });
  }

  const jar = jadxJar(probe);
  if (!jar) checks.push({ id: "jadx", level: "warn", text: `jadx-headless-mcp ${JADX.version} missing: REA's APK analysis needs it (REA_JADX_MCP_JAR), REA does not install it`, fix: JADX_FIX });
  else if (!jar.pinned) checks.push({ id: "jadx", level: "warn", text: `jadx-headless-mcp found at ${jar.path}, but REA 6.4.0 pins ${JADX.version}`, fix: JADX_FIX });
  else checks.push({ id: "jadx", level: "ok", text: `jadx-headless-mcp ${JADX.version} found` });

  if (probe.which("adb")) checks.push({ id: "adb", level: "ok", text: "adb found" });
  else checks.push({ id: "adb", level: "info", text: "adb not found: only needed for a connected device", fix: "brew install --cask android-platform-tools" });

  if (probe.platform !== "linux") checks.push({ id: "firmware", level: "info", text: "Firmware inspection is Linux-only in REA 6.4.0" });
  else if (probe.which("binwalk")) checks.push({ id: "binwalk", level: "ok", text: "binwalk found" });
  else checks.push({ id: "binwalk", level: "info", text: "binwalk not found: firmware inspection needs it", fix: "brew install binwalk" });

  if (deep && launch) checks.push(...(await ownDoctor(launch, reaEnvFor(probe))));
  return { checks, at: new Date().toISOString(), deep };
}

const cache = new Map<"shallow" | "deep", { at: number; report: Promise<ReadinessReport> }>();

/** The readiness of REA on this machine, cached in memory for ten minutes. `fresh` bypasses both caches; `deep` runs REA's own doctor. */
export function reaReadiness(opts: { fresh?: boolean; deep?: boolean } = {}): Promise<ReadinessReport> {
  const key = opts.deep ? "deep" : "shallow";
  const hit = cache.get(key);
  if (opts.fresh) envSeen = null;
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.report;
  const report = checkReadiness(defaultProbe(), Boolean(opts.deep));
  cache.set(key, { at: Date.now(), report });
  return report;
}
