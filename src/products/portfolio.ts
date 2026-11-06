/**
 * The portfolio: every product on one screen. For each product, its status, its repos (with the roadmap progress
 * of each and the last verify result), and what it has cost against its budget.
 *
 * Roadmap progress is read from each repo's ROADMAP.md through the roadmap store. A repo with no readable
 * roadmap reports null progress rather than failing the whole view.
 */
import { table as verifyTable } from "../verify/store";
import { readRoadmap } from "../roadmap/store";
import { owningWorkspace } from "../workspaces";
import { spendOf, spendWindows, type Spend } from "./cost";
import { listProducts, productRepoStates, type Product, type ProductRepo } from "./store";

export interface RepoProgress {
  items: number;
  shipped: number;
  tasksDone: number;
  tasksTotal: number;
}

export interface VerifyStatus {
  /** The newest run that finished, passed or failed. */
  state: "passed" | "failed";
  finished_at: string | null;
}

export interface PortfolioRepo extends ProductRepo {
  /** False when the repo's folder is gone: it is shown as missing and cannot be opened. */
  exists: boolean;
  /** Null when the repo has no readable roadmap. */
  progress: RepoProgress | null;
  verify: VerifyStatus | null;
  /** All-time cost of this repo's agents, in USD. */
  spend: number;
}

export interface PortfolioProduct extends Product {
  repos: PortfolioRepo[];
  /** Roadmap items across the repos, and how many have shipped. */
  progress: RepoProgress;
  spend: Spend;
}

/** Newest finished verify run per workspace. Reads the latest runs only, so an old repo may show no result. */
export function lastVerifyByWorkspace(limit = 500): Map<string, VerifyStatus> {
  const rows = verifyTable()
    .prepare(
      `SELECT vr.state, vr.finished_at, s.base_cwd AS cwd
         FROM verify_runs vr JOIN sessions s ON s.id = vr.session_id
        WHERE vr.state IN ('passed', 'failed')
        ORDER BY vr.started_at DESC, vr.rowid DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ state: "passed" | "failed"; finished_at: string | null; cwd: string }>;
  const out = new Map<string, VerifyStatus>();
  for (const r of rows) {
    const owner = owningWorkspace(r.cwd);
    if (owner && !out.has(owner)) out.set(owner, { state: r.state, finished_at: r.finished_at });
  }
  return out;
}

/** Roadmap progress for one repo folder, or null when it has no readable ROADMAP.md. */
export function repoProgress(path: string): RepoProgress | null {
  try {
    const state = readRoadmap(path);
    if (!state.exists) return null;
    const p: RepoProgress = { items: 0, shipped: 0, tasksDone: 0, tasksTotal: 0 };
    for (const lane of state.lanes) {
      for (const item of lane.items) {
        p.items++;
        if (item.status === "shipped") p.shipped++;
        if (item.progress) {
          p.tasksDone += item.progress.done;
          p.tasksTotal += item.progress.total;
        }
      }
    }
    return p;
  } catch {
    return null;
  }
}

function sumProgress(repos: PortfolioRepo[]): RepoProgress {
  const total: RepoProgress = { items: 0, shipped: 0, tasksDone: 0, tasksTotal: 0 };
  for (const r of repos) {
    if (!r.progress) continue;
    total.items += r.progress.items;
    total.shipped += r.progress.shipped;
    total.tasksDone += r.progress.tasksDone;
    total.tasksTotal += r.progress.tasksTotal;
  }
  return total;
}

export function portfolio(now: Date = new Date()): PortfolioProduct[] {
  const windows = spendWindows(now);
  const verify = lastVerifyByWorkspace();
  return listProducts().map((p) => {
    const repos: PortfolioRepo[] = productRepoStates(p.id).map((r) => ({
      ...r,
      progress: repoProgress(r.path),
      verify: verify.get(r.workspace_id) ?? null,
      spend: spendOf(windows, [r.workspace_id], null).allTime,
    }));
    return {
      ...p,
      repos,
      progress: sumProgress(repos),
      spend: spendOf(windows, repos.map((r) => r.workspace_id), p.budget_usd_month),
    };
  });
}
