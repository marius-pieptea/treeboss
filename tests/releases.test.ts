/** Release ranges, version files, the drafted-notes prompt, publish, and the release routes, in throwaway git repos. */
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { makeCtx } from "../src/daemon/http";
import { releasesRoutes } from "../src/daemon/routes/releases";
import { UserError } from "../src/util";
import { Workspaces } from "../src/workspaces";
import { attachWorkspace, createProduct } from "../src/products/store";
import { listTargets } from "../src/deploy/store";
import { cutRelease, planRelease } from "../src/deploy/release";
import { changelogPrompt, startChangelogSession } from "../src/releases/draft";
import { candidates, detectVersionFiles, listPackageRoots, nextVersion, parseBase, rangeOf, readVersionFile, renderVersion, resolveBase, suggestBump, writeVersionFiles, type VersionFile } from "../src/releases/range";
import { listDrafts, listReleases, parseDoc, publishDraft, publishProductNote, undoRelease, readDraft, renderDoc, updateDraft } from "../src/releases/store";
import { setTurnRunner } from "../src/sessions/manager";
import { makeRepo, resetState } from "./helpers";
import { db } from "../src/db";

beforeEach(() => {
  resetState();
  listTargets("none");
  db().exec("DELETE FROM deploys; DELETE FROM deploy_targets;");
});

/** git in `cwd` with a fixed identity; a non-zero exit throws with git's own message. */
function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A commit with its author and committer dates fixed, so `--date` ranges are deterministic. */
function commitAt(cwd: string, message: string, isoDate: string, files: Record<string, string> = {}): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
  g(cwd, "add", "-A");
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
  if (r.status !== 0) throw new Error(`commit: ${r.stderr}`);
  return g(cwd, "rev-parse", "HEAD");
}

/** A repo with v1.0.0 at 2026-01-10 and three commits after it, the last of them on 2026-03-01. */
function history(extra: Record<string, string> = {}) {
  const dir = makeRepo({ "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2) + "\n", "CHANGELOG.md": "# Changelog\n\n## 1.0.0 - 2026-01-10\n\n- start\n", ...extra });
  g(dir, "config", "commit.gpgsign", "false");
  g(dir, "config", "user.email", "t@t");
  g(dir, "config", "user.name", "t");
  // makeRepo committed at "now"; re-date the root so the date-based range has a clear before and after.
  const first = commitAt(dir, "chore: start", "2026-01-10T12:00:00Z", { "a.txt": "0\n" });
  g(dir, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
  const feat = commitAt(dir, "feat(ui): add the range picker\n\nPicks the base point.", "2026-02-05T09:00:00Z", { "web/range.tsx": "x\n" });
  const fix = commitAt(dir, "fix: rollback label", "2026-02-20T09:00:00Z", { "a.txt": "2\n" });
  const last = commitAt(dir, "feat!: drop the old release dialog\n\nBREAKING CHANGE: the dialog is gone.", "2026-03-01T09:00:00Z", { "web/old.tsx": "y\n" });
  return { dir, first, feat, fix, last };
}

/* -------------------------------------------------------------------------- */
/* Ranges                                                                     */
/* -------------------------------------------------------------------------- */

describe("ranges", () => {
  test("the last tag is the default base, and the range runs from it to HEAD", () => {
    const { dir, feat, fix, last } = history();
    const r = rangeOf(dir);
    expect(r.base.kind).toBe("last-tag");
    expect(r.base.tag).toBe("v1.0.0");
    expect(r.commits.map((c) => c.sha)).toEqual([last, fix, feat]);
    const feature = r.commits.find((c) => c.sha === feat)!;
    expect(feature.subject).toBe("feat(ui): add the range picker");
    expect(feature.body).toBe("Picks the base point.");
    expect(feature.author).toBe("t");
    expect(feature.files).toEqual(["web/range.tsx"]);
    expect(feature.date).toBe("2026-02-05T09:00:00Z");
  });

  test("a tag, a sha and a date each start the range where they point", () => {
    const { dir, feat, fix, last, first } = history();
    expect(rangeOf(dir, { kind: "tag", ref: "v1.0.0" }).commits.length).toBe(3);
    expect(rangeOf(dir, parseBase(feat.slice(0, 7))).commits.map((c) => c.sha)).toEqual([last, fix]);
    expect(rangeOf(dir, parseBase(feat)).base.sha).toBe(feat);
    // The last commit before 2026-02-01 is the start commit: the range is everything after it.
    const byDate = rangeOf(dir, parseBase("2026-02-01"));
    expect(byDate.base.sha).toBe(first);
    expect(byDate.commits.length).toBe(4 - 1);
    expect(parseBase("2026-02-01")).toEqual({ kind: "date", ref: "2026-02-01" });
    expect(parseBase("v2.0.0")).toEqual({ kind: "tag", ref: "v2.0.0" });
    expect(parseBase("")).toEqual({ kind: "last-tag" });
  });

  test("an unknown tag or sha is refused with the tags it has", () => {
    const { dir } = history();
    expect(() => resolveBase(dir, { kind: "tag", ref: "v9.9.9" })).toThrow(UserError);
    expect(() => resolveBase(dir, { kind: "sha", ref: "deadbeef" })).toThrow(UserError);
  });

  test("a repo with no tag covers its whole history, with a warning", () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ name: "x", version: "0.1.0" }) + "\n" });
    const r = rangeOf(dir);
    expect(r.base.sha).toBeNull();
    expect(r.commits.length).toBe(1);
    expect(r.warnings.join(" ")).toContain("whole history");
  });

  test("breaking changes are flagged and suggest a major; the diff stat and spec tasks come from the range", () => {
    const { dir, last } = history({ "specs/119-x/tasks.md": "- [ ] T001 first\n- [ ] T002 second\n" });
    const r = rangeOf(dir);
    expect(r.breaking.join(" ")).toContain("drop the old release dialog");
    expect(suggestBump(r)).toEqual({ bump: "major", reason: "1 breaking change" });
    expect(r.diff.files).toBeGreaterThan(0);
    expect(r.commits.find((c) => c.sha === last)).toBeDefined();
    // Tick T001 after the tag: it is the only task newly done in the range.
    commitAt(dir, "docs: tick", "2026-03-02T09:00:00Z", { "specs/119-x/tasks.md": "- [x] T001 first\n- [ ] T002 second\n" });
    const after = rangeOf(dir);
    expect(after.specs).toEqual([{ feature: "specs/119-x", done: 1, total: 2, newlyDone: ["T001"] }]);
    expect(suggestBump(after).bump).toBe("major");
  });
});

