/** Products: the store, the cost rollup, the portfolio, and the HTTP routes. */
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { productRoutes } from "../src/daemon/routes/products";
import { HttpError, makeCtx } from "../src/daemon/http";
import { productSpend, spendByWorkspace, workspaceSpend } from "../src/products/cost";
import { portfolio, lastVerifyByWorkspace } from "../src/products/portfolio";
import { attachWorkspace, cleanBudget, createProduct, deleteProduct, detachWorkspace, getProduct, listProducts, productForWorkspace, productWorkspaces, resolveProduct, updateProduct } from "../src/products/store";
import { addRoadmapItem, createRoadmap, readRoadmap } from "../src/roadmap/store";
import { table as verifyTable } from "../src/verify/store";
import { Workspaces } from "../src/workspaces";
import { UserError } from "../src/util";
import { makeDir, makeRepo, resetState } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
/** SQLite's CURRENT_TIMESTAMP format, UTC. */
const sqlAt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

let sid = 0;
/** A session cut from `cwd`, with one turn per cost, each stamped at `at`. */
function seedSession(cwd: string, costs: Array<{ usd: number | null; at?: Date }>): string {
  const id = `s_t${++sid}_${Math.random().toString(36).slice(2, 8)}`;
  db().prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd) VALUES (?, 'test', ?, 'claude', ?, ?)").run(id, id, cwd, cwd);
  costs.forEach((c, i) => {
    db()
      .prepare("INSERT INTO turns (id, session_id, seq, prompt, status, cost_usd, started_at) VALUES (?, ?, ?, 'p', 'completed', ?, ?)")
      .run(`t_${id}_${i}`, id, i + 1, c.usd, sqlAt(c.at ?? new Date()));
  });
  return id;
}

beforeEach(() => {
  resetState();
  listProducts(); // the store creates its tables on first use
  verifyTable();
  db().exec("DELETE FROM product_repos; DELETE FROM products; DELETE FROM verify_runs");
});

describe("store", () => {
  test("creates products with a unique slug, a default status and a validated budget", () => {
    const a = createProduct({ name: "Acme Pay" });
    const b = createProduct({ name: "Acme Pay!" });
    expect(a.id).toMatch(/^p_/);
    expect(a).toMatchObject({ slug: "acme-pay", status: "idea", budget_usd_month: null });
    expect(b.slug).toBe("acme-pay-2");
    expect(createProduct({ name: "Budgeted", budget_usd_month: "12.5" }).budget_usd_month).toBe(12.5);
    expect(() => createProduct({ name: "  " })).toThrow("needs a name");
    expect(() => createProduct({ name: "x", status: "shipped" })).toThrow("Status must be one of");
    expect(() => cleanBudget(-1)).toThrow("zero or more");
    expect(cleanBudget("")).toBeNull();
  });

  test("resolves by id or slug and updates only the fields it is given", () => {
    const p = createProduct({ name: "Notes", description: "first" });
    expect(resolveProduct("notes")?.id).toBe(p.id);
    expect(resolveProduct(p.id)?.slug).toBe("notes");
    const u = updateProduct("notes", { status: "live", budget_usd_month: 5 });
    expect(u).toMatchObject({ name: "Notes", description: "first", status: "live", budget_usd_month: 5 });
    expect(updateProduct(p.id, { budget_usd_month: null }).budget_usd_month).toBeNull();
    expect(() => updateProduct(p.id, { status: "nope" })).toThrow("Status must be one of");
    expect(listProducts().map((x) => x.name)).toEqual(["Notes"]);
  });

  test("attaches workspaces with a role, re-attaching changes the role, detach removes", () => {
    const p = createProduct({ name: "Shop" });
    const web = Workspaces.open(makeDir(), "web");
    const api = Workspaces.open(makeDir(), "api");
    expect(attachWorkspace(p.id, web.id, "web")).toMatchObject({ workspace_id: web.id, role: "web", name: "web" });
    attachWorkspace(p.id, api.id);
    expect(attachWorkspace(p.id, web.id, "mobile").role).toBe("mobile");
    expect(productWorkspaces(p.id).map((r) => [r.name, r.role])).toEqual([
      ["api", "other"],
      ["web", "mobile"],
    ]);
    expect(productForWorkspace(api.id)?.id).toBe(p.id);
    expect(() => attachWorkspace(p.id, "w_missing")).toThrow('No workspace "w_missing"');
    expect(() => attachWorkspace(p.id, api.id, "backend")).toThrow("Role must be one of");
    expect(detachWorkspace(p.id, api.id)).toBe(true);
    expect(detachWorkspace(p.id, api.id)).toBe(false);
    expect(productForWorkspace(api.id)).toBeNull();
  });

  test("a workspace in two products reports the older one; deleting a product keeps its workspaces", () => {
    const first = createProduct({ name: "Core" });
    const second = createProduct({ name: "Side" });
    const ws = Workspaces.open(makeDir(), "shared");
    attachWorkspace(second.id, ws.id);
    attachWorkspace(first.id, ws.id);
    expect(productForWorkspace(ws.id)?.id).toBe(first.id);
    expect(deleteProduct("core")).toBe(true);
    expect(getProduct(first.id)).toBeNull();
    expect(productWorkspaces(first.id)).toEqual([]);
    expect(Workspaces.get(ws.id)).not.toBeNull();
    expect(productForWorkspace(ws.id)?.id).toBe(second.id);
    expect(deleteProduct("core")).toBe(false);
  });

  test("removing a workspace detaches it everywhere", () => {
    const p = createProduct({ name: "Gone" });
    const ws = Workspaces.open(makeDir(), "tmp");
    attachWorkspace(p.id, ws.id);
    Workspaces.remove(ws.id);
    expect(productWorkspaces(p.id)).toEqual([]);
  });
});

