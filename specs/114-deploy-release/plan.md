# Implementation Plan: Deploy targets, deploy history, rollback, domains and releases

**Feature**: `114-deploy-release` | **Spec**: [spec.md](./spec.md)

## Summary

`src/deploy/` holds four parts. `providers/` turns a workspace folder into a live URL through one of four CLIs and rolls back through the same CLI. `store.ts` owns the targets and the history, runs a deploy as a background job that streams a redacted log tail, and picks the rollback target. `domains.ts` talks to the Cloudflare DNS API with fetch. `release.ts` previews and cuts a semver release. Routes, a CLI and a web pipeline sit on top. Nothing is registered by this slice; the parent wires the routes, the CLI and the secrets.

## Technical Context

- **Dependencies**: none added. Child processes use `Bun.spawn` with argv arrays; HTTP uses `fetch`.
- **Storage**: `deploy_targets` and `deploys` (or `deploy_runs`, see below), created lazily with `CREATE TABLE IF NOT EXISTS` on first use per database handle. `src/db.ts` is not edited.
- **Secrets**: `setEnvProvider(fn)` in `store.ts`, default `() => ({})`. The secrets slice wires `resolveEnv` in once it exists (see [Wiring](#wiring)).
- **Concurrency**: one job per target (`busy` map). Jobs are promises kept in a map so tests can `waitDeploy`.
- **Logs**: the raw output is kept in memory (twice the tail size); the persisted tail is the last 8000 characters, redacted over the whole buffer each time it is written (every 300 ms while running, and at the end).
- **Test seams**: `setEnvProvider`, the `fetchFn` parameter of the domain functions, and `command` targets whose argv is `process.execPath -e …`, which need no external CLI.
- **Testing**: `bun test tests/deploy.test.ts` (31 tests). Typecheck: `bun run typecheck`.

## Constitution Check

No new listener, no new network exposure: deploys run only when asked, and the only outbound calls are the provider CLIs and the Cloudflare API and DoH endpoints. Secrets are never on a command line. Commands are argv arrays, never a shell. Destructive operations (rollback, cut) are confirmed in the UI.

## Project Structure

```text
src/deploy/providers/types.ts       DeployProvider contract, ProviderId, DeployOptions
src/deploy/providers/exec.ts        runArgv (argv, env, streaming), urlIn, redact, probeUrl
src/deploy/providers/cloudflare.ts  wrangler: Workers deploy/rollback; Pages deploy, no rollback
src/deploy/providers/vercel.ts      vercel deploy [--prod], vercel rollback <url>
src/deploy/providers/fly.ts         flyctl deploy, flyctl releases --json, flyctl releases rollback
src/deploy/providers/command.ts     the user's argv, optional rollbackArgv with {id}
src/deploy/providers/index.ts       PROVIDERS, providerFor, detectProviders
src/deploy/store.ts                 targets, runDeploy, rollbackDeploy, listDeploys, setEnvProvider
src/deploy/domains.ts               listZones, upsertCname, checkPropagation, addDomain, tokenFor
src/deploy/release.ts               bumpVersion, parseCommit, changelogSection, planRelease, cutRelease
src/daemon/routes/deploy.ts         deployRoutes (HTTP, see below)
src/cli/commands/deploy.ts          cmdDeploy, cmdRelease, cmdDomain
web/src/features/deploy/logic.ts    pure pipeline rules (ordering, live deploy, rollback eligibility)
web/src/features/deploy/data.ts     react-query hooks and mutations
web/src/features/deploy/DeployView.tsx    the pipeline (dev, staging, prod cards)
web/src/features/deploy/PipelineCard.tsx  one environment, its actions, its history and log
web/src/features/deploy/ReleaseDialog.tsx preview a bump, cut it
tests/deploy.test.ts
specs/114-deploy-release/{spec,plan,tasks}.md
```

## Design notes

**Providers.** `detect(root)` returns the file that selected the provider (`wrangler.toml`, `vercel.json`, `fly.toml`), or null. `command` is never detected. `deploy` and `rollback` take `DeployOptions` (config, vars, onLog, signal) and return the URL and the provider's handle. For Cloudflare Workers the handle is the version id wrangler prints; for Vercel it is the deployment URL; for Fly it is the release version; for the command provider it is the URL it printed.

**Secrets to child only.** Providers pass `vars` as the child's `env`, merged over the daemon's environment. The Vercel token travels as `VERCEL_TOKEN`, not `--token`, so it stays out of argv (a deliberate departure from the brief's wording). Cloudflare reads `CLOUDFLARE_API_TOKEN` from the same env.

**Redaction.** The stored tail is redacted by replacing every secret value of four or more characters with `[redacted]`. The in-memory buffer is raw. A value cut across the buffer's trim point could survive in part; the window is twice the tail size, so a whole value always fits.

**Rollback target.** The live deploy is the newest succeeded row. The target is the newest earlier succeeded row whose artifact (`provider_deploy_id`, else `url`) differs from the live one. A rollback is itself a row (`kind = 'rollback'`), so rolling back a rollback steps forward again.

**History table name.** The brief names the table `deploys`. Spec 030 left a `deploys` table with other columns in some databases. `runsTableIn()` checks `PRAGMA table_info` and uses `deploy_runs` when `deploys` lacks `target_id`. Fresh databases get `deploys`.

**Startup sweep.** On the first use of a database handle, deploys left `queued` or `running` are marked `failed` ("interrupted").

**Release.** `planRelease` reads: the last `v*` tag (`git describe`), commits since it, roadmap items checked now that were not checked at the tag (`parseRoadmap` of `git show <tag>:ROADMAP.md`). `cutRelease` refuses a dirty tree and an existing tag, rewrites the first `"version"` in `package.json` in place (formatting kept), inserts the section above the first existing one in `CHANGELOG.md`, stages both, commits `chore(release): vX.Y.Z`, and tags that commit annotated. Any failure before the tag restores both files.

**Domains.** Zones are listed by the token's account; the zone is the longest one the name ends with. A CNAME is looked up by name and PATCHed if it exists, POSTed otherwise. Propagation asks `cloudflare-dns.com` for CNAME and, when there is none, A (a proxied record flattens to addresses).

## Wiring

These are the lines the parent adds. None of these files was edited here.

```ts
// src/daemon/server.ts
import { deployRoutes } from "./routes/deploy";
// ...in the modules array, before coreRoutes (any position before it works):
const modules: RouteModule[] = [ /* … */ deployRoutes, /* … */ ];
```

```ts
// src/cli/main.ts
import { cmdDeploy, cmdDomain, cmdRelease } from "./commands/deploy";
// ...in the switch:
case "deploy":
  return cmdDeploy(rest);
case "release":
  return cmdRelease(rest);
case "domain":
  return cmdDomain(rest);
// ...in the help text (USAGE):
//   trb deploy [env]|targets|history|rollback  deploy an environment, its targets and history, or roll back
//   trb release plan|cut <patch|minor|major>  preview or cut a release (changelog, commit, tag)
//   trb domain add|check <domain> --target <host>  point a domain's CNAME at a deploy
```

```ts
// Once src/secrets exports resolveEnv (daemon bootstrap, after the database is open):
import { setEnvProvider } from "../deploy/store";
import { resolveEnv } from "../secrets";
setEnvProvider(resolveEnv); // (workspaceId: string, env: string) => Record<string, string>
```

Web: mount `<DeployView root={workspaceIdOrSessionId} />` (from `web/src/features/deploy/DeployView`) in a shell view. `web/src/shell/*` is not edited here.

## HTTP surface

| Method and path | Purpose |
|---|---|
| GET `/api/deploy/providers?root=` | providers, with the file that detected each |
| GET `/api/deploy/targets?root=` | targets of the workspace |
| POST `/api/deploy/targets` | `{ root, env, provider, config?, url? }` |
| PATCH `/api/deploy/targets/:id` | `{ env?, provider?, config?, url? }` |
| DELETE `/api/deploy/targets/:id` | remove a target and its history |
| POST `/api/deploy/targets/:id/run` | start a deploy (202) |
| GET `/api/deploy/targets/:id/status` | up, down or unknown for the target's URL |
| GET `/api/deploys?target=` or `?root=&limit=` | history, newest first |
| GET `/api/deploys/:id` | one deploy with its log tail |
| POST `/api/deploys/:id/rollback` | roll back from the live deploy (202) |
| GET `/api/domains/zones?root=&env=` | zones the environment's token sees |
| POST `/api/domains` | `{ root, env?, domain, target, proxied? }` |
| GET `/api/domains/check?name=&target=` | propagation |
| POST `/api/release/:root` | `{ bump, mode: "plan" \| "cut" }` |

Errors are `UserError` (400) from the store and providers, and `HttpError` from the routes.

## Risks

- **Provider CLIs drift.** The argv shapes are fixed in the provider modules. A new CLI version may rename a flag; the failure then shows in the log tail rather than being silent.
- **Fly rollback form** is unverified against a live flyctl (see spec Assumptions).
- **Cloudflare Pages** cannot roll back from the CLI; the target says so.
