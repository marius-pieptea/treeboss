/**
 * Release records, kept as files in the repo, the same way ROADMAP.md and lab findings are:
 *
 *   releases/drafts/<version>.md   a draft the agent wrote (status: draft). Edited by the operator or by a revise.
 *   releases/<version>.md          a published release (status: published). Its notes are the CHANGELOG section.
 *   releases/products/<slug>-<date>.md   a combined note across a product's repos (a draft until `publishProductNote` publishes it).
 *
 * Each file opens with a front matter block of `key: value` lines. `publishDraft` moves a draft to releases/<version>.md,
 * prepends its notes to CHANGELOG.md, bumps the version files, commits "release: vX.Y.Z" and tags the commit. Pushing,
 * a GitHub release and a deploy are optional steps after the commit: a failure there is a warning, not a rollback.
 */
import fs from "fs";
import path from "path";
import { LaunchRefused, listTargets, runDeploy } from "../deploy/store";
import { assertCleanTree, assertNoTag, writeRelease } from "../deploy/release";
import { productWorkspaces, resolveProduct } from "../products/store";
import { Workspaces } from "../workspaces";
import { UserError } from "../util";
import { detectVersionFiles, gitIn, parseSemver, primaryVersion } from "./range";

export const RELEASES_DIR = "releases";
export const DRAFTS_DIR = path.join(RELEASES_DIR, "drafts");
export const PRODUCTS_DIR = path.join(RELEASES_DIR, "products");

export type DocStatus = "draft" | "published" | string;

/** A release record or a draft: its front matter and its notes (the Markdown body). */
export interface ReleaseDoc {
  version: string;
  /** Repo-relative path. */
  file: string;
  meta: Record<string, string>;
  body: string;
}

/* -------------------------------------------------------------------------- */
/* Front matter                                                               */
/* -------------------------------------------------------------------------- */

/** Splits a `---` front matter block off a Markdown file. Values are single-line strings. */
export function parseDoc(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    meta[key] = value.replace(/^"(.*)"$/, "$1");
  }
  // renderDoc puts a blank line after the front matter: it is layout, not part of the notes.
  return { meta, body: text.slice(m[0].length).replace(/^\r?\n+/, "") };
}

/** The front matter and the body, as one file. Values are written on one line. */
export function renderDoc(meta: Record<string, string>, body: string): string {
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${String(v).replace(/\s*\n\s*/g, " ").trim()}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "").replace(/\s*$/, "")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** A version as it appears in a file name. Only x.y.z with an optional -prerelease, so a name cannot escape the folder. */
export function assertVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new UserError(`"${version}" is not a version (x.y.z, or x.y.z-beta.1).`);
  return version;
}

function readDocs(root: string, dir: string): ReleaseDoc[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { meta, body } = parseDoc(fs.readFileSync(path.join(abs, f), "utf-8"));
      return { version: f.replace(/\.md$/, ""), file: path.join(dir, f).replace(/\\/g, "/"), meta, body };
    });
}

const bySemverDesc = (a: ReleaseDoc, b: ReleaseDoc) => {
  const x = parseSemver(a.version);
  const y = parseSemver(b.version);
  if (!x || !y) return a.version < b.version ? 1 : -1;
  return y.major - x.major || y.minor - x.minor || y.patch - x.patch || (y.pre ? 0 : 1) - (x.pre ? 0 : 1);
};

/** Published releases, newest version first. */
export function listReleases(root: string): ReleaseDoc[] {
  return readDocs(root, RELEASES_DIR)
    .filter((d) => d.meta.status === "published")
    .sort(bySemverDesc);
}

/** Drafts, newest version first. */
export function listDrafts(root: string): ReleaseDoc[] {
  return readDocs(root, DRAFTS_DIR).sort(bySemverDesc);
}

