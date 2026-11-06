/**
 * "New app" recipes (templates). A recipe is data, and every recipe is editable: the generator's command (an
 * argument list, run exactly as written without a shell, with the new folder as working directory and `.` as
 * its target), post-generate steps (install and so on, same rules), the conventions to seed into the
 * project's AGENTS.md, a starter prompt, and an icon and tag for the picker. A monorepo recipe adds `projects`:
 * sub-projects, each with its own generator, steps and files, run in a subfolder (see ./run.ts).
 *
 * Storage: `<trb home>/recipes.json` holds ALL recipes in display order, never a workspace. The shipped
 * defaults (the four starters and the golden stacks in ./golden.ts) are seeded into it once as ordinary entries (`builtinId` remembers which default an entry came
 * from, so it can be reset); an entry you delete stays deleted until you ask for "Restore missing defaults".
 * A defaults list that grows in a later version seeds only the new ones.
 *
 *   { "version": 2, "seeded": ["nextjs", ...], "recipes": [ ... ] }
 *
 * The version 1 file (an array of your own recipes) is migrated on first read: defaults first, yours after.
 */
import fs from "fs";
import path from "path";
import { home } from "../paths";
import { UserError } from "../util";
import { checkTemplatePath, validateTemplateFiles } from "./files";
import { GOLDEN_RECIPES } from "./golden";
import { catalog } from "../practices/store";
import { checklistById } from "../checklists/custom";

/**
 * A GitHub repository attached to a recipe.
 *  - `starter`: shallow-cloned into the new folder as the project's base (its history is dropped; the project
 *    gets a fresh `git init`). A recipe has at most one, and then has no generator.
 *  - `reference`: shallow-cloned into `.reference/<owner>-<repo>/` inside the project (git-ignored, no .git) and
 *    named in the starter prompt, so the agent reads it before it changes anything.
 */
export interface RepoRef {
  /** Always the canonical `https://github.com/<owner>/<repo>`. */
  url: string;
  /** A branch or tag; the default branch when absent. */
  ref?: string;
  role: "starter" | "reference";
  /** A hint for the agent: what to take from this repo. */
  note?: string;
}

/** A generator run in a subfolder of the project, with its own steps and template files. */
export interface SubProject {
  /** Project-relative folder, forward slashes ("apps/web"). Created by the runner; missing or empty when its generator starts. */
  dir: string;
  /** Generator argv, run with `dir` as working directory and "." as its target. Required: a folder of plain files belongs in the recipe's `files`. */
  generate: string[];
  /** Steps run with `dir` as working directory, after the recipe's own steps. A failing step is logged, not fatal. */
  steps: string[][];
  /** Template files relative to `dir`, written after this generator. Same rules as Recipe.files. */
  files?: Record<string, string>;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** Generator argv. Must create the project in the current directory. Empty when a starter repo is the base. */
  generate: string[];
  /** Post-generate steps, each an argv run in order (install and so on). A failing step is logged, not fatal. */
  steps: string[][];
  /** Rules seeded into AGENTS.md's managed block. */
  conventions: string[];
  /** A sentence or two for the top of AGENTS.md. */
  intro: string;
  starterPrompt: string;
  /** A short icon key the picker maps to a glyph ("globe", "server", "layers", "smartphone", "box", ...). */
  icon: string;
  /** A short label shown next to the name ("web", "api", "mobile"). */
  tag: string;
  /** GitHub repos attached to this recipe (omitted when there are none). */
  repos?: RepoRef[];
  /** Practice packs switched on for a workspace made from this recipe (ids from practices/packs.ts). */
  practices?: string[];
  /** Launch checklists attached to a workspace made from this recipe (ids from the checklist catalog, custom.ts). Empty means the catalog's defaults for the recipe's id and tag. */
  checklists?: string[];
  /** Template files written into the project after the generator: relative path -> content, with {{name}} and {{title}}. Never overwrites. See ./files.ts. */
  files?: Record<string, string>;
  /** Sub-projects, in run order (omitted when there are none). With them the recipe's own generator is optional. */
  projects?: SubProject[];
  /** The shipped default this entry was seeded from, if any; what "Reset to default" restores. */
  builtinId?: string;
}

const NODE_RULES = ["We use bun, not npm or yarn: `bun install`, `bun add`, `bun run`.", "Keep changes small and run the type check and tests before saying a task is done."];

