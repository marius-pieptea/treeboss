/**
 * Lab runs, sweeps and hand-offs.
 *
 *   run     one lens over one scope (the project, a folder or the current diff): an ordinary session in the
 *           workspace that writes findings to lab/findings/ and changes nothing else.
 *   sweep   one run per module, at most `limit` of them, so a whole project is covered without one session
 *           reading everything. Findings from every run land in the same folder and the view merges them.
 *   handoff a finding becomes a roadmap item, a spec, a build session or a design review.
 *
 * A run writes files, so it is a build-mode session; the prompt confines it to lab/. It never runs in a
 * worktree: the findings must appear in the project the operator is looking at.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { db } from "../db";
import { git } from "../git/worktree";
import { createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { startDesign, withInstructions } from "../design/sessions";
import { addRoadmapItem, createRoadmap, readRoadmap, recordSession } from "../roadmap/store";
import { effectivePacks } from "../practices/store";
import { practiceFindings } from "../practices/checks";
import { owningWorkspace } from "../workspaces";
import { startFromItem } from "../roadmap/sessions";
import { CLOSED, evidenceHashesNow, FINDINGS_DIR, LAB_DIR, LENSES, listFindings, noteFinding, patchFinding, priorFindingsBlock, readFinding, type Finding, type FindingPatch, type Lens, type Status } from "./findings";
import { lensDef } from "./lenses";
import { realOf, registerChecklistSession, tables } from "./tables";
import { stackContext } from "./stack-context";
import { checklistPass, parseToken } from "../checklists/plan";

export { realOf, resetLabTables, tables } from "./tables";

/** `project`, `diff`, or a workspace-relative folder or file. */
export type Scope = string;

export interface LabOpts {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  /** Free text from the operator: what to focus on. */
  note?: string | null;
  /** Send into this open session instead of starting one. */
  sessionId?: string | null;
  /** A checklist pass changes code (fix) rather than only reading it. */
  fix?: boolean | null;
  /** The workspace a checklist pass answers for: its session is registered to record checklist items (tables.ts). */
  workspaceId?: string | null;
}

/** How many findings one run may write: past this the list stops being read. */
export const MAX_FINDINGS_PER_RUN = 8;
export const DEFAULT_SWEEP_LIMIT = 6;
export const MAX_SWEEP_LIMIT = 20;

export interface LabRun {
  sessionId: string;
  lens: string;
  scope: string;
  sweepId: string | null;
  /** Files outside lab/ that changed while the run was going. A run is told to touch only lab/; anything here deserves a look. */
  touched: string[];
  at: string;
}

/** The state just before a run starts: when it started, and every finding that exists then with its status. */
export interface Snapshot {
  startedMs: number;
  known: Record<string, Status>;
}

export function snapshot(rootDir: string): Snapshot {
  return { startedMs: Date.now(), known: Object.fromEntries(listFindings(rootDir).map((f) => [f.id, f.status])) };
}

