/** Deploy targets, history, rollback, domains and releases. The provider CLIs are stood in for by `bun -e` scripts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { detectProviders, PROVIDERS, providerFor } from "../src/deploy/providers";
import { cloudflare, cloudflareKind } from "../src/deploy/providers/cloudflare";
import { redact, urlIn } from "../src/deploy/providers/exec";
import { addDomain, checkPropagation, hostOf, listZones, upsertCname, zoneFor, type Zone } from "../src/deploy/domains";
import { bumpVersion, changelogSection, cutRelease, parseCommit, planRelease } from "../src/deploy/release";
import { cleanConfig, createTarget, deleteTarget, getDeploy, listDeploys, listTargets, rollbackDeploy, runDeploy, setEnvProvider, updateTarget, waitDeploy } from "../src/deploy/store";
import { closeDb, db } from "../src/db";
import { UserError } from "../src/util";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState } from "./helpers";
import { spawnSync } from "child_process";
import { deployRoutes } from "../src/daemon/routes/deploy";
import { HttpError, makeCtx } from "../src/daemon/http";
import { canRollback, deploysOf, formatWhen, liveOf, orderTargets, type Deploy } from "../web/src/features/deploy/logic";

const BUN = process.execPath;
/** A stand-in CLI: prints one line and exits 0. Passed as argv (no shell), so quoting is plain JS. */
const say = (text: string) => [BUN, "-e", `console.log(${JSON.stringify(text)})`];

beforeEach(() => {
  resetState();
  // Make sure the deploy tables exist, then clear them.
  listTargets("none");
  db().exec("DELETE FROM deploys; DELETE FROM deploy_targets;");
  setEnvProvider(null);
});
afterEach(() => setEnvProvider(null));

function workspace(files: Record<string, string> = { "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n" }) {
  const dir = makeRepo(files);
  return { dir, id: Workspaces.open(dir).id };
}

const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/* -------------------------------------------------------------------------- */
/* Pure logic                                                                 */
/* -------------------------------------------------------------------------- */

describe("versions and changelog", () => {
  test("bumps patch, minor and major, and drops a prerelease", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.4");
    expect(() => bumpVersion("latest", "patch")).toThrow(UserError);
  });

  test("reads conventional commits, breaking changes included", () => {
    expect(parseCommit("abc1234def", "feat(ui)!: drop the old panel")).toMatchObject({ type: "feat", scope: "ui", breaking: true, description: "drop the old panel" });
    expect(parseCommit("abc1234def", "Fix the thing")).toMatchObject({ type: "other", breaking: false });
  });

  test("groups the section and leaves out merges and release commits", () => {
    const sec = changelogSection({
      version: "1.1.0",
      date: "2026-10-28",
      commits: [
        parseCommit("1111111aaa", "feat(deploy): targets"),
        parseCommit("2222222bbb", "fix: rollback label"),
        parseCommit("3333333ccc", "Merge branch 'x'"),
        parseCommit("4444444ddd", "chore(release): v1.0.0"),
        parseCommit("5555555eee", "docs: readme"),
      ],
      roadmap: [{ id: "r9", title: "Deploy pipeline" }],
    });
    expect(sec).toContain("## 1.1.0 - 2026-10-28");
    expect(sec).toContain("### Added\n- **deploy:** targets (1111111)");
    expect(sec).toContain("### Fixed\n- rollback label (2222222)");
    expect(sec).toContain("### Other\n- readme (5555555)");
    expect(sec).toContain("### Roadmap\n- Deploy pipeline");
    expect(sec).not.toContain("Merge");
    expect(sec).not.toContain("release");
  });

  test("urlIn prefers the matching host and keeps the last otherwise", () => {
    expect(urlIn("see https://dash.example.com then https://app.workers.dev.", /workers\.dev/)).toBe("https://app.workers.dev");
    expect(urlIn("https://a.example.com and https://b.example.com")).toBe("https://b.example.com");
    expect(urlIn("no link")).toBeNull();
  });

  test("redact masks secret values and skips short ones", () => {
    expect(redact("token=s3cret-value ok", { T: "s3cret-value" })).toBe("token=[redacted] ok");
    expect(redact("ab ab", { T: "ab" })).toBe("ab ab");
  });
});

