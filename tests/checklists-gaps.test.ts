/** Spec 118 gap fixes: what a line keeps, findings of items that go away, required items, the editor. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { editJson } from "../src/cli/commands/checklists";
import { fileOf, parseItemLine, readChecklistFile, renderItemLine, type ItemAnswer } from "../src/checklists/files";
import { addItemToProject, attach, detach, recordResult, removeItemFromProject, runAutoChecks, setItem, setItemDisabled, showAttached } from "../src/checklists/store";
import { createChecklist, saveChecklist } from "../src/checklists/custom";
import { patchLabFinding } from "../src/checklists/findings";
import { listFindings } from "../src/lab/findings";
import { checklistsRoutes } from "../src/daemon/routes/checklists";
import { makeCtx } from "../src/daemon/http";
import { home } from "../src/paths";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

beforeEach(resetState);

const answer = (over: Partial<ItemAnswer> = {}): ItemAnswer => ({ status: "unknown", source: null, evidence: null, message: null, reason: null, note: null, ...over });

describe("a check's message (T038)", () => {
  test("a line keeps the message, flattened to one line, and an old line without one still reads", () => {
    const a = answer({ status: "fail", source: "auto", evidence: "app/layout.tsx:3", message: "No <title>\nin app/layout.tsx" });
    const line = renderItemLine("Meta title", "meta-title", a);
    expect(line).toBe("- [ ] Meta title {#meta-title} (status: fail) (source: auto) (evidence: app/layout.tsx:3) (message: No <title> in app/layout.tsx)");
    expect(parseItemLine(line)!.answer).toEqual({ ...a, message: "No <title> in app/layout.tsx" });
    expect(parseItemLine("- [ ] Meta title {#meta-title} (status: fail) (source: auto) (evidence: app/layout.tsx:3)")!.answer.message).toBeNull();
  });

  test("a failing and a passing check keep their message through a re-read of the file", async () => {
    const dir = makeRepo({ "package.json": "{}\n", "app/page.tsx": "export default function P() { return null; }\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const r = await runAutoChecks(id);
    const failing = r.results.find((x) => x.status === "fail")!;
    const passing = r.results.find((x) => x.status === "pass")!;
    expect(failing.message).toBeTruthy();
    expect(passing.message).toBeTruthy();
    const file = readChecklistFile(dir, "marketing-site")!;
    expect(file.answers.get(failing.itemId)!.message).toBe(failing.message.replace(/\s+/g, " ").trim());
    expect(file.answers.get(passing.itemId)!.message).toBe(passing.message.replace(/\s+/g, " ").trim());
    const view = showAttached(id, "marketing-site").items;
    expect(view.find((i) => i.id === failing.itemId)!.message).toBe(failing.message.replace(/\s+/g, " ").trim());
    expect(view.find((i) => i.id === passing.itemId)!.message).toBe(passing.message.replace(/\s+/g, " ").trim());
  });

  test("an agent's or a person's answer carries no message", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "pass", evidence: "package.json:1", note: "seen" });
    setItem(id, "marketing-site", "custom-404", { checked: true });
    const items = showAttached(id, "marketing-site").items;
    expect(items.find((i) => i.id === "cta-above-fold")!.message).toBeNull();
    expect(items.find((i) => i.id === "custom-404")!.message).toBeNull();
  });
});

describe("an agent's reason and an operator's note (T039)", () => {
  test("a line keeps both apart, and an old agent line's (note:) reads as its reason", () => {
    const a = answer({ status: "na", source: "agent", evidence: "app/page.tsx:3", reason: "a single page", note: "checked with Sam" });
    const line = renderItemLine("Privacy page", "privacy-page", a);
    expect(line).toBe("- [x] Privacy page {#privacy-page} (status: na) (source: agent) (evidence: app/page.tsx:3) (reason: a single page) (note: checked with Sam)");
    expect(parseItemLine(line)!.answer).toEqual(a);
    const old = parseItemLine("- [x] Privacy page {#privacy-page} (status: na) (source: agent) (evidence: app/page.tsx:3) (note: a single page)")!.answer;
    expect(old).toMatchObject({ reason: "a single page", note: null });
    const manual = parseItemLine("- [ ] Privacy page {#privacy-page} (status: unknown) (source: manual) (note: waiting)")!.answer;
    expect(manual).toMatchObject({ reason: null, note: "waiting" });
  });

  test("a note on an agent's answer leaves its reason, and a later answer keeps the note", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "na", note: "a one-screen page" });
    setItem(id, "marketing-site", "sticky-mobile-cta", { note: "ask design about this" });
    let item = showAttached(id, "marketing-site").items.find((i) => i.id === "sticky-mobile-cta")!;
    expect(item).toMatchObject({ status: "na", source: "agent", reason: "a one-screen page", note: "ask design about this" });
    recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "fail", note: "the page is long now" });
    item = showAttached(id, "marketing-site").items.find((i) => i.id === "sticky-mobile-cta")!;
    expect(item).toMatchObject({ status: "fail", reason: "the page is long now", note: "ask design about this" });
    const line = fs.readFileSync(path.join(dir, "lab/checklists/marketing-site.md"), "utf8").split("\n").find((l) => l.includes("{#sticky-mobile-cta}"))!;
    expect(line).toContain("(reason: the page is long now) (note: ask design about this)");
  });
});

const catalogFile = () => path.join(home(), "checklists.json");
const u = (p: string) => new URL(`http://localhost${p}`);
const call = async (method: string, p: string, body: Record<string, unknown> = {}) => (await checklistsRoutes(makeCtx(new Request(u(p), { method }), u(p), body)))!;
const agentItem = (id: string) => ({ id, text: `Item ${id}`, category: "General", severity: "recommended", kind: "agent", hint: "Look at it." });
const findingsOf = (dir: string, cid: string) => listFindings(dir).filter((f) => f.checklist?.startsWith(`${cid}/`));
const openOf = (dir: string, cid: string) => findingsOf(dir, cid).filter((f) => f.status !== "shipped" && f.status !== "dismissed");

/** A workspace with a custom checklist of these items attached and every item failed by an agent. */
function failing(cid: string, items: string[]): { id: string; dir: string } {
  createChecklist({ id: cid, title: "Custom", summary: "", appliesTo: [], items: items.map(agentItem) });
  const dir = makeRepo({ "package.json": "{}\n" });
  const id = Workspaces.open(dir).id;
  attach(id, cid);
  for (const item of items) recordResult(id, { checklistId: cid, itemId: item, status: "fail", note: "not there" });
  return { id, dir };
}

