import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { detectMobile } from "../src/mobile/detect";
import { buildArgs, checkBranch, checkEasId, checkName, checkPlatform, easArgv, MobileError, parseBuilds, parseJson, publishUpdate, requireToken, runEas, startBuild, submitArgs, submitLatest, updateArgs, viewBuild, listArgs, type Runner, type RunResult } from "../src/mobile/eas";
import { expoGoUrl, findPreviewUrl, stopExpoPreview } from "../src/mobile/preview";
import { checkStoreMetadata, inFlightBuilds, listBuilds, readStoreMetadata, recordBuilds, refreshInFlightBuilds, updateBuild } from "../src/mobile/store";
import { detectVerifyCommands } from "../src/verify/detect";
import { mobileRoutes } from "../src/daemon/routes/mobile";
import { makeCtx } from "../src/daemon/http";
import { Workspaces } from "../src/workspaces";
import { makeDir, resetState } from "./helpers";

/** A directory with the given files (paths relative to it, values are text). */
function project(files: Record<string, string>): string {
  const dir = makeDir();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const EXPO_PACKAGE = JSON.stringify({ name: "shop", dependencies: { expo: "~54.0.0", react: "19.1.0" } });
const APP_JSON = JSON.stringify({
  expo: { name: "Shop", slug: "shop", ios: { bundleIdentifier: "com.example.shop" }, android: { package: "com.example.shop.android" } },
});
const EAS_JSON = JSON.stringify({ build: { development: { developmentClient: true }, preview: {}, production: {} }, submit: { production: {} } });

/** A runner that records each call and answers with the given stdout. */
function recorder(stdout = "[]", code = 0, stderr = "") {
  const calls: Array<{ argv: string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const runner: Runner = async (argv, opts) => {
    calls.push({ argv, env: opts.env, timeoutMs: opts.timeoutMs });
    return { code, stdout, stderr } satisfies RunResult;
  };
  return { calls, runner };
}

const WITH_TOKEN = () => ({ EXPO_TOKEN: "expo-test-token" });

const savedToken = process.env.EXPO_TOKEN;
beforeEach(() => {
  resetState();
  delete process.env.EXPO_TOKEN;
  // The poller sees every in-flight build in the database, so each test starts with none. Reading first creates the tables.
  listBuilds("w_none");
  db().exec("DELETE FROM mobile_builds; DELETE FROM mobile_submissions");
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.EXPO_TOKEN;
  else process.env.EXPO_TOKEN = savedToken;
});

describe("detect", () => {
  test("reads an Expo app: platforms, identifiers, sdk and eas profiles", () => {
    const dir = project({ "package.json": EXPO_PACKAGE, "app.json": APP_JSON, "eas.json": EAS_JSON });
    const d = detectMobile(dir);
    expect(d.isExpo).toBe(true);
    expect(d.name).toBe("Shop");
    expect(d.slug).toBe("shop");
    expect(d.sdkVersion).toBe("~54.0.0");
    expect(d.configFile).toBe("app.json");
    expect(d.platforms).toEqual(["ios", "android"]);
    expect(d.bundleId).toBe("com.example.shop");
    expect(d.androidPackage).toBe("com.example.shop.android");
    expect(d.profiles).toEqual(["development", "preview", "production"]);
    expect(d.submitProfiles).toEqual(["production"]);
    expect(d.notes).toEqual([]);
  });

  test("a plain React Native project with no Expo marks is not an Expo app", () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: { "react-native": "0.80.0" } }), "app.json": JSON.stringify({ name: "Plain" }) });
    const d = detectMobile(dir);
    expect(d.isExpo).toBe(false);
    expect(d.platforms).toEqual([]);
  });

  test("eas.json alone makes it an Expo project", () => {
    const dir = project({ "eas.json": EAS_JSON });
    expect(detectMobile(dir).isExpo).toBe(true);
    expect(detectMobile(dir).profiles).toEqual(["development", "preview", "production"]);
  });

  test("a dynamic app.config.ts is read as text and says so", () => {
    const dir = project({
      "package.json": EXPO_PACKAGE,
      "app.config.ts": "export default ({ config }) => ({ ...config, ios: { bundleIdentifier: 'com.example.dyn' }, android: { package: 'com.example.dyn' } });",
    });
    const d = detectMobile(dir);
    expect(d.configFile).toBe("app.config.ts");
    expect(d.bundleId).toBe("com.example.dyn");
    expect(d.androidPackage).toBe("com.example.dyn");
    expect(d.notes.join(" ")).toContain("read as text, not run");
  });

  test("a broken app.json is reported, not thrown", () => {
    const dir = project({ "package.json": EXPO_PACKAGE, "app.json": "{ nope" });
    const d = detectMobile(dir);
    expect(d.isExpo).toBe(true);
    expect(d.notes).toContain("app.json is not valid JSON.");
  });
});

