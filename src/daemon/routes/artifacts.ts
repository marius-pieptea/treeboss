/**
 * The Artifacts module over HTTP.
 *
 *   GET    /api/artifacts              { items, account }
 *   POST   /api/artifacts              { url } -> { item }
 *   POST   /api/artifacts/refresh      { account, updated }
 *   DELETE /api/artifacts/:id          { ok: true }
 *   POST   /api/artifacts/:id/restore  { item }
 *   POST   /api/artifacts/:id/refresh  { item }  (409 if already reading)
 *   GET    /api/artifacts/:id/html     text/html body of htmlPath
 */
import fs from "fs";
import { artifactIdFromUrl } from "../../artifacts/capture";
import {
  AlreadyReadingError,
  getAccount,
  isReading,
  listAccount,
  readArtifact,
} from "../../artifacts/reader";
import {
  addPasted,
  getArtifact,
  listArtifacts,
  markRemoved,
  purgeRemoved,
  restore,
} from "../../artifacts/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const UNDO_KEEP_MS = 35_000;
const CLAUDE_CHAT_RE = /(?:https:\/\/|(?<![A-Za-z0-9.:/-]))claude\.ai\/chat(?:\/|$|\?|#)/i;

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(404, "Artifact not found.");
  }
}

export const artifactRoutes: RouteModule = async (c: Ctx) => {
  if (c.path === "/api/artifacts" && c.method === "GET") {
    purgeRemoved(UNDO_KEEP_MS);
    return json({ items: listArtifacts(), account: getAccount() });
  }

  if (c.path === "/api/artifacts" && c.method === "POST") {
    purgeRemoved(UNDO_KEEP_MS);
    const raw = typeof c.body.url === "string" ? c.body.url.trim() : "";
    const id = artifactIdFromUrl(raw);
    if (!id) {
      if (CLAUDE_CHAT_RE.test(raw)) {
        throw new HttpError(400, "That is a chat link. Paste a link that starts with claude.ai/artifact/.");
      }
      throw new HttpError(400, "Paste a link that starts with claude.ai/artifact/.");
    }

    const existing = getArtifact(id);
    const item = addPasted(raw);
    if (!existing && item.lastReadAt === null && !isReading(item.id)) {
      void readArtifact(item.id).catch(() => {});
    }
    return json({ item });
  }

  if (c.path === "/api/artifacts/refresh" && c.method === "POST") {
    return json(await listAccount());
  }

  let m: RegExpMatchArray | null;
  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/restore$/)) && c.method === "POST") {
    purgeRemoved(UNDO_KEEP_MS);
    const id = decodeId(m[1]!);
    const item = restore(id);
    if (!item) throw new HttpError(404, `No artifact "${id}".`);
    return json({ item });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/refresh$/)) && c.method === "POST") {
    const id = decodeId(m[1]!);
    if (!getArtifact(id)) throw new HttpError(404, `No artifact "${id}".`);
    if (isReading(id)) return json({ error: "Already reading." }, 409);
    try {
      const item = await readArtifact(id);
      if (!item) throw new HttpError(404, `No artifact "${id}".`);
      return json({ item });
    } catch (err) {
      if (err instanceof AlreadyReadingError) return json({ error: "Already reading." }, 409);
      throw err;
    }
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/html$/)) && c.method === "GET") {
    const id = decodeId(m[1]!);
    const item = getArtifact(id);
    if (!item || !item.htmlPath || !fs.existsSync(item.htmlPath)) {
      throw new HttpError(404, "No HTML copy for this artifact.");
    }
    return new Response(Bun.file(item.htmlPath), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "no-store",
      },
    });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)$/)) && c.method === "DELETE") {
    const id = decodeId(m[1]!);
    if (!markRemoved(id)) throw new HttpError(404, `No artifact "${id}".`);
    purgeRemoved(UNDO_KEEP_MS);
    return json({ ok: true });
  }

  return null;
};
