/** The Evidence module: the store, the tools an agent calls, the settings wiring, and a real capture when Chrome exists. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync as __afs } from "fs";
const __log = (m: string) => __afs(process.env.TRACE_LOG!, new Date().toISOString() + " " + m + "\n");
const __test: any = (name: string, fn: any, timeout?: number) => __test(name, async () => { __log("START " + name); try { return await fn(); } finally { __log("END " + name); } }, timeout);
__test.skip = test.skip;
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { findChrome } from "../src/browser/chrome";
import { closeBrowser, rootOf, shutdownBrowsers } from "../src/browser/manager";
import { db, migrate } from "../src/db";
import { EVIDENCE_TOOL_NAMES, evidenceToolDefs } from "../src/evidence/defs";
import { REA_VERSION, reaLaunch } from "../src/evidence/rea";
import { buildPrompt, closeInvestigation, getInvestigation, listInvestigations, openInvestigationFor, removeInvestigation, startInvestigation } from "../src/evidence/investigations";
import { MAX_ITEMS, addEvidence, evidenceDir, evidenceHint, evidenceHintLine, getEvidence, listEvidence, readPart, removeEvidence } from "../src/evidence/store";
import { executeEvidenceTool } from "../src/evidence/tools";
import { buildRunMcpConfig } from "../src/mcp/store";
import { getSetting, resetSetting, setSetting } from "../src/settings";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { effectiveKind, runPrompt, startInvestigationRun } from "../src/evidence/runs";
import { detectTargetKind, macExecutable } from "../src/evidence/detect";
import { Workspaces } from "../src/workspaces";
import { makeDir, resetState, settled } from "./helpers";

__log("COLLECT L24");
const chrome = findChrome({ fresh: true });
if (!chrome) console.warn("[evidence tests] page capture SKIPPED: no Chrome found (set TRB_CHROME to run them)");
__log("COLLECT L26");
const t = chrome ? __test : __test.skip;

__log("COLLECT L28");
const reset = () => {
  resetState();
  db().exec("DELETE FROM evidence; DELETE FROM investigations; DELETE FROM investigation_runs");
  for (const k of ["evidence", "rea_mcp", "rea_command", "agent_browser"]) resetSetting(k);
};
__log("COLLECT L33");
beforeEach(reset);
__log("COLLECT L34");
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  reset();
});

__log("COLLECT L40");
const page = (workspace: string, title: string, extra: Partial<Parameters<typeof addEvidence>[0]> = {}) => addEvidence({ workspace, kind: "page", title, url: "https://example.com/", files: { "page.html": "<h1>x</h1>" }, ...extra });
__log("COLLECT L41");
const lead = async (cwd = makeDir()) => (await settled(createLead({ prompt: "SAY ready", engine: "fake", cwd }).id)).id;
__log("COLLECT L42");
const call = (name: string, args: Record<string, unknown>, sessionId: string) => executeEvidenceTool(name, args, { sessionId });

__log("COLLECT L44");
describe("store", () => {
  __test("an item is files plus an index row, scoped to its project", () => {
    const a = makeDir();
    const b = makeDir();
    const item = page(a, "Pricing", { summary: "three cards", files: { "page.html": "<h1>Pricing</h1>", "styles.json": "{}" } });
    expect(item.id).toMatch(/^e_/);
    expect(item.bytes).toBe("<h1>Pricing</h1>".length + 2);
    expect(item.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(readPart(item, "page.html")!.buf.toString()).toBe("<h1>Pricing</h1>");
    expect(getEvidence(item.id, a)?.title).toBe("Pricing");
    expect(getEvidence(item.id, b)).toBeNull(); // another project cannot see it by id
    expect(listEvidence(b)).toEqual([]);
  });

  __test("a note may cite only evidence of its own project", () => {
    const a = makeDir();
    const b = makeDir();
    const shot = page(a, "Home");
    expect(() => addEvidence({ workspace: b, kind: "note", title: "x", refs: [shot.id], files: { "note.md": "x" } })).toThrow(/Cannot cite/);
    const note = addEvidence({ workspace: a, kind: "note", title: "Radius", refs: [shot.id, shot.id], files: { "note.md": "8px" } });
    expect(note.refs).toEqual([shot.id]);
  });

  __test("search matches every word in title, url or summary and treats % literally", () => {
    const dir = makeDir();
    page(dir, "Stripe pricing", { url: "https://stripe.com/pricing" });
    page(dir, "100% uptime page");
    expect(listEvidence(dir, { query: "stripe pricing" }).length).toBe(1);
    expect(listEvidence(dir, { query: "stripe.com" }).length).toBe(1);
    expect(listEvidence(dir, { query: "100%" }).map((e) => e.title)).toEqual(["100% uptime page"]);
    expect(listEvidence(dir, { query: "%" }).map((e) => e.title)).toEqual(["100% uptime page"]);
    expect(listEvidence(dir, { kind: "note" })).toEqual([]);
  });

  __test("bad part names are refused and leave nothing behind", () => {
    const dir = makeDir();
    const before = fs.readdirSync(evidenceDir("x").replace(/x$/, "")).length;
    expect(() => addEvidence({ workspace: dir, kind: "page", title: "t", files: { "../escape": "x" } })).toThrow(/Bad evidence part/);
    expect(fs.readdirSync(evidenceDir("x").replace(/x$/, "")).length).toBe(before);
    expect(listEvidence(dir)).toEqual([]);
  });

  __test("remove deletes the row and the folder; another project cannot remove it", () => {
    const a = makeDir();
    const item = page(a, "Gone");
    expect(removeEvidence(item.id, makeDir())).toBe(false);
    expect(fs.existsSync(evidenceDir(item.id))).toBe(true);
    expect(removeEvidence(item.id, a)).toBe(true);
    expect(fs.existsSync(evidenceDir(item.id))).toBe(false);
    expect(getEvidence(item.id)).toBeNull();
  });

  __test("a project is capped", () => {
    const dir = makeDir();
    const insert = db().prepare("INSERT INTO evidence (id, workspace, kind, title) VALUES (?, ?, 'note', 't')");
    const key = fs.realpathSync(dir);
    for (let i = 0; i < MAX_ITEMS; i++) insert.run(`e_fill${i}`, key);
    expect(() => page(dir, "one too many")).toThrow(/already holds/);
  });

  __test("the hint names the newest items, and is silent for an empty project", () => {
    const dir = makeDir();
    expect(evidenceHint(dir)).not.toContain("already holds");
    const e = page(dir, "Landing");
    expect(evidenceHint(dir)).toContain(`${e.id} "Landing"`);
  });

  __test("no project to look in means no hint, not a crash (a handoff fixture has no base_cwd)", () => {
    expect(evidenceHintLine("")).toBeNull();
    expect(evidenceHintLine(undefined as unknown as string)).toBeNull();
    expect(evidenceHint("")).not.toContain("already holds");
  });
});

__log("COLLECT L118");
describe("agent tools", () => {
  __test("every tool has a manual and a schema, and the names match the dispatcher's set", () => {
    const defs = evidenceToolDefs();
    expect(defs.map((d) => d.name).sort()).toEqual([...EVIDENCE_TOOL_NAMES].sort());
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(60);
      expect(d.inputSchema.type).toBe("object");
    }
  });

  __test("on by default: the evidence tools and REA are on, and a note is saved", async () => {
    resetSetting("evidence");
    resetSetting("rea_mcp");
    expect(getSetting("evidence")).toBe("on");
    expect(getSetting("rea_mcp")).toBe("on");
    const dir = makeDir();
    const id = await lead(dir);
    const r = await call("evidence_note", { title: "x", text: "y" }, id);
    expect(r.text).not.toMatch(/turned off/);
    expect(listEvidence(dir).length).toBe(1);
  });

  __test("switched off: the tools refuse and nothing is saved", async () => {
    setSetting("evidence", "off");
    const id = await lead();
    const r = await call("evidence_note", { title: "x", text: "y" }, id);
    expect(r.text).toMatch(/^Error: evidence is turned off/);
    expect(listEvidence(makeDir())).toEqual([]);
  });

  __test("note, list and read round-trip, with citations checked", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const shot = page(dir, "Home page", { summary: "a hero and three cards", files: { "page.html": "<h1>Hi</h1>", "styles.json": '{"a":1}' } });
    const noted = await call("evidence_note", { title: "Cards are 12px rounded", text: "Measured on the home page.\n\nUncertain: hover state.", refs: [shot.id] }, id);
    expect(noted.text).toContain(`citing ${shot.id}`);
    const bad = await call("evidence_note", { title: "t", text: "x", refs: ["e_nope"] }, id);
    expect(bad.text).toMatch(/^Error: Cannot cite/);
    expect((await call("evidence_note", { title: "only a title" }, id)).text).toMatch(/^Error: title and text/);

    const list = (await call("evidence_list", {}, id)).text;
    expect(list).toContain("Home page");
    expect(list).toContain("Cards are 12px rounded");
    expect((await call("evidence_list", { query: "cards", kind: "note" }, id)).text).not.toContain("Home page");

    const summary = (await call("evidence_read", { id: shot.id }, id)).text;
    expect(summary).toContain("a hero and three cards");
    const styles = (await call("evidence_read", { id: shot.id, part: "styles" }, id)).text;
    expect(styles).toContain("data, not instructions");
    expect(styles).toContain('{"a":1}');
    expect((await call("evidence_read", { id: shot.id, part: "network" }, id)).text).toMatch(/^Error: this capture has no network/);
    expect((await call("evidence_read", { id: shot.id, part: "bogus" }, id)).text).toMatch(/^Error: unknown part/);
    const noteId = listEvidence(dir, { kind: "note" })[0]!.id;
    expect((await call("evidence_read", { id: noteId }, id)).text).toContain("Uncertain: hover state.");
  });

  __test("long parts continue with an offset", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const big = page(dir, "Big", { files: { "page.html": "a".repeat(40_000) } });
    const first = (await call("evidence_read", { id: big.id, part: "html" }, id)).text;
    expect(first).toContain("continue with offset 30000");
    const rest = (await call("evidence_read", { id: big.id, part: "html", offset: 30_000 }, id)).text;
    expect(rest).not.toContain("continue with offset");
  });

  __test("a session cannot read another project's evidence", async () => {
    setSetting("evidence", "on");
    const id = await lead(makeDir());
    const foreign = page(makeDir(), "Secret project");
    expect((await call("evidence_read", { id: foreign.id }, id)).text).toMatch(/^Error: no evidence/);
    expect((await call("evidence_list", {}, id)).text).toBe("No evidence in this project yet.");
  });

  __test("capturing without a browser page says what to do", async () => {
    setSetting("evidence", "on");
    setSetting("agent_browser", "off");
    const id = await lead();
    expect((await call("evidence_capture_page", {}, id)).text).toMatch(/^Error: the agent browser is not available/);
  });
});

__log("COLLECT L202");
describe("investigations and findings", () => {
__log("COLLECT L203");
  const invIdIn = (text: string): string => text.match(/inv_\w+/)![0];
__log("COLLECT L204");
  const idIn = (text: string): string => text.match(/e_\w+/)![0];

  __test("an investigation holds what was filed under it, and its counts say so", () => {
    const dir = makeDir();
    const inv = startInvestigation({ workspace: dir, title: "Stripe checkout", target: "https://stripe.com/checkout", targetKind: "web" });
    expect(inv).toMatchObject({ status: "open", target_kind: "web", summary: "", closed_at: null, counts: { pages: 0, notes: 0, findings: 0, new: 0, planned: 0, built: 0, dismissed: 0 } });
    page(dir, "Checkout", { investigationId: inv.id });
    addEvidence({ workspace: dir, kind: "note", title: "Plain", investigationId: inv.id, files: { "note.md": "x" } });
    addEvidence({ workspace: dir, kind: "note", title: "Email first", investigationId: inv.id, finding: "feature", files: { "note.md": "x" } });
    addEvidence({ workspace: dir, kind: "note", title: "Button", investigationId: inv.id, finding: "ui", files: { "note.md": "x" } });
    expect(getInvestigation(inv.id, dir)!.counts).toEqual({ pages: 1, notes: 3, findings: 2, new: 2, planned: 0, built: 0, dismissed: 0 });
    expect(listInvestigations(dir).map((i) => i.id)).toEqual([inv.id]);
    expect(listEvidence(dir, { investigationId: inv.id, finding: "feature" }).map((e) => e.title)).toEqual(["Email first"]);
    expect(listEvidence(dir, { finding: "any" }).length).toBe(2);
    expect(listEvidence(dir, { finding: "any", findingStatus: "built" })).toEqual([]);
  });

  __test("investigations are listed newest first, closed with a summary, and never seen from another project", () => {
    const dir = makeDir();
    const first = startInvestigation({ workspace: dir, title: "First" });
    const second = startInvestigation({ workspace: dir, title: "Second", targetKind: "binary" });
    expect(listInvestigations(dir).map((i) => i.title)).toEqual(["Second", "First"]);
    expect(() => startInvestigation({ workspace: dir, title: "x", targetKind: "gif" })).toThrow(/Unknown target kind/);
    expect(() => startInvestigation({ workspace: dir, title: "  " })).toThrow(/needs a title/);
    expect(getInvestigation(second.id, makeDir())).toBeNull();
    const closed = closeInvestigation(first.id, dir, "Found the flow.");
    expect(closed).toMatchObject({ status: "closed", summary: "Found the flow." });
    expect(closed.closed_at).not.toBeNull();
  });

  __test("the session's open investigation is the most recent one it started and has not closed", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const a = invIdIn((await call("investigation_start", { title: "Run A" }, id)).text);
    const b = invIdIn((await call("investigation_start", { title: "Run B" }, id)).text);
    expect(openInvestigationFor(id, dir)?.id).toBe(b);
    expect((await call("investigation_close", { summary: "Done with B." }, id)).text).toMatch(/^Closed inv_/);
    expect(openInvestigationFor(id, dir)?.id).toBe(a);
    expect((await call("investigation_close", { summary: "" }, id)).text).toMatch(/^Error: summary is required/);
    expect((await call("investigation_close", { id: a, summary: "Done." }, id)).text).toMatch(/^Closed /);
    expect((await call("investigation_close", { summary: "Done." }, id)).text).toMatch(/^Error: no open investigation/);
    expect((await call("investigation_list", {}, id)).text).toContain(`${b}  [closed]  Run B`);
  });

  __test("a note is filed under the session's open investigation by default, or under the one it names", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const mine = invIdIn((await call("investigation_start", { title: "Mine" }, id)).text);
    await call("evidence_note", { title: "Radius is 8px", text: "Measured." }, id);
    expect(listEvidence(dir, { kind: "note" })[0]).toMatchObject({ investigation_id: mine, source: "agent", finding: null });

    const older = startInvestigation({ workspace: dir, title: "Older run" });
    await call("evidence_note", { title: "Old run note", text: "x", investigation: older.id }, id);
    expect(listEvidence(dir, { investigationId: older.id }).map((e) => e.title)).toEqual(["Old run note"]);

    const foreign = startInvestigation({ workspace: makeDir(), title: "Elsewhere" });
    expect((await call("evidence_note", { title: "t", text: "x", investigation: foreign.id }, id)).text).toMatch(/^Error: No investigation/);
    expect((await call("evidence_list", { investigation: foreign.id }, id)).text).toMatch(/^Error: no investigation/);

    const bare = await lead(makeDir());
    await call("evidence_note", { title: "No investigation here", text: "x" }, bare);
    expect(listEvidence(makeDir()).length).toBe(0);
  });

  __test("evidence_finding records a feature or a design, and set_status moves it along", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const inv = invIdIn((await call("investigation_start", { title: "Pricing page", target: "https://example.com/pricing", target_kind: "web" }, id)).text);
    const f = await call("evidence_finding", { title: "Annual toggle", text: "Switches prices to yearly.", kind: "feature" }, id);
    expect(f.text).toMatch(/^Saved finding e_\w+ \(feature, new\) in inv_/);
    const fid = idIn(f.text);
    expect(getEvidence(fid, dir)).toMatchObject({ kind: "note", finding: "feature", finding_status: "new", source: "agent", investigation_id: inv });

    const ui = idIn((await call("evidence_finding", { title: "Cards", text: "12px radius, 1px border.", kind: "ui", refs: [fid] }, id)).text);
    expect(getEvidence(ui, dir)).toMatchObject({ finding: "ui", refs: [fid] });
    expect((await call("evidence_finding", { title: "Cards", text: "x", kind: "design" }, id)).text).toMatch(/^Error: kind must be/);

    expect((await call("evidence_set_status", { id: fid, status: "planned" }, id)).text).toBe(`${fid} "Annual toggle" is now planned.`);
    expect(getEvidence(fid, dir)!.finding_status).toBe("planned");
    expect((await call("evidence_set_status", { id: fid, status: "shipped" }, id)).text).toMatch(/^Error: Unknown status/);
    const plain = idIn((await call("evidence_note", { title: "Plain conclusion", text: "x" }, id)).text);
    expect((await call("evidence_set_status", { id: plain, status: "built" }, id)).text).toMatch(/^Error: .* is not a finding/);

    const planned = (await call("evidence_list", { finding: "feature", status: "planned" }, id)).text;
    expect(planned).toContain("Annual toggle");
    expect(planned).toContain("[note, agent, finding feature, planned]");
    expect(planned).not.toContain("Cards");
    expect((await call("evidence_list", { status: "built" }, id)).text).toBe("No evidence matches those filters.");
    expect((await call("evidence_list", { finding: "any" }, id)).text).toContain("Cards");
  });

  __test("evidence_save_result keeps JSON and text as they came, redacted, and pages the result back", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const big = { nodes: ["a".repeat(30_000)], limits: "static analysis only" };
    const saved = await call("evidence_save_result", { title: "REA: call graph", tool: "get_call_graph", result: JSON.stringify(big), summary: "Call graph of the login handler." }, id);
    expect(saved.text).toMatch(/^Saved e_\w+: "REA: call graph", \d+ KB \(rea\.json\)/);
    const jid = idIn(saved.text);
    const jitem = getEvidence(jid, dir)!;
    expect(jitem).toMatchObject({ kind: "note", source: "rea", finding: null, summary: "Call graph of the login handler." });
    expect(Object.keys(jitem.files).sort()).toEqual(["note.md", "rea.json"]);

    const first = (await call("evidence_read", { id: jid, part: "result" }, id)).text;
    expect(first).toContain("continue with offset 30000");
    const rest = (await call("evidence_read", { id: jid, part: "result", offset: 30_000 }, id)).text;
    expect(rest).not.toContain("continue with offset");
    expect(rest).toContain("static analysis only");
    expect((await call("evidence_read", { id: jid }, id)).text).toContain("Read it with part result");

    const text = await call("evidence_save_result", { title: "Strings", tool: "list_strings", result: "plain output\ntoken sk-ant-abcdefghijklmnopqrstuvwxyz", source: "agent" }, id);
    const tid = idIn(text.text);
    expect(text.text).toContain("(rea.txt)");
    const tfile = getEvidence(tid, dir)!;
    expect(tfile).toMatchObject({ source: "agent" });
    expect(Object.keys(tfile.files)).toContain("rea.txt");
    expect(readPart(tfile, "rea.txt")!.buf.toString()).toContain("plain output");
    expect(readPart(tfile, "rea.txt")!.buf.toString()).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");

    expect((await call("evidence_save_result", { title: "Huge", result: "x".repeat(1_000_001) }, id)).text).toMatch(/^Error: the result is/);
    expect((await call("evidence_save_result", { title: "Empty", result: "  " }, id)).text).toMatch(/^Error: title and result/);
    const shot = page(dir, "Home");
    expect((await call("evidence_read", { id: shot.id, part: "result" }, id)).text).toMatch(/^Error: unknown part "result"/);
    const plainNote = idIn((await call("evidence_note", { title: "No result", text: "x" }, id)).text);
    expect((await call("evidence_read", { id: plainNote, part: "result" }, id)).text).toMatch(/^Error: .* has no saved result/);
  });

  __test("findings and investigations of another project are refused", async () => {
    setSetting("evidence", "on");
    const a = makeDir();
    const b = makeDir();
    const mine = await lead(a);
    const theirs = await lead(b);
    const inv = invIdIn((await call("investigation_start", { title: "A's run" }, mine)).text);
    const f = idIn((await call("evidence_finding", { title: "A's feature", text: "x", kind: "feature" }, mine)).text);

    expect((await call("evidence_finding", { title: "t", text: "x", kind: "ui", investigation: inv }, theirs)).text).toMatch(/^Error: No investigation/);
    expect((await call("investigation_close", { id: inv, summary: "x" }, theirs)).text).toMatch(/^Error: no investigation/);
    expect((await call("evidence_set_status", { id: f, status: "built" }, theirs)).text).toMatch(/^Error: No evidence/);
    expect((await call("evidence_read", { id: f }, theirs)).text).toMatch(/^Error: no evidence/);
    expect(getInvestigation(inv, b)).toBeNull();
    expect(getInvestigation(inv, a)).not.toBeNull();
    expect(getEvidence(f, a)!.finding_status).toBe("new");
    expect(() => buildPrompt(b, [f])).toThrow(/No evidence/);
  });

  __test("the build prompt cites the evidence, names the design system, and refuses what cannot be built", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const inv = invIdIn((await call("investigation_start", { title: "Linear issues", target: "https://linear.app", target_kind: "web" }, id)).text);
    const shot = page(dir, "Issue list", { investigationId: inv });
    const feature = idIn((await call("evidence_finding", { title: "Command palette", text: "Opens on Cmd+K and filters as you type.", kind: "feature", refs: [shot.id] }, id)).text);
    const design = idIn((await call("evidence_finding", { title: "Sidebar density", text: "Rows are 28px high with 13px type.", kind: "ui" }, id)).text);
    const long = idIn((await call("evidence_finding", { title: "Long one", text: "y".repeat(5_000), kind: "feature" }, id)).text);

    const prompt = buildPrompt(dir, [feature, design, feature]);
    expect(prompt).toContain("# Build these 2 findings");
    expect(prompt).toContain("Opens on Cmd+K");
    expect(prompt).toContain("Rows are 28px high");
    expect(prompt).toContain(`\`${shot.id}\` Issue list`);
    expect(prompt).toContain("Kind: feature");
    expect(prompt).toContain("Kind: UI design");
    expect(prompt).toContain("Linear issues (https://linear.app)");
    expect(prompt).toContain("DESIGN.md");
    expect(prompt).toContain("design/tokens.css");
    expect(prompt).toContain("evidence_read");
    expect(prompt).toContain("evidence_set_status");
    expect(prompt.split("## ").length - 1).toBe(2);
    expect(buildPrompt(dir, [long])).toContain("[cut at 4000 characters");

    expect(() => buildPrompt(dir, [shot.id])).toThrow(/is not a finding/);
    expect(() => buildPrompt(dir, ["e_nope"])).toThrow(/No evidence "e_nope"/);
    expect(() => buildPrompt(dir, [])).toThrow(/at least one finding/);
    expect(() => buildPrompt(dir, Array.from({ length: 21 }, (_, i) => `e_${i}`))).toThrow(/at most 20/);
  });

  __test("closing, reopening, renaming and removing an investigation keep or drop its evidence as asked", () => {
    const dir = makeDir();
    const inv = startInvestigation({ workspace: dir, title: "Old" });
    const kept = addEvidence({ workspace: dir, kind: "note", title: "kept", investigationId: inv.id, files: { "note.md": "x" } });
    expect(removeInvestigation(inv.id, makeDir(), { withEvidence: false })).toBe(false);
    expect(removeInvestigation(inv.id, dir, { withEvidence: false })).toBe(true);
    expect(getInvestigation(inv.id, dir)).toBeNull();
    expect(getEvidence(kept.id, dir)!.investigation_id).toBeNull();

    const gone = startInvestigation({ workspace: dir, title: "Gone" });
    const doomed = addEvidence({ workspace: dir, kind: "note", title: "doomed", investigationId: gone.id, files: { "note.md": "x" } });
    expect(removeInvestigation(gone.id, dir, { withEvidence: true })).toBe(true);
    expect(getEvidence(doomed.id, dir)).toBeNull();
    expect(fs.existsSync(evidenceDir(doomed.id))).toBe(false);
  });

  __test("the schema migrates additively: an older evidence table gains the new columns, and its rows still read", () => {
    const file = path.join(makeDir(), "old.db");
    const old = new Database(file, { create: true });
    old.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('page','note')), title TEXT NOT NULL, url TEXT, summary TEXT NOT NULL DEFAULT '', refs_json TEXT, files_json TEXT, bytes INTEGER NOT NULL DEFAULT 0, sha TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    old.run("INSERT INTO evidence (id, workspace, kind, title, summary, files_json, bytes) VALUES ('e_old', '/somewhere', 'page', 'Old capture', 'a summary', '{\"page.html\":5}', 5)");
    migrate(old);
    migrate(old);
    expect(old.prepare("SELECT id, title, summary, investigation_id, finding, finding_status, source FROM evidence WHERE id = 'e_old'").get()).toEqual({ id: "e_old", title: "Old capture", summary: "a summary", investigation_id: null, finding: null, finding_status: null, source: null });
    expect(() => old.run("INSERT INTO evidence (id, workspace, kind, title, finding) VALUES ('e_bad', '/x', 'note', 't', 'opinion')")).toThrow();
    expect(() => old.run("INSERT INTO investigations (id, workspace, title, target_kind) VALUES ('inv_bad', '/x', 't', 'phone')")).toThrow();
    expect(old.prepare("SELECT COUNT(*) AS n FROM investigations").get()).toEqual({ n: 0 });
    old.close();
  });
});

__log("COLLECT L415");
describe("investigation runs", () => {
__log("COLLECT L416");
  const runs = (inv: string) => db().prepare("SELECT session_id, note FROM investigation_runs WHERE investigation_id = ? ORDER BY rowid").all(inv);
  /** REA "starts" through a command that exists, so runs on app, binary and other targets are allowed. */
