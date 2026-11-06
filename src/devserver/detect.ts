/**
 * Finding how a project runs. Pure reads of a few well-known files; nothing is executed. Env files are
 * reduced to their KEYS here, at the read: values never leave this function.
 */
import fs from "fs";
import path from "path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface RunService {
  /** Stable within a directory: "web:dev", "proc:web". */
  id: string;
  label: string;
  kind: "dev" | "task";
  /** Directory the command runs in, relative to the root ("" for the root). */
  dir: string;
  /** The command as it would be typed (a shell line). */
  command: string;
  source: "package.json" | "Procfile";
  /** The script's own text, for the port rule and for display. */
  script?: string;
  /** Why it is under "database": migrate / seed / push. */
  group?: "db";
}

export interface EnvFile {
  file: string;
  keys: string[];
}

export interface Detected {
  packageManager: PackageManager | null;
  services: RunService[];
  db: RunService[];
  envFiles: EnvFile[];
}

const DEV_SCRIPTS = ["dev", "start", "serve", "preview", "develop", "start:dev", "dev:web", "dev:server"];
const DB_SCRIPT = /^(db[:\-_.]|migrate|migration|seed|prisma|drizzle|knex|typeorm)/i;
const MAX_SERVICES = 16;

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function detectPackageManager(dir: string): PackageManager | null {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package-lock.json") || has("package.json")) return "npm";
  return null;
}

/** `bun run dev`, `pnpm run dev`, `yarn dev`, `npm run dev`. */
export function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
}

/** Keys of a dotenv file. The right-hand side is never captured. */
export function envKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function envFilesIn(dir: string): EnvFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n === ".env" || n.startsWith(".env.")).sort();
  } catch {}
  const out: EnvFile[] = [];
  for (const file of names) {
    try {
      const st = fs.statSync(path.join(dir, file));
      if (!st.isFile() || st.size > 256 * 1024) continue;
      out.push({ file, keys: envKeys(fs.readFileSync(path.join(dir, file), "utf-8")) });
    } catch {}
  }
  return out;
}

export function parseProcfile(text: string): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out.push({ name: m[1], command: m[2] });
  }
  return out;
}

/** Sub-directories worth a look in a monorepo: apps/*, packages/*, and the usual single-app folder names. */
function candidateDirs(root: string): string[] {
  const out = [""];
  const add = (rel: string) => {
    if (fs.existsSync(path.join(root, rel, "package.json")) && !out.includes(rel)) out.push(rel);
  };
  for (const parent of ["apps", "packages", "services"]) {
    try {
      for (const e of fs.readdirSync(path.join(root, parent), { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) add(`${parent}/${e.name}`);
    } catch {}
  }
  for (const n of ["web", "frontend", "client", "server", "backend", "api", "app"]) add(n);
  return out.slice(0, 12);
}

export function detect(root: string): Detected {
  const services: RunService[] = [];
  const dbs: RunService[] = [];
  const rootPm = detectPackageManager(root);

  for (const rel of candidateDirs(root)) {
    const dir = path.join(root, rel);
    const pkg = readJson(path.join(dir, "package.json"));
    const scripts: Record<string, unknown> = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    const pm = detectPackageManager(dir) ?? rootPm ?? "npm";
    const tag = rel ? `${rel}: ` : "";
    const idp = rel ? `${rel}:` : "";
    for (const [name, raw] of Object.entries(scripts)) {
      if (typeof raw !== "string") continue;
      if (DEV_SCRIPTS.includes(name)) {
        // "start" is often a production start; keep it but after "dev" in the list.
        services.push({ id: `${idp}${name}`, label: `${tag}${name}`, kind: "dev", dir: rel, command: runScriptCommand(pm, name), source: "package.json", script: raw });
      } else if (DB_SCRIPT.test(name)) {
        dbs.push({ id: `${idp}${name}`, label: `${tag}${name}`, kind: "task", dir: rel, command: runScriptCommand(pm, name), source: "package.json", script: raw, group: "db" });
      }
    }
  }

  try {
    const proc = fs.readFileSync(path.join(root, "Procfile"), "utf-8");
    for (const p of parseProcfile(proc)) services.push({ id: `proc:${p.name}`, label: `Procfile: ${p.name}`, kind: "dev", dir: "", command: p.command, source: "Procfile", script: p.command });
  } catch {}

  // dev first, then the rest in the order found.
  const rank = (s: RunService) => (/(^|:)dev$/.test(s.id) ? 0 : /(^|:)(dev:|start:dev|develop)/.test(s.id) ? 1 : /(^|:)(serve|preview)$/.test(s.id) ? 2 : /^proc:/.test(s.id) ? 3 : 4);
  services.sort((a, b) => rank(a) - rank(b));

  const envFiles = [...envFilesIn(root), ...candidateDirs(root).filter((r) => r).flatMap((r) => envFilesIn(path.join(root, r)).map((e) => ({ ...e, file: `${r}/${e.file}` })))];
  return { packageManager: rootPm, services: services.slice(0, MAX_SERVICES), db: dbs.slice(0, MAX_SERVICES), envFiles };
}
