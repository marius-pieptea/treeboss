/** Bug capture: the request is validated, the screenshot falls back desktop -> rerender -> none, and what the daemon owns lands in evidence and the finding. */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { _resetRuns, getInstance, startService, stopAllRuns } from "../src/devserver/manager";
import { HttpError } from "../src/daemon/http";
import { db, migrate } from "../src/db";
import { evidenceDir, getEvidence, readPart } from "../src/evidence/store";
import { _resetIssues, recordIssues } from "../src/preview/issues";
import { stripQueryValues } from "../src/search/redact";
import { EXCERPT_BYTES, excerpt, logBug, parseBugReport, type BugReport, type CaptureDeps } from "../src/lab/capture";
import { BUG_KINDS, createBugFinding, findingsDir, listFindings, readFinding } from "../src/lab/findings";
import { makeDir } from "./helpers";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("rest-of-png")]);
const GOOD = { title: "Button is dead", actual: "Click does nothing", url: "http://localhost:5173/app", shot: { kind: "none" } };

const rejects = (body: unknown, re: RegExp) => {
  try {
    parseBugReport(body);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error("expected parseBugReport to throw");
};

describe("parseBugReport", () => {
  test("accepts a minimal report and derives the port from the url", () => {
    const r = parseBugReport(GOOD);
    expect(r).toMatchObject({ title: "Button is dead", port: 5173, shot: { kind: "none" }, attach: { console: true, logs: true } });
  });

  test("decodes a desktop png and a rerender viewport", () => {
    const d = parseBugReport({ ...GOOD, shot: { kind: "desktop", png: PNG.toString("base64") } });
    expect(d.shot.kind === "desktop" && d.shot.png.equals(PNG)).toBe(true);
    expect(parseBugReport({ ...GOOD, shot: { kind: "rerender", viewport: { width: 800.4, height: 600 } } }).shot).toEqual({ kind: "rerender", viewport: { width: 800, height: 600 } });
  });

  test("rejects non-loopback and non-http addresses", () => {
    rejects({ ...GOOD, url: "https://example.com/" }, /localhost/);
    rejects({ ...GOOD, url: "file:///etc/passwd" }, /localhost/);
    rejects({ ...GOOD, url: "not a url" }, /address/);
  });

  test("rejects a missing title, an oversize title or note, and a non-object body", () => {
    rejects({ ...GOOD, title: "  " }, /title/);
    rejects({ ...GOOD, title: "x".repeat(201) }, /title/);
    rejects({ ...GOOD, actual: "x".repeat(10_001) }, /description/);
    rejects({ ...GOOD, expected: "x".repeat(10_001) }, /expected/);
    rejects("nope", /object/);
  });

  test("rejects bad base64, a non-png, and an oversize png", () => {
    rejects({ ...GOOD, shot: { kind: "desktop", png: "!!!not base64!!!" } }, /base64/);
    rejects({ ...GOOD, shot: { kind: "desktop", png: Buffer.from("plain text").toString("base64") } }, /PNG/);
    rejects({ ...GOOD, shot: { kind: "desktop", png: Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]).toString("base64") } }, /MB/);
    rejects({ ...GOOD, shot: { kind: "desktop" } }, /missing/);
    rejects({ ...GOOD, shot: { kind: "rerender", viewport: { width: 0, height: 5 } } }, /viewport/);
    rejects({ ...GOOD, shot: { kind: "weird" } }, /kind/);
  });
});

