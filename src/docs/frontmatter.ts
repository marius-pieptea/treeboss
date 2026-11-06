/**
 * Front matter on a documentation page.
 *
 *   ---
 *   title: Architecture
 *   covers: [src/daemon/**, src/sessions/**]
 *   generated: { commit: 1a2b3c4d…, at: 2026-10-08T10:00:00Z, by: claude/opus }
 *   status: draft | reviewed
 *   ---
 *
 * Reading is done with a real YAML parser (Bun's), but writing never re-serializes the block: a page is
 * a human's file, so keys this module does not know, comments, key order and the body stay exactly as
 * they were. `setKey` edits one top-level key's lines in place and leaves every other byte alone.
 */

export interface Generated {
  commit: string | null;
  at: string | null;
  by: string | null;
}

export interface DocMeta {
  title: string | null;
  covers: string[];
  generated: Generated | null;
  status: "draft" | "reviewed" | null;
}

export interface FrontMatter {
  /** The page starts with a front matter block. */
  present: boolean;
  /** The block exactly as written, delimiters and the newline after the closing one included. "" when absent. */
  raw: string;
  /** The text between the delimiters. */
  inner: string;
  data: Record<string, unknown>;
  body: string;
  /** The YAML did not parse (the page is still readable: data is empty). */
  error: string | null;
}

const OPEN = /^﻿?---[ \t]*\r?\n/;

/** Split a page into its front matter block and its body. `raw + body` is always the original text. */
export function parseFrontMatter(text: string): FrontMatter {
  const open = OPEN.exec(text);
  if (!open) return { present: false, raw: "", inner: "", data: {}, body: text, error: null };
  const after = open[0].length;
  const close = /^(---|\.\.\.)[ \t]*(\r?\n|$)/m;
  const rest = text.slice(after);
  // The closing delimiter has to start a line: search line by line so a `---` inside a value cannot end it early.
  let offset = 0;
  let end = -1;
  let endLen = 0;
  for (const line of rest.split(/(?<=\n)/)) {
    const m = close.exec(line);
    if (m && m.index === 0 && line.trimEnd() === m[1]) {
      end = offset;
      endLen = line.length;
      break;
    }
    offset += line.length;
  }
  if (end < 0) return { present: false, raw: "", inner: "", data: {}, body: text, error: null };
  const inner = rest.slice(0, end);
  const raw = text.slice(0, after + end + endLen);
  const body = text.slice(raw.length);
  let data: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const parsed = inner.trim() ? (Bun as any).YAML.parse(inner) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    else if (parsed !== null && parsed !== undefined) error = "The front matter is not a mapping.";
  } catch (e: any) {
    error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
  }
  return { present: true, raw, inner, data, body, error };
}

export const joinFrontMatter = (fm: FrontMatter): string => fm.raw + fm.body;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/** What the module reads off a page's data. Tolerant: a wrong-typed key is ignored, never an error. */
export function docMeta(data: Record<string, unknown>): DocMeta {
  const covers = Array.isArray(data.covers) ? data.covers.map(str).filter((s): s is string => !!s) : typeof data.covers === "string" ? [data.covers.trim()].filter(Boolean) : [];
  const g = data.generated;
  let generated: Generated | null = null;
  if (g && typeof g === "object" && !Array.isArray(g)) {
    const o = g as Record<string, unknown>;
    generated = { commit: str(o.commit), at: str(o.at), by: str(o.by) };
    if (!generated.commit && !generated.at && !generated.by) generated = null;
  }
  const status = data.status === "draft" || data.status === "reviewed" ? data.status : null;
  return { title: str(data.title), covers, generated, status };
}

/* -------------------------------------------------------------------------- */
/* Writing one key                                                            */
/* -------------------------------------------------------------------------- */

/** A scalar as YAML: plain when it is safe, double-quoted (JSON escapes are valid YAML) when it is not. */
export function yamlScalar(v: string): string {
  if (v === "") return '""';
  if (/^[\w./@+-][\w ./@+()*?-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(v) && !/\s$/.test(v)) return v;
  return JSON.stringify(v);
}

function renderKey(key: string, value: unknown, eol: string): string[] {
  if (Array.isArray(value)) return value.length ? [`${key}:`, ...value.map((x) => `  - ${yamlScalar(String(x))}`)] : [`${key}: []`];
  if (value && typeof value === "object") {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null && v !== undefined) lines.push(`  ${k}: ${yamlScalar(String(v))}`);
    return lines;
  }
  return [`${key}: ${yamlScalar(String(value))}`];
}

