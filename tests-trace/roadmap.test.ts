import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START roadmap\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END roadmap\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { listAll } from "../src/attachments";
import { createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { countTasks, specDir, specProgress, checkLink } from "../src/roadmap/progress";
import { addRoadmapItem, cleanRoadmapPath, createRoadmap, listDocChoices, listSpecChoices, readRoadmap, roadmapPath, RoadmapConflict, setRoadmapPath, updateRoadmapItem } from "../src/roadmap/store";
import { startFromItem } from "../src/roadmap/sessions";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "roadmap-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

beforeEach(() => {
  resetState();
  setTurnRunner(null);
  db().exec("CREATE TABLE IF NOT EXISTS roadmap_prefs (root_dir TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db().exec("DELETE FROM roadmap_prefs");
  readRoadmap(makeRepo({ "a.txt": "x\n" })); // makes sure roadmap_sessions exists
  db().exec("DELETE FROM roadmap_sessions");
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const TASKS = `# Tasks

## Phase 1

- [x] T001 One
- [x] T002 Two
- [ ] T003 Three

\`\`\`
- [ ] T999 not a task, it is in a fence
\`\`\`
`;

/** A repo with a roadmap, one feature that has tasks, and a docs folder. */
function project() {
  const dir = makeRepo({
    "README.md": "# demo\n",
    "docs/architecture.md": "# Architecture\n",
    "specs/001-chat/spec.md": "# Feature Specification: Chat\n",
    "specs/001-chat/tasks.md": TASKS,
    "specs/002-empty/spec.md": "# Empty\n",
    "specs/002-empty/tasks.md": "# nothing yet\n",
  });
  createRoadmap(dir, "Demo");
  return dir;
}

describe("progress", () => {
  test("counts checkboxes, ignoring fenced code", () => {
    expect(countTasks(TASKS)).toEqual({ done: 2, total: 3 });
    expect(countTasks("- [X] upper\n  * [ ] nested\n+ [ ] plus\nplain\n")).toEqual({ done: 1, total: 3 });
    expect(countTasks("")).toEqual({ done: 0, total: 0 });
  });
  test("spec links resolve from a folder, a file or a bare name", () => {
    const dir = project();
    for (const v of ["specs/001-chat", "specs/001-chat/", "specs/001-chat/spec.md", "001-chat", "./specs/001-chat"]) expect(specDir(dir, v)).toBe("specs/001-chat");
    expect(specDir(dir, "specs/999-nope")).toBeNull();
    expect(specProgress(dir, "001-chat")).toMatchObject({ dir: "specs/001-chat", done: 2, total: 3, hasTasks: true, status: "in_progress" });
    expect(specProgress(dir, "specs/002-empty")).toMatchObject({ done: 0, total: 0, status: "not_started" });
    expect(specProgress(dir, "specs/999-nope")).toBeNull();
    expect(specProgress(dir, null)).toBeNull();
  });
  test("a finished spec reads done", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "specs/001-chat/tasks.md"), "- [x] a\n- [x] b\n");
    expect(specProgress(dir, "specs/001-chat")!.status).toBe("done");
  });
  test("links that leave the workspace, are absolute or are missing are flagged", () => {
    const dir = project();
    expect(checkLink(dir, "docs/architecture.md", "docs")).toMatchObject({ ok: true, path: "docs/architecture.md" });
    expect(checkLink(dir, "docs/gone.md", "docs")).toMatchObject({ ok: false, reason: "docs/gone.md does not exist" });
    expect(checkLink(dir, "../secrets.md", "docs")).toMatchObject({ ok: false, reason: "outside the workspace" });
    expect(checkLink(dir, "/etc/passwd", "docs")).toMatchObject({ ok: false });
    expect(checkLink(dir, "https://example.com/x", "docs")).toMatchObject({ ok: false });
    expect(checkLink(dir, "specs/999-nope", "spec")).toMatchObject({ ok: false });
    expect(checkLink(dir, null, "spec")).toBeNull();
    // A symlink out of the workspace is outside too.
    fs.symlinkSync("/etc", path.join(dir, "docs/etc-link"));
    expect(checkLink(dir, "docs/etc-link", "docs")).toMatchObject({ ok: false, reason: "outside the workspace" });
  });
});

describe("store", () => {
  test("nothing exists until you create it, and creating never replaces", () => {
    const dir = makeRepo({ "README.md": "# x\n" });
    const none = readRoadmap(dir);
    expect(none).toMatchObject({ exists: false, path: "ROADMAP.md", rev: "none", lanes: [] });
    expect(fs.existsSync(path.join(dir, "ROADMAP.md"))).toBe(false);
    expect(() => addRoadmapItem(dir, { lane: "Now", title: "x" })).toThrow(/Create it first/);
    const made = createRoadmap(dir, "Demo");
    expect(made.lanes.map((l) => l.name)).toEqual(["Now", "Next", "Later"]);
    expect(made.heading).toBe("Demo roadmap");
    expect(() => createRoadmap(dir)).toThrow(/already exists/);
  });
  test("items carry progress, status, broken links and lane rollups", () => {
    const dir = project();
    addRoadmapItem(dir, { lane: "Now", title: "Chat", spec: "specs/001-chat", docs: "docs/architecture.md", tags: ["core"], target: "2026-Q4" });
    addRoadmapItem(dir, { lane: "Now", title: "Ghost", spec: "specs/404-gone", docs: "docs/missing.md" });
    addRoadmapItem(dir, { lane: "Now", title: "Done thing", done: true });
    const state = readRoadmap(dir);
    const [chat, ghost, shipped] = state.lanes[0]!.items;
    expect(chat).toMatchObject({ id: "r1", status: "in_progress", progress: { done: 2, total: 3, status: "in_progress" }, tags: ["core"], target: "2026-Q4", index: 0 });
    expect(chat!.links.spec!.ok && chat!.links.docs!.ok).toBe(true);
    expect(ghost).toMatchObject({ status: "not_started", progress: null });
    expect(ghost!.links.spec!.ok).toBe(false);
    expect(ghost!.links.docs!.ok).toBe(false);
    expect(shipped!.status).toBe("shipped");
    expect(state.broken).toBe(1);
    expect(state.lanes[0]!.progress).toEqual({ items: 3, shipped: 1, inProgress: 1, tasksDone: 2, tasksTotal: 3 });
  });
  test("a stale rev is refused, a current one is accepted, and the file is not touched by the refusal", () => {
    const dir = project();
    const first = readRoadmap(dir);
    addRoadmapItem(dir, { lane: "Now", title: "one" }, first.rev);
    const before = fs.readFileSync(path.join(dir, "ROADMAP.md"), "utf-8");
    expect(() => addRoadmapItem(dir, { lane: "Now", title: "two" }, first.rev)).toThrow(RoadmapConflict);
    expect(fs.readFileSync(path.join(dir, "ROADMAP.md"), "utf-8")).toBe(before);
    // An edit made outside the app is picked up on the next read.
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), before.replace("one", "one, edited by hand"));
    expect(readRoadmap(dir).lanes[0]!.items[0]!.title).toBe("one, edited by hand");
  });
  test("edits are written atomically with no temp files left behind", () => {
    const dir = project();
    for (let i = 0; i < 5; i++) addRoadmapItem(dir, { lane: "Next", title: `n${i}` });
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
  test("the roadmap path is a workspace pref, validated", () => {
    const dir = makeRepo({ "README.md": "# x\n" });
    expect(roadmapPath(dir)).toBe("ROADMAP.md");
    expect(setRoadmapPath(dir, "docs/ROADMAP.md")).toBe("docs/ROADMAP.md");
    expect(roadmapPath(dir)).toBe("docs/ROADMAP.md");
    createRoadmap(dir);
    expect(fs.existsSync(path.join(dir, "docs/ROADMAP.md"))).toBe(true);
    expect(setRoadmapPath(dir, "")).toBe("ROADMAP.md");
    for (const bad of ["../x.md", "/abs.md", "a/../../b.md", "notes.txt", ".git/x.md", "a//b.md"]) expect(() => cleanRoadmapPath(bad)).toThrow();
  });
  test("a roadmap path that goes through a symlink out of the workspace is refused", () => {
    const dir = makeRepo({ "README.md": "# x\n" });
    const outside = fs.mkdtempSync(path.join(path.dirname(dir), "outside-"));
    fs.symlinkSync(outside, path.join(dir, "linked"));
    setRoadmapPath(dir, "linked/ROADMAP.md");
    expect(() => createRoadmap(dir)).toThrow(/leaves the workspace/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  test("pickers list spec folders and docs", () => {
    const dir = project();
    expect(listSpecChoices(dir)).toEqual([
      { path: "specs/001-chat", title: "Chat", done: 2, total: 3 },
      { path: "specs/002-empty", title: "Empty", done: 0, total: 0 },
    ]);
    expect(listDocChoices(dir)).toEqual(["README.md", "ROADMAP.md", "docs/architecture.md"]);
  });
  test("editing an item without an id gives it one without touching the rest", () => {
    const dir = project();
    const file = path.join(dir, "ROADMAP.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("## Now\n", "## Now\n\n- [ ] Hand written\n"));
    const key = readRoadmap(dir).lanes[0]!.items[0]!.key;
    expect(key).toMatch(/^t-/);
    const r = updateRoadmapItem(dir, key, { done: true });
    expect(r.id).toBe("r1");
    expect(fs.readFileSync(file, "utf-8")).toContain("- [x] Hand written {#r1}");
  });
});

describe("sessions from an item", () => {
  test("spec: runs the specs Specify step on a new feature named after the item, linked at once, recorded on the card", async () => {
    const dir = project();
    const { id } = addRoadmapItem(dir, { lane: "Next", title: "Export orders", description: "CSV, filters kept", tags: ["orders"], target: "2026-11" });
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("wrote it")));
    const { session, itemId } = startFromItem(dir, id!, "spec", { engine: "fake" });
    await settled(session.id);
    expect(itemId).toBe("r1");
    expect(session.title).toBe("Specify: Export orders");
    expect(fs.existsSync(path.join(dir, "specs/003-export-orders/spec.md"))).toBe(true);
    expect(prompts[0]).toContain("# Specify: Export orders");
    expect(prompts[0]).toContain("Write: `specs/003-export-orders/spec.md`");
    expect(prompts[0]).toContain("Roadmap item {#r1} in lane \"Next\" of ROADMAP.md: Export orders");
    expect(prompts[0]).toContain("CSV, filters kept");
    const item = readRoadmap(dir).lanes[1]!.items[0]!;
    expect(item.spec).toBe("specs/003-export-orders");
    expect(item.links.spec?.ok).toBe(true);
    expect(item.sessions.map((s) => [s.id, s.kind])).toEqual([[session.id, "spec"]]);
    // The feature is attached to the session like any step of the specs workflow.
    expect(listAll(session.id).map((a) => a.path)).toContain("specs/003-export-orders");
  });
  test("spec: an item that already links a spec revises that one, and a second start does not make another", async () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, "specs/004-chat"), { recursive: true });
    fs.writeFileSync(path.join(dir, "specs/004-chat/spec.md"), "# Feature Specification: Chat\n");
    const { id } = addRoadmapItem(dir, { lane: "Now", title: "Chat", spec: "specs/004-chat" });
    setTurnRunner(async () => ok("ok"));
    const a = startFromItem(dir, id!, "spec", { engine: "fake" });
    await settled(a.session.id);
    const b = startFromItem(dir, id!, "spec", { engine: "fake" });
    await settled(b.session.id);
    expect(fs.readdirSync(path.join(dir, "specs")).filter((d) => d.endsWith("chat")).sort()).toEqual(["001-chat", "004-chat"]);
    expect(readRoadmap(dir).lanes[0]!.items[0]!.spec).toBe("specs/004-chat");
  });
  test("spec: a feature with the item's name is reused instead of failing on the duplicate", async () => {
    const dir = project();
    const first = addRoadmapItem(dir, { lane: "Now", title: "Search" });
    setTurnRunner(async () => ok("ok"));
    const a = startFromItem(dir, first.id!, "spec", { engine: "fake" });
    await settled(a.session.id);
    updateRoadmapItem(dir, first.id!, { spec: null });
    const b = startFromItem(dir, first.id!, "spec", { engine: "fake" });
    await settled(b.session.id);
    expect(fs.readdirSync(path.join(dir, "specs")).filter((d) => d.endsWith("search"))).toEqual(["003-search"]);
    expect(readRoadmap(dir).lanes[0]!.items[0]!.spec).toBe("specs/003-search");
  });
  test("build: attaches the item and its spec by reference; an item without an id is given one first", async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "ROADMAP.md"), fs.readFileSync(path.join(dir, "ROADMAP.md"), "utf-8").replace("## Now\n", "## Now\n\n- [ ] Chat (spec: specs/001-chat)\n"));
    const key = readRoadmap(dir).lanes[0]!.items[0]!.key;
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("working")));
    const { session, itemId } = startFromItem(dir, key, "build", { engine: "fake" });
    await settled(session.id);
    expect(itemId).toBe("r1");
    expect(fs.readFileSync(path.join(dir, "ROADMAP.md"), "utf-8")).toContain("- [ ] Chat {#r1} (spec: specs/001-chat)");
    expect(prompts[0]).toContain("The spec is specs/001-chat");
    expect(prompts[0]).toContain("tick each one");
    expect(prompts[0]).toContain('change its "[ ]" to "[x]"');
  });
  test("a broken spec link is said, not hidden; a bad kind is refused; sending into an open session works", async () => {
    const dir = project();
    const { id } = addRoadmapItem(dir, { lane: "Now", title: "Ghost", spec: "specs/404" });
    setTurnRunner(async () => ok("fine"));
    const prompts: string[] = [];
    setTurnRunner(async (o) => (prompts.push(o.prompt), ok("fine")));
    const a = startFromItem(dir, id!, "build", { engine: "fake" });
    await settled(a.session.id);
    expect(prompts[0]).toContain("which does not exist; say so before starting");
    expect(() => startFromItem(dir, id!, "weird" as any)).toThrow(/Unknown start kind/);
    const open = createLead({ prompt: "hi", engine: "fake", cwd: dir });
    await settled(open.id);
    const b = startFromItem(dir, id!, "spec", { sessionId: open.id });
    await settled(b.session.id);
    expect(b.session.id).toBe(open.id);
    expect(prompts.at(-1)).toContain("# Specify: Ghost");
    expect(readRoadmap(dir).lanes[0]!.items[0]!.sessions.map((s) => s.kind).sort()).toEqual(["build", "spec"].sort());
  });
  test("deleting an item forgets its sessions", async () => {
    const dir = project();
    const { id } = addRoadmapItem(dir, { lane: "Now", title: "Temp" });
    setTurnRunner(async () => ok("x"));
    const { session } = startFromItem(dir, id!, "build", { engine: "fake" });
    await settled(session.id);
    const { deleteRoadmapItem } = await import("../src/roadmap/store");
    deleteRoadmapItem(dir, id!);
    expect(db().prepare("SELECT COUNT(*) AS n FROM roadmap_sessions WHERE root_dir = ? AND item_id = ?").get(fs.realpathSync(dir), id) as any).toEqual({ n: 0 });
  });
});