export function readDraft(root: string, version: string): ReleaseDoc | null {
  assertVersion(version);
  const file = path.join(DRAFTS_DIR, `${version}.md`);
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return null;
  const { meta, body } = parseDoc(fs.readFileSync(abs, "utf-8"));
  return { version, file: file.replace(/\\/g, "/"), meta, body };
}

/** The operator's edit: the notes change, the front matter stays. Only a draft can be edited. */
export function updateDraft(root: string, version: string, body: string): ReleaseDoc {
  const draft = readDraft(root, version);
  if (!draft) throw new UserError(`No draft ${version}.`);
  if (draft.meta.status !== "draft") throw new UserError(`${version} is ${draft.meta.status}: only a draft can be edited.`);
  fs.writeFileSync(path.join(root, draft.file), renderDoc(draft.meta, body));
  return { ...draft, body: body.replace(/^\n+/, "") };
}

/** The notes as a changelog section needs them: the leading heading is the release's own, so it goes. */
export function notesOf(body: string): string {
  return body.replace(/^\s*#{1,3} [^\n]*\n?/, "").replace(/^\n+/, "").replace(/\s*$/, "");
}

/* -------------------------------------------------------------------------- */
/* Publish                                                                    */
/* -------------------------------------------------------------------------- */

export interface PublishOpts {
  /** Push the commit and the tag to origin. */
  push?: boolean;
  /** Create a GitHub release with the notes (implies push: the tag must be on the remote). */
  ghRelease?: boolean;
  /** Deploy the environment with this name after the push. */
  deploy?: string | null;
  /** The package folder whose version files are bumped (repo-relative; "" or absent is the repo root). */
  package?: string | null;
  /** Override the date the entry is headed with (tests). */
  date?: string;
}

export interface PublishResult {
  version: string;
  tag: string;
  commit: string;
  pushed: boolean;
  releaseUrl: string | null;
  deployId: string | null;
  /** Steps that did not happen after the commit. The release itself is in place. */
  warnings: string[];
}

function hasOrigin(root: string): boolean {
  return gitIn(root, ["remote"]).out.split("\n").map((s) => s.trim()).includes("origin");
}

/** Pushes HEAD and the tag to origin. A failure is a warning: the release stays committed and tagged locally. */
function pushRelease(root: string, tag: string, warnings: string[]): boolean {
  const branch = gitIn(root, ["push", "origin", "HEAD"]);
  const tagged = branch.code === 0 ? gitIn(root, ["push", "origin", `refs/tags/${tag}`]) : branch;
  if (tagged.code === 0) return true;
  warnings.push(`The push failed: ${tagged.err.trim() || branch.err.trim()}. The release is committed and tagged locally.`);
  return false;
}

/**
 * Publishes a draft. Refuses a dirty tree (the draft itself is the one file allowed), a draft whose `from` version is no
 * longer the version on disk, and an existing tag. The commit and the tag are the point of no return: what fails after
 * them (the push, the GitHub release, the deploy) is reported in `warnings`.
 */
export function publishDraft(workspaceId: string, version: string, opts: PublishOpts = {}): PublishResult {
  const w = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  const root = w.path;
  const draft = readDraft(root, version);
  if (!draft) throw new UserError(`No draft ${version}. Draft one first.`);
  if (draft.meta.status !== "draft") throw new UserError(`${version} is ${draft.meta.status}: only a draft can be published.`);
  const tag = `v${version}`;
  const wantsPush = !!(opts.push || opts.ghRelease);
  if (wantsPush && !hasOrigin(root)) throw new UserError("There is no origin remote to push to.");
  if (opts.deploy && !listTargets(workspaceId).some((t) => t.env === opts.deploy)) throw new UserError(`No deploy target for "${opts.deploy}". Add one with trb deploy targets add.`);

  const files = detectVersionFiles(root, opts.package ?? draft.meta.package ?? "");
  const primary = primaryVersion(files);
  if (!primary) throw new UserError(`There is no version file in ${opts.package ?? draft.meta.package ?? "this workspace"}.`);
  if (draft.meta.from && draft.meta.from !== primary.version) throw new UserError(`The draft was written from ${draft.meta.from}, and ${primary.file} says ${primary.version} now. Draft again.`);
  assertCleanTree(root, [draft.file]);
  assertNoTag(root, tag);

  const warnings: string[] = [];
  const head = gitIn(root, ["rev-parse", "HEAD"]).out.trim();
  if (draft.meta.head && draft.meta.head !== head) warnings.push(`HEAD moved since the draft (${draft.meta.head.slice(0, 7)} to ${head.slice(0, 7)}): check the notes still cover the commits.`);

  const date = opts.date ?? draft.meta.date ?? new Date().toISOString().slice(0, 10);
  const notes = notesOf(draft.body);
  const record = renderDoc({ ...draft.meta, version, status: "published", date, tag, published_at: new Date().toISOString() }, `${notes}\n`);
  const written = writeRelease(
    root,
    {
      version,
      tag,
      message: `release: ${tag}`,
      section: `## ${version} - ${date}\n\n${notes}\n`,
      extra: [
        { file: path.join(RELEASES_DIR, `${version}.md`).replace(/\\/g, "/"), text: record },
        { file: draft.file, text: null },
      ],
    },
    files,
  );

  let releaseUrl: string | null = null;
  let deployId: string | null = null;
  const pushed = wantsPush && pushRelease(root, tag, warnings);
  if (opts.ghRelease) {
    if (!pushed) warnings.push("The GitHub release was skipped: the tag is not on the remote.");
    else {
      const r = Bun.spawnSync(["gh", "release", "create", tag, "--title", tag, "--notes-file", "-"], {
        cwd: root,
        stdin: Buffer.from(notes),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      });
      if (r.exitCode === 0) releaseUrl = r.stdout.toString().trim().split("\n").pop() || null;
      else warnings.push(`The GitHub release failed: ${r.stderr.toString().trim() || "gh is not signed in"}.`);
    }
  }
  if (opts.deploy) {
    const target = listTargets(workspaceId).find((t) => t.env === opts.deploy);
    if (!target) warnings.push(`No deploy target for ${opts.deploy}.`);
    else {
      try {
        deployId = runDeploy(target.id).id;
      } catch (e) {
        warnings.push(e instanceof LaunchRefused ? `${opts.deploy} is blocked by its launch checklists: deploy it from Ship with force.` : `The deploy did not start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { version, tag, commit: written.commit, pushed, releaseUrl, deployId, warnings };
}

export interface ProductPublishResult {
  /** Repo-relative path of the note, in the product's first repo. */
  file: string;
  tag: string;
  commit: string;
  pushed: boolean;
  warnings: string[];
}

/**
 * Publishes a product note through the same write path as a release: the note is marked published in place, committed
 * alone as "release: <slug> <date>" and tagged `product-<slug>-<date>`. It touches no version file and no CHANGELOG.md.
 * `name` is the file name without `.md`, as it is listed under releases/products/.
 */
export function publishProductNote(productId: string, name: string, opts: { push?: boolean } = {}): ProductPublishResult {
  const product = resolveProduct(productId);
  if (!product) throw new UserError(`No product "${productId}".`);
  const repo = productWorkspaces(product.id)[0];
  if (!repo) throw new UserError(`${product.name} has no repos. Attach a workspace to it first.`);
  const root = repo.path;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new UserError(`"${name}" is not a product note name.`);
  const file = path.join(PRODUCTS_DIR, `${name}.md`).replace(/\\/g, "/");
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) throw new UserError(`No product note ${name}.`);
  const { meta, body } = parseDoc(fs.readFileSync(abs, "utf-8"));
  if (meta.status !== "draft") throw new UserError(`${name} is ${meta.status ?? "not a draft"}: only a draft can be published.`);
  if (opts.push && !hasOrigin(root)) throw new UserError("There is no origin remote to push to.");
  const tag = `product-${name}`;
  assertCleanTree(root, [file]);
  assertNoTag(root, tag);
  const written = writeRelease(root, { version: name, tag, message: `release: ${product.slug} ${meta.date ?? name}`, section: null, extra: [{ file, text: renderDoc({ ...meta, status: "published", tag, published_at: new Date().toISOString() }, body) }] }, []);
  const warnings: string[] = [];
  const pushed = !!opts.push && pushRelease(root, tag, warnings);
  return { file, tag: written.tag, commit: written.commit, pushed, warnings };
}

export interface UndoOpts {
  /** Also delete the tag on origin. Off by default: a tag others may have fetched is not ours to remove silently. */
  deleteRemoteTag?: boolean;
}

export interface UndoResult {
  version: string;
  tag: string;
  /** The commit that was reverted: the release commit the tag pointed at. */
  reverted: string;
  revertCommit: string;
  tagRemoved: boolean;
  remoteTagDeleted: boolean;
  warnings: string[];
}

/** The subjects `publishDraft` (release: vX) and the quick cut (chore(release): vX) give a release commit. */
const isReleaseSubject = (subject: string, tag: string) => subject === `release: ${tag}` || subject === `chore(release): ${tag}`;

/**
 * Undoes a published release in the local repo: a revert commit for the release commit, then the tag removed. History is
 * kept, never rewritten, and nothing is force-pushed. The revert puts back the version files and CHANGELOG.md, removes the
 * published record and brings the draft back. The tag on origin is deleted only with `deleteRemoteTag` (a delete refspec,
 * not a force-push); otherwise the result warns that it is still there. A revert that conflicts is aborted and refused,
 * with the tag left in place.
 */
export function undoRelease(workspaceId: string, version: string, opts: UndoOpts = {}): UndoResult {
  const w = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  const root = w.path;
  assertVersion(version);
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const target = gitIn(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  if (target.code !== 0) throw new UserError(`No tag ${tag}: nothing to undo.`);
  const reverted = target.out.trim();
  const subject = gitIn(root, ["log", "-1", "--format=%s", reverted]).out.trim();
  if (!isReleaseSubject(subject, tag)) throw new UserError(`${tag} points at "${subject}", which is not a release commit. Remove the tag by hand if that is what you want.`);
  if (gitIn(root, ["merge-base", "--is-ancestor", reverted, "HEAD"]).code !== 0) throw new UserError(`The release commit ${reverted.slice(0, 7)} is not on the current branch.`);
  if (opts.deleteRemoteTag && !hasOrigin(root)) throw new UserError("There is no origin remote to delete the tag from.");
  assertCleanTree(root);

  const revert = gitIn(root, ["revert", "--no-edit", reverted]);
  if (revert.code !== 0) {
    gitIn(root, ["revert", "--abort"]);
    throw new UserError(`The release commit could not be reverted cleanly (later changes touch the same files): ${revert.err.trim() || revert.out.trim()}. Nothing was changed.`);
  }
  const revertCommit = gitIn(root, ["rev-parse", "HEAD"]).out.trim();
  const warnings: string[] = [];
  const tagRemoved = gitIn(root, ["tag", "-d", tag]).code === 0;
  if (!tagRemoved) warnings.push(`The tag ${tag} could not be removed: delete it with git tag -d ${tag}.`);

  let remoteTagDeleted = false;
  const remoteHasTag = hasOrigin(root) && gitIn(root, ["ls-remote", "--tags", "origin", ref]).out.trim() !== "";
  if (opts.deleteRemoteTag) {
    const del = gitIn(root, ["push", "origin", `:${ref}`]);
    if (del.code === 0) remoteTagDeleted = true;
    else warnings.push(`The tag ${tag} could not be deleted on origin: ${del.err.trim()}.`);
  } else if (remoteHasTag) {
    warnings.push(`The remote tag ${tag} is still on origin. Delete it with: git push origin :${ref}, or undo again with the remote flag.`);
  }
  return { version, tag, reverted, revertCommit, tagRemoved, remoteTagDeleted, warnings };
}
