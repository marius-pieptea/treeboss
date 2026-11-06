/**
 * Backend for the settings UI: probing MCP servers, importing configs, editing skill files, the doctor.
 * Registered in server.ts after the core routes, so it only adds paths the core does not own.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { McpStore, RESERVED_MCP_NAMES } from "../../mcp/store";
import { probeHttp, probeStdio } from "../../mcp/probe";
import { SkillStore, parseSkillFrontmatter } from "../../skills/store";
import { builtinStatus, resetBuiltinSkill, restoreBuiltinSkills } from "../../skills/builtin";
import { listSkillPacks, setSkillPackEnabled } from "../../skill-packs";
import { runDoctor } from "../../doctor";
import { db } from "../../db";
import { paths } from "../../paths";
import { getDaemonContext } from "../../sessions/context";
import { HttpError, json, type RouteModule } from "../http";

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SKILL_BYTES = 512 * 1024;

/** What an import would do, without doing it: so the UI can show added / skipped / invalid first. */
function previewImport(file: string, overwrite: boolean): { added: string[]; skipped: string[]; invalid: string[]; servers: Record<string, { transport: "stdio" | "http"; target: string }> } {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const servers: Record<string, any> = raw?.mcpServers ?? {};
  const out = { added: [] as string[], skipped: [] as string[], invalid: [] as string[], servers: {} as Record<string, { transport: "stdio" | "http"; target: string }> };
  for (const [name, s] of Object.entries(servers)) {
    const valid = s && typeof s === "object" && /^[A-Za-z0-9_-]{1,40}$/.test(name) && !RESERVED_MCP_NAMES.has(name) && (typeof s.command === "string" || typeof s.url === "string") && !(typeof s.command === "string" && typeof s.url === "string");
    if (!valid) {
      out.invalid.push(name);
      continue;
    }
    out.servers[name] = typeof s.url === "string" ? { transport: "http", target: s.url } : { transport: "stdio", target: [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(" ") };
    if (McpStore.get(name) && !overwrite) out.skipped.push(name);
    else out.added.push(name);
  }
  return out;
}

function importFilePath(from: unknown): string {
  const f = String(from ?? "").trim();
  if (!f || f === "claude") return McpStore.claudeUserConfig();
  const abs = path.resolve(f.replace(/^~(?=$|\/)/, os.homedir()));
  return abs;
}

/**
 * A skill's SKILL.md, resolved only if it is a regular file physically inside the skill's own stored
 * directory under trb's skills home: the name comes from the URL, the path from the database, and neither
 * may be steered outside by a symlink planted in the skill directory.
 */
function skillFile(name: string): { dir: string; file: string } {
  if (!SKILL_NAME.test(name)) throw new HttpError(404, `No skill "${name}".`);
  const rec = SkillStore.get(name);
  if (!rec) throw new HttpError(404, `No skill "${name}".`);
  const home = fs.realpathSync(paths.skills());
  let dir: string;
  try {
    dir = fs.realpathSync(rec.path);
  } catch {
    throw new HttpError(404, `The files for "${name}" are missing.`);
  }
  if (dir !== path.join(home, name) && !dir.startsWith(home + path.sep)) throw new HttpError(403, "That skill lives outside trb's skills directory.");
  const file = path.join(dir, "SKILL.md");
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { dir, file };
  if (st.isSymbolicLink() || !st.isFile()) throw new HttpError(403, "SKILL.md must be a regular file.");
  return { dir, file };
}

function listSkillFiles(dir: string): Array<{ name: string; size: number; dir: boolean }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .slice(0, 200)
      .map((d) => ({ name: d.name, dir: d.isDirectory(), size: d.isFile() ? fs.statSync(path.join(dir, d.name)).size : 0 }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  } catch {
    return [];
  }
}

/** The stores throw plain Errors for bad input ("Skill name must be…"); to a client that is a 400, not a crash. */
function bad<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, String(err?.message ?? err));
  }
}

