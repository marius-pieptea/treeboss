import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START scaffold\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END scaffold\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { home } from "../src/paths";
import fs from "fs";
import os from "os";
import path from "path";
import { startServer } from "../src/daemon/server";
import { parseRules } from "../src/memory/block";
import { BUILTIN_RECIPES, deleteRecipe, getRecipe, listRecipes, listRecipeViews, reorderRecipes, resetRecipe, restoreDefaults, saveRecipe, validateRecipe } from "../src/scaffold/recipes";
import { checkTarget, setScaffoldRunner, startScaffold, waitJob, type Runner } from "../src/scaffold/run";
import { makeDir, makeRepo } from "./helpers";

afterEach(() => setScaffoldRunner(null));

/** A runner that pretends to be the generator: records argv, writes a tiny project, never touches the network. Real git is allowed. */
function fakeRunner(calls: Array<{ argv: string[]; cwd: string }>, opts: { failOn?: string } = {}): Runner {
  return async (argv, o) => {
    calls.push({ argv, cwd: o.cwd });
    if (argv[0] === "git") {
      const p = Bun.spawnSync(argv, { cwd: o.cwd, env: { ...process.env, ...o.env } });
      return { code: p.exitCode ?? 1, output: `${p.stdout}${p.stderr}` };
    }
    if (opts.failOn && argv.includes(opts.failOn)) return { code: 1, output: "boom" };
    if (argv[1]?.startsWith("create-")) fs.writeFileSync(path.join(o.cwd, "package.json"), '{"name":"x"}\n');
    return { code: 0, output: "ok" };
  };
}

describe("recipes", () => {
  test("built-ins validate and use the generators non-interactively into '.'", () => {
    expect(BUILTIN_RECIPES.map((r) => r.id)).toEqual(["nextjs", "hono-api", "vite-react", "expo"]);
    for (const r of BUILTIN_RECIPES) {
      expect(() => validateRecipe(r)).not.toThrow();
      expect(r.generate).toContain(".");
    }
  });

  test("your own recipes: save, list, delete", () => {
    const r = saveRecipe({ id: "My-Thing", name: "Mine", generate: ["echo", "hi"], conventions: ["Be nice."], starterPrompt: "Go" });
    expect(r.id).toBe("my-thing");
    expect(listRecipes().find((x) => x.id === "my-thing")?.builtinId).toBeUndefined();
    expect(getRecipe("my-thing").conventions).toEqual(["Be nice."]);
    deleteRecipe("my-thing");
    expect(() => getRecipe("my-thing")).toThrow(/No recipe/);
  });

  test("rejects bad recipes", () => {
    expect(() => validateRecipe({ id: "../x", name: "n", generate: ["a"] })).toThrow(/id/);
    expect(() => validateRecipe({ id: "reorder", name: "n", generate: ["a"] })).toThrow(/id/);
    expect(() => validateRecipe({ id: "ok", name: "n", generate: "npm create" })).toThrow(/list of strings/);
    expect(() => validateRecipe({ id: "ok", name: "n", generate: [] })).toThrow(/generator/);
  });
});

