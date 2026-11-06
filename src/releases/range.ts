/**
 * Release ranges and versions.
 *
 * A range runs from a base point to HEAD. The base is the last tag (the default), any tag, a commit, or a date (the
 * last commit before it). The range holds what a changelog is written from: the commits with their bodies, authors
 * and files, the diff stat, the roadmap items checked in it, the spec tasks checked in it, and, when `gh` is signed
 * in, the PRs merged in it.
 *
 * Versions are read from the manifests a folder has (package.json, composer.json, pyproject.toml, Cargo.toml,
 * app.json or app.config.*, pubspec.yaml, a VERSION file) and written back surgically: only the version value and
 * the build counters change, the rest of the file is left byte for byte.
 */
import fs from "fs";
import path from "path";
import { parseRoadmap } from "../roadmap/format";
import { readRoadmap, roadmapPath } from "../roadmap/store";
import { parseTasks } from "../specs/tasks";
import { UserError } from "../util";

/* -------------------------------------------------------------------------- */
/* Git                                                                        */
/* -------------------------------------------------------------------------- */

export function gitIn(root: string, args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** git's well-known empty tree: the base of a range that starts at the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** How many commits a range without a base reads. Past this the changelog stops being useful. */
export const NO_BASE_LIMIT = 300;

/* -------------------------------------------------------------------------- */
/* Base point                                                                 */
/* -------------------------------------------------------------------------- */

/** What the operator asked for. */
export type BaseSpec = { kind: "last-tag" } | { kind: "tag"; ref: string } | { kind: "sha"; ref: string } | { kind: "date"; ref: string };

export interface Base {
  kind: BaseSpec["kind"];
  /** What to show: "v1.2.0", "3f9c1a2", "2026-10-01", or "no tag yet". */
  label: string;
  /** The commit the range starts after, or null for the whole history. */
  sha: string | null;
  /** The tag, when the base is one. */
  tag: string | null;
  /** The base commit's author date (ISO), used to filter merged PRs. */
  date: string | null;
}

/** Reads what the operator typed: nothing or "last" is the last tag; YYYY-MM-DD is a date; 7 to 40 hex digits a sha; anything else a tag. */
export function parseBase(input: string | null | undefined): BaseSpec {
  const s = (input ?? "").trim();
  if (!s || s === "last" || s === "last-tag") return { kind: "last-tag" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "date", ref: s };
  if (/^[0-9a-f]{7,40}$/i.test(s)) return { kind: "sha", ref: s };
  return { kind: "tag", ref: s };
}

function commitOf(root: string, rev: string): string | null {
  const r = gitIn(root, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]);
  return r.code === 0 ? r.out.trim() || null : null;
}

function dateOfCommit(root: string, sha: string): string | null {
  const r = gitIn(root, ["show", "-s", "--format=%cI", sha]);
  return r.code === 0 ? r.out.trim() || null : null;
}

/** The last tag that git describes from HEAD (v-prefixed, as the release tags are). */
export function lastTag(root: string): string | null {
  const r = gitIn(root, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  return r.code === 0 ? r.out.trim() || null : null;
}

/** Every tag, newest first. */
export function listTags(root: string): string[] {
  const r = gitIn(root, ["tag", "--sort=-creatordate"]);
  return r.code === 0 ? r.out.split("\n").map((t) => t.trim()).filter(Boolean) : [];
}

export function resolveBase(root: string, spec: BaseSpec): Base {
  if (spec.kind === "last-tag") {
    const tag = lastTag(root);
    if (!tag) return { kind: "last-tag", label: "no tag yet", sha: null, tag: null, date: null };
    const sha = commitOf(root, tag);
    if (!sha) throw new UserError(`The tag ${tag} does not point at a commit.`);
    return { kind: "last-tag", label: tag, sha, tag, date: dateOfCommit(root, sha) };
  }
  if (spec.kind === "tag") {
    const sha = commitOf(root, `refs/tags/${spec.ref}`);
    if (!sha) throw new UserError(`No tag "${spec.ref}". Tags: ${listTags(root).slice(0, 8).join(", ") || "none"}.`);
    return { kind: "tag", label: spec.ref, sha, tag: spec.ref, date: dateOfCommit(root, sha) };
  }
  if (spec.kind === "sha") {
    const sha = commitOf(root, spec.ref);
    if (!sha) throw new UserError(`No commit "${spec.ref}" in this repository.`);
    return { kind: "sha", label: sha.slice(0, 7), sha, tag: null, date: dateOfCommit(root, sha) };
  }
  // A date is the last commit before the start of that day. A repo with no commit that old covers its whole history.
  const r = gitIn(root, ["rev-list", "-n", "1", `--before=${spec.ref}T00:00:00`, "HEAD"]);
  const sha = r.code === 0 ? r.out.trim() || null : null;
  return { kind: "date", label: spec.ref, sha, tag: null, date: sha ? dateOfCommit(root, sha) : null };
}

/* -------------------------------------------------------------------------- */
/* Range                                                                      */
/* -------------------------------------------------------------------------- */

export interface RangeCommit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  /** Author date, ISO. */
  date: string;
  files: string[];
}

