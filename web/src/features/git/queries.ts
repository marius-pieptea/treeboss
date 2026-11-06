import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { get, url } from "@/lib/api";
import type { GitBranch, GitLogEntry, GitStash } from "@/lib/types";

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/** Keys all start with ["git", root] so `qk.git(root)` invalidates every one of them at once. */
export const gk = {
  branches: (root: string) => ["git", root, "branches"] as const,
  log: (root: string, o: { all: boolean; path: string }) => ["git", root, "log", o] as const,
  stashes: (root: string) => ["git", root, "stashes"] as const,
  worktrees: (root: string) => ["git", root, "worktrees"] as const,
  commit: (root: string, sha: string) => ["git", root, "commit", sha] as const,
  diff: (root: string, params: Record<string, unknown>) => ["git", root, "diff", params] as const,
};

export const useBranches = (root: string, enabled = true) =>
  useQuery({ queryKey: gk.branches(root), enabled, queryFn: () => get<{ branches: GitBranch[] }>(url.git(root, "branches")).then((r) => r.branches), staleTime: 3000 });

export const useStashes = (root: string, enabled = true) => useQuery({ queryKey: gk.stashes(root), enabled, queryFn: () => get<{ stashes: GitStash[] }>(url.git(root, "stash")).then((r) => r.stashes), staleTime: 3000 });

export const useWorktrees = (root: string, enabled = true) => useQuery({ queryKey: gk.worktrees(root), enabled, queryFn: () => get<{ worktrees: Worktree[] }>(url.git(root, "worktrees")).then((r) => r.worktrees), staleTime: 5000 });

const PAGE = 60;

/** History, newest first, in pages. The graph is computed over everything loaded so far. */
export const useHistory = (root: string, o: { all: boolean; path: string }, enabled = true) =>
  useInfiniteQuery({
    queryKey: gk.log(root, o),
    enabled,
    initialPageParam: 0,
    staleTime: 3000,
    queryFn: ({ pageParam }) => get<{ commits: GitLogEntry[] }>(url.git(root, "t/log", { limit: PAGE, skip: pageParam, all: o.all, path: o.path || undefined })).then((r) => r.commits),
    getNextPageParam: (last, all) => (last.length < PAGE ? undefined : all.length * PAGE),
  });

export type { Worktree };
