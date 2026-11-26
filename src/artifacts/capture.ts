import type { ArtifactIntent } from "./types";

const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/;
const EXACT_ARTIFACT_URL_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)(?:[/?#]|$)/;

/** Extract the first published claude.ai artifact URL from a tool result string. */
export function parsePublished(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  const match = ARTIFACT_URL_RE.exec(text);
  return match ? match[0] : null;
}

/** Extract the artifact id from a claude.ai artifact URL, or null when it is not one. */
export function artifactIdFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const match = EXACT_ARTIFACT_URL_RE.exec(url.trim());
  return match ? match[1] : null;
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
