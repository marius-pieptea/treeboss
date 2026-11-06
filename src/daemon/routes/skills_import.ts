/** Skill import with progress: scan a folder, start a background import, poll it. */
import { cancelImportJob, getImportJob, scanSkills, startImport } from "../../skills/import";
import { HttpError, json, type RouteModule } from "../http";

export const skillsImportRoutes: RouteModule = (c) => {
  let m: RegExpMatchArray | null;
  if (c.path === "/api/skills/import/scan" && c.method === "POST") return json(scanSkills(String(c.body.dir ?? "")));
  if (c.path === "/api/skills/import/start" && c.method === "POST") {
    return json({ job: startImport(String(c.body.dir ?? ""), { names: Array.isArray(c.body.names) ? c.body.names.map(String) : null, overwrite: c.body.overwrite === true }) }, 202);
  }
  if ((m = c.match(/^\/api\/skills\/import\/jobs\/([^/]+)$/)) && c.method === "GET") {
    const job = getImportJob(m[1]);
    if (!job) throw new HttpError(404, "No such import.");
    return json({ job });
  }
  if ((m = c.match(/^\/api\/skills\/import\/jobs\/([^/]+)\/cancel$/)) && c.method === "POST") return json({ cancelled: cancelImportJob(m[1]) });
  return null;
};
