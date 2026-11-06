import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START rea-readiness\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END rea-readiness\n"); });
/** REA's readiness: what the machine can and cannot do for REA, the env REA is started with, its deep doctor, the routes, and trb doctor's rea lines. Nothing here depends on what is installed. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { runDoctor } from "../src/doctor";
import { checkReadiness, detectEnv, findGhidra, findJdk, reaEnv, reaEnvFor, reaReadiness, type Probe, type ReadinessCheck } from "../src/evidence/readiness";
import { reaLaunch } from "../src/evidence/rea";
import { resetSetting, setSetting } from "../src/settings";
import { makeDir, resetState } from "./helpers";

const TOKEN = "rea-readiness";
let srv: ReturnType<typeof startServer>;
const realGhidraEnv = process.env.GHIDRA_INSTALL_DIR;
const realJavaEnv = process.env.JAVA_HOME;
const realPath = process.env.PATH;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => {
  srv.stop();
});
beforeEach(() => {
  resetState();
});
afterEach(() => {
  if (realGhidraEnv === undefined) delete process.env.GHIDRA_INSTALL_DIR;
  else process.env.GHIDRA_INSTALL_DIR = realGhidraEnv;
  if (realJavaEnv === undefined) delete process.env.JAVA_HOME;
  else process.env.JAVA_HOME = realJavaEnv;
  process.env.PATH = realPath;
});

/** An executable file in a temp dir. */
function exe(dir: string, name: string, body = "exit 0"): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A Ghidra install folder at `dir`: support/analyzeHeadless is what makes it one. */
function ghidraAt(dir: string): string {
  fs.mkdirSync(path.join(dir, "support"), { recursive: true });
  fs.writeFileSync(path.join(dir, "support", "analyzeHeadless"), "");
  return dir;
}

/** A JDK home at `dir` with its `release` file, as a JDK ships. */
function jdkAt(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "release"), `IMPLEMENTOR="Homebrew"\nJAVA_VERSION="${version}"\n`);
  return dir;
}

/** The keg-only openjdk home under a Homebrew prefix, as `opt/openjdk@<v>` points at it. */
const kegJdk = (prefix: string, formula: string) => path.join(prefix, "opt", formula, "libexec", "openjdk.jdk", "Contents", "Home");

/** The jadx jar REA 6.4.0 pins, under the given home. */
function pinnedJar(home: string, version = "0.7.1"): string {
  const dir = path.join(home, ".local", "share", "rea", "jadx", version);
  fs.mkdirSync(dir, { recursive: true });
  const jar = path.join(dir, `jadx-headless-mcp-${version}-all.jar`);
  fs.writeFileSync(jar, "");
  return jar;
}

/** A probe: a PATH holding only the given commands (apktool is a fake that reports `apktoolVersion`), and empty Homebrew, apps and home folders unless given. The probe's env PATH is that folder unless `env` sets one. */
function probe(opts: { bins?: string[]; apktoolVersion?: string; env?: Record<string, string | undefined>; appsDir?: string; brewPrefixes?: string[]; homeDir?: string; platform?: NodeJS.Platform; javaHome?: string | null } = {}): Probe {
  const bin = makeDir();
  for (const b of opts.bins ?? []) exe(bin, b, b === "apktool" ? `echo ${opts.apktoolVersion ?? "2.9.3"}` : "exit 0");
  return {
    env: { PATH: bin, ...opts.env },
    which: (name) => Bun.which(name, { PATH: bin }),
    appsDir: opts.appsDir ?? makeDir(),
    brewPrefixes: opts.brewPrefixes ?? [],
    homeDir: opts.homeDir ?? makeDir(),
    platform: opts.platform ?? "darwin",
    javaHomeTool: () => opts.javaHome ?? null,
    apktoolVersion: (bin) => {
      const r = Bun.spawnSync([bin, "--version"]);
      return /\d+\.\d+(?:\.\d+)?/.exec(r.stdout.toString())?.[0] ?? null;
    },
  };
}

