/**
 * Every git operation the UI can perform, as plain async functions (not hooks) so the sidebar, the diff tab,
 * the context menus and the command palette all share one implementation, including the palette's commands,
 * which must work while the sidebar is not mounted.
 *
 * Each action reports its own failure (git's message, plus any hook output as the toast description) and
 * refreshes what it changed. They return whether they succeeded.
 */
import { toast } from "sonner";
import { ApiError, del, get, post, url } from "@/lib/api";
import { qk, queryClient } from "@/lib/queries";
import { create } from "zustand";
import type { GitCommitDetail } from "@/lib/types";

/** Operations in flight, keyed by name, so buttons can show a spinner wherever they are drawn. */
export const useBusy = create<{ busy: Record<string, boolean>; set(k: string, v: boolean): void }>((s) => ({
  busy: {},
  set: (k, v) =>
    s((st) => {
      const next = { ...st.busy };
      if (v) next[k] = true;
      else delete next[k];
      return { busy: next };
    }),
}));

export function reportError(e: unknown, title?: string): void {
  const err = e as ApiError;
  const detail = err instanceof ApiError ? err.detail : undefined;
  // The first line is the message; the rest (a hook's output, git's hints) is the description.
  const extra = detail && detail.trim() !== err.message.trim() ? detail.trim().slice(0, 700) : undefined;
  toast.error(title ? `${title}: ${err.message.split("\n")[0]}` : err.message.split("\n")[0], { description: extra ? <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-code)", fontSize: 11, maxHeight: 180, overflow: "auto" }}>{extra}</pre> : undefined, duration: extra ? 9000 : 5000 });
}

/** Refresh git state, and the file tree and open editors when the working tree itself may have changed. */
export function refreshGit(root: string, opts: { files?: boolean } = {}): Promise<unknown> {
  const jobs = [queryClient.invalidateQueries({ queryKey: qk.git(root) })];
  if (opts.files) jobs.push(queryClient.invalidateQueries({ queryKey: qk.fsAll(root) }));
  return Promise.all(jobs);
}

export type PullMode = "ff-only" | "rebase" | "merge";

export interface GitActions {
  root: string;
  stage(paths: string[]): Promise<boolean>;
  unstage(paths: string[]): Promise<boolean>;
  discard(paths: string[], all?: boolean): Promise<boolean>;
  apply(patch: string, o: { cached?: boolean; reverse?: boolean }): Promise<boolean>;
  commit(message: string, o?: { amend?: boolean; noVerify?: boolean }): Promise<GitCommitResult | null>;
  checkout(name: string, remote?: boolean): Promise<boolean>;
  detach(sha: string): Promise<boolean>;
  createBranch(name: string, from?: string): Promise<boolean>;
  deleteBranch(name: string, force?: boolean): Promise<boolean>;
  merge(name: string): Promise<boolean>;
  abort(op: string): Promise<boolean>;
  resolve(path: string, side: "ours" | "theirs"): Promise<boolean>;
  fetch(): Promise<boolean>;
  pull(mode?: PullMode): Promise<boolean>;
  push(o?: { setUpstream?: boolean; branch?: string; forceWithLease?: boolean }): Promise<boolean>;
  stashPush(message: string, includeUntracked?: boolean): Promise<boolean>;
  stashOp(op: "apply" | "pop" | "drop", index: number): Promise<boolean>;
  init(): Promise<boolean>;
  /** Create a GitHub repository from this folder with the user's `gh` login, add it as origin and push. */
  publish(o: { name: string; visibility: "private" | "public"; description?: string }): Promise<boolean>;
  /** Add the folder git refuses (owned by another user) to the global safe.directory list. */
  trust(): Promise<boolean>;
  lastCommit(): Promise<GitCommitDetail | null>;
}

export interface GitCommitResult {
  sha: string;
  summary: string;
  output: string;
}

export function gitActions(root: string): GitActions {
  const run = async <T,>(key: string | null, fn: () => Promise<T>, o: { title?: string; files?: boolean; ok?: (r: T) => void } = {}): Promise<{ ok: true; value: T } | { ok: false }> => {
    if (key) useBusy.getState().set(key, true);
    try {
      const value = await fn();
      o.ok?.(value);
      await refreshGit(root, { files: o.files });
      return { ok: true, value };
    } catch (e) {
      reportError(e, o.title);
      await refreshGit(root); // a failed merge or pull can still have changed state
      return { ok: false };
    } finally {
      if (key) useBusy.getState().set(key, false);
    }
  };
  const g = (op: string, params?: Record<string, any>) => url.git(root, op, params);
  const t = (op: string) => url.git(root, `t/${op}`);
  const out = (r: { output?: string }, fallback: string) => {
    const text = r.output?.trim();
    toast.success(fallback, text ? { description: text.split("\n").slice(-3).join("\n") } : undefined);
  };

  return {
    root,
    stage: async (paths) => (await run(null, () => post(t("stage"), { paths }), { title: "Stage" })).ok,
    unstage: async (paths) => (await run(null, () => post(t("unstage"), { paths }), { title: "Unstage" })).ok,
    discard: async (paths, all) => (await run(null, () => post(t("discard"), { paths, all }), { title: "Discard", files: true })).ok,
    apply: async (patch, o) => (await run(null, () => post(t("apply"), { patch, ...o }), { title: "Apply", files: !o.cached })).ok,
    commit: async (message, o = {}) => {
      const r = await run("commit", () => post<GitCommitResult>(g("commit"), { message, amend: o.amend, noVerify: o.noVerify }), { title: "Commit", files: false });
      return r.ok ? r.value : null;
    },
    checkout: async (name, remote) => (await run("checkout", () => post(g("checkout"), { name, remote }), { title: "Checkout", files: true, ok: () => toast.success(`Switched to ${remote ? name.replace(/^[^/]+\//, "") : name}`) })).ok,
    detach: async (sha) => (await run("checkout", () => post(g("detach"), { sha }), { title: "Checkout", files: true, ok: () => toast.success(`Detached at ${sha.slice(0, 7)}`) })).ok,
    createBranch: async (name, from) => (await run("checkout", () => post(g("branch"), { name, from }), { title: "Create branch", files: true, ok: () => toast.success(`Created and switched to ${name}`) })).ok,
    deleteBranch: async (name, force) => (await run(null, () => del(g("branch", { name, force })), { title: "Delete branch", ok: () => toast.success(`Deleted ${name}`) })).ok,
    merge: async (name) =>
      (
        await run("merge", () => post<{ conflicts: boolean; output: string }>(g("merge"), { name }), {
          title: "Merge",
          files: true,
          ok: (r) => (r.conflicts ? toast.warning(`Merge has conflicts`, { description: "Resolve them in Source Control, then commit." }) : toast.success(`Merged ${name}`)),
        })
      ).ok,
    abort: async (op) => (await run("merge", () => post(g("abort"), { operation: op }), { title: "Abort", files: true, ok: () => toast.success(`Aborted ${op}`) })).ok,
    resolve: async (path, side) => (await run(null, () => post(g("resolve"), { path, side }), { title: "Resolve", files: true })).ok,
    fetch: async () => (await run("fetch", () => post<{ output: string }>(g("fetch")), { title: "Fetch", ok: (r) => out(r, "Fetched") })).ok,
    pull: async (mode = "ff-only") => (await run("pull", () => post<{ output: string }>(g("pull"), { mode }), { title: "Pull", files: true, ok: (r) => out(r, "Pulled") })).ok,
    push: async (o = {}) => (await run("push", () => post<{ output: string }>(g("push"), o), { title: "Push", ok: (r) => out(r, o.setUpstream ? "Published branch" : "Pushed") })).ok,
    stashPush: async (message, includeUntracked = true) => (await run("stash", () => post(g("stash"), { message, includeUntracked }), { title: "Stash", files: true, ok: () => toast.success("Stashed changes") })).ok,
    stashOp: async (op, index) => (await run("stash", () => post<{ output: string }>(g(`stash/${op}`), { index }), { title: `Stash ${op}`, files: op !== "drop" })).ok,
    init: async () =>
      (
        await run("init", () => post(g("init")), {
          title: "Init",
          files: true,
          ok: () => {
            toast.success("Initialized empty repository");
            // The workspace's cached "is this a repo" answer is now wrong.
            void queryClient.invalidateQueries({ queryKey: qk.root(root) });
          },
        })
      ).ok,
    publish: async (o) =>
      (
        await run("publish", () => post<{ url: string }>(g("publish"), o), {
          title: "Publish",
          files: false,
          ok: (r) => {
            toast.success(`Published as ${o.visibility}`, { description: r.url || o.name });
            void queryClient.invalidateQueries({ queryKey: qk.root(root) });
          },
        })
      ).ok,
    trust: async () =>
      (
        await run("trust", () => post<{ trusted: string }>(g("trust")), {
          title: "Trust folder",
          files: true,
          ok: (r) => {
            toast.success("Folder trusted", { description: r.trusted });
            void queryClient.invalidateQueries({ queryKey: qk.root(root) });
          },
        })
      ).ok,
    lastCommit: async () => {
      try {
        return await get<GitCommitDetail>(g("commit/HEAD"));
      } catch {
        return null;
      }
    },
  };
}
