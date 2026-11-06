import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { home } from "../src/paths";
import { startServer } from "../src/daemon/server";
import type { TurnResult } from "../src/engines/runner";
import { getSetting, setSetting } from "../src/settings";
import { interruptAll, setTurnRunner } from "../src/sessions/manager";
import { parseRules } from "../src/memory/block";
import { BUILTIN_SYSTEMS } from "../src/design/builtins";
import { CONTRACT_NAMES, DESIGN_RULE, parseTokens } from "../src/design/contract";
import { deleteSystem, getSystem, idFor, listSystems, listSystemViews, reorderSystems, resetSystem, restoreDefaults, saveSystem, validateSystem } from "../src/design/library";
import { applySystem, DesignConflict, readDesign, saveToLibrary, writeSystem } from "../src/design/workspace";
import { designPrompt, startDesign } from "../src/design/sessions";
import { setScaffoldRunner, startScaffold, waitJob, type Runner } from "../src/scaffold/run";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState, settled } from "./helpers";

const TOKEN = "design-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });
const LIB = () => path.join(home(), "design-systems.json");
const IDS = ["neutral", "editorial", "bold", "soft"];

beforeEach(() => fs.rmSync(LIB(), { force: true }));
afterAll(() => fs.rmSync(LIB(), { force: true }));

describe("token contract", () => {
  test("every shipped system sets every contract token, light and dark", () => {
    for (const s of BUILTIN_SYSTEMS) {
      const t = parseTokens(s.tokens);
      expect(t.missing).toEqual([]);
      expect(t.colors.length).toBe(13);
      expect(t.colors.every((c) => c.dark && c.dark !== "")).toBe(true);
      expect(t.fonts.map((f) => f.name)).toEqual(["--font-sans", "--font-display", "--font-mono"]);
      expect(s.design).toContain(`# ${s.name} design system`);
      for (const n of CONTRACT_NAMES) expect(s.design).toContain(`\`${n}\``);
    }
  });

  test("parses light and dark scopes, comments, and reports missing names", () => {
    const t = parseTokens(`/* --color-ignored: red; */
:root { --color-bg: #fff; --brand: oklch(0.7 0.1 200); --font-sans: Inter, sans-serif; --radius-md: 6px; --space-1: 4px }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --color-bg: #000; } }
.card { --color-bg: blue; }`);
    expect(t.colors).toEqual([
      { name: "--color-bg", light: "#fff", dark: "#000" },
      { name: "--brand", light: "oklch(0.7 0.1 200)", dark: null },
    ]);
    expect(t.fonts).toEqual([{ name: "--font-sans", value: "Inter, sans-serif" }]);
    expect(t.radii).toEqual([{ name: "--radius-md", value: "6px" }]);
    expect(t.count).toBe(5);
    expect(t.missing).toContain("--color-primary");
    expect(t.missing).not.toContain("--color-bg");
    expect(parseTokens("").missing.length).toBe(CONTRACT_NAMES.length);
  });

  test("the agent rule fits a memory rule", () => {
    expect(DESIGN_RULE.length).toBeLessThanOrEqual(400);
  });
});