describe("eas argv", () => {
  test("build, list, submit and update are argv arrays with the flags the brief names", () => {
    expect(buildArgs("all", "production")).toEqual(["build", "--platform", "all", "--profile", "production", "--non-interactive", "--json", "--no-wait"]);
    expect(listArgs(5)).toEqual(["build:list", "--limit", "5", "--json", "--non-interactive"]);
    expect(submitArgs("ios", "production")).toEqual(["submit", "--platform", "ios", "--profile", "production", "--latest", "--non-interactive"]);
    expect(updateArgs("production", "fix login")).toEqual(["update", "--branch", "production", "--message", "fix login", "--non-interactive"]);
  });

  test("easArgv runs eas or npx eas-cli, never a shell", () => {
    const argv = easArgv(["build:view", "x"]);
    expect(argv.slice(-2)).toEqual(["build:view", "x"]);
    expect(argv.some((a) => a === "sh" || a === "cmd" || a === "/bin/sh")).toBe(false);
    expect(argv.some((a) => /(^|[\\/])eas(-cli)?(\.cmd)?$/.test(a))).toBe(true);
  });

  test("input is checked before it reaches argv", () => {
    expect(() => checkPlatform("all", false)).toThrow(MobileError);
    expect(checkPlatform("all", true)).toBe("all");
    expect(() => checkName("--evil", "profile")).toThrow(/must not start with a dash/);
    expect(() => checkBranch("main; rm -rf /")).toThrow(MobileError);
    expect(checkBranch("feature/login")).toBe("feature/login");
    expect(() => checkEasId("not an id")).toThrow(MobileError);
  });
});

