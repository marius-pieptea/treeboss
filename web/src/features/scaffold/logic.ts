/**
 * Pure logic behind the Templates settings page and the New app dialog: the recipe shape, the form it is
 * edited in, and the small helpers between them. No React, no network.
 */
import type { Who } from "@/components/agent-who";
import { joinArgs, tokenizeArgs } from "../settings/logic";

export interface RepoRef {
  url: string;
  ref?: string;
  role: "starter" | "reference";
  note?: string;
}

/** A generator run in a subfolder of the project (a monorepo recipe). The editor carries it unchanged and does not show it. */
export interface SubProject {
  dir: string;
  generate: string[];
  steps: string[][];
  files?: Record<string, string>;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  generate: string[];
  steps: string[][];
  conventions: string[];
  intro: string;
  starterPrompt: string;
  icon: string;
  tag: string;
  repos?: RepoRef[];
  practices?: string[];
  checklists?: string[];
  /** Template files written into the project after the generator: relative path -> content ({{name}}, {{title}}). */
  files?: Record<string, string>;
  /** Sub-projects of a monorepo recipe, each with its own generator. When present the recipe's own generator may be empty. */
  projects?: SubProject[];
  builtinId?: string;
}

export interface RecipeView extends Recipe {
  isDefault: boolean;
  modified: boolean;
}

export interface RecipeList {
  recipes: RecipeView[];
  missingDefaults: Array<{ id: string; name: string }>;
}

/** What the editor holds: commands as one line each (what you would type), rules one per line. */
export interface RecipeForm {
  id: string;
  isNew: boolean;
  name: string;
  description: string;
  generate: string;
  steps: string[];
  rules: string;
  intro: string;
  starterPrompt: string;
  icon: string;
  tag: string;
  repos: RepoRow[];
  /** Practice packs switched on for a workspace made from this template (ids from the pack catalog). */
  practices: string[];
  /** Launch checklists attached to a workspace made from this template (ids from /api/checklists). */
  checklists: string[];
  /** Template files as the recipe holds them. Undefined means the recipe has none, so a save leaves the field out; an empty map is sent and clears them. */
  files?: Record<string, string>;
  /** Sub-projects as the recipe holds them. Undefined means none, so a save leaves the field out and the daemon keeps the stored ones. */
  projects?: SubProject[];
  builtinId?: string;
}

/** One attached repo as typed: the URL may be owner/repo, the ref and note may be empty. */
export interface RepoRow {
  url: string;
  ref: string;
  role: "starter" | "reference";
  note: string;
}

export const ICONS = ["box", "globe", "server", "layers", "smartphone", "terminal", "database", "rocket", "zap", "bot"] as const;

const copyProjects = (list: SubProject[]): SubProject[] => list.map((p) => ({ dir: p.dir, generate: [...p.generate], steps: p.steps.map((a) => [...a]), ...(p.files ? { files: { ...p.files } } : {}) }));

export function toForm(r: Recipe): RecipeForm {
  return {
    id: r.id,
    isNew: false,
    name: r.name,
    description: r.description,
    generate: joinArgs(r.generate),
    steps: r.steps.map(joinArgs),
    rules: r.conventions.join("\n"),
    intro: r.intro,
    starterPrompt: r.starterPrompt,
    icon: r.icon || "box",
    tag: r.tag,
    repos: (r.repos ?? []).map((x) => ({ url: x.url.replace("https://github.com/", ""), ref: x.ref ?? "", role: x.role, note: x.note ?? "" })),
    practices: [...(r.practices ?? [])],
    checklists: [...(r.checklists ?? [])],
    ...(r.files ? { files: { ...r.files } } : {}),
    ...(r.projects ? { projects: copyProjects(r.projects) } : {}),
    builtinId: r.builtinId,
  };
}

export const filePaths = (f: RecipeForm): string[] => Object.keys(f.files ?? {}).sort();

export const setFileContent = (f: RecipeForm, path: string, text: string): RecipeForm => (f.files && path in f.files ? { ...f, files: { ...f.files, [path]: text } } : f);

export function removeFile(f: RecipeForm, path: string): RecipeForm {
  if (!f.files || !(path in f.files)) return f;
  const { [path]: _gone, ...rest } = f.files;
  return { ...f, files: rest };
}

/** The argument list a command line stands for: exactly what will be run. */
export const argvOf = (line: string): string[] => tokenizeArgs(line);

