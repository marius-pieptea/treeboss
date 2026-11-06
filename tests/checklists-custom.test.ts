/** The editable catalog (built-in overrides, forks, custom checklists), the project's own items, reconcile, and the routes. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { BUILTIN_CHECKLISTS } from "../src/checklists/catalog";
import { catalogEntries, checkChecklist, checklistById, createChecklist, defaultChecklistsFor, deleteChecklist, effectiveCatalog, resetChecklist, saveChecklist } from "../src/checklists/custom";
import { fileOf, readChecklistFile } from "../src/checklists/files";
import { addItemToProject, attach, launchBlockers, recordResult, removeItemFromProject, setItem, setItemDisabled, showAttached } from "../src/checklists/store";
import { DISABLED_NOTE } from "../src/checklists/project";
import { checklistsRoutes } from "../src/daemon/routes/checklists";
import { makeCtx } from "../src/daemon/http";
import { home } from "../src/paths";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const catalogFile = () => path.join(home(), "checklists.json");
const u = (p: string) => new URL(`http://localhost${p}`);

/** Every test starts from the shipped catalog: the file is the operator's, and the other test files read the built-ins. */
beforeEach(() => {
  resetState();
  fs.rmSync(catalogFile(), { force: true });
});
afterEach(() => {
  fs.rmSync(catalogFile(), { force: true });
});

const item = (over: Record<string, unknown> = {}) => ({ id: "new-item", text: "A new item", category: "General", severity: "recommended", kind: "manual", hint: "Look at it.", ...over });

describe("the editable catalog", () => {
  test("the shipped checklists are valid as they are", () => {
    for (const c of BUILTIN_CHECKLISTS) expect(() => checkChecklist(clone(c))).not.toThrow();
    expect(effectiveCatalog().map((c) => c.id)).toEqual(BUILTIN_CHECKLISTS.map((c) => c.id));
    expect(catalogEntries().every((c) => c.builtin && !c.modified)).toBe(true);
  });

  test("an override replaces a built-in, shows as modified, and reset puts it back", () => {
    const def = { ...clone(checklistById("seo")!), title: "SEO, our way" };
    saveChecklist("seo", def);
    expect(checklistById("seo")!.title).toBe("SEO, our way");
    expect(catalogEntries().find((c) => c.id === "seo")).toMatchObject({ builtin: true, modified: true });
    expect(effectiveCatalog().filter((c) => c.id === "seo")).toHaveLength(1);
    resetChecklist("seo");
    expect(checklistById("seo")!.title).toBe(BUILTIN_CHECKLISTS.find((c) => c.id === "seo")!.title);
    expect(catalogEntries().find((c) => c.id === "seo")!.modified).toBe(false);
  });

  test("saving a built-in back to its shipped content keeps no override", () => {
    saveChecklist("seo", clone(BUILTIN_CHECKLISTS.find((c) => c.id === "seo")!));
    expect(catalogEntries().find((c) => c.id === "seo")!.modified).toBe(false);
    expect(fs.existsSync(catalogFile())).toBe(true);
    expect(JSON.parse(fs.readFileSync(catalogFile(), "utf8")).checklists).toEqual([]);
  });

  test("a built-in can be reset but not deleted; a custom one can be deleted but not reset", () => {
    expect(() => deleteChecklist("seo", [])).toThrow(/reset it to its default/);
    expect(() => resetChecklist("launch-extra")).toThrow(/came with trb/);
    createChecklist({ id: "launch-extra", title: "Extra", summary: "", appliesTo: [], items: [item()] });
    expect(catalogEntries().find((c) => c.id === "launch-extra")).toMatchObject({ builtin: false, modified: false });
    deleteChecklist("launch-extra", []);
    expect(checklistById("launch-extra")).toBeNull();
  });

  test("a custom checklist is offered to recipes with its tags, and a fork copies what it leaves out", () => {
    createChecklist({ id: "launch-extra", title: "Extra", summary: "", appliesTo: ["api"], items: [item()] });
    expect(defaultChecklistsFor("api").map((c) => c.id)).toContain("launch-extra");
    const fork = createChecklist({ id: "seo-fork", title: "SEO fork" }, "seo");
    expect(fork.items.length).toBe(checklistById("seo")!.items.length);
    expect(fork.summary).toBe(checklistById("seo")!.summary);
    expect(checklistById("seo-fork")).not.toBeNull();
  });

  test("ids are kebab-case and unique, and a built-in id cannot be taken by a new checklist", () => {
    expect(() => createChecklist({ id: "Bad_ID", title: "x", items: [item()] })).toThrow(/lowercase letters/);
    expect(() => createChecklist({ id: "seo", title: "x", items: [item()] })).toThrow(/already exists/);
    expect(() => saveChecklist("seo", { ...clone(checklistById("seo")!), id: "other-seo" })).toThrow(/cannot change/);
    expect(() => checkChecklist({ id: "dup-items", title: "Dup", appliesTo: [], items: [item(), item()] })).toThrow(/Two items/);
  });

  test("kind auto needs a check that exists; agent and manual take none", () => {
    expect(() => checkChecklist({ id: "auto-no-check", title: "A", appliesTo: [], items: [item({ kind: "auto" })] })).toThrow(/names its check/);
    expect(() => checkChecklist({ id: "auto-bad-check", title: "A", appliesTo: [], items: [item({ kind: "auto", check: "not-a-check" })] })).toThrow(/names its check/);
    expect(() => checkChecklist({ id: "agent-check", title: "A", appliesTo: [], items: [item({ kind: "agent", check: "meta-title" })] })).toThrow(/only an auto item/);
    const ok = checkChecklist({ id: "auto-ok", title: "A", appliesTo: [], items: [item({ kind: "auto", check: "meta-title" })] });
    expect(ok.items[0]).toMatchObject({ kind: "auto", check: "meta-title" });
  });

  test("severity is required or recommended, and a hint is required", () => {
    expect(() => checkChecklist({ id: "bad-sev", title: "A", appliesTo: [], items: [item({ severity: "optional" })] })).toThrow(/required or recommended/);
    expect(() => checkChecklist({ id: "no-hint", title: "A", appliesTo: [], items: [item({ hint: "" })] })).toThrow(/hint/);
  });

  test("a catalog file that does not parse is an error, not an empty catalog", () => {
    fs.writeFileSync(catalogFile(), "{ not json");
    expect(() => effectiveCatalog()).toThrow(/not valid JSON/);
  });
});

