/**
 * Skills: reusable instructions a coding agent can load (`SKILL.md` + supporting files).
 *
 * Stored once under trb's home, then materialised into a session's workspace per turn at the
 * place the engine natively discovers skills (`.claude/skills`, `.agents/skills`, …) and taken
 * out again afterwards, so a skill never ends up committed to someone's repo. Engines with no
 * native skills directory get a short index in the prompt pointing at the stored path instead
 * (an engine that cannot see a directory must not be told it exists).
 */
import { UserError } from "../util";
import fs from "fs";
import os from "os";
import path from "path";
import { db } from "../db";
import { paths } from "../paths";
import type { EngineDef } from "../engines/registry";
import { copyWalk, walkSkillDir } from "./files";
import { importSync as importSyncImpl } from "./import";
import { getSetting } from "../settings";
import { excludeTargetFor, forgetRun, linkSkill, present, recordRun, removePlaced, syncExclude, type ExcludeTarget } from "./scaffold";

/** Source of the skills that ship with trb (see skills/builtin.ts). */
export const BUILTIN_SOURCE = "trb:builtin";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SkillRecord {
  name: string;
  description: string;
  path: string;
  source: string | null;
  enabled: boolean;
  created_at: string;
}

function row(r: any): SkillRecord {
  return { name: r.name, description: r.description, path: r.path, source: r.source, enabled: r.enabled === 1, created_at: r.created_at };
}

/** Minimal frontmatter reader: `name:` and `description:` between the leading `---` fences. */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const out: { name?: string; description?: string; body: string } = { body: m[2] };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // Folded/literal block scalars: collect the indented continuation lines.
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(" ");
    }
    value = value.replace(/^["']|["']$/g, "");
    (out as any)[kv[1]] = value;
  }
  return out;
}