describe("running eas", () => {
  test("refuses before spawning when EXPO_TOKEN is missing, and says where to add it", async () => {
    const { calls, runner } = recorder();
    const err = await startBuild(makeDir(), { platform: "ios", profile: "production" }, { runner, envProvider: () => ({}) }).catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.message).toContain("EXPO_TOKEN is not set");
    expect(err.message).toContain("workspace's secrets");
    expect(calls).toEqual([]);
  });

  test("requireToken reads the env it is given", () => {
    expect(() => requireToken({})).toThrow(/EXPO_TOKEN/);
    expect(() => requireToken({ EXPO_TOKEN: "t" })).not.toThrow();
  });

  test("startBuild passes the token and CI=1 in env, and parses the queued builds", async () => {
    const out = JSON.stringify([
      { id: "0f1e2d3c-aaaa-bbbb-cccc-111122223333", platform: "IOS", status: "IN_QUEUE", buildProfile: "production", appVersion: "1.2.0", appBuildVersion: "14" },
      { id: "0f1e2d3c-aaaa-bbbb-cccc-444455556666", platform: "ANDROID", status: "NEW", buildProfile: "production" },
    ]);
    const { calls, runner } = recorder(`Logs: https://expo.dev/x\n${out}`);
    const builds = await startBuild(makeDir(), { platform: "all", profile: "production" }, { runner, envProvider: WITH_TOKEN, workspaceId: "w_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.slice(-buildArgs("all", "production").length)).toEqual(buildArgs("all", "production"));
    expect(calls[0]!.env.EXPO_TOKEN).toBe("expo-test-token");
    expect(calls[0]!.env.CI).toBe("1");
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(builds.map((b) => [b.platform, b.status, b.profile, b.version, b.buildNumber])).toEqual([
      ["ios", "in_queue", "production", "1.2.0", "14"],
      ["android", "new", "production", null, null],
    ]);
  });

  test("a non-zero exit becomes a MobileError with the CLI's own last lines", async () => {
    const { runner } = recorder("", 1, "Error: the project is not configured\nrun eas build:configure\n");
    const err = await submitLatest(makeDir(), { platform: "ios", profile: "production" }, { runner, envProvider: WITH_TOKEN }).catch((e) => e);
    expect(err).toBeInstanceOf(MobileError);
    expect(err.message).toContain("eas submit exited 1");
    expect(err.message).toContain("run eas build:configure");
  });

  test("submit and update build the expected argv", async () => {
    const r1 = recorder("submitted ok");
    await submitLatest(makeDir(), { platform: "android", profile: "production" }, { runner: r1.runner, envProvider: WITH_TOKEN });
    expect(r1.calls[0]!.argv.slice(-submitArgs("android", "production").length)).toEqual(submitArgs("android", "production"));
    const r2 = recorder("published group 9");
    expect(await publishUpdate(makeDir(), { branch: "production", message: "fix login" }, { runner: r2.runner, envProvider: WITH_TOKEN })).toContain("published group 9");
    expect(r2.calls[0]!.argv.slice(-updateArgs("production", "fix login").length)).toEqual(updateArgs("production", "fix login"));
    await expect(publishUpdate(makeDir(), { branch: "production", message: "" }, { runner: r2.runner, envProvider: WITH_TOKEN })).rejects.toThrow(/message/);
  });

  test("viewBuild asks for one build by id and returns it", async () => {
    const { calls, runner } = recorder(JSON.stringify({ id: "0f1e2d3c-aaaa-bbbb-cccc-111122223333", platform: "IOS", status: "FINISHED", artifacts: { buildUrl: "https://expo.dev/artifacts/a.ipa" }, appVersion: "1.2.0", appBuildVersion: "14" }));
    const b = await viewBuild(makeDir(), "0f1e2d3c-aaaa-bbbb-cccc-111122223333", { runner, envProvider: WITH_TOKEN });
    expect(calls[0]!.argv.slice(-4)).toEqual(["build:view", "0f1e2d3c-aaaa-bbbb-cccc-111122223333", "--json", "--non-interactive"]);
    expect(b).toMatchObject({ status: "finished", artifactUrl: "https://expo.dev/artifacts/a.ipa", version: "1.2.0", buildNumber: "14" });
  });

  test("parseJson takes JSON after a line of text, and fails clearly without any", () => {
    expect(parseJson('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(parseJson('Checking the project…\n{"id":"b"}')).toEqual({ id: "b" });
    expect(() => parseJson("no json here")).toThrow(/EAS printed no JSON/);
  });

  test("parseBuilds drops entries without an id and maps the platform", () => {
    expect(parseBuilds([{ platform: "ANDROID", status: "FINISHED" }, { id: "x1x1x1x1", platform: "IOS", status: "ERRORED" }]).map((b) => [b.id, b.platform, b.status])).toEqual([["x1x1x1x1", "ios", "errored"]]);
  });
});

describe("store metadata", () => {
  const good = {
    name: "Shop",
    subtitle: "Buy things quickly",
    keywords: "shop,store,deals",
    description: "A shop.",
    privacyUrl: "https://example.com/privacy",
  };

  test("a complete listing has no issues", () => {
    const { metadata, issues } = checkStoreMetadata(good);
    expect(issues).toEqual([]);
    expect(metadata?.name).toBe("Shop");
  });

  test("every limit and required field is reported, not just the first", () => {
    const { issues } = checkStoreMetadata({ ...good, name: "x".repeat(31), subtitle: "y".repeat(31), keywords: "k".repeat(101), description: "", privacyUrl: "http://example.com/p" });
    expect(issues.map((i) => i.field)).toEqual(["name", "subtitle", "keywords", "description", "privacyUrl"]);
    expect(issues[0]!.problem).toContain("limit is 30");
    expect(issues[2]!.problem).toContain("limit is 100");
  });

  test("a non-object file and a missing privacy URL are issues", () => {
    expect(checkStoreMetadata([]).issues[0]!.field).toBe("file");
    expect(checkStoreMetadata({ ...good, privacyUrl: undefined }).issues).toEqual([{ field: "privacyUrl", problem: "The privacy policy URL is missing." }]);
  });

  test("readStoreMetadata: missing, invalid and valid files", () => {
    const none = readStoreMetadata(makeDir());
    expect(none.present).toBe(false);
    expect(none.issues[0]!.problem).toContain("store/metadata.json is missing");
    const broken = readStoreMetadata(project({ "store/metadata.json": "{" }));
    expect(broken.present).toBe(true);
    expect(broken.issues[0]!.problem).toContain("not valid JSON");
    const ok = readStoreMetadata(project({ "store/metadata.json": JSON.stringify(good) }));
    expect(ok.issues).toEqual([]);
    expect(ok.metadata?.keywords).toBe("shop,store,deals");
  });
});

describe("store and poller", () => {
  const BUILD_ID = "0f1e2d3c-aaaa-bbbb-cccc-111122223333";

  test("recordBuilds stores one row per queued build and inFlightBuilds finds them", () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir).id;
    const rows = recordBuilds(ws, { platform: "all", profile: "production" }, [
      { id: BUILD_ID, platform: "ios", profile: "production", status: "in_queue", artifactUrl: null, version: null, buildNumber: null },
      { id: "9999aaaa-bbbb-cccc-dddd-eeeeffff0000", platform: "android", profile: null, status: "finished", artifactUrl: "https://expo.dev/a.aab", version: "1.2.0", buildNumber: "14" },
    ]);
    expect(rows.map((r) => [r.platform, r.profile, r.status])).toEqual([
      ["ios", "production", "in_queue"],
      ["android", "production", "finished"],
    ]);
    expect(listBuilds(ws).length).toBe(2);
    expect(inFlightBuilds().filter((b) => b.workspaceId === ws).map((b) => b.easBuildId)).toEqual([BUILD_ID]);
  });

  test("the poller updates an in-flight build from build:view, and skips a workspace without a token", async () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir).id;
    recordBuilds(ws, { platform: "ios", profile: "production" }, [{ id: BUILD_ID, platform: "ios", profile: "production", status: "in_progress", artifactUrl: null, version: null, buildNumber: null }]);

    const skipped = recorder();
    expect(await refreshInFlightBuilds({ runner: skipped.runner, envProvider: () => ({}) })).toBe(0);
    expect(skipped.calls).toEqual([]);

    const polled = recorder(JSON.stringify({ id: BUILD_ID, platform: "IOS", status: "FINISHED", artifacts: { buildUrl: "https://expo.dev/a.ipa" }, appVersion: "1.2.0", appBuildVersion: "15" }));
    expect(await refreshInFlightBuilds({ runner: polled.runner, envProvider: WITH_TOKEN })).toBe(1);
    expect(polled.calls[0]!.argv).toContain("build:view");
    const [done] = listBuilds(ws);
    expect(done).toMatchObject({ status: "finished", artifactUrl: "https://expo.dev/a.ipa", version: "1.2.0", buildNumber: "15" });
    expect(inFlightBuilds().filter((b) => b.workspaceId === ws)).toEqual([]);
  });

  test("updateBuild keeps an artifact URL it was not given", () => {
    const ws = Workspaces.open(makeDir()).id;
    const [row] = recordBuilds(ws, { platform: "ios", profile: "production" }, [{ id: BUILD_ID, platform: "ios", profile: "production", status: "new", artifactUrl: "https://expo.dev/keep.ipa", version: null, buildNumber: null }]);
    updateBuild(row!.id, { status: "errored" });
    expect(listBuilds(ws)[0]).toMatchObject({ status: "errored", artifactUrl: "https://expo.dev/keep.ipa" });
  });
});

