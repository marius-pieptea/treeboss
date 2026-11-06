/**
 * Skill packs: groups of skills that ship with trb as files under `src/skills/packs/<id>/`. A pack is a `pack.json`
 * and a `skills/<name>/` folder per skill, each copied as its author wrote it, plus a `local/<name>/` folder per skill
 * written in this repo. packs/pstack/ is the first one; see scripts/vendor-pstack.ts for keeping it in step with upstream.
 *
 * `loadPacks()` turns the skills a pack lists into built-ins, so they are seeded, reset and restored exactly like the
 * ones written in builtin.ts. A pack that is missing or unreadable is logged and skipped: it never stops the daemon.
 * `readPacks()` is the only reader of a pack.json: loadPacks and the Skills API (src/skill-packs.ts) both go through it.
 */
import fs from "fs";
import path from "path";
import { walkSkillDir, type SkillFile, type SkillWalk } from "./files";
import { NAME_RE, parseSkillFrontmatter } from "./store";
import type { BuiltinSkill } from "./builtin";

/** A pack.json. The skills list is the include list: a folder it does not name is not shipped. */
export interface PackManifest {
  id: string;
  title: string;
  version: string;
  author: string;
  license: string;
  upstream: string;
  commit: string;
  skills: string[];
  /** Skills written in this repo, read from `local/`. A re-sync never replaces them. */
  local?: string[];
  /** Bun glob patterns over `<skill>/<path inside it>`: a file they match is not shipped, even inside a listed folder. */
  exclude?: string[];
  /** SHA-256 of each vendored file (LICENSE and skills/**), keyed by path from the pack folder. Written by scripts/vendor-pstack.ts. */
  hashes?: Record<string, string>;
}

const MANIFEST_TEXT = ["id", "title", "version", "author", "license", "upstream", "commit"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Where the packs are: TRB_PACKS_DIR (the desktop app sets it), then beside the source, then beside the binary when compiled. */
export function packsRoot(): string | null {
  const beside = path.resolve(path.dirname(process.execPath), "..", "packs");
  const found = [process.env.TRB_PACKS_DIR, path.join(import.meta.dir, "packs"), beside].find((d) => d && fs.existsSync(d));
  return found ? path.resolve(found) : null;
}

/** A pack that loads: the folder it is in, and its pack.json as read. */
export interface LoadedPack {
  dir: string;
  manifest: PackManifest;
}

/**
 * The packs under `root` whose pack.json reads, in folder-name order. This is the only reader of a pack.json: loadPacks
 * and the Skills API both go through it. A pack that cannot be read is reported to `warn` and skipped.
 */
export function readPacks(root: string | null = packsRoot(), warn: (msg: string) => void = console.warn): LoadedPack[] {
  if (!root) {
    warn("[trb] no skill packs directory found; the pack skills are not offered");
    return [];
  }
  let ids: string[];
  try {
    ids = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err: any) {
    warn(`[trb] cannot read the skill packs at ${root} (${err.message})`);
    return [];
  }
  const out: LoadedPack[] = [];
  for (const dir of ids.map((id) => path.join(root, id))) {
    const manifest = readManifest(dir, warn);
    if (manifest) out.push({ dir, manifest });
  }
  return out;
}

/** The skills a pack lists: the vendored ones (under skills/), then the ones written in this repo (under local/). */
export function packSkillNames(manifest: PackManifest): string[] {
  return [...new Set([...manifest.skills, ...(manifest.local ?? [])])];
}

/** Every skill the packs under `root` list, as built-ins. A pack that cannot be read is logged and skipped. */
export function loadPacks(root: string | null = packsRoot()): BuiltinSkill[] {
  const out: BuiltinSkill[] = [];
  for (const { dir, manifest } of readPacks(root)) {
    const excluded = excludeMatcher(manifest.exclude ?? []);
    for (const [folder, names] of [
      ["skills", manifest.skills],
      ["local", manifest.local ?? []],
    ] as const) {
      for (const name of new Set(names)) {
        const skill = readSkill(path.join(dir, folder, name), name, manifest.id, excluded);
        if (skill) out.push(skill);
      }
    }
  }
  return out;
}

/** The text of a walked skill folder, keyed like BuiltinSkill.files; null when a file is not text. */
export function walkedText(walk: SkillWalk): Record<string, string> | null {
  const { files, binary } = textFiles(walk.files);
  return binary.length ? null : files;
}

/** Every file under `dir`, as a forward-slash path relative to it, sorted. */
function filesBelow(dir: string, rel = ""): string[] {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? filesBelow(dir, r) : [r];
    })
    .sort();
}

/**
 * The SHA-256 of each vendored file in a pack folder: LICENSE and everything under skills/, keyed by path from the pack
 * folder. Text is hashed with CRLF read as LF (the repository keeps LF); a file that is not text is hashed as it is.
 */
