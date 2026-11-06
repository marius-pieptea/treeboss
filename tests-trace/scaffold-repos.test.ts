import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START scaffold-repos\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END scaffold-repos\n"); });
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { home } from "../src/paths";
import { normalizeGithubUrl, saveRecipe, validateRecipe } from "../src/scaffold/recipes";
import { cloneArgv, repoBrief, setScaffoldRunner, startScaffold, waitJob, type Runner } from "../src/scaffold/run";
import { makeDir } from "./helpers";

beforeEach(() => fs.rmSync(path.join(home(), "recipes.json"), { force: true }));
afterEach(() => setScaffoldRunner(null));
afterAll(() => fs.rmSync(path.join(home(), "recipes.json"), { force: true }));

/** Stands in for `git clone` (never the network) and for the generator; every other git call is real. */
function fakeRunner(calls: string[][], opts: { failClone?: string } = {}): Runner {
  return async (argv, o) => {
    calls.push(argv);
    if (argv[0] === "git" && argv.includes("clone")) {
      const url = argv[argv.length - 2]!;
      const dest = path.resolve(o.cwd, argv[argv.length - 1]!);
      if (opts.failClone && url.includes(opts.failClone)) return { code: 128, output: "fatal: repository not found" };
      fs.mkdirSync(path.join(dest, ".git"), { recursive: true }); // the clone's own history, which must not survive
      fs.writeFileSync(path.join(dest, ".git", "HEAD"), "ref: refs/heads/upstream\n");
      fs.writeFileSync(path.join(dest, "README.md"), `# from ${url}\n`);
      fs.writeFileSync(path.join(dest, "index.ts"), "export {};\n");
      return { code: 0, output: "cloned" };
    }
    if (argv[0] === "git") {
      const p = Bun.spawnSync(argv, { cwd: o.cwd, env: { ...process.env, ...o.env } });
      return { code: p.exitCode ?? 1, output: `${p.stdout}${p.stderr}` };
    }
    if (argv[1]?.startsWith("create-")) fs.writeFileSync(path.join(o.cwd, "package.json"), '{"name":"x"}\n');
    return { code: 0, output: "ok" };
  };
}

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

describe("GitHub URLs", () => {
  test("owner/repo, host/owner/repo and full URLs become the canonical https URL", () => {
    for (const x of ["acme/starter", "github.com/acme/starter", "https://github.com/acme/starter", "https://github.com/acme/starter.git", "https://www.github.com/acme/starter/", " Acme/starter "]) {
      expect(normalizeGithubUrl(x).toLowerCase()).toBe("https://github.com/acme/starter");
    }
    expect(normalizeGithubUrl("acme/my.repo_1-x")).toBe("https://github.com/acme/my.repo_1-x");
  });

  test("other hosts, ssh, credentials, paths and option-looking values are refused", () => {
    for (const x of ["https://gitlab.com/acme/starter", "git@github.com:acme/starter.git", "ssh://git@github.com/acme/starter", "https://user:pw@github.com/acme/starter", "https://github.com/acme/starter/tree/main", "http://github.com.evil.io/a/b", "example.com/a", "--upload-pack=x/y", "acme", "", "file:///etc/passwd", "acme/..", "-x/y"]) {
      expect(() => normalizeGithubUrl(x), x).toThrow();
    }
  });
});

describe("recipes with repos", () => {
  const base = { id: "mine", name: "Mine", generate: ["bunx", "create-x", "."] };

  test("references sit beside a generator; the ref and note are kept", () => {
    const r = validateRecipe({ ...base, repos: [{ url: "acme/docs", ref: "v2", role: "reference", note: "see the auth module" }] });
    expect(r.repos).toEqual([{ url: "https://github.com/acme/docs", ref: "v2", role: "reference", note: "see the auth module" }]);
  });

  test("a recipe without repos carries no repos field at all", () => {
    expect("repos" in validateRecipe(base)).toBe(false);
  });

  test("a starter repo replaces the generator, and cannot be combined with one", () => {
    const r = validateRecipe({ id: "s", name: "S", repos: [{ url: "acme/starter", role: "starter" }] });
    expect(r.generate).toEqual([]);
    expect(() => validateRecipe({ ...base, repos: [{ url: "acme/starter", role: "starter" }] })).toThrow(/not both/);
    expect(() => validateRecipe({ id: "s", name: "S" })).toThrow(/generator command, or a starter/);
  });

  test("bad repos are refused", () => {
    const bad = (repos: unknown) => () => validateRecipe({ ...base, repos });
    expect(bad([{ url: "acme/a", role: "starter" }, { url: "acme/b", role: "starter" }])).toThrow(/only one starter/);
    expect(bad([{ url: "acme/a", role: "nope" }])).toThrow(/starter or a reference/);
    expect(bad([{ url: "https://gitlab.com/a/b", role: "reference" }])).toThrow(/not a GitHub/);
    expect(bad([{ url: "acme/a", role: "reference", ref: "--upload-pack=x" }])).toThrow(/branch or tag/);
    expect(bad([{ url: "acme/a", role: "reference", ref: "a..b" }])).toThrow(/branch or tag/);
    expect(bad("acme/a")).toThrow(/list/);
    expect(bad(Array.from({ length: 7 }, (_, i) => ({ url: `acme/r${i}`, role: "reference" })))).toThrow(/at most 6/);
  });

  test("the same repo twice in one role is kept once", () => {
    expect(validateRecipe({ ...base, repos: [{ url: "acme/a", role: "reference" }, { url: "https://github.com/acme/a.git", role: "reference" }] }).repos).toHaveLength(1);
  });
});

