import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, post } from "@/lib/api";
import { queryClient } from "@/lib/queries";
import { useUi } from "@/lib/store";

export type ArtifactIntent = "document" | "slides" | "design" | "other";
export type ArtifactOwner = "mine" | "shared" | "unknown";
export type ArtifactError = "not_signed_in" | "no_plan" | "no_access" | "too_old" | "usage_limit" | "read_failed";
export type ArtifactContentKind = "html" | "markdown" | "files" | "summary";

export interface ArtifactFileEntry {
  path: string;
  size: number;
}

export interface ArtifactFilesResponse {
  files: ArtifactFileEntry[];
  base: string | null;
}

export interface Artifact {
  id: string;
  url: string;
  title: string;
  intent: ArtifactIntent;
  owner: ArtifactOwner;
  source: "created" | "pasted";
  sessionId: string | null;
  sessionTitle: string | null;
  createdAt: number;
  updatedAt: number | null;
  lastReadAt: number | null;
  htmlPath: string | null;
  summary: string | null;
  error: ArtifactError | null;
  errorText: string | null;
  typeName: string | null;
  contentKind: ArtifactContentKind | null;
  contentPath: string | null;
}

export type AccountState = "ok" | "not_signed_in" | "no_plan" | "too_old" | "usage_limit" | "unknown";
export const MIN_CLAUDE_VERSION = "2.1.318";

export interface AccountStatus {
  state: AccountState;
  version: string | null;
}

export interface ArtifactsResponse {
  items: Artifact[];
  account: AccountStatus;
}

export const artifactsKey = ["artifacts"] as const;

export function artifactHtmlUrl(id: string): string {
  return `/api/artifacts/${encodeURIComponent(id)}/html`;
}

export function artifactContentUrl(id: string): string {
  return `/api/artifacts/${encodeURIComponent(id)}/content`;
}

export function artifactFilesUrl(id: string): string {
  return `/api/artifacts/${encodeURIComponent(id)}/files`;
}

export function artifactFileUrl(id: string, filePath: string): string {
  return `/api/artifacts/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`;
}

export async function fetchArtifactContent(id: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(artifactContentUrl(id), {
    credentials: "same-origin",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `GET content failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      if (text) msg = text.slice(0, 300);
    }
    throw new Error(msg);
  }
  return res.text();
}

/** Open an external URL in the system browser (desktop intercepts window.open via setWindowOpenHandler). */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

let pendingFocusLink = false;

export function takePendingFocusLink(): boolean {
  const next = pendingFocusLink;
  pendingFocusLink = false;
  return next;
}

/** Open the Artifacts tab and focus the link paste field. */
export function openArtifactsAddLink(): void {
  pendingFocusLink = true;
  useUi.getState().openTab({ kind: "artifacts", title: "Artifacts" });
  setTimeout(() => window.dispatchEvent(new CustomEvent("trb:artifacts-focus-link")), 60);
}

/** Trigger an account-level refresh from outside the Artifacts tab (e.g. command palette). */
export async function refreshAllArtifacts(): Promise<void> {
  try {
    await post<{ account: AccountStatus; updated: number }>("/api/artifacts/refresh");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    void queryClient.invalidateQueries({ queryKey: artifactsKey });
  }
}

export function useArtifacts(polling = false) {
  return useQuery({
    queryKey: artifactsKey,
    queryFn: () => get<ArtifactsResponse>("/api/artifacts"),
    retry: false,
    refetchInterval: polling ? 2000 : false,
  });
}

export function useArtifactActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: artifactsKey });

  return {
    add: useMutation({
      mutationFn: (url: string) => post<{ item: Artifact }>("/api/artifacts", { url }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => del<{ ok: true }>(`/api/artifacts/${encodeURIComponent(id)}`),
      onSuccess: invalidate,
    }),
    restore: useMutation({
      mutationFn: (id: string) => post<{ item: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}/restore`),
      onSuccess: invalidate,
    }),
    refreshOne: useMutation({
      mutationFn: (id: string) => post<{ item: Artifact }>(`/api/artifacts/${encodeURIComponent(id)}/refresh`),
      onSuccess: invalidate,
    }),
    refreshAccount: useMutation({
      mutationFn: () => post<{ account: AccountStatus; updated: number }>("/api/artifacts/refresh"),
      onSuccess: invalidate,
    }),
  };
}