describe("library", () => {
  test("the four defaults are seeded once, in order, and stay deleted", () => {
    expect(listSystems().map((s) => s.id)).toEqual(IDS);
    deleteSystem("bold");
    expect(listSystems().map((s) => s.id)).toEqual(["neutral", "editorial", "soft"]);
    expect(listSystemViews().missingDefaults).toEqual([{ id: "bold", name: "Bold" }]);
    expect(restoreDefaults().map((s) => s.id)).toEqual(["bold"]);
    expect(listSystemViews().missingDefaults).toEqual([]);
  });

  test("edit, modified flag, reset, and your own systems", () => {
    const n = getSystem("neutral");
    saveSystem({ ...n, name: "Mine" });
    expect(listSystemViews().systems[0]).toMatchObject({ id: "neutral", name: "Mine", isDefault: true, modified: true });
    resetSystem("neutral");
    expect(listSystemViews().systems[0]).toMatchObject({ name: "Neutral", modified: false });
    const s = saveSystem({ id: "Acme", name: "Acme", design: "# Acme", tokens: ":root{--color-bg:#fff}", builtinId: "neutral" });
    expect(s).toMatchObject({ id: "acme", design: "# Acme\n" });
    expect(s.builtinId).toBeUndefined(); // only seeding links an entry to a default
    expect(() => resetSystem("acme")).toThrow(/came with trb/);
    reorderSystems(["acme", "soft"]);
    expect(listSystems().map((x) => x.id)).toEqual(["acme", "soft", "neutral", "editorial", "bold"]);
    expect(listSystemViews().systems[0]!.summary.colors[0]).toMatchObject({ name: "--color-bg", light: "#fff" });
  });

  test("validation", () => {
    expect(() => validateSystem({ id: "../x", name: "n", design: "# x" })).toThrow(/id/);
    expect(() => validateSystem({ id: "reorder", name: "n", design: "# x" })).toThrow(/id/);
    expect(() => validateSystem({ id: "ok", name: "", design: "# x" })).toThrow(/name/);
    expect(() => validateSystem({ id: "ok", name: "n", design: "  " })).toThrow(/DESIGN\.md/);
    expect(() => validateSystem({ id: "ok", name: "n", design: "# x", tokens: "a".repeat(100_001) })).toThrow(/tokens\.css/);
    expect(validateSystem({ id: "ok", name: "n", design: "# x\r\n" }).design).toBe("# x\n");
  });

  test("an unreadable file is backed up, not silently lost", () => {
    fs.writeFileSync(LIB(), "{ nope");
    expect(listSystems()).toHaveLength(4);
    expect(fs.readFileSync(`${LIB()}.bak`, "utf-8")).toBe("{ nope");
  });

  test("ids from names are free and valid", () => {
    expect(idFor("My Brand!", [])).toBe("my-brand");
    expect(idFor("My Brand", ["my-brand", "my-brand-2"])).toBe("my-brand-3");
    expect(idFor("***", [])).toBe("system");
    expect(idFor("reorder", [])).toBe("reorder-1");
  });
});

