/**
 * Manual QA plans and runs over HTTP. `:root` is a root reference (w_… or s_…), like the lab API. Types are in qa/types.ts.
 * Errors are `{ error }`: 400 for a bad request, 404 for a missing plan, proposal, run or step, 409 while a QA session
 * is already working on the plan.
 *
 *   GET    /api/qa/:root/plans
 *            -> { plans: PlanSummary[] }   PlanSummary { slug, title, steps, proposals, problem|null, updatedAt, lastRun: RunSummary|null }
 *   POST   /api/qa/:root/plans            { title, from?: PlanSource, note?, engine?, model?, effort?, agent?, pairId? }
 *            -> 201 { plan: Plan, session: QaSession|null }   with `from`, a draft session starts and writes proposals (a draft from text needs `note`)
 *   GET    /api/qa/:root/plans/:slug
 *            -> { plan: Plan, runs: RunSummary[] (newest first), lastOutcomes: { [stepId]: { run, at, outcome } }, session: QaSession|null }
 *   PATCH  /api/qa/:root/plans/:slug      { edit: PlanEdit }                 -> { plan: Plan }
 *   DELETE /api/qa/:root/plans/:slug                                         -> { ok: true }   (its runs go too)
 *   POST   /api/qa/:root/plans/:slug/proposals/:pid   { decision: "accept"|"reject" }   -> { plan: Plan }   :pid is a proposal id or "all"
 *   POST   /api/qa/:root/plans/:slug/suggest   { focus?: Focus[], note?, engine?, … }   -> 201 { session: QaSession }
 *   POST   /api/qa/:root/plans/:slug/runs                                    -> 201 { run: Run, summary: RunSummary }   copies the plan's steps now
 *   GET    /api/qa/:root/runs/:id                                            -> { run: Run, summary: RunSummary }
 *   PUT    /api/qa/:root/runs/:id/steps/:sid  { outcome: { state, note?, actual?, bug? } }   -> { run: Run, summary: RunSummary }
 *
 *   PlanSource  { kind: "spec", dir } | { kind: "diff", base, head } | { kind: "page", path } | { kind: "text" } | { kind: "manual" }
 *   Plan        { slug, title, source, intro, steps: [{ id, action, expected, path|null }],
 *                 proposals: [{ id, step: { action, expected, path|null }, after: stepId|"start", why, orphan }],
 *                 problem|null (the plan file is unreadable: steps are empty, edits are refused), proposalsProblem|null }
 *   PlanEdit    { op: "add", step: { action, expected?, path? }, after: stepId|"start" } | { op: "update", id, fields: { action?, expected?, path? } }
 *               | { op: "move", id, after: stepId|"start" } | { op: "remove", id }          (path: "/…" or a localhost URL, null clears it)
 *   Focus       "errors" | "edge-cases" | "mobile" | "accessibility" | "empty-states" | "permissions"
 *   QaSession   { sessionId, kind: "draft"|"suggest", running, problem|null }   problem: the turn ended without usable proposals
 *   Run         { id, plan, root, startedAt, steps: [{ id, action, expected, path|null, outcome: Outcome }] }
 *   Outcome     { state: "pending" } | { state: "pass"|"skip", at, note } | { state: "blocked", at, note (not empty) }
 *               | { state: "fail", at, actual, bug: findingId|null }
 *   RunSummary  { id, plan, startedAt, counts: { pending, pass, fail, skip, blocked }, finished, states: { [stepId]: state } }
 *
 * `at` is set by the daemon when the outcome is recorded; the request omits it. A request outcome may be
 * { state: "pending" } to undo a mark.
 */
import { resolveRoot } from "../../workspaces";
import type { LabOpts } from "../../lab/sessions";
import { createPlan, decide, editPlan, listPlans, parsePlanEdit, parsePlanSource, planSlug, proposalId, QaNotFound, readPlan, removePlan, stepId } from "../../qa/plan";
import { getRun, lastOutcomes, listRuns, parseOutcome, runId, setOutcome, startRun, summarize } from "../../qa/runs";
import { parseQaAsk, qaSession, startQaSession } from "../../qa/sessions";
import type { Decision, PlanSlug, Run } from "../../qa/types";
import { realOf } from "../../lab/tables";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const optsOf = (b: Record<string, any>): LabOpts => ({ engine: str(b.engine), model: str(b.model), effort: str(b.effort), agent: str(b.agent), pairId: str(b.pairId ?? b.pair_id), note: str(b.note), sessionId: str(b.sessionId ?? b.session_id) });

