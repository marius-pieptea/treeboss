/**
 * Command receipts: makes the subagent tools safe to retry.
 *
 * A subagent tool call may carry a `command_id`. The first call with that id (per calling session and tool) does the
 * work and stores the response it got; a retry with the same id returns the stored response and does nothing again.
 * The receipt is written in the same SQLite transaction as the work's DB writes, so a call either lands with its
 * receipt or not at all. A refusal (an `Error:` the caller can act on) throws, rolls back, and stores nothing, so the
 * caller can fix the cause and retry with the same id.
 */
import { db } from "../db";
import { clean } from "../util";
import type { Caller } from "./manager";

/** Receipts older than this are pruned at daemon start. A retry after that long is treated as a new call. */
export const RECEIPT_TTL_DAYS = 7;

/** What `run` returns: its response text, and whether that response is receipted (false: it changed nothing, so a retry should re-check). */
export type Outcome = string | { text: string; receipt: false };

/**
 * Run `run` at most once for (caller session, tool, command_id). Without a command_id it just runs. `run` must be
 * synchronous: its DB writes are the transaction, and a throw rolls them back.
 */
export function withReceipt(caller: Caller, tool: string, commandId: unknown, run: () => Outcome): string {
  const id = clean(commandId);
  if (!id) return textOf(run());
  const sessionId = caller.sessionId ?? "operator";
  const conn = db();
  return conn
    .transaction(() => {
      const hit = conn
        .prepare("SELECT result_json FROM command_receipts WHERE session_id = ? AND tool = ? AND command_id = ?")
        .get(sessionId, tool, id) as { result_json: string } | null;
      if (hit) return hit.result_json;
      const out = run();
      const text = textOf(out);
      if (typeof out === "string" || out.receipt !== false) {
        conn.prepare("INSERT INTO command_receipts (command_id, tool, session_id, result_json) VALUES (?, ?, ?, ?)").run(id, tool, sessionId, text);
      }
      return text;
    })
    .immediate();
}

const textOf = (out: Outcome): string => (typeof out === "string" ? out : out.text);

/** Delete receipts older than RECEIPT_TTL_DAYS. `created_at` is UTC `YYYY-MM-DD HH:MM:SS`, which sorts as text. */
export function pruneCommandReceipts(now = new Date()): number {
  const cutoff = new Date(now.getTime() - RECEIPT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  return db().prepare("DELETE FROM command_receipts WHERE created_at < ?").run(cutoff).changes;
}