describe("parseBugReport kind and steps", () => {
  test("kind defaults to functional, accepts each known kind, and rejects others", () => {
    expect(parseBugReport(GOOD).kind).toBe("functional");
    for (const kind of BUG_KINDS) expect(parseBugReport({ ...GOOD, kind }).kind).toBe(kind);
    rejects({ ...GOOD, kind: "cosmetic" }, /kind/);
    rejects({ ...GOOD, kind: 3 }, /kind/);
  });

  test("steps are trimmed, collapsed to one line, and blanks are dropped", () => {
    expect(parseBugReport({ ...GOOD, steps: ['  Go to /checkout ', "", 'Click "Pay"'+'\n now'] }).steps).toEqual(["Go to /checkout", 'Click "Pay" now']);
    expect(parseBugReport(GOOD).steps).toEqual([]);
  });

  test("rejects non-list steps, non-text lines, more than 50 steps and a line over 300 characters", () => {
    rejects({ ...GOOD, steps: "Go to /" }, /steps/);
    rejects({ ...GOOD, steps: ["ok", 4] }, /steps/);
    rejects({ ...GOOD, steps: Array.from({ length: 51 }, () => "x") }, /50/);
    rejects({ ...GOOD, steps: ["x".repeat(301)] }, /300/);
    expect(parseBugReport({ ...GOOD, steps: Array.from({ length: 50 }, () => "x".repeat(300)) }).steps).toHaveLength(50);
  });

  test("note is read as actual when actual is absent, and actual wins when both are given", () => {
    expect(parseBugReport({ title: "T", note: "old client", url: GOOD.url }).actual).toBe("old client");
    expect(parseBugReport({ title: "T", note: "old", actual: "new", expected: "fine", url: GOOD.url })).toMatchObject({ actual: "new", expected: "fine" });
  });
});

describe("parseBugReport feature", () => {
  test("absent and null are no feature; a feature id is kept", () => {
    expect(parseBugReport(GOOD).feature).toBeNull();
    expect(parseBugReport({ ...GOOD, feature: null }).feature).toBeNull();
    expect(parseBugReport({ ...GOOD, feature: "checkout" }).feature).toBe("checkout");
    expect(parseBugReport({ ...GOOD, feature: "a".repeat(60) }).feature).toBe("a".repeat(60));
  });

  test("anything that is not a feature id is a 400", () => {
    for (const feature of ["Checkout", "", "-x", "has space", "a".repeat(61), 3, ["cart"]]) rejects({ ...GOOD, feature }, /feature must be a feature id\./);
  });
});