describe("providers", () => {
  test("detects each provider from its config file", () => {
    const dir = makeDir();
    expect(detectProviders(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "wrangler.toml"), 'name = "app"\n');
    fs.writeFileSync(path.join(dir, "vercel.json"), "{}");
    fs.writeFileSync(path.join(dir, "fly.toml"), "app = 'x'\n");
    expect(detectProviders(dir).map((d) => d.id)).toEqual(["cloudflare", "vercel", "fly"]);
    expect(detectProviders(dir).find((d) => d.id === "cloudflare")?.reason).toBe("wrangler.toml");
    // "command" is never detected: only the user knows its argv.
    expect(PROVIDERS.command.detect(dir)).toBeNull();
  });

  test("tells Pages from Workers by the Pages build output", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "wrangler.jsonc"), '{ "name": "site" }');
    expect(cloudflareKind(dir)).toBe("workers");
    fs.writeFileSync(path.join(dir, "wrangler.jsonc"), '{ "name": "site", "pages_build_output_dir": "dist" }');
    expect(cloudflareKind(dir)).toBe("pages");
    expect(cloudflareKind(makeDir())).toBeNull();
  });

  test("Cloudflare Pages has no rollback command, and says so", async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "wrangler.toml"), 'pages_build_output_dir = "dist"\n');
    await expect(cloudflare.rollback(dir, "x", { config: {}, vars: {}, onLog: () => {} })).rejects.toThrow(/dashboard/);
  });

  test("an unknown provider is refused", () => {
    expect(() => providerFor("heroku")).toThrow(UserError);
    expect(providerFor("fly").label).toBe("Fly.io");
  });

  test("a command target needs an argv, and each part is a string", () => {
    expect(() => cleanConfig("command", {})).toThrow(/config.argv/);
    expect(() => cleanConfig("command", { argv: "npm run deploy" })).toThrow(/argv, not a shell line/);
    expect(cleanConfig("command", { argv: ["./deploy.sh", "prod"] })).toEqual({ argv: ["./deploy.sh", "prod"] });
    expect(() => cleanConfig("vercel", { dir: 5 })).toThrow(/short string/);
  });
});

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

