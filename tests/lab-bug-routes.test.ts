import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { createBugFinding, readFinding, writeFinding } from "../src/lab/findings";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const TOKEN = "lab-bug-routes-token";

let srv: ReturnType<typeof startServer>;
let dir: string;
let root: string;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => {
  srv.stop();
});
beforeEach(() => {
  resetState();
  dir = makeRepo({ "a.txt": "x\n" });
  root = Workspaces.open(dir).id;
});

async function call(p: string, method = "GET", body?: unknown) {
  const res = await fetch(`${srv.url}/api/lab/${root}/${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const bug = (feature: string | null = null) => createBugFinding(dir, { title: "Dead button", body: "It breaks.", bug: { url: "http://localhost:3000/x", capture: null, shot: "none", kind: "functional", feature }, impact: "medium", effort: "s" });
const uiFinding = () => writeFinding(dir, "f1", { title: "Off by a pixel", lens: "ui", scope: "web", impact: "high", effort: "s", status: "new", evidence: [] }, "It is off.");
const REPORT = { title: "Cart total wrong", actual: "Shows 0", url: "http://localhost:3000/cart", shot: { kind: "none" }, attach: { console: false, logs: false } };

describe("PATCH /api/lab/:root/findings/:id feature", () => {
  test("a valid feature is stored on the bug, and null clears it", async () => {
    const f = bug();
    const set = await call(`findings/${f.id}`, "PATCH", { feature: "checkout" });
    expect(set.status).toBe(200);
    expect(set.data.finding.bug.feature).toBe("checkout");
    expect(readFinding(dir, f.id).bug?.feature).toBe("checkout");
    const cleared = await call(`findings/${f.id}`, "PATCH", { feature: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data.finding.bug.feature).toBeNull();
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).not.toMatch(/^feature:/m);
  });

  test("a feature can be set together with a status, and a status alone leaves the feature", async () => {
    const f = bug("cart");
    const both = await call(`findings/${f.id}`, "PATCH", { status: "accepted", feature: "checkout" });
    expect(both.data.finding).toMatchObject({ status: "accepted", bug: { feature: "checkout" } });
    const only = await call(`findings/${f.id}`, "PATCH", { status: "shipped" });
    expect(only.data.finding).toMatchObject({ status: "shipped", bug: { feature: "checkout" } });
  });

  test("a feature that is not a feature id, or not text, is a 400 and changes nothing", async () => {
    const f = bug("cart");
    for (const feature of ["Not An Id", "", "-x", "a".repeat(61), 4, ["cart"]]) {
      const r = await call(`findings/${f.id}`, "PATCH", { feature });
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/feature/);
    }
    expect(readFinding(dir, f.id).bug?.feature).toBe("cart");
  });

  test("a feature on a finding that is not a bug is a 400", async () => {
    const f = uiFinding();
    const r = await call(`findings/${f.id}`, "PATCH", { feature: "checkout" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/bug/);
    expect(readFinding(dir, f.id).status).toBe("new");
  });

  test("a finding that does not exist is refused, as every other Lab PATCH is", async () => {
    const r = await call("findings/bug-nothing", "PATCH", { feature: "checkout" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/no finding/i);
  });
});

describe("PATCH confirmed is gone", () => {
  test("confirmed is a 400 with its name, for true and false, on an agent bug and on a person's bug, and nothing is written", async () => {
    const f = bug();
    const before = fs.readFileSync(path.join(dir, f.path), "utf8");
    for (const confirmed of [true, false]) {
      const r = await call(`findings/${f.id}`, "PATCH", { confirmed, status: "accepted" });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe("Unknown field confirmed.");
    }
    expect(fs.readFileSync(path.join(dir, f.path), "utf8")).toBe(before);
  });
});

describe("bug routes", () => {
  test("POST bugs/fix-all no longer exists", async () => {
    bug();
    const r = await call("bugs/fix-all", "POST", {});
    expect(r.status).toBe(404);
  });

  test("POST findings/:id/fix refuses a bug with a 400 and starts no fix", async () => {
    const f = bug();
    const r = await call(`findings/${f.id}/fix`, "POST", {});
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("Bugs are fixed from the QA view.");
    expect(readFinding(dir, f.id)).toMatchObject({ status: "new", fixSession: null });
  });

  test("POST bugs files the bug under the given feature", async () => {
    const r = await call("bugs", "POST", { ...REPORT, feature: "checkout" });
    expect(r.status).toBe(201);
    expect(r.data.finding.bug).toMatchObject({ feature: "checkout" });
    expect(readFinding(dir, r.data.finding.id).bug?.feature).toBe("checkout");
  });

  test("POST bugs with a null or absent feature files it under none", async () => {
    for (const body of [{ ...REPORT, feature: null }, { ...REPORT, title: "Second" }]) {
      const r = await call("bugs", "POST", body);
      expect(r.status).toBe(201);
      expect(r.data.finding.bug.feature).toBeNull();
    }
  });

  test("POST bugs with a bad feature is a 400 and writes no finding", async () => {
    const r = await call("bugs", "POST", { ...REPORT, feature: "Not An Id" });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("feature must be a feature id.");
    expect(fs.existsSync(path.join(dir, "lab/findings"))).toBe(false);
  });
});
