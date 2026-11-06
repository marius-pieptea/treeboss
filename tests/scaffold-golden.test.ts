import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { home } from "../src/paths";
import { EXPO_APP, GOLDEN_RECIPES, SAAS_MONOREPO, SAAS_NEXT } from "../src/scaffold/golden";
import { detectInputs, planWorkflow, WORKFLOW_PATH } from "../src/ci/workflow";
import { checklistById } from "../src/checklists/custom";
import { packById } from "../src/practices/packs";
import { checkTemplatePath, renderTemplate, templateVars, validateTemplateFiles, writeTemplateFiles } from "../src/scaffold/files";
import { BUILTIN_RECIPES, checkArgv, getRecipe, saveRecipe, validateRecipe, type Recipe } from "../src/scaffold/recipes";
import { setScaffoldRunner, startScaffold, waitJob, type Runner } from "../src/scaffold/run";
import { UserError } from "../src/util";
import { makeDir } from "./helpers";

afterEach(() => setScaffoldRunner(null));

const STORE = () => path.join(home(), "recipes.json");

/** Every file a recipe writes, root and projects, as [relative path from the project root, content]. */
const filesOf = (r: Recipe): Array<readonly [string, string]> => [...Object.entries(r.files ?? {}), ...(r.projects ?? []).flatMap((p) => Object.entries(p.files ?? {}).map(([f, text]) => [`${p.dir}/${f}`, text] as const))];

/** Every file a golden recipe writes, as [recipe id, relative path, content]. */
const TEMPLATE_FILES = GOLDEN_RECIPES.flatMap((r) => filesOf(r).map(([p, text]) => [r.id, p, text] as const));

/** The generator and the steps of every unit of a recipe: the root's, then each project's. */
const unitsOf = (r: Recipe) => [{ where: r.id, generate: r.generate, steps: r.steps }, ...(r.projects ?? []).map((p) => ({ where: `${r.id} ${p.dir}`, generate: p.generate, steps: p.steps }))];

/** Environment keys the code reads, from the given file contents. */
function keysRead(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) out.add(m[1]!);
    for (const m of t.matchAll(/\b(?:env|optionalEnv)\("([A-Z][A-Z0-9_]*)"\)/g)) out.add(m[1]!);
  }
  // Set by Next.js itself, not by the project.
  out.delete("NEXT_RUNTIME");
  return out;
}

/** The keys listed in an .env.example. */
const keysListed = (text: string): Set<string> => new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

/** A generator stand-in: writes the files a real create-* command would, plus anything in `extra`. Git is faked too. */
function fakeGenerator(extra: Record<string, string> = {}): Runner {
  return async (argv, o) => {
    if (argv[0] === "bunx" && argv[1]?.startsWith("create-")) {
      fs.mkdirSync(path.join(o.cwd, "src/app"), { recursive: true });
      fs.writeFileSync(path.join(o.cwd, "package.json"), '{"name":"x"}\n');
      fs.writeFileSync(path.join(o.cwd, ".gitignore"), "node_modules/\n.env*\n");
      fs.writeFileSync(path.join(o.cwd, "src/app/page.tsx"), "export default function Page() { return null }\n");
      for (const [rel, text] of Object.entries(extra)) {
        fs.mkdirSync(path.dirname(path.join(o.cwd, rel)), { recursive: true });
        fs.writeFileSync(path.join(o.cwd, rel), text);
      }
    }
    return { code: 0, output: "ok" };
  };
}

