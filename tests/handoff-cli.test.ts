import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeRepo } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;

async function trb(args: string[], cwd = os.tmpdir()) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], { cwd, env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
async function idle(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await trb(["show", id, "--json"]);
    if (r.code === 0 && !/"status":\s*"running"/.test(r.stdout.split('"children"')[0])) return;
    await Bun.sleep(100);
  }
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-handoff-cli-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb handoff / compact", () => {
  test("--print shows the summary and starts nothing; the real thing starts a linked session", async () => {
    const repo = makeRepo();
    const first = (await trb(["run", "-e", "fake", "-d", "-C", repo, "Build the thing\nSAY built\nUSAGE 150000"])).stdout.trim();
    expect(first).toMatch(/^s_/);
    await idle(first);

    const preview = await trb(["handoff", first, "--print", "--no-model"]);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("## Goal");
    expect(preview.stdout).toContain("Build the thing");
    expect((await trb(["ls", "--json"])).stdout.match(/"id"/g)).toHaveLength(1);

    const started = await trb(["handoff", first, "--no-model", "-d", "-i", "Keep going."]);
    expect(started.code).toBe(0);
    const next = started.stdout.trim();
    expect(next).toMatch(/^s_/);
    expect(next).not.toBe(first);
    await idle(next);
    expect(JSON.parse((await trb(["show", next, "--json"])).stdout).session.handoff_from).toBe(first);

    const compacted = await trb(["compact", first, "-d"]);
    expect(compacted.code).toBe(0);
    await idle(first);
    expect(JSON.parse((await trb(["show", first, "--json"])).stdout).session.compactions).toBe(1);
  }, 60_000);

  test("fails clearly for an unknown session", async () => {
    const r = await trb(["handoff", "s_nope", "--print"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/s_nope|No session/);
  });
});
