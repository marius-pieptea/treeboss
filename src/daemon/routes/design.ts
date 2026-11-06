/**
 * Design systems over HTTP: the library (in the trb home) and a project's DESIGN.md + design/tokens.css.
 * `:root` is a root reference (w_… or s_…), like the file API.
 *
 *   GET    /api/design/systems                        every system, in order, with swatches, plus `missingDefaults`
 *   POST   /api/design/systems                        create or replace a system by id
 *   PUT    /api/design/systems/:id                    replace one system (the id in the URL wins)
 *   DELETE /api/design/systems/:id                    any system, the shipped defaults included
 *   POST   /api/design/systems/:id/reset              put a system that came with trb back to its default
 *   POST   /api/design/systems/restore-defaults       add back the shipped defaults that are missing
 *   POST   /api/design/systems/reorder                { ids }  display order
 *
 *   GET    /api/design/:root                          the project's design: DESIGN.md, token swatches, agent rule
 *   POST   /api/design/:root/apply                    { system, overwrite?, rev? }  write a library system into the project
 *   POST   /api/design/:root/rule                     add the AGENTS.md rule that points agents at DESIGN.md
 *   POST   /api/design/:root/save-to-library          { name, description? }  copy the project's files into the library
 *   POST   /api/design/:root/start                    { kind: brief|url|codebase|wire|review, input?, brainstorm? (default true), engine?, model?, effort?, agent?, pairId?, isolate?, sessionId? }
 *
 * Design turns from the composer use the ordinary session routes: `POST /api/sessions` and
 * `POST /api/sessions/:id/send` may carry `design: { kind, brainstorm? }`. designFoldRoutes runs before every
 * other module, turns the operator's text into the design prompt (their words stay first, the instructions
 * follow a marker the thread folds away), makes the turn a build turn, and lets the core route handle it.
 */
import fs from "fs";
import { resolveRoot } from "../../workspaces";
import { getSession, viewSession } from "../../sessions/manager";
import { setMode } from "../../sessions/plan";
import { deleteSystem, listSystemViews, reorderSystems, resetSystem, restoreDefaults, saveSystem } from "../../design/library";
import { addDesignRule, applySystem, DesignConflict, readDesign, saveToLibrary } from "../../design/workspace";
import { designTurn, startDesign, type DesignKind } from "../../design/sessions";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DesignConflict) throw new HttpError(409, e.message);
    throw e;
  }
}

export const designFoldRoutes: RouteModule = async (c: Ctx) => {
  if (c.method !== "POST" || !c.body.design || typeof c.body.design !== "object") return null;
  const d = c.body.design as Record<string, unknown>;
  delete c.body.design;
  const kind = String(d.kind ?? "") as DesignKind;
  const o = { brainstorm: d.brainstorm !== false };
  if (c.path === "/api/sessions") {
    const cwd = String(c.body.cwd ?? "");
    if (!cwd || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(400, "A design turn needs the project folder as cwd.");
    const t = designTurn(cwd, kind, String(c.body.prompt ?? ""), o);
    c.body.prompt = t.prompt;
    if (!c.body.title) c.body.title = t.title;
    // Design work writes files: a plan or ask mode picked in the composer does not apply to it.
    c.body.mode = "build";
    delete c.body.plan_depth;
    return null;
  }
  const m = c.match(/^\/api\/sessions\/([^/]+)\/send$/);
  if (m) {
    const s = getSession(m[1]!);
    if (!s) throw new HttpError(404, `No session "${m[1]}".`);
    c.body.message = designTurn(s.cwd, kind, String(c.body.message ?? ""), o).prompt;
    setMode(s.id, "build");
  }
  return null;
};

export const designRoutes: RouteModule = async (c: Ctx) => {
  if (!c.path.startsWith("/api/design/")) return null;
  const all = () => listSystemViews();

  if (c.path === "/api/design/systems" || c.path.startsWith("/api/design/systems/")) {
    if (c.path === "/api/design/systems" && c.method === "GET") return json(all());
    if (c.path === "/api/design/systems" && c.method === "POST") return json({ system: saveSystem(c.body), ...all() }, 201);
    if (c.path === "/api/design/systems/restore-defaults" && c.method === "POST") return json({ added: restoreDefaults().map((r) => r.id), ...all() });
    if (c.path === "/api/design/systems/reorder" && c.method === "POST") {
      reorderSystems(Array.isArray(c.body.ids) ? c.body.ids.map(String) : []);
      return json(all());
    }
    let m: RegExpMatchArray | null;
    if ((m = c.match(/^\/api\/design\/systems\/([^/]+)\/reset$/)) && c.method === "POST") {
      resetSystem(decodeURIComponent(m[1]!));
      return json(all());
    }
    if ((m = c.match(/^\/api\/design\/systems\/([^/]+)$/)) && c.method === "PUT") {
      const id = decodeURIComponent(m[1]!);
      if (!all().systems.some((r) => r.id === id)) throw new HttpError(404, `No design system "${id}".`);
      return json({ system: saveSystem({ ...c.body, id }), ...all() });
    }
    if ((m = c.match(/^\/api\/design\/systems\/([^/]+)$/)) && c.method === "DELETE") {
      deleteSystem(decodeURIComponent(m[1]!));
      return json(all());
    }
    throw new HttpError(404, `No design route ${c.method} ${c.path}.`);
  }

  const m = c.match(/^\/api\/design\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2] ?? "";
  const b = c.body;

  if (rest === "" && c.method === "GET") return json({ design: readDesign(dir) });
  if (rest === "apply" && c.method === "POST") return json({ design: guard(() => applySystem(dir, String(b.system ?? ""), b.overwrite === true, str(b.rev))) });
  if (rest === "rule" && c.method === "POST") {
    addDesignRule(dir);
    return json({ design: readDesign(dir) });
  }
  if (rest === "save-to-library" && c.method === "POST") {
    const system = saveToLibrary(dir, { name: String(b.name ?? ""), description: str(b.description) });
    return json({ system, design: readDesign(dir), ...all() }, 201);
  }
  if (rest === "start" && c.method === "POST") {
    const session = startDesign(dir, String(b.kind ?? "") as DesignKind, {
      input: typeof b.input === "string" ? b.input : null,
      brainstorm: b.brainstorm !== false,
      engine: str(b.engine),
      model: str(b.model),
      effort: str(b.effort),
      agent: str(b.agent),
      pairId: str(b.pairId ?? b.pair_id),
      isolate: b.isolate === true,
      sessionId: str(b.sessionId ?? b.session_id),
    });
    return json({ session: viewSession(getSession(session.id)!, { withOutput: false }), design: readDesign(dir) }, 201);
  }
  throw new HttpError(404, `No design route ${c.method} ${c.path}.`);
};