/* -------------------------------------------------------------------------- */
/* Versions                                                                   */
/* -------------------------------------------------------------------------- */

describe("version files", () => {
  const vf = (file: string, text: string): VersionFile => {
    const found = readVersionFile(file, text);
    if (!found) throw new Error(`no version in ${file}`);
    return found;
  };

  test("package.json and composer.json: the version key changes, the rest of the file does not", () => {
    const pkg = '{\n  "name": "demo",\n  "version": "1.0.0",\n  "private": true\n}\n';
    expect(renderVersion(vf("package.json", pkg), pkg, "1.0.1")).toBe(pkg.replace('"1.0.0"', '"1.0.1"'));
    const composer = '{"name":"acme/demo","version":"2.3.4","require":{"php":">=8.2"}}';
    expect(renderVersion(vf("composer.json", composer), composer, "2.4.0")).toBe(composer.replace("2.3.4", "2.4.0"));
  });

  test("pyproject.toml and Cargo.toml change the version under their own section only", () => {
    const py = '[build-system]\nrequires = ["setuptools"]\nversion = "0.0.1"\n\n[project]\nname = "demo"\nversion = "1.2.3"\n\n[tool.x]\nversion = "9.9.9"\n';
    expect(vf("pyproject.toml", py).version).toBe("1.2.3");
    expect(renderVersion(vf("pyproject.toml", py), py, "1.3.0")).toBe(py.replace('version = "1.2.3"', 'version = "1.3.0"'));
    const cargo = '[package]\nname = "demo"\nversion = "0.4.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n';
    expect(renderVersion(vf("Cargo.toml", cargo), cargo, "0.5.0")).toBe(cargo.replace('version = "0.4.0"', 'version = "0.5.0"'));
  });

  test("app.json: expo.version, and the iOS buildNumber and Android versionCode each go up by one", () => {
    const app = '{\n  "expo": {\n    "name": "demo",\n    "version": "1.4.0",\n    "ios": { "bundleIdentifier": "com.x", "buildNumber": "17" },\n    "android": { "package": "com.x", "versionCode": 22 }\n  }\n}\n';
    const found = vf("app.json", app);
    expect(found).toMatchObject({ stack: "expo", version: "1.4.0", builds: [{ key: "ios.buildNumber", value: 17 }, { key: "android.versionCode", value: 22 }] });
    const next = renderVersion(found, app, "1.5.0");
    expect(next).toBe(app.replace('"version": "1.4.0"', '"version": "1.5.0"').replace('"buildNumber": "17"', '"buildNumber": "18"').replace('"versionCode": 22', '"versionCode": 23'));
  });

  test("app.config.ts keeps its literals, and a pubspec keeps its build number in step", () => {
    const cfg = "export default {\n  name: 'demo',\n  version: '2.0.0',\n  ios: { buildNumber: '5' },\n  android: { versionCode: 9 },\n};\n";
    const next = renderVersion(vf("app.config.ts", cfg), cfg, "2.1.0");
    expect(next).toBe(cfg.replace("'2.0.0'", "'2.1.0'").replace("'5'", "'6'").replace("versionCode: 9", "versionCode: 10"));
    const pub = "name: demo\nversion: 1.0.0+4\ndescription: x\n";
    expect(vf("pubspec.yaml", pub)).toMatchObject({ version: "1.0.0", builds: [{ key: "build", value: 4 }] });
    expect(renderVersion(vf("pubspec.yaml", pub), pub, "1.1.0")).toBe("name: demo\nversion: 1.1.0+5\ndescription: x\n");
  });

  test("a VERSION file is one line, and a folder's files are all written with the same version", () => {
    const dir = makeRepo({
      "package.json": '{"name":"a","version":"3.0.0"}\n',
      "VERSION": "3.0.0\n",
      "pyproject.toml": '[project]\nname = "a"\nversion = "3.0.0"\n',
    });
    const files = detectVersionFiles(dir);
    expect(files.map((f) => f.file)).toEqual(["package.json", "pyproject.toml", "VERSION"]);
    expect(writeVersionFiles(dir, files, "3.1.0")).toEqual(["package.json", "pyproject.toml", "VERSION"]);
    expect(fs.readFileSync(path.join(dir, "VERSION"), "utf-8")).toBe("3.1.0\n");
    expect(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8")).toContain('version = "3.1.0"');
  });

  test("semver: plain bumps, and prereleases count up within a preid", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersion("1.2.3", "prerelease")).toBe("1.2.4-beta.1");
    expect(nextVersion("1.2.4-beta.1", "prerelease")).toBe("1.2.4-beta.2");
    expect(nextVersion("1.2.4-beta.2", "prerelease")).toBe("1.2.4-beta.3");
    expect(nextVersion("1.2.4-beta.3", "release")).toBe("1.2.4");
    expect(nextVersion("1.2.4-beta.3", "prerelease")).toBe("1.2.4-beta.4");
    expect(candidates("1.2.3")).toEqual({ patch: "1.2.4", minor: "1.3.0", major: "2.0.0", prerelease: "1.2.4-beta.1" });
    expect(() => nextVersion("latest", "patch")).toThrow(UserError);
  });

  test("a prerelease with another preid starts its own .1 on the same version", () => {
    expect(nextVersion("1.3.0-beta.4", "prerelease", "rc")).toBe("1.3.0-rc.1");
    expect(nextVersion("1.3.0-rc.1", "prerelease", "rc")).toBe("1.3.0-rc.2");
  });
});