__log("COLLECT L418");
  const reaOn = () => {
    setSetting("rea_mcp", "on");
    setSetting("rea_command", "/bin/echo mcp");
  };

  __test("a run is a lead session in the project, linked to the investigation, and its brief is the run prompt", async () => {
    reaOn();
    const dir = makeDir();
    const inv = startInvestigation({ workspace: dir, title: "Acme app", target: makeDir(), targetKind: "electron" });
    const s = startInvestigationRun(dir, inv.id, { engine: "fake", note: "focus on sync" });
    expect(s).toMatchObject({ base_cwd: dir, mode: "build", isolation: "none" });
    expect(getSession(s.id)!.brief).toContain(`Pass investigation: ${inv.id}`);
    expect(getSession(s.id)!.brief).toContain("The operator asks you to focus on: focus on sync");
    await settled(s.id);
    expect(runs(inv.id)).toEqual([{ session_id: s.id, note: "focus on sync" }]);
    expect(getInvestigation(inv.id, dir)).toMatchObject({ session_id: s.id, status: "open", running: false });
  });

  __test("preflight refusals say what is missing, and start nothing", () => {
    const dir = makeDir();
    const bin = startInvestigation({ workspace: dir, title: "Tool", target: makeDir(), targetKind: "binary" });
    const none = startInvestigation({ workspace: dir, title: "No target", targetKind: "web" });
    const gone = startInvestigation({ workspace: dir, title: "Gone", target: "/nope/does-not-exist.app", targetKind: "electron" });
    const site = startInvestigation({ workspace: dir, title: "Site", target: "https://example.com", targetKind: "web" });
    const opts = { engine: "fake" };

    setSetting("evidence", "off");
    expect(() => startInvestigationRun(dir, bin.id, opts)).toThrow(/Evidence is turned off/);
    setSetting("evidence", "on");
    setSetting("rea_mcp", "off");
    expect(() => startInvestigationRun(dir, bin.id, opts)).toThrow(/REA, the reverse-engineering server, which is off/);
    reaOn();
    expect(() => startInvestigationRun(dir, gone.id, opts)).toThrow(/No file or folder at \/nope\/does-not-exist\.app/);
    expect(() => startInvestigationRun(dir, none.id, opts)).toThrow(/has no target to run on/);
    setSetting("agent_browser", "off");
    expect(() => startInvestigationRun(dir, site.id, opts)).toThrow(/agent browser, which is off/);
    expect(() => startInvestigationRun(makeDir(), bin.id, opts)).toThrow(/No investigation/);
    expect(runs(bin.id)).toEqual([]);
    expect(getInvestigation(bin.id, dir)!.session_id).toBeNull();
  });

  __test("a run still going refuses a second; the runs are listed newest first with their status", async () => {
    reaOn();
    const dir = makeDir();
    const inv = startInvestigation({ workspace: dir, title: "Acme", target: makeDir(), targetKind: "other" });
    const first = startInvestigationRun(dir, inv.id, { engine: "fake" });
    await settled(first.id);
    db().prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(first.id);
    expect(getInvestigation(inv.id, dir)).toMatchObject({ running: true, runs: [{ session_id: first.id, status: "running" }] });
    expect(() => startInvestigationRun(dir, inv.id, { engine: "fake" })).toThrow(/already running/);
    db().prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(first.id);

    const second = startInvestigationRun(dir, inv.id, { engine: "fake", note: "second pass" });
    await settled(second.id);
    const detail = getInvestigation(inv.id, dir)!;
    expect(detail.runs.map((r) => [r.session_id, r.status, r.note])).toEqual([
      [second.id, "idle", "second pass"],
      [first.id, "idle", null],
    ]);
    expect(detail.running).toBe(false);
    expect(listInvestigations(dir)[0]!.runs[0]!.session_id).toBe(second.id);
  });

  __test("a run's session files what it records under the investigation, and a closed investigation is reopened by a run", async () => {
    reaOn();
    const dir = makeDir();
    const inv = startInvestigation({ workspace: dir, title: "Acme", target: makeDir(), targetKind: "other" });
    const s = startInvestigationRun(dir, inv.id, { engine: "fake" });
    await settled(s.id);
    expect(openInvestigationFor(s.id, dir)?.id).toBe(inv.id);
    await call("evidence_note", { title: "Sync indicator", text: "A dot at the top right." }, s.id);
    expect(listEvidence(dir, { investigationId: inv.id }).map((e) => e.title)).toEqual(["Sync indicator"]);

    closeInvestigation(inv.id, dir, "Done.");
    expect(openInvestigationFor(s.id, dir)).toBeNull();
    const again = startInvestigationRun(dir, inv.id, { engine: "fake" });
    expect(getInvestigation(inv.id, dir)).toMatchObject({ status: "open", closed_at: null, session_id: again.id });
    expect(openInvestigationFor(again.id, dir)?.id).toBe(inv.id);

    expect(removeInvestigation(inv.id, dir, { withEvidence: false })).toBe(true);
    expect(runs(inv.id)).toEqual([]);
  });

  __test("the brief is specific to the kind of target, refuses to build, and treats a web address as web", () => {
    const dir = makeDir();
    const make = (kind: string, target: string | null, note?: string) => {
      const inv = startInvestigation({ workspace: dir, title: `Probe ${kind}`, target, targetKind: kind });
      return runPrompt(getInvestigation(inv.id, dir)!, note);
    };
    const web = make("web", "https://acme.test");
    expect(web).toContain("browser_navigate");
    expect(web).toContain("evidence_capture_page");
    expect(web).not.toContain("list_electron_targets");
    expect(make("electron", "/Applications/Acme.app")).toMatch(/list_electron_targets[\s\S]*Contents\/Resources\/app\.asar/);
    expect(make("binary", "/usr/bin/true")).toMatch(/binary_overview[\s\S]*Ghidra, Hopper or IDA/);
    expect(make("android", "/tmp/app.apk")).toContain("inspect_android_package");
    expect(make("other", "/tmp/blob")).toContain("inspect_artifact");
    expect(make("electron", "/Applications/Acme.app", "look at the sync")).toContain("The operator asks you to focus on: look at the sync");
    for (const p of [web, make("binary", "/usr/bin/true")]) {
      expect(p).toContain("Do not build, change or delete anything");
      expect(p).toContain("investigation_close");
      expect(p.split("\n").length).toBeLessThan(60);
    }
    expect(effectiveKind({ target: "https://acme.test", target_kind: "other" })).toBe("web");
    expect(effectiveKind({ target: "/Applications/Acme.app", target_kind: "electron" })).toBe("electron");
    expect(effectiveKind({ target: null, target_kind: "other" })).toBe("other");
  });
});