describe("targets", () => {
  test("create, list, update and delete; one target per environment", () => {
    const { id } = workspace();
    const t = createTarget({ workspaceId: id, env: "staging", provider: "command", config: { argv: say("hi") }, url: "https://staging.example.com/" });
    expect(t).toMatchObject({ env: "staging", provider: "command", url: "https://staging.example.com" });
    expect(() => createTarget({ workspaceId: id, env: "staging", provider: "vercel" })).toThrow(/already has a deploy target/);
    expect(() => createTarget({ workspaceId: id, env: "Prod!", provider: "vercel" })).toThrow(/short lowercase/);
    expect(() => createTarget({ workspaceId: id, env: "prod", provider: "vercel", url: "http://insecure.example.com" })).toThrow(/https/);
    expect(updateTarget(t.id, { provider: "vercel", config: {} }).provider).toBe("vercel");
    expect(listTargets(id).map((x) => x.env)).toEqual(["staging"]);
    deleteTarget(t.id);
    expect(listTargets(id)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Deploys and rollback                                                       */
/* -------------------------------------------------------------------------- */

describe("deploy runs", () => {
  test("a deploy streams to the log, records the URL, and never saves the secret", async () => {
    const { dir, id } = workspace();
    setEnvProvider(() => ({ DEPLOY_TOKEN: "s3cret-value" }));
    const t = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: [BUN, "-e", "console.log('live https://app.example.test'); console.log('token ' + process.env.DEPLOY_TOKEN)"] } });
    const queued = runDeploy(t.id);
    expect(["queued", "running"]).toContain(queued.status);
    await waitDeploy(queued.id);
    const d = getDeploy(queued.id)!;
    expect(d.status).toBe("succeeded");
    expect(d.url).toBe("https://app.example.test");
    expect(d.version).toBe("1.0.0");
    expect(d.git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(d.log_tail).toContain("token [redacted]");
    expect(d.log_tail).not.toContain("s3cret-value");
    expect(listTargets(id)[0]!.url).toBe("https://app.example.test");
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("a failing CLI and a missing binary both fail the deploy with a reason", async () => {
    const { id } = workspace();
    const bad = createTarget({ workspaceId: id, env: "dev", provider: "command", config: { argv: [BUN, "-e", "process.exit(3)"] } });
    const d1 = runDeploy(bad.id);
    await waitDeploy(d1.id);
    expect(getDeploy(d1.id)!.status).toBe("failed");
    expect(getDeploy(d1.id)!.log_tail).toContain("exited 3");

    updateTarget(bad.id, { config: { argv: ["definitely-not-a-real-binary-xyz"] } });
    const d2 = runDeploy(bad.id);
    await waitDeploy(d2.id);
    expect(getDeploy(d2.id)!.status).toBe("failed");
    expect(getDeploy(d2.id)!.log_tail).toMatch(/not installed or not on PATH/);
  });

  test("one deploy per target at a time", async () => {
    const { id } = workspace();
    const t = createTarget({ workspaceId: id, env: "dev", provider: "command", config: { argv: [BUN, "-e", "setTimeout(() => {}, 400)"] } });
    const first = runDeploy(t.id);
    expect(() => runDeploy(t.id)).toThrow(/already deploying/);
    await waitDeploy(first.id);
    expect(getDeploy(first.id)!.status).toBe("succeeded");
  });

  test("rollback makes the previous live artifact live again, and history says so", async () => {
    const { dir, id } = workspace();
    fs.writeFileSync(path.join(dir, "next.txt"), "one.example.test");
    const rollbackArgv = [BUN, "-e", "console.log('back to {id}')"];
    const t = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: [BUN, "-e", "console.log('go https://' + require('fs').readFileSync('next.txt', 'utf8').trim())"], rollbackArgv } });
    const a = runDeploy(t.id);
    await waitDeploy(a.id);
    fs.writeFileSync(path.join(dir, "next.txt"), "two.example.test");
    const b = runDeploy(t.id);
    await waitDeploy(b.id);
    expect(getDeploy(b.id)!.url).toBe("https://two.example.test");

    const r = rollbackDeploy(b.id);
    await waitDeploy(r.id);
    const back = getDeploy(r.id)!;
    expect(back).toMatchObject({ kind: "rollback", status: "succeeded", url: "https://one.example.test" });
    expect(back.log_tail).toContain("back to https://one.example.test");
    expect(listTargets(id)[0]!.url).toBe("https://one.example.test");

    const kinds = listDeploys({ targetId: t.id }).map((d) => d.kind);
    expect(kinds).toEqual(["rollback", "deploy", "deploy"]);
  });

  test("only the live deploy rolls back, and only to an earlier artifact", async () => {
    const { id } = workspace();
    const t = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: say("https://only.example.test"), rollbackArgv: say("x") } });
    const only = runDeploy(t.id);
    await waitDeploy(only.id);
    expect(() => rollbackDeploy(only.id)).toThrow(/no earlier successful deploy/);
    expect(() => rollbackDeploy("dp_missing")).toThrow(/No deploy/);
  });

  test("a target without rollbackArgv queues a rollback that then fails, saying it cannot roll back", async () => {
    const { id } = workspace();
    // A fresh URL per run, so the two deploys are different artifacts and a rollback target exists.
    const fresh = [BUN, "-e", "console.log('https://' + Math.random().toString(36).slice(2) + '.example.test')"];
    const t = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: fresh } });
    const a = runDeploy(t.id);
    await waitDeploy(a.id);
    const b = runDeploy(t.id);
    await waitDeploy(b.id);
    const r = rollbackDeploy(b.id);
    await waitDeploy(r.id);
    expect(getDeploy(r.id)!.status).toBe("failed");
    expect(getDeploy(r.id)!.log_tail).toMatch(/cannot roll back/);
    expect(getDeploy(b.id)!.status).toBe("succeeded");
  });
});