/* -------------------------------------------------------------------------- */
/* The draft prompt                                                           */
/* -------------------------------------------------------------------------- */

describe("the changelog prompt", () => {
  test("carries the range compactly, the candidate versions, the audience, the front matter and the rules", () => {
    const { dir } = history();
    // Checked after the tag, so it is newly done in the range.
    commitAt(dir, "docs: roadmap", "2026-03-02T09:00:00Z", { "ROADMAP.md": "# Demo\n\n## Now\n\n- [x] Ship it {#r1}\n" });
    const range = rangeOf(dir);
    const prompt = changelogPrompt({ workspace: "demo", range, current: "1.0.0", bump: "auto", audience: "users", date: "2026-10-28", token: "tok123" });
    expect(prompt).toContain("releases/drafts/<version>.md");
    expect(prompt).toContain("status: draft");
    expect(prompt).toContain("draft: tok123");
    expect(prompt).toContain("Do not tag, bump any version file, commit or push");
    expect(prompt).toContain("minor 1.1.0");
    expect(prompt).toContain("The bump is yours to propose");
    expect(prompt).toContain("drop the old release dialog");
    expect(prompt).toContain("Breaking hints");
    expect(prompt).toContain("Added");
    expect(prompt).toContain("Audience: users");
    expect(prompt).not.toContain("### Developer notes");
    expect(prompt).toContain("Ship it");
    expect(prompt).toContain(range.commits[0]!.sha.slice(0, 7));
  });

  test("a fixed bump fixes the version in the front matter, and developers get developer notes", () => {
    const { dir } = history();
    const prompt = changelogPrompt({ workspace: "demo", range: rangeOf(dir), current: "1.0.0", bump: "minor", audience: "both", date: "2026-10-28", token: "t" });
    expect(prompt).toContain("The bump is fixed: minor, so the version is 1.1.0");
    expect(prompt).toContain("version: 1.1.0");
    expect(prompt).toContain("### Developer notes");
  });

  test("a long history is cut to the first commits, with the rest named", () => {
    const { dir } = history();
    const range = rangeOf(dir);
    const many = { ...range, commits: Array.from({ length: 200 }, (_, i) => ({ ...range.commits[0]!, sha: String(i).padStart(40, "a"), subject: `fix: n${i}` })) };
    const prompt = changelogPrompt({ workspace: "demo", range: many, current: "1.0.0", bump: "auto", audience: "users", date: "2026-10-28", token: "t" });
    expect(prompt).toContain("… 80 more");
    expect(prompt).not.toContain("fix: n150");
  });
});

