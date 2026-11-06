/**
 * `trb deploy`, `trb release` and `trb domain`: deploys, releases and DNS from a terminal. The project is the
 * current directory. Deploys run in the daemon; this follows their log until they finish.
 *
 *   trb deploy [env] [--force]                           deploy an environment (the only target when env is omitted); prod is refused while launch checklists block it, unless --force
 *   trb deploy targets                                   the environments and what each deploys with
 *   trb deploy targets add <env> <provider> [--url U] [--dir D] [--project P] [--app A] [--scope S] [--branch B] [--configFile F] [-- argv…]
 *   trb deploy targets rm <env>
 *   trb deploy history [env] [--limit N]                 newest first
 *   trb deploy rollback [env]                            roll back the live deploy to the one before it
 *   trb release …                                        see release.ts: range, draft, publish, plan|cut
 *   trb domain add <domain> --target <host> [--env E] [--no-proxy]
 *   trb domain check <domain> --target <host>
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson } from "../fmt";

interface Target {
  id: string;
  env: string;
  provider: string;
  url: string | null;
  config: Record<string, any>;
}
interface Deploy {
  id: string;
  kind: string;
  status: string;
  git_sha: string | null;
  version: string | null;
  url: string | null;
  log_tail: string;
  started_at: string;
  finished_at: string | null;
}

const USAGE = `Usage: trb deploy [env] | targets | targets add <env> <provider> [flags] [-- argv…] | targets rm <env> | history [env] | rollback [env]
       trb release plan|cut|range|draft|drafts|publish|ls (see trb release)
       trb domain add <domain> --target <host> [--env E] [--no-proxy] | check <domain> --target <host>`;

async function workspaceId(): Promise<{ id: string; path: string }> {
  const dir = path.resolve(process.cwd());
  const r = await api<{ workspace: { id: string; path: string } }>("POST", "/api/workspaces", { path: dir });
  return { id: r.workspace.id, path: r.workspace.path };
}

async function targetsOf(root: string): Promise<Target[]> {
  return (await api<{ targets: Target[] }>("GET", `/api/deploy/targets?root=${encodeURIComponent(root)}`)).targets;
}

/** The target for an env, or the only one when no env was given. */
async function pick(root: string, env: string | undefined): Promise<Target> {
  const targets = await targetsOf(root);
  if (!targets.length) die("No deploy targets here. Add one: trb deploy targets add <env> <provider>");
  if (env) {
    const t = targets.find((x) => x.env === env);
    if (!t) die(`No deploy target for "${env}". Targets: ${targets.map((x) => x.env).join(", ")}.`);
    return t;
  }
  if (targets.length === 1) return targets[0]!;
  die(`Several targets (${targets.map((x) => x.env).join(", ")}). Name one: trb deploy <env>`);
}

