/**
 * The Lab module over HTTP. `:root` is a root reference (w_… or s_…), like the file API. Findings are files
 * under lab/findings/; these routes read them, change a few keys, and start the sessions that write or act on them.
 *
 *   GET    /api/lab/:root                              state: findings (with fixRunning), lenses (runnable ones are picked), recent runs, sweeps
 *   GET    /api/lab/:root/summary                      { open, total, running }: what the activity badge shows, nothing else
 *   GET    /api/lab/:root/modules                      the folders a sweep can cover, with their size (cached for a minute)
 *   POST   /api/lab/:root/run                          { lens, scope?, note?, engine?, model?, effort?, agent?, pairId?, sessionId? }
 *   GET    /api/lab/:root/sweep?lens=&scopes=&limit=   what a sweep would cover, with a token estimate (starts nothing)
 *   POST   /api/lab/:root/sweep                        { lens, scopes?, limit?, parallel?, note?, engine?, … }  one run per module, `parallel` (default 3) at a time
 *                                                      (the checklist lens is not swept from here: the checklist panel starts those)
 *   POST   /api/lab/:root/bugs                         a bug report from the browser, with feature? (a feature id) (lab/capture.ts)  ->  201 the logged bug
 *   POST   /api/lab/:root/sweeps/:id/cancel            stop starting new modules; running ones finish
 *   GET    /api/lab/:root/estimate?scope=              files and tokens in a scope
 *   PATCH  /api/lab/:root/findings/:id                 { status?, impact?, effort?, feature? }  (feature: the feature id a bug is filed under, or null; dismissing a checklist finding marks its item n/a; a required one is refused)
 *   DELETE /api/lab/:root/findings/:id
 *   POST   /api/lab/:root/findings/:id/roadmap         { lane? }  add to the roadmap
 *   POST   /api/lab/:root/findings/:id/spec            start the spec workflow from it
 *   POST   /api/lab/:root/findings/:id/fix             { engine?, … }  a build session that implements it (not a bug: bugs are fixed from the QA view)
 *   POST   /api/lab/:root/findings/:id/design          a design review focused on it
 */
import { resolveRoot } from "../../workspaces";
import { getSession, viewSession } from "../../sessions/manager";
import { LENSES, listFindings, removeFinding, type Finding } from "../../lab/findings";
import { LENS_DEFS, PICKABLE_LENSES } from "../../lab/lenses";
import { patchLabFinding } from "../../checklists/findings";
import { checkScope, discoverModules, estimateScope, findingToRoadmap, findingToSpec, fixFinding, listRuns, markRoadmapShipped, planSweep, reviewFindingDesign, startLab, summaryOf, type LabOpts } from "../../lab/sessions";
import { db } from "../../db";
import { cancelSweep, listSweeps, startSweep } from "../../lab/sweeps";
import { logBug, parseBugReport } from "../../lab/capture";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const optsOf = (b: Record<string, any>): LabOpts => ({
  engine: str(b.engine),
  model: str(b.model),
  effort: str(b.effort),
  agent: str(b.agent),
  pairId: str(b.pairId ?? b.pair_id),
  note: str(b.note),
  sessionId: str(b.sessionId ?? b.session_id),
});

const view = (id: string) => viewSession(getSession(id)!, { withOutput: false });

const scopesOf = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

/** The ids of the sessions running now: a finding's fix is running when its session is one of them. */
const runningSessionIds = (): Set<string> => new Set((db().prepare("SELECT id FROM sessions WHERE status = 'running'").all() as Array<{ id: string }>).map((r) => r.id));

/** A limit from the query or the body: a whole number of at least 1, or nothing. Anything else is the caller's mistake. */
function limitOf(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a whole number, 1 or more.");
  return n;
}