export const SkillStore = {
  list(): SkillRecord[] {
    const rows = (db().prepare("SELECT * FROM skills ORDER BY name").all() as any[]).map(row);
    // The description lives in SKILL.md, which can be edited in place: show what the file says now.
    for (const r of rows) {
      try {
        const d = parseSkillFrontmatter(fs.readFileSync(path.join(r.path, "SKILL.md"), "utf-8")).description ?? "";
        if (d !== r.description) {
          db().prepare("UPDATE skills SET description = ? WHERE name = ?").run(d, r.name);
          r.description = d;
        }
      } catch {}
    }
    return rows;
  },

  get(name: string): SkillRecord | null {
    const r = db().prepare("SELECT * FROM skills WHERE name = ?").get(name);
    return r ? row(r) : null;
  },

  enabled(): SkillRecord[] {
    return this.list().filter((s) => s.enabled && fs.existsSync(path.join(s.path, "SKILL.md")));
  },

  /** Copy a skill directory (one containing SKILL.md) into trb's store and register it. */
  add(srcDir: string, opts: { name?: string; overwrite?: boolean } = {}): SkillRecord {
    const src = path.resolve(srcDir.replace(/^~(?=$|\/)/, os.homedir()));
    const skillMd = path.join(src, "SKILL.md");
    if (!fs.existsSync(skillMd)) throw new UserError(`${src} has no SKILL.md.`);
    const fm = parseSkillFrontmatter(fs.readFileSync(skillMd, "utf-8"));
    const name = (opts.name || fm.name || path.basename(src)).trim();
    if (!NAME_RE.test(name)) throw new UserError(`Skill name "${name}" must be lowercase letters, digits, ".", "_" or "-".`);
    if (this.get(name) && !opts.overwrite) throw new UserError(`Skill "${name}" already exists (pass --force to replace it).`);
    const dest = path.join(paths.skills(), name);
    copyWalk(walkSkillDir(src), dest);
    this.register(name, fm.description ?? "", dest, src);
    return this.get(name)!;
  },

  /** Record a skill whose files are already in place. */
  register(name: string, description: string, dest: string, source: string | null): SkillRecord {
    db()
      .prepare(
        `INSERT INTO skills (name, description, path, source, enabled) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, path = excluded.path, source = excluded.source`,
      )
      .run(name, description, dest, source);
    return this.get(name)!;
  },

  /** Scaffold a new skill and register it. */
  create(name: string, description: string): SkillRecord {
    if (!NAME_RE.test(name)) throw new UserError(`Skill name "${name}" must be lowercase letters, digits, ".", "_" or "-".`);
    if (this.get(name)) throw new UserError(`Skill "${name}" already exists.`);
    const dir = path.join(paths.skills(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description || "Describe when this skill should be used."}\n---\n\n# ${name}\n\nWrite the instructions the agent should follow here.\n`,
    );
    db().prepare("INSERT INTO skills (name, description, path, source, enabled) VALUES (?, ?, ?, 'created', 1)").run(name, description, dir);
    return this.get(name)!;
  },

  /** Register every skill found under `root` (nested folders included). See skills/import.ts for the progress-reporting form. */
  importDir(root: string, opts: { overwrite?: boolean; onProgress?: (msg: string) => void } = {}): { added: string[]; skipped: string[]; failed: Array<{ name: string; error: string }>; notes: string[] } {
    return importSyncImpl(root, opts);
  },

  remove(name: string): boolean {
    const rec = this.get(name);
    if (!rec) return false;
    fs.rmSync(rec.path, { recursive: true, force: true });
    return db().prepare("DELETE FROM skills WHERE name = ?").run(name).changes > 0;
  },

  setEnabled(name: string, enabled: boolean): boolean {
    return db().prepare("UPDATE skills SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name).changes > 0;
  },
};

/** Skill copies a live turn put in a workspace, with how many turns rely on each, so concurrent turns in one cwd don't strip each other's. */
const materialized = new Map<string, number>();
/** Directories trb created to hold them (`.claude/`, `.claude/skills/`), refcounted the same way. */
const createdDirs = new Map<string, number>();

/** Absolute paths of the skill copies live turns have in workspaces right now: trb's own scaffolding, not the user's changes. */
export function materializedSkillPaths(): string[] {
  return [...materialized.keys()];
}

/**
 * The skills a session gets when neither it nor its agent names any. Never the whole library by default: each one is
 * a folder of files written into the workspace on every turn, and a few thousand of them make a turn slow to start
 * and a repository noisy. Anything else is still one `/name` away.
 */
export function defaultSkillNames(engine?: Pick<EngineDef, "skillsDir">): string[] {
  const tokens = getSetting("default_skills").split(",").map((t) => t.trim()).filter(Boolean);
  const enabled = SkillStore.enabled();
  const out = new Set<string>();
  for (const t of tokens) {
    if (t === "none") continue;
    if (t === "all") {
      // An engine with no skills folder is told about skills in its prompt, one line each: the built-ins only, not the library.
      for (const s of enabled) if (!engine || engine.skillsDir || s.source === BUILTIN_SOURCE) out.add(s.name);
    } else if (t === "builtin") {
      for (const s of enabled) if (s.source === BUILTIN_SOURCE) out.add(s.name);
    } else {
      out.add(t);
    }
  }
  return [...out];
}

export interface MaterializedSkills {
  /** Prompt text listing skills the engine cannot discover natively. Empty when none. */
  promptBlock: string;
  names: string[];
  cleanup: () => void;
}

/**
 * Make the enabled skills visible to `engine` in `cwd`. Never overwrites a skill directory that
 * already exists there and is not ours: the repo's own (or the user's own) skill of that name wins.
 */
export function materializeSkills(engine: EngineDef, cwd: string, allowed?: string[] | null): MaterializedSkills {
  // `allowed` narrows to an agent's (or a session's) assignment. A globally disabled skill stays off even when
  // assigned: disabling is the kill switch, assignment only chooses among what is on.
  const skills = SkillStore.enabled().filter((s) => !allowed || allowed.includes(s.name));
  if (skills.length === 0) return { promptBlock: "", names: [], cleanup: () => {} };

  if (!engine.skillsDir) {
    const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""} (read ${path.join(s.path, "SKILL.md")})`);
    return {
      promptBlock: `# Available skills\nRead a skill's SKILL.md before doing work it covers.\n${lines.join("\n")}\n\n`,
      names: skills.map((s) => s.name),
      cleanup: () => {},
    };
  }

  const root = path.join(cwd, engine.skillsDir);
  // Directories that do not exist yet are ours to create and to remove again. One that exists
  // already (the operator's own `.claude/`) is left alone, even when it ends up empty.
  const ownedDirs: string[] = [];
  for (const dir of [path.dirname(root), root]) {
    const refs = createdDirs.get(dir);
    if (refs !== undefined) {
      createdDirs.set(dir, refs + 1);
      ownedDirs.push(dir);
    } else if (!fs.existsSync(dir)) {
      createdDirs.set(dir, 1);
      ownedDirs.push(dir);
    }
  }

  const placed: string[] = [];
  let link = getSetting("skills_link") === "on";
  for (const s of skills) {
    const dest = path.join(root, s.name);
    const count = materialized.get(dest);
    if (count !== undefined) {
      materialized.set(dest, count + 1);
      placed.push(dest);
      continue;
    }
    if (present(dest)) continue; // not ours: leave it alone
    try {
      // A link is one entry per skill, however many files it holds; a copy is the fallback (a filesystem that refuses links).
      let done = false;
      if (link) {
        try {
          linkSkill(s.path, dest);
          done = true;
        } catch {
          link = false; // do not retry for every remaining skill
        }
      }
      if (!done) copyWalk(walkSkillDir(s.path), dest);
      materialized.set(dest, 1);
      placed.push(dest);
    } catch {}
  }

  // Keep git's view of the workspace clean while the copies exist, and leave a record a crashed daemon can undo.
  const exclude: ExcludeTarget | null = placed.length ? excludeTargetFor(cwd) : null;
  const refreshExclude = () => exclude && syncExclude(exclude, [...materialized.keys()]);
  refreshExclude();
  const runId = placed.length || ownedDirs.length ? recordRun({ cwd, placed, owned: ownedDirs, exclude }) : null;

  let done = false;
  return {
    promptBlock: "",
    names: skills.map((s) => s.name),
    cleanup: () => {
      if (done) return;
      done = true;
      for (const dest of placed) {
        const count = (materialized.get(dest) ?? 1) - 1;
        if (count > 0) {
          materialized.set(dest, count);
          continue;
        }
        materialized.delete(dest);
        removePlaced(dest);
      }
      // Deepest first, so `.claude/skills` goes before `.claude`.
      for (const dir of [...ownedDirs].reverse()) {
        const refs = (createdDirs.get(dir) ?? 1) - 1;
        if (refs > 0) {
          createdDirs.set(dir, refs);
          continue;
        }
        createdDirs.delete(dir);
        try {
          fs.rmdirSync(dir); // only succeeds when empty: never removes something that holds the operator's files
        } catch {}
      }
      refreshExclude();
      if (runId) forgetRun(runId);
    },
  };
}