describe("HTTP routes", () => {
  let srv: ReturnType<typeof startServer>;
  let dir: string;
  let root: string;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  beforeEach(() => {
    dir = makeRepo({ "README.md": "# demo\n", "specs/001-chat/tasks.md": TASKS, "specs/001-chat/spec.md": "# Chat\n" });
    root = Workspaces.open(dir).id;
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  };
  const api = (p = "") => `/api/roadmap/${root}${p}`;

  test("auth is required, and looking creates nothing", async () => {
    const res = await fetch(`${srv.url}${api()}`);
    expect(res.status).toBe(401);
    const r = await call("GET", api());
    expect(r.status).toBe(200);
    expect(r.data.roadmap).toMatchObject({ exists: false, lanes: [] });
    expect(fs.existsSync(path.join(dir, "ROADMAP.md"))).toBe(false);
  });

  test("the whole item lifecycle over HTTP", async () => {
    expect((await call("POST", api("/create"), {})).status).toBe(201);
    expect((await call("POST", api("/create"), {})).status).toBe(400);
    let r = await call("POST", api("/items"), { lane: "Now", title: "Chat", spec: "specs/001-chat", tags: "core, ux", target: "2026-Q4", description: "why" });
    expect(r.status).toBe(201);
    expect(r.data.id).toBe("r1");
    expect(r.data.roadmap.lanes[0].items[0]).toMatchObject({ tags: ["core", "ux"], progress: { done: 2, total: 3 }, description: "why" });
    r = await call("PATCH", api("/items/r1"), { done: true, target: "" });
    expect(r.data.roadmap.lanes[0].items[0]).toMatchObject({ done: true, target: null, status: "shipped" });
    r = await call("POST", api("/items/r1/move"), { lane: "Later", index: 0 });
    expect(r.data.roadmap.lanes[2].items.map((i: any) => i.id)).toEqual(["r1"]);
    r = await call("POST", api("/lanes"), { name: "Parked" });
    expect(r.status).toBe(201);
    expect(r.data.roadmap.lanes.map((l: any) => l.name)).toEqual(["Now", "Next", "Later", "Parked"]);
    r = await call("POST", api("/lanes/rename"), { from: "Parked", to: "Icebox" });
    expect(r.data.roadmap.lanes.at(-1).name).toBe("Icebox");
    expect((await call("POST", api("/lanes/delete"), { name: "Later" })).status).toBe(400); // not empty
    expect((await call("POST", api("/lanes/delete"), { name: "Icebox" })).data.roadmap.lanes).toHaveLength(3);
    r = await call("DELETE", api("/items/r1"));
    expect(r.data.roadmap.lanes.flatMap((l: any) => l.items)).toEqual([]);
  });

  test("a stale rev is a 409; unknown items and lanes are 400; bad paths are refused", async () => {
    await call("POST", api("/create"), {});
    const first = (await call("GET", api())).data.roadmap.rev;
    await call("POST", api("/items"), { lane: "Now", title: "a" });
    expect((await call("POST", api("/items"), { lane: "Now", title: "b", rev: first })).status).toBe(409);
    expect((await call("PATCH", api("/items/nope"), { done: true })).status).toBe(400);
    expect((await call("POST", api("/items"), { lane: "Nowhere", title: "b" })).status).toBe(400);
    expect((await call("POST", api("/items"), { lane: "Now", title: "" })).status).toBe(400);
    expect((await call("PUT", api("/prefs"), { path: "../x.md" })).status).toBe(400);
    expect((await call("GET", "/api/roadmap/w_nope")).status).toBeGreaterThanOrEqual(400);
  });

  test("choices, prefs and start", async () => {
    await call("POST", api("/create"), {});
    const ch = await call("GET", api("/choices"));
    expect(ch.data.specs.map((s: any) => s.path)).toEqual(["specs/001-chat"]);
    expect(ch.data.path).toBe("ROADMAP.md");
    const r = await call("PUT", api("/prefs"), { path: "docs/ROADMAP.md" });
    expect(r.data.roadmap).toMatchObject({ exists: false, path: "docs/ROADMAP.md" });
    await call("PUT", api("/prefs"), { path: "ROADMAP.md" });
    const added = await call("POST", api("/items"), { lane: "Now", title: "Build me" });
    setTurnRunner(async () => ok("on it"));
    const s = await call("POST", api(`/items/${added.data.id}/start`), { kind: "build", engine: "fake" });
    expect(s.status).toBe(201);
    expect(s.data.session.title).toBe("Build: Build me");
    expect(s.data.roadmap.lanes[0].items[0].sessions).toHaveLength(1);
    await settled(s.data.session.id);
  });
});