describe("cost", () => {
  test("sums turns per workspace over all time, this month and the last 7 days, and flags the budget", () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir, "app");
    const p = createProduct({ name: "Spend", budget_usd_month: 10 });
    attachWorkspace(p.id, ws.id);
    const now = new Date();
    const old = new Date(now.getTime() - 60 * DAY);
    // Forward slashes: owningWorkspace matches a subfolder by "<workspace path>/", as the sessions store it.
    seedSession(`${dir}/src`, [{ usd: 1.5 }, { usd: null }, { usd: 2 }]);
    seedSession(dir, [{ usd: 4, at: new Date(now.getTime() - 10 * DAY) }, { usd: 0.25, at: old }]);

    // The 10-day-old turn counts this month only if that day is still in the current UTC month.
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const tenDaysAgoThisMonth = now.getTime() - 10 * DAY >= monthStart;

    const s = productSpend(p.id)!;
    expect(s.allTime).toBeCloseTo(7.75);
    expect(s.last7Days).toBeCloseTo(3.5);
    expect(s.thisMonth).toBeCloseTo(3.5 + (tenDaysAgoThisMonth ? 4 : 0));
    expect(s.budgetUsdMonth).toBe(10);
    expect(s.overBudget).toBe(false);
    expect(workspaceSpend(ws.id)).toBeCloseTo(7.75);
    expect(workspaceSpend(ws.id, new Date(now.getTime() - 3 * DAY).toISOString())).toBeCloseTo(3.5);
  });

  test("flags a product whose month is over its budget, and never flags one without a budget", () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir, "over");
    const p = createProduct({ name: "Over", budget_usd_month: 1 });
    attachWorkspace(p.id, ws.id);
    seedSession(dir, [{ usd: 1.2 }]);
    expect(productSpend(p.id)).toMatchObject({ overBudget: true, budgetUsdMonth: 1 });
    updateProduct(p.id, { budget_usd_month: null });
    expect(productSpend(p.id)).toMatchObject({ overBudget: false, budgetUsdMonth: null });
    expect(productSpend("p_nope")).toBeNull();
  });

  test("a nested workspace owns its own folder, so the parent does not count its spend", () => {
    const dir = makeDir();
    const nested = path.join(dir, "packages", "api");
    fs.mkdirSync(nested, { recursive: true });
    const parent = Workspaces.open(dir, "parent");
    const child = Workspaces.open(nested, "child");
    seedSession(nested, [{ usd: 3 }]);
    seedSession(dir, [{ usd: 1 }]);
    const totals = spendByWorkspace(null);
    expect(totals.get(child.id)).toBeCloseTo(3);
    expect(totals.get(parent.id)).toBeCloseTo(1);
  });
});