const BASE_RECIPES: Recipe[] = [
  {
    id: "nextjs",
    name: "Next.js",
    description: "Next.js (App Router) with TypeScript, Tailwind and ESLint, via create-next-app.",
    generate: ["bunx", "create-next-app@latest", ".", "--ts", "--tailwind", "--eslint", "--app", "--src-dir", "--import-alias", "@/*", "--use-bun", "--skip-install", "--yes"],
    steps: [["bun", "install"]],
    conventions: [...NODE_RULES, "Pages and routes live in src/app (App Router); prefer server components and add \"use client\" only where needed."],
    intro: "A Next.js app (App Router, TypeScript, Tailwind).",
    starterPrompt: "This is a fresh Next.js project. Read the layout, then replace the starter page with a clean landing page for the app described below, and tell me how to run it.\n\nThe app: ",
    icon: "globe",
    tag: "web",
    practices: ["kiss", "smart-dumb-components", "design-tokens", "a11y-basics", "cro", "copywriting", "seo"],
    checklists: ["marketing-site", "seo", "cro", "copywriting"],
  },
  {
    id: "hono-api",
    name: "Hono API",
    description: "A Hono HTTP API on Bun with TypeScript, via create-hono.",
    generate: ["bunx", "create-hono@latest", ".", "--template", "bun", "--pm", "bun", "--install"],
    steps: [],
    conventions: [...NODE_RULES, "Routes are Hono handlers; validate input at the edge and return JSON errors with a status code."],
    intro: "A Hono API running on Bun.",
    starterPrompt: "This is a fresh Hono API project. Read src/index.ts, then add the first endpoints for the service described below, with a test for each, and tell me how to run it.\n\nThe service: ",
    icon: "server",
    tag: "api",
    practices: ["kiss", "strict-types", "test-the-logic"],
    checklists: ["api-service"],
  },
  {
    id: "vite-react",
    name: "Vite + React",
    description: "A Vite single-page app with React and TypeScript, via create-vite.",
    generate: ["bunx", "create-vite@latest", ".", "--template", "react-ts", "--no-interactive"],
    steps: [["bun", "install"]],
    conventions: [...NODE_RULES, "Components are function components in src/; keep state close to where it is used."],
    intro: "A Vite + React + TypeScript single-page app.",
    starterPrompt: "This is a fresh Vite + React project. Replace the demo screen with the first screen of the app described below, and tell me how to run it.\n\nThe app: ",
    icon: "layers",
    tag: "web",
    practices: ["kiss", "smart-dumb-components", "design-tokens", "a11y-basics", "cro", "copywriting", "seo"],
    checklists: ["marketing-site", "seo", "cro", "copywriting"],
  },
  {
    id: "expo",
    name: "Expo (React Native)",
    description: "An Expo app with TypeScript, via create-expo-app.",
    generate: ["bunx", "create-expo-app@latest", ".", "--template", "blank-typescript", "--no-install", "--yes"],
    steps: [["bun", "install"]],
    conventions: [...NODE_RULES, "Use Expo's APIs and config plugins before reaching for native modules."],
    intro: "An Expo (React Native) app in TypeScript.",
    starterPrompt: "This is a fresh Expo project. Replace the starter screen with the first screen of the app described below, and tell me how to run it with `bunx expo start`.\n\nThe app: ",
    icon: "smartphone",
    tag: "mobile",
  },
];

/** The shipped defaults, in display order. The golden stacks come last; a store that predates them seeds only them. */
export const BUILTIN_RECIPES: Recipe[] = [...BASE_RECIPES, ...GOLDEN_RECIPES];

export const DEFAULT_RECIPES = BUILTIN_RECIPES;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Ids that would collide with routes. */
const RESERVED = new Set(["reorder", "restore-defaults"]);

/* ------------------------------------------------------------------ validation */

const OPERATOR = /^(?:&&|\|\||;|;;|\||\|&|&|>|>>|<|<<|2>|2>&1|&>)$/;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe", "powershell", "pwsh", "powershell.exe"]);
const EVAL_FLAG = /^-[a-z]*c$|^\/c$|^-command$|^-encodedcommand$/i;

/**
 * Commands run as an argument vector with no shell, so `&&`, pipes, redirects, `$(…)` and `$VAR` are NOT
 * interpreted: they would be handed to the program as literal text. A recipe that relies on them cannot
 * work, so we say so at save time rather than failing halfway through a scaffold.
 */
