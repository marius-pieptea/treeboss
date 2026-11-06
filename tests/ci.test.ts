/** CI workflow generation, the gh wrappers, the session-to-PR flow and its routes. gh is replaced by a scripted runner. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { ciRoutes } from "../src/daemon/routes/ci";
import { makeCtx } from "../src/daemon/http";
import { bucketOf, prBodyFor, prChecks, prCreate, prMerge, prNumberOf, prView, listWorkspacePrs, PrError, refreshPr, rollupChecks, sessionToPr, setGhRunner, waitForChecks, type CheckRun, type GhResult, type GhRunner } from "../src/ci/pr";
import { detectInputs, planWorkflow, renderWorkflow, writeWorkflow, WORKFLOW_PATH } from "../src/ci/workflow";
import { UserError } from "../src/util";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, sh } from "./helpers";

const ok = (stdout = "", stderr = ""): GhResult => ({ code: 0, stdout, stderr });
const fail = (code: number, stderr: string, stdout = ""): GhResult => ({ code, stdout, stderr });

/** Write a fixture folder: a map of workspace-relative file to content. */
function fixture(files: Record<string, string>): string {
  const dir = makeDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** Every `run:` of the verify job, in order, parsed from the generated YAML. */
function runsOf(yaml: string, job = "verify"): string[] {
  const doc = Bun.YAML.parse(yaml) as any;
  return (doc.jobs[job].steps as any[]).filter((s) => typeof s.run === "string").map((s) => s.run.trim());
}

describe("workflow: detection", () => {
  test("a bun project: bun install, the bun scripts, a Playwright job", () => {
    const dir = fixture({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "bun test" } }),
      "bun.lock": "{}\n",
      "playwright.config.ts": "export default {};\n",
    });
    const plan = planWorkflow(dir);
    expect(plan.path).toBe(WORKFLOW_PATH);
    expect(plan.exists).toBe(false);
    expect(plan.inputs.packageManager).toBe("bun");
    expect(plan.inputs.lockfile).toBe("bun.lock");
    expect(plan.inputs.verify.map((v) => v.name)).toEqual(["typecheck", "lint", "test"]);

    expect(runsOf(plan.yaml)).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run lint", "bun run test"]);
    expect(runsOf(plan.yaml, "e2e")).toEqual(["bun install --frozen-lockfile", "bunx playwright install --with-deps chromium", "bunx playwright test"]);
    expect(plan.yaml).toContain("uses: oven-sh/setup-bun@v2");
    expect(plan.yaml).toContain("hashFiles('bun.lock')");
  });

  test("npm, pnpm and yarn pick their own install, cache and runner", () => {
    const npm = fixture({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" });
    const pnpm = fixture({ "package.json": JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc" } }), "pnpm-lock.yaml": "" });
    const yarn = fixture({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" });

    const n = planWorkflow(npm);
    expect(n.inputs.packageManager).toBe("npm");
    expect(runsOf(n.yaml)).toEqual(["npm ci", "npm run test"]);
    expect(n.yaml).toContain("cache: npm");
    expect(n.yaml).not.toContain("e2e:");

    const p = planWorkflow(pnpm);
    expect(p.inputs.packageManager).toBe("pnpm");
    expect(runsOf(p.yaml)).toEqual(["pnpm install --frozen-lockfile", "pnpm run typecheck", "pnpm run test"]);
    expect(p.yaml).toContain("pnpm/action-setup@v4");

    const y = planWorkflow(yarn);
    expect(y.inputs.packageManager).toBe("yarn");
    expect(runsOf(y.yaml)).toEqual(["yarn install --frozen-lockfile", "yarn run test"]);
  });

  test("a placeholder npm test script is not a test command", () => {
    const dir = fixture({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }) });
    expect(detectInputs(dir).verify.map((v) => v.name)).toEqual(["lint"]);
  });

  test("Cargo, Go and Python each bring their toolchain and their commands", () => {
    const rust = planWorkflow(fixture({ "Cargo.toml": "[package]\nname = \"x\"\n", "Cargo.lock": "" }));
    expect(runsOf(rust.yaml)).toEqual(["cargo check --quiet", "cargo test --quiet"]);
    expect(rust.yaml).toContain("dtolnay/rust-toolchain@stable");
    expect(rust.yaml).toContain("hashFiles('Cargo.lock')");
    expect(rust.inputs.packageManager).toBeNull();

    const go = planWorkflow(fixture({ "go.mod": "module x\n" }));
    expect(runsOf(go.yaml)).toEqual(["go vet ./...", "go test ./..."]);
    expect(go.yaml).toContain("go-version-file: go.mod");

    const py = planWorkflow(
      fixture({
        "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\n",
        "requirements.txt": "requests\n",
      }),
    );
    // The pip install is a run too; the verify commands come last.
    expect(runsOf(py.yaml).slice(-2)).toEqual(["ruff check .", "python3 -m pytest -q"]);
    expect(py.yaml).toContain("python -m pip install -r requirements.txt");
    expect(py.yaml).toContain("python -m pip install -e .");
  });

  test("a folder with nothing to verify is refused, not turned into a green CI", () => {
    expect(() => planWorkflow(fixture({ "README.md": "# nothing\n" }))).toThrow(UserError);
  });

  test("the generated YAML parses and every run line is a detected command", () => {
    const dir = fixture({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }), "bun.lock": "{}", "playwright.config.js": "" });
    const yaml = renderWorkflow(detectInputs(dir));
    const doc = Bun.YAML.parse(yaml) as any;
    expect(Object.keys(doc.jobs)).toEqual(["verify", "e2e"]);
    expect(doc.jobs.verify["runs-on"]).toBe("ubuntu-latest");
    expect(yaml.startsWith("# Generated by `trb ci init`")).toBe(true);
  });
});