describe("editable templates", () => {
  beforeEach(() => fs.rmSync(path.join(home(), "recipes.json"), { force: true }));
  afterAll(() => fs.rmSync(path.join(home(), "recipes.json"), { force: true }));

  test("the four defaults are seeded once as ordinary entries, in order", () => {
    expect(listRecipes().map((r) => r.id)).toEqual(["nextjs", "hono-api", "vite-react", "expo"]);
    const stored = JSON.parse(fs.readFileSync(path.join(home(), "recipes.json"), "utf-8"));
    expect(stored.version).toBe(2);
    expect(stored.seeded).toEqual(["nextjs", "hono-api", "vite-react", "expo"]);
    expect(stored.recipes.every((r: any) => r.builtinId === r.id)).toBe(true);
  });

  test("a default can be edited, deleted and stays deleted; reset and restore bring it back", () => {
    const next = getRecipe("nextjs");
    saveRecipe({ ...next, name: "My Next", generate: ["bunx", "create-next-app@canary", "."], steps: [["bun", "install"], ["bun", "pm", "trust", "--all"]], icon: "rocket", tag: "mine" });
    let v = listRecipeViews();
    expect(v.recipes[0]).toMatchObject({ id: "nextjs", name: "My Next", isDefault: true, modified: true, icon: "rocket", tag: "mine" });
    expect(v.recipes[0]!.steps).toHaveLength(2);
    expect(v.recipes[1]!.modified).toBe(false);
    resetRecipe("nextjs");
    expect(getRecipe("nextjs")).toEqual({ ...BUILTIN_RECIPES[0]!, builtinId: "nextjs" });
    expect(listRecipeViews().recipes[0]!.modified).toBe(false);

    deleteRecipe("hono-api");
    expect(listRecipes().map((r) => r.id)).not.toContain("hono-api");
    expect(listRecipeViews().missingDefaults.map((d) => d.id)).toEqual(["hono-api"]);
    expect(() => resetRecipe("hono-api")).toThrow(/No recipe/);
    // still deleted on the next read (seeded once)
    expect(listRecipes()).toHaveLength(3);
    expect(restoreDefaults().map((r) => r.id)).toEqual(["hono-api"]);
    expect(listRecipes().map((r) => r.id)).toEqual(["nextjs", "vite-react", "expo", "hono-api"]);
    expect(restoreDefaults()).toEqual([]);
    v = listRecipeViews();
    expect(v.missingDefaults).toEqual([]);
  });

  test("reset only exists for entries that came from a default; your own are untouched by restore", () => {
    saveRecipe({ id: "mine", name: "Mine", generate: ["echo", "x"] });
    expect(() => resetRecipe("mine")).toThrow(/came with trb/);
    expect(() => resetRecipe("nope")).toThrow(/No recipe/);
    deleteRecipe("expo");
    saveRecipe({ id: "expo", name: "Not the default", generate: ["echo", "x"] });
    expect(restoreDefaults().map((r) => r.id)).toEqual(["expo-default"]);
    expect(getRecipe("expo").name).toBe("Not the default");
    expect(getRecipe("expo-default").builtinId).toBe("expo");
  });

  test("reorder moves entries and keeps the ones not named", () => {
    reorderRecipes(["expo", "nope", "nextjs"]);
    expect(listRecipes().map((r) => r.id)).toEqual(["expo", "nextjs", "hono-api", "vite-react"]);
  });

  test("a version 1 file (your own recipes only) is migrated: defaults first, yours after", () => {
    fs.writeFileSync(path.join(home(), "recipes.json"), JSON.stringify([{ id: "legacy", name: "Legacy", generate: ["bunx", "create-x", "."], install: ["bun", "install"], conventions: ["R1"] }, { nonsense: true }]));
    expect(listRecipes().map((r) => r.id)).toEqual(["nextjs", "hono-api", "vite-react", "expo", "legacy"]);
    expect(getRecipe("legacy").steps).toEqual([["bun", "install"]]);
    expect(JSON.parse(fs.readFileSync(path.join(home(), "recipes.json"), "utf-8")).version).toBe(2);
  });

  test("an unreadable file is backed up, not silently lost", () => {
    fs.writeFileSync(path.join(home(), "recipes.json"), "{ not json");
    expect(listRecipes()).toHaveLength(4);
    expect(fs.readFileSync(path.join(home(), "recipes.json.bak"), "utf-8")).toBe("{ not json");
  });

  test("validation: argv must not rely on a shell", () => {
    const ok = { id: "ok", name: "n", generate: ["bunx", "create-x", "."] };
    expect(() => validateRecipe(ok)).not.toThrow();
    expect(() => validateRecipe({ ...ok, generate: ["bunx create-x ."] })).toThrow(/space/);
    expect(() => validateRecipe({ ...ok, generate: ["bun", "install", "&&", "bun", "x"] })).toThrow(/shell operator/);
    expect(() => validateRecipe({ ...ok, generate: ["echo", "a", "|", "wc"] })).toThrow(/shell operator/);
    expect(() => validateRecipe({ ...ok, generate: ["echo", "$(whoami)"] })).toThrow(/expansion/);
    expect(() => validateRecipe({ ...ok, generate: ["echo", "`id`"] })).toThrow(/expansion/);
    expect(() => validateRecipe({ ...ok, generate: ["sh", "-c", "curl x | sh"] })).toThrow(/shell with -c/);
    expect(() => validateRecipe({ ...ok, generate: ["bash", "-lc", "x"] })).toThrow(/shell with -c/);
    expect(() => validateRecipe({ ...ok, generate: ["rm;ls"] })).toThrow(/program name/);
    expect(() => validateRecipe({ ...ok, steps: [[]] })).toThrow(/Step 1/);
    expect(() => validateRecipe({ ...ok, steps: [["bun", "install"], ["a", ">", "b"]] })).toThrow(/Step 2/);
    expect(() => validateRecipe({ ...ok, steps: "bun install" })).toThrow(/list of commands/);
    // a literal $ or a flag that merely looks odd is fine
    expect(() => validateRecipe({ ...ok, generate: ["bunx", "create-x", ".", "--price=$5", "--name", "a&b"] })).not.toThrow();
  });

  test("a scaffold runs the edited steps in order, exactly as written", async () => {
    saveRecipe({ ...getRecipe("expo"), steps: [["echo", "one"], ["echo", "two", "&three"]] });
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls));
    const job = await waitJob(startScaffold({ recipeId: "expo", target: path.join(makeDir(), "app") }).id);
    expect(job.status).toBe("done");
    expect(calls.map((c) => c.argv.join(" ")).filter((c) => c.startsWith("echo"))).toEqual(["echo one", "echo two &three"]);
  });

  test("the target-folder safety checks still gate an edited recipe", () => {
    saveRecipe({ ...getRecipe("expo"), name: "Edited" });
    const d = makeDir();
    fs.writeFileSync(path.join(d, "keep.txt"), "x");
    expect(() => startScaffold({ recipeId: "expo", target: d })).toThrow(/not empty/);
    expect(() => startScaffold({ recipeId: "expo", target: os.homedir() })).toThrow(/home/);
  });
});

