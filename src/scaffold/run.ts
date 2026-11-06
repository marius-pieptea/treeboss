/**
 * Scaffolding a new app from a recipe, as a background job.
 *
 * Safety first: the target folder is checked before anything runs (absolute, not a root or the home
 * folder, parent exists, not a symlink, and EMPTY), every command runs with that folder as its working
 * directory and without a shell, and the only files trb itself writes are AGENTS.md / CLAUDE.md, a
 * minimal .gitignore, a recipe's template files (never over an existing file) and, when one is chosen, a design
 * system's DESIGN.md and design/tokens.css inside it.
 * Generator and git calls go through one replaceable runner.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runCmd } from "../git/run";
import { addRules } from "../memory/store";
import { UserError } from "../util";
import { Workspaces } from "../workspaces";
import { createLead, type CreateLeadInput } from "../sessions/manager";
import { getRecipe, type Recipe, type RepoRef } from "./recipes";
import { setPractices } from "../practices/store";
import { attach } from "../checklists/store";
import { defaultChecklistsFor } from "../checklists/custom";
import { templateVars, writeTemplateFiles, type TemplateVars } from "./files";
import { getSystem, type DesignSystem } from "../design/library";
import { writeSystem } from "../design/workspace";
import { DESIGN_FILE, TOKENS_FILE } from "../design/contract";

export interface RunnerResult {
  code: number;
  output: string;
}
export type Runner = (argv: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<RunnerResult>;

const defaultRunner: Runner = async (argv, o) => {
  const [cmd, ...args] = argv;
  try {
    const r = await runCmd(cmd!, args, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, maxBytes: 4 * 1024 * 1024 });
    const output = `${r.stdout.toString("utf-8")}${r.stderr.toString("utf-8")}`;
    return { code: r.timedOut ? 124 : r.code, output: r.timedOut ? `${output}\n(timed out)` : output };
  } catch (e: any) {
    return { code: 127, output: `Could not run ${cmd}: ${e?.message ?? e}` };
  }
};

let runner: Runner = defaultRunner;
/** Tests only: stand in for every external command. */
export function setScaffoldRunner(r: Runner | null): void {
  runner = r ?? defaultRunner;
}

const STEP_TIMEOUT_MS = 15 * 60_000;
/** Non-interactive, no telemetry nags. */
const ENV: Record<string, string> = { CI: "1", NEXT_TELEMETRY_DISABLED: "1", EXPO_NO_TELEMETRY: "1", npm_config_yes: "true", GIT_TERMINAL_PROMPT: "0" };

const IGNORABLE = new Set([".DS_Store", "Thumbs.db"]);

export interface TargetCheck {
  /** The folder as it will be used (absolute). */
  dir: string;
  exists: boolean;
  /** Inside a git work tree already: no `git init` is run. */
  insideRepo: boolean;
  /** The parent folder does not exist yet and will be created (only with `createParents`). */
  createsParents?: boolean;
}