/**
 * `/skill-name rest of the message`: the user calling an enabled skill by hand. Returns the skill and the
 * remaining message, or null when the text is not a single-line-start slash call of a known skill.
 * An exact name always wins. Otherwise a partial one works (`/rev` for `code-review`) only when exactly one
 * enabled skill starts with it or has a word that does; two or more is ambiguous, so the text goes out as typed.
 */
export function parseSkillInvocation(prompt: string): { skill: SkillRecord; rest: string } | null {
  const m = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i.exec(prompt.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const enabled = SkillStore.enabled();
  let skill = enabled.find((x) => x.name === word);
  if (!skill) {
    const hits = enabled.filter((x) => x.name.startsWith(word) || x.name.split(/[-._]+/).some((w) => w.startsWith(word)));
    if (hits.length === 1) skill = hits[0];
  }
  return skill ? { skill, rest: (m[2] ?? "").trim() } : null;
}

/** The prompt an engine receives for a skill invocation: engine-agnostic, points at the stored SKILL.md. */
export function skillInvocationPrompt(inv: { skill: SkillRecord; rest: string }): string {
  const head = `Use the "${inv.skill.name}" skill for this task. Read ${path.join(inv.skill.path, "SKILL.md")} first and follow it.`;
  return inv.rest ? `${head}\n\n${inv.rest}` : `${head}\nNo further instructions were given: do what the skill describes for the current project.`;
}
