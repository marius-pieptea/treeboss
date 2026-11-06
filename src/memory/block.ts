/**
 * The managed block: the one region of AGENTS.md / CLAUDE.md that trb writes. Everything outside it is
 * the operator's and is never touched; the rules inside it are the whole store.
 *
 *   <!-- trb:memory:start -->
 *   ## Project rules
 *   <!-- ... -->
 *   - We use bun, not npm.
 *   <!-- trb:memory:end -->
 */
import { createHash } from "crypto";
import { UserError } from "../util";

export const START = "<!-- trb:memory:start -->";
export const END = "<!-- trb:memory:end -->";
const LEGACY_START = "<!-- occ:memory:start -->";
const LEGACY_END = "<!-- occ:memory:end -->";
const HEADING = "## Project rules";
const NOTE = "<!-- Managed by trb (Memory view). Edit rules there; text outside this block is yours and is never changed. -->";

export const ruleId = (text: string): string => createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 8);

/** One line, no list marker, no surrounding space. */
export function cleanRule(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim();
}

export interface Span {
  start: number;
  /** One past the end marker. */
  end: number;
}

/** Where the block is, or null. A damaged block (unpaired or repeated markers) is an error: guessing could eat the operator's text. */
export function findBlock(content: string): Span | null {
  // Blocks written before the rename use `occ:` markers; same length, so spans still line up with `content`.
  content = content.split(LEGACY_START).join(START).split(LEGACY_END).join(END);
  const a = content.indexOf(START);
  const b = content.indexOf(END);
  if (a < 0 && b < 0) return null;
  if (a < 0 || b < 0 || b < a || content.indexOf(START, a + 1) >= 0 || content.indexOf(END, b + 1) >= 0) {
    throw new UserError("The trb memory block in this file is damaged (a start or end marker is missing or repeated). Fix or remove it by hand first.");
  }
  return { start: a, end: b + END.length };
}

export function parseRules(content: string): string[] {
  const span = findBlock(content);
  if (!span) return [];
  const inner = content.slice(span.start + START.length, span.end - END.length);
  const out: string[] = [];
  for (const line of inner.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (m) out.push(cleanRule(m[1]!));
  }
  return out;
}

function renderBlock(rules: string[], nl: string): string {
  return [START, HEADING, NOTE, ...rules.map((r) => `- ${r}`), END].join(nl);
}

/** The content with the block set to `rules`: replaced in place, appended when absent, removed when `rules` is empty. Nothing else changes. */
export function spliceRules(content: string, rules: string[]): string {
  const nl = content.includes("\r\n") ? "\r\n" : "\n";
  const span = findBlock(content);
  if (!rules.length) {
    if (!span) return content;
    let before = content.slice(0, span.start);
    let after = content.slice(span.end);
    // Take the blank line we added with it, not more.
    before = before.replace(/(\r?\n){2,}$/, nl);
    after = after.replace(/^\r?\n/, "");
    return before + after;
  }
  const block = renderBlock(rules, nl);
  if (span) return content.slice(0, span.start) + block + content.slice(span.end);
  if (!content.trim()) return block + nl;
  const tail = /(\r?\n){2,}$/.test(content) ? "" : /\r?\n$/.test(content) ? nl : nl + nl;
  return content + tail + block + nl;
}
