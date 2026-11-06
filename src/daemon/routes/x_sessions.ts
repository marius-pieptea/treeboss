/**
 * Session housekeeping for the UI: rename, and delete what is already closed.
 *
 * Deliberately narrow. Closing is `POST /api/sessions/:id/close` (it unwinds worktrees and branches);
 * deleting here only removes the records of a session that is already closed, never a running one and never
 * anything on disk.
 */
import { db } from "../../db";
import { Hub } from "../../sessions/hub";
import { descendantsOf, getSession, treebossStateOf } from "../../sessions/manager";
import { isTreeboss, setOperatorTier, setTreeboss, TIERS, type Tier } from "../../treeboss/store";
import { HttpError, json, type RouteModule } from "../http";

export const sessionsExtRoutes: RouteModule = (c) => {
  // Timestamps the session view does not carry, for "5m ago" in the list. One cheap query for all sessions.
  if (c.path === "/api/session-times" && c.method === "GET") {
    const rows = db().prepare("SELECT id, created_at, updated_at FROM sessions").all() as Array<{ id: string; created_at: string; updated_at: string }>;
    return json({ times: Object.fromEntries(rows.map((r) => [r.id, { created_at: r.created_at, updated_at: r.updated_at }])) });
  }

  // Treeboss mode for one session: POST { enabled?, tier? }. Switching it on sends the rules again on the next turn.
  // tier is the operator's override ("tweak" | "feature" | "area"); null clears it. Either field alone is enough.
  const tb = c.match(/^\/api\/sessions\/([^/]+)\/treeboss$/);
  if (tb && c.method === "POST") {
    const ts = getSession(tb[1]);
    if (!ts) throw new HttpError(404, `No session "${tb[1]}".`);
    const { enabled, tier } = c.body;
    if (enabled === undefined && tier === undefined) throw new HttpError(400, "Send enabled (true or false) and/or tier (tweak, feature, area or null).");
    if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    if (tier !== undefined && tier !== null && !TIERS.includes(tier)) throw new HttpError(400, "tier must be tweak, feature, area or null.");
    if (enabled !== undefined) setTreeboss(ts.id, enabled);
    if (tier !== undefined) setOperatorTier(ts.id, tier as Tier | null);
    Hub.publish({ type: "state", sessionId: ts.id, rootId: ts.root_id, status: ts.status });
    return json({ treeboss: isTreeboss(ts.id), treeboss_state: treebossStateOf(ts.id) });
  }

  const m = c.match(/^\/api\/sessions\/([^/]+)$/);
  if (!m) return null;
  const s = getSession(m[1]);

  if (c.method === "PATCH") {
    if (!s) throw new HttpError(404, `No session "${m[1]}".`);
    const sets: string[] = [];
    const values: Array<string | null> = [];
    let title: string | undefined;
    if (c.body.title !== undefined) {
      title = String(c.body.title).replace(/\s+/g, " ").trim().slice(0, 100);
      if (!title) throw new HttpError(400, "A title is required.");
      sets.push("title = ?");
      values.push(title);
    }
    if (c.body.pinned !== undefined) {
      // Pinning stamps the time, so the pinned group keeps the order the operator made them in.
      sets.push("pinned_at = ?");
      values.push(c.body.pinned ? new Date().toISOString() : null);
    }
    if (!sets.length) throw new HttpError(400, "Nothing to change: send a title or pinned.");
    db().prepare(`UPDATE sessions SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, s.id);
    // The sidebar and header refetch on state events.
    Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
    return json({ ok: true, ...(title !== undefined ? { title } : {}), pinned: c.body.pinned !== undefined ? Boolean(c.body.pinned) : s.pinned_at !== null });
  }

  if (c.method === "DELETE") {
    if (!s) throw new HttpError(404, `No session "${m[1]}".`);
    const family = [s, ...descendantsOf(s.id)];
    const open = family.filter((x) => x.status !== "closed");
    if (open.length) {
      throw new HttpError(409, open.length === 1 && open[0].id === s.id ? `Session ${s.id} is ${s.status}. Close it before deleting.` : `${open.length} sessions under ${s.id} are still open. Close it first.`);
    }
    const ids = family.map((x) => x.id);
    const marks = ids.map(() => "?").join(", ");
    db().transaction(() => {
      db().prepare(`DELETE FROM events WHERE session_id IN (${marks})`).run(...ids);
      db().prepare(`DELETE FROM turns WHERE session_id IN (${marks})`).run(...ids);
      // Children first: parent_id is ON DELETE SET NULL, but a child row has no business outliving its parent.
      db().prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...[...ids].reverse());
    })();
    Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: "closed" });
    return json({ deleted: ids.length });
  }
  return null;
};
