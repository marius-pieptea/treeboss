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
 *   GET    /api/artifacts/:id/content  text/markdown body of content.md
 *   GET    /api/artifacts/:id/files    { files: [{ path, size }] }
 *   GET    /api/artifacts/:id/file     one file from files dir (?path=rel)
 */
import fs from "fs";
import path from "path";
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
  listArtifactFiles,
  listArtifacts,
  markRemoved,
  purgeRemoved,
  restore,
} from "../../artifacts/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const UNDO_KEEP_MS = 35_000;
const CLAUDE_CHAT_RE = /(?:https:\/\/|(?<![A-Za-z0-9.:/-]))claude\.ai\/chat(?:\/|$|\?|#)/i;

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-ancestors 'self'",
  "cache-control": "no-store",
} as const;

const MIME_BY_EXT: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};

function resolveArtifactFile(filesDir: string, rel: string | null): string {
  const cleanRel = (rel ?? "").replace(/\\/g, "/");
  if (!cleanRel || cleanRel.startsWith("/") || cleanRel.includes("\0") || /^[A-Za-z]:/.test(cleanRel)) {
    throw new HttpError(404, "File not found.");
  }
  const baseDir = path.resolve(filesDir);
  const resolved = path.resolve(baseDir, cleanRel);
  const relFromBase = path.relative(baseDir, resolved);
  if (!relFromBase || relFromBase.startsWith("..") || path.isAbsolute(relFromBase)) {
    throw new HttpError(404, "File not found.");
  }
  if (!fs.existsSync(resolved)) {
    throw new HttpError(404, "File not found.");
  }
  const realBase = fs.realpathSync(baseDir);
  const realTarget = fs.realpathSync(resolved);
  const realRel = path.relative(realBase, realTarget);
  if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new HttpError(404, "File not found.");
  }
  if (!fs.statSync(realTarget).isFile()) {
    throw new HttpError(404, "File not found.");
  }
  return realTarget;
}

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
    return json(await listAccount({ force: true }));
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
    return new Response(Bun.file(item.htmlPath), { headers: HTML_HEADERS });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/content$/)) && c.method === "GET") {
    const id = decodeId(m[1]!);
    const item = getArtifact(id);
    if (
      !item ||
      item.contentKind !== "markdown" ||
      !item.contentPath ||
      !fs.existsSync(item.contentPath) ||
      !fs.statSync(item.contentPath).isFile()
    ) {
      throw new HttpError(404, "No markdown content for this artifact.");
    }
    return new Response(Bun.file(item.contentPath), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/files$/)) && c.method === "GET") {
    const id = decodeId(m[1]!);
    const item = getArtifact(id);
    if (
      !item ||
      item.contentKind !== "files" ||
      !item.contentPath ||
      !fs.existsSync(item.contentPath) ||
      !fs.statSync(item.contentPath).isDirectory()
    ) {
      throw new HttpError(404, "No files for this artifact.");
    }
    return json({ files: listArtifactFiles(item.contentPath) });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/file$/)) && c.method === "GET") {
    const id = decodeId(m[1]!);
    const item = getArtifact(id);
    if (
      !item ||
      item.contentKind !== "files" ||
      !item.contentPath ||
      !fs.existsSync(item.contentPath)
    ) {
      throw new HttpError(404, "No files for this artifact.");
    }
    const target = resolveArtifactFile(item.contentPath, c.q("path"));
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      return new Response(Bun.file(target), { headers: HTML_HEADERS });
    }
    const headers: Record<string, string> = {
      "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    if (ext === ".svg") {
      headers["content-security-policy"] = "sandbox";
    }
    return new Response(Bun.file(target), { headers });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)$/)) && c.method === "DELETE") {
    const id = decodeId(m[1]!);
    if (!markRemoved(id)) throw new HttpError(404, `No artifact "${id}".`);
    purgeRemoved(UNDO_KEEP_MS);
    return json({ ok: true });
  }

  return null;
};
