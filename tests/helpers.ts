import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { db } from "../src/db";
import { getSession, wait } from "../src/sessions/manager";

export const sh = (cmd: string, cwd: string): string => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};

/** A git repo with one commit and a file, in a temp dir. */
export function makeRepo(files: Record<string, string> = { "a.txt": "one\n" }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trb-repo-")));
  sh("git init -q -b main .", dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  sh("git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init", dir);
  return dir;
}

export function makeDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trb-dir-")));
}

/** Block until a session's turn has settled. */
export async function settled(id: string, timeoutSec = 30) {
  await wait({ operator: true }, [id], { timeoutSec });
  const s = getSession(id)!;
  if (s.status === "running") throw new Error(`session ${id} still running after ${timeoutSec}s`);
  return s;
}

export function resetState(): void {
  db().exec("DELETE FROM events; DELETE FROM turns; DELETE FROM session_waits; DELETE FROM sessions; DELETE FROM pairs; DELETE FROM mcp_servers; DELETE FROM skills; DELETE FROM settings;");
}