__log("COLLECT L527");
describe("target kind detection", () => {
__log("COLLECT L528");
  const write = (file: string, content: string | Buffer): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
__log("COLLECT L533");
  const plist = (exe?: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleName</key>\n\t<string>Acme</string>${exe ? `\n\t<key>CFBundleExecutable</key>\n\t<string>${exe}</string>` : ""}\n</dict></plist>\n`;
  /** A macOS app whose code is an Electron one: Info.plist and the app.asar marker. */
__log("COLLECT L535");
  const electronApp = (dir: string): string => {
    const app = path.join(dir, "Acme.app");
    write(path.join(app, "Contents", "Info.plist"), plist("Acme"));
    write(path.join(app, "Contents", "Resources", "app.asar"), "asar");
    return app;
  };
  /** A native macOS app: its executable is named in Info.plist and starts with a Mach-O magic. */
__log("COLLECT L542");
  const nativeApp = (dir: string): string => {
    const app = path.join(dir, "Native.app");
    write(path.join(app, "Contents", "Info.plist"), plist("NativeTool"));
    write(path.join(app, "Contents", "MacOS", "NativeTool"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    return app;
  };

  __test("a URL or a bare domain is web; a path that is not there is other, not found", () => {
    expect(detectTargetKind("https://example.com/pricing")).toEqual({ kind: "web", reason: "http(s) URL" });
    expect(detectTargetKind("stripe.com/checkout").kind).toBe("web");
    expect(detectTargetKind("/nope/Acme.app")).toEqual({ kind: "other", reason: "not found" });
    expect(detectTargetKind("app.apk")).toEqual({ kind: "other", reason: "not found" });
    expect(detectTargetKind("  ")).toEqual({ kind: "other", reason: "no target given" });
  });

  __test("a macOS app is electron when its code is Electron, and binary when it is native; the executable is named", () => {
    const dir = makeDir();
    const electron = electronApp(dir);
    expect(detectTargetKind(electron)).toEqual({ kind: "electron", reason: "Electron app: Contents/Resources/app.asar" });

    const framework = path.join(dir, "Framework.app");
    write(path.join(framework, "Contents", "Info.plist"), plist("Framework"));
    write(path.join(framework, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"), "x");
    expect(detectTargetKind(framework)).toEqual({ kind: "electron", reason: "Electron app: Contents/Frameworks/Electron Framework.framework" });

    const native = nativeApp(dir);
    expect(detectTargetKind(native)).toEqual({ kind: "binary", reason: "native macOS app; executable Contents/MacOS/NativeTool" });
    expect(macExecutable(native)).toBe(path.join(native, "Contents", "MacOS", "NativeTool"));

    const solo = path.join(dir, "Solo.app");
    write(path.join(solo, "Contents", "Info.plist"), plist());
    write(path.join(solo, "Contents", "MacOS", "Solo"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    expect(detectTargetKind(solo)).toEqual({ kind: "binary", reason: "native macOS app; executable Contents/MacOS/Solo" });

    const binaryPlist = path.join(dir, "Binary.app");
    write(path.join(binaryPlist, "Contents", "Info.plist"), Buffer.from("bplist00\u0000\u0001"));
    expect(detectTargetKind(binaryPlist)).toEqual({ kind: "binary", reason: "native macOS app" });
    expect(macExecutable(binaryPlist)).toBeNull();
  });

  __test("an asar, an APK, and binaries and wasm are told apart by extension and magic bytes", () => {
    const dir = makeDir();
    expect(detectTargetKind(write(path.join(dir, "app.asar"), "asar"))).toEqual({ kind: "electron", reason: "asar archive: Electron app code" });
    expect(detectTargetKind(write(path.join(dir, "app.apk"), "PK\u0003\u0004 not really a zip"))).toEqual({ kind: "android", reason: "Android package (.apk)" });
    expect(detectTargetKind(write(path.join(dir, "macho"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])))).toEqual({ kind: "binary", reason: "Mach-O binary" });
    expect(detectTargetKind(write(path.join(dir, "fat"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])))).toEqual({ kind: "binary", reason: "Mach-O universal or Java class" });
    expect(detectTargetKind(write(path.join(dir, "elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])))).toEqual({ kind: "binary", reason: "ELF executable or shared library" });
    expect(detectTargetKind(write(path.join(dir, "tool.exe"), "MZ\u0090\u0000"))).toEqual({ kind: "binary", reason: "Windows PE executable" });
    expect(detectTargetKind(write(path.join(dir, "mod.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])))).toEqual({ kind: "other", reason: "WebAssembly module (REA inspect_artifact reads it)" });
    expect(detectTargetKind(write(path.join(dir, "notes.txt"), "hello")).kind).toBe("other");
  });

  __test("a folder is electron when its package.json depends on electron, and other otherwise", () => {
    const dir = makeDir();
    write(path.join(dir, "package.json"), JSON.stringify({ name: "acme", devDependencies: { electron: "^30.0.0" } }));
    expect(detectTargetKind(dir)).toEqual({ kind: "electron", reason: "package.json depends on electron" });
    const plain = makeDir();
    write(path.join(plain, "package.json"), JSON.stringify({ name: "acme", dependencies: { react: "19.0.0" }, keywords: ["electron"] }));
    expect(detectTargetKind(plain)).toEqual({ kind: "other", reason: "a folder; REA inspect_artifact will classify it" });
  });

  __test("an investigation is auto by default: its kind and reason are kept; an explicit kind wins and keeps no reason", () => {
    const dir = makeDir();
    const app = electronApp(dir);
    expect(startInvestigation({ workspace: dir, title: "Acme", target: app })).toMatchObject({ target_kind: "electron", kind_reason: "Electron app: Contents/Resources/app.asar" });
    expect(startInvestigation({ workspace: dir, title: "Site", target: "https://example.com", targetKind: "auto" })).toMatchObject({ target_kind: "web", kind_reason: "http(s) URL" });
    expect(startInvestigation({ workspace: dir, title: "Forced", target: app, targetKind: "binary" })).toMatchObject({ target_kind: "binary", kind_reason: null });
    expect(startInvestigation({ workspace: dir, title: "Nothing" })).toMatchObject({ target: null, target_kind: "other", kind_reason: "no target given" });
    expect(() => startInvestigation({ workspace: dir, title: "Bad", targetKind: "gif" })).toThrow(/Use one of: auto, web, electron/);
  });

  __test("a run works a stored other as what its target is now, and a native app's executable goes into the brief", () => {
    const dir = makeDir();
    const app = electronApp(dir);
    const inv = startInvestigation({ workspace: dir, title: "Early", target: app, targetKind: "other" });
    expect(inv.target_kind).toBe("other");
    const brief = runPrompt(getInvestigation(inv.id, dir)!);
    expect(brief).toContain("- Kind: electron (Electron app: Contents/Resources/app.asar)");
    expect(brief).toContain("list_electron_targets");

    const native = nativeApp(dir);
    const nat = startInvestigation({ workspace: dir, title: "Native", target: native, targetKind: "other" });
    expect(runPrompt(getInvestigation(nat.id, dir)!)).toContain(`The app's executable is ${path.join(native, "Contents", "MacOS", "NativeTool")}: pass that path to binary_overview.`);

    const lost = startInvestigation({ workspace: dir, title: "Lost", target: path.join(dir, "gone.bin"), targetKind: "other" });
    expect(runPrompt(getInvestigation(lost.id, dir)!)).toContain("inspect_artifact");
    expect(effectiveKind({ target: app, target_kind: "binary" })).toBe("binary");
    expect(effectiveKind({ target: path.join(dir, "gone.bin"), target_kind: "other" })).toBe("other");
  });

  __test("the agent's investigation_start works the kind out too, and says what it found", async () => {
    const dir = makeDir();
    const sessionId = await lead(dir);
    const r = await call("investigation_start", { title: "Acme", target: electronApp(dir) }, sessionId);
    expect(r.text).toContain("(electron, detected: Electron app: Contents/Resources/app.asar");
    expect((await call("investigation_start", { title: "Bad", target_kind: "gif" }, sessionId)).text).toMatch(/auto, web, electron/);
  });
});