/**
 * Set (or add, or with `undefined` remove) one top-level key, rewriting only that key's own lines. When
 * the page has no front matter yet, a block holding just that key is put in front of the body.
 */
export function setKey(text: string, key: string, value: unknown): string {
  const fm = parseFrontMatter(text);
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const eol = /\r\n/.test(fm.present ? fm.raw : text) ? "\r\n" : "\n";
  const fresh = value === undefined ? [] : renderKey(key, value, eol);
  if (!fm.present) {
    if (!fresh.length) return text;
    return `${bom}---${eol}${fresh.join(eol)}${eol}---${eol}${bom ? text.slice(1) : text}`;
  }
  const lines = fm.inner.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const isKeyLine = (l: string) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l);
  const start = lines.findIndex(isKeyLine);
  let next: string[];
  if (start < 0) next = [...lines, ...fresh];
  else {
    // The key owns the following lines that are indented, list items, comments or blank, up to the next top-level key.
    let stop = start + 1;
    while (stop < lines.length && !/^[^\s#-]/.test(lines[stop])) stop++;
    // Trailing blank lines belong to what follows, not to this key.
    while (stop > start + 1 && lines[stop - 1].trim() === "") stop--;
    next = [...lines.slice(0, start), ...fresh, ...lines.slice(stop)];
  }
  // The opening and closing delimiter lines are kept as written.
  const openLine = /^﻿?---[ \t]*\r?\n/.exec(fm.raw)![0];
  const closeLine = fm.raw.slice(openLine.length + fm.inner.length);
  const inner = next.length ? next.join(eol) + eol : "";
  return openLine + inner + closeLine + fm.body;
}

/** Record that a page was written against a commit, by a model (or `manual` when a person says it is current). */
export function setGenerated(text: string, g: { commit: string | null; at?: string; by: string }): string {
  return setKey(text, "generated", { commit: g.commit, at: g.at ?? new Date().toISOString(), by: g.by });
}

/* -------------------------------------------------------------------------- */
/* Keep blocks                                                                */
/* -------------------------------------------------------------------------- */

const KEEP = /<!--\s*keep\s*-->([\s\S]*?)<!--\s*\/keep\s*-->/g;

/** The human-written sections of a page: what sits between `<!-- keep -->` and `<!-- /keep -->`. */
export function keepBlocks(text: string): string[] {
  return [...text.matchAll(KEEP)].map((m) => m[0]);
}

/** Keep blocks of `before` that `after` does not contain verbatim. A refresh must leave this empty. */
export function alteredKeepBlocks(before: string, after: string): string[] {
  const now = keepBlocks(after);
  const used = new Set<number>();
  const lost: string[] = [];
  for (const b of keepBlocks(before)) {
    const i = now.findIndex((n, idx) => !used.has(idx) && n === b);
    if (i < 0) lost.push(b);
    else used.add(i);
  }
  return lost;
}

/** `<!-- keep -->` without its closing marker, or the reverse: a block that would silently swallow text. */
export function unbalancedKeep(text: string): boolean {
  const opens = (text.match(/<!--\s*keep\s*-->/g) ?? []).length;
  const closes = (text.match(/<!--\s*\/keep\s*-->/g) ?? []).length;
  return opens !== closes;
}

/** First heading of the body, the title a page without a `title:` key shows. */
export function firstHeading(body: string): string | null {
  const m = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(body.replace(/```[\s\S]*?```/g, ""));
  return m ? m[1].trim() : null;
}

/** A line or two that say what the page is about: the first prose paragraph. */
export function summaryLine(body: string, max = 200): string {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const para of prose.split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith(">") || /^[-*+]\s/.test(t) || /^\d+\.\s/.test(t)) continue;
    const one = t.replace(/\s+/g, " ").replace(/[*_`]/g, "");
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
  }
  return "";
}