export interface DiffFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface SpecProgress {
  /** The spec folder, e.g. "specs/119-releases-changelog". */
  feature: string;
  done: number;
  total: number;
  /** Task ids (or the first words of the line) checked in this range. */
  newlyDone: string[];
}

export interface MergedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

export interface Range {
  base: Base;
  head: { sha: string; branch: string | null };
  /** Newest first. */
  commits: RangeCommit[];
  /** True when a range without a base was cut at NO_BASE_LIMIT commits. */
  truncated: boolean;
  diff: { files: number; insertions: number; deletions: number; top: DiffFile[] };
  roadmap: Array<{ id: string | null; title: string }>;
  specs: SpecProgress[];
  /** Merged PRs in the range, when gh is available and asked for. Empty otherwise. */
  prs: MergedPr[];
  /** Breaking changes and the risky files (migrations) a reader should be told about. */
  breaking: string[];
  warnings: string[];
}

const SEP_REC = "\x1d";
const SEP_FIELD = "\x1f";

function commitsIn(root: string, base: string | null): { commits: RangeCommit[]; truncated: boolean } {
  const range = base ? [`${base}..HEAD`] : ["-n", String(NO_BASE_LIMIT), "HEAD"];
  const r = gitIn(root, ["log", `--format=${SEP_REC}%H${SEP_FIELD}%s${SEP_FIELD}%b${SEP_FIELD}%an${SEP_FIELD}%aI`, "--name-only", ...range]);
  if (r.code !== 0) return { commits: [], truncated: false };
  const commits = r.out
    .split(SEP_REC)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      // The fields are separated by \x1f; the last one holds the date, then the file names, one per line.
      const [sha = "", subject = "", body = "", author = "", tail = ""] = chunk.split(SEP_FIELD);
      const [date = "", ...files] = tail.split("\n").map((l) => l.trim());
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim(), author: author.trim(), date: date ?? "", files: files.filter(Boolean) };
    });
  return { commits, truncated: !base && commits.length >= NO_BASE_LIMIT };
}

function diffOf(root: string, base: string | null): Range["diff"] {
  const r = gitIn(root, ["diff", "--numstat", `${base ?? EMPTY_TREE}..HEAD`]);
  const files: DiffFile[] = [];
  for (const line of r.out.split("\n")) {
    const [ins = "", del = "", ...rest] = line.split("\t");
    if (!rest.length) continue;
    // Binary files show "-" for both counts.
    files.push({ path: rest.join("\t"), insertions: Number(ins) || 0, deletions: Number(del) || 0 });
  }
  const sum = (k: "insertions" | "deletions") => files.reduce((n, f) => n + f[k], 0);
  const top = [...files].sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions)).slice(0, 20);
  return { files: files.length, insertions: sum("insertions"), deletions: sum("deletions"), top };
}

/** Roadmap items checked now that were not checked at the base (all checked items when there is no base). */
function roadmapDoneSince(root: string, base: string | null): Array<{ id: string | null; title: string }> {
  const now = readRoadmap(root);
  const doneNow = now.lanes.flatMap((l) => l.items).filter((i) => i.done);
  if (!doneNow.length) return [];
  const before = new Set<string>();
  if (base) {
    const file = roadmapPath(root).replace(/\\/g, "/");
    const r = gitIn(root, ["show", `${base}:${file}`]);
    if (r.code === 0) for (const it of parseRoadmap(r.out).lanes.flatMap((l) => l.items)) if (it.done) before.add(it.id ?? it.title);
  }
  return doneNow.filter((i) => !before.has(i.id ?? i.title)).map((i) => ({ id: i.id, title: i.title }));
}

