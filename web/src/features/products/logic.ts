/** Pure helpers for the portfolio: how far a budget is used, how far a roadmap has got, which repo a product opens to. No React here. */
import type { RepoProgress, RepoRole, Spend } from "./data";

/** A budget is "near" from this share used, so the bar warns before it is over. */
export const NEAR_BUDGET = 0.8;

export type BudgetTone = "none" | "ok" | "near" | "over";

export interface BudgetBar {
  /** Share of the budget used, 0 to 1 for the bar, uncapped in `share`. Null without a budget. */
  share: number | null;
  /** Bar fill width, capped at 100%. */
  width: number;
  tone: BudgetTone;
}

export function budgetBar(spend: Spend | null): BudgetBar {
  const budget = spend?.budgetUsdMonth ?? null;
  if (!spend || budget === null) return { share: null, width: 0, tone: "none" };
  if (budget === 0) return { share: spend.thisMonth > 0 ? Infinity : 0, width: spend.thisMonth > 0 ? 100 : 0, tone: spend.thisMonth > 0 ? "over" : "ok" };
  const share = spend.thisMonth / budget;
  const tone: BudgetTone = spend.overBudget ? "over" : share >= NEAR_BUDGET ? "near" : "ok";
  return { share, width: Math.min(share, 1) * 100, tone };
}

/** Shipped items as a percent of the items in the roadmap. Null when there are no items. */
export function shippedPercent(p: Pick<RepoProgress, "items" | "shipped"> | null): number | null {
  if (!p || p.items === 0) return null;
  return Math.round((p.shipped / p.items) * 100);
}

export const money = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

/** "$3.20 of $10.00 this month", or the spend alone when there is no budget. */
export function spendLine(spend: Spend): string {
  if (spend.budgetUsdMonth === null) return `${money(spend.thisMonth)} this month, no budget`;
  return `${money(spend.thisMonth)} of ${money(spend.budgetUsdMonth)} this month`;
}

/** Repo roles in the order a product's "primary" repo is picked: the web app first, the rest after it. */
export const ROLE_ORDER: readonly RepoRole[] = ["web", "api", "mobile", "worker", "other"];

/** What the portfolio needs to know about a repo to pick, sort and mark it. */
export interface RepoRef {
  workspace_id: string;
  role: RepoRole;
  exists: boolean;
}

/** The repo a card's Open goes to: the first by role order. Ties keep the list's order. Null for no repos. */
export function primaryRepo<T extends Pick<RepoRef, "role">>(repos: T[]): T | null {
  let best: T | null = null;
  let bestRank = Infinity;
  for (const r of repos) {
    const i = ROLE_ORDER.indexOf(r.role);
    const rank = i === -1 ? ROLE_ORDER.length : i;
    if (rank < bestRank) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/** Products that hold the open workspace come first, the rest keep the portfolio's order. */
export function sortCurrentFirst<T extends { repos: Array<Pick<RepoRef, "workspace_id">> }>(products: T[], workspaceId: string | null): T[] {
  if (!workspaceId) return products;
  const holds = (p: T) => p.repos.some((r) => r.workspace_id === workspaceId);
  return [...products.filter(holds), ...products.filter((p) => !holds(p))];
}

/** Whether a product holds the open workspace. */
export function isCurrentProduct(p: { repos: Array<Pick<RepoRef, "workspace_id">> }, workspaceId: string | null): boolean {
  return !!workspaceId && p.repos.some((r) => r.workspace_id === workspaceId);
}

/**
 * The banner's state: the open workspace is in no product. Nothing shows while there is no workspace, or before
 * the portfolio has loaded (`products` undefined), so it does not flash on the way in.
 */
export function isLooseWorkspace(workspaceId: string | null, products: Array<{ repos: Array<Pick<RepoRef, "workspace_id">> }> | undefined): boolean {
  if (!workspaceId || !products) return false;
  return !products.some((p) => isCurrentProduct(p, workspaceId));
}

/** What a repo row shows: whether it is the open workspace, whether its folder is gone, and whether Switch is offered. */
export function repoSwitch(repo: Pick<RepoRef, "workspace_id" | "exists">, workspaceId: string | null): { open: boolean; missing: boolean; canSwitch: boolean } {
  const open = repo.workspace_id === workspaceId;
  const missing = !repo.exists;
  return { open, missing, canSwitch: !open && !missing };
}
