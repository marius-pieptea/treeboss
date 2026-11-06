/**
 * What the agents cost, per workspace and per product: the sum of turns.cost_usd for the sessions cut from each
 * workspace (sessions.base_cwd, the operator's folder, not a worktree). A session belongs to the most specific
 * workspace containing its folder, the same rule as owningWorkspace, so a nested project's spend is not also
 * counted in its parent.
 *
 * "This month" and "the last 7 days" are measured in UTC, because turns are stamped in UTC by SQLite.
 */
import { db } from "../db";
import { owningWorkspace } from "../workspaces";
import { productWorkspaces, resolveProduct } from "./store";

export interface Spend {
  allTime: number;
  thisMonth: number;
  last7Days: number;
  budgetUsdMonth: number | null;
  /** This month's spend is above the budget. False when there is no budget. */
  overBudget: boolean;
}

/** Per-workspace totals for each window, computed once so a portfolio of many products reads the turns once per window. */
export interface SpendWindows {
  allTime: Map<string, number>;
  thisMonth: Map<string, number>;
  last7Days: Map<string, number>;
}

/** SQLite's CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS", UTC. */
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function weekStart(now: Date): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

/** Summed cost per workspace since a time (or ever, when `since` is null). Sessions outside every workspace are dropped. */
export function spendByWorkspace(since: Date | null): Map<string, number> {
  const rows = db()
    .prepare(
      `SELECT s.base_cwd AS cwd, SUM(t.cost_usd) AS usd
         FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE t.cost_usd IS NOT NULL AND (? IS NULL OR t.started_at >= ?)
        GROUP BY s.base_cwd`,
    )
    .all(since ? sqlTime(since) : null, since ? sqlTime(since) : null) as Array<{ cwd: string; usd: number }>;
  const out = new Map<string, number>();
  for (const r of rows) {
    const owner = owningWorkspace(r.cwd);
    if (owner) out.set(owner, (out.get(owner) ?? 0) + r.usd);
  }
  return out;
}

export function spendWindows(now: Date = new Date()): SpendWindows {
  return {
    allTime: spendByWorkspace(null),
    thisMonth: spendByWorkspace(monthStart(now)),
    last7Days: spendByWorkspace(weekStart(now)),
  };
}

/** Spend for a set of workspaces against a monthly budget (null = no budget). */
export function spendOf(windows: SpendWindows, workspaceIds: string[], budgetUsdMonth: number | null): Spend {
  const sum = (m: Map<string, number>) => workspaceIds.reduce((total, id) => total + (m.get(id) ?? 0), 0);
  const thisMonth = sum(windows.thisMonth);
  return {
    allTime: sum(windows.allTime),
    thisMonth,
    last7Days: sum(windows.last7Days),
    budgetUsdMonth,
    overBudget: budgetUsdMonth !== null && thisMonth > budgetUsdMonth,
  };
}

/** A workspace's spend: all time, or since `sinceIso` (ISO 8601). */
export function workspaceSpend(workspaceId: string, sinceIso?: string): number {
  const since = sinceIso ? new Date(sinceIso) : null;
  if (since && Number.isNaN(since.getTime())) throw new Error(`Not a date: ${sinceIso}`);
  return spendByWorkspace(since).get(workspaceId) ?? 0;
}

/** A product's spend over its workspaces, against its budget. Null when there is no such product (id or slug). */
export function productSpend(productId: string, now: Date = new Date()): Spend | null {
  const p = resolveProduct(productId);
  if (!p) return null;
  return spendOf(spendWindows(now), productWorkspaces(p.id).map((r) => r.workspace_id), p.budget_usd_month);
}