describe("a project's own items and its reconcile", () => {
  test("a changed definition reconciles the file: removed items go, renamed and moved ones keep their answers, new ones start unknown", () => {
    const dir = makeRepo();
    const wsId = Workspaces.open(dir).id;
    attach(wsId, "seo");
    const [a, b, c] = checklistById("seo")!.items;
    setItem(wsId, "seo", b!.id, { checked: true });
    setItem(wsId, "seo", c!.id, { note: "kept note" });

    const def = clone(checklistById("seo")!);
    def.items = def.items.filter((i) => i.id !== a!.id);
    def.items.find((i) => i.id === b!.id)!.text = "Renamed item";
    def.items.find((i) => i.id === c!.id)!.category = "Moved category";
    def.items.push(item({ id: "brand-new-item", text: "A brand new item", category: "Brand" }) as any);
    saveChecklist("seo", def);

    const view = showAttached(wsId, "seo");
    expect(view.items.map((i) => i.id)).not.toContain(a!.id);
    expect(view.items.find((i) => i.id === b!.id)).toMatchObject({ text: "Renamed item", status: "pass", source: "manual" });
    expect(view.items.find((i) => i.id === c!.id)).toMatchObject({ category: "Moved category", note: "kept note" });
    expect(view.items.find((i) => i.id === "brand-new-item")).toMatchObject({ status: "unknown", category: "Brand" });
    const text = fs.readFileSync(fileOf(dir, "seo"), "utf8");
    expect(text).not.toContain(`{#${a!.id}}`);
    expect(text).toContain("## Moved category");
    expect(text).toContain("A brand new item {#brand-new-item}");
  });

  test("disabling an item for this project settles it, pins it, and turns it back on; a required item cannot be disabled", () => {
    const dir = makeRepo();
    const wsId = Workspaces.open(dir).id;
    attach(wsId, "seo");
    const items = showAttached(wsId, "seo").items;
    const rec = items.find((i) => i.severity === "recommended")!;
    const req = items.find((i) => i.severity === "required")!;
    const blockersBefore = launchBlockers(wsId).length;
    expect(setItemDisabled(wsId, "seo", rec.id, true)).toMatchObject({ status: "na", source: "manual", note: DISABLED_NOTE });
    expect(fs.readFileSync(fileOf(dir, "seo"), "utf8")).toContain(`(note: ${DISABLED_NOTE})`);
    expect(setItemDisabled(wsId, "seo", rec.id, false).status).toBe("unknown");
    expect(() => setItemDisabled(wsId, "seo", req.id, true)).toThrow(/required launch item/);
    expect(launchBlockers(wsId).length).toBe(blockersBefore);
  });

  test("a project item lives in the file, is answered like any other, survives a catalog change, and goes with its line", () => {
    const dir = makeRepo();
    const wsId = Workspaces.open(dir).id;
    attach(wsId, "seo");
    const added = addItemToProject(wsId, "seo", { text: "Staging smoke test", category: "Operations", severity: "required", kind: "agent", hint: "Hit /health on staging." });
    expect(added).toMatchObject({ id: "p-staging-smoke-test", custom: true, kind: "agent", severity: "required", status: "unknown" });

    const text = fs.readFileSync(fileOf(dir, "seo"), "utf8");
    expect(text).toContain("(custom) (category: Operations) (severity: required) (kind: agent) (hint: Hit /health on staging.)");
    const back = readChecklistFile(dir, "seo")!;
    expect(back.projectItems.get("p-staging-smoke-test")).toMatchObject({ text: "Staging smoke test", category: "Operations", kind: "agent", hint: "Hit /health on staging.", custom: true });

    recordResult(wsId, { checklistId: "seo", itemId: added.id, status: "pass", evidence: "a.txt:1", note: "checked" });
    expect(showAttached(wsId, "seo").items.find((i) => i.id === added.id)).toMatchObject({ status: "pass", source: "agent" });

    const def = clone(checklistById("seo")!);
    def.title = "SEO and search";
    saveChecklist("seo", def);
    expect(showAttached(wsId, "seo").title).toBe("SEO and search");
    expect(showAttached(wsId, "seo").items.some((i) => i.id === added.id)).toBe(true);

    expect(() => addItemToProject(wsId, "seo", { text: "x", category: "X", kind: "auto", hint: "h", severity: "required" })).toThrow(/agent or manual/);
    removeItemFromProject(wsId, "seo", added.id);
    expect(showAttached(wsId, "seo").items.some((i) => i.id === added.id)).toBe(false);
    expect(() => removeItemFromProject(wsId, "seo", checklistById("seo")!.items[0]!.id)).toThrow(/disable it/);
  });
});

