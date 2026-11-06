/**
 * Everything the UI does to a head: merge, close, interrupt, follow up, spawn, open a terminal in its worktree.
 * Each call confirms what is destructive, toasts the outcome in the server's own words, and refreshes what changed.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import type { SessionView, TerminalInfo } from "@/lib/types";
import { confirm } from "@/components/ui/dialogs";
import { hasUnmergedWork, isFinished, isMergeReady } from "./model";
import { requestSessionPane } from "@/features/session/intent";

export interface MergeResult {
  merged: boolean;
  message: string;
  files: string[];
}

export interface SpawnInput {
  brief: string;
  title?: string;
  role?: string;
  agent?: string;
  engine?: string;
  model?: string;
  effort?: string;
  isolate?: boolean;
}

function refresh(qc: QueryClient, root: string): void {
  qc.invalidateQueries({ queryKey: qk.sessionsAll });
  qc.invalidateQueries({ queryKey: ["session"] });
  qc.invalidateQueries({ queryKey: qk.git(root) });
  qc.invalidateQueries({ queryKey: qk.fsAll(root) });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useHeadActions() {
  const qc = useQueryClient();
  const { root } = useWorkspace();

  const open = (h: Pick<SessionView, "id" | "title" | "role" | "engine">, view?: "conversation" | "changes" | "files" | "info") => {
    if (view) requestSessionPane(h.id, view);
    useUi.getState().openTab({ kind: "session", sessionId: h.id, title: h.role ? `${h.role}: ${h.title}` : h.title });
  };

  const merge = async (h: SessionView, opts: { skipConfirm?: boolean } = {}): Promise<MergeResult | null> => {
    if (!opts.skipConfirm) {
      const n = h.changes?.files ?? 0;
      const ok = await confirm({
        title: `Merge ${h.role ?? h.engine}: ${h.title}`,
        description: `${n} file${n === 1 ? "" : "s"} from ${h.branch ?? "its worktree"} will be applied to the parent's checkout as uncommitted edits. Nothing is committed, and a conflict applies nothing.`,
        confirmLabel: "Merge",
      });
      if (!ok) return null;
    }
    try {
      const r = await post<MergeResult>(`/api/sessions/${h.id}/merge`);
      if (r.merged) toast.success(r.message);
      else toast.warning(r.message, { duration: 9000 });
      return r;
    } catch (e) {
      toast.error(errText(e));
      return null;
    } finally {
      refresh(qc, root);
    }
  };

  /** Merge every head that is ready, one after another (they may touch the same files, so not in parallel). */
  const mergeAll = async (heads: SessionView[]) => {
    const ready = heads.filter(isMergeReady);
    if (!ready.length) return;
    const ok = await confirm({
      title: `Merge ${ready.length} head${ready.length === 1 ? "" : "s"}`,
      description: `Each head's changes are applied to the parent's checkout as uncommitted edits, in order. A head that conflicts applies nothing and is reported.`,
      confirmLabel: `Merge ${ready.length}`,
    });
    if (!ok) return;
    let merged = 0;
    const problems: string[] = [];
    for (const h of ready) {
      const r = await merge(h, { skipConfirm: true });
      if (r?.merged) merged++;
      else problems.push(h.title);
    }
    if (problems.length) toast.warning(`Merged ${merged} of ${ready.length}. Needs attention: ${problems.join(", ")}`, { duration: 9000 });
  };

  const close = async (h: SessionView, opts: { skipConfirm?: boolean } = {}): Promise<boolean> => {
    if (!opts.skipConfirm && hasUnmergedWork(h)) {
      const ok = await confirm({
        title: `Close ${h.role ?? h.engine}: ${h.title}?`,
        description: `Its changes are not merged. The worktree is removed, but the branch ${h.branch ?? ""} is kept, so nothing is lost.`,
        confirmLabel: "Close head",
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      await post(`/api/sessions/${h.id}/close`);
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    } finally {
      refresh(qc, root);
    }
  };

  const closeFinished = async (heads: SessionView[]) => {
    const done = heads.filter(isFinished);
    if (!done.length) return;
    const ok = await confirm({ title: `Close ${done.length} finished head${done.length === 1 ? "" : "s"}?`, description: "Only heads with nothing unmerged are closed.", confirmLabel: "Close" });
    if (!ok) return;
    for (const h of done) await close(h, { skipConfirm: true });
    toast.success(`Closed ${done.length} head${done.length === 1 ? "" : "s"}`);
  };

  const interrupt = async (h: SessionView) => {
    try {
      await post(`/api/sessions/${h.id}/interrupt`);
      toast(`Interrupted ${h.title}. It keeps its context; send a follow-up to resume.`);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      refresh(qc, root);
    }
  };

  const send = async (h: Pick<SessionView, "id">, message: string): Promise<boolean> => {
    try {
      await post(`/api/sessions/${h.id}/send`, { message });
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    } finally {
      refresh(qc, root);
    }
  };

  const spawn = async (parentId: string, input: SpawnInput): Promise<SessionView | null> => {
    try {
      const r = await post<{ session: SessionView }>(`/api/sessions/${parentId}/spawn`, { ...input, isolate: input.isolate === false ? false : "auto" });
      toast.success(`Opened ${r.session.role ?? r.session.engine}: ${r.session.title}`);
      return r.session;
    } catch (e) {
      toast.error(errText(e));
      return null;
    } finally {
      refresh(qc, root);
    }
  };

  const openTerminal = async (h: Pick<SessionView, "id">) => {
    try {
      const r = await post<{ terminal: TerminalInfo }>("/api/terminals", { root: h.id });
      useUi.getState().setBottomTab("terminal");
      window.dispatchEvent(new CustomEvent("trb:terminals-changed", { detail: { focus: r.terminal.id } }));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const copyBranch = async (h: SessionView) => {
    if (!h.branch) return;
    await navigator.clipboard.writeText(h.branch);
    toast.success(`Copied ${h.branch}`);
  };

  return { open, merge, mergeAll, close, closeFinished, interrupt, send, spawn, openTerminal, copyBranch };
}

export type HeadActions = ReturnType<typeof useHeadActions>;