describe("verify checks for Expo", () => {
  test("an Expo app gets tsc even without a typecheck script, and no doctor unless it declares expo-doctor", () => {
    const dir = project({ "package.json": EXPO_PACKAGE, "tsconfig.json": "{}" });
    expect(detectVerifyCommands(dir)).toEqual([{ name: "typecheck", cmd: "npx tsc --noEmit" }]);
  });

  test("expo-doctor runs last, and only when the project declares it", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { expo: "~54.0.0" }, devDependencies: { "expo-doctor": "^1.0.0" }, scripts: { lint: "eslint ." } }),
      "tsconfig.json": "{}",
    });
    expect(detectVerifyCommands(dir)).toEqual([
      { name: "typecheck", cmd: "npx tsc --noEmit" },
      { name: "lint", cmd: "npm run lint" },
      { name: "doctor", cmd: "npx expo-doctor" },
    ]);
  });

  test("a plain Node project keeps its checks and gets no Expo ones", () => {
    const dir = project({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }), "tsconfig.json": "{}" });
    expect(detectVerifyCommands(dir)).toEqual([{ name: "lint", cmd: "npm run lint" }]);
  });
});

describe("device preview", () => {
  test("findPreviewUrl reads the exp:// address out of CLI output, with ANSI codes around it", () => {
    expect(findPreviewUrl("› Metro waiting on exp://192.168.1.2:8081\n")).toBe("exp://192.168.1.2:8081");
    expect(findPreviewUrl("\x1b[1mexp://abc-anon.exp.direct:80\x1b[0m\n")).toBe("exp://abc-anon.exp.direct:80");
    expect(findPreviewUrl("starting Metro")).toBeNull();
  });

  test("a project that is not Expo gets a clear refusal, not a tunnel", async () => {
    await expect(expoGoUrl(project({ "package.json": JSON.stringify({ dependencies: { react: "19.1.0" } }) }))).rejects.toThrow(/not an Expo project/);
    expect(stopExpoPreview(makeDir())).toBe(false);
  });
});

