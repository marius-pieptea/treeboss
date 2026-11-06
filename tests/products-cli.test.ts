/** `trb product …` and `trb portfolio`: a real CLI against a real daemon. */
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-products-home-"));
  repo = makeRepo({ "README.md": "# demo\n" });
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb product and trb portfolio", () => {
  test("empty state points at the way in", async () => {
    for (const args of [["product", "ls"], ["portfolio"]]) {
      const r = await trb(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('no products yet: trb product new "<name>"');
    }
  });

  test("create, attach, set status and budget, list, portfolio", async () => {
    let r = await trb(["product", "new", "Acme", "Cloud", "-D", "The main app"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created Acme Cloud \(acme-cloud, \S+\)/);

    r = await trb(["product", "attach", "acme-cloud", "-r", "web"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/attached w_\S+ to Acme Cloud \(web\)/);

    r = await trb(["product", "set-status", "acme-cloud", "building"]);
    expect(r.stdout).toContain("Acme Cloud is building");
    r = await trb(["product", "budget", "acme-cloud", "50"]);
    expect(r.stdout).toContain("Acme Cloud: budget $50.00 a month");

    r = await trb(["product", "ls"]);
    expect(r.code).toBe(0);
    for (const s of ["Acme Cloud", "acme-cloud", "building", "1 repo", "$0 of $50.00 this month"]) expect(r.stdout).toContain(s);

    r = await trb(["product", "show", "acme-cloud"]);
    expect(r.stdout).toContain("status    building");
    expect(r.stdout).toContain("about     The main app");
    expect(r.stdout).toContain("budget    $50.00 a month");
    expect(r.stdout).toContain(path.basename(repo));

    r = await trb(["portfolio"]);
    expect(r.code).toBe(0);
    for (const s of ["Acme Cloud", "acme-cloud", "building", "0/0 shipped", "$0 of $50.00 this month", "web", path.basename(repo), "no roadmap", "no verify run"]) {
      expect(r.stdout).toContain(s);
    }

    const json = JSON.parse((await trb(["portfolio", "--json"])).stdout);
    expect(json.products[0]).toMatchObject({ slug: "acme-cloud", status: "building", budget_usd_month: 50 });
    expect(json.products[0].repos[0].role).toBe("web");
  });

  test("clear the budget, detach, and bad input fails with a message", async () => {
    let r = await trb(["product", "budget", "acme-cloud", "none"]);
    expect(r.stdout).toContain("Acme Cloud: no budget");
    r = await trb(["product", "detach", "acme-cloud"]);
    expect(r.stdout).toMatch(/detached w_\S+ from Acme Cloud/);
    r = await trb(["portfolio"]);
    expect(r.stdout).toContain("no repos attached");

    r = await trb(["product", "set-status", "acme-cloud", "bogus"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    r = await trb(["product", "show", "nope"]);
    expect(r.code).not.toBe(0);
    r = await trb(["product", "frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Usage: trb product");
  });
});