/** Throws a UserError naming the problem. Does not create anything. With `createParents`, a missing parent folder is allowed (the nearest existing ancestor is checked instead). */
export function checkTarget(target: string, opts: { createParents?: boolean } = {}): TargetCheck {
  const raw = String(target ?? "").trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!raw) throw new UserError("Choose a folder for the new app.");
  if (raw.includes("\0")) throw new UserError("That folder path is not valid.");
  if (!path.isAbsolute(raw)) throw new UserError("The folder must be an absolute path.");
  if (raw.split(/[\\/]/).includes("..")) throw new UserError("The folder path cannot contain '..'.");
  const dir = path.resolve(raw);
  if (dir === path.parse(dir).root) throw new UserError("Refusing to scaffold into the filesystem root.");
  const parent = path.dirname(dir);
  let realParent: string;
  let createsParents = false;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    if (!opts.createParents) throw new UserError(`The parent folder ${parent} does not exist.`);
    // Walk up to the nearest folder that exists; the rest will be created.
    let anchor = parent;
    const rest: string[] = [];
    while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) {
      rest.unshift(path.basename(anchor));
      anchor = path.dirname(anchor);
    }
    realParent = path.join(fs.realpathSync(anchor), ...rest);
    createsParents = true;
    if (!fs.statSync(fs.realpathSync(anchor)).isDirectory()) throw new UserError(`${anchor} is not a folder.`);
  }
  if (!createsParents && !fs.statSync(realParent).isDirectory()) throw new UserError(`${parent} is not a folder.`);
  const realHome = (() => {
    try {
      return fs.realpathSync(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  const real = path.join(realParent, path.basename(dir));
  if (real === realHome || real === path.parse(real).root) throw new UserError("Refusing to scaffold into your home folder; choose a new subfolder.");

  const st = createsParents ? undefined : fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new UserError("The folder is a symbolic link; choose a real folder.");
  if (st && !st.isDirectory()) throw new UserError(`${dir} exists and is not a folder.`);
  if (st) {
    const entries = fs.readdirSync(dir).filter((n) => !IGNORABLE.has(n));
    if (entries.length) throw new UserError(`${dir} is not empty (${entries.length} item${entries.length === 1 ? "" : "s"}). Choose an empty folder.`);
  }
  let insideRepo = false;
  for (let p = realParent; ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, ".git"))) {
      insideRepo = true;
      break;
    }
    if (path.dirname(p) === p) break;
  }
  return { dir: real, exists: !!st, insideRepo, ...(createsParents ? { createsParents } : {}) };
}

export type JobStatus = "running" | "done" | "failed";
export interface Job {
  id: string;
  recipe: string;
  dir: string;
  status: JobStatus;
  step: string;
  log: string[];
  error: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  startedAt: number;
}

const jobs = new Map<string, Job>();
const busy = new Set<string>();
const MAX_LOG = 400;

export const getJob = (id: string): Job | null => jobs.get(id) ?? null;

export interface ScaffoldInput {
  recipeId: string;
  target: string;
  /** What to build, appended to the recipe's starter prompt. */
  describe?: string;
  /** Start a session with the starter prompt once the project exists. */
  session?: Omit<CreateLeadInput, "prompt" | "cwd"> | null;
  /** A design system from the library: its DESIGN.md and tokens.css go into the first commit. */
  designSystem?: string | null;
}

function note(job: Job, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    job.log.push(line.slice(0, 400));
  }
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}

async function step(job: Job, label: string, argv: string[], cwd: string, mustSucceed = true): Promise<boolean> {
  job.step = label;
  note(job, `$ ${argv.join(" ")}`);
  const r = await runner(argv, { cwd, env: ENV, timeoutMs: STEP_TIMEOUT_MS });
  note(job, r.output.split(/\r?\n/).slice(-30).join("\n"));
  if (r.code !== 0) {
    if (mustSucceed) throw new UserError(`${label} failed (exit ${r.code}). See the log.`);
    note(job, `${label} failed (exit ${r.code}); continuing.`);
    return false;
  }
  return true;
}

/**
 * A shallow clone that cannot run anything of the repo's: hooks off, no submodules, no tags, no prompts for
 * credentials (a private repo works only if git is already signed in to GitHub). `--` keeps a URL from ever
 * being read as an option; the URL and ref were validated when the recipe was saved.
 */
export function cloneArgv(repo: RepoRef, dest: string): string[] {
  return ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules", ...(repo.ref ? ["--branch", repo.ref] : []), "--", repo.url, dest];
}

const repoSlug = (r: RepoRef): string => r.url.replace("https://github.com/", "").replace("/", "-").toLowerCase();
const repoLabel = (r: RepoRef): string => `${r.url}${r.ref ? ` (${r.ref})` : ""}`;

