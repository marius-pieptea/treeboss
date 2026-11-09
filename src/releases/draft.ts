/**
 * Agent-drafted release notes. A changelog session reads a release range (src/releases/range.ts) and writes one draft to
 * releases/drafts/<version>.md; it never tags, bumps, commits or pushes. Publishing is a separate step (store.ts).
 *
 * The draft is linked to its session by a token written into its front matter (`draft:`), so a revise can find the
 * session that wrote it. Sessions are recorded in the release_sessions table, created on first use.
 */
import path from "path";
import { randomBytes } from "crypto";
import { db } from "../db";
import { createLead, getSession, send } from "../sessions/manager";
import { productWorkspaces, resolveProduct } from "../products/store";
import { Workspaces } from "../workspaces";
import { UserError } from "../util";
import { candidates, detectVersionFiles, nextVersion, parseBase, primaryVersion, rangeOf, suggestBump, type Range, type ReleaseBump } from "./range";
import { DRAFTS_DIR, listReleases, PRODUCTS_DIR, readDraft } from "./store";

export const AUDIENCES = ["users", "developers", "both"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** How many commits the prompt lists. The rest are one `git log` away, so the prompt stays compact. */
export const PROMPT_COMMITS = 120;

const today = () => new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

const AUDIENCE_RULES: Record<Audience, string> = {
  users: "Write for the people who use the product: plain words, what they can now do or what no longer goes wrong. No commit hashes, file paths or internals.",
  developers: "Write for the developers who run or integrate it: name the modules, config keys, commands and API routes that changed. Keep the short hashes in brackets.",
  both: "Write the user notes first. Then a `### Developer notes` section with the technical detail and short hashes in brackets.",
};

export interface ChangelogPromptInput {
  workspace: string;
  range: Range;
  /** The version the version files say now. */
  current: string;
  /** "auto" leaves the bump to the agent; anything else fixes the version. */
  bump: ReleaseBump;
  audience: Audience;
  date: string;
  /** Written into the draft's front matter, so a revise can find this session. */
  token: string;
}

/**
 * The prompt a changelog session gets: the range data, compact, and what to write. Pure: the range is read beforehand.
 */
export function changelogPrompt(p: ChangelogPromptInput): string {
  const cands = candidates(p.current);
  const fixed = p.bump === "auto" ? null : nextVersion(p.current, p.bump);
  const suggestion = suggestBump(p.range);
  const r = p.range;
  const shown = r.commits.slice(0, PROMPT_COMMITS);
  const more = r.commits.length - shown.length;
  const lines: string[] = [];
  lines.push(`You are drafting the release notes for ${p.workspace}. Read the code if you need to. Do not tag, bump any version file, commit or push anything. Write exactly one file: the draft named below.`);
  lines.push("");
  lines.push(`## Range`);
  lines.push(`From ${r.base.label}${r.base.sha ? ` (${r.base.sha.slice(0, 7)})` : " (the whole history)"} to HEAD ${r.head.sha.slice(0, 7)}${r.head.branch ? ` on ${r.head.branch}` : ""}. ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}.`);
  lines.push(`Current version: ${p.current}.`);
  lines.push(`Versions by bump: patch ${cands.patch}, minor ${cands.minor}, major ${cands.major}, prerelease ${cands.prerelease}.`);
  if (fixed) lines.push(`The bump is fixed: ${p.bump}, so the version is ${fixed}. Use it. Say in \`reason\` whether you agree.`);
  else lines.push(`The bump is yours to propose. From the commits alone it looks like ${suggestion.bump} (${suggestion.reason}). Decide from what the changes do, then name the file with that bump's version.`);
  lines.push(`Audience: ${p.audience}. ${AUDIENCE_RULES[p.audience]}`);
  lines.push("");
  lines.push(`## Commits (newest first)`);
  for (const c of shown) lines.push(`- ${c.sha.slice(0, 7)} ${c.subject}`);
  if (more > 0) lines.push(`- … ${more} more: \`git log ${r.base.sha ? `${r.base.sha.slice(0, 7)}..` : ""}HEAD\``);
  if (!r.commits.length) lines.push("- (none)");
  lines.push("");
  lines.push(`## Diff`);
  lines.push(`${r.diff.files} files, +${r.diff.insertions} −${r.diff.deletions}. Largest: ${r.diff.top.slice(0, 12).map((f) => `${f.path} (+${f.insertions} −${f.deletions})`).join(", ") || "none"}.`);
  if (r.roadmap.length) {
    lines.push("", "## Roadmap items checked in this range");
    for (const it of r.roadmap) lines.push(`- ${it.title}`);
  }
  if (r.specs.length) {
    lines.push("", "## Spec tasks checked in this range");
    for (const s of r.specs) lines.push(`- ${s.feature}: ${s.done} of ${s.total} done (${s.newlyDone.slice(0, 8).join(", ")})`);
  }
  if (r.prs.length) {
    lines.push("", "## Merged PRs");
    for (const pr of r.prs.slice(0, 40)) lines.push(`- #${pr.number} ${pr.title}`);
  }
  if (r.breaking.length) {
    lines.push("", "## Breaking hints (check each one)");
    for (const b of r.breaking) lines.push(`- ${b}`);
  }
  lines.push("");
  lines.push(`## What to write`);
  lines.push(`1. Read the commits. Where a subject is unclear, read its body, \`git show <sha> --stat\`, or the diff. Do not guess what changed.`);
  lines.push(`2. Group the changes in Keep a Changelog style: \`### Added\`, \`### Changed\`, \`### Fixed\`, \`### Removed\`, \`### Security\`, \`### Deprecated\`. Leave out empty groups. Skip merges, release commits and formatting-only changes.`);
  lines.push(`3. Flag breaking changes first, on a line that starts \`**Breaking:**\`, with what a user must do.`);
  lines.push(`4. Write the file \`${DRAFTS_DIR.replace(/\\/g, "/")}/<version>.md\`, creating the folder if it is missing. Its first lines are this front matter, filled in:`);
  lines.push("```");
  lines.push("---");
  lines.push(`version: ${fixed ?? "<version>"}`);
  lines.push(`from: ${p.current}`);
  lines.push(`base: ${r.base.sha ?? "none"}`);
  lines.push(`head: ${r.head.sha}`);
  lines.push(`date: ${p.date}`);
  lines.push(`bump: ${p.bump === "auto" ? "<patch|minor|major|prerelease>" : p.bump}`);
  lines.push("reason: <one line: why this bump>");
  lines.push("status: draft");
  lines.push(`draft: ${p.token}`);
  lines.push("---");
  lines.push("```");
  lines.push(`Then the notes: the \`###\` groups only, with no version heading (the publisher adds it). The file name is the version.`);
  lines.push(`5. Reply with two lines: the path, and the bump with its reason. Nothing else.`);
  return lines.join("\n");
}

export interface ProductPromptInput {
  product: string;
  slug: string;
  date: string;
  audience: Audience;
  token: string;
  repos: Array<{ name: string; role: string; version: string | null; date: string | null; notes: string | null }>;
}

/** The prompt for a combined note across a product's repos, each built from that repo's latest published release. */
export function productPrompt(p: ProductPromptInput): string {
  const lines: string[] = [];
  lines.push(`You are writing one combined release note for the product "${p.product}", across its repos. Do not tag, bump, commit or push. Write exactly one file: ${PRODUCTS_DIR.replace(/\\/g, "/")}/${p.slug}-${p.date}.md, in the folder of the first repo you are in.`);
  lines.push("");
  lines.push(`Audience: ${p.audience}. ${AUDIENCE_RULES[p.audience]}`);
  lines.push("");
  lines.push("## Each repo's latest release");
  for (const r of p.repos) {
    lines.push(`### ${r.name} (${r.role})`);
    if (!r.version) lines.push("No published release yet. Leave it out, or say so in one line.");
    else {
      lines.push(`Version ${r.version}${r.date ? `, ${r.date}` : ""}.`);
      lines.push(r.notes ? r.notes.slice(0, 1500) : "(no notes)");
    }
    lines.push("");
  }
  lines.push("## What to write");
  lines.push("Group the changes by what they mean to a user of the product, not by repo. Keep a Changelog groups (Added, Changed, Fixed, Removed, Security, Deprecated). Name the repo in brackets only where it matters.");
  lines.push("Its first lines are this front matter, filled in:");
  lines.push("```");
  lines.push("---");
  lines.push(`product: ${p.product}`);
  lines.push(`date: ${p.date}`);
  lines.push("status: draft");
  lines.push(`draft: ${p.token}`);
  lines.push("---");
  lines.push("```");
  lines.push("Reply with the path, and nothing else.");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

interface SessionRow {
  token: string;
  workspace_id: string;
  session_id: string;
  kind: "changelog" | "product";
  subject: string;
  created_at: string;
}

function tables(): void {
  db().exec(`CREATE TABLE IF NOT EXISTS release_sessions (
    token TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

function recordSession(row: Omit<SessionRow, "created_at">): void {
  tables();
  db()
    .prepare("INSERT INTO release_sessions (token, workspace_id, session_id, kind, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.token, row.workspace_id, row.session_id, row.kind, row.subject, new Date().toISOString());
}

/** The session that wrote a draft or a product note, by the token in its front matter. */
export function sessionOfToken(token: string | undefined): SessionRow | null {
  if (!token) return null;
  tables();
  return (db().prepare("SELECT * FROM release_sessions WHERE token = ?").get(token) as SessionRow | undefined) ?? null;
}

/** The sessions that drafted releases in a workspace, newest first. */
export function releaseSessionsOf(workspaceId: string, limit = 20): SessionRow[] {
  tables();
  return db().prepare("SELECT * FROM release_sessions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?").all(workspaceId, limit) as SessionRow[];
}

export interface DraftStart {
  sessionId: string;
  token: string;
  base: string;
  commits: number;
  /** The version when the bump was fixed; null when the agent proposes it. */
  version: string | null;
  /** What the commits alone suggest (the agent may differ). */
  suggested: { bump: string; reason: string };
}

/** Who runs the session a draft starts. Empty fields fall back to the default engine, or the agent's or the pair's choice. */
export interface SessionChoice {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface ChangelogOpts extends SessionChoice {
  base?: string | null;
  bump?: ReleaseBump | null;
  audience?: Audience | null;
}

function audienceOf(v: unknown): Audience {
  const a = (v ?? "users") as Audience;
  if (!AUDIENCES.includes(a)) throw new UserError(`Audience must be one of: ${AUDIENCES.join(", ")}.`);
  return a;
}

/**
 * Starts a changelog session for a workspace: it reads the range from `base` (the last tag by default) to HEAD and
 * drafts the notes. The session's token is in the draft's front matter; the draft lands in releases/drafts/.
 */
export function startChangelogSession(workspaceId: string, opts: ChangelogOpts = {}): DraftStart {
  const w = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  const bump = opts.bump ?? "auto";
  if (!["auto", "patch", "minor", "major", "prerelease", "release"].includes(bump)) throw new UserError("Bump must be one of: auto, patch, minor, major, prerelease.");
  const audience = audienceOf(opts.audience);
  const primary = primaryVersion(detectVersionFiles(w.path));
  if (!primary) throw new UserError("There is no version file in this workspace (package.json, composer.json, pyproject.toml, Cargo.toml, app.json, pubspec.yaml or VERSION).");
  const range = rangeOf(w.path, parseBase(opts.base), { prs: true });
  if (!range.commits.length && !range.roadmap.length) throw new UserError(`Nothing has changed since ${range.base.label}. There is nothing to draft.`);
  const token = randomBytes(6).toString("hex");
  const prompt = changelogPrompt({ workspace: w.name, range, current: primary.version, bump, audience, date: today(), token });
  const session = createLead({ prompt, title: `Changelog: ${range.base.label}`.slice(0, 100), cwd: w.path, mode: "build", engine: opts.engine, model: opts.model, effort: opts.effort });
  recordSession({ token, workspace_id: workspaceId, session_id: session.id, kind: "changelog", subject: range.base.label });
  return {
    sessionId: session.id,
    token,
    base: range.base.label,
    commits: range.commits.length,
    version: bump === "auto" ? null : nextVersion(primary.version, bump),
    suggested: suggestBump(range),
  };
}

/** A follow-up in the session that wrote the draft: the agent revises the file and keeps its front matter. */
export function reviseDraft(workspaceId: string, version: string, instructions: string): { sessionId: string } {
  const w = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  const text = instructions.trim();
  if (!text) throw new UserError("Say what to change.");
  const draft = readDraft(w.path, version);
  if (!draft) throw new UserError(`No draft ${version}.`);
  if (draft.meta.status !== "draft") throw new UserError(`${version} is ${draft.meta.status}: only a draft can be revised.`);
  const row = sessionOfToken(draft.meta.draft);
  if (!row || row.workspace_id !== workspaceId || !getSession(row.session_id)) throw new UserError(`The session that wrote ${version} is gone. Draft the release again.`);
  send({ operator: true }, row.session_id, `Revise the draft at ${draft.file} as follows: ${text}\n\nKeep its front matter as it is (version, from, base, head, status: draft, draft: ${row.token}), and update \`bump\` and \`reason\` if the change moves them. Write the file again. Do not tag, bump, commit or push.`);
  return { sessionId: row.session_id };
}

/* -------------------------------------------------------------------------- */
/* Product notes                                                              */
/* -------------------------------------------------------------------------- */

export interface ProductStart {
  sessionId: string;
  token: string;
  file: string;
  repos: Array<{ name: string; version: string | null }>;
}

/**
 * Starts a session that drafts one combined note for a product, from each of its repos' latest published release. The
 * note is written in the first repo's folder, under releases/products/.
 */
export function startProductReleaseNotes(productId: string, opts: SessionChoice & { audience?: Audience | null } = {}): ProductStart {
  const product = resolveProduct(productId);
  if (!product) throw new UserError(`No product "${productId}".`);
  const repos = productWorkspaces(product.id);
  if (!repos.length) throw new UserError(`${product.name} has no repos. Attach a workspace to it first.`);
  const audience = audienceOf(opts.audience);
  const date = today();
  const token = randomBytes(6).toString("hex");
  const rows = repos.map((r) => {
    const latest = listReleases(r.path)[0] ?? null;
    return { name: r.name, role: r.role, version: latest?.version ?? null, date: latest?.meta.date ?? null, notes: latest ? latest.body : null };
  });
  const prompt = productPrompt({ product: product.name, slug: product.slug, date, audience, token, repos: rows });
  const session = createLead({ prompt, title: `Product notes: ${product.name}`.slice(0, 100), cwd: repos[0]!.path, mode: "build", engine: opts.engine, model: opts.model, effort: opts.effort });
  recordSession({ token, workspace_id: repos[0]!.workspace_id, session_id: session.id, kind: "product", subject: product.id });
  return {
    sessionId: session.id,
    token,
    file: path.join(PRODUCTS_DIR, `${product.slug}-${date}.md`).replace(/\\/g, "/"),
    repos: rows.map((r) => ({ name: r.name, version: r.version })),
  };
}
