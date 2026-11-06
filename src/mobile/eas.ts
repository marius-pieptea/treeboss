/**
 * The EAS CLI for an Expo app: builds, the build list, store submissions and over-the-air updates.
 *
 * Every call is an argv array run with Bun.spawn, never a shell. `eas` is used when it is on PATH, else
 * `npx --yes eas-cli`. Every cloud call needs EXPO_TOKEN in the environment the caller's envProvider
 * returns (the workspace's secrets); without it the call is refused before anything is spawned.
 */
import { UserError } from "../util";
import type { MobilePlatform } from "./detect";

export type Platform = MobilePlatform | "all";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs argv[0] with argv[1..]. Injectable so tests never reach the network. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

/** The environment for a workspace's EAS calls. The secrets slice supplies it (see setEnvProvider). */
export type EnvProvider = (workspaceId: string) => Record<string, string | undefined>;

export interface EasOptions {
  workspaceId?: string;
  runner?: Runner;
  envProvider?: EnvProvider;
  timeoutMs?: number;
}

/** A refusal or failure the operator can read: it becomes a 400 over HTTP, like other UserErrors. */
export class MobileError extends UserError {}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

let envProvider: EnvProvider = () => ({});

/** Where the daemon gets a workspace's env (EXPO_TOKEN). Default: nothing. The daemon sets it at startup. */
export function setEnvProvider(fn: EnvProvider): void {
  envProvider = fn;
}