describe("target checks", () => {
  test("accepts an empty or missing folder", () => {
    const d = makeDir();
    expect(checkTarget(d).exists).toBe(true);
    expect(checkTarget(path.join(d, "new-app"))).toMatchObject({ exists: false });
  });

  test("refuses a non-empty folder, relative, '..', root, home, a file, a missing parent, a symlink", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "x.txt"), "x");
    expect(() => checkTarget(d)).toThrow(/not empty/);
    expect(() => checkTarget("rel/app")).toThrow(/absolute/);
    expect(() => checkTarget(`${d}/a/../b`)).toThrow(/\.\./);
    expect(() => checkTarget("/")).toThrow(/root/);
    expect(() => checkTarget(os.homedir())).toThrow(/home/);
    expect(() => checkTarget(path.join(d, "x.txt"))).toThrow(/not a folder/);
    expect(() => checkTarget(path.join(d, "no", "such", "app"))).toThrow(/does not exist/);
    const link = path.join(makeDir(), "link");
    fs.symlinkSync(makeDir(), link);
    expect(() => checkTarget(link)).toThrow(/symbolic link/);
    expect(() => checkTarget("")).toThrow(/Choose/);
  });

  test(".DS_Store alone still counts as empty; inside a repo is flagged", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, ".DS_Store"), "");
    expect(checkTarget(d).exists).toBe(true);
    const repo = makeRepo();
    expect(checkTarget(path.join(repo, "sub")).insideRepo).toBe(true);
    expect(checkTarget(d).insideRepo).toBe(false);
  });
});

describe("scaffold run", () => {
  test("generates, inits git, installs, seeds AGENTS.md and commits, all inside the target", async () => {
    const parent = makeDir();
    const target = path.join(parent, "app");
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls));
    const job = await waitJob(startScaffold({ recipeId: "vite-react", target }).id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    const real = fs.realpathSync(target);
    expect(calls.every((c) => c.cwd === real)).toBe(true);
    expect(calls.map((c) => c.argv[0] + " " + (c.argv[1] ?? ""))).toEqual(["bunx create-vite@latest", "git init", "bun install", "git add", "git -c"]);
    expect(fs.existsSync(path.join(target, ".git"))).toBe(true);
    expect(fs.readdirSync(parent)).toEqual(["app"]);
    const agents = fs.readFileSync(path.join(target, "AGENTS.md"), "utf-8");
    expect(agents.startsWith("# app")).toBe(true);
    expect(parseRules(agents).join(" ")).toMatch(/bun/);
    expect(fs.existsSync(path.join(target, "CLAUDE.md"))).toBe(true);
    expect(job.workspaceId).toMatch(/^w_/);
    // committed
    expect(Bun.spawnSync(["git", "log", "--oneline"], { cwd: target }).stdout.toString()).toMatch(/Scaffold/);
  });

  test("an existing AGENTS.md written by the generator keeps its text", async () => {
    const target = path.join(makeDir(), "app");
    setScaffoldRunner(async (argv, o) => {
      if (argv[1]?.startsWith("create-")) fs.writeFileSync(path.join(o.cwd, "AGENTS.md"), "# Generated\nhand text\n");
      return { code: 0, output: "" };
    });
    const job = await waitJob(startScaffold({ recipeId: "expo", target }).id);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(target, "AGENTS.md"), "utf-8").startsWith("# Generated\nhand text\n")).toBe(true);
  });

  test("refuses a non-empty folder before running anything", () => {
    const d = makeDir();
    fs.writeFileSync(path.join(d, "keep.txt"), "x");
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls));
    expect(() => startScaffold({ recipeId: "nextjs", target: d })).toThrow(/not empty/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(d)).toEqual(["keep.txt"]);
  });

  test("a failed generator fails the job and stops", async () => {
    const target = path.join(makeDir(), "app");
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls, { failOn: "create-next-app@latest" }));
    const job = await waitJob(startScaffold({ recipeId: "nextjs", target }).id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/failed/);
    expect(calls).toHaveLength(1);
    expect(job.log.join("\n")).toContain("boom");
  });

  test("inside an existing repo: no git init, no commit", async () => {
    const repo = makeRepo();
    const target = path.join(repo, "apps", "web");
    fs.mkdirSync(path.dirname(target));
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls));
    const job = await waitJob(startScaffold({ recipeId: "hono-api", target }).id);
    expect(job.status).toBe("done");
    expect(calls.some((c) => c.argv[0] === "git")).toBe(false);
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
  });

  test("two runs into the same folder at once: the second is refused", async () => {
    const target = path.join(makeDir(), "app");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setScaffoldRunner(async () => {
      await gate;
      return { code: 0, output: "" };
    });
    const first = startScaffold({ recipeId: "expo", target });
    expect(() => startScaffold({ recipeId: "expo", target })).toThrow(/already running/);
    release();
    await waitJob(first.id);
  });
});