describe("golden stacks: recipes", () => {
  test("the golden stacks come after the four defaults, and every recipe validates", () => {
    expect(BUILTIN_RECIPES.map((r) => r.id)).toEqual(["nextjs", "hono-api", "vite-react", "expo", "saas-next", "expo-app", "saas-monorepo"]);
    for (const r of GOLDEN_RECIPES) {
      const v = validateRecipe(r);
      expect(v.files).toEqual(r.files);
      expect(v.steps).toEqual(r.steps);
      expect(v.projects).toEqual(r.projects);
    }
  });

  test("tags: the Next.js stack is web, the Expo app is mobile", () => {
    expect(SAAS_NEXT.tag).toBe("web");
    expect(EXPO_APP.tag).toBe("mobile");
  });

  test("saas-next carries the seo, cro and copywriting packs and checklists, and every recipe's ids resolve", () => {
    for (const p of ["cro", "copywriting", "seo"]) expect(SAAS_NEXT.practices).toContain(p);
    for (const c of ["seo", "cro", "copywriting"]) expect(SAAS_NEXT.checklists).toContain(c);
    for (const r of BUILTIN_RECIPES) {
      for (const p of r.practices ?? []) expect(packById(p)).toBeDefined();
      for (const c of r.checklists ?? []) expect(checklistById(c)).toBeDefined();
    }
  });

  test("every generator and every step passes checkArgv (argv, no shell)", () => {
    for (const r of GOLDEN_RECIPES) {
      for (const u of unitsOf(r)) {
        if (u.generate.length) expect(() => checkArgv(u.generate, `${u.where} generator`)).not.toThrow();
        expect(u.steps.length).toBeLessThanOrEqual(20);
        u.steps.forEach((argv, i) => {
          expect(argv.length).toBeGreaterThan(0);
          expect(() => checkArgv(argv, `${u.where} step ${i + 1}`)).not.toThrow();
        });
      }
    }
  });

  test("saas-next runs the package scripts the brief asks for, and writes the pieces a generator cannot", () => {
    const scripts = SAAS_NEXT.steps.flat().join("\n");
    for (const key of ["scripts.typecheck=", "scripts.lint=", "scripts.test=", "scripts.db:migrate="]) expect(scripts).toContain(key);
    const written = Object.keys(SAAS_NEXT.files ?? {});
    for (const p of [
      "src/db/schema.ts",
      "drizzle.config.ts",
      "src/lib/auth.ts",
      "src/app/api/auth/[...all]/route.ts",
      "src/lib/billing.ts",
      "src/app/api/billing/checkout/route.ts",
      "src/app/api/billing/portal/route.ts",
      "src/app/api/stripe/webhook/route.ts",
      "src/app/api/health/route.ts",
      "src/instrumentation.ts",
      "src/instrumentation-client.ts",
      "vitest.config.ts",
      "playwright.config.ts",
      "e2e/smoke.spec.ts",
      ".env.example",
    ]) expect(written).toContain(p);
  });

  test("saas-next conventions say where auth, billing, the schema, env and tests live", () => {
    const rules = SAAS_NEXT.conventions.join("\n");
    for (const where of ["src/lib/auth.ts", "src/lib/billing.ts", "src/db/schema.ts", ".env.example", "src/**/*.test.ts", "e2e/"]) expect(rules).toContain(where);
    expect(SAAS_NEXT.conventions.length).toBeLessThanOrEqual(30);
    for (const r of SAAS_NEXT.conventions) expect(r.length).toBeLessThanOrEqual(400);
  });

  test("expo-app ships eas.json with development, preview and production, and the store metadata fields", () => {
    const eas = JSON.parse(EXPO_APP.files!["eas.json"]!);
    expect(Object.keys(eas.build).sort()).toEqual(["development", "preview", "production"]);
    const meta = JSON.parse(EXPO_APP.files!["store/metadata.json"]!);
    expect(Object.keys(meta).sort()).toEqual(["description", "keywords", "name", "privacyUrl", "screenshotsDir", "subtitle"]);
    expect(meta.screenshotsDir).toBe("store/screenshots");
    expect(EXPO_APP.files!["store/screenshots/.gitkeep"]).toBe("");
  });
});

describe("golden stacks: template content", () => {
  test("every TypeScript and TSX template parses, and every JSON one parses", () => {
    for (const [id, p, text] of TEMPLATE_FILES) {
      if (/\.tsx?$/.test(p)) {
        const loader = p.endsWith(".tsx") ? "tsx" : "ts";
        expect({ id, p, ok: (() => { try { new Bun.Transpiler({ loader }).transformSync(text); return true; } catch { return false; } })() }).toEqual({ id, p, ok: true });
      }
      if (p.endsWith(".json")) expect({ id, p, ok: (() => { try { JSON.parse(text); return true; } catch { return false; } })() }).toEqual({ id, p, ok: true });
    }
  });

  test("no template leaves a template-literal escape in the generated code", () => {
    // The CI workflow is rendered by renderWorkflow, not written as a template, and its ${{ }} expressions are YAML.
    for (const [id, p, text] of TEMPLATE_FILES) {
      if (p.endsWith(".github/workflows/ci.yml")) continue;
      expect({ id, p, bad: text.includes("${") || text.includes("`") }).toEqual({ id, p, bad: false });
    }
  });

  test("every placeholder is one of the known names", () => {
    for (const r of GOLDEN_RECIPES) for (const [, text] of filesOf(r)) expect(() => renderTemplate(text, { name: "x", title: "X" })).not.toThrow();
  });

  test("every environment key the saas-next code reads is listed in its .env.example", () => {
    // The unit test reads its own made-up key; only code that ships counts.
    const saas = Object.entries(SAAS_NEXT.files!).filter(([p]) => p !== ".env.example" && !p.endsWith(".test.ts")).map(([, t]) => t);
    const listed = keysListed(SAAS_NEXT.files![".env.example"]!);
    const missing = [...keysRead(saas)].filter((k) => !listed.has(k));
    expect(missing).toEqual([]);
    expect(keysRead(saas).size).toBeGreaterThan(8);
  });

  test("every environment key the expo-app code reads is listed in its .env.example", () => {
    const app = Object.entries(EXPO_APP.files!).filter(([p]) => p !== ".env.example").map(([, t]) => t);
    const listed = keysListed(EXPO_APP.files![".env.example"]!);
    expect([...keysRead(app)].filter((k) => !listed.has(k))).toEqual([]);
  });
});