describe("a project's design", () => {
  test("looking writes nothing; applying writes both files and the agent rule", () => {
    const dir = makeRepo();
    expect(readDesign(dir)).toMatchObject({ exists: false, path: "DESIGN.md", rev: "none", agentRule: false, matches: null, tokens: { exists: false, summary: null } });
    expect(fs.existsSync(path.join(dir, "DESIGN.md"))).toBe(false);
    const s = applySystem(dir, "editorial");
    expect(s).toMatchObject({ exists: true, title: "Editorial design system", agentRule: true, matches: "editorial", tokens: { path: "design/tokens.css", exists: true } });
    expect(s.tokens.summary!.missing).toEqual([]);
    expect(parseRules(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8"))).toContain(DESIGN_RULE);
    // The rule goes in once.
    applySystem(dir, "soft", true);
    expect(parseRules(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).filter((r) => r === DESIGN_RULE)).toHaveLength(1);
  });

  test("never replaces files unless asked, and a stale rev is a conflict", () => {
    const dir = makeRepo({ "DESIGN.md": "# Ours\n" });
    expect(() => applySystem(dir, "neutral")).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(dir, "DESIGN.md"), "utf-8")).toBe("# Ours\n");
    const rev = readDesign(dir).rev;
    fs.writeFileSync(path.join(dir, "DESIGN.md"), "# Ours, edited\n");
    expect(() => applySystem(dir, "neutral", true, rev)).toThrow(DesignConflict);
    const now = applySystem(dir, "neutral", true, readDesign(dir).rev);
    expect(now.matches).toBe("neutral");
    // Edited by hand: no longer matches the library entry.
    fs.appendFileSync(path.join(dir, "DESIGN.md"), "\nOne more rule.\n");
    expect(readDesign(dir).matches).toBeNull();
  });

  test("refuses to write through a symlink that leaves the project", () => {
    const dir = makeRepo();
    const outside = makeDir();
    fs.symlinkSync(outside, path.join(dir, "design"));
    expect(() => writeSystem(dir, getSystem("neutral"))).toThrow(/outside the project/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("save to library copies the project's files under a free id", () => {
    const dir = makeRepo();
    applySystem(dir, "bold");
    fs.appendFileSync(path.join(dir, "DESIGN.md"), "\nProject rule.\n");
    const s = saveToLibrary(dir, { name: "", description: "for the launch" });
    expect(s).toMatchObject({ id: "bold-2", name: "Bold", description: "for the launch" }); // "bold" is the library's own
    expect(s.design).toContain("Project rule.");
    expect(s.tokens).toBe(getSystem("bold").tokens);
    expect(saveToLibrary(dir, { name: "Bold" }).id).toBe("bold-3");
    expect(() => saveToLibrary(makeRepo(), { name: "x" })).toThrow(/no DESIGN\.md/);
  });
});

describe("design sessions", () => {
  beforeEach(() => {
    resetState();
    setTurnRunner(null);
  });
  afterEach(async () => {
    await interruptAll();
    setTurnRunner(null);
  });

  test("prompts carry the contract and refuse bad input", () => {
    const p = designPrompt("brief", "A habit tracker for students; playful but focused", { exists: false, brainstorm: false });
    expect(p).toContain("A habit tracker for students");
    expect(p).toContain("Create DESIGN.md at the project root and design/tokens.css");
    expect(p).toContain("`--color-primary`");
    expect(p).toContain("4.5:1");
    expect(designPrompt("url", "https://example.com", { exists: true })).toContain("ORIGINAL system");
    expect(designPrompt("url", "https://example.com", { exists: true })).toContain("already has DESIGN.md");
    expect(designPrompt("codebase", "", { exists: false })).toContain('"Drift" section');
    expect(designPrompt("wire", "", { exists: true })).toContain("Import design/tokens.css once");
    expect(designPrompt("review", "the settings page", { exists: true })).toContain("Focus: the settings page");
    expect(() => designPrompt("brief", " ", { exists: false })).toThrow(/Describe/);
    expect(() => designPrompt("url", "example.com", { exists: false })).toThrow(/URL/);
  });

  test("a brief session adds the rule and sends the prompt; wire needs a DESIGN.md", async () => {
    const dir = makeRepo();
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("wrote it")));
    expect(() => startDesign(dir, "wire", { engine: "fake" })).toThrow(/no DESIGN\.md/);
    expect(() => startDesign(dir, "nope" as any, { engine: "fake" })).toThrow(/Unknown/);
    const s = startDesign(dir, "brief", { engine: "fake", input: "A CRM for florists", brainstorm: false });
    await settled(s.id);
    expect(s.title).toBe("Design system from a brief");
    expect(prompts[0]).toContain("A CRM for florists");
    expect(readDesign(dir).agentRule).toBe(true);
  });
});

describe("brainstorm and critique", () => {
  beforeEach(() => {
    resetState();
    setTurnRunner(null);
  });
  afterEach(async () => {
    await interruptAll();
    setTurnRunner(null);
  });

  test("a brief brainstorm asks and proposes directions, and writes the files only after the pick", () => {
    const p = designPrompt("brief", "A booking app for yoga studios", { exists: false, brainstorm: true });
    expect(p).toContain("do NOT write DESIGN.md or design/tokens.css yet");
    expect(p).toContain("At most five questions");
    expect(p).toContain("Write design/directions.html");
    expect(p).toContain("Quiet product");
    expect(p).toContain("When the user replies with a pick");
    expect(p).toContain("Then delete design/directions.html");
    expect(p).toContain("`--color-primary`"); // the contract is in context for the second turn
    expect(p).toContain("**Restraint**");
  });

  test("a reference brainstorm extracts real values and stays original", () => {
    const p = designPrompt("url", "https://example.com", { exists: false, brainstorm: true });
    expect(p).toContain("Extract, never guess");
    expect(p).toContain("Make A close to the reference's feel");
    expect(p).toContain("Do not copy the reference's logo");
    expect(p).not.toContain("Quiet product");
  });

  test("one-shot generation and review carry the critique and the anti-generic list; codebase never brainstorms", () => {
    const one = designPrompt("brief", "A CRM", { exists: false, brainstorm: false });
    expect(one).not.toContain("directions.html");
    expect(one).toContain("**Hierarchy**");
    expect(one).toContain("violet gradient");
    expect(designPrompt("url", "https://example.com", { exists: false })).toContain("Extract, never guess");
    expect(designPrompt("codebase", "", { exists: false, brainstorm: true })).not.toContain("directions.html");
    const review = designPrompt("review", "", { exists: true });
    expect(review).toContain("**Specificity**");
    expect(review).toContain("End with the scores");
  });

  test("start brainstorms brief and url by default", async () => {
    const dir = makeRepo();
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("A, B or C?")));
    const s = startDesign(dir, "brief", { engine: "fake", input: "A CRM for florists" });
    await settled(s.id);
    expect(s.title).toBe("Design system from a brief (brainstorm)");
    expect(prompts[0]).toContain("do NOT write DESIGN.md");
  });

  test("the directions page is part of the design state", () => {
    const dir = makeRepo();
    expect(readDesign(dir).directions).toEqual({ path: "design/directions.html", exists: false, html: null, tooLarge: false });
    fs.mkdirSync(path.join(dir, "design"));
    fs.writeFileSync(path.join(dir, "design/directions.html"), "<h1>A</h1>");
    expect(readDesign(dir).directions).toMatchObject({ exists: true, html: "<h1>A</h1>" });
    fs.writeFileSync(path.join(dir, "design/directions.html"), "x".repeat(400_001));
    expect(readDesign(dir).directions).toMatchObject({ exists: true, html: null, tooLarge: true });
  });
});