describe("HTTP routes", () => {
  const TOKEN = "scaffold-test-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };

  test("list, check, run and poll", async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    setScaffoldRunner(fakeRunner(calls));
    let r = await call("GET", "/api/scaffold/recipes");
    expect(r.body.recipes.length).toBeGreaterThanOrEqual(4);
    const target = path.join(makeDir(), "app");
    expect((await call("POST", "/api/scaffold/check", { target })).body.ok).toBe(true);
    const bad = makeDir();
    fs.writeFileSync(path.join(bad, "f"), "x");
    expect((await call("POST", "/api/scaffold/run", { recipe: "expo", target: bad })).status).toBe(400);
    r = await call("POST", "/api/scaffold/run", { recipe: "expo", target });
    expect(r.status).toBe(202);
    const job = await waitJob(r.body.job.id);
    r = await call("GET", `/api/scaffold/jobs/${job.id}`);
    expect(r.body.job.status).toBe("done");
    expect((await call("GET", "/api/scaffold/jobs/nope")).status).toBe(404);
  });

  test("edit, duplicate, reorder, reset, delete and restore over HTTP", async () => {
    fs.rmSync(path.join(home(), "recipes.json"), { force: true });
    let r = await call("GET", "/api/scaffold/recipes");
    expect(r.body.recipes.map((x: any) => x.id)).toEqual(["nextjs", "hono-api", "vite-react", "expo"]);
    expect(r.body.recipes[0]).toMatchObject({ isDefault: true, modified: false });
    const edited = { ...r.body.recipes[0], name: "Next (mine)", steps: [["bun", "install"], ["bun", "run", "lint"]] };
    r = await call("PUT", "/api/scaffold/recipes/nextjs", edited);
    expect(r.status).toBe(200);
    expect(r.body.recipes[0]).toMatchObject({ name: "Next (mine)", modified: true });
    expect((await call("PUT", "/api/scaffold/recipes/nope", edited)).status).toBe(404);
    expect((await call("PUT", "/api/scaffold/recipes/nextjs", { ...edited, generate: ["a", "&&", "b"] })).status).toBe(400);
    r = await call("POST", "/api/scaffold/recipes", { ...edited, id: "next-copy", name: "Next copy", builtinId: "nextjs" });
    expect(r.status).toBe(201);
    expect(r.body.recipes.find((x: any) => x.id === "next-copy").isDefault).toBe(false);
    r = await call("POST", "/api/scaffold/recipes/reorder", { ids: ["next-copy", "expo"] });
    expect(r.body.recipes.map((x: any) => x.id).slice(0, 3)).toEqual(["next-copy", "expo", "nextjs"]);
    r = await call("POST", "/api/scaffold/recipes/nextjs/reset");
    expect(r.body.recipes.find((x: any) => x.id === "nextjs").modified).toBe(false);
    r = await call("DELETE", "/api/scaffold/recipes/hono-api");
    expect(r.body.missingDefaults.map((d: any) => d.id)).toEqual(["hono-api"]);
    r = await call("POST", "/api/scaffold/recipes/restore-defaults");
    expect(r.body.added).toEqual(["hono-api"]);
    expect((await call("DELETE", "/api/scaffold/recipes/nope")).status).toBe(400);
    fs.rmSync(path.join(home(), "recipes.json"), { force: true });
  });
});