/** Records a run. `pre` is the snapshot taken before the session was created, so a write during its first turn is inside the window. */
export function record(rootDir: string, sessionId: string, lens: Lens, scope: string, sweepId: string | null, pre: Snapshot = snapshot(rootDir)): void {
  tables();
  db()
    .prepare("INSERT OR REPLACE INTO lab_sessions (session_id, root_dir, lens, scope, sweep_id, baseline, started_ms, known) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sessionId, realOf(rootDir), lens, scope, sweepId, JSON.stringify(dirtyOutsideLab(rootDir)), pre.startedMs, JSON.stringify(pre.known));
}

/** Files with uncommitted changes (and what each looks like), outside lab/: the state a run is compared against. */
function dirtyOutsideLab(rootDir: string): string[] {
  const out: string[] = [];
  for (const f of changedFiles(rootDir)) {
    try {
      const st = fs.statSync(path.join(rootDir, f));
      out.push(`${f}@${Math.floor(st.mtimeMs)}`);
    } catch {
      out.push(`${f}@gone`);
    }
  }
  return out;
}

/**
 * A Lab turn ended. Within the run's window (from when it started): the findings it wrote are stamped with the session,
 * a status it rewrote back to new is restored, and their evidence lines are hashed (so a later edit shows as drift). A fix
 * whose turn ends without `shipped` keeps its finding accepted, with a note. Files outside lab/ that changed in the window
 * are listed as touched, which can include other sessions' edits: the tab says so. Called by the sweep driver on every turn end.
 */
export function finishRun(sessionId: string): void {
  tables();
  const row = db().prepare("SELECT root_dir, baseline, lens, scope, started_ms, known FROM lab_sessions WHERE session_id = ?").get(sessionId) as { root_dir: string; baseline: string; lens: string; scope: string; started_ms: number; known: string } | null;
  if (!row) return;
  const root = row.root_dir;
  const since = row.started_ms;
  const known = JSON.parse(row.known) as Record<string, string>;
  for (const f of listFindings(root)) {
    if (f.updatedAt < since) continue;
    const was = known[f.id];
    if ((was === "dismissed" || was === "shipped") && f.status === "new") {
      patchFinding(root, f.id, { status: was as Status });
      noteFinding(root, f.id, `Lab note: this run rewrote the finding as new. Its status (${was}) was restored. To reopen it, give the new finding its own id.`);
    }
    const patch: FindingPatch = {};
    if (f.session !== sessionId) patch.session = sessionId;
    const hashes = evidenceHashesNow(root, f.evidence);
    if (hashes.join("|") !== Object.entries(f.evidenceHashes).map(([k, v]) => `${k}=${v}`).join("|")) patch.evidence_hashes = hashes;
    if (Object.keys(patch).length) patchFinding(root, f.id, patch);
  }
  const fix = listFindings(root).find((f) => f.fixSession === sessionId);
  if (fix && fix.status !== "shipped" && fix.status !== "dismissed") {
    if (fix.status !== "accepted") patchFinding(root, fix.id, { status: "accepted" });
    noteFinding(root, fix.id, "Lab note: the fix session ended its turn without marking this finding shipped. It stays accepted: check the change, then set `status: shipped`, or send the session another turn.");
  }
  // A checklist fix and a fix session change code on purpose: the guard that flags edits outside lab/ does not apply to them.
  if (row.lens === "checklist" || row.scope.startsWith("fix:")) return;
  const before = new Map<string, number>();
  for (const e of JSON.parse(row.baseline) as string[]) before.set(e.slice(0, e.lastIndexOf("@")), Number(e.slice(e.lastIndexOf("@") + 1)));
  const touched = dirtyOutsideLab(root)
    .filter((e) => !before.has(e.slice(0, e.lastIndexOf("@"))) || Number(e.slice(e.lastIndexOf("@") + 1)) >= since)
    .map((e) => e.slice(0, e.lastIndexOf("@")));
  db().prepare("UPDATE lab_sessions SET touched = ? WHERE session_id = ?").run(JSON.stringify(touched), sessionId);
}

/** Findings whose linked roadmap item is done become shipped. Returns the ids it changed. */
export function markRoadmapShipped(rootDir: string): string[] {
  const open = listFindings(rootDir).filter((f) => f.roadmap && !CLOSED.includes(f.status));
  if (!open.length) return [];
  const done = new Set(readRoadmap(rootDir).lanes.flatMap((l) => l.items).filter((i) => i.status === "shipped").map((i) => i.id));
  const changed: string[] = [];
  for (const f of open) {
    if (!done.has(f.roadmap!)) continue;
    patchFinding(rootDir, f.id, { status: "shipped" });
    changed.push(f.id);
  }
  return changed;
}

/** The counts the activity badges show: open findings and open bugs, all findings, and the Lab runs still going. */
export function summaryOf(rootDir: string): { open: number; bugs: number; total: number; running: number } {
  tables();
  const all = listFindings(rootDir);
  const running = (db().prepare("SELECT COUNT(*) AS n FROM lab_sessions l JOIN sessions s ON s.id = l.session_id WHERE l.root_dir = ? AND s.status = 'running'").get(realOf(rootDir)) as { n: number }).n;
  const open = all.filter((f) => f.status === "new" || f.status === "accepted");
  return { open: open.filter((f) => f.lens !== "bug").length, bugs: open.filter((f) => f.lens === "bug").length, total: all.length, running };
}

/** Recent runs for the project, newest first. */
export function listRuns(rootDir: string, limit = 60): LabRun[] {
  tables();
  const rows = db().prepare("SELECT session_id, lens, scope, sweep_id, touched, created_at FROM lab_sessions WHERE root_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(realOf(rootDir), limit) as Array<{ session_id: string; lens: string; scope: string; sweep_id: string | null; touched: string; created_at: string }>;
  return rows.map((r) => ({ sessionId: r.session_id, lens: r.lens, scope: r.scope, sweepId: r.sweep_id, touched: JSON.parse(r.touched), at: r.created_at }));
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/** A scope as the operator may have typed it, checked against the project. */
export function checkScope(rootDir: string, raw: string | null | undefined): Scope {
  const v = (raw ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!v || v === "project" || v === ".") return "project";
  if (v === "diff") return "diff";
  if (path.isAbsolute(v) || v.split(/[\\/]/).includes("..")) throw new UserError(`"${v}" is outside the project: give a folder or file inside it.`);
  const abs = path.join(realOf(rootDir), v);
  if (!fs.existsSync(abs)) throw new UserError(`"${v}" does not exist in the project.`);
  if (!realOf(abs).startsWith(realOf(rootDir) + path.sep)) throw new UserError(`"${v}" is outside the project: give a folder or file inside it.`);
  return v;
}

function scopeText(rootDir: string, scope: Scope): string {
  if (scope === "project") return "the whole project. Start from the entry points and the most-changed areas; you cannot read everything, so say what you did not cover.";
  if (scope === "diff") {
    const files = changedFiles(rootDir);
    return files.length
      ? `the current uncommitted changes and what they touch. Changed files:\n${files.slice(0, 80).map((f) => `- ${f}`).join("\n")}\nRead the diff (\`git diff HEAD\`) and the code around it, not the whole project.`
      : "the current uncommitted changes, but there are none: say so and write no findings.";
  }
  return `\`${scope}\` and what it directly depends on or is used by. Stay in it: other areas get their own pass.`;
}

export function changedFiles(rootDir: string): string[] {
  const r = git(["status", "--porcelain", "-z"], rootDir);
  if (!r.ok) return [];
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith(`${LAB_DIR}/`));
}

/* -------------------------------------------------------------------------- */
/* Modules and cost                                                           */
/* -------------------------------------------------------------------------- */

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", "target", "vendor", "__pycache__", ".venv", LAB_DIR]);
const TEXT = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|css|scss|html|sql|md|json|ya?ml|toml|sh)$/i;
/** Where a project keeps its modules: each child folder of these is one. */
const MODULE_PARENTS = ["src", "web/src/features", "web/src", "app", "apps", "packages", "services", "lib", "server", "client"];

export interface ModuleInfo {
  path: string;
  files: number;
  /** Rough tokens to read every source file in it. A ceiling: a run reads what it needs. */
  tokens: number;
}

/** Size up a folder or file: how many source files and about how many tokens. Bounded, so a huge tree is cheap to ask about. */
export function estimateScope(rootDir: string, scope: Scope, cap = 4000): { files: number; tokens: number } {
  const root = realOf(rootDir);
  if (scope === "diff") {
    let bytes = 0;
    let n = 0;
    for (const f of changedFiles(root)) {
      try {
        bytes += fs.statSync(path.join(root, f)).size;
        n++;
      } catch {}
    }
    return { files: n, tokens: Math.ceil(bytes / 4) };
  }
  const start = scope === "project" ? root : path.join(root, scope);
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    if (files >= cap) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (files >= cap) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
      } else if (e.isFile() && TEXT.test(e.name)) {
        try {
          bytes += fs.statSync(path.join(dir, e.name)).size;
          files++;
        } catch {}
      }
    }
  };
  try {
    if (fs.statSync(start).isFile()) return { files: 1, tokens: Math.ceil(fs.statSync(start).size / 4) };
  } catch {
    return { files: 0, tokens: 0 };
  }
  walk(start);
  return { files, tokens: Math.ceil(bytes / 4) };
}