describe("template interpolation", () => {
  test("{{name}} and {{title}} are filled in, with or without spaces inside the braces", () => {
    const vars = { name: "my-saas", title: "My Saas" };
    expect(renderTemplate("DATABASE_URL=postgres://localhost/{{name}}\n<h1>{{ title }}</h1>", vars)).toBe("DATABASE_URL=postgres://localhost/my-saas\n<h1>My Saas</h1>");
  });

  test("JSX object literals are not placeholders", () => {
    const jsx = '<div style={{ margin: 0 }} data-x={{ a: 1 }} />';
    expect(renderTemplate(jsx, { name: "a", title: "A" })).toBe(jsx);
  });

  test("an unknown placeholder is an error, not literal text", () => {
    expect(() => renderTemplate("hi {{nope}}", { name: "a", title: "A" })).toThrow(/not known/);
    expect(() => validateTemplateFiles({ "a.ts": "{{Name}}" })).toThrow(/not known/);
  });

  test("the folder's name becomes a slug and a title, and odd names fall back to app", () => {
    expect(templateVars("/work/my-saas")).toEqual({ name: "my-saas", title: "My Saas" });
    expect(templateVars("/work/Acme_Shop 2")).toEqual({ name: "acme-shop-2", title: "Acme Shop 2" });
    expect(templateVars("/work/!!!")).toEqual({ name: "app", title: "App" });
  });
});

describe("template file paths and content", () => {
  test("paths must be plain and relative, and never inside .git", () => {
    expect(checkTemplatePath("src/app/api/[...all]/route.ts")).toBe("src/app/api/[...all]/route.ts");
    expect(checkTemplatePath("src\\lib\\env.ts")).toBe("src/lib/env.ts");
    for (const bad of ["", "../x", "a/../b", "/etc/passwd", "C:/x", "a//b", "a/./b", "a/", ".git/config", "a\0b"]) {
      expect(() => checkTemplatePath(bad)).toThrow(UserError);
    }
  });

  test("the files map is checked from the outside: count, size, duplicates and paths", () => {
    expect(validateTemplateFiles(undefined)).toEqual({});
    expect(() => validateTemplateFiles(["a.ts"])).toThrow(/map/);
    expect(() => validateTemplateFiles({ "../escape.ts": "x" })).toThrow(/relative/);
    expect(() => validateTemplateFiles({ "a.ts": 5 })).toThrow(/text/);
    expect(() => validateTemplateFiles({ "a.ts": "x".repeat(20_001) })).toThrow(/characters/);
    expect(() => validateTemplateFiles({ "a\\b.ts": "x", "a/b.ts": "y" })).toThrow(/twice/);
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`f${i}.ts`, "x"]));
    expect(() => validateTemplateFiles(many)).toThrow(/at most 60/);
  });

  test("a recipe with a bad files map does not save, and one without it keeps no files key", () => {
    const base = { id: "files-check", name: "Files check", generate: ["bunx", "create-x", "."] };
    expect(() => validateRecipe({ ...base, files: { "../x": "y" } })).toThrow(/relative/);
    expect("files" in validateRecipe({ ...base, files: {} })).toBe(false);
  });
});

describe("writing template files", () => {
  test("writes nested files with the names filled in, and reports what it wrote", () => {
    const dir = path.join(makeDir(), "my-saas");
    fs.mkdirSync(dir);
    const written = writeTemplateFiles(dir, { "src/lib/x.ts": "// {{name}}\n", ".env.example": "DATABASE_URL=/{{name}}\n" }, { name: "my-saas", title: "My Saas" });
    expect(written.sort()).toEqual([".env.example", "src/lib/x.ts"]);
    expect(fs.readFileSync(path.join(dir, "src/lib/x.ts"), "utf-8")).toBe("// my-saas\n");
    expect(fs.readFileSync(path.join(dir, ".env.example"), "utf-8")).toBe("DATABASE_URL=/my-saas\n");
  });

  test("refuses an existing file and writes nothing, not even the files before it", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/lib/env.ts"), "the generator's own\n");
    const files = { "src/lib/auth.ts": "a", "src/lib/env.ts": "b" };
    expect(() => writeTemplateFiles(dir, files, { name: "x", title: "X" })).toThrow(/src\/lib\/env\.ts already exists/);
    expect(fs.existsSync(path.join(dir, "src/lib/auth.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "src/lib/env.ts"), "utf-8")).toBe("the generator's own\n");
  });

  test("refuses a path whose folder is a file", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "src"), "not a folder");
    expect(() => writeTemplateFiles(dir, { "src/x.ts": "x" }, { name: "x", title: "X" })).toThrow(/in the way/);
  });
});

describe("saving a golden recipe from the editor", () => {
  beforeEach(() => fs.rmSync(STORE(), { force: true }));
  afterAll(() => fs.rmSync(STORE(), { force: true }));

  test("an edit that does not mention files keeps them; files: {} clears them", () => {
    const stored = getRecipe("saas-next");
    const { files: _f, ...fromEditor } = stored;
    saveRecipe({ ...fromEditor, description: "Edited" });
    expect(getRecipe("saas-next").files).toEqual(SAAS_NEXT.files);
    expect(getRecipe("saas-next").description).toBe("Edited");
    saveRecipe({ ...fromEditor, files: {} });
    expect(getRecipe("saas-next").files).toBeUndefined();
  });
});