describe("excerpt", () => {
  test("keeps the newest lines inside the byte cap and counts them", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(40)}`);
    const e = excerpt(lines);
    expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(e.text.endsWith(lines[499]!)).toBe(true);
    expect(e.count).toBe(e.text.split("\n").length);
    expect(e.count).toBeLessThan(500);
  });

  test("truncates one line that alone exceeds the cap", () => {
    const e = excerpt(["y".repeat(EXCERPT_BYTES * 2)]);
    expect(e.count).toBe(1);
    expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  test("keeps the tail of an over-long final line, where the error usually is", () => {
    const e = excerpt(["short line", "x".repeat(5000) + " ERROR: the real message is at the end"]);
    expect(e.text).toContain("ERROR: the real message is at the end");
    expect(e.text.startsWith("…")).toBe(true);
    expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(e.text).not.toContain("�");
  });

  test("redacts secrets", () => {
    expect(excerpt(["Authorization: Bearer abcdefghijklmnop1234"]).text).not.toContain("abcdefghijklmnop1234");
  });
});

const report = (over: Partial<BugReport> = {}): BugReport => ({ title: "Button is dead", kind: "functional", steps: [], expected: "", actual: "Click does nothing", url: "http://localhost:4000/", port: 4000, shot: { kind: "none" }, attach: { console: true, logs: true }, ...over });
const shooter = (r: { path: string } | { error: string }): CaptureDeps => ({ shoot: async () => r, write: createBugFinding });

afterEach(async () => {
  await stopAllRuns();
  _resetRuns();
  _resetIssues();
  db().exec("DELETE FROM evidence");
});

describe("secrets in the url", () => {
  const URL_IN = "http://localhost:3000/gate?code=pin-4242-secret&page=2#x";

  test("parseBugReport keeps the address as sent; only logBug strips it", () => {
    expect(parseBugReport({ title: "t", url: URL_IN }).url).toBe(URL_IN);
  });

  test("stripQueryValues blanks every value, keeps names, and covers a query or pairs in the hash", () => {
    expect(stripQueryValues("http://localhost/g?a=1&a=2&b&c%6Fde=x")).toBe("http://localhost/g?a=[redacted]&a=[redacted]&b&c%6Fde=[redacted]");
    expect(stripQueryValues("http://localhost/g#/r?tok=1&x=2")).toBe("http://localhost/g#/r?tok=[redacted]&x=[redacted]");
    expect(stripQueryValues("http://localhost/g?a=1#access_token=zz&state=q")).toBe("http://localhost/g?a=[redacted]#access_token=[redacted]&state=[redacted]");
    expect(stripQueryValues("http://localhost/g#section")).toBe("http://localhost/g#section");
    expect(stripQueryValues("http://localhost/g")).toBe("http://localhost/g");
  });

  test("a logged bug stores no query value anywhere, while the re-render sees the real page", async () => {
    const root = makeDir();
    const tmp = path.join(makeDir(), "shot.png");
    fs.writeFileSync(tmp, PNG);
    const shot: string[] = [];
    const deps: CaptureDeps = { shoot: async (o) => (shot.push(o.url), { path: tmp }), write: createBugFinding };
    const out = await logBug(root, parseBugReport({ title: "t", url: URL_IN, shot: { kind: "rerender", viewport: { width: 800, height: 600 } }, attach: { console: false, logs: false } }), deps);
    expect(shot).toEqual([URL_IN]);
    const f = readFinding(root, out.finding.id);
    expect(f.bug!.url).toBe("http://localhost:3000/gate?code=[redacted]&page=[redacted]#x");
    expect(out.capture!.url).toBe(f.bug!.url);
    const dump = [JSON.stringify(out), JSON.stringify(f), fs.readFileSync(path.join(findingsDir(root), `${out.finding.id}.md`), "utf8"), ...fs.readdirSync(evidenceDir(out.capture!.id)).filter((n) => n !== "screenshot.png").map((n) => fs.readFileSync(path.join(evidenceDir(out.capture!.id), n), "utf8")), JSON.stringify(db().query("SELECT * FROM evidence").all())].join(" ");
    expect(dump).not.toContain("pin-4242");
  });
});

describe("logBug", () => {
  test("a logged bug reads back as a bug finding with its keys, no problem and no missing evidence", async () => {
    const root = makeDir();
    recordIssues(4000, [{ level: "error", text: "boom" }]);
    const out = await logBug(root, report({ shot: { kind: "desktop", png: PNG } }));
    for (const f of [readFinding(root, out.finding.id), listFindings(root).find((x) => x.id === out.finding.id)!]) {
      expect(f.lens).toBe("bug");
      expect(f.bug).toEqual({ url: "http://localhost:4000/", capture: out.capture!.id, shot: "desktop", kind: "functional", feature: null });
      expect(f.problem).toBeNull();
      expect(f.missing).toEqual([]);
      expect(f.evidence).toEqual([]);
      expect(f.status).toBe("new");
    }
  });

  test("the body has the steps as a numbered list, then expected, actual, and the kind is stored", async () => {
    const root = makeDir();
    recordIssues(4000, [{ level: "error", text: "boom" }]);
    const out = await logBug(root, report({ kind: "logic", steps: ["Go to /cart", 'Click "Pay now" button', "Type token=sk_live_abcdef123456 into Notes"], expected: "A receipt", actual: "A blank page" }));
    const b = out.finding.body;
    expect(b.indexOf("## Steps to reproduce")).toBeLessThan(b.indexOf("## Expected"));
    expect(b.indexOf("## Expected")).toBeLessThan(b.indexOf("## Actual"));
    expect(b.indexOf("## Actual")).toBeLessThan(b.indexOf("## Console"));
    expect(b).toContain("## Steps to reproduce\n\n1. Go to /cart\n2. Click \"Pay now\" button\n3. Type token=");
    expect(b).toContain("## Expected\n\nA receipt");
    expect(b).toContain("## Actual\n\nA blank page");
    expect(b).not.toContain("sk_live_abcdef123456");
    expect(readFinding(root, out.finding.id).bug!.kind).toBe("logic");
  });

  test("sections with no content are left out, and a report with none of them falls back to the title", async () => {
    const root = makeDir();
    const only = await logBug(root, report({ actual: "", steps: ["Go to /"] }));
    expect(only.finding.body).toBe("## Steps to reproduce\n\n1. Go to /");
    const bare = await logBug(root, report({ actual: "" }));
    expect(bare.finding.body).toBe("Button is dead");
  });

  test("a logged bug is filed under its feature, and an agent's bug carries found_by but no confirmed line", async () => {
    const root = makeDir();
    const filed = await logBug(root, report({ feature: "checkout" }));
    expect(filed.finding.bug).toMatchObject({ feature: "checkout" });
    expect(readFinding(root, filed.finding.id).bug?.feature).toBe("checkout");
    const plain = await logBug(root, report({ title: "Other bug" }));
    expect(plain.finding.bug).toMatchObject({ feature: null });
    expect(plain.finding.bug).not.toHaveProperty("by");
    const agent = await logBug(root, report({ title: "Agent bug", byAgent: true, feature: "cart" }));
    expect(agent.finding.bug).toEqual({ url: "http://localhost:4000/", capture: null, shot: "none", kind: "functional", by: "agent", feature: "cart" });
    const file = fs.readFileSync(path.join(root, agent.finding.path), "utf8");
    expect(file).toMatch(/^found_by: agent$/m);
    expect(file).toMatch(/^feature: cart$/m);
    expect(file).not.toContain("confirmed");
  });

  test("an empty console and log still write the finding, with no evidence item", async () => {
    const root = makeDir();
    const out = await logBug(root, report());
    expect(out.capture).toBeNull();
    expect(out.shotNote).toBeNull();
    expect(out.finding.title).toBe("Button is dead");
    expect(out.finding.body).toBe("## Actual\n\nClick does nothing");
    expect(out.finding.body).not.toContain("## Console");
  });

  test("a desktop screenshot and a redacted console are stored as parts, and the body carries the excerpt", async () => {
    const root = makeDir();
    recordIssues(4000, [{ level: "error", text: "TypeError: x is undefined", page: "/app" }, { level: "failed-request", text: "GET /api 500 api_key=sk_live_abcdef123456" }]);
    const out = await logBug(root, report({ shot: { kind: "desktop", png: PNG } }));
    const item = getEvidence(out.capture!.id)!;
    expect(item.kind).toBe("bug");
    expect(Object.keys(item.files).sort()).toEqual(["console.txt", "meta.json", "screenshot.png"]);
    expect(readPart(item, "screenshot.png")!.buf.equals(PNG)).toBe(true);
    const con = fs.readFileSync(path.join(evidenceDir(item.id), "console.txt"), "utf8");
    expect(con).toContain("TypeError: x is undefined");
    expect(con).not.toContain("sk_live_abcdef123456");
    expect(JSON.parse(fs.readFileSync(path.join(evidenceDir(item.id), "meta.json"), "utf8"))).toMatchObject({ url: "http://localhost:4000/", shot: "desktop" });
    expect(out.finding.body).toContain("## Console (last 2)");
    expect(out.finding.body).not.toContain("sk_live_abcdef123456");
  });

  test("attach.console=false leaves the console out", async () => {
    const root = makeDir();
    recordIssues(4000, [{ level: "error", text: "boom" }]);
    const out = await logBug(root, report({ attach: { console: false, logs: true } }));
    expect(out.capture).toBeNull();
    expect(out.finding.body).not.toContain("boom");
  });

  test("the console body is capped at 4 KB while console.txt keeps the whole ring", async () => {
    const root = makeDir();
    recordIssues(4000, Array.from({ length: 50 }, (_, i) => ({ level: "error", text: `failure number ${i} ${"z".repeat(300)}` })));
    const out = await logBug(root, report());
    const section = out.finding.body.split("## Console")[1]!;
    expect(Buffer.byteLength(section)).toBeLessThan(EXCERPT_BYTES + 200);
    expect(fs.readFileSync(path.join(evidenceDir(out.capture!.id), "console.txt"), "utf8").split("\n").filter(Boolean)).toHaveLength(50);
  });

  test("rerender that works is stored as a rerender shot and the temp file is removed", async () => {
    const root = makeDir();
    const tmp = path.join(makeDir(), "shot.png");
    fs.writeFileSync(tmp, PNG);
    const out = await logBug(root, report({ shot: { kind: "rerender", viewport: { width: 800, height: 600 } } }), shooter({ path: tmp }));
    expect(out.shotNote).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(evidenceDir(out.capture!.id), "meta.json"), "utf8"))).toMatchObject({ shot: "rerender", viewport: { width: 800, height: 600 } });
    expect(fs.existsSync(tmp)).toBe(false);
  });

  test("a failed rerender falls back to none with a note", async () => {
    const root = makeDir();
    const out = await logBug(root, report({ shot: { kind: "rerender", viewport: { width: 800, height: 600 } } }), shooter({ error: "Chrome missing" }));
    expect(out.capture).toBeNull();
    expect(out.shotNote).toContain("Chrome missing");
    expect(out.finding.title).toBe("Button is dead");
  });

  test("desktop wins over the shooter, which is never called", async () => {
    const root = makeDir();
    let called = false;
    const out = await logBug(root, report({ shot: { kind: "desktop", png: PNG } }), { shoot: async () => ((called = true), { error: "x" }), write: createBugFinding });
    expect(called).toBe(false);
    expect(out.capture).not.toBeNull();
  });

  test("the server log of the service on that port is stored and excerpted", async () => {
    const root = makeDir();
    fs.writeFileSync(path.join(root, "server.ts"), `const s = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("hi") });\nconsole.log("ready on http://localhost:" + s.port);`);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "bun server.ts" } }));
    await startService({ rootDir: root, owner: "w_t", service: "dev" });
    const until = Date.now() + 15000;
    let svc = getInstance(root, "dev")!;
    while (Date.now() < until && svc.status === "starting") {
      await new Promise((r) => setTimeout(r, 50));
      svc = getInstance(root, "dev")!;
    }
    await new Promise((r) => setTimeout(r, 300));
    const out = await logBug(fs.realpathSync(root), report({ url: `http://localhost:${svc.port}/`, port: svc.port }));
    const item = getEvidence(out.capture!.id)!;
    const log = fs.readFileSync(path.join(evidenceDir(item.id), "server.log"), "utf8");
    expect(log).toContain(`[trb] $ npm run dev`);
    // A real line the service printed, not just trb's start line: this fails when the service never started.
    expect(log).toContain("ready on http://localhost:");
    expect(out.finding.body).toContain("ready on http://localhost:");
    expect(JSON.parse(fs.readFileSync(path.join(evidenceDir(item.id), "meta.json"), "utf8")).service).toBe("dev");
    expect(out.finding.body).toContain("## Server log (last ");
  }, 30_000);
});

describe("evidence kind bug", () => {
  test("an older evidence table is widened once to accept bug, keeping its rows and indexes", () => {
    const old = new Database(path.join(makeDir(), "old.db"), { create: true });
    old.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('page','note')), title TEXT NOT NULL, url TEXT, summary TEXT NOT NULL DEFAULT '', refs_json TEXT, files_json TEXT, bytes INTEGER NOT NULL DEFAULT 0, sha TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    old.run("INSERT INTO evidence (id, workspace, kind, title) VALUES ('e_old', '/w', 'page', 'Old')");
    migrate(old);
    migrate(old);
    old.run("INSERT INTO evidence (id, workspace, kind, title) VALUES ('e_bug', '/w', 'bug', 'New')");
    expect(old.prepare("SELECT COUNT(*) AS n FROM evidence").get()).toEqual({ n: 2 });
    expect(() => old.run("INSERT INTO evidence (id, workspace, kind, title) VALUES ('e_x', '/w', 'other', 't')")).toThrow();
    expect(old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence' AND name LIKE 'idx_%' ORDER BY name").all()).toEqual([{ name: "idx_evidence_investigation" }, { name: "idx_evidence_workspace" }]);
    old.close();
  });
});