/** Spec tasks checked in the range: each specs/<feature>/tasks.md now against its base version. */
function specsDoneSince(root: string, base: string | null): SpecProgress[] {
  const dir = path.join(root, "specs");
  if (!fs.existsSync(dir)) return [];
  const out: SpecProgress[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const rel = `specs/${name}/tasks.md`;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const now = parseTasks(fs.readFileSync(file, "utf-8")).tasks;
    const before = new Set<string>();
    if (base) {
      const r = gitIn(root, ["show", `${base}:${rel}`]);
      if (r.code === 0) for (const t of parseTasks(r.out).tasks) if (t.done) before.add(t.id ?? t.text);
    }
    const newlyDone = now.filter((t) => t.done && !before.has(t.id ?? t.text)).map((t) => t.id ?? t.text.slice(0, 60));
    if (newlyDone.length) out.push({ feature: `specs/${name}`, done: now.filter((t) => t.done).length, total: now.length, newlyDone });
  }
  return out;
}

/** Merged PRs since the base date, through `gh`. Empty when gh is missing or signed out. */
export function mergedPrsSince(root: string, sinceIso: string | null): { prs: MergedPr[]; warning: string | null } {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(["gh", "pr", "list", "--state", "merged", "--limit", "100", "--json", "number,title,url,mergedAt"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
  } catch {
    return { prs: [], warning: "gh is not installed: merged PRs are not listed." };
  }
  if (r.exitCode !== 0) return { prs: [], warning: "gh could not list the merged PRs (is it signed in?)." };
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const rows = JSON.parse(r.stdout?.toString() || "[]") as MergedPr[];
  return { prs: rows.filter((p) => Date.parse(p.mergedAt) > since).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)), warning: null };
}

/** Breaking changes: a `!` or BREAKING CHANGE in the subject or body, and migration files. */
function breakingOf(commits: RangeCommit[]): string[] {
  const out: string[] = [];
  for (const c of commits) {
    if (/^[\w-]+(\([^)]*\))?!:/.test(c.subject) || /BREAKING[ -]CHANGE/.test(c.body)) out.push(`${c.subject} (${c.sha.slice(0, 7)})`);
  }
  const migrations = new Set<string>();
  for (const c of commits) for (const f of c.files) if (/(^|\/)(migrations?|db\/migrate)\//i.test(f)) migrations.add(f);
  for (const f of [...migrations].slice(0, 10)) out.push(`migration: ${f}`);
  return out;
}

export interface RangeOpts {
  /** Ask gh for the merged PRs. Off by default: it is a network call. */
  prs?: boolean;
}

