/**
 * Deploy targets, deploys, domains and releases over HTTP. `root` is a root reference (w_… or s_…), like the
 * roadmap's. Workspace ids are what the store keeps; a session ref is mapped to its folder's workspace.
 *
 * A prod run is refused while launch checklists block it (409, with the blockers), unless the body has force: true.
 *
 *   GET    /api/deploy/providers?root=                  providers, with the config file that detected each
 *   GET    /api/deploy/targets?root=                    targets of the workspace
 *   POST   /api/deploy/targets                          { root, env, provider, config?, url? }
 *   PATCH  /api/deploy/targets/:id                      { env?, provider?, config?, url? }
 *   DELETE /api/deploy/targets/:id
 *   POST   /api/deploy/targets/:id/run                  { force? } start a deploy (202, runs in the background)
 *   GET    /api/deploy/targets/:id/status               the provider's view of the URL (up, down, unknown)
 *   GET    /api/deploys?target=&root=&limit=            history, newest first
 *   GET    /api/deploys/:id                             one deploy, with its log tail (poll while running)
 *   POST   /api/deploys/:id/rollback                    roll back from the live deploy (202)
 *   GET    /api/domains/zones?root=&env=                Cloudflare zones the environment's token can see
 *   POST   /api/domains                                 { root, env?, domain, target, proxied? } add or update a CNAME
 *   GET    /api/domains/check?name=&target=             does the name reach the target
 *   POST   /api/release/:root                           { bump, mode: "plan" | "cut" }
 */
import { resolveRoot, Workspaces, type Workspace } from "../../workspaces";
import { detectProviders, PROVIDER_IDS, PROVIDERS } from "../../deploy/providers";
import { createTarget, deleteTarget, getDeploy, getTarget, LaunchRefused, listDeploys, listTargets, rollbackDeploy, runDeploy, targetStatus, updateTarget } from "../../deploy/store";
import { addDomain, checkPropagation, listZones, tokenFor } from "../../deploy/domains";
import { BUMPS, cutRelease, planRelease, type Bump } from "../../deploy/release";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The workspace a root reference points at. A session's folder is registered as a workspace on first use. */
function workspaceOf(ref: string | null): Workspace {
  if (!ref) throw new HttpError(400, "root is required (a workspace or session id).");
  if (ref.startsWith("w_")) {
    const w = Workspaces.get(ref);
    if (!w) throw new HttpError(404, `No workspace "${ref}".`);
    return w;
  }
  return Workspaces.open(resolveRoot(ref).dir);
}

const guardBump = (v: unknown): Bump => {
  if (!BUMPS.includes(v as Bump)) throw new HttpError(400, `bump must be one of: ${BUMPS.join(", ")}.`);
  return v as Bump;
};

export const deployRoutes: RouteModule = async (c: Ctx) => {
  const { method } = c;
  const b = c.body;

  if (c.match(/^\/api\/deploy\/providers$/) && method === "GET") {
    const ws = workspaceOf(c.q("root"));
    const detected = new Map(detectProviders(ws.path).map((d) => [d.id, d.reason]));
    return json({ providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label, detectedBy: detected.get(id) ?? null })) });
  }

  if (c.match(/^\/api\/deploy\/targets$/)) {
    if (method === "GET") {
      const ws = workspaceOf(c.q("root"));
      return json({ targets: listTargets(ws.id) });
    }
    if (method === "POST") {
      const ws = workspaceOf(str(b.root));
      return json({ target: createTarget({ workspaceId: ws.id, env: String(b.env ?? ""), provider: String(b.provider ?? ""), config: b.config, url: str(b.url) }) }, 201);
    }
  }

  let m: RegExpMatchArray | null;
  if ((m = c.match(/^\/api\/deploy\/targets\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]!);
    if (method === "PATCH") {
      if (!getTarget(id)) throw new HttpError(404, `No deploy target "${id}".`);
      const patch: Record<string, unknown> = {};
      if ("env" in b) patch.env = b.env;
      if ("provider" in b) patch.provider = b.provider;
      if ("config" in b) patch.config = b.config;
      if ("url" in b) patch.url = str(b.url);
      return json({ target: updateTarget(id, patch) });
    }
    if (method === "DELETE") {
      deleteTarget(id);
      return json({ ok: true });
    }
  }

  if ((m = c.match(/^\/api\/deploy\/targets\/([^/]+)\/run$/)) && method === "POST") {
    try {
      return json({ deploy: runDeploy(decodeURIComponent(m[1]!), { force: b.force === true }) }, 202);
    } catch (e) {
      if (e instanceof LaunchRefused) return json({ error: e.message, blockers: e.blockers }, 409);
      throw e;
    }
  }

  if ((m = c.match(/^\/api\/deploy\/targets\/([^/]+)\/status$/)) && method === "GET") {
    return json({ status: await targetStatus(decodeURIComponent(m[1]!)) });
  }

  if (c.match(/^\/api\/deploys$/) && method === "GET") {
    const limit = Number(c.q("limit") ?? 50);
    const target = c.q("target");
    const root = c.q("root");
    if (!target && !root) throw new HttpError(400, "Pass target (a target id) or root (a workspace or session id).");
    return json({ deploys: listDeploys({ targetId: target ?? undefined, workspaceId: target ? undefined : workspaceOf(root).id, limit: Number.isFinite(limit) ? limit : 50 }) });
  }

  if ((m = c.match(/^\/api\/deploys\/([^/]+)$/)) && method === "GET") {
    const d = getDeploy(decodeURIComponent(m[1]!));
    if (!d) throw new HttpError(404, "No such deploy.");
    return json({ deploy: d });
  }

  if ((m = c.match(/^\/api\/deploys\/([^/]+)\/rollback$/)) && method === "POST") {
    return json({ deploy: rollbackDeploy(decodeURIComponent(m[1]!)) }, 202);
  }

  if (c.match(/^\/api\/domains\/zones$/) && method === "GET") {
    const ws = workspaceOf(c.q("root"));
    const env = c.q("env") ?? "prod";
    return json({ zones: await listZones(tokenFor(ws.id, env)) });
  }

  if (c.match(/^\/api\/domains$/) && method === "POST") {
    const ws = workspaceOf(str(b.root));
    const r = await addDomain({ workspaceId: ws.id, env: str(b.env) ?? "prod", domain: String(b.domain ?? ""), target: String(b.target ?? ""), proxied: typeof b.proxied === "boolean" ? b.proxied : undefined });
    return json(r, 201);
  }

  if (c.match(/^\/api\/domains\/check$/) && method === "GET") {
    const name = c.q("name");
    const target = c.q("target");
    if (!name || !target) throw new HttpError(400, "Pass name and target.");
    return json({ propagation: await checkPropagation(name, target) });
  }

  if ((m = c.match(/^\/api\/release\/([^/]+)$/)) && method === "POST") {
    const ws = workspaceOf(decodeURIComponent(m[1]!));
    const bump = guardBump(b.bump);
    if (b.mode === "cut") return json(cutRelease(ws.path, bump));
    if (b.mode === undefined || b.mode === "plan") return json({ plan: planRelease(ws.path, bump) });
    throw new HttpError(400, 'mode must be "plan" or "cut".');
  }

  return null;
};