describe("findings of items that go away", () => {
  beforeEach(() => fs.rmSync(catalogFile(), { force: true }));
  afterEach(() => fs.rmSync(catalogFile(), { force: true }));

  test("deleting a custom checklist closes its open findings in every project, and keeps the project's file (T050)", async () => {
    const a = failing("gone-list", ["one", "two"]);
    const b = makeRepo({ "package.json": "{}\n" });
    const bId = Workspaces.open(b).id;
    attach(bId, "gone-list");
    recordResult(bId, { checklistId: "gone-list", itemId: "one", status: "fail", note: "no" });
    expect(openOf(a.dir, "gone-list")).toHaveLength(2);
    expect(openOf(b, "gone-list")).toHaveLength(1);
    expect((await call("DELETE", "/api/checklists/catalog/gone-list")).status).toBe(200);
    expect(openOf(a.dir, "gone-list")).toHaveLength(0);
    expect(openOf(b, "gone-list")).toHaveLength(0);
    expect(findingsOf(a.dir, "gone-list").every((f) => f.status === "shipped")).toBe(true);
    expect(fs.existsSync(fileOf(a.dir, "gone-list"))).toBe(true);
  });

  test("a finding the operator dismissed stays dismissed, and a finding of another checklist is left alone", async () => {
    const a = failing("gone-too", ["one"]);
    recordResult(a.id, { checklistId: "gone-too", itemId: "one", status: "fail", note: "still" });
    patchLabFinding(a.dir, findingsOf(a.dir, "gone-too")[0]!.id, { status: "dismissed" });
    attach(a.id, "marketing-site");
    recordResult(a.id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "fail", note: "none" });
    await call("DELETE", "/api/checklists/catalog/gone-too");
    expect(findingsOf(a.dir, "gone-too")[0]!.status).toBe("dismissed");
    expect(openOf(a.dir, "marketing-site")).toHaveLength(1);
  });

  test("removing a project item ships its open finding (T051)", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const added = addItemToProject(id, "marketing-site", { text: "Staging smoke test", category: "Ops", kind: "agent", severity: "recommended", hint: "Hit /health" });
    recordResult(id, { checklistId: "marketing-site", itemId: added.id, status: "fail", note: "502" });
    expect(openOf(dir, "marketing-site").map((f) => f.checklist)).toContain(`marketing-site/${added.id}`);
    removeItemFromProject(id, "marketing-site", added.id);
    expect(openOf(dir, "marketing-site").map((f) => f.checklist)).not.toContain(`marketing-site/${added.id}`);
  });

  test("detaching a checklist ships the open findings of its items (T051)", () => {
    const { id, dir } = failing("detach-list", ["one", "two"]);
    expect(openOf(dir, "detach-list")).toHaveLength(2);
    expect(detach(id, "detach-list")).toBe(true);
    expect(openOf(dir, "detach-list")).toHaveLength(0);
  });

  test("an item the definition drops loses its finding at the next read, and the others keep theirs (T051)", () => {
    const { id, dir } = failing("shrink-list", ["one", "two"]);
    saveChecklist("shrink-list", { id: "shrink-list", title: "Custom", summary: "", appliesTo: [], items: [agentItem("one")] });
    showAttached(id, "shrink-list");
    expect(openOf(dir, "shrink-list").map((f) => f.checklist)).toEqual(["shrink-list/one"]);
    expect(findingsOf(dir, "shrink-list").find((f) => f.checklist === "shrink-list/two")!.status).toBe("shipped");
  });
});

