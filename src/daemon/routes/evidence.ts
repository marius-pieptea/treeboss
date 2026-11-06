/**
 * The Evidence module over HTTP. `:root` is a root reference (w_… or s_…); evidence belongs to the project, so a
 * session root means its session's base directory. Captured text is only ever served as text/plain with
 * `sandbox` and `nosniff`: a captured page's own scripts must never run in the daemon's origin.
 *
 *   GET    /api/evidence/:root?q=&kind=&investigation=&finding=&status=   { enabled, browser, rea, items, investigations }
 *   GET    /api/evidence/:root/:id                  the item, its cited items and the notes that cite it
 *   GET    /api/evidence/:root/:id/file/:part       one stored part (screenshot.jpg or .png, styles.json, page.html, rea.json, …)
 *   POST   /api/evidence/:root/capture              { sessionId, label?, investigation_id? }  capture the page open in that session's browser
 *   POST   /api/evidence/:root/note                 { title, text, refs?, finding?, investigation_id? }
 *   POST   /api/evidence/:root/build                { ids }  →  { prompt, ids }  the brief to build these findings
 *   PATCH  /api/evidence/:root/:id                  { finding_status }  (findings only)
 *   POST   /api/evidence/:root/:id/export           { path? }  write it as a page in the project's docs folder
 *   DELETE /api/evidence/:root/:id
 *   GET    /api/evidence/:root/investigations       { investigations }
 *   POST   /api/evidence/:root/investigations       { title, target?, target_kind?, run?, …run opts }  → 201 { investigation, detected }
 *                                                   target_kind "auto" (or none) works the kind out from the target: detected { kind, reason };
 *                                                   an explicit kind wins and detected is null. with run: true also starts a run → 201 { investigation, session, runError? , detected }
 *   GET    /api/evidence/:root/investigations/:id   { investigation, items }
 *   PATCH  /api/evidence/:root/investigations/:id   { status?, summary?, title? }  → { investigation }
 *   DELETE /api/evidence/:root/investigations/:id?withEvidence=1   { removed }
 *   POST   /api/evidence/:root/investigations/:id/run   { engine?, model?, effort?, agent?, pairId?, note? }  → 201 { investigation, session }
 */
import fs from "fs";
import { SessionError, getSession, viewSession } from "../../sessions/manager";
import { owningWorkspace, resolveRoot } from "../../workspaces";
import { getSetting } from "../../settings";
import { createPage, docsDirOf } from "../../docs/store";
import { slug, UserError } from "../../util";
import { act, ctxConsole, getContext } from "../../browser/manager";
import { browserEnabled } from "../../browser/chrome";
import { capturePage } from "../../evidence/capture";
import { reaEnabled, reaLaunch, REA_VERSION } from "../../evidence/rea";
import { buildPrompt, closeInvestigation, getInvestigation, listInvestigations, openInvestigationFor, reopenInvestigation, removeInvestigation, setFindingStatus, startInvestigation, updateInvestigation } from "../../evidence/investigations";
import { startInvestigationRun, type RunOpts } from "../../evidence/runs";
import { MAX_NOTE_CHARS, addEvidence, evidenceDir, evidenceEnabled, evidenceMarkdown, getEvidence, isFindingKind, isFindingStatus, listEvidence, removeEvidence, workspaceKey } from "../../evidence/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";
import path from "path";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const runOptsOf = (b: Record<string, any>): RunOpts => ({ engine: str(b.engine), model: str(b.model), effort: str(b.effort), agent: str(b.agent), pairId: str(b.pairId ?? b.pair_id), note: str(b.note) });

/** The session view a run returns, as Lab's run does. */
const view = (id: string) => viewSession(getSession(id)!, { withOutput: false });

/** The project directory a root reference stands for: a session's own project, not its worktree. */
function projectOf(ref: string): string {
  const root = resolveRoot(ref);
  if (root.kind === "session") {
    const s = getSession(ref);
    if (s && fs.existsSync(s.base_cwd)) return workspaceKey(s.base_cwd);
  }
  return workspaceKey(root.dir);
}

