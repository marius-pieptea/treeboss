/**
 * Checklist audits and fixes, launched through Lab. A pass is a sweep of the lens `checklist`: the open items are split into
 * chunks (plan.ts), one session per chunk, bounded in parallel and restart-safe (lab/sweeps.ts). The sessions answer with
 * checklist_record (tools.ts), which is allowed only for a session the launch registered (lab/tables.ts).
 */
import { UserError } from "../util";
import { Workspaces } from "../workspaces";
import { cancelSweep, startSweep } from "../lab/sweeps";
import { checklistById, effectiveCatalog } from "./custom";
import { readChecklistFile } from "./files";
import { passChunks } from "./plan";

export interface PassStart {
  sessionId: string;
  sweepId: string;
  /** How many sessions the pass takes in all: one per chunk. The first ones start now, the rest as those stop. */
  chunks: number;
}

/** A pass's options: what it does, and which engine and model it runs on. An empty one takes the default engine. */
export interface PassOpts {
  fix?: boolean;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
}

/**
 * Starts a pass over one attached checklist, or over all of them. `fix` changes the failing and unknown items; without it
 * the pass only reads the code and records. Refuses when nothing is attached or nothing is open.
 */
export function startChecklistPass(workspaceId: string, checklistId: string | null, opts: PassOpts = {}): PassStart {
  const w = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  const fix = !!opts.fix;
  let ids: string[];
  let title = "all checklists";
  if (checklistId) {
    const c = checklistById(checklistId);
    if (!c) throw new UserError(`No checklist "${checklistId}". The checklists: ${effectiveCatalog().map((x) => x.id).join(", ")}.`);
    if (!readChecklistFile(w.path, c.id)) throw new UserError(`${c.id} is not attached to this workspace. Attach it first.`);
    ids = [c.id];
    title = c.title;
  } else {
    ids = effectiveCatalog().filter((c) => readChecklistFile(w.path, c.id)).map((c) => c.id);
  }
  if (!ids.length) throw new UserError("No checklist is attached to this workspace. Attach one first.");
  const chunks = passChunks(w.path, ids, fix);
  if (!chunks.length) throw new UserError(`Nothing to ${fix ? "fix" : "audit"}: every item in ${title} passes or was decided by hand.`);
  const r = startSweep(w.path, "checklist", chunks, { workspaceId, fix, engine: opts.engine, model: opts.model, effort: opts.effort });
  const first = r.sessions[0];
  if (!first) {
    cancelSweep(w.path, r.sweepId);
    throw new UserError("The checklist pass did not start a session. Check the engine and the agent settings, then try again.");
  }
  return { sessionId: first.id, sweepId: r.sweepId, chunks: chunks.length };
}
