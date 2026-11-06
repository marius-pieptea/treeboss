/**
 * Launch checklists attached to a workspace, and the state of each item.
 *
 * The state is a file in the project, one per attached checklist: lab/checklists/<id>.md (files.ts). Attaching creates the
 * file and detaching removes it. An item's line holds its last answer: status (pass, fail, na or unknown), source (auto,
 * agent or manual), the evidence (a repo path or URL) and the note. A missing line reads as unknown, not checked.
 *
 * The source says who answered. "auto" is a check in checks.ts. "agent" is an answer an audit session recorded with
 * checklist_record (tools.ts). "manual" is a person's tick, a dismissal in Lab (findings.ts), or an item disabled for this project.
 *
 * A manual answer pins the item: "Run checks" and the audits leave it alone, so the operator's decision stands. Untick it to
 * hand the item back to the checks. A note alone pins nothing. An agent's answer stands where no check can judge the item.
 *
 * The definitions are the effective catalog (custom.ts), and a project adds its own items and disables some (project.ts). Every
 * read goes through projectChecklist(), which also brings the file up to the definition.
 *
 * A failing item is a Lab finding, one per item (findings.ts); a pass ships it. Audits and fixes are Lab passes (launch.ts).
 * Attachments and item state used to be SQLite rows; importLegacy() exports them to files once, on the first read.
 * Nothing here runs a shell; checks are in checks.ts.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { UserError } from "../util";
import { Workspaces, type Workspace } from "../workspaces";
import { detectStack, type StackDetection } from "../stack";
import type { Checklist, ChecklistItem, CheckId } from "./catalog";
import { makeChecker, openRepo, type CheckResult, type CheckStatus, type FetchFn } from "./checks";
import { checklistById, effectiveCatalog } from "./custom";
import { createChecklistFile, fileOf, patchChecklistFile, removeChecklistFile, UNANSWERED, type ItemAnswer } from "./files";
import { closeItemFinding, findingsByItem, syncItemFinding } from "./findings";
import { judgeScreens, readJudgements, screenMessage, verificationOf, type ScreenJudgement, type ScreenRun, type Shooter, type Verification } from "./screens";
import { browserShooter } from "./screens-browser";
import { startChecklistPass } from "./launch";
import { addProjectItem, disabledAnswer, isDisabled, projectChecklist, removeProjectItem, type ProjectChecklist } from "./project";
import { patchFinding, shipChecklistFindings, type Finding } from "../lab/findings";

export type ItemSource = "auto" | "agent" | "manual";
/** pass, fail and unknown come from the checks; na (not applicable) is an agent's answer that needs a reason. */
export type ItemStatus = CheckStatus | "na";
/** The statuses an agent may record. */
export type AgentStatus = "pass" | "fail" | "na";

export interface ItemState extends ChecklistItem {
  status: ItemStatus;
  source: ItemSource | null;
  evidence: string | null;
  /** The check's message, or the screenshot judgement's reason. Not kept in the line: the next run gives it again, and a failing item's finding carries it. Null otherwise. */
  message: string | null;
  /** What backs an agent's answer: the probe's screenshot judgement, or the agent's word. Null when a check or a person answered. */
  verification: Verification | null;
  /** The agent's reason: why an item is n/a, or what it saw. */
  reason: string | null;
  /** The operator's note. */
  note: string | null;
  /** When the checklist last ran (its file's last_run). */
  updatedAt: string | null;
  /** The Lab finding of this item, when it fails (its id under lab/findings/). */
  finding: string | null;
}

export interface AttachedChecklist {
  id: string;
  title: string;
  summary: string;
  attachedAt: string;
  items: ItemState[];
  progress: {
    total: number;
    passing: number;
    requiredTotal: number;
    requiredPassing: number;
    requiredNotApplicable: number;
    /** Items with no answer yet (status unknown), of any kind. */
    unverified: number;
  };
}

export interface ItemRun {
  checklistId: string;
  itemId: string;
  check: CheckId;
  status: CheckStatus;
  evidence: string | null;
  message: string;
}

const requireChecklist = (id: string): Checklist => {
  const c = checklistById(id);
  if (!c) throw new UserError(`No checklist "${id}". The checklists: ${effectiveCatalog().map((x) => x.id).join(", ")}.`);
  return c;
};

/** The workspace, with its checklists imported from the old tables first (once). */
function requireWorkspace(id: string): Workspace {
  const w = Workspaces.get(id);
  if (!w) throw new UserError(`No workspace "${id}".`);
  importLegacy(w);
  return w;
}

