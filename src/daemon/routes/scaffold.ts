/**
 * "New app" scaffolding over HTTP.
 *
 *   GET    /api/scaffold/recipes             every recipe, in order, plus `missingDefaults` (see scaffold/recipes.ts)
 *   POST   /api/scaffold/recipes             create or replace a recipe by id (validated: argv lists, no shell)
 *   PUT    /api/scaffold/recipes/:id         replace one recipe (the id in the URL wins)
 *   DELETE /api/scaffold/recipes/:id         any recipe, the shipped defaults included
 *   POST   /api/scaffold/recipes/:id/reset   put a recipe that came with trb back to its default
 *   POST   /api/scaffold/recipes/restore-defaults   add back the shipped defaults that are missing
 *   POST   /api/scaffold/recipes/reorder     { ids }  display order
 *   POST   /api/scaffold/check               { target }  { ok, dir, exists, insideRepo } or a 400 saying why not
 *   POST   /api/scaffold/run                 { recipe, target, describe?, designSystem?, session?: { engine?, model?, effort?, pair?, isolate? } | true }  202 { job }
 *   POST   /api/scaffold/project            { kind: "empty"|"clone", target, gitInit?, url?, ref?, shallow? }  202 { job }; creates missing parent folders
 *   GET    /api/scaffold/jobs/:id            { job } with the log tail, workspaceId and sessionId when done
 */
import { checkTarget, getJob, startProject, startScaffold } from "../../scaffold/run";
import { deleteRecipe, listRecipeViews, reorderRecipes, resetRecipe, restoreDefaults, saveRecipe } from "../../scaffold/recipes";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const scaffoldRoutes: RouteModule = async (c: Ctx) => {
  if (!c.path.startsWith("/api/scaffold/")) return null;
  const all = () => listRecipeViews();
  if (c.path === "/api/scaffold/recipes" && c.method === "GET") return json(all());
  if (c.path === "/api/scaffold/recipes" && c.method === "POST") return json({ recipe: saveRecipe(c.body), ...all() }, 201);
  if (c.path === "/api/scaffold/recipes/restore-defaults" && c.method === "POST") return json({ added: restoreDefaults().map((r) => r.id), ...all() });
  if (c.path === "/api/scaffold/recipes/reorder" && c.method === "POST") {
    reorderRecipes(Array.isArray(c.body.ids) ? c.body.ids.map(String) : []);
    return json(all());
  }
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^\/api\/scaffold\/recipes\/([^/]+)\/reset$/)) && c.method === "POST") {
    resetRecipe(decodeURIComponent(m[1]!));
    return json(all());
  }
  if ((m = c.match(/^\/api\/scaffold\/recipes\/([^/]+)$/)) && c.method === "PUT") {
    const id = decodeURIComponent(m[1]!);
    if (!all().recipes.some((r) => r.id === id)) throw new HttpError(404, `No recipe "${id}".`);
    return json({ recipe: saveRecipe({ ...c.body, id }), ...all() });
  }
  if ((m = c.match(/^\/api\/scaffold\/recipes\/([^/]+)$/)) && c.method === "DELETE") {
    deleteRecipe(decodeURIComponent(m[1]!));
    return json(all());
  }
  if (c.path === "/api/scaffold/check" && c.method === "POST") return json({ ok: true, ...checkTarget(String(c.body.target ?? "")) });
  if (c.path === "/api/scaffold/run" && c.method === "POST") {
    const b = c.body;
    const s = b.session && typeof b.session === "object" ? b.session : b.session === true ? {} : null;
    const job = startScaffold({
      recipeId: String(b.recipe ?? ""),
      target: String(b.target ?? ""),
      describe: typeof b.describe === "string" ? b.describe : undefined,
      designSystem: str(b.designSystem ?? b.design_system),
      session: s ? { engine: str(s.engine) ?? undefined, model: str(s.model) ?? undefined, effort: str(s.effort) ?? undefined, pairId: str(s.pair) ?? undefined, isolate: s.isolate === true } : null,
    });
    return json({ job }, 202);
  }
  if (c.path === "/api/scaffold/project" && c.method === "POST") {
    const b = c.body;
    const job = startProject({ kind: b.kind === "clone" ? "clone" : "empty", target: String(b.target ?? ""), gitInit: b.gitInit !== false, url: str(b.url) ?? undefined, ref: str(b.ref) ?? undefined, shallow: b.shallow === true });
    return json({ job }, 202);
  }
  if ((m = c.match(/^\/api\/scaffold\/jobs\/([^/]+)$/)) && c.method === "GET") {
    const job = getJob(decodeURIComponent(m[1]!));
    if (!job) throw new HttpError(404, "No such scaffold job.");
    return json({ job });
  }
  throw new HttpError(404, `No scaffold route ${c.method} ${c.path}.`);
};
