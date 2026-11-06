/**
 * The Specs module over HTTP. `:root` is a root reference (w_… or s_…), like the file API; paths are
 * relative to it and limited to specs/ and .specify/.
 *
 *   GET    /api/specs/:root                                  overview: constitution, features, numbering, rev
 *   POST   /api/specs/:root/constitution                     { project? }  write the template (never replaces)
 *   POST   /api/specs/:root/features                         { name, description? }  allocate NNN-name + spec.md
 *   GET    /api/specs/:root/features/:id                     one feature, with its parsed tasks
 *   GET    /api/specs/:root/file?path=                       read a spec file
 *   PUT    /api/specs/:root/file                             { path, content, expectedMtime?, create? }
 *   POST   /api/specs/:root/features/:id/tasks/toggle        { line, done? }  flip one checkbox
 *   POST   /api/specs/:root/features/:id/tasks/run           { line, sessionId?, asHead?, engine?, … }
 *   POST   /api/specs/:root/features/:id/implement           { parallel?, test?, maxTurns?, maxMinutes?, pairId?, … }
 *   POST   /api/specs/:root/steps/:step                      { feature?, input?, sessionId?, engine?, … }
 *   POST   /api/specs/:root/architecture                     { feature?, topic?, engine?, … }
 *   GET    /api/specs/:root/estimate?path=&mode=             token estimate of attaching something
 *   GET    /api/sessions/:id/specs                           what a session has attached, with its cost
 *   POST   /api/sessions/:id/specs                           { path, mode? }
 *   DELETE /api/sessions/:id/specs?path=
 */
import fs from "fs";
import path from "path";
import { resolveRoot } from "../../workspaces";
import { getSession, viewSession } from "../../sessions/manager";
import { attach, detach, estimatePath, estimateSession, listAttached, type AttachMode } from "../../specs/attach";
import { runTask, startArchitecture, startImplement, startImplementParallel, startStep, type ImplementOpts } from "../../specs/implement";
import { STEP_ORDER, type StepName } from "../../specs/prompts";
import { createFeature, featureFile, initConstitution, overview, readSpecFile, requireFeature, writeSpecFile } from "../../specs/store";
import { parseTasks, setTaskDone } from "../../specs/tasks";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

function runOpts(body: Record<string, any>): ImplementOpts {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    engine: str(body.engine),
    model: str(body.model),
    effort: str(body.effort),
    agent: str(body.agent),
    pairId: str(body.pairId ?? body.pair_id),
    isolate: body.isolate === true,
    sessionId: str(body.sessionId ?? body.session_id),
    test: str(body.test),
    maxTurns: num(body.maxTurns ?? body.max_turns),
    maxMinutes: num(body.maxMinutes ?? body.max_minutes),
    input: str(body.input),
  };
}

const view = (id: string) => viewSession(getSession(id)!, { withOutput: false });

function featureDetail(rootDir: string, id: string) {
  const f = requireFeature(rootDir, id);
  const tasksPath = f.files.tasks ? path.join(rootDir, f.dir, "tasks.md") : null;
  const parsed = tasksPath ? parseTasks(fs.readFileSync(tasksPath, "utf-8")) : null;
  return { feature: f, tasks: parsed };
}

const sessionRoutes: RouteModule = (c: Ctx) => {
  const m = c.match(/^\/api\/sessions\/([^/]+)\/specs$/);
  if (!m) return null;
  const s = getSession(m[1]);
  if (!s) throw new HttpError(404, `No session "${m[1]}".`);
  if (c.method === "GET") return json({ attached: listAttached(s.id), estimate: estimateSession(s.id) });
  if (c.method === "POST") {
    const mode = (c.body.mode ?? "ref") as AttachMode;
    const a = attach(s.id, String(c.body.path ?? ""), { mode, purpose: "context" });
    return json({ attached: a, estimate: estimateSession(s.id) }, 201);
  }
  if (c.method === "DELETE") {
    const p = c.q("path") ?? "";
    return json({ removed: detach(s.id, p), estimate: estimateSession(s.id) });
  }
  return null;
};

