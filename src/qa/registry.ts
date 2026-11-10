/**
 * Which sessions are QA sessions, read from `qa_sessions` (db.ts). Nothing here imports the session manager, so the
 * manager can ask "does this session get the QA tools?" without a cycle (qa/sessions.ts imports the manager).
 */
import { db } from "../db";
import type { QaKind } from "./types";

export interface QaRow {
  session_id: string;
  root_dir: string;
  /** A plan slug, or FEATURES_KEY for the feature-map session. */
  plan: string;
  kind: QaKind;
  problem: string | null;
  /** The proposals file as the turn started, so a file left by an earlier turn is not mistaken for this turn's work. */
  proposals_sig: string | null;
  run_id: string | null;
  batch_id: string | null;
}

/** The `plan` of the feature-map session: not a valid slug, so it never clashes with a plan. */
export const FEATURES_KEY = "@features";

/** Sessions that drive the app and get qa_record and bug_log (draft and suggest only write a file). */
const TOOL_KINDS: readonly QaKind[] = ["run", "explore", "map"];

export const qaRow = (sessionId: string): QaRow | null => db().prepare("SELECT * FROM qa_sessions WHERE session_id = ?").get(sessionId) as QaRow | null;

export function usesQaTools(sessionId: string): boolean {
  const r = qaRow(sessionId);
  return !!r && TOOL_KINDS.includes(r.kind);
}
