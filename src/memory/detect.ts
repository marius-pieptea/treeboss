/**
 * Does a message read as a standing convention ("we use bun, not npm")? Conservative on purpose: it only
 * proposes, the operator decides, and a wrong proposal is noise they have to dismiss. Pure.
 */
const MAX_CHARS = 500;

const PATTERNS: RegExp[] = [
  /^(?:we|i|our (?:team|project|repo|codebase))\s+(?:always\s+|only\s+)?(?:use|prefer|run|write|name|put|keep|deploy|test with)\b.*\b(?:not|instead of|rather than|over)\b/i,
  /^(?:we|i)\s+(?:always|never|only)\s+\S/i,
  /^(?:please\s+)?(?:use|prefer)\s+.+\s+(?:instead of|rather than|over)\s+/i,
  /^(?:please\s+)?(?:always|never)\s+\S/i,
  /^(?:please\s+)?(?:don'?t|do not|stop)\s+(?:ever\s+)?(?:use|using|add|adding|write|writing|create|creating|touch|touching|edit|editing|commit|committing|install|installing|import|importing)\b/i,
  /^(?:from now on|going forward|in this (?:project|repo|codebase)|for this (?:project|repo|codebase))\b[,:]?\s*\S/i,
  /^(?:remember|note|keep in mind)\s*(?:that|to|:)\s*\S/i,
  /^(?:this|the)\s+(?:project|repo|codebase)\s+(?:uses|runs on|is built (?:with|on)|needs)\s+\S/i,
  /^(?:no|nope|actually|wrong)[,.:]?\s+(?:we|it'?s|use|it uses)\b.*\b(?:not|instead|rather)\b/i,
];

/** Leading filler that is not part of the rule. */
const FILLER = /^(?:(?:hey|ok(?:ay)?|no|nope|actually|wrong|also|and|but|so|btw|please|just)[,.:!]?\s+)+/i;

export interface Proposal {
  text: string;
}

export function normalizeRule(sentence: string): string {
  let s = sentence.replace(/\s+/g, " ").trim().replace(FILLER, "").trim();
  s = s.replace(/[.!\s]+$/, "");
  if (!s) return "";
  s = s[0]!.toUpperCase() + s.slice(1);
  return s + ".";
}

export function detectCorrection(message: string): Proposal | null {
  const text = String(message ?? "").trim();
  if (!text || text.length > MAX_CHARS || text.includes("```")) return null;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.endsWith("?") || sentence.length < 8 || sentence.length > 220) continue;
    const bare = sentence.replace(FILLER, "");
    if (PATTERNS.some((re) => re.test(sentence) || re.test(bare))) {
      const rule = normalizeRule(sentence);
      if (rule) return { text: rule };
    }
  }
  return null;
}
