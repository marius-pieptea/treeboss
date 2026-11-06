/**
 * Ask mode's two follow-ups, both only on a click:
 *   GET  /api/sessions/:id/ask/doc?turn=   what "Save as doc" would write (path, title, covers, content)
 *   POST /api/sessions/:id/ask/doc         { path?, title?, turn? }  write that page into the docs folder
 * ("Turn into a plan" needs no route: it flips the mode and sends a message, like any follow-up.)
 *   GET  /api/ask/model?engine=            the model and effort a NEW ask session on that engine starts with
 */
import { getSetting } from "../../settings";
import { askStartModel } from "../../sessions/ask";
import { getSession } from "../../sessions/manager";
import { previewAskDoc, saveAskDoc } from "../../sessions/askdoc";
import { HttpError, json, type RouteModule } from "../http";

export const askRoutes: RouteModule = async (c) => {
  if (c.path === "/api/ask/model" && c.method === "GET") return json(await askStartModel(c.q("engine") || String(getSetting("default_engine"))));
  const m = c.match(/^\/api\/sessions\/([^/]+)\/ask\/doc$/);
  if (!m) return null;
  if (!getSession(m[1])) throw new HttpError(404, `No session "${m[1]}".`);
  if (c.method === "GET") return json({ preview: await previewAskDoc(m[1], c.q("turn")) });
  if (c.method === "POST") {
    const saved = await saveAskDoc(m[1], { turnId: c.body.turn ?? null, path: c.body.path, title: c.body.title });
    return json({ page: saved }, 201);
  }
  return null;
};