export const settingsExtRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;

  /* ---- MCP ---- */
  if (c.path === "/api/mcp/import" && c.method === "POST") {
    const file = importFilePath(c.body.from);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, `${file} does not exist.`);
    let preview;
    try {
      preview = previewImport(file, c.body.overwrite === true);
    } catch (err: any) {
      throw new HttpError(400, `Could not read ${file}: ${err.message}`);
    }
    if (c.body.dryRun === true) return json({ file, ...preview });
    const r = bad(() => McpStore.importFile(file, { overwrite: c.body.overwrite === true }));
    return json({ file, ...r, servers: preview.servers });
  }

  if ((m = c.match(/^\/api\/mcp\/([^/]+)\/test$/)) && c.method === "POST") {
    const rec = McpStore.get(m[1]);
    if (!rec) throw new HttpError(404, `No MCP server "${m[1]}".`);
    const result = rec.transport === "stdio" ? await probeStdio(rec.command!, rec.args, rec.env, { timeoutMs: 15_000 }) : await probeHttp(rec.url!, rec.headers, { timeoutMs: 15_000 });
    return json({ name: rec.name, ...result });
  }

  if ((m = c.match(/^\/api\/mcp\/([^/]+)$/)) && c.method === "PUT") {
    if (!McpStore.get(m[1])) throw new HttpError(404, `No MCP server "${m[1]}".`);
    // put() upserts and keeps the enabled flag; the name is the identity, so it cannot be changed here.
    return json({ server: bad(() => McpStore.put({ name: m![1], command: c.body.command, args: c.body.args, env: c.body.env, url: c.body.url, headers: c.body.headers })) });
  }

  /* ---- skills ---- */
  if (c.path === "/api/skills/restore-builtins" && c.method === "POST") return json({ added: restoreBuiltinSkills() });
  if (c.path === "/api/skills/packs" && c.method === "GET") return json(listSkillPacks());
  if ((m = c.match(/^\/api\/skills\/packs\/([^/]+)\/enabled$/)) && c.method === "POST") {
    if (typeof c.body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    const counts = setSkillPackEnabled(m[1], c.body.enabled);
    if (!counts) throw new HttpError(404, `No skill pack "${m[1]}".`);
    return json(counts);
  }
  if ((m = c.match(/^\/api\/skills\/([^/]+)\/reset$/)) && c.method === "POST") {
    const rec = bad(() => resetBuiltinSkill(m![1]));
    return json({ skill: { ...rec, ...builtinStatus(rec) } });
  }
  if (c.path === "/api/skills/create" && c.method === "POST") {
    return json({ skill: bad(() => SkillStore.create(String(c.body.name ?? "").trim(), String(c.body.description ?? "").trim())) }, 201);
  }
  if (c.path === "/api/skills/import" && c.method === "POST") {
    const dir = String(c.body.dir ?? "").trim();
    if (!dir) throw new HttpError(400, "dir is required.");
    const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(404, `${abs} is not a directory.`);
    return json({ dir: abs, ...bad(() => SkillStore.importDir(abs, { overwrite: c.body.overwrite === true })) });
  }

  if ((m = c.match(/^\/api\/skills\/([^/]+)\/file$/))) {
    const { dir, file } = skillFile(m[1]);
    if (c.method === "GET") {
      if (!fs.existsSync(file)) throw new HttpError(404, "This skill has no SKILL.md.");
      const st = fs.statSync(file);
      if (st.size > MAX_SKILL_BYTES) throw new HttpError(413, "SKILL.md is too large to edit here.");
      return json({ name: m[1], dir, content: fs.readFileSync(file, "utf-8"), mtime: Math.round(st.mtimeMs), files: listSkillFiles(dir) });
    }
    if (c.method === "PUT") {
      const content = String(c.body.content ?? "");
      if (Buffer.byteLength(content) > MAX_SKILL_BYTES) throw new HttpError(413, "SKILL.md is too large.");
      const current = fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : null;
      if (c.body.expectedMtime != null && current !== null && Math.abs(current - Number(c.body.expectedMtime)) > 1) {
        return json({ error: "SKILL.md changed on disk since you opened it.", conflict: true, mtime: current }, 409);
      }
      const tmp = path.join(dir, `.SKILL.md.trb-${process.pid}-${Date.now()}.tmp`);
      try {
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      // The description is what the list shows and what a prompt index uses: keep it in step with the file.
      const fm = parseSkillFrontmatter(content);
      db().prepare("UPDATE skills SET description = ? WHERE name = ?").run(fm.description ?? "", m[1]);
      return json({ ok: true, mtime: Math.round(fs.statSync(file).mtimeMs), description: fm.description ?? "" });
    }
  }

  /* ---- doctor ---- */
  if (c.path === "/api/doctor" && c.method === "GET") {
    const ctx = getDaemonContext();
    const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    // The Engines page loads this: REA's deep check (its own doctor, may download) is left to the Check button in Settings > MCP.
    return json(await runDoctor(ctx ? { url: ctx.url, pid: process.pid, startedAt } : null, undefined, { reaDeep: false }));
  }

  return null;
};