/** How long a module scan is reused: it stats every file in every module, which a poll must not repeat. */
export const MODULES_TTL_MS = 60_000;
const modulesCache = new Map<string, { at: number; value: ModuleInfo[] }>();

/** The folders a sweep can run over, with their size. Biggest first. Cached for MODULES_TTL_MS per project. */
export function discoverModules(rootDir: string): ModuleInfo[] {
  const root = realOf(rootDir);
  const hit = modulesCache.get(root);
  if (hit && Date.now() - hit.at < MODULES_TTL_MS) return hit.value;
  const value = scanModules(root);
  modulesCache.set(root, { at: Date.now(), value });
  return value;
}

function scanModules(root: string): ModuleInfo[] {
  const seen = new Set<string>();
  const out: ModuleInfo[] = [];
  for (const parent of MODULE_PARENTS) {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const rel = `${parent}/${e.name}`;
      // `web/src` lists `web/src/features` as a module when features is also a parent: use the finer split only.
      if (MODULE_PARENTS.includes(rel) || seen.has(rel)) continue;
      seen.add(rel);
      const est = estimateScope(root, rel);
      if (est.files > 0) out.push({ path: rel, files: est.files, tokens: est.tokens });
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const FORMAT = `Write each finding as its own file, \`${FINDINGS_DIR}/<id>.md\`, where <id> is a short lowercase slug starting with the scope's name (create the folder if needed). If that file already exists, choose another id: never overwrite a file you did not write in this pass. Exactly this shape:

\`\`\`
---
title: <one line, what to do, not what is wrong>
lens: <the lens id>
scope: <the folder or file it is about>
impact: high | medium | low
effort: s | m | l
status: new
evidence:
  - <path/to/file.ext:line>
---
<Why it matters and what you saw, in a few sentences. Then "First step:" with the smallest concrete action. For performance, "Measure first:" with the command that gives the baseline.>
\`\`\``;

/** The roadmap's items that are not shipped yet: a feature pass must not propose them again. */
function openRoadmapTitles(rootDir: string): string[] {
  const state = readRoadmap(rootDir);
  if (!state.exists) return [];
  return state.lanes.flatMap((l) => l.items).filter((i) => i.status !== "shipped").map((i) => i.title).slice(0, 60);
}

/** SECURITY.md at the project root, when there is one: what the project already accepts as a risk. */
function securityDoc(rootDir: string): string | null {
  try {
    return fs.readFileSync(path.join(rootDir, "SECURITY.md"), "utf8").slice(0, 6000);
  } catch {
    return null;
  }
}

/** The files a scope covers, for the deterministic practice checks: bounded, and only text files. */
function filesInScope(rootDir: string, scope: Scope, cap = 300): string[] {
  if (scope === "diff") return changedFiles(rootDir).slice(0, cap);
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= cap) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= cap) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(abs);
      } else if (e.isFile() && TEXT.test(e.name)) out.push(path.relative(rootDir, abs).split(path.sep).join("/"));
    }
  };
  walk(scope === "project" ? rootDir : path.join(rootDir, scope));
  return out;
}

