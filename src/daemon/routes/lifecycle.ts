/**
 * Checkpoints and verification over HTTP.
 *
 *   GET  /api/sessions/:id/checkpoints                       the session's checkpoints and turns
 *   POST /api/sessions/:id/turns/:turnId/rewind              put the files back to before that turn
 *   POST /api/sessions/:id/revert-turn                       the same for the last turn; { filesOnly: true } is required (no conversation rollback)
 *   POST /api/sessions/:id/turns/:turnId/fork                a new lead that starts from the end of that turn
 *                                                            { instructions?, engine?, model?, effort?, agent?, pair? }
 *
 *   GET  /api/sessions/:id/verify                            state, effective settings, commands, recent runs
 *   PUT  /api/sessions/:id/verify                            { enabled: true | false | null }  this session's switch
 *   POST /api/sessions/:id/verify/run                        { fix?: boolean }  run the checks now (idle sessions)
 *   POST /api/sessions/:id/verify/stop                       kill a running verification
 *   GET  /api/verify/config                                  the global settings
 *   PUT  /api/verify/config                                  { enabled?, commands?, max_retries?, timeout_sec? } (null clears)
 *   GET  /api/workspaces/:id/verify                          the workspace's settings, and what would be detected
 *   PUT  /api/workspaces/:id/verify                          same body as the global one
 */
import { db } from "../../db";
import { forkSession, rewindSession } from "../../checkpoints/fork";
import { revertLastTurn } from "../../checkpoints/revert";
import { listCheckpoints } from "../../checkpoints/store";
import { getSession, viewSession } from "../../sessions/manager";
import { detectVerifyCommands, parseCommands } from "../../verify/detect";
import { commandsFor, isVerifying, runVerifyNow, stopVerify, verifyView } from "../../verify/loop";
import { getConfig, getGlobalConfig, getSessionRow, listRuns, patchSession, resolveConfig, setConfig, setGlobalConfig, type VerifyConfig } from "../../verify/store";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

function sessionOr404(id: string) {
  const s = getSession(id);
  if (!s) throw new HttpError(404, `No session "${id}".`);
  return s;
}

/** A settings body: only the keys present change; null clears one back to inheriting. */
function configPatch(body: Ctx["body"]): Partial<VerifyConfig> {
  const patch: Partial<VerifyConfig> = {};
  try {
    if ("enabled" in body) patch.enabled = body.enabled === null ? null : Boolean(body.enabled);
    if ("commands" in body) patch.commands = body.commands === null ? null : parseCommands(body.commands);
    if ("max_retries" in body) patch.max_retries = body.max_retries === null ? null : Number(body.max_retries);
    if ("timeout_sec" in body) patch.timeout_sec = body.timeout_sec === null ? null : Number(body.timeout_sec);
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
  return patch;
}

function applyConfig(scope: string | null, body: Ctx["body"]): VerifyConfig {
  const patch = configPatch(body);
  try {
    return scope === null ? setGlobalConfig(patch) : setConfig(scope, patch);
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
}

export const lifecycleRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;

  /* ---- checkpoints ---- */
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/checkpoints$/)) && c.method === "GET") {
    const s = sessionOr404(m[1]);
    const turns = db().prepare("SELECT id, seq, status, prompt, started_at, finished_at FROM turns WHERE session_id = ? ORDER BY seq").all(s.id) as Array<{ id: string; seq: number; status: string; prompt: string; started_at: string; finished_at: string | null }>;
    const checkpoints = listCheckpoints(s.id).map((cp) => ({ id: cp.id, kind: cp.kind, turn_id: cp.turn_id, seq: cp.seq, ref: cp.ref, commit: cp.commit_sha.slice(0, 10), changed: cp.changed, created_at: cp.created_at }));
    return json({
      checkpoints,
      turns: turns.map((t) => ({ id: t.id, seq: t.seq, status: t.status, prompt: t.prompt.replace(/\s+/g, " ").trim().slice(0, 160), started_at: t.started_at, finished_at: t.finished_at })),
      can_rewind: s.status === "idle" || s.status === "failed",
      closed: s.status === "closed",
    });
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/rewind$/)) && c.method === "POST") {
    const s = sessionOr404(m[1]);
    const r = rewindSession(s.id, m[2]);
    return json({ turn: r.turn, restored: r.restored, removed: r.removed, failed: r.failed, undo_ref: r.undo?.ref ?? null, session: viewSession(getSession(s.id)!, { withOutput: false }) });
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/revert-turn$/)) && c.method === "POST") {
    const s = sessionOr404(m[1]);
    const r = revertLastTurn(s.id, { filesOnly: c.body.filesOnly === true });
    return json({ turn: r.turn, restored: r.restored, removed: r.removed, failed: r.failed, undo_ref: r.undo?.ref ?? null, session: viewSession(getSession(s.id)!, { withOutput: false }) });
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/fork$/)) && c.method === "POST") {
    const s = sessionOr404(m[1]);
    const r = forkSession(s.id, m[2], { instructions: c.body.instructions, engine: c.body.engine, model: c.body.model, effort: c.body.effort, agent: c.body.agent, pairId: c.body.pair });
    return json({ session: viewSession(r.session, { withOutput: false }), from_turn: r.turn, ref: r.checkpoint.ref }, 201);
  }

  /* ---- verification ---- */
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/verify$/))) {
    const s = sessionOr404(m[1]);
    if (c.method === "PUT") {
      if (!("enabled" in c.body)) throw new HttpError(400, "Pass { enabled: true | false | null }.");
      patchSession(s.id, { enabled: c.body.enabled === null ? null : c.body.enabled ? 1 : 0 });
    } else if (c.method !== "GET") return null;
    const cfg = resolveConfig(s.id, s.base_cwd);
    const { commands, source } = commandsFor(s, cfg.commands);
    return json({
      view: verifyView(s) ?? { state: "unknown", done: false, note: null, attempts: 0, last: null },
      enabled: cfg.enabled,
      enabled_from: cfg.enabled_from,
      session_enabled: getSessionRow(s.id)?.enabled ?? null,
      max_retries: cfg.max_retries,
      timeout_sec: cfg.timeout_sec,
      commands,
      commands_from: source,
      running: isVerifying(s.id),
      runs: listRuns(s.id, 8),
    });
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/verify\/run$/)) && c.method === "POST") {
    const s = sessionOr404(m[1]);
    let outcome;
    try {
      outcome = await runVerifyNow(s.id, { fix: Boolean(c.body.fix) });
    } catch (err: any) {
      throw new HttpError(400, err.message);
    }
    return json({ state: outcome.state, continued: outcome.continued, session: viewSession(getSession(s.id)!, { withOutput: false }) });
  }
  if ((m = c.match(/^\/api\/sessions\/([^/]+)\/verify\/stop$/)) && c.method === "POST") {
    const s = sessionOr404(m[1]);
    return json({ stopped: stopVerify(s.id) });
  }
  if (c.path === "/api/verify/config") {
    if (c.method === "GET") return json({ config: getGlobalConfig() });
    if (c.method === "PUT") return json({ config: applyConfig(null, c.body) });
  }
  if ((m = c.match(/^\/api\/workspaces\/([^/]+)\/verify$/))) {
    const ws = Workspaces.get(m[1]);
    if (!ws) throw new HttpError(404, `No workspace "${m[1]}".`);
    if (c.method === "PUT") applyConfig(ws.path, c.body);
    else if (c.method !== "GET") return null;
    return json({ config: getConfig(ws.path), global: getGlobalConfig(), detected: detectVerifyCommands(ws.path) });
  }
  return null;
};
