/** CodeGraph: per-workspace index status, an explicit index/re-index job, and the auto-use toggle. */
import { CODEGRAPH_INSTALL_COMMAND, codegraphBinary, codegraphSetting, codegraphStatusAsync, clearCodegraphCache } from "../../codegraph/detect";
import { cancelCodegraphJob, dismissCodegraphJob, getCodegraphJob, latestJobFor, startCodegraph } from "../../codegraph/jobs";
import { estimateIndexSize } from "../../codegraph/estimate";
import { uninitCodegraph } from "../../codegraph/uninit";
import { setPrefs } from "../../codegraph/prefs";
import { setSetting } from "../../settings";
import { Workspaces } from "../../workspaces";
import { HttpError, json, type RouteModule } from "../http";

function dirOf(ref: string): string {
  const w = Workspaces.get(ref);
  if (!w) throw new HttpError(404, `No workspace "${ref}".`);
  return w.path;
}

export const codegraphRoutes: RouteModule = async (c) => {
  let m: RegExpMatchArray | null;
  if (c.path === "/api/codegraph" && c.method === "GET") return json({ available: !!codegraphBinary(), setting: codegraphSetting(), installCommand: CODEGRAPH_INSTALL_COMMAND });
  // The status carries the project's current job, so a reloaded page picks a running one back up.
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/codegraph$/)) && c.method === "GET") {
    const dir = dirOf(m[1]);
    const st = await codegraphStatusAsync(dir, { fresh: c.q("fresh") === "1" });
    return json({ codegraph: st, job: latestJobFor(st.root, dir) });
  }
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/codegraph\/estimate$/)) && c.method === "GET") return json({ estimate: estimateIndexSize(dirOf(m[1])) });
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/codegraph\/uninit$/)) && c.method === "POST") {
    if (c.body.confirm !== true) throw new HttpError(400, "Removing the index needs confirm: true.");
    uninitCodegraph(dirOf(m[1]));
    return json({ codegraph: await codegraphStatusAsync(dirOf(m[1]), { fresh: true }), job: null });
  }
  // Only `init` creates an index, and only when asked: the others need one to exist.
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/codegraph\/(init|sync|index)$/)) && c.method === "POST") {
    const mode = m[2] === "index" ? "reindex" : (m[2] as "init" | "sync");
    return json({ job: startCodegraph(dirOf(m[1]), mode, { gitignore: mode === "init" && c.body.gitignore !== false }) }, 202);
  }
  if ((m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/codegraph\/prefs$/)) && c.method === "PUT") {
    const dir = dirOf(m[1]);
    const { use, keepInSync } = c.body as { use?: boolean | null; keepInSync?: boolean };
    setPrefs(m[1], { use: use === undefined ? undefined : use === null ? null : use === true, keepInSync: keepInSync === undefined ? undefined : keepInSync === true });
    clearCodegraphCache();
    return json({ codegraph: await codegraphStatusAsync(dir, { fresh: true }) });
  }
  if ((m = c.match(/^\/api\/codegraph\/jobs\/([^/]+)\/(cancel|dismiss)$/)) && c.method === "POST") {
    if (!getCodegraphJob(m[1])) throw new HttpError(404, "No such index job.");
    if (m[2] === "cancel") return json({ job: await cancelCodegraphJob(m[1]) });
    dismissCodegraphJob(m[1]);
    return json({ ok: true });
  }
  if ((m = c.match(/^\/api\/codegraph\/jobs\/([^/]+)$/)) && c.method === "GET") {
    const job = getCodegraphJob(m[1]);
    if (!job) throw new HttpError(404, "No such index job.");
    return json({ job });
  }
  if (c.path === "/api/codegraph/toggle" && c.method === "POST") {
    const on = c.body.enabled === true;
    setSetting("codegraph", on ? "auto" : "off");
    clearCodegraphCache();
    return json({ setting: on ? "auto" : "off" });
  }
  return null;
};