export function checkArgv(argv: string[], what: string): void {
  const cmd = argv[0]!;
  if (/\s/.test(cmd)) throw new UserError(`${what}: the first entry is the program only ("${cmd.slice(0, 40)}" has a space). Put each argument in its own entry.`);
  for (const a of argv) {
    if (OPERATOR.test(a)) throw new UserError(`${what}: "${a}" is a shell operator. Commands run without a shell, so it would be passed as plain text. Use a separate step instead of chaining.`);
  }
  if (/[;&|<>`$()]/.test(cmd)) throw new UserError(`${what}: "${cmd.slice(0, 40)}" is not a program name. Commands run without a shell.`);
  for (const a of argv.slice(1)) {
    if (/\$\(|`|\$\{/.test(a)) throw new UserError(`${what}: "${a.slice(0, 40)}" relies on shell expansion, which does not happen here. Write the literal value.`);
  }
  const base = cmd.split("/").pop()!.toLowerCase();
  if (SHELLS.has(base) && argv.slice(1).some((a) => EVAL_FLAG.test(a))) throw new UserError(`${what}: running a shell with -c hides what runs. Call the program directly.`);
}

const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GH_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * `owner/repo`, `github.com/owner/repo` or `https://github.com/owner/repo[.git]` become the canonical https URL.
 * Anything else (other hosts, ssh, credentials, a /tree/… path) is refused: only github.com is cloned.
 */
export function normalizeGithubUrl(raw: unknown): string {
  const t = String(raw ?? "").trim();
  const m = /^(?:https:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s@:]+)\/([^/\s@:?#]+?)(?:\.git)?\/?$/i.exec(t);
  if (!m || (!/github\.com/i.test(t) && /[.]/.test(m[1]!))) throw new UserError(`"${t.slice(0, 60)}" is not a GitHub repository. Use owner/repo or https://github.com/owner/repo (put a branch in the Ref field).`);
  const [, owner, repo] = m;
  if (!GH_OWNER.test(owner!) || !GH_REPO.test(repo!) || repo === "." || repo === "..") throw new UserError(`"${owner}/${repo}" is not a valid GitHub repository name.`);
  return `https://github.com/${owner}/${repo}`;
}

function validateRepos(raw: unknown): RepoRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UserError("Repos must be a list.");
  if (raw.length > 6) throw new UserError("A recipe can attach at most 6 repos.");
  const out: RepoRef[] = [];
  for (const x of raw) {
    const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const role = r.role === "reference" ? "reference" : r.role === "starter" ? "starter" : null;
    if (!role) throw new UserError("Each repo is either a starter or a reference.");
    const url = normalizeGithubUrl(r.url);
    const ref = String(r.ref ?? "").trim();
    if (ref && (!GH_REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock"))) throw new UserError(`"${ref.slice(0, 40)}" is not a usable branch or tag name.`);
    const note = short(r.note, 300);
    if (out.some((o) => o.url === url && o.role === role)) continue;
    out.push({ url, ...(ref ? { ref } : {}), role, ...(note ? { note } : {}) });
  }
  if (out.filter((r) => r.role === "starter").length > 1) throw new UserError("A recipe can have only one starter repo.");
  return out;
}

/** A practice pack a recipe may name: a built-in or a custom one. When the catalog cannot be read the id is kept, not the recipe. */
const knownPack = (id: string): boolean => {
  try {
    return catalog().some((p) => p.id === id);
  } catch {
    return true;
  }
};

/** Ids a recipe takes from a built-in catalog (packs, checklists). An unknown id is refused, not dropped. */
const catalogIds =(v: unknown, what: string, noun: string, known: (id: string) => boolean): string[] => {
  const ids = [...new Set(strList(v, what, 20, 40))];
  const bad = ids.find((id) => !known(id));
  if (bad) throw new UserError(`${what}: "${bad}" is not a built-in ${noun}.`);
  return ids;
};

const strList = (v: unknown, what: string, max: number, maxLen: number): string[] => {
  if (!Array.isArray(v)) throw new UserError(`${what} must be a list of strings.`);
  if (v.length > max) throw new UserError(`${what} has too many entries (max ${max}).`);
  return v.map((x) => {
    if (typeof x !== "string" || !x.trim() || x.length > maxLen || x.includes("\0")) throw new UserError(`${what}: each entry must be a non-empty string of at most ${maxLen} characters.`);
    return x;
  });
};

const short = (v: unknown, max: number): string =>
  String(v ?? "")
    .trim()
    .slice(0, max);

/** A list of argv steps, at most 20. `dir` names a sub-project in the messages; without it they read as the recipe's own. */
function validateSteps(raw: unknown, dir?: string): string[][] {
  if (!Array.isArray(raw)) throw new UserError(dir ? `${dir}: steps must be a list of commands.` : "Steps must be a list of commands.");
  if (raw.length > 20) throw new UserError(dir ? `${dir} has at most 20 steps.` : "A recipe has at most 20 steps.");
  return raw.map((s, i) => {
    const label = dir ? `${dir} step ${i + 1}` : `Step ${i + 1}`;
    const argv = strList(s, label, 60, 300);
    if (!argv.length) throw new UserError(`${label} is empty. Remove it or give it a command.`);
    checkArgv(argv, label);
    return argv;
  });
}

const MAX_PROJECTS = 6;

/**
 * Check a recipe's `projects` from the outside. Every refusal names the offending dir. `rootFiles` is the recipe's
 * own (already checked) `files` map: those are written before any generator runs, so none may sit inside a project folder.
 */
function validateProjects(raw: unknown, rootFiles: Record<string, string>): SubProject[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UserError("Projects must be a list.");
  if (raw.length > MAX_PROJECTS) throw new UserError(`A recipe can have at most ${MAX_PROJECTS} projects.`);
  const out: SubProject[] = [];
  for (const x of raw) {
    const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const dir = checkTemplatePath(p.dir);
    if (dir.startsWith(".")) throw new UserError(`Project "${dir}": a project folder cannot start with a dot (.github, .reference and the like belong to trb and the tools).`);
    const generate = p.generate === undefined ? [] : strList(p.generate, `${dir} generator`, 60, 300);
    if (!generate.length) throw new UserError(`Project "${dir}" needs a generator command. A folder of plain files belongs in the recipe's template files.`);
    checkArgv(generate, `${dir} generator`);
    const steps = p.steps === undefined ? [] : validateSteps(p.steps, dir);
    let files: Record<string, string>;
    try {
      files = validateTemplateFiles(p.files);
    } catch (e) {
      throw e instanceof UserError ? new UserError(`${dir}: ${e.message}`) : e;
    }
    out.push({ dir, generate, steps, ...(Object.keys(files).length ? { files } : {}) });
  }
  for (const [i, a] of out.entries()) {
    for (const b of out.slice(i + 1)) {
      const [x, y] = [a.dir.toLowerCase(), b.dir.toLowerCase()];
      if (x === y) throw new UserError(`Project "${b.dir}" is listed twice.`);
      if (y.startsWith(`${x}/`) || x.startsWith(`${y}/`)) {
        const [outer, inner] = x.length < y.length ? [a.dir, b.dir] : [b.dir, a.dir];
        throw new UserError(`Project "${outer}" contains project "${inner}". A folder has one owner: do not nest projects.`);
      }
    }
    for (const f of Object.keys(rootFiles)) {
      if (f === a.dir || f.startsWith(`${a.dir}/`)) throw new UserError(`"${f}" is inside project "${a.dir}". The recipe's own files are written before the generator runs, so put it in that project's files.`);
    }
  }
  return out;
}

/** Check and normalise a recipe from the outside. */
export function validateRecipe(raw: unknown): Recipe {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = String(r.id ?? "").trim().toLowerCase();
  if (!ID.test(id) || RESERVED.has(id)) throw new UserError("A recipe id is lowercase letters, digits and dashes (at most 40 characters).");
  const name = String(r.name ?? "").trim();
  if (!name || name.length > 60) throw new UserError("A recipe needs a name of at most 60 characters.");
  const repos = validateRepos(r.repos);
  const hasStarter = repos.some((x) => x.role === "starter");
  const files = validateTemplateFiles(r.files);
  const projects = validateProjects(r.projects, files);
  const noBase = "A recipe needs a generator command, or a starter repo to copy, or projects to generate.";
  if (r.generate === undefined && !hasStarter && !projects.length) throw new UserError(noBase);
  const generate = r.generate === undefined ? [] : strList(r.generate, "Generator command", 60, 300);
  if (hasStarter && generate.length) throw new UserError("A recipe starts from a starter repo or runs a generator, not both. Clear the generator command or make the repo a reference.");
  if (!hasStarter && !generate.length && !projects.length) throw new UserError(noBase);
  if (generate.length) checkArgv(generate, "Generator command");
  let steps: string[][];
  if (r.steps !== undefined) steps = validateSteps(r.steps);
  else if (r.install !== undefined && r.install !== null) {
    // The version 1 field: one install command.
    const argv = strList(r.install, "install", 60, 300);
    if (argv.length) checkArgv(argv, "install");
    steps = argv.length ? [argv] : [];
  } else steps = [];
  const practices = r.practices === undefined || r.practices === null ? [] : catalogIds(r.practices, "Practice packs", "practice pack", knownPack);
  const checklists = r.checklists === undefined || r.checklists === null ? [] : catalogIds(r.checklists, "Checklists", "checklist", (x) => !!checklistById(x));
  const out: Recipe = {
    id,
    name,
    description: short(r.description, 300),
    generate,
    steps,
    conventions: r.conventions === undefined ? [] : strList(r.conventions, "Rules", 30, 400),
    intro: short(r.intro, 500),
    starterPrompt: String(r.starterPrompt ?? "").slice(0, 4000),
    icon: short(r.icon, 24).toLowerCase().replace(/[^a-z0-9-]/g, "") || "box",
    tag: short(r.tag, 20),
  };
  if (repos.length) out.repos = repos;
  if (practices.length) out.practices = practices;
  if (checklists.length) out.checklists = checklists;
  if (Object.keys(files).length) out.files = files;
  if (projects.length) out.projects = projects;
  const b = typeof r.builtinId === "string" ? r.builtinId.trim() : "";
  if (b && BUILTIN_RECIPES.some((d) => d.id === b)) out.builtinId = b;
  return out;
}

/* ------------------------------------------------------------------ the store */

interface Store {
  version: 2;
  seeded: string[];
  recipes: Recipe[];
}

const file = (): string => path.join(home(), "recipes.json");

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const asDefault = (d: Recipe): Recipe => ({ ...clone(d), builtinId: d.id });

function parse(text: string): Store | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const keep = (list: unknown): Recipe[] => {
    const out: Recipe[] = [];
    for (const x of Array.isArray(list) ? list : []) {
      try {
        const r = validateRecipe(x);
        if (!out.some((o) => o.id === r.id)) out.push(r);
      } catch {
        // a hand-edited entry that no longer validates is skipped, not fatal
      }
    }
    return out;
  };
  if (Array.isArray(v)) {
    const mine = keep(v);
    return { version: 2, seeded: [], recipes: mine }; // defaults are seeded in front by load()
  }
  if (v && typeof v === "object" && Array.isArray((v as any).recipes)) {
    const seeded = Array.isArray((v as any).seeded) ? (v as any).seeded.filter((s: unknown) => typeof s === "string") : [];
    return { version: 2, seeded, recipes: keep((v as any).recipes) };
  }
  return null;
}

function write(s: Store): void {
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, file());
}

/** Read the store, seeding any default that has never been seeded (once). Persists only when something changed. */
function load(): Store {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file(), "utf-8");
  } catch {}
  const legacy = text !== null && text.trimStart().startsWith("[");
  const parsed = text !== null ? parse(text) : null;
  if (text !== null && !parsed) {
    // Hand-edited into something unreadable: keep a copy before it is replaced by the defaults.
    try {
      fs.copyFileSync(file(), `${file()}.bak`);
    } catch {}
  }
  const s = parsed ?? { version: 2 as const, seeded: [], recipes: [] };
  const fresh = BUILTIN_RECIPES.filter((d) => !s.seeded.includes(d.id));
  if (fresh.length) {
    const taken = new Set(s.recipes.map((r) => r.id));
    const add = fresh.filter((d) => !taken.has(d.id)).map(asDefault);
    // First seeding puts the defaults ahead of what was already there; a later one appends.
    s.recipes = text === null || legacy ? [...add, ...s.recipes] : [...s.recipes, ...add];
    s.seeded = [...s.seeded, ...fresh.map((d) => d.id)];
    write(s);
  }
  return s;
}