__log("COLLECT L641");
describe("settings wiring", () => {
__log("COLLECT L642");
  const base = { sessionId: "s_x", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t" };

  __test("evidence alone brings up the trb shim with its flag; without it there is no shim", () => {
    expect(buildRunMcpConfig({ ...base }).trb).toBeUndefined();
    const on = buildRunMcpConfig({ ...base, evidence: true }).trb;
    expect(on?.type === "stdio" && on.env?.TRB_EVIDENCE).toBe("1");
    const subs = buildRunMcpConfig({ ...base, subagents: true }).trb;
    expect(subs?.type === "stdio" && subs.env?.TRB_EVIDENCE).toBe("0");
  });

  __test("REA is a pinned npx server, only when asked for, never in ask mode, and honours an agent's MCP allow-list", () => {
    if (!Bun.which("npx")) return;
    expect(buildRunMcpConfig({ ...base }).rea).toBeUndefined();
    const on = buildRunMcpConfig({ ...base, rea: true }).rea;
    expect(on).toMatchObject({ type: "stdio", args: ["-y", `rea-agents@${REA_VERSION}`, "mcp"] });
    expect(buildRunMcpConfig({ ...base, rea: true, ask: true }).rea).toBeUndefined();
    expect(buildRunMcpConfig({ ...base, rea: true, allowed: ["codegraph"] }).rea).toBeUndefined();
    expect(buildRunMcpConfig({ ...base, rea: true, allowed: ["rea"] }).rea).toBeDefined();
  });

  __test("rea_command overrides how REA starts; a server the operator registered under that name wins", () => {
    setSetting("rea_command", "/opt/bin/rea mcp --quiet");
    expect(reaLaunch()).toEqual({ command: "/opt/bin/rea", args: ["mcp", "--quiet"], source: "override" });
    expect(buildRunMcpConfig({ ...base, rea: true }).rea).toMatchObject({ command: "/opt/bin/rea", args: ["mcp", "--quiet"] });
  });

  __test("the settings only take on or off", () => {
    expect(() => setSetting("evidence", "maybe")).toThrow(/"on" or "off"/);
    expect(() => setSetting("rea_mcp", "1")).toThrow(/"on" or "off"/);
  });
});

__log("COLLECT L674");
describe("HTTP routes", () => {
__log("COLLECT L675");
  const TOKEN = "evidence-test-token";
__log("COLLECT L676");
  let srv: ReturnType<typeof startServer>;
__log("COLLECT L677");
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
__log("COLLECT L680");
  afterAll(() => srv.stop());
__log("COLLECT L681");
  const http = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return res;
  };

  __test("list, note, read a part safely, export to docs, delete", async () => {
    const dir = makeDir();
    const root = Workspaces.open(dir).id;
    const shot = page(dir, "Home", { files: { "page.html": "<script>alert(1)</script>", "screenshot.jpg": Buffer.from([0xff, 0xd8, 0xff]) } });

    const listed = await (await http("GET", `/api/evidence/${root}`)).json();
    expect(listed.enabled).toBe(true); // on by default
    expect(listed.items.map((i: any) => i.id)).toEqual([shot.id]);

    const made = await http("POST", `/api/evidence/${root}/note`, { title: "Hero is full bleed", text: "Seen on Home.", refs: [shot.id] });
    expect(made.status).toBe(201);
    const noteId = (await made.json()).item.id;
    expect((await http("POST", `/api/evidence/${root}/note`, { title: "", text: "" })).status).toBe(400);

    const detail = await (await http("GET", `/api/evidence/${root}/${shot.id}`)).json();
    expect(detail.citedBy.map((n: any) => n.id)).toEqual([noteId]);

    // A captured page's own markup must never run: plain text, sandboxed, no sniffing.
    const html = await http("GET", `/api/evidence/${root}/${shot.id}/file/page.html`);
    expect(html.headers.get("content-type")).toStartWith("text/plain");
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await http("GET", `/api/evidence/${root}/${shot.id}/file/nothing.txt`)).status).toBe(404);
    expect((await http("GET", `/api/evidence/${root}/${shot.id}/file/screenshot.jpg`)).headers.get("content-type")).toBe("image/jpeg");

    const exp = await http("POST", `/api/evidence/${root}/${noteId}/export`, {});
    expect(exp.status).toBe(201);
    const pagePath = (await exp.json()).page.path as string;
    expect(pagePath).toStartWith("docs/evidence/");
    const text = fs.readFileSync(`${dir}/${pagePath}`, "utf-8");
    expect(text).toContain("Hero is full bleed");
    expect(text).toContain(shot.id);

    expect(((await (await http("DELETE", `/api/evidence/${root}/${noteId}`)).json()) as any).removed).toBe(true);
    expect((await http("GET", `/api/evidence/${root}/${noteId}`)).status).toBe(404);
  });

  __test("investigations: create, read, close, reopen, rename and remove, all within the project", async () => {
    const dir = makeDir();
    const root = Workspaces.open(dir).id;
    const made = await http("POST", `/api/evidence/${root}/investigations`, { title: "Figma plugin", target: "https://figma.com", target_kind: "web" });
    expect(made.status).toBe(201);
    const inv = (await made.json()).investigation;
    expect(inv).toMatchObject({ title: "Figma plugin", target: "https://figma.com", target_kind: "web", status: "open", counts: { pages: 0, notes: 0, findings: 0, new: 0, planned: 0, built: 0, dismissed: 0 } });
    expect((await http("POST", `/api/evidence/${root}/investigations`, { title: "" })).status).toBe(400);
    expect((await http("POST", `/api/evidence/${root}/investigations`, { title: "x", target_kind: "gif" })).status).toBe(400);

    const f = (await (await http("POST", `/api/evidence/${root}/note`, { title: "Toolbar floats", text: "It floats.", finding: "ui", investigation_id: inv.id })).json()).item;
    expect(f).toMatchObject({ finding: "ui", finding_status: "new", investigation_id: inv.id, source: "operator" });
    expect((await http("POST", `/api/evidence/${root}/note`, { title: "Bad", text: "x", finding: "color" })).status).toBe(400);
    const plain = (await (await http("POST", `/api/evidence/${root}/note`, { title: "Plain", text: "x" })).json()).item;

    const listed = await (await http("GET", `/api/evidence/${root}`)).json();
    expect(listed.investigations.map((i: any) => i.id)).toEqual([inv.id]);
    expect(listed.investigations[0].counts).toMatchObject({ notes: 1, findings: 1, new: 1 });
    const filtered = await (await http("GET", `/api/evidence/${root}?finding=ui&status=new&investigation=${inv.id}`)).json();
    expect(filtered.items.map((i: any) => i.id)).toEqual([f.id]);
    expect((await (await http("GET", `/api/evidence/${root}/investigations`)).json()).investigations.length).toBe(1);
    const detail = await (await http("GET", `/api/evidence/${root}/investigations/${inv.id}`)).json();
    expect(detail.investigation.id).toBe(inv.id);
    expect(detail.items.map((i: any) => i.id)).toEqual([f.id]);

    const st = await http("PATCH", `/api/evidence/${root}/${f.id}`, { finding_status: "planned" });
    expect((await st.json()).item.finding_status).toBe("planned");
    expect((await http("PATCH", `/api/evidence/${root}/${f.id}`, { finding_status: "shipped" })).status).toBe(400);
    expect((await http("PATCH", `/api/evidence/${root}/${plain.id}`, { finding_status: "built" })).status).toBe(400);

    const closed = (await (await http("PATCH", `/api/evidence/${root}/investigations/${inv.id}`, { status: "closed", summary: "It floats on hover." })).json()).investigation;
    expect(closed).toMatchObject({ status: "closed", summary: "It floats on hover." });
    expect(closed.closed_at).not.toBeNull();
    const reopened = (await (await http("PATCH", `/api/evidence/${root}/investigations/${inv.id}`, { status: "open", title: "Figma plugin v2" })).json()).investigation;
    expect(reopened).toMatchObject({ title: "Figma plugin v2", status: "open", closed_at: null, summary: "It floats on hover." });
    expect((await http("PATCH", `/api/evidence/${root}/investigations/${inv.id}`, { status: "paused" })).status).toBe(400);
    expect((await http("PATCH", `/api/evidence/${root}/investigations/${inv.id}`, { title: "  " })).status).toBe(400);

    const built = await http("POST", `/api/evidence/${root}/build`, { ids: [f.id] });
    expect(built.status).toBe(200);
    const bj = await built.json();
    expect(bj.ids).toEqual([f.id]);
    expect(bj.prompt).toContain(f.id);
    expect(bj.prompt).toContain("DESIGN.md");
    expect((await http("POST", `/api/evidence/${root}/build`, { ids: [plain.id] })).status).toBe(400);
    expect((await http("POST", `/api/evidence/${root}/build`, { ids: "e_x" })).status).toBe(400);

    expect(((await (await http("DELETE", `/api/evidence/${root}/investigations/${inv.id}`)).json()) as any).removed).toBe(true);
    expect(getEvidence(f.id, dir)!.investigation_id).toBeNull();
    expect((await http("GET", `/api/evidence/${root}/investigations/${inv.id}`)).status).toBe(404);

    const gone = startInvestigation({ workspace: dir, title: "Gone" });
    const doomed = addEvidence({ workspace: dir, kind: "note", title: "doomed", investigationId: gone.id, files: { "note.md": "x" } });
    expect(((await (await http("DELETE", `/api/evidence/${root}/investigations/${gone.id}?withEvidence=1`)).json()) as any).removed).toBe(true);
    expect(getEvidence(doomed.id)).toBeNull();

    // A saved result is served like every other part: plain text, sandboxed.
    const raw = addEvidence({ workspace: dir, kind: "note", title: "REA output", source: "rea", files: { "note.md": "x", "rea.json": '{"ok":true}' } });
    const file = await http("GET", `/api/evidence/${root}/${raw.id}/file/rea.json`);
    expect(file.headers.get("content-type")).toStartWith("text/plain");
    expect(file.headers.get("content-security-policy")).toBe("sandbox");
    expect(await file.text()).toBe('{"ok":true}');
  });

  __test("another project's investigation is a 404 for reads, edits and removal", async () => {
    const root = Workspaces.open(makeDir()).id;
    const foreign = startInvestigation({ workspace: makeDir(), title: "Elsewhere" });
    expect((await http("GET", `/api/evidence/${root}/investigations/${foreign.id}`)).status).toBe(404);
    expect((await http("PATCH", `/api/evidence/${root}/investigations/${foreign.id}`, { title: "hijack" })).status).toBe(404);
    expect((await http("DELETE", `/api/evidence/${root}/investigations/${foreign.id}`)).status).toBe(404);
    expect(getInvestigation(foreign.id, makeDir())).toBeNull();
    expect(getInvestigation(foreign.id, makeDir())).toBeNull();
    expect(listInvestigations(makeDir())).toEqual([]);
  });

  __test("another project's id is a 404, not a leak", async () => {
    const root = Workspaces.open(makeDir()).id;
    const foreign = page(makeDir(), "Elsewhere");
    expect((await http("GET", `/api/evidence/${root}/${foreign.id}`)).status).toBe(404);
    expect((await http("DELETE", `/api/evidence/${root}/${foreign.id}`)).status).toBe(404);
    expect(getEvidence(foreign.id)).not.toBeNull();
  });

  __test("POST investigations with run keeps the investigation and says why the run did not start; /run answers 400 with the same reason", async () => {
    const dir = makeDir();
    const root = Workspaces.open(dir).id;
    setSetting("rea_mcp", "off");
    const refused = await http("POST", `/api/evidence/${root}/investigations`, { title: "Binary", target: "/bin/ls", target_kind: "binary", run: true, engine: "fake" });
    expect(refused.status).toBe(201);
    const kept = await refused.json();
    expect(kept.session).toBeNull();
    expect(kept.runError).toMatch(/REA, the reverse-engineering server, which is off/);
    expect(kept.investigation).toMatchObject({ title: "Binary", status: "open", runs: [], running: false });
    const retry = await http("POST", `/api/evidence/${root}/investigations/${kept.investigation.id}/run`, { engine: "fake" });
    expect(retry.status).toBe(400);
    expect((await retry.json()).error).toBe(kept.runError);
    expect((await http("POST", `/api/evidence/${root}/investigations/${startInvestigation({ workspace: makeDir(), title: "Elsewhere" }).id}/run`, {})).status).toBe(404);

    setSetting("rea_mcp", "on");
    setSetting("rea_command", "/bin/echo mcp");
    const started = await http("POST", `/api/evidence/${root}/investigations`, { title: "Other", target: makeDir(), target_kind: "other", run: true, engine: "fake", note: "start here" });
    expect(started.status).toBe(201);
    const body = await started.json();
    expect(body.runError).toBeUndefined();
    const firstId: string = body.session.id;
    expect(body.session.mode).toBe("build");
    expect(body.investigation.runs).toEqual([expect.objectContaining({ session_id: firstId, note: "start here" })]);
    await settled(firstId);

    const again = await http("POST", `/api/evidence/${root}/investigations/${body.investigation.id}/run`, { engine: "fake" });
    expect(again.status).toBe(201);
    const second = await again.json();
    expect(second.session.id).not.toBe(firstId);
    expect(second.investigation.runs.map((r: any) => r.session_id)).toEqual([second.session.id, firstId]);
    await settled(second.session.id);
    const listed = await (await http("GET", `/api/evidence/${root}/investigations`)).json();
    expect(listed.investigations[0]).toMatchObject({ id: body.investigation.id, running: false });
  });

  __test("create with the kind left to detection stores the detected kind and its reason; an explicit kind wins", async () => {
    const dir = makeDir();
    const root = Workspaces.open(dir).id;
    const app = path.join(makeDir(), "Acme.app");
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "asar");

    const made = await (await http("POST", `/api/evidence/${root}/investigations`, { title: "Acme", target: app, target_kind: "auto" })).json();
    expect(made.detected).toEqual({ kind: "electron", reason: "Electron app: Contents/Resources/app.asar" });
    expect(made.investigation).toMatchObject({ target_kind: "electron", kind_reason: "Electron app: Contents/Resources/app.asar" });

    const site = await (await http("POST", `/api/evidence/${root}/investigations`, { title: "Site", target: "https://example.com" })).json();
    expect(site.detected).toEqual({ kind: "web", reason: "http(s) URL" });
    expect(site.investigation.target_kind).toBe("web");

    const forced = await (await http("POST", `/api/evidence/${root}/investigations`, { title: "Forced", target: app, target_kind: "binary" })).json();
    expect(forced.detected).toBeNull();
    expect(forced.investigation).toMatchObject({ target_kind: "binary", kind_reason: null });
    expect((await http("POST", `/api/evidence/${root}/investigations`, { title: "x", target_kind: "gif" })).status).toBe(400);
  });
});