export const evidenceRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/evidence\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const dir = projectOf(m[1]!);
  const rest = m[2] ?? "";

  if (rest === "" && c.method === "GET") {
    const kind = c.q("kind");
    const finding = c.q("finding");
    const status = c.q("status");
    const launch = reaLaunch();
    return json({
      enabled: evidenceEnabled(),
      browser: browserEnabled(),
      rea: { enabled: getSetting("rea_mcp") === "on", available: reaEnabled(), version: REA_VERSION, source: launch?.source ?? null },
      items: listEvidence(dir, {
        query: c.q("q"),
        kind: kind === "page" || kind === "note" ? kind : null,
        investigationId: c.q("investigation") || null,
        finding: finding === "any" || isFindingKind(finding) ? finding : null,
        findingStatus: isFindingStatus(status) ? status : null,
        limit: 200,
      }),
      investigations: listInvestigations(dir),
    });
  }

  if (rest === "capture" && c.method === "POST") {
    if (!evidenceEnabled()) throw new HttpError(400, "Evidence is turned off (trb config set evidence on).");
    if (!browserEnabled()) throw new HttpError(400, "The agent browser is not available.");
    const sessionId = str(c.body.sessionId);
    const s = sessionId ? getSession(sessionId) : null;
    if (!s) throw new HttpError(400, "sessionId names no session.");
    if (workspaceKey(s.base_cwd) !== dir) throw new HttpError(400, "That session belongs to another project.");
    const investigationId = str(c.body.investigation_id) ?? openInvestigationFor(s.id, dir)?.id ?? null;
    const ctx = await getContext(s.id);
    const cap = await act(ctx, { label: "Capturing evidence", actor: "you", sessionId: s.id }, (page) => capturePage(page, { console: ctxConsole(ctx, { level: "all" }) })).catch((e) => {
      throw new HttpError(400, String(e?.message ?? e).split("\n")[0]!);
    });
    return json({ item: addEvidence({ workspace: dir, sessionId: s.id, kind: "page", title: str(c.body.label) ?? cap.title, url: cap.url, summary: cap.summary, files: cap.files, investigationId, source: "browser" }) }, 201);
  }

  if (rest === "note" && c.method === "POST") {
    const title = str(c.body.title);
    const text = typeof c.body.text === "string" ? c.body.text.trim() : "";
    if (!title || !text) throw new HttpError(400, "title and text are required.");
    if (text.length > MAX_NOTE_CHARS) throw new HttpError(400, `The note is too long (limit ${MAX_NOTE_CHARS} characters).`);
    const finding = c.body.finding ?? null;
    if (finding !== null && !isFindingKind(finding)) throw new HttpError(400, 'finding must be "feature" or "ui".');
    const refs = Array.isArray(c.body.refs) ? c.body.refs.map(String) : [];
    return json({ item: addEvidence({ workspace: dir, kind: "note", title, summary: text.split("\n").find((l) => l.trim()) ?? "", refs, finding, investigationId: str(c.body.investigation_id), source: "operator", files: { "note.md": `${text}\n` } }) }, 201);
  }

  if (rest === "build" && c.method === "POST") {
    if (!Array.isArray(c.body.ids)) throw new HttpError(400, "ids must be a list of finding ids.");
    const ids = c.body.ids.map(String);
    return json({ prompt: buildPrompt(dir, ids), ids });
  }

  if (rest === "investigations") {
    if (c.method === "GET") return json({ investigations: listInvestigations(dir) });
    if (c.method === "POST") {
      const title = str(c.body.title);
      if (!title) throw new HttpError(400, "title is required.");
      const requested = str(c.body.target_kind);
      const created = startInvestigation({ workspace: dir, title, target: str(c.body.target), targetKind: requested });
      // What the kind was worked out to, when the operator left it to detection ("auto" or none).
      const detected = requested === null || requested === "auto" ? { kind: created.target_kind, reason: created.kind_reason } : null;
      if (c.body.run !== true) return json({ investigation: created, detected }, 201);
      // The investigation stays when its run cannot start: the operator sees why, and can run it again.
      try {
        const session = startInvestigationRun(dir, created.id, runOptsOf(c.body));
        return json({ investigation: getInvestigation(created.id, dir), session: view(session.id), detected }, 201);
      } catch (err) {
        if (!(err instanceof UserError || err instanceof SessionError)) throw err;
        return json({ investigation: getInvestigation(created.id, dir), session: null, runError: err.message, detected }, 201);
      }
    }
  }

  const rn = rest.match(/^investigations\/([^/]+)\/run$/);
  if (rn && c.method === "POST") {
    const id = decodeURIComponent(rn[1]!);
    if (!getInvestigation(id, dir)) throw new HttpError(404, `No investigation "${id}" in this project.`);
    const session = startInvestigationRun(dir, id, runOptsOf(c.body));
    return json({ investigation: getInvestigation(id, dir), session: view(session.id) }, 201);
  }

  const im = rest.match(/^investigations\/([^/]+)$/);
  if (im) {
    const id = decodeURIComponent(im[1]!);
    const investigation = getInvestigation(id, dir);
    if (!investigation) throw new HttpError(404, `No investigation "${id}" in this project.`);
    if (c.method === "GET") return json({ investigation, items: listEvidence(dir, { investigationId: id, limit: 200 }) });
    if (c.method === "PATCH") {
      const status = c.body.status;
      if (status !== undefined && status !== "open" && status !== "closed") throw new HttpError(400, 'status must be "open" or "closed".');
      if (c.body.title !== undefined && !str(c.body.title)) throw new HttpError(400, "title cannot be empty.");
      const title = c.body.title !== undefined ? str(c.body.title)! : undefined;
      const summary = typeof c.body.summary === "string" ? c.body.summary : undefined;
      if (title !== undefined || summary !== undefined) updateInvestigation(id, dir, { title, summary });
      if (status === "closed") closeInvestigation(id, dir, summary ?? investigation.summary);
      if (status === "open") reopenInvestigation(id, dir);
      return json({ investigation: getInvestigation(id, dir) });
    }
    if (c.method === "DELETE") {
      const withEvidence = c.q("withEvidence");
      return json({ removed: removeInvestigation(id, dir, { withEvidence: withEvidence === "1" || withEvidence === "true" }) });
    }
  }

  const fm = rest.match(/^([^/]+)\/file\/([^/]+)$/);
  if (fm && c.method === "GET") {
    const item = getEvidence(decodeURIComponent(fm[1]!), dir);
    const part = decodeURIComponent(fm[2]!);
    if (!item || !(part in item.files)) throw new HttpError(404, "No such evidence part.");
    const file = path.join(evidenceDir(item.id), part);
    const image = part.endsWith(".jpg") ? "image/jpeg" : part.endsWith(".png") ? "image/png" : null;
    return new Response(Bun.file(file), { headers: { "content-type": image ?? "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "no-store" } });
  }

  const em = rest.match(/^([^/]+)(?:\/(export))?$/);
  if (em) {
    const id = decodeURIComponent(em[1]!);
    const item = getEvidence(id, dir);
    if (!item) throw new HttpError(404, `No evidence "${id}" in this project.`);
    if (!em[2] && c.method === "GET") {
      const cites = item.refs.map((r) => getEvidence(r, dir)).filter(Boolean);
      const citedBy = listEvidence(dir, { kind: "note", limit: 200 }).filter((n) => n.refs.includes(item.id));
      return json({ item, cites, citedBy });
    }
    if (!em[2] && c.method === "PATCH") return json({ item: setFindingStatus(id, dir, c.body.finding_status) });
    if (!em[2] && c.method === "DELETE") return json({ removed: removeEvidence(id, dir) });
    if (em[2] && c.method === "POST") {
      const { dir: docsDir } = docsDirOf(owningWorkspace(dir));
      const rel = str(c.body.path) ?? `evidence/${slug(item.title, 48)}-${item.id}.md`;
      const page = createPage(dir, docsDir, { path: rel, title: item.title, content: evidenceMarkdown(item, dir) });
      return json({ page }, 201);
    }
  }
  throw new HttpError(404, `No evidence route ${c.method} ${c.path}.`);
};