/* -------------------------------------------------------------------------- */
/* The quick path and publish                                                 */
/* -------------------------------------------------------------------------- */

function draftFile(dir: string, version: string, meta: Record<string, string>, body: string) {
  fs.mkdirSync(path.join(dir, "releases/drafts"), { recursive: true });
  const file = path.join(dir, `releases/drafts/${version}.md`);
  fs.writeFileSync(file, renderDoc({ version, status: "draft", from: "1.0.0", date: "2026-10-28", bump: "minor", reason: "a feature", ...meta }, body));
  return file;
}

describe("publish", () => {
  test("publish bumps the version, prepends the notes, moves the draft, commits and tags", () => {
    const { dir, feat } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0", { base: "v1.0.0" },"# 1.1.0 draft heading\n\n### Added\n- The range picker.\n\n### Fixed\n- The rollback label.\n");
    const r = publishDraft(id, "1.1.0", { date: "2026-10-28" });
    expect(r).toMatchObject({ version: "1.1.0", tag: "v1.1.0", pushed: false, releaseUrl: null, deployId: null, warnings: [] });

    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.1.0");
    const changelog = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8");
    expect(changelog).toMatch(/^# Changelog\n\n## 1\.1\.0 - 2026-10-28\n\n### Added\n- The range picker\.\n\n### Fixed\n- The rollback label\.\n\n## 1\.0\.0 - 2026-01-10/);

    expect(fs.existsSync(path.join(dir, "releases/drafts/1.1.0.md"))).toBe(false);
    const record = parseDoc(fs.readFileSync(path.join(dir, "releases/1.1.0.md"), "utf-8"));
    expect(record.meta).toMatchObject({ version: "1.1.0", status: "published", tag: "v1.1.0", date: "2026-10-28", base: "v1.0.0" });
    expect(record.body).toContain("### Added");
    expect(listReleases(dir).map((d) => d.version)).toEqual(["1.1.0"]);
    expect(listDrafts(dir)).toEqual([]);

    expect(g(dir, "log", "-1", "--format=%s")).toBe("release: v1.1.0");
    expect(g(dir, "cat-file", "-t", "v1.1.0")).toBe("tag");
    expect(g(dir, "status", "--porcelain")).toBe("");
    expect(feat).toBeTruthy();
  });

  test("a dirty tree is refused, and nothing is written", () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0", {}, "### Added\n- A thing.\n");
    fs.writeFileSync(path.join(dir, "scratch.txt"), "not committed\n");
    expect(() => publishDraft(id, "1.1.0", { date: "2026-10-28" })).toThrow(/Commit or stash your changes first/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.0.0");
    expect(fs.existsSync(path.join(dir, "releases/drafts/1.1.0.md"))).toBe(true);
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("");
  });

  test("a draft that is not the only change is refused: a tracked edit makes the tree dirty", () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0", {}, "### Added\n- A thing.\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
    expect(() => publishDraft(id, "1.1.0", { date: "2026-10-28" })).toThrow(UserError);
  });

  test("a draft written from an older version, or with no origin to push to, is refused before anything is written", () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0", { from: "0.9.0" }, "### Added\n- A thing.\n");
    expect(() => publishDraft(id, "1.1.0", { date: "2026-10-28" })).toThrow(/written from 0\.9\.0/);
    draftFile(dir, "1.1.0", {}, "### Added\n- A thing.\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-qm", "docs: draft");
    expect(() => publishDraft(id, "1.1.0", { date: "2026-10-28", push: true })).toThrow(/no origin remote/);
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("");
  });

  test("a prerelease publishes as its own version and tag", () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0-beta.1", { bump: "prerelease", reason: "first beta" }, "### Added\n- The beta.\n");
    const r = publishDraft(id, "1.1.0-beta.1", { date: "2026-10-28" });
    expect(r.tag).toBe("v1.1.0-beta.1");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.1.0-beta.1");
    expect(g(dir, "tag", "-l", "v1.1.0-beta.1")).toBe("v1.1.0-beta.1");
    // The next draft of the same preid counts up from the version on disk.
    expect(nextVersion("1.1.0-beta.1", "prerelease")).toBe("1.1.0-beta.2");
    expect(planRelease(dir, "patch", { date: "2026-10-28" }).version).toBe("1.1.1");
  });

  test("an existing draft can be edited, and a published one cannot", () => {
    const { dir } = history();
    draftFile(dir, "1.1.0", {}, "### Added\n- A thing.\n");
    expect(updateDraft(dir, "1.1.0", "### Fixed\n- Changed it.\n").body).toBe("### Fixed\n- Changed it.\n");
    expect(readDraft(dir, "1.1.0")!.meta.status).toBe("draft");
    expect(readDraft(dir, "1.1.0")!.body).toBe("### Fixed\n- Changed it.\n");
    draftFile(dir, "1.2.0", { status: "published" }, "x\n");
    expect(() => updateDraft(dir, "1.2.0", "y")).toThrow(/only a draft/);
  });

  test("the quick cut still writes the same version, changelog and tag through the shared path", () => {
    const { dir } = history();
    const cut = cutRelease(dir, "minor", { date: "2026-10-28" });
    expect(cut.tag).toBe("v1.1.0");
    expect(g(dir, "log", "-1", "--format=%s")).toBe("chore(release): v1.1.0");
    expect(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")).toMatch(/^# Changelog\n\n## 1\.1\.0 - 2026-10-28/);
  });
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

describe("monorepo package roots", () => {
  function monorepo() {
    const dir = makeRepo({
      "package.json": JSON.stringify({ name: "root", version: "0.0.0", workspaces: ["packages/*"] }, null, 2) + "\n",
      "packages/app/package.json": JSON.stringify({ name: "app", version: "2.0.0" }, null, 2) + "\n",
      "packages/lib/package.json": JSON.stringify({ name: "lib", version: "3.1.0" }, null, 2) + "\n",
      "packages/notes/README.md": "no manifest\n",
    });
    g(dir, "config", "core.autocrlf", "false");
    return dir;
  }

  test("package roots come from the workspaces globs, and only folders with a version file count", () => {
    const dir = monorepo();
    expect(listPackageRoots(dir)).toEqual(["", "packages/app", "packages/lib"]);
    expect(detectVersionFiles(dir, "packages/app").map((f) => [f.file, f.version])).toEqual([["packages/app/package.json", "2.0.0"]]);
    expect(detectVersionFiles(dir).map((f) => f.version)).toEqual(["0.0.0"]);
    expect(() => detectVersionFiles(dir, "../outside")).toThrow(UserError);
  });

  test("publish with a package bumps that folder's manifest and leaves the root alone", () => {
    const dir = monorepo();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "2.1.0", { from: "2.0.0" }, "### Added\n- A thing.\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-qm", "docs: draft");
    const r = publishDraft(id, "2.1.0", { date: "2026-10-28", package: "packages/app" });
    expect(r.tag).toBe("v2.1.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "packages/app/package.json"), "utf-8")).version).toBe("2.1.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("0.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "packages/lib/package.json"), "utf-8")).version).toBe("3.1.0");
    expect(g(dir, "status", "--porcelain")).toBe("");
  });
});

describe("product note publish", () => {
  function productWithNote(status = "draft") {
    const { dir } = history();
    const w = Workspaces.open(dir);
    const product = createProduct({ name: "Acme Pay" });
    attachWorkspace(product.id, w.id, "web");
    const file = `releases/products/${product.slug}-2026-10-28.md`;
    fs.mkdirSync(path.join(dir, "releases/products"), { recursive: true });
    fs.writeFileSync(path.join(dir, file), renderDoc({ product: product.name, date: "2026-10-28", status, draft: "abc" }, "### Added\n- One checkout.\n"));
    return { dir, product, file };
  }

  test("publishing marks the note published, commits only that file and tags the commit", () => {
    const { dir, product, file } = productWithNote();
    const r = publishProductNote(product.id, `${product.slug}-2026-10-28`);
    expect(r).toMatchObject({ file, tag: `product-${product.slug}-2026-10-28`, pushed: false, warnings: [] });
    const note = parseDoc(fs.readFileSync(path.join(dir, file), "utf-8"));
    expect(note.meta).toMatchObject({ status: "published", tag: r.tag });
    expect(note.body).toContain("One checkout.");
    expect(g(dir, "log", "-1", "--format=%s")).toBe(`release: ${product.slug} 2026-10-28`);
    expect(g(dir, "show", "--name-only", "--format=", "HEAD")).toBe(file);
    expect(g(dir, "cat-file", "-t", r.tag)).toBe("tag");
    expect(g(dir, "status", "--porcelain")).toBe("");
  });

  test("a published note or an unknown one is refused", () => {
    const { product } = productWithNote("published");
    expect(() => publishProductNote(product.id, `${product.slug}-2026-10-28`)).toThrow(/only a draft/);
    expect(() => publishProductNote(product.id, "nope-2026-01-01")).toThrow(/No product note/);
  });
});

describe("undo of a published release", () => {
  function published() {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    draftFile(dir, "1.1.0", { base: "v1.0.0" }, "### Added\n- A thing.\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-qm", "docs: draft");
    const before = g(dir, "rev-parse", "HEAD^{tree}");
    publishDraft(id, "1.1.0", { date: "2026-10-28" });
    return { dir, id, before };
  }

  function withOrigin(dir: string, name: string) {
    const remote = path.join(path.dirname(dir), `${path.basename(dir)}-${name}.git`);
    g(path.dirname(dir), "init", "-q", "--bare", remote);
    g(dir, "remote", "add", "origin", remote);
    g(dir, "push", "-q", "origin", "HEAD", "refs/tags/v1.1.0");
  }

  test("undo reverts the release commit and removes the tag, leaving the pre-release tree", () => {
    const { dir, id, before } = published();
    const r = undoRelease(id, "1.1.0");
    expect(r).toMatchObject({ version: "1.1.0", tag: "v1.1.0", tagRemoved: true, remoteTagDeleted: false, warnings: [] });
    expect(g(dir, "rev-parse", "HEAD^{tree}")).toBe(before);
    expect(g(dir, "rev-parse", "HEAD")).toBe(r.revertCommit);
    expect(g(dir, "log", "-1", "--format=%s")).toBe('Revert "release: v1.1.0"');
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.0.0");
    expect(listReleases(dir)).toEqual([]);
    expect(listDrafts(dir).map((d) => d.version)).toEqual(["1.1.0"]);
    expect(g(dir, "status", "--porcelain")).toBe("");
  });

  test("an unknown tag, a tag that is not a release commit and a dirty tree are refused", () => {
    const { dir, id } = published();
    expect(() => undoRelease(id, "9.9.9")).toThrow(/No tag v9\.9\.9/);
    g(dir, "tag", "-a", "v1.0.5", "-m", "x", "HEAD~1");
    expect(() => undoRelease(id, "1.0.5")).toThrow(/not a release commit/);
    fs.writeFileSync(path.join(dir, "scratch.txt"), "x\n");
    expect(() => undoRelease(id, "1.1.0")).toThrow(/Commit or stash/);
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("v1.1.0");
  });

  test("without the flag the remote tag stays, and the result says so", () => {
    const { dir, id } = published();
    withOrigin(dir, "keep");
    const r = undoRelease(id, "1.1.0");
    expect(r.remoteTagDeleted).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/v1\.1\.0 is still on origin/);
    expect(g(dir, "ls-remote", "--tags", "origin")).toContain("refs/tags/v1.1.0");
  });

  test("with the flag the remote tag is deleted too, and a missing origin is refused first", () => {
    const { dir, id } = published();
    expect(() => undoRelease(id, "1.1.0", { deleteRemoteTag: true })).toThrow(/no origin remote/);
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("v1.1.0");
    withOrigin(dir, "drop");
    const r = undoRelease(id, "1.1.0", { deleteRemoteTag: true });
    expect(r.remoteTagDeleted).toBe(true);
    expect(g(dir, "ls-remote", "--tags", "origin")).not.toContain("v1.1.0");
  });

  test("the undo route reverts the release", async () => {
    const { dir, id } = published();
    const res = (await (await call("POST", `/api/releases/${id}/releases/1.1.0/undo`, {}))!.json()) as { tagRemoved: boolean };
    expect(res.tagRemoved).toBe(true);
    expect(g(dir, "tag", "-l", "v1.1.0")).toBe("");
  });
});

describe("the changelog session", () => {
  test("a draft session records its token, and the prompt it was given carries that token", async () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    const prompts: string[] = [];
    setTurnRunner(async (opts: any) => {
      prompts.push(opts.prompt);
      return { success: true, output: "ok", sessionId: "cli-x", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" } as any;
    });
    try {
      const started = startChangelogSession(id, { bump: "minor", audience: "developers" });
      expect(started.version).toBe("1.1.0");
      expect(started.token).toMatch(/^[0-9a-f]{12}$/);
      expect(started.commits).toBe(3);
      // The run is asynchronous: give the turn a moment to reach the runner.
      for (let i = 0; i < 50 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(prompts[0]).toContain(`draft: ${started.token}`);
      expect(prompts[0]).toContain("The bump is fixed: minor");
    } finally {
      setTurnRunner(null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

async function call(method: string, url: string, body: Record<string, any> = {}): Promise<Response | null> {
  const u = new URL(url, "http://daemon.test");
  return releasesRoutes(makeCtx(new Request(u, { method }), u, body));
}

describe("routes", () => {
  test("the range, the drafts and the publish over HTTP", async () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    const range = (await (await call("GET", `/api/releases/${id}/range?base=`))!.json()) as { range: { commits: unknown[]; base: { label: string } } };
    expect(range.range.base.label).toBe("v1.0.0");
    expect(range.range.commits.length).toBe(3);

    draftFile(dir, "1.1.0", {}, "### Added\n- A thing.\n");
    const view = (await (await call("GET", `/api/releases/${id}`))!.json()) as { drafts: Array<{ version: string }>; version: { version: string; candidates: { minor: string } } };
    expect(view.drafts.map((d) => d.version)).toEqual(["1.1.0"]);
    expect(view.version).toMatchObject({ version: "1.0.0", candidates: { minor: "1.1.0" } });

    const put = await call("PUT", `/api/releases/${id}/drafts/1.1.0`, { body: "### Fixed\n- Better.\n" });
    expect(((await put!.json()) as { draft: { body: string } }).draft.body).toBe("### Fixed\n- Better.\n");

    const pub = (await (await call("POST", `/api/releases/${id}/drafts/1.1.0/publish`, {}))!.json()) as { tag: string; pushed: boolean };
    expect(pub).toMatchObject({ tag: "v1.1.0", pushed: false });
    expect(listReleases(dir)[0]!.version).toBe("1.1.0");
    await expect(call("POST", `/api/releases/${id}/drafts/not-a-version/publish`, {})).rejects.toThrow();
  });

  test("a bad bump or audience is refused", async () => {
    const { dir } = history();
    const id = Workspaces.open(dir).id;
    await expect(call("POST", `/api/releases/${id}/draft`, { bump: "huge" })).rejects.toThrow();
    await expect(call("POST", `/api/releases/${id}/draft`, { audience: "pirates" })).rejects.toThrow();
  });

  test("the tag listing and the version of a workspace with no commits yet read cleanly", () => {
    const { dir } = history();
    expect(detectVersionFiles(dir).map((f) => f.file)).toEqual(["package.json"]);
    expect(resolveBase(dir, parseBase("v1.0.0")).sha).toBeTruthy();
    expect(() => startChangelogSession(Workspaces.open(dir).id, { bump: "huge" as any })).toThrow(UserError);
  });
});
