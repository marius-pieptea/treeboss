import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";

export const PRODUCT_STATUSES = ["idea", "building", "staging", "live", "paused", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const REPO_ROLES = ["web", "api", "mobile", "worker", "other"] as const;
export type RepoRole = (typeof REPO_ROLES)[number];

export interface Spend {
  allTime: number;
  thisMonth: number;
  last7Days: number;
  budgetUsdMonth: number | null;
  overBudget: boolean;
}

export interface Repo {
  product_id: string;
  workspace_id: string;
  role: RepoRole;
  path: string;
  name: string;
  /** False when the folder is gone from disk: shown as missing, and cannot be opened. */
  exists: boolean;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
  budget_usd_month: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProductView extends Product {
  repos: Repo[];
  spend: Spend | null;
}

export interface RepoProgress {
  items: number;
  shipped: number;
  tasksDone: number;
  tasksTotal: number;
}

export interface PortfolioRepo extends Repo {
  progress: RepoProgress | null;
  verify: { state: "passed" | "failed"; finished_at: string | null } | null;
  /** All-time cost of this repo, in USD. */
  spend: number;
}

export interface PortfolioProduct extends Product {
  repos: PortfolioRepo[];
  progress: RepoProgress;
  spend: Spend;
}

export const pfKey = ["portfolio"] as const;
export const productsKey = ["products"] as const;
export const productKey = (ref: string) => ["products", ref] as const;

export const useProducts = () =>
  useQuery({
    queryKey: productsKey,
    queryFn: () => get<{ products: ProductView[] }>("/api/products").then((r) => r.products),
    staleTime: 5_000,
  });

export const useProduct = (ref: string) =>
  useQuery({
    queryKey: productKey(ref),
    queryFn: () => get<{ product: ProductView }>(`/api/products/${encodeURIComponent(ref)}`).then((r) => r.product),
    staleTime: 2_000,
  });

/** The product the open workspace belongs to (the oldest, if several), its repos, and this workspace's role in it. Under the products key, so every product write refreshes it. */
export interface WorkspaceProduct extends ProductView {
  role: RepoRole;
}

export const useWorkspaceProduct = (workspaceId: string) =>
  useQuery({
    queryKey: [...productsKey, "for-workspace", workspaceId] as const,
    queryFn: () => get<{ product: WorkspaceProduct | null }>(`/api/products/for-workspace/${encodeURIComponent(workspaceId)}`).then((r) => r.product),
    staleTime: 2_000,
  });

export const usePortfolio = () =>
  useQuery({
    queryKey: pfKey,
    queryFn: () => get<{ products: PortfolioProduct[] }>("/api/portfolio").then((r) => r.products),
    // Agents keep spending while the view is open, and roadmaps change on disk: look again every half minute.
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
    staleTime: 10_000,
  });

export interface ProductInput {
  name?: string;
  description?: string;
  status?: ProductStatus;
  budget_usd_month?: number | null;
}

/** Every write refreshes the product list, the detail and the portfolio, since each one shows the others' data. */
export function useProductActions() {
  const qc = useQueryClient();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: productsKey }), qc.invalidateQueries({ queryKey: pfKey })]);
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");

  const create = useMutation({
    mutationFn: (input: ProductInput & { name: string }) => post<{ product: ProductView }>("/api/products", input).then((r) => r.product),
    onSuccess: refresh,
    onError,
  });
  const update = useMutation({
    mutationFn: ({ ref, input }: { ref: string; input: ProductInput }) => patch<{ product: ProductView }>(`/api/products/${encodeURIComponent(ref)}`, input).then((r) => r.product),
    onSuccess: (p, v) => {
      qc.setQueryData(productKey(v.ref), p);
      return refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (ref: string) => del<{ removed: boolean }>(`/api/products/${encodeURIComponent(ref)}`),
    onSuccess: refresh,
    onError,
  });
  const attach = useMutation({
    mutationFn: ({ ref, workspace, role }: { ref: string; workspace: string; role: RepoRole }) => post<{ product: ProductView }>(`/api/products/${encodeURIComponent(ref)}/repos`, { workspace, role }).then((r) => r.product),
    onSuccess: (p, v) => {
      qc.setQueryData(productKey(v.ref), p);
      return refresh();
    },
    onError,
  });
  const detach = useMutation({
    mutationFn: ({ ref, workspace }: { ref: string; workspace: string }) => del<{ product: ProductView }>(`/api/products/${encodeURIComponent(ref)}/repos?workspace=${encodeURIComponent(workspace)}`).then((r) => r.product),
    onSuccess: (p, v) => {
      qc.setQueryData(productKey(v.ref), p);
      return refresh();
    },
    onError,
  });

  return { create, update, remove, attach, detach };
}