describe("the HTTP route", () => {
  const call = async (ws: string, rest: string, method: string, body: Record<string, unknown> = {}) => {
    const url = new URL(`http://daemon.test/api/mobile/${ws}${rest}`);
    return mobileRoutes(makeCtx(new Request(url, { method }), url, body));
  };

  test("GET returns detect, the store check and the recent builds for a workspace", async () => {
    const dir = project({ "package.json": EXPO_PACKAGE, "app.json": APP_JSON, "eas.json": EAS_JSON });
    const ws = Workspaces.open(dir).id;
    const res = await call(ws, "", "GET");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.detect).toMatchObject({ isExpo: true, bundleId: "com.example.shop" });
    expect(body.metadata).toMatchObject({ present: false });
    expect(body.builds).toEqual([]);
    expect(body.submissions).toEqual([]);
  });

  test("POST builds without EXPO_TOKEN answers with the refusal", async () => {
    const ws = Workspaces.open(project({ "package.json": EXPO_PACKAGE })).id;
    await expect(call(ws, "/builds", "POST", { platform: "ios", profile: "production" })).rejects.toThrow(/EXPO_TOKEN is not set/);
  });

  test("a platform outside ios, android or all is refused before anything runs", async () => {
    const ws = Workspaces.open(project({ "package.json": EXPO_PACKAGE })).id;
    await expect(call(ws, "/builds", "POST", { platform: "web", profile: "production" })).rejects.toThrow(/platform/);
  });

  test("unknown sub-routes are not claimed", async () => {
    const ws = Workspaces.open(makeDir()).id;
    expect(await call(ws, "/nope", "GET")).toBeNull();
    expect(await mobileRoutes(makeCtx(new Request("http://daemon.test/api/roadmap/w_1"), new URL("http://daemon.test/api/roadmap/w_1"), {}))).toBeNull();
  });
});