/** What the agent is told to read before it touches anything. */
export function repoBrief(starter: RepoRef | undefined, refs: RepoRef[]): string {
  if (!starter && !refs.length) return "";
  const lines = ["Before you change anything, read the repositories attached to this template and work out how to use them:"];
  if (starter) lines.push(`- This project began as a copy of ${repoLabel(starter)}. Read its README, AGENTS.md or CLAUDE.md, docs and entry points in the project root.${starter.note ? ` Hint: ${starter.note}` : ""}`);
  for (const r of refs) lines.push(`- Reference: .reference/${repoSlug(r)} is ${repoLabel(r)}, kept for reading only and ignored by git. Read its README and layout, and see how it solves what this project needs.${r.note ? ` Hint: ${r.note}` : ""}`);
  lines.push("Then say in a few bullets how you will use them, and carry on with the task.", "", "");
  return lines.join("\n");
}

/** What the starter session is told about the design system, ahead of the recipe's own prompt. */
export function designBrief(sys: DesignSystem): string {
  return `This project uses the "${sys.name}" design system: ${DESIGN_FILE} is the contract and ${TOKENS_FILE} holds the tokens. Before building any screen, import ${TOKENS_FILE} into the global styles, load the fonts it names, and map the tokens into the styling setup (for Tailwind, theme values that point at the CSS variables). Then build the UI with the tokens only.\n\n`;
}

/**
 * The recipe's practice packs and launch checklists, switched on for the new workspace. Best effort: a failure is noted
 * in the job log and the scaffold goes on. A recipe with no checklists of its own gets the catalog's defaults for its id and tag.
 */