describe("a scaffold with template files", () => {
  beforeEach(() => fs.rmSync(STORE(), { force: true }));
  afterAll(() => fs.rmSync(STORE(), { force: true }));

  test("saas-next: generator, then the template files, then the steps in order, with the names filled in", async () => {
    const calls: string[][] = [];
    const generator = fakeGenerator();
    setScaffoldRunner(async (argv, o) => {
      calls.push(argv);
      return generator(argv, o);
    });
    const dir = path.join(makeDir(), "my-saas");
    const job = await waitJob(startScaffold({ recipeId: "saas-next", target: dir }).id, 20_000);
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");

    // The generator's own page is kept, and the template's files are present.
    expect(fs.readFileSync(path.join(dir, "src/app/page.tsx"), "utf-8")).toContain("Page");
    expect(fs.readFileSync(path.join(dir, ".env.example"), "utf-8")).toContain("postgres://postgres:postgres@localhost:5432/my-saas");
    expect(fs.readFileSync(path.join(dir, "src/app/pricing/page.tsx"), "utf-8")).toContain("Plans for My Saas");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toContain("src/lib/billing.ts");

    // The recipe's steps ran in order after the generator (trb's own git calls are not steps).
    const ran = calls.map((c) => c.join(" "));
    const generated = ran.findIndex((c) => c.startsWith("bunx create-next-app"));
    const steps = SAAS_NEXT.steps.map((s) => s.join(" "));
    expect(ran.slice(generated + 1).filter((c) => !c.startsWith("git "))).toEqual(steps);
  });

  test("a template never overwrites what the generator made: the job fails and no template file is written", async () => {
    setScaffoldRunner(fakeGenerator({ "src/lib/env.ts": "export const generated = true;\n" }));
    const dir = path.join(makeDir(), "clash");
    const job = await waitJob(startScaffold({ recipeId: "saas-next", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/src\/lib\/env\.ts already exists/);
    expect(fs.existsSync(path.join(dir, "src/lib/auth.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "src/lib/env.ts"), "utf-8")).toBe("export const generated = true;\n");
  });

  test("expo-app: the Expo files are written with the app's name, and the folder keeps its generator files", async () => {
    setScaffoldRunner(fakeGenerator({ "app.json": '{"expo":{"name":"x"}}\n' }));
    const dir = path.join(makeDir(), "my-app");
    const job = await waitJob(startScaffold({ recipeId: "expo-app", target: dir }).id, 20_000);
    expect(job.status).toBe("done");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "store/metadata.json"), "utf-8"));
    expect(meta.name).toBe("My App");
    expect(fs.existsSync(path.join(dir, "store/screenshots/.gitkeep"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "app.config.ts"), "utf-8")).toContain('const slug = "my-app"');
    expect(fs.existsSync(path.join(dir, "app.json"))).toBe(true);
  });
});


describe("recipes with sub-projects", () => {
  beforeEach(() => fs.rmSync(STORE(), { force: true }));
  afterAll(() => fs.rmSync(STORE(), { force: true }));

  const web = { dir: "apps/web", generate: ["bunx", "create-next-app@latest", "."], steps: [["bun", "install"]], files: { "a.txt": "{{name}}" } };
  const base = { id: "mono", name: "Mono", generate: [] as string[], projects: [web] };

  test("a recipe with no generator is accepted when it has a project, and the project round-trips", () => {
    const v = validateRecipe(base);
    expect(v.generate).toEqual([]);
    expect(v.projects).toEqual([web]);
    expect(validateRecipe({ id: "mono", name: "Mono", projects: [web] }).projects).toEqual([web]);
  });

  test("a recipe with neither a generator, a starter repo nor a project is still refused, and an empty projects list is not a project", () => {
    expect(() => validateRecipe({ id: "mono", name: "Mono", generate: [] })).toThrow(/needs a generator command/);
    expect(() => validateRecipe({ ...base, projects: [] })).toThrow(/needs a generator command/);
    expect("projects" in validateRecipe({ ...base, generate: ["bunx", "create-x", "."], projects: [] })).toBe(false);
  });

  test("a project dir must be a plain folder: not absolute, parent, .git, .reference or hidden, and each refusal names the dir", () => {
    for (const dir of ["../x", "/x", "C:/x", "a//b", ".git/x", ".reference/x", ".github", ".expo/x"]) {
      expect(() => validateRecipe({ ...base, projects: [{ ...web, dir }] })).toThrow(UserError);
    }
    expect(() => validateRecipe({ ...base, projects: [{ ...web, dir: "../x" }] })).toThrow(/\.\.\/x/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, dir: "." }] })).toThrow(/\./);
  });

  test("two projects cannot share a dir or nest in each other", () => {
    const mobile = { ...web, dir: "apps/mobile" };
    expect(() => validateRecipe({ ...base, projects: [web, { ...mobile, dir: "apps/web" }] })).toThrow(/apps\/web.*more than once|twice|duplicate/i);
    expect(() => validateRecipe({ ...base, projects: [web, { ...mobile, dir: "apps" }] })).toThrow(/apps.*apps\/web|apps\/web.*apps/);
    expect(() => validateRecipe({ ...base, projects: [web, mobile] })).not.toThrow();
  });

  test("a root file cannot sit at or under a project dir", () => {
    expect(() => validateRecipe({ ...base, files: { "apps/web/x.ts": "x" } })).toThrow(/apps\/web\/x\.ts.*apps\/web/);
    expect(() => validateRecipe({ ...base, files: { "apps/web": "x" } })).toThrow(/apps\/web/);
    expect(() => validateRecipe({ ...base, files: { "apps/mobile/x.ts": "x", "apps/webby.ts": "x" } })).not.toThrow();
  });

  test("a project needs a generator that passes checkArgv, its steps and files are checked, and the labels name the dir", () => {
    expect(() => validateRecipe({ ...base, projects: [{ ...web, generate: [] }] })).toThrow(/apps\/web.*generator/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, generate: ["bunx create-x", "."] }] })).toThrow(/apps\/web.*program only/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, steps: [["bun", "install"], ["a", "&&", "b"]] }] })).toThrow(/apps\/web step 2.*shell operator/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, steps: Array.from({ length: 21 }, () => ["bun", "install"]) }] })).toThrow(/apps\/web.*at most 20/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, files: { "../x": "y" } }] })).toThrow(/relative/);
    expect(() => validateRecipe({ ...base, projects: [{ ...web, files: { "a.txt": "{{nope}}" } }] })).toThrow(/not known/);
  });

  test("at most 6 projects, and projects must be a list of objects", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...web, dir: `apps/p${i}` }));
    expect(() => validateRecipe({ ...base, projects: seven })).toThrow(/at most 6/);
    expect(validateRecipe({ ...base, projects: seven.slice(0, 6) }).projects).toHaveLength(6);
    expect(() => validateRecipe({ ...base, projects: "apps/web" })).toThrow(/list/);
  });

  test("a starter repo may be combined with projects", () => {
    const v = validateRecipe({ id: "mono", name: "Mono", repos: [{ url: "owner/repo", role: "starter" }], projects: [web] });
    expect(v.projects).toEqual([web]);
  });

  test("an editor save that sends no projects and generate: [] saves and keeps the stored projects", () => {
    saveRecipe(base);
    const { projects: _p, ...fromEditor } = getRecipe("mono");
    saveRecipe({ ...fromEditor, description: "Edited", generate: [] });
    expect(getRecipe("mono").projects).toEqual([web]);
    expect(getRecipe("mono").description).toBe("Edited");
    saveRecipe({ ...fromEditor, description: "Edited", generate: [] });
    expect(getRecipe("mono")).toEqual({ ...getRecipe("mono"), projects: [web], description: "Edited" });
  });

  test("sending projects replaces them, and projects: [] with no generator is refused and changes nothing", () => {
    saveRecipe(base);
    saveRecipe({ ...base, projects: [{ ...web, dir: "apps/site" }] });
    expect(getRecipe("mono").projects?.map((p) => p.dir)).toEqual(["apps/site"]);
    expect(() => saveRecipe({ ...base, projects: [] })).toThrow(/needs a generator command/);
    expect(getRecipe("mono").projects?.map((p) => p.dir)).toEqual(["apps/site"]);
  });

  test("the editor's other kept fields still work: a save that does not mention practices or checklists keeps them", () => {
    const stored = getRecipe("saas-next");
    const { practices: _p, checklists: _c, files: _f, ...fromEditor } = stored;
    saveRecipe(fromEditor);
    expect(getRecipe("saas-next").practices).toEqual(SAAS_NEXT.practices);
    expect(getRecipe("saas-next").checklists).toEqual(SAAS_NEXT.checklists);
    expect(getRecipe("saas-next").files).toEqual(SAAS_NEXT.files);
  });
});