describe("portfolio", () => {
  test("shows each product's repos with roadmap progress, the last verify result and spend", () => {
    const dir = makeRepo({ "README.md": "# web\n" });
    const ws = Workspaces.open(dir, "web");
    createRoadmap(dir, "Web");
    const lane = readRoadmap(dir).lanes[0]!.name;
    addRoadmapItem(dir, { lane, title: "Login", done: true });
    addRoadmapItem(dir, { lane, title: "Billing" });
    const p = createProduct({ name: "Portal", status: "building", budget_usd_month: 2 });
    attachWorkspace(p.id, ws.id, "web");
    const sid2 = seedSession(dir, [{ usd: 2.5 }]);
    verifyTable()
      .prepare("INSERT INTO verify_runs (id, session_id, attempt, state, trigger, started_at, finished_at) VALUES (?, ?, 0, 'failed', 'turn', ?, ?)")
      .run("vr_1", sid2, sqlAt(new Date()), sqlAt(new Date()));

    expect(lastVerifyByWorkspace().get(ws.id)?.state).toBe("failed");
    const [row] = portfolio().filter((x) => x.id === p.id);
    expect(row).toMatchObject({ name: "Portal", status: "building", progress: { items: 2, shipped: 1 } });
    expect(row!.repos).toHaveLength(1);
    expect(row!.repos[0]).toMatchObject({ role: "web", progress: { items: 2, shipped: 1 }, verify: { state: "failed" } });
    expect(row!.spend).toMatchObject({ thisMonth: 2.5, budgetUsdMonth: 2, overBudget: true });
  });

  test("a repo with no roadmap reports null progress instead of failing the view", () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir, "bare");
    const p = createProduct({ name: "Bare" });
    attachWorkspace(p.id, ws.id);
    const row = portfolio().find((x) => x.id === p.id)!;
    expect(row.repos[0]).toMatchObject({ progress: null, verify: null, spend: 0 });
    expect(row.progress).toEqual({ items: 0, shipped: 0, tasksDone: 0, tasksTotal: 0 });
  });
});

