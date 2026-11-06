/**
 * Project memory over HTTP. `:root` is a root reference (w_… or s_…).
 *
 *   GET    /api/memory/:root                 { rules, files }
 *   POST   /api/memory/:root/rules           { text }  add (a rule that is already there is not added twice)
 *   PATCH  /api/memory/:root/rules/:id       { text }  edit
 *   DELETE /api/memory/:root/rules/:id
 *   POST   /api/memory/:root/suggest         { message }  { proposal: { text } | null }; never writes
 */
import { resolveRoot } from "../../workspaces";
import { detectCorrection } from "../../memory/detect";
import { ruleId } from "../../memory/block";
import { addRule, deleteRule, memoryView, readRules, updateRule } from "../../memory/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

export const memoryRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/memory\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = resolveRoot(m[1]!).dir;
  const rest = m[2] ?? "";

  if (rest === "" && c.method === "GET") return json({ memory: memoryView(dir) });
  if (rest === "rules" && c.method === "POST") {
    const r = addRule(dir, String(c.body.text ?? ""));
    return json({ rule: r.rule, added: r.added, memory: memoryView(dir) }, r.added ? 201 : 200);
  }
  let rm: RegExpMatchArray | null;
  if ((rm = rest.match(/^rules\/([^/]+)$/))) {
    const id = decodeURIComponent(rm[1]!);
    if (c.method === "PATCH") return json({ rule: updateRule(dir, id, String(c.body.text ?? "")), memory: memoryView(dir) });
    if (c.method === "DELETE") {
      deleteRule(dir, id);
      return json({ memory: memoryView(dir) });
    }
  }
  if (rest === "suggest" && c.method === "POST") {
    const p = detectCorrection(String(c.body.message ?? ""));
    if (!p) return json({ proposal: null });
    const have = new Set(readRules(dir).map((r) => r.id));
    return json({ proposal: have.has(ruleId(p.text)) ? null : p });
  }
  throw new HttpError(404, `No memory route ${c.method} ${c.path}.`);
};