function applyRecipeDefaults(job: Job, recipe: Recipe, workspaceId: string): void {
  if (recipe.practices?.length) {
    try {
      setPractices(workspaceId, { enabled: recipe.practices });
    } catch (e) {
      note(job, `Could not enable the practice packs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const checklists = recipe.checklists?.length ? recipe.checklists : defaultChecklistsFor([recipe.id, recipe.tag]).map((c) => c.id);
  for (const id of checklists) {
    try {
      attach(workspaceId, id);
    } catch (e) {
      note(job, `Could not attach the ${id} checklist: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** One place a generator runs: the project root ("."), then each of the recipe's sub-projects, in order. */
interface Unit {
  /** Project-relative folder; "." for the root. */
  dir: string;
  label: string;
  /** Empty for a root that starts from a starter repo or from nothing but template files. */
  generate: string[];
  steps: string[][];
  files?: Record<string, string>;
}

/** The root first, then each project. A recipe without projects is one unit, so it runs as it always has. */
function units(recipe: Recipe): Unit[] {
  return [{ dir: ".", label: recipe.name, generate: recipe.generate, steps: recipe.steps, files: recipe.files }, ...(recipe.projects ?? []).map((p) => ({ dir: p.dir, label: p.dir, generate: p.generate, steps: p.steps, files: p.files }))];
}

/** A project folder must be real folders all the way down (not a file or a link) and empty when its generator starts. Creates it. */
function prepareProjectDir(root: string, rel: string): string {
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = path.join(cur, seg);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) fs.mkdirSync(cur);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(`${rel} cannot be used as a project folder: ${path.relative(root, cur).split(path.sep).join("/")} is a file or a link.`);
  }
  const entries = fs.readdirSync(cur).filter((n) => !IGNORABLE.has(n));
  if (entries.length) throw new UserError(`${rel} is not empty (${entries.length} item${entries.length === 1 ? "" : "s"}). A project's generator needs an empty folder; something that ran before it wrote there.`);
  return cur;
}

/**
 * Run the unit's generator in its folder (fatal on failure), then write its template files. A project folder is created and
 * must be empty first, and a `.git` its generator leaves behind is deleted: the project's history is the root's, and a nested
 * repository would be committed as a gitlink. The root's own generator is left alone (it may have made the repository).
 */
async function generateUnit(job: Job, root: string, u: Unit, vars: TemplateVars): Promise<void> {
  const cwd = u.dir === "." ? root : prepareProjectDir(root, u.dir);
  if (u.generate.length) {
    await step(job, `Generating ${u.label}`, u.generate, cwd);
    if (u.dir !== ".") fs.rmSync(path.join(cwd, ".git"), { recursive: true, force: true });
  }
  if (u.files) {
    // After the generator, before git init, so the files are part of the first commit. A file the generator already made is refused, not replaced.
    job.step = "Writing the template files";
    const written = writeTemplateFiles(cwd, u.files, vars);
    note(job, `Wrote ${written.length} template file${written.length === 1 ? "" : "s"}${u.dir === "." ? "" : ` in ${u.dir}`}.`);
  }
}

/** The unit's steps with its folder as working directory. A failing step is logged and skipped. */
async function runSteps(job: Job, root: string, u: Unit): Promise<void> {
  const where = u.dir === "." ? "" : `${u.dir}: `;
  for (const [i, argv] of u.steps.entries()) await step(job, `${where}${u.steps.length === 1 ? `Running ${argv[0]}` : `Step ${i + 1} of ${u.steps.length}: ${argv[0]}`}`, argv, path.join(root, u.dir), false);
}

async function execute(job: Job, recipe: Recipe, check: TargetCheck, input: ScaffoldInput, design: DesignSystem | null): Promise<void> {
  const dir = check.dir;
  job.step = "Creating the folder";
  if (!check.exists) fs.mkdirSync(dir, { recursive: check.createsParents === true }); // not recursive unless the parent was checked as missing
  const starter = recipe.repos?.find((r) => r.role === "starter");
  const refs = recipe.repos?.filter((r) => r.role === "reference") ?? [];
  if (starter) {
    await step(job, `Copying ${starter.url.replace("https://github.com/", "")}`, cloneArgv(starter, "."), dir);
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true }); // the project gets its own history
  }
  const vars = templateVars(dir);
  for (const u of units(recipe)) await generateUnit(job, dir, u, vars);
  if (!fs.existsSync(path.join(dir, ".gitignore"))) fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\ndist/\n.next/\n.expo/\n.DS_Store\n");

  const gotRefs: RepoRef[] = [];
  if (refs.length) {
    fs.mkdirSync(path.join(dir, ".reference"), { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    const cur = fs.readFileSync(ignore, "utf-8");
    if (!/^\/?\.reference\/?$/m.test(cur)) fs.writeFileSync(ignore, `${cur}${cur.endsWith("\n") || !cur ? "" : "\n"}.reference/\n`);
    for (const r of refs) {
      const dest = path.join(".reference", repoSlug(r));
      const ok = await step(job, `Fetching reference ${r.url.replace("https://github.com/", "")}`, cloneArgv(r, dest), dir, false);
      if (!ok) continue;
      fs.rmSync(path.join(dir, dest, ".git"), { recursive: true, force: true });
      gotRefs.push(r);
    }
  }

  if (!check.insideRepo && !fs.existsSync(path.join(dir, ".git"))) await step(job, "git init", ["git", "init", "-q", "-b", "main"], dir);
  else note(job, check.insideRepo ? "Inside an existing git repository: not running git init." : "The generator already created a git repository.");

  for (const u of units(recipe)) await runSteps(job, dir, u);

  job.step = "Seeding AGENTS.md";
  const agents = path.join(dir, "AGENTS.md");
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, `# ${path.basename(dir)}\n\n${recipe.intro || recipe.name}\n`);
  addRules(dir, recipe.conventions);
  if (starter || gotRefs.length) {
    const lines = ["", "## Where this started", ""];
    if (starter) lines.push(`- Started from ${repoLabel(starter)}.${starter.note ? ` ${starter.note}` : ""}`);
    for (const r of gotRefs) lines.push(`- Reference, read before changing related code: \`.reference/${repoSlug(r)}\` (${repoLabel(r)}; ignored by git).${r.note ? ` ${r.note}` : ""}`);
    fs.appendFileSync(agents, `${lines.join("\n")}\n`);
  }
  if (design) {
    job.step = "Writing the design system";
    writeSystem(dir, design, { overwrite: true });
    note(job, `Design system "${design.name}": wrote ${DESIGN_FILE}${design.tokens ? ` and ${TOKENS_FILE}` : ""}.`);
  }

  // Registered before the commit, so the AGENTS.md block the practice packs write is part of the first commit.
  job.step = "Opening the workspace";
  const wsId = Workspaces.open(dir).id;
  job.workspaceId = wsId;
  applyRecipeDefaults(job, recipe, wsId);

  if (!check.insideRepo) {
    // Isolated sessions need a commit to branch from. Identity is only a fallback for machines with none set.
    const staged = await step(job, "git add", ["git", "add", "-A"], dir, false);
    if (staged) await step(job, "Initial commit", ["git", "-c", "commit.gpgsign=false", "-c", "user.name=trb", "-c", "user.email=trb@localhost", "commit", "-q", "-m", `Scaffold ${recipe.name} app`], dir, false);
  }

  if (input.session) {
    job.step = "Starting a session";
    const prompt = `${repoBrief(starter, gotRefs)}${design ? designBrief(design) : ""}${recipe.starterPrompt}${input.describe?.trim() ?? ""}`.trim() || `This is a fresh ${recipe.name} project. Ask me what to build.`;
    job.sessionId = createLead({ ...input.session, prompt, cwd: dir, title: `New ${recipe.name} app` }).id;
  }
}

/** Validate synchronously (so the caller gets the refusal as an error), then run in the background. */
export function startScaffold(input: ScaffoldInput): Job {
  const recipe = getRecipe(String(input.recipeId ?? ""));
  const design = input.designSystem ? getSystem(String(input.designSystem)) : null;
  const check = checkTarget(input.target);
  if (busy.has(check.dir)) throw new UserError("A scaffold into that folder is already running.");
  busy.add(check.dir);
  const job: Job = { id: `sc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, recipe: recipe.id, dir: check.dir, status: "running", step: "Starting", log: [], error: null, workspaceId: null, sessionId: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  if (jobs.size > 50) for (const [k, j] of jobs) if (j.status !== "running" && jobs.size > 50) jobs.delete(k);
  void (async () => {
    try {
      await execute(job, recipe, check, input, design);
      job.status = "done";
      job.step = "Done";
    } catch (e: any) {
      job.status = "failed";
      job.error = String(e?.message ?? e);
      note(job, job.error);
    } finally {
      busy.delete(check.dir);
    }
  })();
  return job;
}

/** Tests: wait for a job to finish. */
export async function waitJob(id: string, timeoutMs = 10_000): Promise<Job> {
  const t0 = Date.now();
  for (;;) {
    const j = jobs.get(id);
    if (!j) throw new Error("no such job");
    if (j.status !== "running") return j;
    if (Date.now() - t0 > timeoutMs) throw new Error("job still running");
    await new Promise((r) => setTimeout(r, 10));
  }
}


// ---------------------------------------------------------------------------------------------------
// Plain projects: an empty folder, or a clone of any git repository. No recipe, no generator.
// ---------------------------------------------------------------------------------------------------

export interface CloneSource {
  url: string;
  ref?: string;
}

const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * What a user may paste into a clone box: `owner/repo` (GitHub), `https://host/path[.git]`, `ssh://git@host/path`
 * or `git@host:path`. Refused: anything that starts with a dash, has whitespace or control characters, embeds
 * a password in the URL, or is a transport that can run code or read local files (`ext::`, `file:`, a path).
 */
export function normalizeCloneUrl(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) throw new UserError("Paste a repository URL.");
  if (t.length > 300 || /[\s\0-\x1f]/.test(t) || t.startsWith("-")) throw new UserError("That is not a usable repository URL.");
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(t) && !t.includes("..")) return `https://github.com/${t.replace(/\.git$/, "")}`;
  let m = /^https:\/\/([^/@:]+)\/([^?#]+?)\/?$/.exec(t); // no user:pass@ , no port, no query
  if (m && HOST.test(m[1]!) && m[1]!.includes(".") && !m[2]!.split("/").includes("..")) return t.replace(/\/$/, "");
  m = /^ssh:\/\/git@([^/@:]+)\/([^?#]+?)\/?$/.exec(t);
  if (m && HOST.test(m[1]!) && m[1]!.includes(".") && !m[2]!.split("/").includes("..")) return t.replace(/\/$/, "");
  m = /^git@([^/@:]+):([^?#\s]+?)\/?$/.exec(t);
  if (m && HOST.test(m[1]!) && m[1]!.includes(".") && !m[2]!.startsWith("/") && !m[2]!.split("/").includes("..")) return t.replace(/\/$/, "");
  throw new UserError(`"${t.slice(0, 60)}" is not a repository URL. Use owner/repo, https://host/owner/repo, or git@host:owner/repo.`);
}

/** The folder name a clone lands in by default: the repository's name. */
export function repoFolderName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "");
}

/**
 * A full clone that keeps the history and the origin remote, but cannot run anything of the repo's: hooks off,
 * no fsmonitor, no `ext::` or `file:` transports, no prompts for credentials (private repos work when git or SSH
 * is already signed in). `--` keeps the URL from being read as an option. `shallow` trades history for speed.
 */
export function projectCloneArgv(src: CloneSource, dest: string, shallow = false): string[] {
  return ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "clone", ...(shallow ? ["--depth", "1", "--single-branch"] : []), "--no-recurse-submodules", ...(src.ref ? ["--branch", src.ref] : []), "--", src.url, dest];
}

export interface ProjectInput {
  kind: "empty" | "clone";
  target: string;
  /** Empty folder: run `git init` and make a first commit. Default true. */
  gitInit?: boolean;
  url?: string;
  ref?: string;
  shallow?: boolean;
}

async function executeProject(job: Job, check: TargetCheck, input: ProjectInput, src: CloneSource | null): Promise<void> {
  const dir = check.dir;
  job.step = "Creating the folder";
  if (!check.exists) fs.mkdirSync(dir, { recursive: true });
  if (src) {
    const label = src.url.replace(/^https:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
    const ok = await step(job, `Cloning ${label}`, projectCloneArgv(src, ".", input.shallow === true), dir, false);
    if (!ok) {
      // Leave nothing behind that this job made: an empty folder only, never one with content.
      if (!check.exists && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
      throw new UserError("The clone failed. See the log (a private repository needs git or SSH to be signed in already).");
    }
  } else if (input.gitInit !== false) {
    await step(job, "git init", ["git", "init", "-q", "-b", "main"], dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\ndist/\n.DS_Store\n");
    const staged = await step(job, "git add", ["git", "add", "-A"], dir, false);
    if (staged) await step(job, "Initial commit", ["git", "-c", "commit.gpgsign=false", "-c", "user.name=trb", "-c", "user.email=trb@localhost", "commit", "-q", "-m", "Initial commit"], dir, false);
  }
  job.step = "Opening the workspace";
  job.workspaceId = Workspaces.open(dir).id;
}

/** Validate synchronously, then create an empty folder or clone a repository into a new one, in the background. Missing parent folders are created. */
export function startProject(input: ProjectInput): Job {
  const src: CloneSource | null =
    input.kind === "clone"
      ? (() => {
          const url = normalizeCloneUrl(input.url);
          const ref = String(input.ref ?? "").trim();
          if (ref && (!GIT_REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock"))) throw new UserError(`"${ref.slice(0, 40)}" is not a usable branch or tag name.`);
          return { url, ...(ref ? { ref } : {}) };
        })()
      : null;
  const check = checkTarget(input.target, { createParents: true });
  if (busy.has(check.dir)) throw new UserError("A project is already being created in that folder.");
  busy.add(check.dir);
  const job: Job = { id: `sc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, recipe: input.kind, dir: check.dir, status: "running", step: "Starting", log: [], error: null, workspaceId: null, sessionId: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  if (jobs.size > 50) for (const [k, j] of jobs) if (j.status !== "running" && jobs.size > 50) jobs.delete(k);
  void (async () => {
    try {
      await executeProject(job, check, input, src);
      job.status = "done";
      job.step = "Done";
    } catch (e: any) {
      job.status = "failed";
      job.error = String(e?.message ?? e);
      note(job, job.error);
    } finally {
      busy.delete(check.dir);
    }
  })();
  return job;
}
