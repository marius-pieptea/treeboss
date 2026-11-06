/**
 * Generating and refreshing documentation with an agent of the operator's choice, and checking the result.
 *
 * A generation run is an ordinary session in the workspace: nothing here has a runtime of its own. What
 * this module adds is the prompt (see prompts.ts), a record of what the pages looked like before (so human
 * sections can be checked afterwards), and `docsAfterTurn`, which looks at what the turn changed and says,
 * in the session's log and in a stored result the UI reads, which pages were touched and what is wrong
 * with them. It only reports: it never edits a page, and the operator reviews the diff before committing.
 */
import fs from "fs";
import path from "path";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { getSetting } from "../settings";
import { UserError } from "../util";
import { findIndexRoot } from "../codegraph/detect";
import { appendLog, createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { Hub } from "../sessions/hub";
import { runCmd } from "../git/run";
import { attach } from "./attach";
import { alteredKeepBlocks, docMeta, parseFrontMatter, unbalancedKeep } from "./frontmatter";
import { type GenKind, GEN_KINDS, KIND_SPECS, type Target, generationPrompt, reportedTouched } from "./prompts";
import { FRESHNESS_RANK, type Staleness, headSha, pageStaleness } from "./staleness";
import { docsDirOf, guardDocsPath, listPages, nextAdrNumber, type PageInfo } from "./store";
import { DECISIONS_DIR, slugify } from "./templates";

export interface GenerateOpts {
  kind: GenKind;
  /** A page to write or refresh: relative to the workspace, or to the docs folder. */
  page?: string | null;
  /** Several existing pages to refresh together (kind `refresh`). */
  pages?: string[] | null;
  /** Refresh every page that is stale or drifting. */
  stale?: boolean;
  /** The topic of a module page or a decision, or extra instructions. */
  input?: string | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  /** Continue in this open session instead of starting one (a decision record taken from a conversation). */
  sessionId?: string | null;
  /** Review a plan with the operator before anything is written. */
  planFirst?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Run records                                                                */
/* -------------------------------------------------------------------------- */

export interface DocIssue {
  code: "no-front-matter" | "front-matter-error" | "missing-covers" | "missing-generated" | "commit-mismatch" | "keep-altered" | "keep-unbalanced";
  message: string;
}

export interface TouchedPage {
  path: string;
  created: boolean;
  issues: DocIssue[];
}

export interface RunResult {
  at: string;
  head: string | null;
  touched: TouchedPage[];
  /** What the agent said it touched, when that differs from what changed on disk. */
  reportedOnly: string[];
  /** Files outside the docs folder that changed during the turn. */
  stray: string[];
}

export interface DocsRun {
  session_id: string;
  kind: string;
  docs_dir: string;
  head: string | null;
  by: string;
  started_at: string;
  result: RunResult | null;
}

const prepared = new WeakSet<Database>();
function table(): Database {
  const conn = db();
  if (!prepared.has(conn)) {
    conn.exec(`CREATE TABLE IF NOT EXISTS docs_runs (
      session_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      docs_dir TEXT NOT NULL,
      head TEXT,
      by TEXT NOT NULL,
      before_dirty TEXT NOT NULL DEFAULT '[]',
      before_pages TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      result TEXT
    )`);
    prepared.add(conn);
  }
  return conn;
}

export function getRun(sessionId: string): DocsRun | null {
  const r = table().prepare("SELECT session_id, kind, docs_dir, head, by, started_at, result FROM docs_runs WHERE session_id = ?").get(sessionId) as any;
  return r ? { ...r, result: r.result ? (JSON.parse(r.result) as RunResult) : null } : null;
}

/* -------------------------------------------------------------------------- */
/* Working tree                                                               */
/* -------------------------------------------------------------------------- */

/** Files that differ from HEAD (or are untracked), as workspace-relative paths. Empty outside a git repository. */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const r = await runCmd("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: dir, timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 });
  if (r.code !== 0) return [];
  const out: string[] = [];
  const recs = r.stdout.toString().split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length <= 3) continue;
    out.push(rec.slice(3));
    if (rec[0] === "R" || rec[0] === "C") i++; // the old name follows as its own record
  }
  return out;
}

const SNAPSHOT_CAP = 1_000_000;

