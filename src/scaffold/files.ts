/**
 * Template files a recipe writes into the new project, after its generator has run. A recipe's `files` map is
 * relative path -> content. Content may use `{{name}}` (the folder's name as a slug, for package and bundle ids)
 * and `{{title}}` (the folder's name as words, for display). Anything else in double braces is refused.
 *
 * A file that already exists is never overwritten: the whole set is checked before the first byte is written,
 * so a refusal leaves the folder as the generator left it.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";

export interface TemplateVars {
  /** The folder's name, lowercased, with runs of other characters turned into dashes. */
  name: string;
  /** The folder's name as words. Only letters, digits, spaces, dots, dashes and underscores. */
  title: string;
}

export const MAX_TEMPLATE_FILES = 60;
export const MAX_TEMPLATE_BYTES = 20_000;
const VAR_NAMES = ["name", "title"] as const;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** The variables for a project in `dir`, from the folder's own name. */
export function templateVars(dir: string): TemplateVars {
  const base = path.basename(dir);
  const name = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
  const title = base.replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60) || "App";
  return { name, title };
}

/** Fill in the placeholders. An unknown one is an error, so a typo never ships as literal text. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    if (!(VAR_NAMES as readonly string[]).includes(key)) {
      throw new UserError(`Template placeholder ${whole} is not known. Use ${VAR_NAMES.map((v) => `{{${v}}}`).join(" or ")}.`);
    }
    return vars[key as (typeof VAR_NAMES)[number]];
  });
}

/** A project-relative path with forward slashes: no absolute or drive-letter form, no `..`, `.` or empty part, and nothing under `.git`. */
export function checkTemplatePath(raw: unknown): string {
  const p = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!p || p.length > 200 || p.includes("\0")) throw new UserError(`"${p.slice(0, 60)}" is not a usable file path.`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new UserError(`"${p}" must be a path inside the project, not an absolute one.`);
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) throw new UserError(`"${p}" must be a plain relative path.`);
  if (parts[0] === ".git") throw new UserError(`"${p}" is inside .git, which templates never write.`);
  return parts.join("/");
}

/** Check a recipe's `files` map from the outside, including that every placeholder is known. Returns a clean copy. */
export function validateTemplateFiles(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new UserError("Template files must be a map of path to text.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TEMPLATE_FILES) throw new UserError(`A recipe can write at most ${MAX_TEMPLATE_FILES} template files.`);
  const out: Record<string, string> = {};
  for (const [key, text] of entries) {
    const p = checkTemplatePath(key);
    if (typeof text !== "string" || text.length > MAX_TEMPLATE_BYTES) throw new UserError(`"${p}": the content must be text of at most ${MAX_TEMPLATE_BYTES} characters.`);
    if (p in out) throw new UserError(`"${p}" is listed twice.`);
    renderTemplate(text, { name: "x", title: "X" }); // throws on an unknown placeholder
    out[p] = text;
  }
  return out;
}

/**
 * Write the files under `dir`, rendered with `vars`. Refuses, before writing anything, if a file already exists
 * (any kind, including a link) or a parent on the way is a file or a link. Returns the paths written.
 */
export function writeTemplateFiles(dir: string, files: Record<string, string>, vars: TemplateVars): string[] {
  const plan = Object.entries(files).map(([key, text]) => {
    const rel = checkTemplatePath(key);
    const parts = rel.split("/");
    let cur = dir;
    for (const seg of parts.slice(0, -1)) {
      cur = path.join(cur, seg);
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) throw new UserError(`${rel} cannot be written: ${seg} is in the way (a file or a link).`);
    }
    const target = path.join(dir, ...parts);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) throw new UserError(`${rel} already exists, and a template never overwrites a file. Remove it from the recipe or delete the file from the generator.`);
    return { rel, target, content: renderTemplate(text, vars) };
  });
  for (const f of plan) {
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    fs.writeFileSync(f.target, f.content);
  }
  return plan.map((f) => f.rel);
}
