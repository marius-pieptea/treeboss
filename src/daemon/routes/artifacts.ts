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
 *   GET    /api/artifacts/:id/files    { files: [{ path, size }], base }
 *   GET    /api/artifacts/:id/file     one file from files dir (?path=rel)
 *   GET    /api/artifacts/:id/f/:token/<rest>  capability-URL file serving for sandboxed previews
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
  getArtifactViewToken,
  listArtifactFiles,
  listArtifacts,
  markRemoved,
  purgeRemoved,
  restore,
} from "../../artifacts/store";
import { HttpError, json, makeCtx, safeEqual, type Ctx, type RouteModule } from "../http";

const UNDO_KEEP_MS = 35_000;
const CLAUDE_CHAT_RE = /(?:https:\/\/|(?<![A-Za-z0-9.:/-]))claude\.ai\/chat(?:\/|$|\?|#)/i;
const ARTIFACT_VIEW_PATH_RE = /^\/api\/artifacts\/[A-Za-z0-9-]+\/f\/[0-9a-f]{32}\//;
const ARTIFACT_VIEW_TOKEN_REDACT_RE = /^(\/api\/artifacts\/[^/]+\/f\/)[0-9a-f]{32}(\/)/;
const BLOB_NO_EXT_RE = /^_blob\/([0-9a-f]{32})$/;
const ASSET_ID_RE = /^[0-9a-f]{32}$/;

/** The capability-URL path shape admitted without owner auth in server.ts. */
export const isArtifactViewPath = (pathname: string): boolean => ARTIFACT_VIEW_PATH_RE.test(pathname);

/** Redact the 32-hex capability view token in artifact file URLs before logging. */
export const redactArtifactToken = (pathname: string): string =>
  pathname.replace(ARTIFACT_VIEW_TOKEN_REDACT_RE, "$1<token>$2");

const CAPABILITY_SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-ancestors 'self'",
  "cache-control": "no-store",
} as const;

const VIEW_HTML_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

const FONT_MIME_BY_EXT: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const TEXT_PLAIN_EXTS = new Set([".json", ".css", ".js", ".txt", ".md"]);
const SANDBOX_NONE_CSP = "sandbox; default-src 'none'";

