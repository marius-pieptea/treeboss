/**
 * Refresh the vendored pstack skills from a checkout of cursor/plugins (https://github.com/cursor/plugins, its pstack/ folder):
 *   bun scripts/vendor-pstack.ts <path-to-cursor-plugins-checkout> [--pack <pack-folder>]
 *   bun scripts/vendor-pstack.ts --hashes-only   (rewrite only pack.json's hashes from the files on disk; no checkout)
 * Replaces src/skills/packs/pstack/skills with the listed skills of the checkout's pstack/skills, minus the files that
 * pack.json's exclude globs match. It also copies the LICENSE and sets version (from pstack/plugin.json) and commit (HEAD)
 * in pack.json. The skills and exclude lists are kept as curated: new upstream folders and removed ones are reported, not
 * applied. local/ (skills written in this repo) is never touched. The checkout is only read, never run. Text is stored with
 * LF line endings, as the repository keeps it. pack.json's hashes records a SHA-256 per vendored file (see verifyPackFiles). Use a clean checkout: pack.json records its HEAD.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { packFileHashes } from "../src/skills/packs";

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USAGE = "usage: bun scripts/vendor-pstack.ts <path-to-cursor-plugins-checkout>  |  --hashes-only   [--pack <pack-folder>]";

function die(msg: string): never {
  console.error(`vendor-pstack: ${msg}`);
  process.exit(1);
}

let PACK = path.resolve(import.meta.dir, "..", "src", "skills", "packs", "pstack");
let hashesOnly = false;
const positional: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--hashes-only") hashesOnly = true;
  else if (argv[i] === "--pack") PACK = path.resolve(argv[++i] ?? die(USAGE));
  else positional.push(argv[i]!);
}

/** Rewrite pack.json's hashes from the files now on disk, keeping every other field; `extra` is merged in first. */
function writeManifest(manifestFile: string, old: any, extra: object): void {
  fs.writeFileSync(manifestFile, JSON.stringify({ ...old, ...extra, hashes: packFileHashes(PACK) }, null, 2) + "\n");
}

const manifestFile = path.join(PACK, "pack.json");
if (hashesOnly) {
  if (positional.length) die(USAGE);
  let current: any;
  try {
    current = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  } catch (err: any) {
    die(`${manifestFile} cannot be read (${err.message})`);
  }
  writeManifest(manifestFile, current, {});
  console.log(`pstack hashes: ${Object.keys(packFileHashes(PACK)).length} files, no re-vendoring`);
  process.exit(0);
}
const checkout = positional[0];
if (!checkout || positional.length > 1) die(USAGE);
const root = path.resolve(checkout);

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) die(`git ${args.join(" ")} failed in ${root}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Every file under `dir`, as a forward-slash path relative to it. Symlinks are refused: they could point outside the checkout. */
function filesUnder(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) die(`${r} is a symbolic link; refusing to copy it`);
    return e.isDirectory() ? filesUnder(dir, r) : [r];
  });
}

/** The bytes to store: UTF-8 text with CRLF read as LF; anything else as it is. */
function stored(buf: Buffer): Buffer {
  if (buf.includes(0)) return buf;
  try {
    return Buffer.from(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf).replace(/\r\n/g, "\n"), "utf-8");
  } catch {
    return buf;
  }
}

const src = path.join(root, "pstack");
let plugin: any;
try {
  plugin = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf-8"));
} catch (err: any) {
  die(`${src} has no readable plugin.json (${err.message})`);
}
if (plugin.name !== "pstack") die(`${src}/plugin.json is for "${plugin.name}", not pstack`);
const commit = git(["rev-parse", "HEAD"]).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) die(`git rev-parse HEAD printed "${commit}"`);

const upstreamSkills = path.join(src, "skills");
if (!fs.existsSync(upstreamSkills)) die(`${upstreamSkills} is missing`);
const license = path.join(src, "LICENSE");
if (!fs.existsSync(license)) die(`${license} is missing`);
const names = fs
  .readdirSync(upstreamSkills, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// Everything that can refuse is settled before the first write, so a refusal leaves the tree as it was.
if (!fs.existsSync(manifestFile)) die(`${manifestFile} is missing: write it with the skills to ship`);
let old: any;
try {
  old = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
} catch (err: any) {
  die(`${manifestFile} is not valid JSON (${err.message})`);
}
if (!Array.isArray(old.skills) || old.skills.some((n: unknown) => typeof n !== "string" || !SKILL_NAME.test(n))) die(`${manifestFile} needs a skills list of folder names`);
const listed: string[] = old.skills;
const isExcluded = (() => {
  const patterns = (Array.isArray(old.exclude) ? old.exclude : []).map((g: string) => new Bun.Glob(g));
  return (rel: string) => patterns.some((p: Bun.Glob) => p.match(rel));
})();

// What gets copied: the listed folders that exist upstream, file by file, minus the excluded ones. Files are given as
// <skill>/<path>, the same form the exclude globs match.
const plan: Array<{ rel: string; from: string }> = [];
let excludedCount = 0;
for (const name of listed) {
  if (!names.includes(name)) continue; // gone upstream: reported below
  for (const inner of filesUnder(path.join(upstreamSkills, name))) {
    const rel = `${name}/${inner}`;
    if (isExcluded(rel)) excludedCount++;
    else plan.push({ rel, from: path.join(upstreamSkills, rel) });
  }
}
// Which files git records as executable: read from the index, so it holds on any OS.
const executable = new Set(
  git(["ls-files", "-s", "--", "pstack/skills"])
    .split("\n")
    .filter((l) => l.startsWith("100755 "))
    .map((l) => l.split("\t")[1]!.replace(/^pstack\/skills\//, "")),
);
const fresh = names.filter((n) => !listed.includes(n));
const gone = listed.filter((n) => !names.includes(n));

fs.rmSync(path.join(PACK, "skills"), { recursive: true, force: true });
for (const { rel, from } of plan) {
  const to = path.join(PACK, "skills", rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, stored(fs.readFileSync(from)));
  if (executable.has(rel)) fs.chmodSync(to, 0o755);
}
fs.writeFileSync(path.join(PACK, "LICENSE"), stored(fs.readFileSync(license)));
writeManifest(manifestFile, old, { version: plugin.version, commit });

if (fresh.length) console.warn(`new upstream skills, not in the skills list so not shipped (add them to pack.json to ship): ${fresh.join(", ")}`);
if (gone.length) console.warn(`in the skills list but gone upstream (remove them from pack.json): ${gone.join(", ")}`);
const shipped = listed.filter((n) => names.includes(n)).length;
const shippedExecutable = plan.filter((p) => executable.has(p.rel)).length;
console.log(`pstack ${plugin.version} at ${commit.slice(0, 7)}: ${shipped} skills, ${plan.length} files (${excludedCount} excluded), ${shippedExecutable} executable`);