export const spawnRunner: Runner = async (argv, { cwd, env, timeoutMs }) => {
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

/** `eas` when it is on PATH, else the published CLI through npx. The first element is resolved, so Windows' .cmd shims run without a shell. */
export function easArgv(args: string[]): string[] {
  const eas = Bun.which("eas");
  if (eas) return [eas, ...args];
  return [Bun.which("npx") ?? "npx", "--yes", "eas-cli", ...args];
}

export function checkName(value: string, what: string): string {
  if (!NAME.test(value)) throw new MobileError(`The ${what} must be letters, digits, dots, dashes or underscores, and must not start with a dash (got "${value}").`);
  return value;
}

export function checkPlatform(value: string, allowAll: boolean): Platform {
  if (value === "ios" || value === "android" || (allowAll && value === "all")) return value;
  throw new MobileError(`The platform must be ${allowAll ? "ios, android or all" : "ios or android"} (got "${value}").`);
}

export function checkBranch(value: string): string {
  if (!BRANCH.test(value)) throw new MobileError(`The branch must be a name like "production" or "feature/login" (got "${value}").`);
  return value;
}

export function easEnv(opts: EasOptions): Record<string, string> {
  const provided = (opts.envProvider ?? envProvider)(opts.workspaceId ?? "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...provided })) if (typeof v === "string") env[k] = v;
  // Stops the CLI from prompting: a prompt would hang a call that nobody is watching.
  env.CI = "1";
  return env;
}

export function requireToken(env: Record<string, string>): void {
  if (!env.EXPO_TOKEN) {
    throw new MobileError("EXPO_TOKEN is not set. Add an Expo access token to this workspace's secrets (expo.dev, Account settings, Access tokens), then try again.");
  }
}

const tail = (text: string, lines = 6): string =>
  text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");

/** Runs one eas command in `cwd`. Throws a MobileError with the CLI's own last lines when it exits non-zero. */
export async function runEas(args: string[], cwd: string, opts: EasOptions = {}, { token = true } = {}): Promise<RunResult> {
  const env = easEnv(opts);
  if (token) requireToken(env);
  const run = opts.runner ?? spawnRunner;
  const res = await run(easArgv(args), { cwd, env, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (res.code !== 0) {
    const detail = tail(res.stderr) || tail(res.stdout);
    throw new MobileError(`eas ${args[0]} exited ${res.code}${detail ? `:\n${detail}` : "."}`);
  }
  return res;
}

/** The JSON part of a CLI's output: the whole text, or from its first line that starts a JSON value. */
export function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through: the CLI printed something before the JSON */
  }
  const at = text.search(/^[[{]/m);
  if (at >= 0) {
    try {
      return JSON.parse(text.slice(at));
    } catch {
      /* fall through */
    }
  }
  throw new MobileError(`EAS printed no JSON${tail(stdout) ? `: ${tail(stdout, 3)}` : "."}`);
}

export interface EasBuild {
  /** The EAS build id (a UUID). */
  id: string;
  platform: MobilePlatform | null;
  profile: string | null;
  /** EAS's status, lower-cased: new, in_queue, in_progress, finished, errored, canceled. */
  status: string;
  artifactUrl: string | null;
  version: string | null;
  buildNumber: string | null;
}

const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const PLATFORMS: Record<string, MobilePlatform> = { IOS: "ios", ANDROID: "android", ios: "ios", android: "android" };

/** Builds from `build`, `build:list` or `build:view` JSON: one object or a list. */
export function parseBuilds(value: unknown): EasBuild[] {
  const list: unknown[] = Array.isArray(value) ? value : isObject(value) ? [value] : [];
  return list
    .filter(isObject)
    .map((b) => ({
      id: str(b.id) ?? "",
      platform: PLATFORMS[String(b.platform ?? "")] ?? null,
      profile: str(b.buildProfile) ?? str(b.profile),
      status: (str(b.status) ?? "unknown").toLowerCase(),
      artifactUrl: str(b.artifacts?.buildUrl),
      version: str(b.appVersion),
      buildNumber: str(b.appBuildVersion),
    }))
    .filter((b) => b.id !== "");
}

export function buildArgs(platform: Platform, profile: string): string[] {
  return ["build", "--platform", platform, "--profile", profile, "--non-interactive", "--json", "--no-wait"];
}

export function listArgs(limit: number): string[] {
  return ["build:list", "--limit", String(limit), "--json", "--non-interactive"];
}

export function viewArgs(id: string): string[] {
  return ["build:view", id, "--json", "--non-interactive"];
}

/** `--latest` submits the newest finished build for the platform, so no build id is needed. */
export function submitArgs(platform: MobilePlatform, profile: string): string[] {
  return ["submit", "--platform", platform, "--profile", profile, "--latest", "--non-interactive"];
}

export function updateArgs(branch: string, message: string): string[] {
  return ["update", "--branch", branch, "--message", message, "--non-interactive"];
}

/** Queues cloud builds and returns at once (`--no-wait`); the poller follows them with build:view. */
export async function startBuild(cwd: string, input: { platform: string; profile: string }, opts: EasOptions = {}): Promise<EasBuild[]> {
  const platform = checkPlatform(input.platform, true);
  const profile = checkName(input.profile, "build profile");
  const res = await runEas(buildArgs(platform, profile), cwd, opts);
  return parseBuilds(parseJson(res.stdout));
}

export async function listBuilds(cwd: string, limit = 20, opts: EasOptions = {}): Promise<EasBuild[]> {
  const res = await runEas(listArgs(Math.min(Math.max(limit, 1), 100)), cwd, opts);
  return parseBuilds(parseJson(res.stdout));
}

export async function viewBuild(cwd: string, id: string, opts: EasOptions = {}): Promise<EasBuild | null> {
  const res = await runEas(viewArgs(checkEasId(id)), cwd, opts);
  return parseBuilds(parseJson(res.stdout))[0] ?? null;
}

/** An EAS build id is a UUID. Refuse anything else before it reaches argv. */
export function checkEasId(id: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new MobileError(`"${id}" is not an EAS build id.`);
  return id;
}

/** Submits the latest finished build to TestFlight (ios) or the Play internal track (android), with the named submit profile. */
export async function submitLatest(cwd: string, input: { platform: string; profile: string }, opts: EasOptions = {}): Promise<string> {
  const platform = checkPlatform(input.platform, false) as MobilePlatform;
  const profile = checkName(input.profile, "submit profile");
  const res = await runEas(submitArgs(platform, profile), cwd, opts);
  return tail(res.stdout, 12);
}

/** Publishes a JavaScript-only update to a branch. Returns the CLI's own closing lines. */
export async function publishUpdate(cwd: string, input: { branch: string; message: string }, opts: EasOptions = {}): Promise<string> {
  const branch = checkBranch(input.branch);
  const message = input.message.trim();
  if (!message || message.length > 200) throw new MobileError("An update needs a message of 1 to 200 characters.");
  const res = await runEas(updateArgs(branch, message), cwd, opts);
  return tail(res.stdout, 12);
}
