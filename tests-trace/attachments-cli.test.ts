import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START attachments-cli\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END attachments-cli\n"); });
/** `trb attachments …`: a real CLI against a real daemon. */
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

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-attach-cli-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb attachments", () => {
  test("attach any kind by path, list with cost, switch to paste, detach", async () => {
    const repo = makeRepo({ "specs/001-chat/spec.md": "# Chat\n", "plans/2026-10-08-a.md": "---\ntitle: A\n---\n# A\n", "docs/architecture.md": "# Architecture\n\nText.\n" });
    const id = (await trb(["run", "-e", "fake", "-d", "-C", repo, "SAY hi"])).stdout.trim();
    expect(id).toMatch(/^s_/);

    let r = await trb(["attachments", id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing attached");

    r = await trb(["attachments", id, "specs/001-chat", "plans/2026-10-08-a.md", "docs/architecture.md"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("attached");
    for (const kind of ["spec", "plan", "doc"]) expect(r.stdout).toMatch(new RegExp(`${kind}\\s`));
    expect(r.stdout).toContain("pointer");
    expect(r.stdout).toMatch(/about \d+ tokens in all/);

    r = await trb(["attachments", id, "docs/architecture.md", "--inline"]);
    expect(r.stdout).toMatch(/docs\/architecture\.md\s+pasted/);

    r = await trb(["attachments", id, "plans/2026-10-08-a.md", "--detach"]);
    expect(r.stdout).toContain("detached");
    expect(r.stdout).not.toContain("plans/2026-10-08-a.md  ");

    const json = JSON.parse((await trb(["attachments", id, "--json"])).stdout);
    expect(json.attached.map((a: any) => a.path).sort()).toEqual(["docs/architecture.md", "specs/001-chat"]);

    r = await trb(["attachments", id, "docs/missing.md"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("does not exist");
  });
});
