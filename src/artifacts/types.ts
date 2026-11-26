export type ArtifactIntent = "document" | "slides" | "design" | "other";
export type ArtifactOwner = "mine" | "shared" | "unknown";
export type ArtifactContentKind = "html" | "markdown" | "files" | "summary";
export type ArtifactError = "not_signed_in" | "no_plan" | "no_access" | "too_old" | "read_failed";
export interface Artifact {
  id: string;
  url: string;
  title: string;
  intent: ArtifactIntent;
  owner: ArtifactOwner;
  typeName: string | null;
  contentKind: ArtifactContentKind | null;
  contentPath: string | null;
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
}
export type AccountState = "ok" | "not_signed_in" | "no_plan" | "too_old" | "unknown";
export const MIN_CLAUDE_VERSION = "2.1.318";
