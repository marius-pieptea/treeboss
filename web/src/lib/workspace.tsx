import { createContext, useContext } from "react";
import type { RepoInfo, Workspace } from "./types";

export interface WorkspaceCtx {
  workspace: Workspace;
  /** Root reference for the workspace's own files and git: the workspace id. */
  root: string;
  repo: RepoInfo | undefined;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const c = useContext(WorkspaceContext);
  if (!c) throw new Error("useWorkspace outside a workspace");
  return c;
}

/**
 * Where a git path lives in the workspace. Git speaks repo-relative paths; the file API speaks
 * workspace-relative ones. They differ only when the workspace is a subdirectory of a repo.
 */
export function gitToFsPath(gitPath: string, prefix: string | undefined): string | null {
  const p = prefix ?? "";
  if (!p) return gitPath;
  return gitPath.startsWith(p) ? gitPath.slice(p.length) : null;
}

export function fsToGitPath(fsPath: string, prefix: string | undefined): string {
  return `${prefix ?? ""}${fsPath}`;
}