/* -------------------------------------------------------------------------- */
/* Domains                                                                    */
/* -------------------------------------------------------------------------- */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("domains", () => {
  test("a host is taken from a URL or a bare name, and must look like one", () => {
    expect(hostOf("https://App.Example.com/path")).toBe("app.example.com");
    expect(hostOf("api.example.com.")).toBe("api.example.com");
    expect(() => hostOf("not a host")).toThrow(UserError);
  });

  test("the zone is the longest one the name ends with", () => {
    const zones: Zone[] = [
      { id: "z1", name: "example.com", status: "active" },
      { id: "z2", name: "shop.example.com", status: "active" },
    ];
    expect(zoneFor("app.shop.example.com", zones)?.id).toBe("z2");
    expect(zoneFor("example.com", zones)?.id).toBe("z1");
    expect(zoneFor("other.org", zones)).toBeNull();
  });

  test("a CNAME is created when absent and updated when present", async () => {
    const zone: Zone = { id: "z1", name: "example.com", status: "active" };
    const calls: Array<{ url: string; method: string; body?: any; auth?: string | null }> = [];
    const replies: Array<() => Response> = [
      () => json({ success: true, result: [] }),
      () => json({ success: true, result: { id: "r1", name: "app.example.com", content: "x.vercel.app", proxied: true } }),
      () => json({ success: true, result: [{ id: "r1" }] }),
      () => json({ success: true, result: { id: "r1", name: "app.example.com", content: "y.fly.dev", proxied: true } }),
    ];
    const f = (async (url: any, init?: any) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined, auth: new Headers(init?.headers).get("authorization") });
      return replies.shift()!();
    }) as unknown as typeof fetch;

    const first = await upsertCname("tok-abc", zone, { name: "app.example.com", target: "https://x.vercel.app/" }, f);
    expect(first.action).toBe("created");
    expect(calls[1]).toMatchObject({ method: "POST", body: { type: "CNAME", name: "app.example.com", content: "x.vercel.app", proxied: true } });
    expect(calls[0]!.auth).toBe("Bearer tok-abc");

    const second = await upsertCname("tok-abc", zone, { name: "app.example.com", target: "y.fly.dev" }, f);
    expect(second.action).toBe("updated");
    expect(calls[3]).toMatchObject({ method: "PATCH", body: { content: "y.fly.dev" } });
    expect(calls[3]!.url).toContain("/zones/z1/dns_records/r1");
  });

  test("addDomain needs the environment's token, and a refusal never echoes it", async () => {
    const { id } = workspace();
    await expect(addDomain({ workspaceId: id, env: "prod", domain: "app.example.com", target: "x.vercel.app" })).rejects.toThrow(/CLOUDFLARE_API_TOKEN is not set for prod/);

    setEnvProvider(() => ({ CLOUDFLARE_API_TOKEN: "tok-secret-9999" }));
    const f = (async () => json({ success: false, errors: [{ message: "Invalid request headers" }] }, 403)) as unknown as typeof fetch;
    const err = await listZones("tok-secret-9999", f).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(String(err.message)).toContain("Invalid request headers");
    expect(String(err.message)).not.toContain("tok-secret-9999");
  });

  test("propagation is checked through DNS over HTTPS", async () => {
    const f = (async (url: any) => {
      const u = new URL(String(url));
      if (u.searchParams.get("type") === "CNAME") return json({ Answer: [{ data: "x.vercel.app." }] });
      return json({});
    }) as unknown as typeof fetch;
    const ok = await checkPropagation("app.example.com", "https://x.vercel.app", f);
    expect(ok).toMatchObject({ resolved: true, cname: ["x.vercel.app"] });
    const late = (async () => json({})) as unknown as typeof fetch;
    expect((await checkPropagation("app.example.com", "x.vercel.app", late)).resolved).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Releases                                                                   */
/* -------------------------------------------------------------------------- */

describe("releases", () => {
  function releaseRepo() {
    const dir = makeRepo({ "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2) + "\n", "ROADMAP.md": "# Demo\n\n## Now\n\n- [x] Old {#r0}\n- [ ] New {#r1}\n" });
    g(dir, "config", "user.email", "t@t");
    g(dir, "config", "user.name", "t");
    g(dir, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "feat(deploy): targets");
    fs.writeFileSync(path.join(dir, "a.txt"), "2");
    g(dir, "commit", "-am", "fix: rollback label");
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), "# Demo\n\n## Now\n\n- [x] Old {#r0}\n- [x] New {#r1}\n");
    g(dir, "commit", "-am", "docs: check the roadmap");
    return dir;
  }

  test("a plan lists the commits and the roadmap items checked since the tag, and writes nothing", () => {
    const dir = releaseRepo();
    const before = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    const plan = planRelease(dir, "minor", { date: "2026-10-28" });
    expect(plan).toMatchObject({ fromTag: "v1.0.0", current: "1.0.0", version: "1.1.0", tag: "v1.1.0" });
    expect(plan.commits.map((c) => c.type)).toEqual(["docs", "fix", "feat"]);
    expect(plan.roadmap).toEqual([{ id: "r1", title: "New" }]);
    expect(plan.changelog).toContain("### Added\n- **deploy:** targets");
    expect(plan.changelog).toContain("### Roadmap\n- New");
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).toBe(before);
  });

  test("a cut writes the version and the changelog, commits them, and tags the commit", () => {
    const dir = releaseRepo();
    const r = cutRelease(dir, "minor", { date: "2026-10-28" });
    expect(r.tag).toBe("v1.1.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.1.0");
    expect(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")).toMatch(/^# Changelog\n\n## 1\.1\.0 - 2026-10-28/);
    expect(g(dir, "log", "-1", "--format=%s")).toBe("chore(release): v1.1.0");
    expect(g(dir, "rev-parse", "v1.1.0^{commit}")).toBe(g(dir, "rev-parse", "HEAD"));
    expect(g(dir, "status", "--porcelain")).toBe("");

    // A second cut builds on the first one's section and tag.
    fs.writeFileSync(path.join(dir, "b.txt"), "x");
    g(dir, "add", "-A");
    g(dir, "commit", "-m", "fix: small thing");
    cutRelease(dir, "patch", { date: "2026-10-29" });
    const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8");
    expect(log.indexOf("## 1.1.1")).toBeLessThan(log.indexOf("## 1.1.0"));
  });

  test("a cut refuses a dirty tree and an existing tag, and changes nothing", () => {
    const dir = releaseRepo();
    fs.writeFileSync(path.join(dir, "scratch.txt"), "unrelated work");
    expect(() => cutRelease(dir, "patch")).toThrow(/Commit or stash/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).version).toBe("1.0.0");
    fs.rmSync(path.join(dir, "scratch.txt"));
    g(dir, "tag", "v1.0.1");
    expect(() => cutRelease(dir, "patch")).toThrow(/already exists/);
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP routes (called directly; server.ts registers deployRoutes)            */
/* -------------------------------------------------------------------------- */

async function call(method: string, url: string, body: Record<string, any> = {}): Promise<Response | null> {
  const u = new URL(url, "http://daemon.test");
  return deployRoutes(makeCtx(new Request(u, { method }), u, body));
}

describe("routes", () => {
  test("target, run, history and plan over HTTP", async () => {
    const { id } = workspace();
    const made = await call("POST", "/api/deploy/targets", { root: id, env: "dev", provider: "command", config: { argv: say("https://route.example.test") } });
    expect(made!.status).toBe(201);
    const { target } = (await made!.json()) as { target: { id: string } };

    const list = (await (await call("GET", `/api/deploy/targets?root=${id}`))!.json()) as { targets: Array<{ env: string }> };
    expect(list.targets.map((t) => t.env)).toEqual(["dev"]);

    const ran = await call("POST", `/api/deploy/targets/${target.id}/run`);
    expect(ran!.status).toBe(202);
    const { deploy } = (await ran!.json()) as { deploy: { id: string } };
    await waitDeploy(deploy.id);

    const one = (await (await call("GET", `/api/deploys/${deploy.id}`))!.json()) as { deploy: { status: string; url: string } };
    expect(one.deploy).toMatchObject({ status: "succeeded", url: "https://route.example.test" });
    const hist = (await (await call("GET", `/api/deploys?target=${target.id}`))!.json()) as { deploys: unknown[] };
    expect(hist.deploys.length).toBe(1);

    const plan = (await (await call("POST", `/api/release/${id}`, { bump: "minor" }))!.json()) as { plan: { version: string } };
    expect(plan.plan.version).toBe("1.1.0");
    await expect(call("POST", `/api/release/${id}`, { bump: "huge" })).rejects.toThrow(HttpError);
  });

  test("history needs a target or a root, and other paths are left to the next module", async () => {
    await expect(call("GET", "/api/deploys")).rejects.toThrow(/Pass target/);
    expect(await call("GET", "/api/roadmap/w_x")).toBeNull();
  });
});

describe("web pipeline logic", () => {
  const d = (over: Partial<Deploy>): Deploy => ({ id: "dp", target_id: "t", kind: "deploy", status: "succeeded", git_sha: null, version: null, url: "https://a", provider_deploy_id: null, log_tail: "", started_at: "2026-10-28 10:00:00", finished_at: null, ...over });

  test("environments read dev, staging, prod, then the rest", () => {
    expect(orderTargets([{ env: "prod" }, { env: "qa" }, { env: "dev" }, { env: "staging" }]).map((t) => t.env)).toEqual(["dev", "staging", "prod", "qa"]);
  });

  test("the live deploy is the newest success, and rollback needs an earlier, different one", () => {
    const newest = d({ id: "b", url: "https://b" });
    const older = d({ id: "a", url: "https://a" });
    expect(liveOf([newest, older])?.id).toBe("b");
    expect(canRollback([newest, older])).toBe(true);
    expect(canRollback([d({ id: "a", url: "https://a" }), d({ id: "b", url: "https://a" })])).toBe(false);
    expect(canRollback([d({ status: "failed" })])).toBe(false);
  });

  test("a stored UTC time is read as UTC", () => {
    expect(formatWhen("2026-10-28 10:00:00")).toBe(formatWhen("2026-10-28T10:00:00Z"));
    expect(formatWhen(null)).toBe("");
  });
});

describe("an orphaned deploys table", () => {
  test("from before spec 114 is left alone, and history goes to deploy_runs", async () => {
    const prev = process.env.TRB_HOME;
    process.env.TRB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trb-deploy-legacy-"));
    closeDb();
    try {
      db().exec("CREATE TABLE deploys (id TEXT PRIMARY KEY, legacy TEXT)");
      db().exec("INSERT INTO deploys (id, legacy) VALUES ('old', 'x')");
      const { id } = workspace();
      const t = createTarget({ workspaceId: id, env: "dev", provider: "command", config: { argv: say("https://legacy.example.test") } });
      const d = runDeploy(t.id);
      await waitDeploy(d.id);
      expect(getDeploy(d.id)!.status).toBe("succeeded");
      expect(listDeploys({ targetId: t.id }).map((x) => x.id)).toEqual([d.id]);
      expect(db().prepare("SELECT legacy FROM deploys").all()).toEqual([{ legacy: "x" }]);
    } finally {
      closeDb();
      process.env.TRB_HOME = prev;
    }
  });
});