function resolveArtifactFile(filesDir: string, rel: string | null): string {
  const cleanRel = (rel ?? "").replace(/\\/g, "/");
  if (
    !cleanRel ||
    cleanRel.startsWith("/") ||
    cleanRel.includes("\0") ||
    /^[A-Za-z]:/.test(cleanRel) ||
    cleanRel.split("/").some((seg) => seg === "." || seg === "..")
  ) {
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

function resolveBlobAssetFile(filesDir: string, assetId: string): string | null {
  if (!ASSET_ID_RE.test(assetId)) return null;
  const baseDir = path.resolve(filesDir);
  const blobDir = path.join(baseDir, "_blob");
  if (!fs.existsSync(blobDir)) return null;
  let realBase: string;
  let realBlob: string;
  try {
    realBase = fs.realpathSync(baseDir);
    realBlob = fs.realpathSync(blobDir);
  } catch {
    return null;
  }
  if (path.relative(realBase, realBlob) !== "_blob" || !fs.statSync(realBlob).isDirectory()) {
    return null;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realBlob, { withFileTypes: true });
  } catch {
    return null;
  }
  const match = entries.find(
    (ent) => !ent.isSymbolicLink() && ent.isFile() && (ent.name === assetId || ent.name.startsWith(`${assetId}.`)),
  );
  if (!match) return null;
  const candidate = path.join(realBlob, match.name);
  const realTarget = fs.realpathSync(candidate);
  const realRel = path.relative(realBlob, realTarget);
  if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  if (!fs.statSync(realTarget).isFile()) return null;
  return realTarget;
}

function rewriteBlobUrls(html: string, id: string, token: string): string {
  const blobBase = `/api/artifacts/${encodeURIComponent(id)}/f/${token}/_blob/`;
  return html
    .replaceAll('"/_blob/', `"${blobBase}`)
    .replaceAll("'/_blob/", `'${blobBase}`)
    .replace(/url\(\s*\/_blob\//g, `url(${blobBase}`);
}

function capabilityNotFound(method: string, message = "File not found."): Response {
  return new Response(method === "HEAD" ? null : JSON.stringify({ error: message }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      ...CAPABILITY_SECURITY_HEADERS,
    },
  });
}

function serveCapabilityView(c: Ctx, rawId: string, token: string, rawRest: string): Response {
  let id: string;
  try {
    id = decodeId(rawId);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return capabilityNotFound(c.method, err.message);
    throw err;
  }

  const item = getArtifact(id);
  const expected = getArtifactViewToken(id);
  if (
    !item ||
    item.contentKind !== "files" ||
    !item.contentPath ||
    !expected ||
    !safeEqual(token, expected) ||
    !fs.existsSync(item.contentPath)
  ) {
    return capabilityNotFound(c.method);
  }

  let rel: string;
  try {
    rel = decodeURIComponent(rawRest);
  } catch {
    return capabilityNotFound(c.method);
  }

  let target: string | null = null;
  const cleanRel = rel.replace(/\\/g, "/");
  const blobMatch = BLOB_NO_EXT_RE.exec(cleanRel);
  if (blobMatch) {
    target = resolveBlobAssetFile(item.contentPath, blobMatch[1]!);
  }
  if (!target) {
    try {
      target = resolveArtifactFile(item.contentPath, rel);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return capabilityNotFound(c.method, err.message);
      throw err;
    }
  }

  const ext = path.extname(target).toLowerCase();
  const headers: Record<string, string> = {
    "access-control-allow-origin": "*",
    ...CAPABILITY_SECURITY_HEADERS,
    "cache-control": "no-store",
  };

  if (ext === ".html" || ext === ".htm") {
    headers["content-type"] = "text/html; charset=utf-8";
    headers["content-security-policy"] = VIEW_HTML_CSP;
    const rewritten = rewriteBlobUrls(fs.readFileSync(target, "utf-8"), id, token);
    return new Response(c.method === "HEAD" ? null : rewritten, { headers });
  }

  if (ext === ".js" || ext === ".mjs") {
    headers["content-type"] = "text/javascript; charset=utf-8";
  } else if (ext === ".svg") {
    headers["content-type"] = "image/svg+xml";
    headers["content-security-policy"] = "sandbox";
  } else if (IMAGE_MIME_BY_EXT[ext]) {
    headers["content-type"] = IMAGE_MIME_BY_EXT[ext]!;
  } else if (FONT_MIME_BY_EXT[ext]) {
    headers["content-type"] = FONT_MIME_BY_EXT[ext]!;
  } else {
    headers["content-type"] = "application/octet-stream";
    headers["content-disposition"] = "attachment";
    headers["content-security-policy"] = SANDBOX_NONE_CSP;
  }

  return new Response(c.method === "HEAD" ? null : Bun.file(target), { headers });
}

/** Direct handler for capability-URL artifact file requests (called before owner auth in server.ts). */
export async function serveArtifactView(req: Request, url: URL): Promise<Response> {
  const m = /^\/api\/artifacts\/([^/]+)\/f\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!m) return capabilityNotFound(req.method);
  return serveCapabilityView(makeCtx(req, url, {}), m[1]!, m[2]!, m[3]!);
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
    const files = listArtifactFiles(item.contentPath).filter(
      (f) => !f.path.startsWith("_blob/") && f.path !== "project/support.js",
    );
    const token = getArtifactViewToken(id);
    const base = token ? `/api/artifacts/${encodeURIComponent(id)}/f/${token}/` : null;
    return json({ files, base });
  }

  if ((m = c.match(/^\/api\/artifacts\/([^/]+)\/f\/([^/]+)\/(.*)$/)) && (c.method === "GET" || c.method === "HEAD")) {
    return serveCapabilityView(c, m[1]!, m[2]!, m[3]!);
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
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    if (ext === ".svg") {
      headers["content-type"] = "image/svg+xml";
      headers["content-security-policy"] = "sandbox";
    } else if (IMAGE_MIME_BY_EXT[ext]) {
      headers["content-type"] = IMAGE_MIME_BY_EXT[ext]!;
    } else if (TEXT_PLAIN_EXTS.has(ext)) {
      headers["content-type"] = "text/plain; charset=utf-8";
      headers["content-security-policy"] = SANDBOX_NONE_CSP;
    } else {
      headers["content-type"] = "application/octet-stream";
      headers["content-disposition"] = "attachment";
      headers["content-security-policy"] = SANDBOX_NONE_CSP;
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