export function toRecipe(f: RecipeForm): Recipe {
  return {
    id: f.id,
    name: f.name.trim(),
    description: f.description.trim(),
    generate: argvOf(f.generate),
    steps: f.steps.map(argvOf).filter((a) => a.length),
    conventions: f.rules.split("\n").map((l) => l.trim()).filter(Boolean),
    intro: f.intro.trim(),
    starterPrompt: f.starterPrompt,
    icon: f.icon,
    tag: f.tag.trim(),
    ...(usedRepos(f).length ? { repos: usedRepos(f).map((x) => ({ url: x.url.trim(), role: x.role, ...(x.ref.trim() ? { ref: x.ref.trim() } : {}), ...(x.note.trim() ? { note: x.note.trim() } : {}) })) } : {}),
    // Sent even when empty: the daemon keeps a field that is left out, so an empty list is how a selection is cleared.
    practices: [...f.practices],
    checklists: [...f.checklists],
    ...(f.files ? { files: { ...f.files } } : {}),
    ...(f.projects ? { projects: copyProjects(f.projects) } : {}),
    builtinId: f.builtinId,
  };
}

/** Rows that have a URL; an empty row is just a box waiting to be filled. */
export const usedRepos = (f: RecipeForm): RepoRow[] => f.repos.filter((x) => x.url.trim());
export const hasStarter = (f: RecipeForm): boolean => usedRepos(f).some((x) => x.role === "starter");

/** Mirrors the daemon: owner/repo, github.com/owner/repo or https://github.com/owner/repo(.git). */
export function looksLikeGithub(v: string): boolean {
  const m = /^(?:https:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(v.trim());
  return !!m && m[2] !== "." && m[2] !== "..";
}

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "template";

/** An id that is not in `taken`, starting from `base`. */
export function freeId(base: string, taken: string[]): string {
  const b = slug(base);
  if (!taken.includes(b)) return b;
  for (let n = 2; ; n++) {
    const id = `${b.slice(0, 36)}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

export function blankForm(taken: string[]): RecipeForm {
  return { id: freeId("my-template", taken), isNew: true, name: "My template", description: "", generate: "bunx create-something@latest .", steps: ["bun install"], rules: "", intro: "", starterPrompt: "", icon: "box", tag: "", repos: [], practices: [], checklists: [], builtinId: undefined };
}

/** A copy of a form as a new template (no link to a default, a fresh id). */
export function duplicateForm(f: RecipeForm, taken: string[]): RecipeForm {
  const name = `${f.name} copy`.slice(0, 60);
  return { ...f, id: freeId(name, taken), isNew: true, name, builtinId: undefined };
}

/** Quick checks mirrored from the daemon so the Save button can explain itself; the daemon has the last word. */
export function formProblem(f: RecipeForm): string | null {
  if (!f.name.trim()) return "Give it a name.";
  const starter = hasStarter(f);
  if (usedRepos(f).filter((x) => x.role === "starter").length > 1) return "Only one repo can be the starter.";
  for (const r of usedRepos(f)) if (!looksLikeGithub(r.url)) return `"${r.url.trim().slice(0, 40)}" is not a GitHub repository (use owner/repo).`;
  if (starter && argvOf(f.generate).length) return "A starter repo is the base, so clear the generator command.";
  if (!starter && !argvOf(f.generate).length && !f.projects?.length) return "The generator command is empty (or attach a starter repo).";
  return null;
}

export const sameForm = (a: RecipeForm, b: RecipeForm): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Move `id` one place up or down in an ordered id list. */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The folder a clone lands in by default: the repository's name (`owner/app`, a URL or `git@host:owner/app.git`). */
export function repoFolderName(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "");
}

/** Parent folder and name joined into the folder that will be created. */
export const projectTarget = (parent: string, name: string): string => `${parent.replace(/\/+$/, "")}/${name.trim()}`;

export interface ScaffoldRunInput extends Who {
  recipe: string;
  target: string;
  describe: string;
  /** The design system to write in; "" is none. */
  design?: string;
  /** Open a session with the starter prompt. */
  session: boolean;
}

/** The scaffold run body. The starter session carries the picked engine and model; `true` asks for the server's defaults. */
export function scaffoldRunBody(a: ScaffoldRunInput): Record<string, unknown> {
  const who = { ...(a.engine ? { engine: a.engine } : {}), ...(a.model ? { model: a.model } : {}) };
  return { recipe: a.recipe, target: a.target, describe: a.describe, ...(a.design ? { designSystem: a.design } : {}), session: a.session ? (Object.keys(who).length ? who : true) : false };
}

const LAST_PARENT = "trb.newproject.parent";
export function readLastParent(): string {
  try {
    return localStorage.getItem(LAST_PARENT) ?? "";
  } catch {
    return "";
  }
}
export function saveLastParent(parent: string): void {
  try {
    localStorage.setItem(LAST_PARENT, parent);
  } catch {}
}
