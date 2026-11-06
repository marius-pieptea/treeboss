/**
 * Stages what the installer ships: the built web UI, the skill packs, and one compiled `trb` per target. A compiled
 * `trb` cannot read files from src/, so the packs ship beside it, as the web UI does.
 *   bun run stage.ts darwin-arm64 windows-x64 …    (no args: this machine only)
 * Output: desktop/stage/web, desktop/stage/packs, desktop/stage/bin/<target>/trb[.exe]
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(import.meta.dir, "stage");
const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [host];

const run = (cmd: string[], cwd = root) => {
  const r = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
};

run(["bun", "run", "build:web"]);
fs.rmSync(path.join(out, "web"), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, "web", "dist"), path.join(out, "web"), { recursive: true });
fs.rmSync(path.join(out, "packs"), { recursive: true, force: true });
fs.cpSync(path.join(root, "src", "skills", "packs"), path.join(out, "packs"), { recursive: true });

for (const t of targets) {
  const exe = t.startsWith("windows") ? "trb.exe" : "trb";
  const dest = path.join(out, "bin", t, exe);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  run(["bun", "build", "--compile", `--target=bun-${t}`, "--external", "chromium-bidi/*", "--external", "electron", "src/cli/main.ts", "--outfile", dest]);
  console.log(`staged ${t}: ${(fs.statSync(dest).size / 1e6).toFixed(0)} MB`);
}
