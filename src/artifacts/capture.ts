import type { ArtifactIntent } from "./types";

export const ARTIFACT_ID_RE = /^[A-Za-z0-9-]+$/;
const ARTIFACT_SOURCE_RE = /(?:https:\/\/|(?<![A-Za-z0-9.:/-]))claude\.ai\/(code\/)?artifact\/([A-Za-z0-9-]+)/;
const PUBLISHED_AT_RE = /Published\s+.+?\s+at\s+(https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/;

export interface ParsedArtifactUrl {
  id: string;
  code: boolean;
  url: string;
}

/**
 * Extract the artifact id and rebuild a canonical `https://claude.ai/...` URL,
 * ignoring any trailing query/fragment/text and normalizing missing `https://`.
 */
export function parseArtifactUrl(input: string): ParsedArtifactUrl | null {
  if (!input || typeof input !== "string") return null;
  const match = ARTIFACT_SOURCE_RE.exec(input);
  if (!match) return null;
  const code = Boolean(match[1]);
  const id = match[2]!;
  if (!ARTIFACT_ID_RE.test(id)) return null;
  return {
    id,
    code,
    url: `https://claude.ai/${code ? "code/" : ""}artifact/${id}`,
  };
}

/** Extract the published claude.ai artifact URL (canonicalized) from a tool result string. */
export function parsePublished(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const preferred = PUBLISHED_AT_RE.exec(text);
  if (preferred) return parseArtifactUrl(preferred[1]!)?.url ?? null;
  return parseArtifactUrl(text)?.url ?? null;
}

/** Extract the artifact id from a claude.ai artifact URL, or null when it is not one. */
export function artifactIdFromUrl(url: string): string | null {
  return parseArtifactUrl(url)?.id ?? null;
}

const SLIDES_WORD_RE = /(?:^|[^a-z0-9])(slides?|deck)(?:$|[^a-z0-9])/i;
const DESIGN_WORD_RE = /(?:^|[^a-z0-9])(designs?|mockups?|ui)(?:$|[^a-z0-9])/i;
const DOC_WORD_RE = /(?:^|[^a-z0-9])(docs?|document|specs?|notes?|reports?)(?:$|[^a-z0-9])/i;

/** Infer a broad intent category from the source file path and title. */
export function intentFromPath(filePath: string, title: string): ArtifactIntent {
  const fp = (filePath || "").trim().toLowerCase();
  const combined = `${fp} ${(title || "").toLowerCase()}`;
  if (fp.endsWith(".pptx") || SLIDES_WORD_RE.test(combined)) return "slides";
  if (DESIGN_WORD_RE.test(combined)) return "design";
  if ((fp.endsWith(".md") || fp.endsWith(".html")) && DOC_WORD_RE.test(combined)) return "document";
  return "other";
}
