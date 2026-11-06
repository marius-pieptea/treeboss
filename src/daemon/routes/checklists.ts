/**
 * Launch checklists over HTTP. `:id` is a workspace id (w_…).
 *
 *   GET    /api/checklists                                       the effective catalog (built-ins with their edits, then custom)
 *   GET    /api/checklists/catalog                               { checklists, checks, kinds, severities }: every checklist with builtin and modified flags
 *   POST   /api/checklists/catalog                               a new checklist (201); { forkOf } copies the fields it leaves out from that checklist
 *   GET    /api/checklists/catalog/:id                           one checklist
 *   PUT    /api/checklists/catalog/:id                           replace one: a built-in becomes an override, a custom one is replaced
 *   DELETE /api/checklists/catalog/:id                           remove a custom checklist (a built-in is reset, not deleted)
 *   POST   /api/checklists/catalog/:id/reset                     a built-in back to its shipped definition
 *   GET    /api/workspaces/:id/checklists                        attached checklists, with each item's state
 *   POST   /api/workspaces/:id/checklists                        { checklistId }   attach (201)
 *   DELETE /api/workspaces/:id/checklists/:checklistId           detach
 *   PATCH  /api/workspaces/:id/checklists/:checklistId/items/:itemId   { checked?, note?, disabled? }   disabled: for this project only; refused for a required item
 *   POST   /api/workspaces/:id/checklists/:checklistId/items     { text, category, severity, kind, hint, id? }   a project-only item (201)
 *   DELETE /api/workspaces/:id/checklists/:checklistId/items/:itemId   remove a project-only item
 *   POST   /api/workspaces/:id/checklists/run                    { url? }   run the automatic checks
 *   GET    /api/workspaces/:id/checklists/urls                   what the checks can run against: running dev servers, deploy targets
 *   POST   /api/workspaces/:id/checklists/:checklistId/fix       start an audit that fixes first, { sessionId } (201)
 *   POST   /api/workspaces/:id/checklists/audit                  { checklistId?, fix? }   start an audit session, { sessionId } (201)
 *   GET    /api/workspaces/:id/checklists/stack                  the detected stack of the folder, with the evidence
 */
import { CHECK_IDS } from "../../checklists/catalog";
import { catalogEntries, createChecklist, deleteChecklist, effectiveCatalog, resetChecklist, saveChecklist, MAX_ITEMS } from "../../checklists/custom";
import { addItemToProject, attach, detach, listAttached, removeItemFromProject, runAutoChecks, setItem, setItemDisabled, stackOf, startAuditSession, startFixSession, type ItemInput } from "../../checklists/store";
import { checkUrls } from "../../checklists/urls";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export const checklistsRoutes: RouteModule = async (c: Ctx) => {
  const { method } = c;
  const b = c.body;

  if (c.match(/^\/api\/checklists$/) && method === "GET") return json({ checklists: effectiveCatalog() });

  /* The catalog the operator edits (custom.ts). */
  if (c.path === "/api/checklists/catalog") {
    if (method === "GET") return json({ checklists: catalogEntries(), checks: CHECK_IDS, kinds: ["auto", "agent", "manual"], severities: ["required", "recommended"], maxItems: MAX_ITEMS });
    if (method === "POST") {
      const { forkOf, ...rest } = b;
      const from = typeof forkOf === "string" && forkOf.trim() ? forkOf.trim() : null;
      return json({ checklist: createChecklist(rest, from) }, 201);
    }
  }
  let m: RegExpMatchArray | null;
  if ((m = c.path.match(/^\/api\/checklists\/catalog\/([^/]+)(\/reset)?$/))) {
    const id = decodeURIComponent(m[1] ?? "");
    if (m[2] && method === "POST") return json({ checklist: resetChecklist(id) });
    if (!m[2] && method === "GET") {
      const one = catalogEntries().find((x) => x.id === id);
      if (!one) throw new HttpError(404, `No checklist "${id}".`);
      return json({ checklist: one });
    }
    if (!m[2] && method === "PUT") return json({ checklist: saveChecklist(id, b) });
    if (!m[2] && method === "DELETE") {
      deleteChecklist(id, Workspaces.list().map((w) => w.path));
      return json({ ok: true });
    }
  }

  const m2 = c.match(/^\/api\/workspaces\/(w_[^/]+)\/checklists(?:\/(.*))?$/);
  if (!m2) return null;
  const id = m2[1]!;
  const ws = Workspaces.get(id);
  if (!ws) throw new HttpError(404, `No workspace "${id}".`);
  const rest = m2[2] ?? "";
  const dec = (s: string) => decodeURIComponent(s);

  if (rest === "" && method === "GET") return json({ checklists: listAttached(id) });
  if (rest === "" && method === "POST") return json({ checklist: attach(id, String(b.checklistId ?? "")) }, 201);
  if (rest === "run" && method === "POST") {
    const url = typeof b.url === "string" && b.url.trim() ? b.url.trim() : null;
    return json(await runAutoChecks(id, { url }));
  }
  if (rest === "urls" && method === "GET") return json({ urls: checkUrls(id, ws.path) });
  if (rest === "stack" && method === "GET") return json(stackOf(id));
  if (rest === "audit" && method === "POST") {
    const checklistId = typeof b.checklistId === "string" && b.checklistId.trim() ? b.checklistId.trim() : null;
    if (b.fix !== undefined && typeof b.fix !== "boolean") throw new HttpError(400, "fix must be true or false.");
    return json({ sessionId: startAuditSession(id, checklistId, { fix: b.fix === true }) }, 201);
  }

  let r: RegExpMatchArray | null;
  if ((r = rest.match(/^([^/]+)\/items$/)) && method === "POST") return json({ item: addItemToProject(id, dec(r[1]!), b) }, 201);
  if ((r = rest.match(/^([^/]+)\/items\/([^/]+)$/)) && method === "PATCH") {
    const input: ItemInput = {};
    if ("checked" in b) {
      if (b.checked !== null && !isBool(b.checked)) throw new HttpError(400, "checked must be true, false or null.");
      input.checked = b.checked;
    }
    if ("note" in b) {
      if (b.note !== null && typeof b.note !== "string") throw new HttpError(400, "note must be text or null.");
      input.note = b.note;
    }
    if ("disabled" in b) {
      if (!isBool(b.disabled)) throw new HttpError(400, "disabled must be true or false.");
      if ("checked" in b || "note" in b) setItem(id, dec(r[1]!), dec(r[2]!), input);
      return json({ item: setItemDisabled(id, dec(r[1]!), dec(r[2]!), b.disabled) });
    }
    return json({ item: setItem(id, dec(r[1]!), dec(r[2]!), input) });
  }
  if ((r = rest.match(/^([^/]+)\/items\/([^/]+)$/)) && method === "DELETE") {
    removeItemFromProject(id, dec(r[1]!), dec(r[2]!));
    return json({ ok: true });
  }
  if ((r = rest.match(/^([^/]+)\/fix$/)) && method === "POST") return json({ sessionId: startFixSession(id, dec(r[1]!)) }, 201);
  if ((r = rest.match(/^([^/]+)$/)) && method === "DELETE") {
    if (!detach(id, dec(r[1]!))) throw new HttpError(404, `${dec(r[1]!)} is not attached to this workspace.`);
    return json({ ok: true });
  }
  throw new HttpError(404, `No checklist route ${method} ${c.path}.`);
};