export function listRecipes(): Recipe[] {
  return load().recipes;
}

export function getRecipe(id: string): Recipe {
  const r = listRecipes().find((x) => x.id === id);
  if (!r) throw new UserError(`No recipe "${id}".`);
  return r;
}

const sameContent = (a: Recipe, b: Recipe): boolean => {
  const strip = ({ id: _i, builtinId: _b, ...rest }: Recipe) => JSON.stringify(rest);
  return strip(a) === strip(b);
};

/** A recipe as the UI shows it: whether it comes from a default, and whether it has been changed since. */
export interface RecipeView extends Recipe {
  /** Seeded from a shipped default (so "Reset to default" exists for it). */
  isDefault: boolean;
  modified: boolean;
}

export function listRecipeViews(): { recipes: RecipeView[]; missingDefaults: Array<{ id: string; name: string }> } {
  const recipes = load().recipes;
  const views = recipes.map((r) => {
    const d = BUILTIN_RECIPES.find((x) => x.id === r.builtinId);
    return { ...r, isDefault: !!d, modified: d ? !sameContent(r, { ...d, builtinId: d.id }) || r.id !== d.id : false };
  });
  const have = new Set(recipes.map((r) => r.builtinId).filter(Boolean));
  return { recipes: views, missingDefaults: BUILTIN_RECIPES.filter((d) => !have.has(d.id)).map((d) => ({ id: d.id, name: d.name })) };
}