const byId = (checks: ReadinessCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

/** A fake REA doctor: prints the given body as its output, whatever it is asked. */
const reaScript = (body: string) => exe(makeDir(), "fake-rea", body);

// The same JDK finding comes twice under two names, a registration finding is about another client, and the ghidra finding carries REA's remediation.
const DOCTOR_JSON = `{"checks":[{"name":"ghidra","status":"fail","message":"analyzeHeadless not on PATH","remediation":"Install Ghidra 12.1"},{"name":"node","status":"pass"},{"id":"jdk","level":"warning","detail":"JDK 11"},{"name":"registration","ok":false,"detail":"IDA MCP registration is not configured."}],"configuration":[{"name":"configuration","ok":false,"detail":"JDK 11"}],"summary":{"fail":1}}`;
const doctorScript = () => reaScript(`echo "npm notice fetching rea-agents"\necho '${DOCTOR_JSON}'`);

describe("shallow readiness", () => {
  test("a full macOS setup: Ghidra formula, JDK 21, apktool, the jadx jar and adb are ok; firmware is a Linux-only info line", async () => {
    const prefix = makeDir();
    ghidraAt(path.join(prefix, "opt", "ghidra", "libexec"));
    const jdk = jdkAt(kegJdk(prefix, "openjdk@21"), "21.0.12");
    const home = makeDir();
    pinnedJar(home);
    const p = probe({ bins: ["npx", "apktool", "adb"], brewPrefixes: [prefix], homeDir: home });
    const r = await checkReadiness(p, false);
    const c = byId(r.checks);
    expect(r.deep).toBe(false);
    expect(c.launcher).toMatchObject({ level: "ok" });
    expect(c.native).toMatchObject({ level: "ok" });
    expect(c.native.text).toContain(path.join(prefix, "opt", "ghidra", "libexec"));
    expect(c.java).toEqual({ id: "java", level: "ok", text: `JDK 21+ found at ${jdk}` });
    expect(c.android).toEqual({ id: "android", level: "ok", text: "apktool 2.9.3 found" });
    expect(c.jadx).toEqual({ id: "jadx", level: "ok", text: "jadx-headless-mcp 0.7.1 found" });
    expect(c.adb).toEqual({ id: "adb", level: "ok", text: "adb found" });
    expect(c.firmware).toEqual({ id: "firmware", level: "info", text: "Firmware inspection is Linux-only in REA 6.4.0" });
    expect(c.binwalk).toBeUndefined();
    expect(r.checks.some((x) => x.level === "warn")).toBe(false);
  });

  test("an empty machine: every gap is a warning or info with its fix, and the jadx fix is the pinned download with its checksum", async () => {
    const c = byId((await checkReadiness(probe(), false)).checks);
    expect(c.launcher).toMatchObject({ level: "warn", fix: "Install Node (brew install node) or set rea_command" });
    expect(c.native).toMatchObject({
      level: "warn",
      text: "No native engine (Ghidra, Hopper or IDA): binaries and native apps get only strings, symbols and structure, no decompilation",
      fix: "brew install ghidra",
    });
    expect(c.java).toMatchObject({ level: "warn", text: "No JDK 17+ found: REA needs JAVA_HOME set to one", fix: "brew install openjdk@21" });
    expect(c.android).toMatchObject({ level: "warn", fix: "brew install apktool" });
    expect(c.android.text).toContain("apktool missing");
    expect(c.jadx).toMatchObject({ level: "warn" });
    expect(c.jadx.fix).toContain("https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar");
    expect(c.jadx.fix).toContain("6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75");
    expect(c.adb).toMatchObject({ level: "info", text: "adb not found: only needed for a connected device", fix: "brew install --cask android-platform-tools" });
    expect(c.firmware).toMatchObject({ level: "info" });
    expect(new Set(Object.values(c).map((x) => x.level))).toEqual(new Set(["warn", "info"]));
  });

  test("Ghidra from the Cellar with only JDK 17: the JDK warns that Ghidra needs 21", async () => {
    const prefix = makeDir();
    ghidraAt(path.join(prefix, "Cellar", "ghidra", "12.1.4", "libexec"));
    jdkAt(kegJdk(prefix, "openjdk@17"), "17.0.9");
    const c = byId((await checkReadiness(probe({ brewPrefixes: [prefix] }), false)).checks);
    expect(c.native.text).toContain(path.join(prefix, "Cellar", "ghidra", "12.1.4", "libexec"));
    expect(c.java).toMatchObject({ level: "warn", text: "No JDK 21+ found: REA needs JAVA_HOME set to one (Ghidra requires 21)", fix: "brew install openjdk@21" });
  });

  test("JAVA_HOME set to a JDK that is too old warns and suggests the JDK 21 that is installed", async () => {
    const prefix = makeDir();
    ghidraAt(path.join(prefix, "opt", "ghidra", "libexec"));
    const jdk21 = jdkAt(kegJdk(prefix, "openjdk@21"), "21.0.1");
    const jdk17 = jdkAt(path.join(makeDir(), "jdk17"), "17.0.9");
    const c = byId((await checkReadiness(probe({ brewPrefixes: [prefix], env: { JAVA_HOME: jdk17 } }), false)).checks);
    expect(c.java).toMatchObject({ level: "warn", fix: `export JAVA_HOME="${jdk21}"` });
    expect(c.java.text).toContain(jdk17);
  });

  test("an apktool older than 2.7.0 warns, and a jadx jar of another version is named", async () => {
    const home = makeDir();
    pinnedJar(home, "0.7.0");
    const c = byId((await checkReadiness(probe({ bins: ["apktool"], apktoolVersion: "2.6.1", homeDir: home }), false)).checks);
    expect(c.android).toMatchObject({ level: "warn", text: "apktool 2.6.1 is older than REA's 2.7.0 minimum", fix: "brew upgrade apktool" });
    expect(c.jadx.level).toBe("warn");
    expect(c.jadx.text).toContain("pins 0.7.1");
  });

  test("Linux: binwalk is checked, not the macOS firmware line", async () => {
    const c = byId((await checkReadiness(probe({ bins: ["binwalk"], platform: "linux" }), false)).checks);
    expect(c.binwalk).toEqual({ id: "binwalk", level: "ok", text: "binwalk found" });
    expect(c.firmware).toBeUndefined();
    const missing = byId((await checkReadiness(probe({ platform: "linux" }), false)).checks);
    expect(missing.binwalk).toMatchObject({ level: "info", fix: "brew install binwalk" });
  });

  test("Hopper gets the one-time demo note, and IDA is found from its bundle", async () => {
    const apps = makeDir();
    fs.mkdirSync(path.join(apps, "Hopper Disassembler v5.app"));
    fs.mkdirSync(path.join(apps, "IDA Free.app"));
    const r = await checkReadiness(probe({ appsDir: apps }), false);
    const c = byId(r.checks);
    expect(c.native.text).toContain("Hopper");
    expect(c.native.text).toContain("IDA");
    expect(c.hopper).toEqual({
      id: "hopper",
      level: "info",
      text: "Hopper (demo) needs one manual first launch: open Hopper Disassembler and choose the demo mode, or REA's first Hopper call fails",
    });
  });
});

describe("npx outside the daemon's PATH", () => {
  test("reaLaunch uses npx from a Homebrew prefix when PATH has none, and none when there is no prefix either", () => {
    const prefix = makeDir();
    const npx = exe(path.join(prefix, "bin"), "npx");
    expect(reaLaunch(() => null, [prefix])).toEqual({ command: npx, args: ["-y", "rea-agents@6.4.0", "mcp"], source: "npx" });
    expect(reaLaunch(() => null, [])).toBeNull();
    expect(reaLaunch(() => "/usr/bin/npx", [prefix])?.command).toBe("/usr/bin/npx");
  });

  test("the launcher check says where npx was found when the daemon's PATH lacks it", async () => {
    const prefix = makeDir();
    const npx = exe(path.join(prefix, "bin"), "npx");
    const c = byId((await checkReadiness(probe({ brewPrefixes: [prefix] }), false)).checks);
    expect(c.launcher).toEqual({ id: "launcher", level: "ok", text: `REA starts through npx (rea-agents@6.4.0) via ${npx} (not on the daemon's PATH)` });
    const onPath = byId((await checkReadiness(probe({ bins: ["npx"] }), false)).checks);
    expect(onPath.launcher.text).toBe("REA starts through npx (rea-agents@6.4.0)");
  });

  test("the REA env appends the npx and node folders to PATH when missing, keeping the PATH it has", () => {
    const prefix = makeDir();
    const npxDir = path.dirname(exe(path.join(prefix, "bin"), "npx"));
    expect(reaEnvFor(probe({ brewPrefixes: [prefix], env: { PATH: "/usr/bin:/bin" } })).PATH).toBe(`/usr/bin:/bin:${npxDir}`);
    // Already on PATH: nothing to add, so no PATH key at all.
    expect(reaEnvFor(probe({ brewPrefixes: [prefix], env: { PATH: `/usr/bin:/bin:${npxDir}` } }))).not.toHaveProperty("PATH");
    // node alone, found on the probe's PATH but not on the daemon's.
    const p = probe({ bins: ["node"], env: { PATH: "/usr/bin:/bin" } });
    expect(reaEnvFor(p).PATH).toBe(`/usr/bin:/bin:${path.dirname(p.which("node")!)}`);
  });

  test("reaEnv keeps the process PATH and only adds to it", () => {
    process.env.PATH = "/usr/bin:/bin";
    const env = reaEnv();
    if (env.PATH !== undefined) expect(env.PATH.startsWith("/usr/bin:/bin:")).toBe(true);
    expect(Object.keys(env).filter((k) => k === "PATH")).toHaveLength(env.PATH === undefined ? 0 : 1);
  });
});

describe("the env REA is started with", () => {
  test("detectEnv gives absolute paths for everything found, on macOS without the Linux-only binwalk", () => {
    const prefix = makeDir();
    const ghidra = ghidraAt(path.join(prefix, "opt", "ghidra", "libexec"));
    const jdk = jdkAt(kegJdk(prefix, "openjdk@21"), "21.0.12");
    const home = makeDir();
    const jar = pinnedJar(home);
    const p = probe({ bins: ["apktool", "adb", "binwalk"], brewPrefixes: [prefix], homeDir: home });
    const env = detectEnv(p);
    expect(env).toEqual({
      GHIDRA_INSTALL_DIR: ghidra,
      JAVA_HOME: jdk,
      REA_APKTOOL_COMMAND: p.which("apktool")!,
      REA_ADB_PATH: p.which("adb")!,
      REA_JADX_MCP_JAR: jar,
    });
    for (const v of Object.values(env)) expect(path.isAbsolute(v)).toBe(true);
  });

  test("on Linux, detectEnv also gives REA_BINWALK_COMMAND", () => {
    const p = probe({ bins: ["binwalk"], platform: "linux" });
    expect(detectEnv(p).REA_BINWALK_COMMAND).toBe(p.which("binwalk")!);
  });

  test("reaEnvFor leaves out what the operator already set, and nothing is passed for a machine with nothing", () => {
    const prefix = makeDir();
    ghidraAt(path.join(prefix, "opt", "ghidra", "libexec"));
    jdkAt(kegJdk(prefix, "openjdk@21"), "21.0.12");
    const env = reaEnvFor(probe({ brewPrefixes: [prefix], env: { JAVA_HOME: "/already/set" } }));
    expect(env).not.toHaveProperty("JAVA_HOME");
    expect(env.GHIDRA_INSTALL_DIR).toBe(path.join(prefix, "opt", "ghidra", "libexec"));
    expect(reaEnvFor(probe())).toEqual({});
  });

  test("Ghidra is found in the Homebrew formula, the Cellar, the cask and /Applications, in that order", () => {
    const prefix = makeDir();
    const cask = makeDir();
    const apps = makeDir();
    ghidraAt(path.join(prefix, "Cellar", "ghidra", "12.1.4", "libexec"));
    expect(findGhidra(probe({ brewPrefixes: [prefix] }))).toBe(path.join(prefix, "Cellar", "ghidra", "12.1.4", "libexec"));
    ghidraAt(path.join(prefix, "opt", "ghidra", "libexec"));
    expect(findGhidra(probe({ brewPrefixes: [prefix] }))).toBe(path.join(prefix, "opt", "ghidra", "libexec"));
    expect(findGhidra(probe({ brewPrefixes: [cask] }))).toBeNull();
    ghidraAt(path.join(cask, "Caskroom", "ghidra", "11.2", "ghidra_11.2_PUBLIC"));
    expect(findGhidra(probe({ brewPrefixes: [cask] }))).toBe(path.join(cask, "Caskroom", "ghidra", "11.2", "ghidra_11.2_PUBLIC"));
    ghidraAt(path.join(apps, "ghidra_11.0_PUBLIC"));
    expect(findGhidra(probe({ appsDir: apps }))).toBe(path.join(apps, "ghidra_11.0_PUBLIC"));
  });

  test("findJdk reads the release file: 21 satisfies 21, 17 does not", () => {
    const prefix = makeDir();
    jdkAt(kegJdk(prefix, "openjdk@17"), "17.0.9");
    expect(findJdk(probe({ brewPrefixes: [prefix] }), 21)).toBeNull();
    expect(findJdk(probe({ brewPrefixes: [prefix] }), 17)).toBe(kegJdk(prefix, "openjdk@17"));
  });

  test("findJdk prefers the JDK of exactly the major Ghidra needs over a newer one", () => {
    const prefix = makeDir();
    const jdk21 = jdkAt(kegJdk(prefix, "openjdk@21"), "21.0.12");
    jdkAt(kegJdk(prefix, "openjdk@27"), "27.0.1");
    expect(findJdk(probe({ brewPrefixes: [prefix] }), 21)).toBe(jdk21);
  });

  test("reaEnv leaves an operator-set GHIDRA_INSTALL_DIR alone and returns only absolute values", () => {
    process.env.GHIDRA_INSTALL_DIR = ghidraAt(makeDir());
    const env = reaEnv();
    expect(env).not.toHaveProperty("GHIDRA_INSTALL_DIR");
    for (const v of Object.values(env)) expect(path.isAbsolute(v)).toBe(true);
  });
});

describe("deep readiness: REA's own doctor", () => {
  test("its failures become warnings prefixed REA:, with REA's remediation as the fix; passes and duplicates are dropped", async () => {
    setSetting("rea_command", doctorScript());
    const r = await checkReadiness(probe(), true);
    expect(r.deep).toBe(true);
    const texts = r.checks.map((c) => c.text);
    expect(texts).toContain("REA: ghidra: analyzeHeadless not on PATH");
    expect(byId(r.checks)["own:1"]).toEqual({ id: "own:1", level: "warn", text: "REA: ghidra: analyzeHeadless not on PATH", fix: "Install Ghidra 12.1" });
    expect(texts.filter((t) => t.includes("JDK 11"))).toEqual(["REA: jdk: JDK 11"]);
    expect(texts.some((t) => t.includes("node") || t.includes("registration"))).toBe(false);
    const own = r.checks.filter((c) => c.id.startsWith("own:"));
    expect(own.every((c) => c.level === "warn")).toBe(true);
    // The override replaces the npx launcher, so the launcher line names the script.
    expect(byId(r.checks).launcher.text).toContain("rea_command");
  });

  test("when the doctor cannot run, one info line says why", async () => {
    setSetting("rea_command", reaScript("echo boom >&2\nexit 2"));
    const own = (await checkReadiness(probe(), true)).checks.filter((c) => c.id === "own");
    expect(own).toEqual([{ id: "own", level: "info", text: "REA's own check could not run: boom" }]);

    setSetting("rea_command", "/nonexistent/rea-fake-for-tests");
    const missing = (await checkReadiness(probe(), true)).checks.filter((c) => c.id === "own");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.level).toBe("info");
    expect(missing[0]!.text.startsWith("REA's own check could not run: ")).toBe(true);
  });

  test("the report is cached for ten minutes; fresh bypasses the cache", async () => {
    const first = await reaReadiness();
    expect(await reaReadiness()).toBe(first);
    expect(await reaReadiness({ fresh: true })).not.toBe(first);
  });
});