/** The workspace's enabled practice packs as rules, and the deterministic hits over the scope as known evidence (capped). */
function practicesBlock(rootDir: string, scope: Scope): string {
  const ws = owningWorkspace(rootDir);
  if (!ws) return "";
  const packs = effectivePacks(ws).filter((p) => p.rules.length);
  if (!packs.length) return "";
  const rules = packs.map((p) => `${p.title}:\n${p.rules.map((r) => `  - ${r}`).join("\n")}`).join("\n");
  const hits = practiceFindings(rootDir, filesInScope(rootDir, scope), rootDir).slice(0, 25);
  const known = hits.length ? `\nDeterministic hits already found in this scope (confirm or refute each; do not re-report one unless you add evidence):\n${hits.map((h) => `- ${h.file}${h.line ? `:${h.line}` : ""}: ${h.message}`).join("\n")}` : "";
  return `Practice packs enabled for this workspace. Judge the scoped code against their rules:\n${rules}${known}`;
}

/** The context a lens reads beyond the code: the roadmap, SECURITY.md, the practice packs. Each only when the lens asks for it. */
function contextBlock(rootDir: string, def: ReturnType<typeof lensDef>, scope: Scope): string {
  const parts: string[] = [];
  if (def.readsRoadmap) {
    const open = openRoadmapTitles(rootDir);
    if (open.length) parts.push(`Open roadmap items (already planned: do not propose them again):\n${open.map((t) => `- ${t}`).join("\n")}`);
  }
  if (def.readsSecurity) {
    const doc = securityDoc(rootDir);
    if (doc) parts.push(`SECURITY.md (what the project already accepts as a risk: do not report those):\n${doc}`);
  }
  if (def.id === "review") {
    const practices = practicesBlock(rootDir, scope);
    if (practices) parts.push(practices);
  }
  return parts.length ? `\n${parts.join("\n\n")}\n` : "";
}