/** Print the log as it grows, until the deploy is no longer queued or running. Returns the final row. */
async function follow(id: string): Promise<Deploy> {
  let printed = "";
  for (;;) {
    const { deploy } = await api<{ deploy: Deploy }>("GET", `/api/deploys/${encodeURIComponent(id)}`);
    const log = deploy.log_tail ?? "";
    // The tail is a window: print only what was not printed yet, or the whole window when it moved on.
    process.stdout.write(log.startsWith(printed) ? log.slice(printed.length) : `\n${log}`);
    printed = log;
    if (deploy.status !== "queued" && deploy.status !== "running") return deploy;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function finish(d: Deploy): number {
  const label = d.kind === "rollback" ? "Rolled back" : "Deployed";
  if (d.status === "succeeded") {
    console.log(`\n${c.green(label)}${d.url ? `: ${c.bold(d.url)}` : ""}${d.version ? c.dim(`  v${d.version}`) : ""}${d.git_sha ? c.dim(`  ${d.git_sha.slice(0, 7)}`) : ""}`);
    return 0;
  }
  console.log(`\n${c.red(d.kind === "rollback" ? "Rollback failed" : "Deploy failed")}. Full log: trb deploy history`);
  return 1;
}

const when = (iso: string | null): string => (iso ? iso.replace("T", " ").slice(0, 16) : "running");

export async function cmdDeploy(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    url: { type: "string" },
    dir: { type: "string" },
    project: { type: "string" },
    app: { type: "string" },
    scope: { type: "string" },
    branch: { type: "string" },
    configFile: { type: "string" },
    target: { type: "string" },
    limit: { type: "string" },
    detach: { type: "boolean", short: "d" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const [first, second] = positionals;
  const ws = await workspaceId();

  if (first === "targets" && second === "add") {
    const env = positionals[2];
    const provider = positionals[3];
    if (!env || !provider) die(USAGE);
    const config: Record<string, unknown> = {};
    for (const k of ["dir", "project", "app", "scope", "branch", "configFile"] as const) if (values[k]) config[k] = values[k];
    if (provider === "command") {
      const argvList = positionals.slice(4);
      if (!argvList.length) die("A command target needs its command after --: trb deploy targets add dev command -- ./deploy.sh");
      config.argv = argvList;
    }
    const r = await api<{ target: Target }>("POST", "/api/deploy/targets", { root: ws.id, env, provider, config, url: values.url ?? null });
    if (values.json) return printJson(r);
    console.log(`added ${c.bold(r.target.env)} (${r.target.provider})`);
    return 0;
  }

  if (first === "targets" && second === "rm") {
    const t = await pick(ws.id, positionals[2]);
    await api("DELETE", `/api/deploy/targets/${encodeURIComponent(t.id)}`);
    console.log(`removed ${t.env}`);
    return 0;
  }

  if (first === "targets" || first === "ls" || first === "list") {
    const targets = await targetsOf(ws.id);
    if (values.json) return printJson({ targets });
    if (!targets.length) {
      console.log(c.dim("no deploy targets: trb deploy targets add <env> <provider>"));
      return 0;
    }
    for (const t of targets) console.log(`${c.bold(t.env.padEnd(10))} ${t.provider.padEnd(11)} ${t.url ? c.cyan(t.url) : c.dim("no url yet")}`);
    return 0;
  }

  if (first === "history") {
    const t = await pick(ws.id, second);
    const limit = values.limit ? Number(values.limit) : 20;
    const { deploys } = await api<{ deploys: Deploy[] }>("GET", `/api/deploys?target=${encodeURIComponent(t.id)}&limit=${limit}`);
    if (values.json) return printJson({ deploys });
    if (!deploys.length) console.log(c.dim(`no deploys for ${t.env} yet`));
    for (const d of deploys) {
      const status = d.status === "succeeded" ? c.green("succeeded") : d.status === "failed" ? c.red("failed") : c.yellow(d.status);
      console.log(`${c.dim(d.id)}  ${when(d.started_at)}  ${d.kind.padEnd(8)} ${status.padEnd(18)} ${d.version ? `v${d.version}`.padEnd(10) : "".padEnd(10)} ${d.url ?? ""}`);
    }
    return 0;
  }

  if (first === "rollback") {
    const t = await pick(ws.id, second);
    const { deploys } = await api<{ deploys: Deploy[] }>("GET", `/api/deploys?target=${encodeURIComponent(t.id)}&limit=50`);
    const live = deploys.find((d) => d.status === "succeeded");
    if (!live) die(`${t.env} has no successful deploy to roll back from.`);
    const { deploy } = await api<{ deploy: Deploy }>("POST", `/api/deploys/${encodeURIComponent(live.id)}/rollback`, {});
    if (values.detach) return printJson({ deploy });
    return finish(await follow(deploy.id));
  }

  // trb deploy [env]
  const t = await pick(ws.id, first);
  const { deploy } = await api<{ deploy: Deploy }>("POST", `/api/deploy/targets/${encodeURIComponent(t.id)}/run`, { force: values.force === true });
  if (values.detach) return printJson({ deploy });
  console.log(c.dim(`deploying ${t.env} with ${t.provider}`));
  return finish(await follow(deploy.id));
}

/** The release commands live in release.ts; `trb release` is routed there from main.ts. */
export { cmdRelease } from "./release";

export async function cmdDomain(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    target: { type: "string" },
    env: { type: "string" },
    "no-proxy": { type: "boolean" },
    json: { type: "boolean" },
  });
  const [sub, domain] = positionals;
  if ((sub !== "add" && sub !== "check") || !domain || !values.target) die(USAGE);
  if (sub === "check") {
    const { propagation } = await api<{ propagation: { resolved: boolean; cname: string[]; addresses: string[]; expected: string } }>("GET", `/api/domains/check?name=${encodeURIComponent(domain)}&target=${encodeURIComponent(values.target)}`);
    if (values.json) return printJson(propagation);
    console.log(propagation.resolved ? c.green(`${domain} reaches ${propagation.expected}`) : c.yellow(`${domain} does not reach ${propagation.expected} yet`));
    if (propagation.cname.length) console.log(c.dim(`CNAME: ${propagation.cname.join(", ")}`));
    if (propagation.addresses.length) console.log(c.dim(`addresses: ${propagation.addresses.join(", ")} (a proxied record answers with addresses)`));
    return propagation.resolved ? 0 : 1;
  }
  const ws = await workspaceId();
  const r = await api<{ zone: { name: string }; action: string; record: { name: string; content: string; proxied: boolean } }>("POST", "/api/domains", {
    root: ws.id,
    env: values.env ?? "prod",
    domain,
    target: values.target,
    proxied: !values["no-proxy"],
  });
  if (values.json) return printJson(r);
  console.log(`${r.action === "created" ? "added" : "updated"} ${c.bold(r.record.name)} → ${r.record.content} ${c.dim(`(zone ${r.zone.name}${r.record.proxied ? ", proxied" : ""})`)}`);
  return 0;
}