/** A runner for a monorepo scaffold: records [command, folder relative to the project], and each `create-*` writes into its own cwd plus a nested .git, like a real generator may. Git is faked. */
function recordingRunner(root: () => string, o: { fail?: (argv: string[], rel: string) => boolean; also?: (argv: string[], cwd: string) => void } = {}) {
  const calls: Array<{ cmd: string; rel: string }> = [];
  const runner: Runner = async (argv, opts) => {
    const rel = path.relative(root(), opts.cwd).split(path.sep).join("/") || ".";
    calls.push({ cmd: argv.join(" "), rel });
    if (o.fail?.(argv, rel)) return { code: 1, output: "boom" };
    if (argv[0] === "bunx" && argv[1]?.startsWith("create-")) {
      fs.mkdirSync(path.join(opts.cwd, ".git"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, ".git/HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(opts.cwd, "package.json"), '{"name":"x"}\n');
      o.also?.(argv, opts.cwd);
    }
    return { code: 0, output: "ok" };
  };
  return { calls, runner };
}

describe("a scaffold with sub-projects", () => {
  beforeEach(() => fs.rmSync(STORE(), { force: true }));
  afterAll(() => fs.rmSync(STORE(), { force: true }));

  const mono = {
    id: "mono-run",
    name: "Mono run",
    generate: [],
    steps: [["bun", "install"]],
    files: { "package.json": '{"name":"{{name}}","private":true}\n', "packages/shared/index.ts": "export {};\n" },
    projects: [
      { dir: "apps/web", generate: ["bunx", "create-next-app@latest", "."], steps: [["bun", "add", "a"], ["bun", "add", "b"]], files: { ".env.example": "DB=/{{name}}\n" } },
      { dir: "apps/mobile", generate: ["bunx", "create-expo-app@latest", "."], steps: [["bun", "add", "c"]], files: { "store/metadata.json": '{"name":"{{title}}"}\n' } },
    ],
  };

  test("each generator runs in its own folder in order, then git init, then root steps, then each project's steps", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir);
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    expect(calls.filter((c) => !c.cmd.startsWith("git add") && !c.cmd.startsWith("git -c")).map((c) => `${c.rel}: ${c.cmd}`)).toEqual([
      "apps/web: bunx create-next-app@latest .",
      "apps/mobile: bunx create-expo-app@latest .",
      ".: git init -q -b main",
      ".: bun install",
      "apps/web: bun add a",
      "apps/web: bun add b",
      "apps/mobile: bun add c",
    ]);
  });

  test("a project's template files are written after its generator with the project's name, the nested .git is removed, the root has its own files", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    setScaffoldRunner(recordingRunner(() => dir).runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.status).toBe("done");
    expect(fs.readFileSync(path.join(dir, "apps/web/.env.example"), "utf-8")).toBe("DB=/my-stack\n");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "apps/mobile/store/metadata.json"), "utf-8")).name).toBe("My Stack");
    expect(fs.existsSync(path.join(dir, "apps/web/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "apps/web/.git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "apps/mobile/.git"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name).toBe("my-stack");
    expect(fs.existsSync(path.join(dir, "packages/shared/index.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toContain("!.env.example");
  });

  test("a failing project generator fails the job before git init, and its steps and the later projects do not run", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir, { fail: (argv) => argv[1]?.startsWith("create-expo-app") === true });
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/Generating apps\/mobile failed/);
    expect(calls.some((c) => c.cmd.startsWith("git init"))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("bun "))).toBe(false);
  });

  test("a failing step is logged and the job still finishes, with the later steps run", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir, { fail: (argv) => argv.join(" ") === "bun add a" });
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.status).toBe("done");
    expect(job.log.join("\n")).toMatch(/apps\/web: Step 1 of 2: bun failed \(exit 1\); continuing/);
    expect(calls.map((c) => c.cmd)).toContain("bun add c");
  });

  test("a generator that writes into another project's folder fails the job naming that folder", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    const { runner } = recordingRunner(() => dir, {
      also: (argv, cwd) => {
        if (argv[1]?.startsWith("create-next-app")) {
          fs.mkdirSync(path.join(cwd, "../mobile"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "../mobile/stray.txt"), "x");
        }
      },
    });
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/apps\/mobile is not empty/);
    expect(fs.existsSync(path.join(dir, "apps/mobile/store"))).toBe(false);
  });

  test("a template file that the project's generator already made fails the job and writes none of that project's files", async () => {
    saveRecipe(mono);
    const dir = path.join(makeDir(), "my-stack");
    const also = (argv: string[], cwd: string) => {
      if (argv[1]?.startsWith("create-next-app")) fs.writeFileSync(path.join(cwd, ".env.example"), "theirs\n");
    };
    setScaffoldRunner(recordingRunner(() => dir, { also }).runner);
    const job = await waitJob(startScaffold({ recipeId: "mono-run", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/\.env\.example already exists/);
    expect(fs.readFileSync(path.join(dir, "apps/web/.env.example"), "utf-8")).toBe("theirs\n");
  });

  test("a recipe without projects still runs exactly one generator at the root, keeps the repository it made, then runs its steps", async () => {
    const dir = path.join(makeDir(), "plain");
    const { calls, runner } = recordingRunner(() => dir);
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "nextjs", target: dir }).id, 20_000);
    expect(job.status).toBe("done");
    expect(calls.map((c) => `${c.rel}: ${c.cmd.split(" ").slice(0, 2).join(" ")}`).filter((c) => !c.includes("git -c") && !c.includes("git add"))).toEqual([".: bunx create-next-app@latest", ".: bun install"]);
  });
});

