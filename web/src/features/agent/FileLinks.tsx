/**
 * Clickable file mentions in a conversation. `FileLinkScope` wraps a thread: it loads the files of the root the
 * session works in (the workspace, or the session's worktree), and everything below can ask whether a piece of
 * text names one of them (`useFileLinks`). Outside a scope nothing links, so Markdown used elsewhere is unchanged.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { get, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { qk } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { WorkspaceContext } from "@/lib/workspace";
import type { SessionView } from "@/lib/types";
import { createFileIndex, resolveFileRef, toolFilePaths, type FileIndex, type FileRef } from "./file-links";

export interface FileLinksValue {
  index: FileIndex;
  /** Absolute directory the session works in, to turn absolute paths in prose into relative ones. */
  cwd: string | undefined;
  open(ref: FileRef): void;
}

export const FileLinksContext = createContext<FileLinksValue | null>(null);

/** The scope's index and opener, or null outside one. */
export function useFileLinks(): FileLinksValue | null {
  return useContext(FileLinksContext);
}

type ScopeSession = Pick<SessionView, "id" | "isolation" | "cwd">;

/**
 * Where a session's files live. A worktree session's own directory is its root (the file API takes a session id);
 * any other session works in the workspace, so its files open in the same tabs as the file tree's.
 */
export function fileRootFor(session: ScopeSession, workspace: { root: string; path: string } | null): { root: string; cwd: string } {
  if (session.isolation === "worktree" || !workspace) return { root: session.id, cwd: session.cwd };
  return { root: workspace.root, cwd: workspace.path };
}

interface ScopeProps {
  session: ScopeSession | null;
  /** The transcript so far: files the agent wrote this turn are linked before the file list catches up. */
  items?: ReadonlyArray<{ type: string; name?: string; arg?: string; session?: string }>;
  running?: boolean;
  children: ReactNode;
}

export function FileLinkScope({ session, items, running, children }: ScopeProps) {
  const ws = useContext(WorkspaceContext);
  const qc = useQueryClient();
  const target = useMemo(() => (session ? fileRootFor(session, ws ? { root: ws.root, path: ws.workspace.path } : null) : null), [session?.id, session?.isolation, session?.cwd, ws?.root, ws?.workspace.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const root = target?.root ?? "";
  const cwd = target?.cwd;

  // Same key as quick-open and the composer's @-menu, so the list is fetched once and shared.
  const files = useQuery({
    queryKey: [...qk.fsAll(root), "find"],
    enabled: !!root,
    queryFn: () => get<{ files: string[] }>(url.fs(root, "find")).then((r) => r.files),
    staleTime: 20_000,
    retry: false,
  });

  // A run that just ended may have created files: refresh once so they link.
  const wasRunning = useRef(!!running);
  useEffect(() => {
    if (wasRunning.current && !running && root) void qc.invalidateQueries({ queryKey: [...qk.fsAll(root), "find"] });
    wasRunning.current = !!running;
  }, [running, root, qc]);

  const touched = useMemo(() => (items ? toolFilePaths(items, cwd, session?.id) : []), [items, cwd, session?.id]);
  const listed = files.data;
  const index = useMemo(() => createFileIndex([...(listed ?? []), ...touched]), [listed, touched]);

  const open = useCallback(
    (ref: FileRef) => {
      useUi.getState().openTab({ kind: "file", root, path: ref.path, title: basename(ref.path), line: ref.line });
      if (ref.line) bus.emit("editor-goto", { path: ref.path, line: ref.line, column: ref.col });
    },
    [root],
  );

  const value = useMemo<FileLinksValue | null>(() => (root ? { index, cwd, open } : null), [root, index, cwd, open]);
  return <FileLinksContext.Provider value={value}>{children}</FileLinksContext.Provider>;
}

/** An inline file mention in prose: a button that opens the file (at its line) in the editor. */
export function FileLink({ path, line, col, children }: { path: string; line?: number; col?: number; children: ReactNode }) {
  const links = useFileLinks();
  const ref: FileRef = { path, line, col };
  return (
    <button
      type="button"
      data-file-link={path}
      data-file-line={line}
      title={`Open ${path}${line ? `:${line}` : ""}`}
      onClick={() => links?.open(ref)}
      className="file-link"
    >
      {children}
    </button>
  );
}

/** For a tool call's argument: a small open button when it names a real file, nothing otherwise. */
export function OpenFileButton({ arg, className }: { arg: string; className?: string }) {
  const links = useFileLinks();
  const ref = useMemo(() => (links ? resolveFileRef(arg.trim(), links.index, links.cwd) : null), [links, arg]);
  if (!links || !ref) return null;
  return (
    <button
      type="button"
      data-file-link={ref.path}
      aria-label={`Open ${ref.path}`}
      title={`Open ${ref.path}${ref.line ? `:${ref.line}` : ""}`}
      onClick={() => links.open(ref)}
      className={cn("flex size-5 shrink-0 items-center justify-center rounded text-fg-faint outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-1 focus-visible:ring-accent", className)}
    >
      <ExternalLink className="size-3" />
    </button>
  );
}