/** The range from a base point to HEAD: everything a changelog is written from. Reads only. */
export function rangeOf(root: string, spec: BaseSpec = { kind: "last-tag" }, opts: RangeOpts = {}): Range {
  const base = resolveBase(root, spec);
  const head = gitIn(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new UserError("This folder is not a git repository with a commit.");
  const branch = gitIn(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim() || null;
  const { commits, truncated } = commitsIn(root, base.sha);
  const warnings: string[] = [];
  if (!base.sha) warnings.push(spec.kind === "last-tag" ? "No version tag yet: the range covers the whole history." : `No commit before ${base.label}: the range covers the whole history.`);
  if (truncated) warnings.push(`The range has no base, so only the last ${NO_BASE_LIMIT} commits are read.`);
  if (base.sha && !commits.length) warnings.push("No commits since the base.");
  let prs: MergedPr[] = [];
  if (opts.prs) {
    const got = mergedPrsSince(root, base.date);
    prs = got.prs;
    if (got.warning) warnings.push(got.warning);
  }
  return {
    base,
    head: { sha: head.out.trim(), branch: branch === "HEAD" ? null : branch },
    commits,
    truncated,
    diff: diffOf(root, base.sha),
    roadmap: roadmapDoneSince(root, base.sha),
    specs: specsDoneSince(root, base.sha),
    prs,
    breaking: breakingOf(commits),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Semver                                                                     */
/* -------------------------------------------------------------------------- */

/** "auto" is decided from the commits (suggestBump); the rest are what the operator picked. */
export type ReleaseBump = "auto" | "patch" | "minor" | "major" | "prerelease" | "release";
export const RELEASE_BUMPS: ReleaseBump[] = ["auto", "patch", "minor", "major", "prerelease", "release"];
export const PRERELEASE_IDS = ["alpha", "beta", "rc"] as const;
export type PreId = (typeof PRERELEASE_IDS)[number];

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** "beta.2", "rc.1", or null for a plain release. */
  pre: string | null;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): Semver | null {
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

const formatSemver = (v: Semver) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;

/**
 * The next version. patch, minor and major drop a prerelease suffix and bump as a plain release (1.2.3-beta.1 patch
 * is 1.2.4, as it always was). `release` drops the suffix and bumps nothing: 1.3.0-rc.2 becomes 1.3.0. `prerelease`
 * counts up within a preid (1.3.0-rc.2 is 1.3.0-rc.3); a new preid, or a plain release, starts at .1 (1.2.3 is 1.2.4-beta.1).
 */
export function nextVersion(current: string, bump: Exclude<ReleaseBump, "auto">, preid: PreId = "beta"): string {
  const v = parseSemver(current);
  if (!v) throw new UserError(`Version "${current}" is not x.y.z (with an optional -prerelease).`);
  if (bump === "release") return `${v.major}.${v.minor}.${v.patch}`;
  if (bump === "prerelease") {
    const same = v.pre?.match(new RegExp(`^${preid}\\.(\\d+)$`));
    if (same) return `${v.major}.${v.minor}.${v.patch}-${preid}.${Number(same[1]) + 1}`;
    // A plain release is the next patch; a prerelease of another preid stays on its own version.
    const base = v.pre ? v : { ...v, patch: v.patch + 1 };
    return formatSemver({ ...base, pre: `${preid}.1` });
  }
  const base = bumpVersion(current, bump);
  return base;
}

/** The plain bump, as the quick release path has always done it. */
export function bumpVersion(version: string, bump: "patch" | "minor" | "major"): string {
  const v = parseSemver(version);
  if (!v) throw new UserError(`package.json version "${version}" is not x.y.z.`);
  let { major, minor, patch } = v;
  if (bump === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (bump === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

/** A bump proposed from the commits: a breaking change is a major, a feature a minor, anything else a patch. */
export function suggestBump(range: Pick<Range, "commits" | "breaking">): { bump: "patch" | "minor" | "major"; reason: string } {
  if (range.breaking.length) return { bump: "major", reason: `${range.breaking.length} breaking change${range.breaking.length === 1 ? "" : "s"}` };
  const feats = range.commits.filter((c) => /^feat(\(|:)/.test(c.subject)).length;
  if (feats) return { bump: "minor", reason: `${feats} new feature${feats === 1 ? "" : "s"}` };
  return { bump: "patch", reason: "fixes and maintenance only" };
}

/** The version a bump would produce from the current one, for every bump the operator can pick. */
export function candidates(current: string): Record<"patch" | "minor" | "major" | "prerelease", string> {
  return {
    patch: nextVersion(current, "patch"),
    minor: nextVersion(current, "minor"),
    major: nextVersion(current, "major"),
    prerelease: nextVersion(current, "prerelease"),
  };
}

/* -------------------------------------------------------------------------- */
/* Version files                                                              */
/* -------------------------------------------------------------------------- */

export type VersionStack = "npm" | "composer" | "python" | "cargo" | "expo" | "expo-config" | "flutter" | "plain";

/** A counter that goes up with every release: iOS buildNumber, Android versionCode, the pubspec build number. */
export interface BuildCounter {
  key: string;
  value: number;
}

export interface VersionFile {
  /** Repo-relative path. */
  file: string;
  stack: VersionStack;
  version: string;
  builds: BuildCounter[];
}

const VERSION_CANDIDATES = ["package.json", "composer.json", "pyproject.toml", "Cargo.toml", "app.json", "app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs", "pubspec.yaml", "VERSION"];

/** Parents whose subfolders are packages by convention, for monorepos that do not list them in `workspaces`. */
const PACKAGE_PARENTS = ["apps", "packages", "services"];

/** The repo-relative folders a version can be bumped in: "" (the root) and each workspace folder that has a version file. */
export function listPackageRoots(root: string): string[] {
  const dirs = new Set<string>();
  const addChildren = (parent: string) => {
    try {
      for (const e of fs.readdirSync(path.join(root, parent), { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") dirs.add(path.posix.join(parent, e.name));
    } catch {}
  };
  for (const pattern of workspacePatterns(root)) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean.endsWith("/*") || clean.endsWith("/**")) addChildren(clean.replace(/\/\*+$/, ""));
    else if (!clean.includes("*")) dirs.add(clean);
  }
  for (const parent of PACKAGE_PARENTS) addChildren(parent);
  const out = [""];
  for (const rel of [...dirs].sort()) if (detectVersionFiles(root, rel).length) out.push(rel);
  return out;
}

/** The `workspaces` of the root package.json: an array, or `{ packages: [...] }`. */
function workspacePatterns(root: string): string[] {
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"))?.workspaces;
    const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    return list.filter((x: unknown): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * The version manifests in a package folder, in a stable order. `pkg` is repo-relative ("" for the root); each result's
 * `file` is repo-relative too, so it can be written and committed as it is. package.json comes first when it is there.
 */
export function detectVersionFiles(root: string, pkg = ""): VersionFile[] {
  const rel = pkg.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (rel.split("/").includes("..")) throw new UserError(`"${pkg}" is outside the repository.`);
  const out: VersionFile[] = [];
  for (const name of VERSION_CANDIDATES) {
    const file = rel ? `${rel}/${name}` : name;
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const found = readVersionFile(file, fs.readFileSync(abs, "utf-8"));
    if (found) out.push(found);
  }
  return out;
}

/** What one manifest says now. Null when it has no version. */
export function readVersionFile(file: string, text: string): VersionFile | null {
  const name = path.basename(file);
  const jsonVersion = (obj: any) => (typeof obj?.version === "string" ? obj.version : null);
  if (name === "package.json" || name === "composer.json") {
    const version = jsonVersion(parseJson(file, text));
    return version ? { file, stack: name === "package.json" ? "npm" : "composer", version, builds: [] } : null;
  }
  if (name === "app.json") {
    const expo = parseJson(file, text)?.expo;
    if (!expo || typeof expo.version !== "string") return null;
    const builds: BuildCounter[] = [];
    if (expo.ios?.buildNumber !== undefined && /^\d+$/.test(String(expo.ios.buildNumber))) builds.push({ key: "ios.buildNumber", value: Number(expo.ios.buildNumber) });
    if (typeof expo.android?.versionCode === "number") builds.push({ key: "android.versionCode", value: expo.android.versionCode });
    return { file, stack: "expo", version: expo.version, builds };
  }
  if (name.startsWith("app.config.")) {
    const version = /\bversion\s*:\s*["']([^"']+)["']/.exec(text)?.[1];
    if (!version) return null;
    const builds: BuildCounter[] = [];
    const ios = /\bbuildNumber\s*:\s*["'](\d+)["']/.exec(text);
    const android = /\bversionCode\s*:\s*(\d+)/.exec(text);
    if (ios) builds.push({ key: "ios.buildNumber", value: Number(ios[1]) });
    if (android) builds.push({ key: "android.versionCode", value: Number(android[1]) });
    return { file, stack: "expo-config", version, builds };
  }
  if (name === "pyproject.toml" || name === "Cargo.toml") {
    const sections = name === "Cargo.toml" ? ["package"] : ["project", "tool.poetry"];
    const found = tomlVersion(text, sections);
    return found ? { file, stack: name === "Cargo.toml" ? "cargo" : "python", version: found.version, builds: [] } : null;
  }
  if (name === "pubspec.yaml") {
    const m = /^version:\s*([^\s+]+)(?:\+(\d+))?/m.exec(text);
    if (!m) return null;
    return { file, stack: "flutter", version: m[1]!, builds: m[2] ? [{ key: "build", value: Number(m[2]) }] : [] };
  }
  if (name === "VERSION") {
    const version = text.trim();
    return version ? { file, stack: "plain", version, builds: [] } : null;
  }
  return null;
}

function parseJson(file: string, text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(`${file} is not valid JSON.`);
  }
}

/** The version under [section] in a TOML file: the first `version = "…"` inside it. */
function tomlVersion(text: string, sections: string[]): { version: string; start: number } | null {
  for (const section of sections) {
    const head = new RegExp(`^\\[${section.replace(/\./g, "\\.")}\\][ \\t]*$`, "m").exec(text);
    if (!head) continue;
    const from = head.index + head[0].length;
    const next = /^\[/m.exec(text.slice(from));
    const body = text.slice(from, next ? from + next.index : text.length);
    const v = /^version\s*=\s*"([^"]*)"/m.exec(body);
    if (v) return { version: v[1]!, start: from + v.index };
  }
  return null;
}

/**
 * The same file with the version (and each build counter, plus one) changed. Nothing else in the file moves: each
 * change is a replacement of one value, in place.
 */
export function renderVersion(vf: VersionFile, text: string, version: string): string {
  const bumpBuild = (key: string) => vf.builds.find((b) => b.key === key);
  switch (vf.stack) {
    case "npm":
    case "composer":
      return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    case "expo": {
      // The version and the counters live under "expo": the first match after that key.
      const at = text.indexOf('"expo"');
      if (at < 0) return text;
      let body = text.slice(at);
      body = body.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
      const ios = bumpBuild("ios.buildNumber");
      if (ios) body = body.replace(/("buildNumber"\s*:\s*")\d+(")/, `$1${ios.value + 1}$2`);
      const android = bumpBuild("android.versionCode");
      if (android) body = body.replace(/("versionCode"\s*:\s*)\d+/, `$1${android.value + 1}`);
      return text.slice(0, at) + body;
    }
    case "expo-config": {
      let out = text.replace(/(\bversion\s*:\s*["'])[^"']+(["'])/, `$1${version}$2`);
      const ios = bumpBuild("ios.buildNumber");
      if (ios) out = out.replace(/(\bbuildNumber\s*:\s*["'])\d+(["'])/, `$1${ios.value + 1}$2`);
      const android = bumpBuild("android.versionCode");
      if (android) out = out.replace(/(\bversionCode\s*:\s*)\d+/, `$1${android.value + 1}`);
      return out;
    }
    case "python":
    case "cargo": {
      const sections = vf.stack === "cargo" ? ["package"] : ["project", "tool.poetry"];
      const found = tomlVersion(text, sections);
      if (!found) return text;
      const line = /^version\s*=\s*"[^"]*"/m.exec(text.slice(found.start));
      if (!line) return text;
      const at = found.start + line.index;
      return text.slice(0, at) + `version = "${version}"` + text.slice(at + line[0].length);
    }
    case "flutter": {
      const build = bumpBuild("build");
      const next = build ? `${version}+${build.value + 1}` : version;
      return text.replace(/^version:\s*[^\s]+/m, `version: ${next}`);
    }
    case "plain": {
      const trailing = /\n$/.test(text) ? "\n" : "";
      return `${version}${trailing}`;
    }
  }
}

/** The version the release is about: the first manifest's, which package.json is when there is one. */
export function primaryVersion(files: VersionFile[]): VersionFile | null {
  return files[0] ?? null;
}

/** Warnings for manifests that disagree with the primary one. */
export function versionWarnings(files: VersionFile[]): string[] {
  const primary = primaryVersion(files);
  if (!primary) return ["No version file found: package.json, composer.json, pyproject.toml, Cargo.toml, app.json, pubspec.yaml or VERSION."];
  return files.filter((f) => f.version !== primary.version).map((f) => `${f.file} says ${f.version}, ${primary.file} says ${primary.version}.`);
}

/** Write the new version into each manifest. Returns what changed as repo-relative paths. */
export function writeVersionFiles(root: string, files: VersionFile[], version: string): string[] {
  const changed: string[] = [];
  for (const vf of files) {
    const abs = path.join(root, vf.file);
    const text = fs.readFileSync(abs, "utf-8");
    const next = renderVersion(vf, text, version);
    if (next !== text) {
      fs.writeFileSync(abs, next);
      changed.push(vf.file);
    }
  }
  return changed;
}