describe("scaffold with a design system", () => {
  afterEach(() => setScaffoldRunner(null));
  const runner: Runner = async (argv, o) => {
    if (argv[0] === "git") {
      const p = Bun.spawnSync(argv, { cwd: o.cwd, env: { ...process.env, ...o.env } });
      return { code: p.exitCode ?? 1, output: `${p.stdout}${p.stderr}` };
    }
    if (argv[1]?.startsWith("create-")) fs.writeFileSync(path.join(o.cwd, "package.json"), '{"name":"x"}\n');
    return { code: 0, output: "ok" };
  };

  test("writes DESIGN.md and tokens.css into the first commit, with the rule", async () => {
    setScaffoldRunner(runner);
    const target = path.join(makeDir(), "app");
    const job = await waitJob(startScaffold({ recipeId: "vite-react", target, designSystem: "soft" }).id);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(target, "DESIGN.md"), "utf-8")).toBe(getSystem("soft").design);
    expect(fs.existsSync(path.join(target, "design/tokens.css"))).toBe(true);
    expect(parseRules(fs.readFileSync(path.join(target, "AGENTS.md"), "utf-8"))).toContain(DESIGN_RULE);
    const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: target }).stdout.toString();
    expect(tracked).toContain("DESIGN.md");
    expect(tracked).toContain("design/tokens.css");
  });

  test("none writes nothing; an unknown system is refused before anything runs", async () => {
    setScaffoldRunner(runner);
    const target = path.join(makeDir(), "app");
    expect(() => startScaffold({ recipeId: "vite-react", target, designSystem: "nope" })).toThrow(/No design system/);
    expect(fs.existsSync(target)).toBe(false);
    const job = await waitJob(startScaffold({ recipeId: "vite-react", target }).id);
    expect(job.status).toBe("done");
    expect(fs.existsSync(path.join(target, "DESIGN.md"))).toBe(false);
  });
});