describe("the catalog and project routes", () => {
  const call = async (method: string, p: string, body: Record<string, unknown> = {}) => (await checklistsRoutes(makeCtx(new Request(u(p), { method }), u(p), body)))!;

  test("the catalog: list, edit, reset, fork, create and delete", async () => {
    const list = await (await call("GET", "/api/checklists/catalog")).json();
    expect(list.checks).toContain("meta-title");
    expect(list.checklists.find((c: any) => c.id === "seo")).toMatchObject({ builtin: true, modified: false });

    const seo = (await (await call("GET", "/api/checklists/catalog/seo")).json()).checklist;
    const def = { ...seo };
    delete def.builtin;
    delete def.modified;
    def.title = "SEO (ours)";
    expect((await call("PUT", "/api/checklists/catalog/seo", def)).status).toBe(200);
    expect((await (await call("GET", "/api/checklists/catalog/seo")).json()).checklist).toMatchObject({ title: "SEO (ours)", modified: true });
    expect((await call("POST", "/api/checklists/catalog/seo/reset")).status).toBe(200);
    expect((await (await call("GET", "/api/checklists/catalog/seo")).json()).checklist.modified).toBe(false);

    const made = await call("POST", "/api/checklists/catalog", { id: "route-made", title: "Route made", summary: "", appliesTo: ["api"], items: [item({ id: "one", text: "One" })] });
    expect(made.status).toBe(201);
    const forked = await call("POST", "/api/checklists/catalog", { id: "seo-fork", title: "SEO fork", forkOf: "seo" });
    expect(forked.status).toBe(201);
    expect((await forked.json()).checklist.items.length).toBe(checklistById("seo")!.items.length);
    expect((await call("DELETE", "/api/checklists/catalog/route-made")).status).toBe(200);
    await expect(call("DELETE", "/api/checklists/catalog/seo")).rejects.toThrow(/came with trb/);
    await expect(call("GET", "/api/checklists/catalog/nope")).rejects.toThrow(/No checklist/);
  });

  test("a project adds an item and disables one through the workspace routes", async () => {
    const dir = makeRepo();
    const wsId = Workspaces.open(dir).id;
    expect((await call("POST", `/api/workspaces/${wsId}/checklists`, { checklistId: "seo" })).status).toBe(201);
    const added = await call("POST", `/api/workspaces/${wsId}/checklists/seo/items`, { text: "Route item", category: "Ops", kind: "manual", severity: "recommended", hint: "Look" });
    expect(added.status).toBe(201);
    const itemId = (await added.json()).item.id;
    const off = await (await call("PATCH", `/api/workspaces/${wsId}/checklists/seo/items/${itemId}`, { disabled: true })).json();
    expect(off.item).toMatchObject({ status: "na", note: DISABLED_NOTE });
    await expect(call("PATCH", `/api/workspaces/${wsId}/checklists/seo/items/${itemId}`, { disabled: "yes" })).rejects.toThrow(/disabled must be true or false/);
    expect((await call("DELETE", `/api/workspaces/${wsId}/checklists/seo/items/${itemId}`)).status).toBe(200);
  });
});