function snapshot(rootDir: string, rels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const rel of rels) {
    try {
      const text = fs.readFileSync(path.join(rootDir, rel), "utf-8");
      if (total + text.length > SNAPSHOT_CAP) break;
      total += text.length;
      out[rel] = text;
    } catch {}
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Starting a run                                                             */
/* -------------------------------------------------------------------------- */

export interface Resolved {
  engine: string | null;
  model: string | null;
  by: string;
}

/** The engine and model: what the operator chose, else the `docs_engine` / `docs_model` settings, else the app's defaults. */
export function resolveHarness(o: Pick<GenerateOpts, "engine" | "model" | "agent" | "pairId">): Resolved {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const engine = clean(o.engine) ?? (o.agent || o.pairId ? null : clean(getSetting("docs_engine")));
  const model = clean(o.model) ?? (engine && engine === clean(getSetting("docs_engine")) ? clean(getSetting("docs_model")) : null);
  const named = engine ?? (o.agent ? `agent ${o.agent}` : o.pairId ? "hydra pair" : (getSetting("default_engine") as string));
  return { engine, model, by: `${named}${model ? `/${model}` : ""}` };
}

function toWorkspacePath(docsDir: string, p: string): string {
  const cleaned = p.replace(/\\/g, "/").replace(/^\/+/, "");
  return cleaned.startsWith(`${docsDir}/`) ? cleaned : `${docsDir}/${cleaned}`;
}

export async function withStaleness(rootDir: string, pages: PageInfo[], head: string | null): Promise<Array<{ page: PageInfo; st: Staleness }>> {
  const out: Array<{ page: PageInfo; st: Staleness }> = [];
  const queue = [...pages];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) out.push({ page: p, st: await pageStaleness(rootDir, p.meta, head) });
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

/** Everything a run needs decided before the session exists: the pages it works on and the prompt. */
export async function planRun(rootDir: string, workspaceId: string | null, o: GenerateOpts): Promise<{ docsDir: string; kind: GenKind; targets: Target[]; head: string | null; prompt: string; title: string; resolved: Resolved; refresh: boolean }> {
  if (!GEN_KINDS.includes(o.kind)) throw new UserError(`Unknown kind "${o.kind}". Kinds: ${GEN_KINDS.join(", ")}.`);
  const docsDir = docsDirOf(workspaceId).dir;
  const head = await headSha(rootDir);
  const resolved = resolveHarness(o);
  const { pages } = listPages(rootDir, docsDir);
  const byPath = new Map(pages.map((p) => [p.path, p]));
  let kind = o.kind;
  let targets: Target[] = [];
  let refresh = false;

  const describe = async (rels: string[]): Promise<Target[]> => {
    const infos = rels.map((r) => byPath.get(r)).filter((x): x is PageInfo => !!x);
    const stale = new Map((await withStaleness(rootDir, infos, head)).map((x) => [x.page.path, x.st]));
    return rels.map((r) => {
      const st = stale.get(r);
      return { path: r, exists: byPath.has(r), state: st?.state ?? null, changed: st?.files.map((f) => f.path), changedTotal: st?.filesChanged };
    });
  };

  if (o.stale || (o.pages && o.pages.length)) {
    kind = "refresh";
    refresh = true;
    let rels: string[];
    if (o.pages?.length) rels = o.pages.map((p) => guardDocsPath(rootDir, docsDir, toWorkspacePath(docsDir, p)));
    else {
      const all = await withStaleness(rootDir, pages.filter((p) => p.managed), head);
      rels = all
        .filter((x) => x.st.state === "stale" || x.st.state === "drifting")
        .sort((a, b) => FRESHNESS_RANK[a.st.state] - FRESHNESS_RANK[b.st.state])
        .map((x) => x.page.path);
      if (!rels.length) throw new UserError("No page is stale or drifting: nothing to refresh.");
    }
    for (const r of rels) if (!byPath.has(r)) throw new UserError(`${r} does not exist: refresh needs existing pages.`);
    targets = await describe(rels.slice(0, 25));
  } else if (kind === "refresh") {
    throw new UserError("Refresh needs pages: name them, or ask for the stale ones.");
  } else if (kind === "adr") {
    targets = [];
  } else {
    let rel: string;
    if (o.page) rel = guardDocsPath(rootDir, docsDir, toWorkspacePath(docsDir, o.page));
    else if (kind === "module") {
      const slug = slugify(o.input ?? "");
      if (!slug) throw new UserError("A module page needs a page path or a topic (the module's name).");
      rel = `${docsDir}/modules/${slug}.md`;
    } else rel = `${docsDir}/${KIND_SPECS[kind].defaultFile}`;
    refresh = byPath.has(rel);
    targets = await describe([rel]);
    targets[0].exists = refresh;
  }

  const existing = pages.map((p) => p.path).filter((p) => !targets.some((t) => t.path === p));
  const prompt = generationPrompt({
    kind,
    docsDir,
    targets,
    head,
    by: resolved.by,
    at: new Date().toISOString(),
    input: o.input ?? null,
    refresh,
    codegraph: !!findIndexRoot(rootDir),
    existing,
    inConversation: kind === "adr" && !!o.sessionId,
    nextAdr: kind === "adr" ? nextAdrNumber(rootDir, docsDir) : undefined,
    planFirst: o.planFirst === true,
  });
  const label = KIND_SPECS[kind].label;
  const subject = kind === "adr" ? (o.input ?? "").slice(0, 60) : targets.length === 1 ? path.basename(targets[0].path) : `${targets.length} pages`;
  const title = `Docs: ${refresh ? "refresh" : "write"} ${label.toLowerCase()}${subject ? ` (${subject})` : ""}`.slice(0, 100);
  return { docsDir, kind, targets, head, prompt, title, resolved, refresh };
}

function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export async function startGeneration(rootDir: string, workspaceId: string | null, o: GenerateOpts): Promise<{ session: SessionRecord; targets: Target[]; docsDir: string }> {
  const plan = await planRun(rootDir, workspaceId, o);
  const before = await dirtyFiles(rootDir);
  const beforePages = snapshot(rootDir, plan.targets.filter((t) => t.exists).map((t) => t.path));

  let session: SessionRecord;
  if (o.sessionId) {
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    if (s.status === "closed") throw new UserError(`Session ${s.id} is closed.`);
    if (realOf(s.base_cwd) !== realOf(rootDir)) throw new UserError(`Session ${s.id} works in ${s.base_cwd}, not in this workspace.`);
    session = send({ operator: true }, s.id, plan.prompt);
  } else {
    session = createLead({
      prompt: plan.prompt,
      title: plan.title,
      cwd: rootDir,
      engine: plan.resolved.engine,
      model: plan.resolved.model,
      effort: o.effort ?? null,
      agent: o.agent ?? null,
      pairId: o.pairId ?? null,
      mode: o.planFirst ? "plan" : null,
    });
  }
  // Same tick as the session's creation: its first turn cannot have ended yet.
  table()
    .prepare(
      `INSERT INTO docs_runs (session_id, kind, docs_dir, head, by, before_dirty, before_pages) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, docs_dir = excluded.docs_dir, head = excluded.head, by = excluded.by,
         before_dirty = excluded.before_dirty, before_pages = excluded.before_pages, started_at = CURRENT_TIMESTAMP, result = NULL`,
    )
    .run(session.id, plan.kind, plan.docsDir, plan.head, plan.resolved.by, JSON.stringify(before), JSON.stringify(beforePages));
  for (const t of plan.targets) if (t.exists) attach(session.id, t.path, { purpose: "generate" });
  return { session: getSession(session.id)!, targets: plan.targets, docsDir: plan.docsDir };
}

/* -------------------------------------------------------------------------- */
/* After a turn                                                               */
/* -------------------------------------------------------------------------- */

/** What is wrong with a page a generation run touched. Pure: the daemon-free part of the check. */
export function checkPage(text: string, ctx: { head: string | null; before: string | null; adr: boolean }): DocIssue[] {
  const issues: DocIssue[] = [];
  const fm = parseFrontMatter(text);
  if (!fm.present) {
    issues.push({ code: "no-front-matter", message: "The page has no front matter, so the app cannot tell when it drifts from the code." });
  } else if (fm.error) {
    issues.push({ code: "front-matter-error", message: `The front matter does not parse: ${fm.error}` });
  } else if (!ctx.adr) {
    const meta = docMeta(fm.data);
    if (!meta.covers.length) issues.push({ code: "missing-covers", message: "The front matter lists no `covers`: there is nothing to check the page against." });
    if (!meta.generated?.commit) {
      if (ctx.head) issues.push({ code: "missing-generated", message: "The front matter records no `generated.commit`." });
    } else if (ctx.head && !ctx.head.startsWith(meta.generated.commit) && !meta.generated.commit.startsWith(ctx.head)) {
      issues.push({ code: "commit-mismatch", message: `generated.commit is ${meta.generated.commit.slice(0, 12)} but HEAD is ${ctx.head.slice(0, 12)}.` });
    }
  }
  if (unbalancedKeep(text)) issues.push({ code: "keep-unbalanced", message: "A `<!-- keep -->` block has no matching `<!-- /keep -->` (or the reverse)." });
  if (ctx.before !== null) {
    const lost = alteredKeepBlocks(ctx.before, text);
    if (lost.length) issues.push({ code: "keep-altered", message: `${lost.length} human-written \`<!-- keep -->\` block${lost.length === 1 ? " was" : "s were"} changed or removed.` });
  }
  return issues;
}

const isMd = (p: string) => /\.(md|mdx|markdown)$/i.test(p);

/**
 * Called when a turn has settled. Never throws: bookkeeping must not fail a turn. Reports only.
 */
export async function docsAfterTurn(sessionId: string, info: { interrupted: boolean; success: boolean }): Promise<void> {
  try {
    const row = table().prepare("SELECT * FROM docs_runs WHERE session_id = ?").get(sessionId) as any;
    if (!row) return;
    const s = getSession(sessionId);
    if (!s) return;
    const rootDir = s.base_cwd;
    const docsDir: string = row.docs_dir;
    const beforeDirty = new Set<string>(JSON.parse(row.before_dirty));
    const beforePages: Record<string, string> = JSON.parse(row.before_pages);
    const head = await headSha(rootDir);

    const now = await dirtyFiles(rootDir);
    // A page is touched when it is new to the dirty set, or its text no longer matches what we saw at launch.
    const changedPages = now.filter((f) => f.startsWith(`${docsDir}/`) && isMd(f) && (!beforeDirty.has(f) || (f in beforePages && safeRead(rootDir, f) !== beforePages[f])));
    const stray = now.filter((f) => !beforeDirty.has(f) && !f.startsWith(`${docsDir}/`));
    const reported = reportedTouched(s.last_output).map((p) => p.replace(/^\.\//, ""));

    const touched: TouchedPage[] = changedPages.map((p) => {
      const text = safeRead(rootDir, p) ?? "";
      const adr = p.startsWith(`${docsDir}/${DECISIONS_DIR}/`);
      return { path: p, created: !(p in beforePages), issues: checkPage(text, { head, before: p in beforePages ? beforePages[p] : null, adr }) };
    });
    const reportedOnly = reported.filter((p) => !changedPages.includes(p));
    const result: RunResult = { at: new Date().toISOString(), head, touched, reportedOnly, stray };
    table().prepare("UPDATE docs_runs SET result = ? WHERE session_id = ?").run(JSON.stringify(result), sessionId);

    if (info.interrupted) return;
    if (touched.length) appendLog(s, s.last_turn_id, `[docs] ${touched.length} page${touched.length === 1 ? "" : "s"} written: ${touched.map((t) => t.path).join(", ")}. Review the diff in Source Control before committing.`, "info");
    for (const t of touched) for (const i of t.issues) appendLog(s, s.last_turn_id, `[docs] ${t.path}: ${i.message}`, "info");
    if (stray.length) appendLog(s, s.last_turn_id, `[docs] warning: files outside ${docsDir}/ changed during this turn: ${stray.slice(0, 8).join(", ")}${stray.length > 8 ? ", …" : ""}. Review them in Source Control.`, "info");
    if (reportedOnly.length) appendLog(s, s.last_turn_id, `[docs] the agent reported ${reportedOnly.join(", ")} but nothing changed there.`, "info");
    Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  } catch (err: any) {
    try {
      const s = getSession(sessionId);
      if (s) appendLog(s, s.last_turn_id, `[docs] bookkeeping failed: ${err?.message ?? err}`, "info");
    } catch {}
  }
}

function safeRead(rootDir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(rootDir, rel), "utf-8");
  } catch {
    return null;
  }
}