describe("cloning", () => {
  test("the clone command is shallow, hook-free, prompt-free and cannot read the URL as an option", () => {
    const argv = cloneArgv({ url: "https://github.com/acme/starter", ref: "main", role: "starter" }, ".");
    expect(argv.slice(0, 5)).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
    expect(argv).toContain("--depth");
    expect(argv).toContain("--no-recurse-submodules");
    expect(argv).toContain("--no-tags");
    expect(argv.indexOf("--")).toBe(argv.length - 3);
    expect(argv.slice(argv.indexOf("--branch"), argv.indexOf("--branch") + 2)).toEqual(["--branch", "main"]);
    expect(cloneArgv({ url: "https://github.com/a/b", role: "reference" }, "x")).not.toContain("--branch");
  });
});

describe("scaffolding with repos", () => {
  test("a starter repo is the base: no generator runs, upstream history is dropped, the project gets its own", async () => {
    saveRecipe({ id: "from-repo", name: "From repo", repos: [{ url: "acme/starter", ref: "main", role: "starter", note: "keep the folder layout" }], steps: [], conventions: ["Be tidy."] });
    const calls: string[][] = [];
    setScaffoldRunner(fakeRunner(calls));
    const dir = path.join(makeDir(), "app");
    const job = await waitJob(startScaffold({ recipeId: "from-repo", target: dir }).id);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toContain("https://github.com/acme/starter");
    expect(calls.some((c) => c[1] === "-c" && c.includes("clone"))).toBe(true);
    expect(calls.some((c) => c[1]?.startsWith("create-"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".git", "HEAD")) && fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf-8")).not.toContain("upstream");
    expect(git(dir, "log", "--format=%s")).toBe("Scaffold From repo app");
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("## Where this started");
    expect(agents).toContain("Started from https://github.com/acme/starter (main). keep the folder layout");
  });

  test("a reference repo is cloned inside the project, git-ignored, without its own .git, and named in AGENTS.md", async () => {
    saveRecipe({ id: "with-ref", name: "With ref", generate: ["bunx", "create-x", "."], steps: [], repos: [{ url: "acme/design-system", role: "reference", note: "use its Button" }] });
    setScaffoldRunner(fakeRunner([]));
    const dir = path.join(makeDir(), "app");
    const job = await waitJob(startScaffold({ recipeId: "with-ref", target: dir }).id);
    expect(job.status).toBe("done");
    const ref = path.join(dir, ".reference", "acme-design-system");
    expect(fs.readFileSync(path.join(ref, "README.md"), "utf-8")).toContain("acme/design-system");
    expect(fs.existsSync(path.join(ref, ".git"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toMatch(/^\.reference\/$/m);
    expect(git(dir, "ls-files")).not.toContain(".reference");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toContain("`.reference/acme-design-system`");
  });

  test("a reference that cannot be fetched is logged and skipped, not fatal, and not promised to the agent", async () => {
    saveRecipe({ id: "ref-missing", name: "Ref missing", generate: ["bunx", "create-x", "."], steps: [], repos: [{ url: "acme/gone", role: "reference" }, { url: "acme/here", role: "reference" }] });
    setScaffoldRunner(fakeRunner([], { failClone: "acme/gone" }));
    const dir = path.join(makeDir(), "app");
    const job = await waitJob(startScaffold({ recipeId: "ref-missing", target: dir }).id);
    expect(job.status).toBe("done");
    expect(job.log.join("\n")).toContain("continuing");
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("acme-here");
    expect(agents).not.toContain("acme-gone");
  });

  test("a starter that cannot be fetched fails the job and leaves nothing half-built behind a success", async () => {
    saveRecipe({ id: "bad-starter", name: "Bad", steps: [], repos: [{ url: "acme/gone", role: "starter" }] });
    setScaffoldRunner(fakeRunner([], { failClone: "acme/gone" }));
    const job = await waitJob(startScaffold({ recipeId: "bad-starter", target: path.join(makeDir(), "app") }).id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/failed/);
  });
});

describe("the read-first brief", () => {
  test("empty when no repos are attached", () => {
    expect(repoBrief(undefined, [])).toBe("");
  });

  test("names the starter and each reference with their hints, and asks for a summary first", () => {
    const b = repoBrief({ url: "https://github.com/acme/starter", ref: "v1", role: "starter", note: "start at src/app" }, [{ url: "https://github.com/acme/ui", role: "reference", note: "copy its tokens" }]);
    expect(b).toContain("Before you change anything, read");
    expect(b).toContain("began as a copy of https://github.com/acme/starter (v1)");
    expect(b).toContain("Hint: start at src/app");
    expect(b).toContain(".reference/acme-ui");
    expect(b).toContain("Hint: copy its tokens");
    expect(b).toContain("say in a few bullets");
    expect(b.endsWith("\n\n")).toBe(true);
  });
});
