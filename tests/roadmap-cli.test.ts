/** `trb roadmap …`: a real CLI against a real daemon. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { makeRepo } from "./helpers";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;
let repo: string;

async function trb(args: string[], cwd = repo) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd,
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-roadmap-home-"));
  repo = makeRepo({ "README.md": "# demo\n", "specs/001-chat/tasks.md": "- [x] T1 a\n- [ ] T2 b\n", "specs/001-chat/spec.md": "# Chat\n" });
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb roadmap", () => {
  test("looking creates nothing; init writes the template once", async () => {
    let r = await trb(["roadmap", "show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no ROADMAP.md yet: trb roadmap init");
    expect(fs.existsSync(path.join(repo, "ROADMAP.md"))).toBe(false);
    r = await trb(["roadmap", "add", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("trb roadmap init");
    r = await trb(["roadmap", "init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("wrote ROADMAP.md");
    expect((await trb(["roadmap", "init"])).code).not.toBe(0);
  });

  test("add, edit, move, done, show, rm", async () => {
    let r = await trb(["roadmap", "add", "Ship", "chat", "--lane", "Now", "--tag", "core,ux", "--target", "2026-Q4", "--spec", "specs/001-chat", "-D", "Realtime"]);
    expect(r.stdout).toContain("added r1: Ship chat");
    await trb(["roadmap", "add", "Billing", "--lane", "Next"]);
    const text = () => fs.readFileSync(path.join(repo, "ROADMAP.md"), "utf-8");
    expect(text()).toContain("- [ ] Ship chat {#r1} (spec: specs/001-chat) (tag: core, ux) (target: 2026-Q4)\n  Realtime");

    r = await trb(["roadmap", "show"]);
    expect(r.stdout).toContain("Now");
    expect(r.stdout).toContain("Ship chat");
    expect(r.stdout).toContain("1/2"); // spec progress
    expect(r.stdout).toContain("#core #ux");
    expect(r.stdout).toContain("@2026-Q4");
    r = await trb(["roadmap", "show", "--lane", "next"]);
    expect(r.stdout).toContain("Billing");
    expect(r.stdout).not.toContain("Ship chat");
    r = await trb(["roadmap", "show", "--tag", "core"]);
    expect(r.stdout).toContain("Ship chat");
    expect(r.stdout).not.toContain("Billing");
    const json = JSON.parse((await trb(["roadmap", "show", "--json"])).stdout);
    expect(json.lanes[0].items[0]).toMatchObject({ id: "r1", progress: { done: 1, total: 2 } });

    r = await trb(["roadmap", "move", "r2", "Now", "--index", "0"]);
    expect(r.stdout).toContain("moved r2 to Now");
    expect(text().indexOf("Billing")).toBeLessThan(text().indexOf("Ship chat"));
    r = await trb(["roadmap", "move", "{#r2}", "Later"]);
    expect(r.code).toBe(0);

    expect((await trb(["roadmap", "done", "r1"])).stdout).toContain("r1 shipped");
    expect(text()).toContain("- [x] Ship chat {#r1}");
    expect((await trb(["roadmap", "done", "r1", "--undo"])).stdout).toContain("reopened");

    r = await trb(["roadmap", "edit", "r1", "--title", "Ship chat v2", "--target", ""]);
    expect(r.stdout).toContain("updated r1");
    expect(text()).toContain("- [ ] Ship chat v2 {#r1} (spec: specs/001-chat) (tag: core, ux)\n");
    expect((await trb(["roadmap", "edit", "r1"])).code).not.toBe(0);

    r = await trb(["roadmap", "move", "r1", "Nowhere"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No lane "Nowhere"');
    r = await trb(["roadmap", "rm", "r2"]);
    expect(r.stdout).toContain("removed r2");
    expect(text()).not.toContain("Billing");
    expect((await trb(["roadmap", "rm", "r99"])).code).not.toBe(0);
  });

  test("a hand-written item keeps its place and gains an id only when touched", async () => {
    const file = path.join(repo, "ROADMAP.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("## Next\n", "## Next\n\n- [ ] Written by hand\n"));
    const before = fs.readFileSync(file, "utf-8");
    const shown = await trb(["roadmap", "show"]);
    expect(shown.stdout).toContain("Written by hand");
    expect(fs.readFileSync(file, "utf-8")).toBe(before); // reading never writes
    await trb(["roadmap", "add", "Another", "--lane", "Next"]);
    expect(fs.readFileSync(file, "utf-8")).toContain("- [ ] Written by hand\n"); // still without an id
    const json = JSON.parse((await trb(["roadmap", "show", "--json"])).stdout);
    const hand = json.lanes.flatMap((l: any) => l.items).find((i: any) => i.title === "Written by hand");
    expect(hand.id).toBeNull();
    await trb(["roadmap", "done", hand.key]);
    expect(fs.readFileSync(file, "utf-8")).toMatch(/- \[x\] Written by hand \{#r\d+\}/);
  });

  test("unknown subcommand prints usage", async () => {
    const r = await trb(["roadmap", "frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Usage: trb roadmap");
  });
});