export function labPrompt(rootDir: string, lens: Lens, scope: Scope, note?: string | null): string {
  const def = lensDef(lens);
  const prior = priorFindingsBlock(rootDir);
  const design = def.readsDesign ? `\nRead DESIGN.md and design/tokens.css first, when they exist: they are the contract the UI is judged against.\n` : "";
  const context = contextBlock(rootDir, def, scope);
  return `Lab pass: ${def.label.toLowerCase()}. Find what is worth improving in ${scopeText(rootDir, scope)}
${design}${context}
What the files say this project is (detected, not typed by the operator):
${stackContext(rootDir)}

What to look for:
${def.guidance}

How to report:
${FORMAT}

Rules:
- Read and run things to find out; do not change application code, configuration, tests or docs. The only files you create or edit are under \`${FINDINGS_DIR}/\`.
- At most ${MAX_FINDINGS_PER_RUN} findings. Fewer, better ones beat a long list: if nothing clears the bar, write none and say so.
- Every finding has evidence you actually opened (a file and line, a command's output, a screenshot) and a concrete first step. No general advice ("add caching", "improve error handling") without the specific place.
- impact is what the user or the team gains; effort is what it costs: s under an hour, m under a day, l more.
- Do not repeat what is listed below. A finding is a repeat when its title or its evidence path matches one listed, even under another id.
${prior ? `\n${prior}\n` : ""}${note?.trim() ? `\nThe operator asks you to focus on: ${note.trim()}\n` : ""}
End your reply with a table of the findings (id, title, impact, effort), then what you did not cover.`;
}

const VISIBLE = (lens: Lens, scope: Scope, note?: string | null) => `Lab: ${lensDef(lens).label.toLowerCase()} pass on ${scope === "project" ? "the project" : scope === "diff" ? "the current changes" : scope}.${note?.trim() ? `\n\n${note.trim()}` : ""}`;

export interface LabTurn {
  prompt: string;
  title: string;
  lens: Lens;
  scope: Scope;
}

/**
 * Everything a Lab turn needs, wherever it starts (the tab, the API, the composer). A checklist pass is named by a chunk token
 * (checklists/plan.ts), which a sweep stores; `fix` says whether the pass may change code.
 */
export function labTurn(rootDir: string, lens: string, rawScope: string | null | undefined, note?: string | null, fix?: boolean | null): LabTurn {
  if (!(LENSES as readonly string[]).includes(lens)) throw new UserError(`Unknown lens "${lens}": use ${LENSES.join(", ")}.`);
  const l = lens as Lens;
  if (l === "bug") throw new UserError("A bug is logged from the browser and fixed from its finding: no pass runs on it.");
  if (l === "checklist") {
    // A catalog item names itself; a project-only item is only in its project's file, so try the project's view too.
    try {
      parseToken(rawScope ?? "");
    } catch {
      try {
        parseToken(rawScope ?? "", rootDir);
      } catch {
        throw new UserError("Checklist passes start from the Checklists panel, with their items.");
      }
    }
    const pass = checklistPass(rootDir, rawScope ?? "", { fix: !!fix, note });
    return { prompt: withInstructions(pass.visible, "Lab · Checklist", pass.prompt), title: pass.title.slice(0, 100), lens: l, scope: rawScope ?? "" };
  }
  const scope = checkScope(rootDir, rawScope);
  const title = `Lab · ${lensDef(l).label} · ${scope === "project" ? "project" : scope}`.slice(0, 100);
  return { prompt: withInstructions(VISIBLE(l, scope, note), `Lab · ${lensDef(l).label}`, labPrompt(rootDir, l, scope, note)), title, lens: l, scope };
}

/* -------------------------------------------------------------------------- */
/* Runs and sweeps                                                            */
/* -------------------------------------------------------------------------- */

export function launch(rootDir: string, t: LabTurn, o: LabOpts, sweepId: string | null): SessionRecord {
  const pre = snapshot(rootDir);
  let session: SessionRecord;
  if (o.sessionId) {
    if (t.lens === "checklist") throw new UserError("A checklist pass starts its own session.");
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    setMode(s.id, "build");
    session = send({ operator: true }, s.id, t.prompt);
  } else {
    if (t.lens === "checklist" && !o.workspaceId) throw new UserError("A checklist pass answers for a workspace: start it from the checklist panel.");
    // Never isolated: a worktree would keep the findings out of the project the operator is looking at.
    // A checklist session is registered before its first turn, so its tools (checklist_record) are offered from the start.
    const workspaceId = o.workspaceId ?? null;
    const onCreated = t.lens === "checklist" && workspaceId ? (id: string) => registerChecklistSession(id, workspaceId) : undefined;
    session = createLead({ prompt: t.prompt, title: t.title, cwd: rootDir, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: false, mode: "build", onCreated });
  }
  record(rootDir, session.id, t.lens, t.scope, sweepId, pre);
  return session;
}

