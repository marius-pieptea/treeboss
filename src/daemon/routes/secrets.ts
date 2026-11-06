/**
 * Environments and secrets of one workspace over HTTP. `:id` is a workspace id (w_…). No route returns a secret
 * value: listings carry names and times, and writes answer with the name and time they stored.
 *
 *   GET    /api/workspaces/:id/envs                        { envs }: dev, staging, prod, then custom ones
 *   POST   /api/workspaces/:id/envs                        { name, url? }   add, or set the URL of one
 *   DELETE /api/workspaces/:id/envs/:name                  a custom environment and its secrets
 *   GET    /api/workspaces/:id/secrets?env=dev             { env, keys: [{ key, updatedAt }] }
 *   PUT    /api/workspaces/:id/secrets/:key?env=dev        { value }   set or replace
 *   DELETE /api/workspaces/:id/secrets/:key?env=dev        remove one
 *   POST   /api/workspaces/:id/secrets/import              { env, path }   a .env file inside the workspace
 *   POST   /api/workspaces/:id/secrets/export              { env, path?, force? }   writes .env (0600), only when asked
 */
import { Workspaces } from "../../workspaces";
import { addEnv, exportDotenv, importDotenv, listEnvs, listSecretKeys, removeEnv, setSecret, unsetSecret } from "../../secrets/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

export const secretsRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/workspaces\/(w_[^/]+)\/(envs|secrets)(?:\/(.*))?$/);
  if (!m) return null;
  const id = m[1]!;
  if (!Workspaces.get(id)) throw new HttpError(404, `No workspace "${id}".`);
  const rest = m[3] ?? "";
  const envOf = (body: Record<string, any>): string => String(body.env ?? c.q("env") ?? "") || "dev";

  if (m[2] === "envs") {
    if (rest === "" && c.method === "GET") return json({ envs: listEnvs(id) });
    if (rest === "" && c.method === "POST") {
      addEnv(id, String(c.body.name ?? ""), typeof c.body.url === "string" ? c.body.url : null);
      return json({ envs: listEnvs(id) }, 201);
    }
    if (rest && c.method === "DELETE") {
      const { removedSecrets } = removeEnv(id, decodeURIComponent(rest));
      return json({ removedSecrets, envs: listEnvs(id) });
    }
    throw new HttpError(404, `No environment route ${c.method} ${c.path}.`);
  }

  const env = envOf({});
  if (rest === "" && c.method === "GET") return json({ env, keys: listSecretKeys(id, env) });
  if (rest === "import" && c.method === "POST") {
    const e = envOf(c.body);
    return json({ env: e, ...importDotenv(id, e, String(c.body.path ?? "")) });
  }
  if (rest === "export" && c.method === "POST") {
    const e = envOf(c.body);
    return json({ env: e, ...exportDotenv(id, e, typeof c.body.path === "string" ? c.body.path : null, c.body.force === true) });
  }
  const im = rest.match(/^([^/]+)$/);
  if (im) {
    const key = decodeURIComponent(im[1]!);
    if (c.method === "PUT") {
      if (typeof c.body.value !== "string") throw new HttpError(400, "Send the value as text: { value }.");
      return json({ env, ...setSecret(id, env, key, c.body.value) });
    }
    if (c.method === "DELETE") return json({ env, key, removed: unsetSecret(id, env, key) });
  }
  throw new HttpError(404, `No secrets route ${c.method} ${c.path}.`);
};