/**
 * Fields the editor does not carry: a save that leaves one out keeps the stored value; sending it (even empty) replaces it.
 * `projects` is here because a recipe made of projects has no generator of its own for the editor to send.
 */
const KEPT_WHEN_UNSENT = ["files", "projects", "practices", "checklists"] as const;

/** The payload with the stored entry's value for every kept field it does not mention. Merged before validating, so what is checked is what is stored. */
function withKeptFields(raw: unknown, stored: Recipe | undefined): unknown {
  if (!stored || !raw || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = { ...raw };
  for (const k of KEPT_WHEN_UNSENT) if (!(k in out) && stored[k]) out[k] = stored[k];
  return out;
}

/** Create or replace by id. A replaced entry keeps its link to the default it came from. */
export function saveRecipe(raw: unknown): Recipe {
  const s = load();
  const id = raw && typeof raw === "object" ? String((raw as Record<string, unknown>).id ?? "").trim().toLowerCase() : "";
  const i = s.recipes.findIndex((x) => x.id === id);
  const r = validateRecipe(withKeptFields(raw, s.recipes[i]));
  if (i >= 0) {
    const kept = s.recipes[i]!.builtinId;
    if (kept) r.builtinId = kept;
    else delete r.builtinId;
    s.recipes[i] = r;
  } else {
    delete r.builtinId; // only seeding and restoring link an entry to a default
    s.recipes.push(r);
  }
  write(s);
  return r;
}

export function deleteRecipe(id: string): void {
  const s = load();
  if (!s.recipes.some((x) => x.id === id)) throw new UserError(`No recipe "${id}".`);
  s.recipes = s.recipes.filter((x) => x.id !== id);
  write(s);
}

/** Put a seeded entry back to what shipped (same position). */
export function resetRecipe(id: string): Recipe {
  const s = load();
  const i = s.recipes.findIndex((x) => x.id === id);
  if (i < 0) throw new UserError(`No recipe "${id}".`);
  const d = BUILTIN_RECIPES.find((x) => x.id === s.recipes[i]!.builtinId);
  if (!d) throw new UserError("Only recipes that came with trb have a default to go back to.");
  const taken = s.recipes.some((x, j) => j !== i && x.id === d.id);
  if (taken) throw new UserError(`Another recipe already uses the id "${d.id}"; rename or delete it first.`);
  s.recipes[i] = asDefault(d);
  write(s);
  return s.recipes[i]!;
}

/** Add back the defaults that are missing (deleted, or renamed away from). Returns what was added. */
export function restoreDefaults(): Recipe[] {
  const s = load();
  const have = new Set(s.recipes.map((r) => r.builtinId).filter(Boolean));
  const added: Recipe[] = [];
  for (const d of BUILTIN_RECIPES) {
    if (have.has(d.id)) continue;
    const r = asDefault(d);
    if (s.recipes.some((x) => x.id === r.id)) r.id = `${d.id}-default`.slice(0, 40);
    while (s.recipes.some((x) => x.id === r.id)) r.id = `${r.id}-2`.slice(0, 40);
    s.recipes.push(r);
    added.push(r);
  }
  if (added.length) write(s);
  return added;
}

/** Set the display order. Unknown ids are ignored; recipes not named keep their order at the end. */
export function reorderRecipes(ids: string[]): Recipe[] {
  const s = load();
  const by = new Map(s.recipes.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: Recipe[] = [];
  for (const id of ids) {
    const r = by.get(id);
    if (r && !seen.has(id)) {
      out.push(r);
      seen.add(id);
    }
  }
  for (const r of s.recipes) if (!seen.has(r.id)) out.push(r);
  s.recipes = out;
  write(s);
  return out;
}
