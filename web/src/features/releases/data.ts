import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Who } from "@/components/agent-who";
import { get, post, put } from "@/lib/api";

/** The release bumps the operator can pick. "auto" lets the agent propose one from the commits. */
export const BUMPS = ["auto", "patch", "minor", "major", "prerelease"] as const;
export type DraftBump = (typeof BUMPS)[number];
export const AUDIENCES = ["users", "developers", "both"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The range and options a changelog draft is written from, and the engine and model that write it. */
export interface DraftInput extends Who {
  base: string;
  bump: DraftBump;
  audience: Audience;
}

/** What the draft endpoint receives. An empty base is sent as null: the server then uses the last tag. */
export interface DraftBody extends Who {
  base: string | null;
  bump: DraftBump;
  audience: Audience;
}

/** The POST a changelog draft starts: the range, the options, and the chosen engine and model. */
export function draftRequest(root: string, v: DraftInput): { path: string; body: DraftBody } {
  return { path: `/api/releases/${encodeURIComponent(root)}/draft`, body: { base: v.base || null, bump: v.bump, audience: v.audience, engine: v.engine, model: v.model } };
}

export interface ReleaseDoc {
  version: string;
  file: string;
  status: string | null;
  meta: Record<string, string>;
  sessionId: string | null;
  body?: string;
}

export interface ReleasesView {
  workspace: { id: string; name: string; path: string };
  version: { file: string; version: string; candidates: Record<"patch" | "minor" | "major" | "prerelease", string>; files: Array<{ file: string; version: string; stack: string }> } | null;
  head: { sha: string; branch: string | null };
  dirty: boolean;
  tags: string[];
  releases: ReleaseDoc[];
  drafts: ReleaseDoc[];
  sessions: Array<{ sessionId: string; kind: string; subject: string; createdAt: string }>;
  draftsDir: string;
}

export interface RangeData {
  base: { kind: string; label: string; sha: string | null; tag: string | null; date: string | null };
  head: { sha: string; branch: string | null };
  commits: Array<{ sha: string; subject: string; body: string; author: string; date: string; files: string[] }>;
  truncated: boolean;
  diff: { files: number; insertions: number; deletions: number; top: Array<{ path: string; insertions: number; deletions: number }> };
  roadmap: Array<{ id: string | null; title: string }>;
  specs: Array<{ feature: string; done: number; total: number; newlyDone: string[] }>;
  prs: Array<{ number: number; title: string; url: string; mergedAt: string }>;
  breaking: string[];
  warnings: string[];
}

export interface PublishOptions {
  push: boolean;
  ghRelease: boolean;
  deploy: string | null;
}

export interface PublishResult {
  version: string;
  tag: string;
  commit: string;
  pushed: boolean;
  releaseUrl: string | null;
  deployId: string | null;
  warnings: string[];
}

export interface ProductReleases {
  product: { id: string; name: string; slug: string };
  repos: Array<{ workspaceId: string; name: string; role: string; latest: { version: string; date: string | null; tag: string | null } | null }>;
  notes: string[];
}

export interface Product {
  id: string;
  name: string;
  slug: string;
}

export const releasesKey = (root: string) => ["releases", root] as const;

/** Everything the page shows for one workspace: the version, tags, drafts, published releases and sessions. */
export const useReleases = (root: string | null) =>
  useQuery({
    queryKey: releasesKey(root ?? ""),
    enabled: !!root,
    queryFn: () => get<ReleasesView>(`/api/releases/${encodeURIComponent(root!)}`),
    staleTime: 3000,
  });

/** The range from a base point. `base` is a tag, a sha, a date, or "" for the last tag. */
export const useRange = (root: string | null, base: string, prs: boolean) =>
  useQuery({
    queryKey: [...releasesKey(root ?? ""), "range", base, prs],
    enabled: !!root,
    queryFn: () => get<{ range: RangeData }>(`/api/releases/${encodeURIComponent(root!)}/range?base=${encodeURIComponent(base)}&prs=${prs ? 1 : 0}`).then((r) => r.range),
    staleTime: 10_000,
    retry: false,
  });

export const useDraft = (root: string, version: string | null) =>
  useQuery({
    queryKey: [...releasesKey(root), "draft", version],
    enabled: !!version,
    queryFn: () => get<{ draft: ReleaseDoc }>(`/api/releases/${encodeURIComponent(root)}/drafts/${encodeURIComponent(version!)}`).then((r) => r.draft),
  });

export function useReleaseActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: releasesKey(root) });
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");

  const draft = useMutation({
    mutationFn: (v: DraftInput) => {
      const r = draftRequest(root, v);
      return post<{ sessionId: string; version: string | null; commits: number; base: string; suggested: { bump: string; reason: string } }>(r.path, r.body);
    },
    onSuccess: (r) => {
      toast.success("Drafting the notes", { description: `${r.commits} commit${r.commits === 1 ? "" : "s"} since ${r.base}. The draft appears here when the session is done.` });
      void refresh();
    },
    onError,
  });

  const save = useMutation({
    mutationFn: ({ version, body }: { version: string; body: string }) => put<{ draft: ReleaseDoc }>(`/api/releases/${encodeURIComponent(root)}/drafts/${encodeURIComponent(version)}`, { body }),
    onSuccess: (_r, v) => {
      toast.success(`Saved the ${v.version} draft`);
      void qc.invalidateQueries({ queryKey: [...releasesKey(root), "draft", v.version] });
      void refresh();
    },
    onError,
  });

  const revise = useMutation({
    mutationFn: ({ version, instructions }: { version: string; instructions: string }) => post<{ sessionId: string }>(`/api/releases/${encodeURIComponent(root)}/drafts/${encodeURIComponent(version)}/revise`, { instructions }),
    onSuccess: () => {
      toast.success("Sent to the agent that wrote the draft");
      void refresh();
    },
    onError,
  });

  const publish = useMutation({
    mutationFn: ({ version, options }: { version: string; options: PublishOptions }) => post<PublishResult>(`/api/releases/${encodeURIComponent(root)}/drafts/${encodeURIComponent(version)}/publish`, options),
    onSuccess: (r) => {
      for (const w of r.warnings) toast.warning(w);
      toast.success(`Published ${r.tag}`, { description: r.pushed ? "Committed, tagged and pushed." : "Committed and tagged. Nothing is pushed." });
      void refresh();
    },
    onError,
  });

  return { draft, save, revise, publish };
}