__log("COLLECT L864");
describe("capture against a real browser", () => {
__log("COLLECT L865");
  let site: ReturnType<typeof Bun.serve>;
__log("COLLECT L866");
  let base: string;
__log("COLLECT L867");
  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/app.css") return new Response(`:root{--brand:#0a7cff;--radius:12px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.2);font:600 18px/1.4 Georgia,serif;color:#111}`, { headers: { "content-type": "text/css" } });
        return new Response(`<!doctype html><title>Cards</title><meta name="description" content="demo"><link rel=stylesheet href="/app.css?sig=SECRET123"><body style="background:#fafafa"><div class="card">Hello card</div><p>token=sk-ant-abcdefghijklmnopqrstuvwxyz</p><script src="/x.js?k=1"></script>`, { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${site.port}`;
  });
__log("COLLECT L878");
  afterAll(async () => {
    setDaemonContext(null);
    site.stop(true);
    await shutdownBrowsers();
  });

  t("captures structure, measured styles, assets and a screenshot, and keeps secrets out", async () => {
    setSetting("evidence", "on");
    const dir = makeDir();
    const id = await lead(dir);
    const { executeBrowserTool } = await import("../src/browser/tools");
    await executeBrowserTool("browser_navigate", { url: base + "/" }, { sessionId: id });

    const r = await call("evidence_capture_page", { label: "Card demo" }, id);
    expect(r.text).toMatch(/^Saved e_\w+: "Card demo"/);
    const item = listEvidence(dir)[0]!;
    for (const need of ["page.html", "snapshot.txt", "styles.json", "network.json", "assets.json", "meta.json", "screenshot.jpg"]) expect(Object.keys(item.files)).toContain(need);

    const styles = JSON.parse(readPart(item, "styles.json")!.buf.toString());
    expect(styles.tokens["--brand"]).toBe("#0a7cff");
    expect(styles.radii.map((x: any[]) => x[0])).toContain("12px");
    expect(JSON.stringify(styles.fonts.families)).toContain("Georgia");
    expect(styles.colors.background.length).toBeGreaterThan(0);

    const html = readPart(item, "page.html")!.buf.toString();
    expect(html).toContain("Hello card");
    expect(html).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz"); // token-shaped strings are redacted
    const files = readPart(item, "assets.json")!.buf.toString() + readPart(item, "network.json")!.buf.toString();
    expect(files).not.toContain("SECRET123"); // query strings are dropped
    expect(files).toContain("/app.css");
    expect(readPart(item, "screenshot.jpg")!.buf.subarray(0, 2).toString("hex")).toBe("ffd8");

    const img = await call("evidence_read", { id: item.id, part: "screenshot" }, id);
    expect(img.images?.[0]?.mimeType).toBe("image/jpeg");
    await closeBrowser(rootOf(id)!);
  });

  t("an empty browser is a clear error, not a blank capture", async () => {
    setSetting("evidence", "on");
    const id = await lead();
    const r = await call("evidence_capture_page", {}, id);
    expect(r.text).toMatch(/^Error: .*no page open/);
    await closeBrowser(rootOf(id)!);
  });
});