describe("disabling a required item (T052)", () => {
  const REQUIRED = /required launch item.*cannot be disabled.*blocks a prod deploy/;

  test("the store refuses it, with the reason dismissal gives, and changes nothing", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const before = fs.readFileSync(fileOf(dir, "marketing-site"), "utf8");
    expect(() => setItemDisabled(id, "marketing-site", "cta-above-fold", true)).toThrow(REQUIRED);
    expect(fs.readFileSync(fileOf(dir, "marketing-site"), "utf8")).toBe(before);
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "cta-above-fold")!.status).toBe("unknown");
  });

  test("a recommended item can still be disabled and put back", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    expect(setItemDisabled(id, "marketing-site", "sticky-mobile-cta", true)).toMatchObject({ status: "na" });
    expect(setItemDisabled(id, "marketing-site", "sticky-mobile-cta", false)).toMatchObject({ status: "unknown" });
  });

  test("putting a required item back on is always allowed", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    expect(setItemDisabled(id, "marketing-site", "cta-above-fold", false)).toMatchObject({ status: "unknown" });
  });

  test("the route answers with the same words", async () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    await expect(call("PATCH", `/api/workspaces/${id}/checklists/marketing-site/items/cta-above-fold`, { disabled: true })).rejects.toThrow(REQUIRED);
  });
});

describe("trb checklist edit (T053)", () => {
  const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("an editor is handed a path with a space in it as one argument", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "trb-editor-"));
    const spaced = path.join(base, "with space");
    fs.mkdirSync(spaced);
    const script = path.join(base, "editor.js");
    fs.writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], JSON.stringify({ edited: true, argv: process.argv.slice(2) }));');
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = spaced;
    delete process.env.VISUAL;
    process.env.EDITOR = `"${process.execPath}" "${script}"`;
    const out = editJson({ id: "x" }) as { edited: boolean; argv: string[] };
    expect(out.edited).toBe(true);
    expect(out.argv).toHaveLength(1);
    expect(out.argv[0]).toContain("with space");
    expect(path.basename(out.argv[0]!)).toBe("checklist.json");
  });
});