const dec = (v: unknown): string => decodeURIComponent(String(v));

function idle(dir: string, slug: PlanSlug): void {
  if (qaSession(dir, slug)?.running) throw new HttpError(409, `A QA session is already working on "${slug}". Wait for it to finish.`);
}

/** A run of this project, or a 404: a run id from another project is not found here. */
function runOf(dir: string, rawId: string): Run {
  const run = getRun(runId(dec(rawId)));
  if (!run || run.root !== realOf(dir)) throw new HttpError(404, `No run "${dec(rawId)}".`);
  return run;
}

const runReply = (run: Run, status = 200) => json({ run, summary: summarize(run) }, status);

async function handle(c: Ctx): Promise<Response | null> {
  const m = c.match(/^\/api\/qa\/([^/]+)\/(.*)$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2]!;
  const b = c.body;

  if (rest === "plans" && c.method === "GET") return json({ plans: listPlans(dir) });
  if (rest === "plans" && c.method === "POST") {
    const given = b.from === undefined || b.from === null ? null : parsePlanSource(b.from);
    const from = given?.kind === "manual" ? null : given;
    const ask = from ? parseQaAsk("draft", { from, note: b.note }) : null;
    const plan = createPlan(dir, String(b.title ?? ""), from ?? { kind: "manual" });
    if (!ask) return json({ plan, session: null }, 201);
    try {
      startQaSession(dir, plan.slug, ask, optsOf(b));
    } catch (e) {
      removePlan(dir, plan.slug);
      throw e;
    }
    return json({ plan, session: qaSession(dir, plan.slug) }, 201);
  }

  const p = /^plans\/([^/]+)(?:\/(.*))?$/.exec(rest);
  if (p) {
    const slug = planSlug(dec(p[1]));
    const sub = p[2] ?? "";
    if (sub === "" && c.method === "GET") {
      return json({ plan: readPlan(dir, slug), runs: listRuns(dir, slug), lastOutcomes: lastOutcomes(dir, slug), session: qaSession(dir, slug) });
    }
    if (sub === "" && c.method === "PATCH") return json({ plan: editPlan(dir, slug, parsePlanEdit(b.edit)) });
    if (sub === "" && c.method === "DELETE") {
      removePlan(dir, slug);
      return json({ ok: true });
    }
    const pr = /^proposals\/([^/]+)$/.exec(sub);
    if (pr && c.method === "POST") {
      if (b.decision !== "accept" && b.decision !== "reject") throw new HttpError(400, 'decision must be "accept" or "reject".');
      const which = dec(pr[1]) === "all" ? "all" : proposalId(dec(pr[1]));
      return json({ plan: decide(dir, slug, which, b.decision as Decision) });
    }
    if (sub === "suggest" && c.method === "POST") {
      readPlan(dir, slug);
      idle(dir, slug);
      const ask = parseQaAsk("suggest", b);
      startQaSession(dir, slug, ask, optsOf(b));
      return json({ session: qaSession(dir, slug) }, 201);
    }
    if (sub === "runs" && c.method === "POST") return runReply(startRun(dir, readPlan(dir, slug)), 201);
  }

  const r = /^runs\/([^/]+)(?:\/steps\/([^/]+))?$/.exec(rest);
  if (r) {
    const run = runOf(dir, r[1]!);
    if (!r[2] && c.method === "GET") return runReply(run);
    if (r[2] && c.method === "PUT") {
      const step = stepId(dec(r[2]));
      if (!run.steps.some((s) => s.id === step)) throw new HttpError(404, `Step ${step} is not in run ${run.id}.`);
      return runReply(setOutcome(run.id, step, parseOutcome(b.outcome)));
    }
  }
  throw new HttpError(404, `No QA route ${c.method} ${c.path}.`);
}

export const qaRoutes: RouteModule = async (c) => {
  try {
    return await handle(c);
  } catch (e) {
    if (e instanceof QaNotFound) throw new HttpError(404, e.message);
    throw e;
  }
};