export const productsKey = ["products"] as const;

export const useProducts = () =>
  useQuery({
    queryKey: productsKey,
    queryFn: () => get<{ products: Product[] }>("/api/products").then((r) => r.products),
    staleTime: 30_000,
  });

export const useProductReleases = (productId: string | null) =>
  useQuery({
    queryKey: ["releases", "product", productId ?? ""],
    enabled: !!productId,
    queryFn: () => get<ProductReleases>(`/api/releases/product/${encodeURIComponent(productId!)}`),
  });

/** The audience a combined product note is written for, and the engine and model that write it. */
export interface ProductNotesInput extends Who {
  audience: Audience;
}

/** The POST a combined product note starts: the audience and the chosen engine and model. */
export function productNotesRequest(productId: string, v: ProductNotesInput): { path: string; body: ProductNotesInput } {
  return { path: `/api/releases/product/${encodeURIComponent(productId)}/draft`, body: { audience: v.audience, engine: v.engine, model: v.model } };
}

export function useProductNotes(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ProductNotesInput) => {
      const r = productNotesRequest(productId, v);
      return post<{ sessionId: string; file: string }>(r.path, r.body);
    },
    onSuccess: (r) => {
      toast.success("Drafting the product notes", { description: r.file });
      void qc.invalidateQueries({ queryKey: ["releases", "product", productId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "The product notes did not start."),
  });
}

/** The deploy environments of a workspace, for the publish's deploy choice. */
export const useEnvs = (root: string | null) =>
  useQuery({
    queryKey: ["deploy", root ?? "", "envs"],
    enabled: !!root,
    queryFn: () => get<{ targets: Array<{ env: string }> }>(`/api/deploy/targets?root=${encodeURIComponent(root!)}`).then((r) => r.targets.map((t) => t.env)),
    staleTime: 15_000,
  });