export function startLab(rootDir: string, lens: string, scope: string | null | undefined, o: LabOpts = {}): SessionRecord {
  return launch(rootDir, labTurn(rootDir, lens, scope, o.note, o.fix), o, null);
}

export interface SweepPlan {
  lens: Lens;
  modules: ModuleInfo[];
  /** Rough tokens to read every module once, and what the sessions will cost at most. */
  tokens: number;
  skipped: string[];
}

/** What a sweep would run and about what it would read, without starting anything. */
export function planSweep(rootDir: string, lens: string, scopes: string[] | null | undefined, limit?: number | null): SweepPlan {
  if (!(LENSES as readonly string[]).includes(lens)) throw new UserError(`Unknown lens "${lens}": use ${LENSES.join(", ")}.`);
  if (lens === "bug") throw new UserError("A bug is logged from the browser and fixed from its finding: no sweep runs on it.");
  if (lens === "checklist") {
    // The chunks are planned already (checklists/plan.ts): one session each, none of them capped.
    const chunks = [...new Set(scopes ?? [])];
    if (!chunks.length) throw new UserError("Nothing to check: every checklist item passes or was decided by hand.");
    return { lens: "checklist", modules: chunks.map((path) => ({ path, files: 0, tokens: 0 })), tokens: 0, skipped: [] };
  }
  const max = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_SWEEP_LIMIT)), MAX_SWEEP_LIMIT);
  const wanted = scopes?.length ? scopes.map((s) => checkScope(rootDir, s)).filter((s) => s !== "project" && s !== "diff") : discoverModules(rootDir).map((m) => m.path);
  const unique = [...new Set(wanted)];
  if (!unique.length) throw new UserError("There are no modules to sweep: name the folders to cover, or use a single run on the project.");
  const infos = unique.map((p) => ({ path: p, ...estimateScope(rootDir, p) })).sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  const modules = infos.slice(0, max);
  return { lens: lens as Lens, modules, tokens: modules.reduce((n, m) => n + m.tokens, 0), skipped: infos.slice(max).map((m) => m.path) };
}

/* -------------------------------------------------------------------------- */
/* Hand-offs                                                                  */
/* -------------------------------------------------------------------------- */

function findingBrief(f: Finding): string {
  const lines = [`Lab finding ${f.id} (${f.path}): ${f.title}`, `Lens: ${f.lens ?? "—"}   Impact: ${f.impact}   Effort: ${f.effort}${f.unmeasured ? "   (unmeasured)" : ""}`];
  if (f.scope) lines.push(`Scope: ${f.scope}`);
  if (f.evidence.length) lines.push("Evidence:", ...f.evidence.map((e) => `- ${e}`));
  if (f.body) lines.push("", f.body);
  return lines.join("\n");
}

/** The roadmap lane a finding goes to: "Next" when there is one, else the first. */
function laneFor(rootDir: string, lane?: string | null): string {
  const state = readRoadmap(rootDir);
  if (!state.exists) throw new UserError("There is no roadmap yet.");
  if (lane) {
    if (!state.lanes.some((l) => l.name === lane)) throw new UserError(`The roadmap has no lane "${lane}".`);
    return lane;
  }
  const next = state.lanes.find((l) => l.name.toLowerCase() === "next");
  const first = next ?? state.lanes[0];
  if (!first) throw new UserError("The roadmap has no lanes. Add one first.");
  return first.name;
}

/** Add a finding to the roadmap (creating ROADMAP.md when the project has none) and link the two. Sending the same finding twice is a no-op. */
export function findingToRoadmap(rootDir: string, id: string, lane?: string | null): { finding: Finding; itemId: string } {
  const f = readFinding(rootDir, id);
  if (f.roadmap && f.status !== "dismissed") {
    const exists = readRoadmap(rootDir).lanes.some((l) => l.items.some((i) => i.id === f.roadmap));
    if (exists) return { finding: f, itemId: f.roadmap };
  }
  if (!readRoadmap(rootDir).exists) createRoadmap(rootDir);
  const description = [f.body || f.summary, f.evidence.length ? `Evidence: ${f.evidence.join(", ")}` : "", `From Lab: ${f.path}`].filter(Boolean).join("\n").slice(0, 1500);
  const r = addRoadmapItem(rootDir, { lane: laneFor(rootDir, lane), title: f.title, description, tags: ["lab", ...(f.lens ? [f.lens] : [])] });
  if (!r.id) throw new UserError("The roadmap did not give the new item an id.");
  const finding = patchFinding(rootDir, id, { roadmap: r.id, status: "accepted" });
  return { finding, itemId: r.id };
}

