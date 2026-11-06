/**
 * Prompt context palette API: candidates for `@`, chip resolution, pasted images.
 *
 * Folding: a request that starts or continues a session may carry `context: [{kind, value}]`. This module
 * runs before the core session routes, resolves the chips, rewrites `prompt` / `message` in the request body
 * and returns null so the core route handles the (now enriched) request as usual. The core routes need no
 * knowledge of chips, and every engine receives the same text.
 */
import fs from "fs";
import { getSession } from "../../sessions/manager";
import { Workspaces, resolveRoot } from "../../workspaces";
import { FileError, saveUpload, storedFile } from "../../context/files";
import { ImageError, imageFile, saveImage } from "../../context/images";
import { parseChips, resolveChips, withContext } from "../../context/resolve";
import { searchAll, searchCommits, searchFiles, searchSymbols } from "../../context/search";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const selfPort = (c: Ctx): number | null => Number(c.url.port) || null;

async function fold(c: Ctx, root: string, dir: string | undefined, field: "prompt" | "message"): Promise<void> {
  const chips = parseChips(c.body.context);
  delete c.body.context;
  if (!chips.length) return;
  const r = await resolveChips(chips, { root, dir, previewUrl: typeof c.body.preview_url === "string" ? c.body.preview_url : null, selfPort: selfPort(c) });
  // A new session is titled from its prompt's first line: keep that the operator's sentence, not "# Attached context".
  if (field === "prompt" && !c.body.title) c.body.title = String(c.body.prompt ?? "").trim().split("\n")[0]!.slice(0, 100) || undefined;
  c.body[field] = withContext(String(c.body[field] ?? ""), r.block);
}

export const contextRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;

  if (c.path === "/api/context/search" && c.method === "GET") {
    const root = resolveRoot(c.q("root") ?? "");
    const q = (c.q("q") ?? "").trim().slice(0, 120);
    const kind = c.q("kind");
    if (kind === "file") return json({ items: await searchFiles(root.dir, q, 20) });
    if (kind === "commit") return json({ items: await searchCommits(root.dir, q, 15) });
    if (kind === "symbol") {
      const r = await searchSymbols(root.dir, q, 15);
      return json({ items: r.items, symbols: r.engine });
    }
    return json(await searchAll(root.dir, q));
  }

  if (c.path === "/api/context/resolve" && c.method === "POST") {
    const chips = parseChips(c.body.context);
    const root = String(c.body.root ?? "");
    resolveRoot(root);
    const r = await resolveChips(chips, { root, previewUrl: typeof c.body.preview_url === "string" ? c.body.preview_url : null, selfPort: selfPort(c) });
    return json(r);
  }

  if (c.path === "/api/context/images" && c.method === "POST") {
    const b64 = String(c.body.data ?? "").replace(/^data:[^,]*,/, "");
    try {
      const img = saveImage(Buffer.from(b64, "base64"));
      return json({ id: img.id, mime: img.mime, bytes: img.bytes }, 201);
    } catch (err) {
      if (err instanceof ImageError) throw new HttpError(400, err.message);
      throw err;
    }
  }
  // Any attachable file (images included): { name, data } with data as base64 or a data: URL.
  if (c.path === "/api/context/files" && c.method === "POST") {
    const b64 = String(c.body.data ?? "").replace(/^data:[^,]*,/, "");
    try {
      return json(saveUpload(String(c.body.name ?? "file"), Buffer.from(b64, "base64")), 201);
    } catch (err) {
      if (err instanceof FileError || err instanceof ImageError) throw new HttpError(400, err.message);
      throw err;
    }
  }
  if ((m = c.match(/^\/api\/context\/files\/(fil_[0-9a-f]{16})$/)) && c.method === "GET") {
    const f = storedFile(m[1]);
    if (!f) throw new HttpError(404, "No such file.");
    return json({ id: f.id, name: f.name, kind: f.kind, bytes: f.bytes });
  }
  if ((m = c.match(/^\/api\/context\/images\/(img_[0-9a-f]{16})$/)) && c.method === "GET") {
    const img = imageFile(m[1]);
    if (!img) throw new HttpError(404, "No such image.");
    return new Response(fs.readFileSync(img.file), { headers: { "content-type": img.mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  }

  // Folding (see the header comment).
  if (c.method === "POST" && Array.isArray(c.body.context)) {
    if (c.path === "/api/sessions") {
      const cwd = String(c.body.cwd ?? "");
      const w = Workspaces.list().find((x) => x.path === cwd);
      if (!w) throw new HttpError(400, "Context chips need a workspace: open the folder first.");
      await fold(c, w.id, w.path, "prompt");
    } else if ((m = c.match(/^\/api\/sessions\/([^/]+)\/send$/))) {
      const s = getSession(m[1]);
      if (s) {
        const ws = Workspaces.list().find((x) => x.path === s.base_cwd);
        await fold(c, ws?.id ?? s.id, s.cwd, "message");
      }
    }
  }
  return null;
};
