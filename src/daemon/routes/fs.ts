/** File API: /api/fs/:root/… */
import fs from "fs";
import path from "path";
import { resolveRoot, safeJoin } from "../../workspaces";
import { ConflictError, createEntry, deleteEntry, grep, listAllFiles, listDir, readFileSafe, renameEntry, writeFileSafe } from "../../fs/files";
import { HttpError, json, type RouteModule } from "../http";

/** Types worth rendering inline in the editor's image/PDF viewer. Anything else downloads. */
const SAFE_INLINE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export const fsRoutes: RouteModule = async (c) => {
  const m = c.match(/^\/api\/fs\/([^/]+)\/([a-z]+)$/);
  if (!m) return null;
  const root = resolveRoot(m[1]);
  const op = m[2];
  const rel = c.q("path") ?? String(c.body.path ?? "");

  if (op === "tree" && c.method === "GET") return json({ entries: await listDir(root.dir, rel) });

  if (op === "file") {
    if (c.method === "GET") return json(readFileSafe(root.dir, rel));
    if (c.method === "PUT") {
      try {
        return json(writeFileSafe(root.dir, rel, String(c.body.content ?? ""), { expectedMtime: c.body.expectedMtime ?? null, create: c.body.create === true }));
      } catch (err) {
        if (err instanceof ConflictError) return json({ error: err.message, conflict: true, mtime: err.mtime }, 409);
        throw err;
      }
    }
    if (c.method === "DELETE") {
      deleteEntry(root.dir, rel);
      return json({ ok: true });
    }
  }

  if (op === "create" && c.method === "POST") {
    createEntry(root.dir, rel, c.body.type === "dir" ? "dir" : "file");
    return json({ ok: true }, 201);
  }
  if (op === "rename" && c.method === "POST") {
    renameEntry(root.dir, String(c.body.from ?? ""), String(c.body.to ?? ""));
    return json({ ok: true });
  }
  if (op === "find" && c.method === "GET") return json(await listAllFiles(root.dir));
  if (op === "grep" && c.method === "GET") {
    return json(await grep(root.dir, { query: c.q("q") ?? "", regex: c.q("regex") === "1", caseSensitive: c.q("case") === "1", wholeWord: c.q("word") === "1", include: c.q("include") ?? "" }));
  }

  if (op === "raw" && c.method === "GET") {
    const abs = safeJoin(root.dir, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new HttpError(404, `No such file: ${rel}`);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const type = SAFE_INLINE[ext];
    // Workspace files are untrusted content served from the daemon's own origin. Anything that is not a
    // known passive type is forced to download, and everything gets a sandbox CSP so even an SVG or PDF
    // cannot run script with this origin's cookies.
    return new Response(Bun.file(abs), {
      headers: {
        "content-type": type ?? "application/octet-stream",
        "content-disposition": type ? "inline" : `attachment; filename="${path.basename(abs).replace(/"/g, "")}"`,
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      },
    });
  }
  return null;
};