/** Start the spec workflow from a finding: it goes to the roadmap first, so the spec, the item and the finding all point at each other. */
export function findingToSpec(rootDir: string, id: string, o: LabOpts = {}): { finding: Finding; session: SessionRecord; itemId: string } {
  const before = readFinding(rootDir, id);
  if (before.spec) throw new UserError(`${before.id} already has a spec: ${before.spec}. Open it instead of starting another.`);
  const { itemId } = findingToRoadmap(rootDir, id);
  const { session } = startFromItem(rootDir, itemId, "spec", o);
  const spec = readRoadmap(rootDir).lanes.flatMap((l) => l.items).find((i) => i.id === itemId)?.spec ?? null;
  const finding = patchFinding(rootDir, id, { spec });
  return { finding, session, itemId };
}

/** The fix session still running in the project, if any. Every fix edits the project folder itself, so only one may run at a time. */
export function runningFix(rootDir: string): { findingId: string; sessionId: string } | null {
  for (const f of listFindings(rootDir)) {
    if (f.fixSession && getSession(f.fixSession)?.status === "running") return { findingId: f.id, sessionId: f.fixSession };
  }
  return null;
}

/** A build session that fixes one finding, with the finding named by reference. */
export function fixFinding(rootDir: string, id: string, o: LabOpts = {}, sweepId: string | null = null): { finding: Finding; session: SessionRecord } {
  const f = readFinding(rootDir, id);
  if (f.lens === "bug") throw new UserError("Bugs are fixed from the QA view.");
  const busy = runningFix(rootDir);
  if (busy) {
    throw new UserError(
      busy.findingId === f.id
        ? `A fix for ${f.id} is already running (${busy.sessionId}). Open it instead of starting another.`
        : `A fix for ${busy.findingId} is already running (${busy.sessionId}). Fixes share the project folder, so wait for it to finish or open it.`,
    );
  }
  const measure = f.lens === "perf" ? "\nThis is a performance finding: take the baseline measurement first, make the change, measure again, and report both numbers. If the number did not improve, say so and revert." : "";
  const design = f.lens === "ui" || f.lens === "ux" ? "\nFollow DESIGN.md and design/tokens.css; add a missing token to both files first." : "";
  const secure = f.lens === "security" ? "\nThis is a security finding: fix the missing or wrong check at its source, not at one call site; add a test that fails without the fix; do not weaken or bypass any existing check; keep secrets and exploit details out of code comments, commit messages and your reply." : "";
  const prompt = `Implement this Lab finding.\n\n${findingBrief(f)}\n${measure}${design}${secure}\nRead the code at the evidence first and confirm the problem is still there; if it is not, say so and stop. Keep the change to what the finding asks for. When it is done and verified, set \`status: shipped\` in ${f.path} and say what you did.`;
  let session: SessionRecord;
  const pre = snapshot(rootDir);
  if (o.sessionId) {
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    setMode(s.id, "build");
    session = send({ operator: true }, s.id, prompt);
  } else {
    session = createLead({ prompt, title: `Fix: ${f.title}`.slice(0, 100), cwd: rootDir, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: false, mode: "build" });
  }
  record(rootDir, session.id, f.lens ?? "features", `fix:${f.id}`, sweepId, pre);
  if (f.roadmap) recordSession(rootDir, f.roadmap, session.id, "build");
  return { finding: patchFinding(rootDir, id, { status: "accepted", fix_session: session.id }), session };
}

/** Start a design review focused on a UI finding. */
export function reviewFindingDesign(rootDir: string, id: string, o: LabOpts = {}): { finding: Finding; session: SessionRecord } {
  const f = readFinding(rootDir, id);
  const session = startDesign(rootDir, "review", { input: findingBrief(f), engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, sessionId: o.sessionId });
  return { finding: f, session };
}
