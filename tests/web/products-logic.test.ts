/** The portfolio's budget bar and progress helpers (web/src/features/products/logic.ts). */
import { describe, expect, test } from "bun:test";
import { budgetBar, isCurrentProduct, isLooseWorkspace, money, primaryRepo, repoSwitch, shippedPercent, sortCurrentFirst, spendLine } from "../../web/src/features/products/logic";
import type { RepoRole, Spend } from "../../web/src/features/products/data";

const spend = (over: Partial<Spend>): Spend => ({ allTime: 0, thisMonth: 0, last7Days: 0, budgetUsdMonth: null, overBudget: false, ...over });

describe("budgetBar", () => {
  test("no budget means no bar", () => {
    expect(budgetBar(spend({ thisMonth: 4 }))).toEqual({ share: null, width: 0, tone: "none" });
    expect(budgetBar(null)).toEqual({ share: null, width: 0, tone: "none" });
  });

  test("ok below 80%, near from 80%, over past the budget", () => {
    expect(budgetBar(spend({ thisMonth: 2, budgetUsdMonth: 10 }))).toMatchObject({ tone: "ok", width: 20 });
    expect(budgetBar(spend({ thisMonth: 8, budgetUsdMonth: 10 }))).toMatchObject({ tone: "near", width: 80 });
    expect(budgetBar(spend({ thisMonth: 12, budgetUsdMonth: 10, overBudget: true }))).toMatchObject({ tone: "over", width: 100 });
  });

  test("a zero budget is over as soon as anything is spent", () => {
    expect(budgetBar(spend({ thisMonth: 0, budgetUsdMonth: 0 }))).toMatchObject({ tone: "ok", width: 0 });
    expect(budgetBar(spend({ thisMonth: 0.5, budgetUsdMonth: 0 }))).toMatchObject({ tone: "over", width: 100 });
  });
});

describe("text", () => {
  test("shippedPercent is null without items", () => {
    expect(shippedPercent(null)).toBeNull();
    expect(shippedPercent({ items: 0, shipped: 0 })).toBeNull();
    expect(shippedPercent({ items: 3, shipped: 1 })).toBe(33);
  });

  test("money keeps cents and shows tiny amounts to four places", () => {
    expect(money(3.5)).toBe("$3.50");
    expect(money(0.004)).toBe("$0.0040");
  });

  test("spendLine says whether there is a budget", () => {
    expect(spendLine(spend({ thisMonth: 3.2, budgetUsdMonth: 10 }))).toBe("$3.20 of $10.00 this month");
    expect(spendLine(spend({ thisMonth: 3.2 }))).toBe("$3.20 this month, no budget");
  });
});

const repo = (workspace_id: string, role: RepoRole = "other", exists = true) => ({ workspace_id, role, exists });
const product = (id: string, ...workspaceIds: string[]) => ({ id, repos: workspaceIds.map((w) => ({ workspace_id: w })) });

describe("primaryRepo", () => {
  test("picks the first repo by role order: web, api, mobile, worker, other", () => {
    expect(primaryRepo([repo("a", "other"), repo("b", "worker"), repo("c", "api")])?.workspace_id).toBe("c");
    expect(primaryRepo([repo("a", "mobile"), repo("b", "web"), repo("c", "api")])?.workspace_id).toBe("b");
    expect(primaryRepo([repo("a", "other"), repo("b", "worker")])?.workspace_id).toBe("b");
  });

  test("ties keep the list's order, and no repos means no primary", () => {
    expect(primaryRepo([repo("x", "api"), repo("y", "api")])?.workspace_id).toBe("x");
    expect(primaryRepo([])).toBeNull();
  });

  test("a missing repo can still be the primary, so the caller can say it is missing", () => {
    expect(primaryRepo([repo("a", "web", false), repo("b", "api")])).toMatchObject({ workspace_id: "a", exists: false });
  });
});

describe("sortCurrentFirst", () => {
  test("the product holding the open workspace goes first, the rest keep their order", () => {
    const ps = [product("p1", "a"), product("p2", "b"), product("p3", "c", "b")];
    expect(sortCurrentFirst(ps, "b").map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(sortCurrentFirst(ps, "a").map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  test("with no open workspace, or one in no product, the order is unchanged", () => {
    const ps = [product("p1", "a"), product("p2", "b")];
    expect(sortCurrentFirst(ps, null)).toBe(ps);
    expect(sortCurrentFirst(ps, "zzz").map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("current and loose workspaces", () => {
  test("a product is current when it holds the open workspace", () => {
    expect(isCurrentProduct(product("p", "a"), "a")).toBe(true);
    expect(isCurrentProduct(product("p", "a"), "b")).toBe(false);
    expect(isCurrentProduct(product("p", "a"), null)).toBe(false);
  });

  test("the banner shows only when the open workspace is in no product, after the portfolio loads", () => {
    const ps = [product("p1", "a")];
    expect(isLooseWorkspace("b", ps)).toBe(true);
    expect(isLooseWorkspace("a", ps)).toBe(false);
    expect(isLooseWorkspace(null, ps)).toBe(false);
    expect(isLooseWorkspace("b", undefined)).toBe(false);
    expect(isLooseWorkspace("b", [])).toBe(true);
  });
});

describe("repoSwitch", () => {
  test("the open repo is marked and not switchable; a missing repo is switchable by no one", () => {
    expect(repoSwitch(repo("a"), "a")).toEqual({ open: true, missing: false, canSwitch: false });
    expect(repoSwitch(repo("b"), "a")).toEqual({ open: false, missing: false, canSwitch: true });
    expect(repoSwitch(repo("b", "other", false), "a")).toEqual({ open: false, missing: true, canSwitch: false });
    expect(repoSwitch(repo("a", "other", false), "a")).toEqual({ open: true, missing: true, canSwitch: false });
  });
});