describe("GET /api/rea/readiness and the Engines doctor", () => {
  const call = async (method: string, p: string) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("returns { enabled, report }, running the deep check when asked", async () => {
    setSetting("rea_command", doctorScript());
    const r = await call("GET", "/api/rea/readiness?deep=1&fresh=1");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.report.deep).toBe(true);
    expect(r.body.report.checks.map((c: ReadinessCheck) => c.text)).toContain("REA: ghidra: analyzeHeadless not on PATH");
  });

  test("with rea_mcp off it says so and does not run REA's doctor", async () => {
    setSetting("rea_command", doctorScript());
    setSetting("rea_mcp", "off");
    const r = await call("GET", "/api/rea/readiness?deep=1&fresh=1");
    expect(r.body.enabled).toBe(false);
    expect(r.body.report.deep).toBe(false);
    expect(r.body.report.checks.some((c: ReadinessCheck) => c.text.startsWith("REA:"))).toBe(false);
    resetSetting("rea_mcp");
  });

  test("other methods are refused", async () => {
    expect((await call("POST", "/api/rea/readiness")).status).toBe(405);
  });

  test("the Engines page's doctor (GET /api/doctor) never runs REA's own doctor; the readiness route does", async () => {
    const marker = path.join(makeDir(), "ran");
    setSetting("rea_command", reaScript(`touch "${marker}"\necho '{}'`));
    const doctor = await call("GET", "/api/doctor");
    expect(doctor.status).toBe(200);
    expect(doctor.body.checks.some((c: { id: string }) => c.id.startsWith("rea:own"))).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    await call("GET", "/api/rea/readiness?deep=1&fresh=1");
    expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);
});

describe("trb doctor", () => {
  test("includes rea:* lines, never a fail, and keeps the launcher line only once", async () => {
    setSetting("rea_command", doctorScript());
    // The doctor reads the cached deep report; refresh it so it sees this rea_command.
    await reaReadiness({ deep: true, fresh: true });
    const report = await runDoctor(null);
    const rea = report.checks.filter((c) => c.id.startsWith("rea"));
    expect(rea.some((c) => c.id === "rea" && c.level === "ok")).toBe(true);
    expect(rea.map((c) => c.id)).not.toContain("rea:launcher");
    expect(rea.some((c) => c.id.startsWith("rea:") && c.level === "warn" && c.text.includes("REA: ghidra: analyzeHeadless not on PATH. Fix: Install Ghidra 12.1"))).toBe(true);
    expect(rea.some((c) => c.id.startsWith("rea:") && c.level === "fail")).toBe(false);
    expect(report.checks.some((c) => c.level === "fail" && c.id.startsWith("rea"))).toBe(false);
  }, 30_000);
});
