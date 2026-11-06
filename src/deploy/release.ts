/**
 * Releases, the quick path: a semver bump of the version files, a CHANGELOG.md section from the conventional commits
 * and the roadmap items checked since the last tag, then a commit and an annotated tag.
 *
 * The range and the version files come from src/releases/range.ts; this module adds the mechanical changelog and the
 * write. `planRelease` only reads (it is a preview). `cutRelease` writes, and refuses a dirty tree so the release commit
 * holds exactly the version bump and the changelog. The agent-drafted path (src/releases/) writes through `writeRelease`.
 */
import fs from "fs";
import path from "path";
import { detectVersionFiles, gitIn, bumpVersion, primaryVersion, rangeOf, writeVersionFiles, type VersionFile } from "../releases/range";
import { UserError } from "../util";

export { bumpVersion };

export type Bump = "patch" | "minor" | "major";
export const BUMPS: Bump[] = ["patch", "minor", "major"];

export interface Commit {
  sha: string;
  subject: string;
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

export interface RoadmapDone {
  id: string | null;
  title: string;
}

export interface ReleasePlan {
  /** The last tag (v1.2.3), or null when the repo has none yet. */
  fromTag: string | null;
  /** The version the version files have now. */
  current: string;
  version: string;
  tag: string;
  bump: Bump;
  date: string;
  commits: Commit[];
  roadmap: RoadmapDone[];
  /** The new CHANGELOG.md section, as it will be written. */
  changelog: string;
  /** The version files that will change, then CHANGELOG.md. */
  files: string[];
  warnings: string[];
}

const CC = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** A conventional commit subject. Anything else is kept under "other". */
export function parseCommit(sha: string, subject: string): Commit {
  const m = CC.exec(subject.trim());
  if (!m) return { sha, subject, type: "other", scope: null, breaking: false, description: subject.trim() };
  return { sha, subject, type: m[1]!.toLowerCase(), scope: m[2] ?? null, breaking: m[3] === "!" || /BREAKING CHANGE/.test(subject), description: m[4]!.trim() };
}

/** Changelog group by conventional type. Anything else is "Other". */
const TITLE_OF: Record<string, string> = { feat: "Added", fix: "Fixed", perf: "Changed", refactor: "Changed" };
const ORDER = ["Added", "Fixed", "Changed", "Other"];
const titleOf = (c: Commit): string => TITLE_OF[c.type] ?? "Other";

/** Merges and the release commits this module makes (chore(release)) are not news. */
const isNoise = (c: Commit): boolean => /^Merge\b/.test(c.subject) || (c.type === "chore" && c.scope === "release");

/** The changelog section for one release. Empty groups are left out. */
export function changelogSection(p: { version: string; date: string; commits: Commit[]; roadmap: RoadmapDone[] }): string {
  const lines: string[] = [`## ${p.version} - ${p.date}`, ""];
  const commits = p.commits.filter((c) => !isNoise(c));
  const breaking = commits.filter((c) => c.breaking);
  const item = (c: Commit) => `- ${c.scope ? `**${c.scope}:** ` : ""}${c.description} (${c.sha.slice(0, 7)})`;
  if (breaking.length) lines.push("### Breaking", ...breaking.map(item), "");
  for (const title of ORDER) {
    const rows = commits.filter((c) => !c.breaking && titleOf(c) === title);
    if (rows.length) lines.push(`### ${title}`, ...rows.map(item), "");
  }
  if (p.roadmap.length) lines.push("### Roadmap", ...p.roadmap.map((r) => `- ${r.title}`), "");
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/** A preview: what the release would contain. Reads only. */
export function planRelease(root: string, bump: Bump, opts: { date?: string } = {}): ReleasePlan {
  if (!BUMPS.includes(bump)) throw new UserError(`Bump must be one of: ${BUMPS.join(", ")}.`);
  const files = detectVersionFiles(root);
  const primary = primaryVersion(files);
  if (!primary) throw new UserError("There is no version file in this workspace (package.json, composer.json, pyproject.toml, Cargo.toml, app.json, pubspec.yaml or VERSION).");
  const version = bumpVersion(primary.version, bump);
  const range = rangeOf(root, { kind: "last-tag" });
  const tag = range.base.tag;
  const commits = range.commits.map((c) => parseCommit(c.sha, c.subject));
  const roadmap = range.roadmap;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const warnings: string[] = [];
  if (!tag) warnings.push("No version tag yet: the changelog covers the whole history (up to 300 commits).");
  if (tag && tag.replace(/^v/, "") !== primary.version) warnings.push(`The last tag is ${tag} but ${primary.file} says ${primary.version}.`);
  if (!commits.length && !roadmap.length) warnings.push("Nothing has changed since the last tag.");
  return {
    fromTag: tag,
    current: primary.version,
    version,
    tag: `v${version}`,
    bump,
    date,
    commits,
    roadmap,
    changelog: changelogSection({ version, date, commits, roadmap }),
    files: [...files.map((f) => f.file), "CHANGELOG.md"],
    warnings,
  };
}

/** Insert a section above the first existing one (under the "# Changelog" heading), or start the file. */
export function withSection(existing: string | null, section: string): string {
  if (existing === null || !existing.trim()) return `# Changelog\n\n${section}`;
  const at = existing.search(/^## /m);
  if (at < 0) return `${existing.replace(/\s*$/, "")}\n\n${section}`;
  return `${existing.slice(0, at)}${section}\n${existing.slice(at)}`;
}

/**
 * Refuses a tree with changes, except the paths in `allow` (a draft that is about to be published). Untracked files are
 * listed one by one, so a new folder shows its files rather than its name.
 */
export function assertCleanTree(root: string, allow: string[] = []): void {
  const status = gitIn(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) throw new UserError("This folder is not a git repository.");
  const dirty = status.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => !allow.includes(f));
  if (dirty.length) throw new UserError("Commit or stash your changes first: a release commit holds only the version bump and the changelog.");
}

export function assertNoTag(root: string, tag: string): void {
  if (gitIn(root, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).code === 0) throw new UserError(`The tag ${tag} already exists.`);
}

export interface ReleaseWrite {
  version: string;
  tag: string;
  /** The commit subject. */
  message: string;
  /** The CHANGELOG.md section to put above the existing ones. Null leaves CHANGELOG.md alone (a product note). */
  section: string | null;
  /** Other files to write (text) or remove (null), as repo-relative paths. */
  extra?: Array<{ file: string; text: string | null }>;
}

export interface WriteResult {
  commit: string;
  tag: string;
}

/**
 * Writes the version files, the changelog and any extra files, commits them and tags the commit. Any failure before the
 * commit puts every file back. A failure at the tag leaves the commit in place and says so.
 */
export function writeRelease(root: string, w: ReleaseWrite, files: VersionFile[]): WriteResult {
  const changelogPath = path.join(root, "CHANGELOG.md");
  const extra = w.extra ?? [];
  const tracked = [...files.map((f) => f.file), ...(w.section === null ? [] : ["CHANGELOG.md"]), ...extra.map((e) => e.file)];
  const originals = new Map<string, string | null>();
  for (const f of tracked) {
    const abs = path.join(root, f);
    originals.set(f, fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);
  }
  const restore = () => {
    for (const [file, text] of originals) {
      const abs = path.join(root, file);
      if (text === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, text);
    }
  };

  try {
    writeVersionFiles(root, files, w.version);
    if (w.section !== null) fs.writeFileSync(changelogPath, withSection(originals.get("CHANGELOG.md") ?? null, w.section));
    for (const e of extra) {
      const abs = path.join(root, e.file);
      if (e.text === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, e.text);
      }
    }
    const present = tracked.filter((f) => fs.existsSync(path.join(root, f)));
    const removed = extra.filter((e) => e.text === null).map((e) => e.file);
    if (present.length && gitIn(root, ["add", "-A", "--", ...present]).code !== 0) throw new Error("git add failed.");
    if (removed.length) gitIn(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...removed]);
    const commit = Bun.spawnSync(["git", "-C", root, "commit", "-m", w.message], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.toString().trim() || commit.stdout.toString().trim()}`);
  } catch (e) {
    gitIn(root, ["reset", "-q", "--", ...tracked]);
    restore();
    throw e;
  }
  const sha = gitIn(root, ["rev-parse", "HEAD"]).out.trim();
  const tag = Bun.spawnSync(["git", "-C", root, "tag", "-a", w.tag, "-m", w.tag], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (tag.exitCode !== 0) throw new Error(`git tag failed: ${tag.stderr.toString().trim()} (the release commit is in place; tag it by hand)`);
  return { commit: sha, tag: w.tag };
}

export interface CutResult {
  plan: ReleasePlan;
  commit: string;
  tag: string;
}

/** Write the version and the changelog, commit them, and tag the commit. Refuses a dirty tree or an existing tag. */
export function cutRelease(root: string, bump: Bump, opts: { date?: string } = {}): CutResult {
  const plan = planRelease(root, bump, opts);
  assertCleanTree(root);
  assertNoTag(root, plan.tag);
  const files = detectVersionFiles(root);
  const r = writeRelease(root, { version: plan.version, tag: plan.tag, message: `chore(release): ${plan.tag}`, section: plan.changelog }, files);
  return { plan, commit: r.commit, tag: r.tag };
}