/** The checklist as this project sees it (definition, project items, reconciled file). Refused when it is not attached. */
function requireProject(root: string, checklistId: string): ProjectChecklist {
  const p = projectChecklist(root, checklistId);
  if (p) return p;
  requireChecklist(checklistId);
  throw new UserError(`${checklistId} is not attached to this workspace. Attach it first.`);
}

/* -------------------------------------------------------------------------- */
/* Before the files: the SQLite tables, exported once                         */
/* -------------------------------------------------------------------------- */

const IMPORT_MARK = "checklist_imports";
const imported = new Set<string>();

const STATUS_OF: readonly string[] = ["pass", "fail", "na", "unknown"];
const SOURCE_OF: readonly string[] = ["auto", "agent", "manual"];
/** SQLite's CURRENT_TIMESTAMP ("2026-10-28 09:00:00", UTC) as the ISO time the files use. */
const isoOf = (v: string | null | undefined): string => {
  const s = String(v ?? "").trim();
  const d = new Date(/T/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return s && !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
};

/**
 * Exports a workspace's rows from the old `workspace_checklists` and `checklist_items` tables to files, the first time the
 * workspace is read. A checklist that already has a file is left alone. The tables stay where they are and are not used
 * again; the marker table records that the workspace was done, so a file a person deleted is not brought back from the rows.
 */
function importLegacy(w: Workspace): void {
  if (imported.has(w.id) || !fs.existsSync(w.path)) return;
  imported.add(w.id);
  const conn = db();
  conn.exec(`CREATE TABLE IF NOT EXISTS ${IMPORT_MARK} (workspace_id TEXT PRIMARY KEY, imported_at TEXT NOT NULL)`);
  if (conn.prepare(`SELECT 1 FROM ${IMPORT_MARK} WHERE workspace_id = ?`).get(w.id)) return;
  const have = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  if (have.has("workspace_checklists")) {
    const attached = conn.prepare("SELECT checklist_id, attached_at FROM workspace_checklists WHERE workspace_id = ? ORDER BY attached_at, rowid").all(w.id) as Array<{ checklist_id: string; attached_at: string | null }>;
    for (const r of attached) {
      const c = checklistById(r.checklist_id);
      if (!c || fs.existsSync(fileOf(w.path, c.id))) continue;
      const answers = new Map<string, ItemAnswer>();
      if (have.has("checklist_items")) {
        const rows = conn.prepare("SELECT item_id, status, source, evidence, reason, note FROM checklist_items WHERE workspace_id = ? AND checklist_id = ?").all(w.id, c.id) as Array<{ item_id: string; status: string; source: string | null; evidence: string | null; reason: string | null; note: string | null }>;
        for (const x of rows) {
          answers.set(x.item_id, {
            status: (STATUS_OF.includes(x.status) ? x.status : "unknown") as ItemAnswer["status"],
            source: x.source && SOURCE_OF.includes(x.source) ? (x.source as ItemAnswer["source"]) : null,
            evidence: x.evidence || null,
            message: null,
            reason: x.reason || null,
            note: x.note || null,
          });
        }
      }
      createChecklistFile(w.path, c, isoOf(r.attached_at), answers);
    }
  }
  conn.prepare(`INSERT INTO ${IMPORT_MARK} (workspace_id, imported_at) VALUES (?, ?)`).run(w.id, new Date().toISOString());
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function viewOf(c: Checklist, f: { attachedAt: string; lastRun: string | null; answers: Map<string, ItemAnswer> }, findings: Map<string, Finding>, judgements: Map<string, ScreenJudgement>): AttachedChecklist {
  const items: ItemState[] = c.items.map((it) => {
    const a = f.answers.get(it.id) ?? UNANSWERED;
    const judged = judgements.get(it.id);
    return {
      ...it,
      status: a.status,
      source: a.source,
      evidence: a.evidence,
      message: a.message ?? screenMessage(a, judged),
      verification: verificationOf(it.id, a, judged),
      reason: a.reason,
      note: a.note,
      updatedAt: f.lastRun,
      finding: findings.get(`${c.id}/${it.id}`)?.id ?? null,
    };
  });
  const required = items.filter((i) => i.severity === "required");
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    attachedAt: f.attachedAt,
    items,
    progress: {
      total: items.length,
      passing: items.filter((i) => i.status === "pass").length,
      requiredTotal: required.length,
      requiredPassing: required.filter((i) => i.status === "pass").length,
      requiredNotApplicable: required.filter((i) => i.status === "na").length,
      unverified: items.filter((i) => i.status === "unknown").length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Attach and detach                                                          */
/* -------------------------------------------------------------------------- */

/** Attaches a checklist of the catalog to a workspace: its file is created. Attaching twice is a no-op. */
export function attach(workspaceId: string, checklistId: string): AttachedChecklist {
  const w = requireWorkspace(workspaceId);
  const c = requireChecklist(checklistId);
  createChecklistFile(w.path, c, new Date().toISOString());
  return showAttached(workspaceId, c.id);
}

/** Detaches a checklist: its file is removed. Returns false when it was not attached. */
export function detach(workspaceId: string, checklistId: string): boolean {
  const w = requireWorkspace(workspaceId);
  const c = checklistById(checklistId);
  const removed = !!c && removeChecklistFile(w.path, c.id);
  if (removed) shipChecklistFindings(w.path, c!.id);
  return removed;
}

/** The attached checklists of a workspace, in the order they were attached. */
export function listAttached(workspaceId: string): AttachedChecklist[] {
  const w = requireWorkspace(workspaceId);
  const findings = findingsByItem(w.path);
  const out: AttachedChecklist[] = [];
  for (const c of effectiveCatalog()) {
    const p = projectChecklist(w.path, c.id);
    if (p) out.push(viewOf(p.checklist, p.file, findings, readJudgements(w.path, c.id)));
  }
  return out.sort((a, b) => a.attachedAt.localeCompare(b.attachedAt));
}

export function showAttached(workspaceId: string, checklistId: string): AttachedChecklist {
  const w = requireWorkspace(workspaceId);
  const p = requireProject(w.path, checklistId);
  return viewOf(p.checklist, p.file, findingsByItem(w.path), readJudgements(w.path, checklistId));
}

/** The stack the workspace's folder is, with the evidence for it. Read from the files; nothing is run. */
export function stackOf(workspaceId: string): StackDetection {
  const w = requireWorkspace(workspaceId);
  return detectStack(openRepo(w.path));
}

const itemOf = (c: Checklist, itemId: string): ChecklistItem => {
  const item = c.items.find((i) => i.id === itemId);
  if (!item) throw new UserError(`${c.id} has no item "${itemId}".`);
  return item;
};

/** The item as it reads now, with its finding. */
function itemStateOf(workspaceId: string, c: Checklist, itemId: string): ItemState {
  const found = showAttached(workspaceId, c.id).items.find((i) => i.id === itemId);
  return found!;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

export interface ItemInput {
  /** true: ticked (pass). false: unticked (unknown). null: forget the answer and let the checks decide again. */
  checked?: boolean | null;
  /** The operator's note. "" clears it. Omit to keep the current one. */
  note?: string | null;
}

/** Ticks, unticks or notes one item. A manual answer pins the item (see the header). */
export function setItem(workspaceId: string, checklistId: string, itemId: string, input: ItemInput): ItemState {
  const w = requireWorkspace(workspaceId);
  const { checklist: c, file } = requireProject(w.path, checklistId);
  const item = itemOf(c, itemId);
  const cur = file.answers.get(item.id) ?? UNANSWERED;
  let next: ItemAnswer;
  if (input.checked === null && input.note === undefined) next = UNANSWERED;
  else if (input.checked === null) next = { ...UNANSWERED, note: cur.note };
  else if (typeof input.checked === "boolean") {
    next = { status: input.checked ? "pass" : "unknown", source: "manual", evidence: cur.evidence, message: null, reason: null, note: input.note === undefined ? cur.note : input.note || null };
  } else next = { ...cur, note: input.note || null };
  patchChecklistFile(w.path, c, new Map([[item.id, next]]), new Date().toISOString());
  syncItemFinding(w.path, c, item, next);
  return itemStateOf(workspaceId, c, item.id);
}

/**
 * Disables an item for this project, or puts it back. A disabled item counts as not applicable (with the note DISABLED_NOTE),
 * is pinned like a tick, and its open finding ships. Putting it back clears the answer; the next run decides again. A required
 * item cannot be disabled, as it cannot be dismissed in Lab: it blocks a prod deploy until it passes or an agent records why it does not apply.
 */
export function setItemDisabled(workspaceId: string, checklistId: string, itemId: string, disabled: boolean): ItemState {
  const w = requireWorkspace(workspaceId);
  const { checklist: c, file } = requireProject(w.path, checklistId);
  const item = itemOf(c, itemId);
  const cur = file.answers.get(item.id) ?? UNANSWERED;
  if (disabled === isDisabled(cur)) return itemStateOf(workspaceId, c, item.id);
  if (disabled && item.severity === "required") {
    throw new UserError(`${item.id} is a required launch item, so it cannot be disabled for this project: it blocks a prod deploy until it passes. Fix it, or have the audit record why it does not apply.`);
  }
  patchChecklistFile(w.path, c, new Map([[item.id, disabled ? disabledAnswer(cur) : UNANSWERED]]), new Date().toISOString());
  if (disabled) closeItemFinding(w.path, c.id, item.id);
  return itemStateOf(workspaceId, c, item.id);
}

/** Adds a project-only item (agent or manual) to an attached checklist. */
export function addItemToProject(workspaceId: string, checklistId: string, input: unknown): ItemState {
  const w = requireWorkspace(workspaceId);
  const { checklist: c } = requireProject(w.path, checklistId);
  const item = addProjectItem(w.path, c, input);
  return itemStateOf(workspaceId, c, item.id);
}

/** Removes a project-only item. A catalog item is disabled instead (setItemDisabled). */
export function removeItemFromProject(workspaceId: string, checklistId: string, itemId: string): void {
  const w = requireWorkspace(workspaceId);
  const { checklist: c } = requireProject(w.path, checklistId);
  removeProjectItem(w.path, c, itemId);
  closeItemFinding(w.path, c.id, itemId);
}

/* -------------------------------------------------------------------------- */
/* Automatic checks                                                           */
/* -------------------------------------------------------------------------- */

export interface RunOptions {
  /** The running dev server or the deploy URL. Without it only the static checks run. */
  url?: string | null;
  fetch?: FetchFn;
  /** Takes the screenshots for the screen items. The default drives a headless Chrome; tests pass a fake. */
  shooter?: Shooter;
  maxPages?: number;
}

/**
 * Runs the automatic checks of every attached checklist and stores each answer. Items a person ticked are skipped.
 * Each check runs once per pass, however many items use it. An agent's answer is kept when the check cannot judge the item.
 * Each checklist's file gets its changed lines and a new last_run; a failing item opens its finding, a passing one ships it.
 * With a URL, the screen items (screens.ts) are then judged from screenshots of the page: the judge can fail an agent's pass, never pass an item.
 */
export async function runAutoChecks(workspaceId: string, opts: RunOptions = {}): Promise<{ ran: number; skipped: number; results: ItemRun[]; screens: ScreenRun[] }> {
  const w = requireWorkspace(workspaceId);
  let url: string | null = null;
  if (opts.url) {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      throw new UserError(`"${opts.url}" is not a URL.`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError("The URL must be http or https.");
    url = u.toString();
  }
  const run = makeChecker({ root: w.path, url, fetch: opts.fetch, maxPages: opts.maxPages });
  const byCheck = new Map<CheckId, CheckResult>();
  const results: ItemRun[] = [];
  let skipped = 0;
  const attached = listAttached(workspaceId);
  for (const a of attached) {
    const { checklist: c } = requireProject(w.path, a.id);
    const updates = new Map<string, ItemAnswer>();
    const changed: Array<{ item: ChecklistItem; answer: ItemAnswer; message: string }> = [];
    for (const it of a.items) {
      if (it.kind !== "auto" || !it.check) continue;
      if (it.source === "manual") {
        skipped++;
        continue;
      }
      let r = byCheck.get(it.check);
      if (!r) {
        r = await run(it.check);
        byCheck.set(it.check, r);
      }
      if (r.status === "unknown" && it.source === "agent") continue;
      const answer: ItemAnswer = { status: r.status, source: "auto", evidence: r.evidence, message: r.message, reason: null, note: it.note };
      updates.set(it.id, answer);
      changed.push({ item: it, answer, message: r.message });
      results.push({ checklistId: a.id, itemId: it.id, check: it.check, status: r.status, evidence: r.evidence, message: r.message });
    }
    if (!updates.size) continue;
    patchChecklistFile(w.path, c, updates, new Date().toISOString());
    for (const x of changed) syncItemFinding(w.path, c, x.item, x.answer, x.message);
  }
  const projects = attached.flatMap((a) => projectChecklist(w.path, a.id) ?? []);
  const screens = url ? await judgeScreens(w.path, projects, url, opts.shooter ?? browserShooter()) : [];
  return { ran: results.length, skipped, results, screens };
}

/* -------------------------------------------------------------------------- */
/* Agent answers                                                              */
/* -------------------------------------------------------------------------- */

export interface RecordInput {
  checklistId: string;
  itemId: string;
  status: AgentStatus;
  /** A URL, or a file in the project with an optional line: "app/page.tsx:12". */
  evidence?: string | null;
  /** Why na, or what the agent saw. Required for na. */
  note?: string | null;
}

/** Refuses evidence the project does not have: a file that is not there, a line past its end, or a path outside the project. */
function checkEvidence(root: string, evidence: string): void {
  if (/^https?:\/\//.test(evidence)) return;
  const m = /^(.+?)(?::(\d+))?$/.exec(evidence);
  const rel = m?.[1] ?? evidence;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new UserError(`Evidence "${evidence}" is outside the project.`);
  if (!fs.existsSync(abs)) throw new UserError(`Evidence "${evidence}" is not a file in this project. Cite a file that exists, with its line.`);
  if (m?.[2] && fs.statSync(abs).isFile()) {
    const lines = fs.readFileSync(abs, "utf-8").split("\n").length;
    if (Number(m[2]) > lines) throw new UserError(`Evidence "${evidence}": ${rel} has ${lines} lines.`);
  }
}

/**
 * Records an agent's answer to one item (checklist_record). Refused for a manual item (a person decides those), for an
 * item a person decided (a tick, or a dismissal in Lab), for an na with no reason, a pass with no evidence, and evidence the
 * project does not have. The ids must be attached to the workspace. A fail opens the item's finding; a pass ships it.
 */
export function recordResult(workspaceId: string, input: RecordInput): ItemState {
  const w = requireWorkspace(workspaceId);
  const { checklist: c, file } = requireProject(w.path, input.checklistId);
  const item = itemOf(c, input.itemId);
  if (item.kind === "manual") throw new UserError(`${item.id} is a manual item: a person decides it. Say what you see in your reply instead.`);
  const note = input.note?.trim() || null;
  const evidence = input.evidence?.trim() || null;
  if (input.status === "na" && !note) throw new UserError("na needs a reason in note: say why the item does not apply to this project.");
  if (input.status === "pass" && !evidence) throw new UserError("pass needs evidence: the file and line you read, such as app/page.tsx:12, or a URL you measured.");
  if (evidence) checkEvidence(w.path, evidence);
  const cur = file.answers.get(item.id) ?? UNANSWERED;
  if (cur.source === "manual") throw new UserError(`${item.id} was decided by hand (ticked, or dismissed in Lab). Untick it first to let the audit decide.`);
  const answer: ItemAnswer = { status: input.status, source: "agent", evidence, message: null, reason: note, note: cur.note };
  patchChecklistFile(w.path, c, new Map([[item.id, answer]]), new Date().toISOString());
  syncItemFinding(w.path, c, item, answer);
  return itemStateOf(workspaceId, c, item.id);
}

/* -------------------------------------------------------------------------- */
/* Audits and fixes (Lab passes)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Starts an audit: a Lab pass over every item not passing (or, with `fix`, over the failing and unknown ones), in sessions
 * of about ten items, run by the sweep runner. Each answer is recorded with checklist_record. Returns the first session's id.
 * Refuses when nothing is open. `checklistId` omitted covers every attached checklist.
 */
export function startAuditSession(workspaceId: string, checklistId?: string | null, opts: { fix?: boolean } = {}): string {
  return startChecklistPass(workspaceId, checklistId ?? null, { fix: !!opts.fix }).sessionId;
}

/** "Fix with agent": an audit that fixes failing and unknown items. Kept under its old name. */
export function startFixSession(workspaceId: string, checklistId: string): string {
  return startAuditSession(workspaceId, checklistId, { fix: true });
}

/* -------------------------------------------------------------------------- */
/* Deploy gate                                                                */
/* -------------------------------------------------------------------------- */

export interface LaunchBlocker {
  checklistId: string;
  checklistTitle: string;
  itemId: string;
  text: string;
  status: ItemStatus;
  message: string | null;
}

/**
 * Required items of the workspace's attached checklists that are not settled, read from their files. A pass, or an n/a with a
 * reason, settles an item. A fail, or an unknown (not checked yet, or not checkable on the stack and not yet audited), blocks.
 * Empty when a prod deploy may go ahead.
 */
export function launchBlockers(workspaceId: string): LaunchBlocker[] {
  return listAttached(workspaceId).flatMap((c) =>
    c.items
      .filter((i) => i.severity === "required" && i.status !== "pass" && i.status !== "na")
      .map((i) => ({ checklistId: c.id, checklistTitle: c.title, itemId: i.id, text: i.text, status: i.status, message: i.message })),
  );
}