export const specsRoutes: RouteModule = async (c) => {
  const sess = sessionRoutes(c);
  if (sess) return sess;

  const m = c.match(/^\/api\/specs\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const root = resolveRoot(m[1]);
  const rest = m[2] ?? "";
  const rootDir = root.dir;

  if (rest === "" && c.method === "GET") return json({ specs: overview(rootDir) });

  if (rest === "/constitution" && c.method === "POST") {
    const r = initConstitution(rootDir, c.body.project);
    return json({ ...r, specs: overview(rootDir) }, 201);
  }

  if (rest === "/features" && c.method === "POST") {
    const feature = createFeature(rootDir, { name: String(c.body.name ?? ""), description: c.body.description });
    return json({ feature, specs: overview(rootDir) }, 201);
  }

  const fm = /^\/features\/([^/]+)(\/.*)?$/.exec(rest);
  if (fm) {
    const id = decodeURIComponent(fm[1]);
    const sub = fm[2] ?? "";
    if (sub === "" && c.method === "GET") return json(featureDetail(rootDir, id));

    if (sub === "/tasks/toggle" && c.method === "POST") {
      const f = requireFeature(rootDir, id);
      if (!f.files.tasks) throw new HttpError(404, "This feature has no tasks.md.");
      const file = path.join(rootDir, featureFile(f, "tasks"));
      const line = Number(c.body.line);
      if (!Number.isInteger(line) || line < 0) throw new HttpError(400, "line must be a zero-based line number.");
      let next: string;
      try {
        next = setTaskDone(fs.readFileSync(file, "utf-8"), line, typeof c.body.done === "boolean" ? c.body.done : undefined);
      } catch (e: any) {
        throw new HttpError(409, `${e.message} The file changed: reload it.`);
      }
      fs.writeFileSync(file, next);
      return json(featureDetail(rootDir, id));
    }

    if (sub === "/tasks/run" && c.method === "POST") {
      const line = Number(c.body.line);
      if (!Number.isInteger(line) || line < 0) throw new HttpError(400, "line must be a zero-based line number.");
      const session = runTask(rootDir, id, line, { ...runOpts(c.body), asHead: c.body.asHead === true || c.body.as_head === true });
      return json({ session: view(session.id) }, 201);
    }

    if (sub === "/implement" && c.method === "POST") {
      const o = runOpts(c.body);
      if (c.body.parallel === true) {
        const r = startImplementParallel(rootDir, id, { ...o, maxHeads: c.body.maxHeads ?? c.body.max_heads });
        return json({ mode: r.mode, note: r.note, heads: r.heads, skipped: r.skipped, session: view(r.session.id) }, 201);
      }
      const r = startImplement(rootDir, id, o);
      return json({ mode: "goal", note: null, heads: [], skipped: [], open: r.open, session: view(r.session.id) }, 201);
    }
    return null;
  }

  if (rest === "/file") {
    const rel = c.q("path") ?? String(c.body.path ?? "");
    if (c.method === "GET") return json(readSpecFile(rootDir, rel));
    if (c.method === "PUT") return json(writeSpecFile(rootDir, rel, String(c.body.content ?? ""), { expectedMtime: c.body.expectedMtime ?? null, create: c.body.create === true }));
  }

  const sm = /^\/steps\/([a-z]+)$/.exec(rest);
  if (sm && c.method === "POST") {
    if (!STEP_ORDER.includes(sm[1] as StepName)) throw new HttpError(404, `No step "${sm[1]}". Steps: ${STEP_ORDER.join(", ")}.`);
    const r = startStep(rootDir, sm[1] as StepName, { ...runOpts(c.body), feature: c.body.feature ?? null });
    return json({ session: view(r.session.id), feature: r.feature }, 201);
  }

  if (rest === "/architecture" && c.method === "POST") {
    const r = startArchitecture(rootDir, c.body.feature ?? null, c.body.topic ?? null, runOpts(c.body));
    return json({ session: view(r.session.id), feature: r.feature, tools: r.tools }, 201);
  }

  if (rest === "/estimate" && c.method === "GET") {
    const mode = (c.q("mode") ?? "ref") as AttachMode;
    return json(estimatePath(rootDir, c.q("path") ?? "", mode));
  }
  return null;
};