/** The route module called directly: the server is not wired to it yet, so this is its contract. */
describe("HTTP routes", () => {
  /** Mirrors the server: HttpError and UserError become their status, anything unmatched is a 404. */
  const call = async (method: string, p: string, body: Record<string, unknown> = {}) => {
    const url = new URL(`http://localhost${p}`);
    const req = new Request(url, { method, headers: { "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body) });
    try {
      const res = await productRoutes(makeCtx(req, url, method === "GET" || method === "DELETE" ? {} : body));
      if (!res) return { status: 404, data: null };
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
      if (e instanceof UserError) return { status: 400, data: { error: e.message } };
      throw e;
    }
  };

  test("create, read, patch, attach, detach and delete a product", async () => {
    const created = await call("POST", "/api/products", { name: "Route App", description: "x", status: "live", budget_usd_month: 3 });
    expect(created.status).toBe(201);
    const id = created.data.product.id as string;
    expect(created.data.product).toMatchObject({ slug: "route-app", status: "live", budget_usd_month: 3, repos: [], spend: { budgetUsdMonth: 3 } });

    expect((await call("GET", "/api/products/route-app")).data.product.id).toBe(id);

    const ws = Workspaces.open(makeDir(), "api");
    const attached = await call("POST", `/api/products/${id}/repos`, { workspace: ws.id, role: "api" });
    expect(attached.status).toBe(201);
    expect(attached.data.product.repos).toMatchObject([{ workspace_id: ws.id, role: "api", name: "api" }]);

    const patched = await call("PATCH", `/api/products/${id}`, { status: "building", budget_usd_month: null });
    expect(patched.data.product).toMatchObject({ status: "building", budget_usd_month: null });

    const detached = await call("DELETE", `/api/products/${id}/repos?workspace=${ws.id}`);
    expect(detached.data.product.repos).toEqual([]);
    expect((await call("DELETE", `/api/products/${id}/repos?workspace=${ws.id}`)).status).toBe(404);

    expect((await call("DELETE", `/api/products/${id}`)).data).toEqual({ removed: true });
    expect((await call("GET", `/api/products/${id}`)).status).toBe(404);
  });

  test("bad input is a 400 with the reason; unknown products are 404", async () => {
    const bad = await call("POST", "/api/products", { name: "Bad", status: "shipped" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("Status must be one of");
    expect((await call("POST", "/api/products", { name: "Neg", budget_usd_month: -4 })).status).toBe(400);
    expect((await call("GET", "/api/products/nope")).status).toBe(404);
    expect((await call("POST", "/api/products/nope/repos", { workspace: "w_x" })).status).toBe(404);
  });

  test("the portfolio endpoint lists every product", async () => {
    await call("POST", "/api/products", { name: "One" });
    await call("POST", "/api/products", { name: "Two" });
    const r = await call("GET", "/api/portfolio");
    expect(r.status).toBe(200);
    expect(r.data.products.map((p: { name: string }) => p.name).sort()).toEqual(["One", "Two"]);
  });

  test("a repo whose folder is gone is flagged exists: false, in the product and the portfolio", async () => {
    const id = (await call("POST", "/api/products", { name: "Gone" })).data.product.id as string;
    const dir = makeDir();
    const ws = Workspaces.open(dir, "gone-web");
    await call("POST", `/api/products/${id}/repos`, { workspace: ws.id, role: "web" });
    expect((await call("GET", `/api/products/${id}`)).data.product.repos[0]).toMatchObject({ workspace_id: ws.id, exists: true });

    fs.rmSync(dir, { recursive: true, force: true });
    expect((await call("GET", `/api/products/${id}`)).data.product.repos[0]).toMatchObject({ workspace_id: ws.id, exists: false });
    expect(portfolio().find((x) => x.id === id)!.repos[0]).toMatchObject({ workspace_id: ws.id, exists: false });
  });

  test("for-workspace returns the product the workspace is in, its repos and its role; no product is null; unknown is 404", async () => {
    const id = (await call("POST", "/api/products", { name: "Lookup" })).data.product.id as string;
    const web = Workspaces.open(makeDir(), "lookup-web");
    const api = Workspaces.open(makeDir(), "lookup-api");
    await call("POST", `/api/products/${id}/repos`, { workspace: web.id, role: "web" });
    await call("POST", `/api/products/${id}/repos`, { workspace: api.id, role: "api" });

    const found = await call("GET", `/api/products/for-workspace/${api.id}`);
    expect(found.status).toBe(200);
    expect(found.data.product).toMatchObject({ id, name: "Lookup", role: "api" });
    expect(found.data.product.repos.map((r: { workspace_id: string }) => r.workspace_id).sort()).toEqual([web.id, api.id].sort());
    expect(found.data.product.repos.every((r: { exists: boolean }) => r.exists)).toBe(true);
    expect(productForWorkspace(api.id)?.id).toBe(id);

    const loose = Workspaces.open(makeDir(), "loose");
    expect(await call("GET", `/api/products/for-workspace/${loose.id}`)).toEqual({ status: 200, data: { workspace: loose.id, product: null } });
    expect((await call("GET", "/api/products/for-workspace/w_nope")).status).toBe(404);
  });
});