describe("the saas-next CI workflow", () => {
  test("is byte-identical to the one shipped before sub-projects existed", () => {
    expect(SAAS_NEXT.files![".github/workflows/ci.yml"]).toBe(fs.readFileSync(path.join(import.meta.dir, "fixtures/saas-ci.yml"), "utf-8").replace(/\r\n/g, "\n"));
  });
});

describe("saas-monorepo", () => {
  beforeEach(() => fs.rmSync(STORE(), { force: true }));
  afterAll(() => fs.rmSync(STORE(), { force: true }));

  const web = SAAS_MONOREPO.projects!.find((p) => p.dir === "apps/web")!;
  const mobile = SAAS_MONOREPO.projects!.find((p) => p.dir === "apps/mobile")!;
  const rootPackage = () => JSON.parse(renderTemplate(SAAS_MONOREPO.files!["package.json"]!, { name: "my-stack", title: "My Stack" }));
  const LINK = ["bun", "pm", "pkg", "set", "dependencies.@workspace/shared=workspace:*"];

  test("is the last golden stack, tagged web, with no generator of its own and the two apps as projects in order", () => {
    expect(GOLDEN_RECIPES.at(-1)).toBe(SAAS_MONOREPO);
    expect(SAAS_MONOREPO.id).toBe("saas-monorepo");
    expect(SAAS_MONOREPO.generate).toEqual([]);
    expect(SAAS_MONOREPO.projects!.map((p) => p.dir)).toEqual(["apps/web", "apps/mobile"]);
    expect(validateRecipe(SAAS_MONOREPO).projects).toEqual(SAAS_MONOREPO.projects);
  });

  test("apps/web is the saas-next stack without its own CI file, and apps/mobile is the expo-app stack", () => {
    const { [WORKFLOW_PATH]: _ci, ...saasFiles } = SAAS_NEXT.files!;
    expect(web.files).toEqual(saasFiles);
    expect(web.generate).toEqual(SAAS_NEXT.generate);
    expect(mobile.files).toEqual(EXPO_APP.files);
    expect(mobile.generate).toEqual(EXPO_APP.generate);
  });

  test("each app links the shared package before its own steps, which are the stack's steps unchanged", () => {
    expect(web.steps).toEqual([LINK, ...SAAS_NEXT.steps]);
    expect(mobile.steps).toEqual([LINK, ...EXPO_APP.steps]);
    expect(SAAS_MONOREPO.steps).toEqual([["bun", "install"]]);
  });

  test("the root is a bun workspace over apps and packages, with the scripts the CI calls and a hoisted install for Metro", () => {
    const pkg = rootPackage();
    expect(pkg.name).toBe("my-stack");
    expect(pkg.private).toBe(true);
    expect(pkg.workspaces).toEqual(["apps/*", "packages/*"]);
    for (const dir of [...SAAS_MONOREPO.projects!.map((p) => p.dir), "packages/shared"]) {
      const [group] = dir.split("/");
      expect(pkg.workspaces).toContain(`${group}/*`);
    }
    for (const s of ["typecheck", "lint", "test", "dev:web", "dev:mobile"]) expect(typeof pkg.scripts[s]).toBe("string");
    expect(SAAS_MONOREPO.files!["bunfig.toml"]).toMatch(/linker\s*=\s*"hoisted"/);
  });

  test("packages/shared is a workspace package the apps link by name, with source the apps import directly", () => {
    const shared = JSON.parse(SAAS_MONOREPO.files!["packages/shared/package.json"]!);
    expect(shared.name).toBe("@workspace/shared");
    expect(LINK[4]).toContain(`${shared.name}=workspace:*`);
    expect(shared.scripts.typecheck).toBeDefined();
    expect(SAAS_MONOREPO.files!["packages/shared/src/index.ts"]).toContain("HealthResponse");
    expect(Object.keys(SAAS_MONOREPO.files!).every((p) => !SAAS_MONOREPO.projects!.some((pr) => p.startsWith(`${pr.dir}/`)))).toBe(true);
  });

  test("the one CI file sits at the root, runs the root scripts, and runs Playwright in apps/web where the config is", () => {
    const yaml = SAAS_MONOREPO.files![WORKFLOW_PATH]!;
    const doc = Bun.YAML.parse(yaml) as any;
    const runs = (job: string) => (doc.jobs[job].steps as any[]).filter((s) => typeof s.run === "string").map((s) => s.run.trim());
    expect(runs("verify")).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun run lint", "bun run test"]);
    for (const cmd of runs("verify").filter((c) => c.startsWith("bun run "))) expect(rootPackage().scripts[cmd.replace("bun run ", "")]).toBeDefined();
    const pw = (doc.jobs.e2e.steps as any[]).filter((s) => /playwright/.test(s.run ?? ""));
    expect(pw.map((s) => s["working-directory"])).toEqual(["apps/web", "apps/web"]);
    expect(Object.keys(web.files!)).toContain("playwright.config.ts");
    expect(web.files![WORKFLOW_PATH]).toBeUndefined();
  });

  test("trb ci init on the scaffolded root detects the same verify commands the shipped workflow runs", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), renderTemplate(SAAS_MONOREPO.files!["package.json"]!, { name: "my-stack", title: "My Stack" }));
    fs.writeFileSync(path.join(dir, "bun.lock"), "{}");
    const plan = planWorkflow(dir);
    expect(plan.inputs.verify.map((v) => v.cmd)).toEqual(["bun run typecheck", "bun run lint", "bun run test"]);
    expect(detectInputs(dir).playwright).toBeNull();
  });

  test("the rules cover the layout, scope each app's rules to its folder, and stay inside the editor's limits", () => {
    const rules = SAAS_MONOREPO.conventions;
    expect(rules.length).toBeLessThanOrEqual(30);
    for (const r of rules) expect(r.length).toBeLessThanOrEqual(400);
    for (const r of SAAS_NEXT.conventions) expect(rules.some((x) => x.startsWith("apps/web") && x.endsWith(r))).toBe(true);
    for (const r of EXPO_APP.conventions) expect(rules.some((x) => x.startsWith("apps/mobile") && x.endsWith(r))).toBe(true);
    const own = rules.filter((x) => !x.startsWith("apps/web (") && !x.startsWith("apps/mobile ("));
    expect(own.join("\n")).toContain("packages/shared");
    expect(own.join("\n")).toContain("bun install");
  });

  test("practices and checklists are the union of the two stacks, and the prompt names both apps and their env files", () => {
    expect(new Set(SAAS_MONOREPO.practices)).toEqual(new Set([...SAAS_NEXT.practices!, ...EXPO_APP.practices!]));
    expect(new Set(SAAS_MONOREPO.checklists)).toEqual(new Set([...SAAS_NEXT.checklists!, ...EXPO_APP.checklists!]));
    for (const w of ["apps/web", "apps/mobile", ".env.example"]) expect(SAAS_MONOREPO.starterPrompt).toContain(w);
  });

  test("a full scaffold: web generator, mobile generator, git init, root install, then each app's steps, with names filled in", async () => {
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir);
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "saas-monorepo", target: dir }).id, 20_000);
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    const ran = calls.filter((c) => !c.cmd.startsWith("git add") && !c.cmd.startsWith("git -c")).map((c) => `${c.rel}: ${c.cmd}`);
    expect(ran).toEqual([
      `apps/web: ${SAAS_NEXT.generate.join(" ")}`,
      `apps/mobile: ${EXPO_APP.generate.join(" ")}`,
      ".: git init -q -b main",
      ".: bun install",
      ...web.steps.map((s) => `apps/web: ${s.join(" ")}`),
      ...mobile.steps.map((s) => `apps/mobile: ${s.join(" ")}`),
    ]);
    expect(fs.readFileSync(path.join(dir, "apps/web/.env.example"), "utf-8")).toContain("postgres://postgres:postgres@localhost:5432/my-stack");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "apps/mobile/store/metadata.json"), "utf-8")).name).toBe("My Stack");
    expect(fs.existsSync(path.join(dir, "apps/web/.git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "apps/mobile/.git"))).toBe(false);
    expect(fs.existsSync(path.join(dir, WORKFLOW_PATH))).toBe(true);
    expect(fs.existsSync(path.join(dir, "apps/web/.github"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name).toBe("my-stack");
    expect(fs.existsSync(path.join(dir, "packages/shared/src/index.ts"))).toBe(true);
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("apps/web (paths are relative to it)");
    expect(agents).toContain("packages/shared");
  });

  test("the mobile generator failing fails the job and git init never runs", async () => {
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir, { fail: (argv) => argv[1]?.startsWith("create-expo-app") === true });
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "saas-monorepo", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(calls.some((c) => c.cmd.startsWith("git init"))).toBe(false);
  });

  test("a web step failing is logged and the job still finishes", async () => {
    const dir = path.join(makeDir(), "my-stack");
    const { calls, runner } = recordingRunner(() => dir, { fail: (argv, rel) => rel === "apps/web" && argv[0] === "bunx" && argv[1] === "playwright" });
    setScaffoldRunner(runner);
    const job = await waitJob(startScaffold({ recipeId: "saas-monorepo", target: dir }).id, 20_000);
    expect(job.status).toBe("done");
    expect(job.log.join("\n")).toMatch(/apps\/web: Step \d+ of \d+: bunx failed/);
    expect(calls.some((c) => c.rel === "apps/mobile" && c.cmd.startsWith("bunx expo install"))).toBe(true);
  });

  test("the web generator writing into apps/mobile fails the job with 'apps/mobile is not empty'", async () => {
    const dir = path.join(makeDir(), "my-stack");
    const also = (argv: string[], cwd: string) => {
      if (argv[1]?.startsWith("create-next-app")) {
        fs.mkdirSync(path.join(cwd, "../mobile"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "../mobile/stray.txt"), "x");
      }
    };
    setScaffoldRunner(recordingRunner(() => dir, { also }).runner);
    const job = await waitJob(startScaffold({ recipeId: "saas-monorepo", target: dir }).id, 20_000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/apps\/mobile is not empty/);
  });
});