function state(dir: string) {
  markRoadmapShipped(dir);
  const running = runningSessionIds();
  const findings = listFindings(dir).map((f) => ({ ...f, fixRunning: !!f.fixSession && running.has(f.fixSession) }));
  return {
    findings,
    open: findings.filter((f) => f.status === "new" || f.status === "accepted").length,
    lenses: LENSES.map((l) => ({ id: l, label: LENS_DEFS[l].label, hint: LENS_DEFS[l].hint, runnable: PICKABLE_LENSES.includes(l) })),
    runs: listRuns(dir),
    sweeps: listSweeps(dir),
  };
}

export const labRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/lab\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2] ?? "";
  const b = c.body;

  if (rest === "" && c.method === "GET") return json(state(dir));

  if (rest === "run" && c.method === "POST") {
    const session = startLab(dir, String(b.lens ?? ""), str(b.scope), optsOf(b));
    return json({ session: view(session.id) }, 201);
  }
  if (rest === "summary" && c.method === "GET") return json(summaryOf(dir));
  if (rest === "modules" && c.method === "GET") return json({ modules: discoverModules(dir) });
  if (rest === "sweep" && c.method === "GET") return json({ plan: planSweep(dir, c.q("lens") ?? "", scopesOf(c.q("scopes")), limitOf(c.q("limit"))) });
  if (rest === "sweep" && c.method === "POST") {
    if (String(b.lens ?? "") === "checklist") throw new HttpError(400, "Checklist passes start from the checklist panel, with their items.");
    const r = startSweep(dir, String(b.lens ?? ""), scopesOf(b.scopes), { ...optsOf(b), limit: limitOf(b.limit), parallel: typeof b.parallel === "number" ? b.parallel : null });
    return json({ sweepId: r.sweepId, plan: r.plan, sessions: r.sessions.map((s) => view(s.id)) }, 201);
  }
  if (rest === "bugs" && c.method === "POST") return json(await logBug(dir, parseBugReport(b)), 201);
  const sw = /^sweeps\/([^/]+)\/cancel$/.exec(rest);
  if (sw && c.method === "POST") {
    const r = cancelSweep(dir, decodeURIComponent(sw[1]!));
    if (!r) throw new HttpError(404, `No sweep "${sw[1]}".`);
    return json({ sweep: r });
  }
  if (rest === "estimate" && c.method === "GET") {
    const scope = checkScope(dir, c.q("scope"));
    return json({ scope, ...estimateScope(dir, scope) });
  }

  const f = /^findings\/([^/]+)(?:\/(roadmap|spec|fix|design))?$/.exec(rest);
  if (f) {
    const id = decodeURIComponent(f[1]!);
    const act = f[2];
    const reply = (finding: Finding, extra: Record<string, unknown> = {}) => json({ finding, ...extra });
    if (!act && c.method === "PATCH") {
      if (b.confirmed !== undefined) throw new HttpError(400, "Unknown field confirmed.");
      if (b.feature !== undefined && b.feature !== null && typeof b.feature !== "string") throw new HttpError(400, "feature must be a feature id or null.");
      return reply(patchLabFinding(dir, id, { status: str(b.status) as any ?? undefined, impact: str(b.impact) as any ?? undefined, effort: str(b.effort) as any ?? undefined, feature: b.feature }));
    }
    if (!act && c.method === "DELETE") {
      removeFinding(dir, id);
      return json({ ok: true });
    }
    if (act === "roadmap" && c.method === "POST") {
      const r = findingToRoadmap(dir, id, str(b.lane));
      return reply(r.finding, { itemId: r.itemId });
    }
    if (act === "spec" && c.method === "POST") {
      const r = findingToSpec(dir, id, optsOf(b));
      return reply(r.finding, { itemId: r.itemId, session: view(r.session.id) });
    }
    if (act === "fix" && c.method === "POST") {
      const r = fixFinding(dir, id, optsOf(b));
      return reply(r.finding, { session: view(r.session.id) });
    }
    if (act === "design" && c.method === "POST") {
      const r = reviewFindingDesign(dir, id, optsOf(b));
      return reply(r.finding, { session: view(r.session.id) });
    }
  }
  throw new HttpError(404, `No lab route ${c.method} ${c.path}.`);
};