export function packFileHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of [...(fs.existsSync(path.join(dir, "LICENSE")) ? ["LICENSE"] : []), ...filesBelow(path.join(dir, "skills")).map((f) => `skills/${f}`)]) {
    const buf = fs.readFileSync(path.join(dir, rel));
    let bytes: Buffer | string = buf;
    if (!buf.includes(0)) {
      try {
        bytes = UTF8.decode(buf).replace(/\r\n/g, "\n");
      } catch {}
    }
    hashes[rel] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }
  return hashes;
}

/**
 * What is wrong with a pack's vendored files, one line per file: changed from its recorded hash, missing, present but not
 * recorded, or matched by an exclude glob. Empty when the pack is intact. Only tests call it, per FR-004.
 */
export function verifyPackFiles(dir: string, manifest: PackManifest): string[] {
  const recorded = manifest.hashes ?? {};
  const actual = packFileHashes(dir);
  const excluded = excludeMatcher(manifest.exclude ?? []);
  const problems: string[] = [];
  for (const rel of Object.keys(actual)) {
    if (rel.startsWith("skills/") && excluded(rel.slice("skills/".length))) problems.push(`${rel} is excluded by pack.json but is present`);
    else if (recorded[rel] === undefined) problems.push(`${rel} is not recorded in pack.json hashes`);
    else if (recorded[rel] !== actual[rel]) problems.push(`${rel} differs from its recorded hash`);
  }
  for (const rel of Object.keys(recorded)) if (actual[rel] === undefined) problems.push(`${rel} is recorded in pack.json hashes but missing`);
  return problems;
}

/** Whether a `<skill>/<path>` matches one of a pack's exclude globs. */
function excludeMatcher(globs: string[]): (rel: string) => boolean {
  const patterns = globs.map((g) => new Bun.Glob(g));
  return (rel) => patterns.some((p) => p.match(rel));
}

function readManifest(dir: string, warn: (msg: string) => void): PackManifest | null {
  const file = path.join(dir, "pack.json");
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf-8"));
    const valid =
      MANIFEST_TEXT.every((k) => typeof m?.[k] === "string") &&
      Array.isArray(m.skills) &&
      m.skills.every((s: unknown) => typeof s === "string" && NAME_RE.test(s)) &&
      (m.local === undefined || (Array.isArray(m.local) && m.local.every((s: unknown) => typeof s === "string" && NAME_RE.test(s)))) &&
      (m.exclude === undefined || (Array.isArray(m.exclude) && m.exclude.every((g: unknown) => typeof g === "string")));
    if (valid) return m;
    warn(`[trb] ${file} is not a pack manifest; the pack is skipped`);
  } catch (err: any) {
    warn(`[trb] ${file} cannot be read (${err.message}); the pack is skipped`);
  }
  return null;
}

/** One skill folder as a built-in; null (and logged) when it is missing or has no SKILL.md. */
function readSkill(dir: string, name: string, pack: string, excluded: (rel: string) => boolean): BuiltinSkill | null {
  const where = `${pack}/${name}`;
  let walk: SkillWalk;
  try {
    walk = walkSkillDir(dir);
  } catch (err: any) {
    console.warn(`[trb] skill ${where} is skipped: ${err.message}`);
    return null;
  }
  const kept = walk.files.filter((f) => !excluded(`${name}/${f.rel}`));
  const { files, binary } = textFiles(kept);
  for (const why of walk.skipped) console.warn(`[trb] skill ${where} leaves out ${why}`);
  if (binary.length) console.warn(`[trb] skill ${where} ships without files that are not text: ${binary.join(", ")}`);
  if (files["SKILL.md"] === undefined) {
    console.warn(`[trb] skill ${where} is skipped: no SKILL.md in ${dir}`);
    return null;
  }
  const executable = kept.filter((f) => files[f.rel] !== undefined && (fs.statSync(f.abs).mode & 0o111) !== 0).map((f) => f.rel);
  return { name, description: parseSkillFrontmatter(files["SKILL.md"]).description ?? "", files, executable, pack };
}

/** The files that are text, keyed by relative path; the rest are listed by name. */
function textFiles(list: SkillFile[]): { files: Record<string, string>; binary: string[] } {
  const files: Record<string, string> = {};
  const binary: string[] = [];
  for (const f of list) {
    const text = readText(f.abs);
    if (text === null) binary.push(f.rel);
    else files[f.rel] = text;
  }
  return { files, binary };
}

/** A file's text with CRLF read as LF (the repository keeps LF), or null when it is not UTF-8 text. */
function readText(abs: string): string | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.includes(0)) return null;
  try {
    return UTF8.decode(buf).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}