describe("workflow: writing", () => {
  test("writes .github/workflows/ci.yml and refuses to replace it unless asked", () => {
    const dir = fixture({ "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "{}" });
    const first = writeWorkflow(dir);
    expect(first.path).toBe(WORKFLOW_PATH);
    expect(fs.readFileSync(path.join(dir, WORKFLOW_PATH), "utf-8")).toBe(first.plan.yaml);

    expect(planWorkflow(dir).exists).toBe(true);
    expect(() => writeWorkflow(dir)).toThrow(/already exists/);

    fs.writeFileSync(path.join(dir, WORKFLOW_PATH), "name: mine\n");
    writeWorkflow(dir, { overwrite: true });
    expect(fs.readFileSync(path.join(dir, WORKFLOW_PATH), "utf-8")).toContain("name: CI");
  });
});

describe("pr: the gh wrappers", () => {
  let calls: Array<{ args: string[]; cwd: string; stdin?: string }> = [];
  let answer: (args: string[]) => GhResult | null = () => ok();
  const runner: GhRunner = async (args, cwd, stdin) => {
    calls.push({ args, cwd, stdin });
    return answer(args);
  };
  beforeAll(() => setGhRunner(runner));
  afterAll(() => setGhRunner(null));
  afterEach(() => {
    calls = [];
    answer = () => ok();
  });

  test("prCreate passes the body on stdin and reads the number from the URL", async () => {
    answer = () => ok("https://github.com/acme/app/pull/42\n");
    const r = await prCreate("/repo", { title: "Add greeting", body: "## Summary\nhi", base: "main", head: "trb/x/abc", draft: true });
    expect(r).toEqual({ number: 42, url: "https://github.com/acme/app/pull/42" });
    expect(calls[0]!.args).toEqual(["pr", "create", "--title=Add greeting", "--body-file=-", "--base=main", "--head=trb/x/abc", "--draft"]);
    expect(calls[0]!.stdin).toBe("## Summary\nhi");
    expect(calls[0]!.cwd).toBe("/repo");
  });

  test("a missing gh is a 412 with the install hint; a signed-out gh is a 412 with the login hint", async () => {
    answer = () => null;
    const missing = await prView("/repo", 1).catch((e) => e);
    expect(missing).toBeInstanceOf(PrError);
    expect(missing.status).toBe(412);
    expect(missing.message).toContain("cli.github.com");

    answer = () => fail(4, "To get started with GitHub CLI, please run:  gh auth login\n");
    const out = await prView("/repo", 1).catch((e) => e);
    expect(out.status).toBe(412);
    expect(out.message).toContain("not signed in");
  });

  test("a gh that is not on PATH is reported as missing, not thrown", async () => {
    setGhRunner(null);
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      const err = await prChecks("/repo", 3).catch((e) => e);
      expect(err.status).toBe(412);
      expect(err.message).toContain("not found");
    } finally {
      process.env.PATH = saved;
      setGhRunner(runner);
    }
  });

  test("prView normalises the state and reads the merge state", async () => {
    answer = () =>
      ok(
        JSON.stringify({
          number: 7,
          title: "T",
          url: "https://github.com/acme/app/pull/7",
          state: "OPEN",
          isDraft: false,
          headRefName: "trb/x/1",
          baseRefName: "main",
          updatedAt: "2026-10-28T10:00:00Z",
          mergeStateStatus: "CLEAN",
          additions: 3,
          deletions: 1,
          changedFiles: 2,
        }),
      );
    const pr = await prView("/repo", 7);
    expect(pr).toMatchObject({ number: 7, state: "open", head: "trb/x/1", base: "main", mergeState: "CLEAN", additions: 3, changedFiles: 2 });
  });

  test("prChecks parses the JSON even when gh exits non-zero for pending checks", async () => {
    answer = () =>
      fail(8, "", JSON.stringify([
        { name: "verify", state: "SUCCESS", bucket: "pass", link: "https://x/1", workflow: "CI" },
        { name: "e2e", state: "IN_PROGRESS", bucket: "pending", link: null, workflow: "CI" },
      ]));
    const checks = await prChecks("/repo", 9);
    expect(checks.map((c) => [c.name, c.bucket])).toEqual([
      ["verify", "pass"],
      ["e2e", "pending"],
    ]);
    expect(rollupChecks(checks)).toBe("pending");
  });

  test("prChecks reports no checks as an empty list, and derives the bucket when gh omits it", async () => {
    answer = () => fail(1, "no checks reported on the 'trb/x/1' branch\n");
    expect(await prChecks("/repo", 9)).toEqual([]);

    answer = () => ok(JSON.stringify([{ name: "lint", state: "FAILURE" }]));
    const [c] = await prChecks("/repo", 9);
    expect(c!.bucket).toBe("fail");
    expect(rollupChecks([c!])).toBe("failing");
  });

  test("the checks rollup: failing beats pending beats passing", () => {
    const run = (bucket: CheckRun["bucket"]): CheckRun => ({ name: bucket, bucket, state: bucket, link: null, workflow: null });
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks([run("pass"), run("skipping")])).toBe("passing");
    expect(rollupChecks([run("pass"), run("pending")])).toBe("pending");
    expect(rollupChecks([run("pending"), run("fail")])).toBe("failing");
    expect(rollupChecks([run("cancel")])).toBe("failing");
    expect(bucketOf("TIMED_OUT")).toBe("fail");
    expect(bucketOf("QUEUED")).toBe("pending");
  });

  test("prMerge merges a passing PR with the method and branch option", async () => {
    answer = (args) => {
      if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number: 5, title: "T", url: "u", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main" }));
      if (args[1] === "checks") return ok(JSON.stringify([{ name: "a", state: "SUCCESS", bucket: "pass" }]));
      return ok();
    };
    expect(await prMerge("/repo", 5, { method: "rebase", deleteBranch: true })).toEqual({ number: 5, method: "rebase" });
    const merge = calls.find((c) => c.args[1] === "merge")!;
    expect(merge.args).toEqual(["pr", "merge", "5", "--rebase", "--delete-branch"]);
  });

  test("prMerge refuses failing checks and closed PRs, and never calls merge", async () => {
    answer = (args) => {
      if (args[1] === "view") return ok(JSON.stringify({ number: 5, title: "T", url: "u", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main" }));
      return ok(JSON.stringify([{ name: "a", state: "FAILURE", bucket: "fail" }]));
    };
    const red = await prMerge("/repo", 5).catch((e) => e);
    expect(red.status).toBe(409);
    expect(calls.some((c) => c.args[1] === "merge")).toBe(false);

    answer = () => ok(JSON.stringify({ number: 5, title: "T", url: "u", state: "MERGED", isDraft: false, headRefName: "h", baseRefName: "main" }));
    const closed = await prMerge("/repo", 5).catch((e) => e);
    expect(closed.status).toBe(409);
    expect(closed.message).toContain("merged");
  });

  test("waitForChecks polls until the checks settle, and reports a timeout", async () => {
    let n = 0;
    answer = (args) => {
      if (args[1] !== "checks") return ok();
      n++;
      return ok(JSON.stringify([{ name: "a", state: n < 2 ? "IN_PROGRESS" : "SUCCESS", bucket: n < 2 ? "pending" : "pass" }]));
    };
    const settled = await waitForChecks("/repo", 5, 10, { intervalSec: 1 });
    expect(settled).toMatchObject({ state: "passing", timedOut: false });

    answer = (args) => (args[1] === "checks" ? ok(JSON.stringify([{ name: "a", state: "IN_PROGRESS", bucket: "pending" }])) : ok());
    const stuck = await waitForChecks("/repo", 5, 1, { intervalSec: 1 });
    expect(stuck).toMatchObject({ state: "pending", timedOut: true });
  });

  test("prNumberOf and the PR body", () => {
    expect(prNumberOf("https://github.com/acme/app/pull/123")).toBe(123);
    expect(prNumberOf("https://github.com/acme/app/issues/1")).toBeNull();
    const body = prBodyFor({ id: "s_1", branch: "trb/x/1" } as any, "", null);
    expect(body).toContain("No turn has finished yet.");
    expect(body).toContain("No changes against the starting commit yet.");
    expect(prBodyFor({ id: "s_1", branch: "trb/x/1" } as any, "Done.", { files: 2, insertions: 10, deletions: 1 })).toContain("2 files changed, +10 -1");
  });
});

describe("pr: sessions and the table", () => {
  let repo: string;
  let bare: string;
  let wsId: string;
  const sessions: string[] = [];
  let calls: Array<{ args: string[]; stdin?: string }> = [];
  let checks: string = "[]";
  let listed: string = "[]";
  const runner: GhRunner = async (args, _cwd, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/acme/app/pull/88\n");
    if (args[0] === "pr" && args[1] === "view") return ok(JSON.stringify({ number: 88, title: "Add greeting", url: "https://github.com/acme/app/pull/88", state: "OPEN", isDraft: false, headRefName: "x", baseRefName: "main", updatedAt: "2026-10-28T10:00:00Z" }));
    if (args[0] === "pr" && args[1] === "checks") return ok(checks);
    if (args[0] === "pr" && args[1] === "list") return ok(listed);
    return ok();
  };

  beforeAll(() => {
    setGhRunner(runner);
    repo = makeRepo({ "a.txt": "one\n" });
    bare = makeDir();
    fs.rmSync(bare, { recursive: true, force: true });
    sh(`git init -q --bare "${bare.replace(/\\/g, "/")}"`, repo);
    sh(`git remote add origin "${bare.replace(/\\/g, "/")}"`, repo);
    wsId = Workspaces.open(repo).id;
  });
  afterAll(() => {
    setGhRunner(null);
    for (const id of sessions) {
      db().prepare("DELETE FROM turns WHERE session_id = ?").run(id);
      db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    }
    db().prepare("DELETE FROM session_prs WHERE workspace_id = ?").run(wsId);
  });
  afterEach(() => {
    calls = [];
    checks = "[]";
    listed = "[]";
  });

  /** A session that ran in its own worktree and committed one change, with one completed turn. */
  function worktreeSession(title: string): string {
    const id = `s_${Math.random().toString(16).slice(2, 12).padEnd(10, "0")}`;
    const wt = makeDir();
    fs.rmSync(wt, { recursive: true, force: true });
    const base = sh("git rev-parse HEAD", repo);
    const branch = `trb/${title.toLowerCase().replace(/\W+/g, "-")}/${id.slice(2, 8)}`;
    sh(`git worktree add -q -b ${branch} "${wt.replace(/\\/g, "/")}" HEAD`, repo);
    fs.writeFileSync(path.join(wt, "greet.txt"), "hello\n");
    sh("git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm feat", wt);
    db()
      .prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd, isolation, worktree_root, worktree_git_root, branch, base_sha, status) VALUES (?, ?, ?, 'claude', ?, ?, 'worktree', ?, ?, ?, ?, 'idle')")
      .run(id, title, id, wt, repo, wt, repo, branch, base);
    db()
      .prepare("INSERT INTO turns (id, session_id, seq, prompt, status, output) VALUES (?, ?, 1, 'add greeting', 'completed', 'Added greet.txt with a hello line.')")
      .run(`t_${id}`, id);
    sessions.push(id);
    return id;
  }

  test("sessionToPr pushes the branch, opens the PR from the session, and remembers it", async () => {
    const id = worktreeSession("Add greeting");
    const r = await sessionToPr(id, { draft: false });
    expect(r.created).toBe(true);
    expect(r.pr).toMatchObject({ workspaceId: wsId, number: 88, sessionId: id, state: "open", checksState: "none" });

    const { branch } = db().prepare("SELECT branch FROM sessions WHERE id = ?").get(id) as { branch: string };
    expect(branch).toStartWith("trb/add-greeting/");
    expect(sh(`git ls-remote --heads origin ${branch}`, repo)).toContain(`refs/heads/${branch}`);

    const create = calls.find((c) => c.args[1] === "create")!;
    expect(create.args).toContain("--title=Add greeting");
    expect(create.args).toContain(`--head=${branch}`);
    expect(create.stdin).toContain("Added greet.txt with a hello line.");
    expect(create.stdin).toContain("1 file changed, +1 -0");
  });

  test("a session with an open PR gets that PR back, not a second one", async () => {
    const id = worktreeSession("Second try");
    await sessionToPr(id);
    calls = [];
    const again = await sessionToPr(id);
    expect(again.created).toBe(false);
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  test("a session without its own branch is refused", async () => {
    const id = `s_plain${Math.random().toString(16).slice(2, 8)}`;
    db().prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd, isolation, status) VALUES (?, 'plain', ?, 'claude', ?, ?, 'none', 'idle')").run(id, id, repo, repo);
    sessions.push(id);
    const err = await sessionToPr(id).catch((e) => e);
    expect(err).toBeInstanceOf(PrError);
    expect(err.message).toContain("no branch of its own");
  });

  test("refreshPr brings the checks state up to date in the table", async () => {
    const id = worktreeSession("Checks please");
    await sessionToPr(id);
    checks = JSON.stringify([{ name: "verify", state: "SUCCESS", bucket: "pass" }]);
    const r = await refreshPr(wsId, 88);
    expect(r.pr.checksState).toBe("passing");
    expect(r.checks).toHaveLength(1);
    expect(r.pr.sessionId).toBe(id);
  });

  test("listWorkspacePrs joins the session each PR came from", async () => {
    const id = worktreeSession("Listed");
    await sessionToPr(id);
    listed = JSON.stringify([
      { number: 88, title: "Add greeting", url: "u", state: "OPEN", isDraft: false, headRefName: "x", baseRefName: "main", updatedAt: null },
      { number: 5, title: "Hand made", url: "u5", state: "OPEN", isDraft: true, headRefName: "y", baseRefName: "main", updatedAt: null },
    ]);
    const prs = await listWorkspacePrs(wsId, "open");
    expect(prs.find((p) => p.number === 88)).toMatchObject({ sessionId: id, state: "open", draft: false });
    expect(prs.find((p) => p.number === 5)).toMatchObject({ sessionId: null, checksState: null, draft: true });
  });
});

describe("ci routes", () => {
  let repo: string;
  let wsId: string;
  beforeAll(() => {
    repo = fixture({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }), "bun.lock": "{}" });
    wsId = Workspaces.open(repo).id;
    setGhRunner(async (args) => (args[1] === "list" ? ok(JSON.stringify([{ number: 3, title: "t", url: "u", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main" }])) : ok()));
  });
  afterAll(() => setGhRunner(null));

  const call = async (method: string, url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const u = new URL(`http://127.0.0.1${url}`);
    return (await ciRoutes(makeCtx(new Request(u, { method }), u, body)))!;
  };

  test("POST /api/ci/:ws/workflow plans without writing, and writes on write", async () => {
    const planned = (await call("POST", `/api/ci/${wsId}/workflow`)) as Response;
    expect(planned.status).toBe(200);
    const body = (await planned.json()) as any;
    expect(body.plan.inputs.verify.map((v: any) => v.name)).toEqual(["lint"]);
    expect(fs.existsSync(path.join(repo, WORKFLOW_PATH))).toBe(false);

    const written = (await call("POST", `/api/ci/${wsId}/workflow`, { write: true })) as Response;
    expect(written.status).toBe(201);
    expect(fs.existsSync(path.join(repo, WORKFLOW_PATH))).toBe(true);

    const again = await call("POST", `/api/ci/${wsId}/workflow`, { write: true }).catch((e) => e);
    expect(again).toBeInstanceOf(UserError);
    expect(again.message).toContain("already exists");
  });

  test("GET /api/prs needs a workspace and returns its open PRs", async () => {
    const missing = await call("GET", "/api/prs").catch((e) => e);
    expect(missing.status).toBe(400);
    const res = (await call("GET", `/api/prs?workspace=${wsId}`)) as Response;
    expect((await res.json()).prs[0]).toMatchObject({ number: 3, state: "open" });
  });

  test("the merge route rejects an unknown method before calling gh", async () => {
    const err = await call("POST", `/api/prs/${wsId}/3/merge`, { method: "fast-forward" }).catch((e) => e);
    expect(err.status).toBe(400);
  });
});

describe("workflow: a Playwright config in a subfolder", () => {
  const inputs = {
    packageManager: "bun" as const,
    lockfile: "bun.lock",
    cargo: false,
    go: false,
    python: false,
    pythonProject: false,
    requirements: false,
    playwright: "playwright.config.ts" as string | null,
    verify: [{ name: "test", cmd: "bun run test" }],
  };
  const e2eSteps = (yaml: string) => (Bun.YAML.parse(yaml) as any).jobs.e2e.steps as any[];

  test("both Playwright steps run in the config's folder, and nothing else in the workflow does", () => {
    const yaml = renderWorkflow({ ...inputs, playwright: "apps/web/playwright.config.ts" });
    const steps = e2eSteps(yaml);
    const playwright = steps.filter((s) => /playwright/.test(s.run ?? ""));
    expect(playwright.map((s) => [s.run.trim(), s["working-directory"]])).toEqual([
      ["bunx playwright install --with-deps chromium", "apps/web"],
      ["bunx playwright test", "apps/web"],
    ]);
    expect(yaml.match(/working-directory/g)).toHaveLength(2);
    expect(((Bun.YAML.parse(yaml) as any).jobs.verify.steps as any[]).some((s) => "working-directory" in s)).toBe(false);
  });

  test("a config at the root adds no working-directory, so the workflow is the one it always was", () => {
    const yaml = renderWorkflow(inputs);
    expect(yaml).not.toContain("working-directory");
    expect(yaml).toBe(renderWorkflow({ ...inputs, playwright: "./playwright.config.ts" }));
  });
});