describe("HTTP routes", () => {
  let srv: ReturnType<typeof startServer>;
  let dir: string;
  let root: string;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  beforeEach(() => {
    dir = makeRepo();
    root = Workspaces.open(dir).id;
  });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  test("library CRUD", async () => {
    expect((await fetch(`${srv.url}/api/design/systems`)).status).toBe(401);
    let r = await call("GET", "/api/design/systems");
    expect(r.data.systems.map((s: any) => s.id)).toEqual(IDS);
    expect(r.data.systems[0].summary.colors.length).toBe(13);
    r = await call("POST", "/api/design/systems", { id: "acme", name: "Acme", design: "# Acme" });
    expect(r.status).toBe(201);
    r = await call("PUT", "/api/design/systems/acme", { name: "Acme 2", design: "# Acme 2" });
    expect(r.data.system).toMatchObject({ id: "acme", name: "Acme 2" });
    expect((await call("PUT", "/api/design/systems/ghost", { name: "x", design: "# x" })).status).toBe(404);
    r = await call("POST", "/api/design/systems/reorder", { ids: ["acme"] });
    expect(r.data.systems[0].id).toBe("acme");
    r = await call("DELETE", "/api/design/systems/neutral");
    expect(r.data.missingDefaults).toEqual([{ id: "neutral", name: "Neutral" }]);
    r = await call("POST", "/api/design/systems/restore-defaults");
    expect(r.data.added).toEqual(["neutral"]);
    expect((await call("POST", "/api/design/systems", { id: "bad id", name: "x", design: "# x" })).status).toBe(400);
  });

  test("a project's design: look, apply, conflict, save to library", async () => {
    let r = await call("GET", `/api/design/${root}`);
    expect(r.data.design).toMatchObject({ exists: false });
    r = await call("POST", `/api/design/${root}/apply`, { system: "bold" });
    expect(r.data.design).toMatchObject({ exists: true, matches: "bold", agentRule: true });
    expect((await call("POST", `/api/design/${root}/apply`, { system: "soft" })).status).toBe(400);
    expect((await call("POST", `/api/design/${root}/apply`, { system: "soft", overwrite: true, rev: "stale" })).status).toBe(409);
    r = await call("POST", `/api/design/${root}/apply`, { system: "soft", overwrite: true, rev: r.data.design.rev });
    expect(r.data.design.matches).toBe("soft");
    r = await call("POST", `/api/design/${root}/save-to-library`, { name: "Launch" });
    expect(r.status).toBe(201);
    expect(r.data.system.id).toBe("launch");
    expect(r.data.systems.some((s: any) => s.id === "launch")).toBe(true);
    expect((await call("POST", `/api/design/${root}/start`, { kind: "url", input: "not a url", engine: "fake" })).status).toBe(400);
    setTurnRunner(async () => ok("done"));
    r = await call("POST", `/api/design/${root}/start`, { kind: "brief", input: "A CRM", engine: "fake", brainstorm: false });
    expect(r.status).toBe(201);
    expect(r.data.session.title).toBe("Design system from a brief");
    await settled(r.data.session.id);
    setTurnRunner(null);
  });

  test("design turns from the composer: the session routes take a design field", async () => {
    // REA is on by default and its hint leads a conversation's first prompt. This test checks where the design block sits, so REA is off here.
    const prevRea = getSetting("rea_mcp");
    setSetting("rea_mcp", "off");
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("A, B or C?")));
    const body = { prompt: "A CRM for florists", cwd: dir, engine: "fake", mode: "plan", design: { kind: "brief" } };
    expect((await fetch(`${srv.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
    let r = await call("POST", "/api/sessions", body);
    expect(r.status).toBe(201);
    expect(r.data.session).toMatchObject({ title: "Design system from a brief (brainstorm)", mode: "build" });
    const id = r.data.session.id;
    await settled(id);
    expect(prompts[0]!.startsWith("A CRM for florists\n\n<!-- trb:instructions Design · brief · brainstorm -->\n")).toBe(true);
    expect(prompts[0]).toContain("do NOT write DESIGN.md");
    expect(readDesign(dir).agentRule).toBe(true);

    // Into the same thread: review needs a DESIGN.md first, and an empty message gets a visible line.
    expect((await call("POST", `/api/sessions/${id}/send`, { message: "", design: { kind: "review" } })).status).toBe(400);
    applySystem(dir, "neutral");
    r = await call("POST", `/api/sessions/${id}/send`, { message: "", design: { kind: "review" } });
    expect(r.status).toBe(200);
    await settled(id);
    expect(prompts[1]!.startsWith("Review the UI against the design system.\n\n<!-- trb:instructions Design · review -->")).toBe(true);
    r = await call("POST", "/api/sessions", { prompt: "", cwd: dir, engine: "fake", design: { kind: "brief" } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Describe/);
    setTurnRunner(null);
    setSetting("rea_mcp", prevRea);
  });

  test("scaffold run passes the design system through", async () => {
    setScaffoldRunner(async (argv, o) => {
      if (argv[0] === "git") {
        const p = Bun.spawnSync(argv, { cwd: o.cwd, env: { ...process.env, ...o.env } });
        return { code: p.exitCode ?? 1, output: "" };
      }
      return { code: 0, output: "ok" };
    });
    const target = path.join(makeDir(), "app");
    const r = await call("POST", "/api/scaffold/run", { recipe: "nextjs", target, designSystem: "editorial" });
    expect(r.status).toBe(202);
    const job = await waitJob(r.data.job.id);
    setScaffoldRunner(null);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(target, "DESIGN.md"), "utf-8")).toContain("# Editorial design system");
  });
});
