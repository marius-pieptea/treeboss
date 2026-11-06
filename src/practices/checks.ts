/**
 * Mechanical checks for the enabled practice packs. Each is a heuristic over text, not a parser: cheap enough to run
 * after every treeboss turn, and every finding names a line the operator can look at. Code is stripped of comments
 * and string contents first (stripCode), so a `!` in a string is not a non-null assertion. Template files (templates.ts)
 * are read through their markup: the template syntax is blanked, and the checks see what a visitor sees.
 *
 * What is not checked, on purpose: anything that needs a parser or a judgement (is this function's name honest, is
 * this a presentational component). Those are rules in the pack's text, not checks.
 */
import fs from "fs";
import path from "path";
import { owningWorkspace } from "../workspaces";
import { CHECK_IDS, PACK_OF_CHECK, type PracticeCheck } from "./packs";
import { activeChecks, practicesOf, type Enforce, type Thresholds } from "./store";
import { blankKeepLines, hasTemplateOutput, isTemplatePage, layoutRef, type Layout, type LayoutReader, markupOf, maskTemplate, NO_LAYOUT, stripHtmlComments, TEMPLATE } from "./templates";

export interface Finding {
  packId: string;
  check: PracticeCheck;
  file: string;
  line?: number;
  message: string;
}

/** What a pure check reports: a line when it has one, and the message. */
export interface Hit {
  line?: number;
  message: string;
}

/** A file of the project's main stack that no enabled check reads. `check` is null: no check reads these files. */
export interface Skipped {
  check: PracticeCheck | null;
  reason: string;
}

export interface Report {
  findings: Finding[];
  skipped: Skipped[];
}

const MAX_BYTES = 1_000_000;
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|css|scss|html|vue|svelte|py|go|rs|rb|java|kt|swift|cs|php|c|cc|cpp|h|hpp)$/i;
/** Source code and templates: the files a main stack can be made of. */
const isCodeFile = (f: string): boolean => SOURCE.test(f) || TEMPLATE.test(f);

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

const blank = (ch: string | undefined): string => (ch === "\n" ? "\n" : ch === undefined ? "" : " ");

/**
 * The code with comments removed and string contents blanked. Quotes stay, and every newline stays, so a line number in
 * the result is the line number in the source. A ' or " string ends at its line (JS strings cannot span lines), which
 * keeps an apostrophe in JSX text from blanking the rest of the file. Regex literals are not recognised: a quote or `!`
 * inside one can be read as code (a known limit of the heuristic).
 */
export function stripCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out += blank(text[i++]);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += blank(text[i++]);
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") {
          out += blank(text[i]) + blank(text[i + 1]);
          i += 2;
          continue;
        }
        if (c !== "`" && text[i] === "\n") break;
        out += blank(text[i++]);
      }
      if (text[i] === c) out += text[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineCount = (text: string): number => {
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

export function fileTooLong(text: string, max: number): Hit[] {
  const n = lineCount(text);
  return n > max ? [{ message: `file is ${n} lines (max ${max}); split it by responsibility.` }] : [];
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "await", "typeof", "new", "else", "do", "try", "super", "throw", "yield", "case", "delete", "void"]);

/** Columns on one (stripped) line where a function body may open: `function`, `=> {`, or a method head `name(`. */
function fnStarts(s: string): number[] {
  const cols: number[] = [];
  for (const m of s.matchAll(/\bfunction\b/g)) cols.push(m.index ?? 0);
  for (const m of s.matchAll(/=>\s*\{/g)) cols.push(m.index ?? 0);
  const method = /^\s*(?:(?:export|default|async|static|public|private|protected|override|get|set|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(s);
  const name = method?.[1] ?? "";
  if (method && !KEYWORDS.has(name)) cols.push(s.indexOf(name));
  return cols;
}

/** The `{` that opens a body, after its parameter list. A `;` first means there is no body. */
function bodyOpen(lines: string[], line: number, col: number): { line: number; col: number } | null {
  let depth = 0;
  for (let l = line; l < lines.length && l < line + 40; l++) {
    const s = lines[l] ?? "";
    for (let c = l === line ? col : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "{" && depth <= 0) return { line: l, col: c };
      else if (ch === ";" && depth <= 0) return null;
    }
  }
  return null;
}

/** The line where the body opened at (line, col) closes, or null when it never does. */
function bodyEnd(lines: string[], line: number, col: number): number | null {
  let depth = 0;
  for (let l = line; l < lines.length; l++) {
    const s = lines[l] ?? "";
    for (let c = l === line ? col : 0; c < s.length; c++) {
      if (s[c] === "{") depth++;
      else if (s[c] === "}" && --depth === 0) return l;
    }
  }
  return null;
}

/** Functions (declarations, arrows with a block body, methods) longer than `max` lines. Heuristic: braces are counted on stripped code. */
export function functionsTooLong(text: string, max: number): Hit[] {
  const lines = stripCode(text).split("\n");
  const hits: Hit[] = [];
  lines.forEach((s, i) => {
    for (const col of fnStarts(s)) {
      const open = bodyOpen(lines, i, col);
      if (!open) continue;
      const end = bodyEnd(lines, open.line, open.col);
      if (end === null) continue;
      const len = end - i + 1;
      if (len > max) hits.push({ line: i + 1, message: `function is ${len} lines (max ${max}); extract a named helper for each step.` });
      return;
    }
  });
  return hits;
}

const ANY_ESCAPE = [/\bas\s+any\b/, /:\s*any\b/, /\bextends\s+any\b/, /[<,]\s*any\s*[>,]/, /\bany\s*\[\]/];

/** `any` in type positions and non-null assertions (`x!`, `f()!`), one hit per line. Strings and comments are ignored. */
export function noAny(text: string): Hit[] {
  const hits: Hit[] = [];
  stripCode(text)
    .split("\n")
    .forEach((s, i) => {
      if (ANY_ESCAPE.some((re) => re.test(s))) hits.push({ line: i + 1, message: "`any` escape hatch: type it, or use `unknown` and narrow it." });
      else if (/[\w)\]]!(?![=:])/.test(s)) hits.push({ line: i + 1, message: "non-null assertion `!`: narrow it with a check, or handle the missing case." });
    });
  return hits;
}

const DATA_IMPORT = /^\s*import\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const DATA_MODULE = /(^|\/)(api|data)(\.[cm]?[jt]sx?)?$|(^|\/)api\//;

const DATA_BINDING = /\b(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*(?:await\s+)?(?:fetch|useQuery|useMutation|useInfiniteQuery)\s*\(/g;

/**
 * A container owns its data when a name bound from its own fetch or query is passed into a child component
 * (`<Child x={data} />`). A component that only renders the data in plain markup is still presentational.
 */
function passesDataToChild(code: string): boolean {
  for (const m of code.matchAll(DATA_BINDING)) {
    for (const name of (m[1] ?? "").match(/\w+/g) ?? []) {
      if (new RegExp(`<[A-Z][\\w.]*\\b[^>]*\\{[^}]*\\b${name}\\b`).test(code)) return true;
    }
  }
  return false;
}

/** A component that fetches, runs a query, or imports an api or data module: the data belongs to a container. A container that hands its own fetched data to a child is skipped. */
export function dataInPresentational(text: string): Hit[] {
  const hits: Hit[] = [];
  if (passesDataToChild(stripCode(text))) return hits;
  stripCode(text)
    .split("\n")
    .forEach((s, i) => {
      if (/\bfetch\s*\(/.test(s)) hits.push({ line: i + 1, message: "calls fetch; a presentational component takes its data as props." });
      else if (/\buseQuery\s*\(|\buseMutation\s*\(|\buseInfiniteQuery\s*\(/.test(s)) hits.push({ line: i + 1, message: "runs a query; a presentational component takes its data as props." });
    });
  for (const m of text.matchAll(DATA_IMPORT)) {
    if (DATA_MODULE.test(m[1] ?? "")) hits.push({ line: lineOf(text, m.index ?? 0), message: `imports ${m[1]}; pass the data in as props from a container.` });
  }
  return hits;
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9A-Za-z_-])/;
const FUNC_COLOR = /\b(?:rgba?|hsla?)\(\s*[\d.]/;

/**
 * A hex, rgb or hsl literal. Heuristic: a `#id` selector spelled with hex letters (`#bad`) is reported too. A template's
 * syntax is blanked first, so a color in a `{# #}` comment is not one; its <style> blocks are still read.
 */
export function rawColors(text: string, file = ""): Hit[] {
  const hits: Hit[] = [];
  maskTemplate(text, file, { code: true })
    .split("\n")
    .forEach((s, i) => {
      const m = HEX.exec(s) ?? FUNC_COLOR.exec(s);
      if (m) hits.push({ line: i + 1, message: `raw color ${m[0]}: use a token from design/tokens.css (var(--color-…)).` });
    });
  return hits;
}

const IMG = /<img\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^{}]*\})*)>/g;
/** An alt attribute: `alt`, a Vue binding `:alt` or `v-bind:alt`. `data-alt` is not one. */
const ALT = /(^|\s)(?:v-bind)?:?alt\s*=/;

/** A bare template tag in a tag's attributes ({{ $attributes }}), outside any quoted value: it may carry an alt. */
const hasBareSlot = (tag: string): boolean => /\{|<[%?]/.test(tag.replace(/"[^"]*"|'[^']*'/g, "").replace(/=\s*\{[^{}]*\}/g, ""));

/**
 * An <img> with no alt attribute. A spread (`{...props}`) may carry one, so it passes. In a template, a bare tag inside the
 * tag ({{ $attributes }}) may carry one too, so that tag passes; a quoted value with template output (src="{{ url }}") does not.
 */
export function imgWithoutAlt(text: string, file = ""): Hit[] {
  const templated = TEMPLATE.test(file);
  const code = templated ? maskTemplate(text, file, { code: false }) : stripCode(text);
  const hits: Hit[] = [];
  for (const m of code.matchAll(IMG)) {
    const attrs = m[1] ?? "";
    const at = m.index ?? 0;
    if (ALT.test(attrs) || /\{\s*\.\.\./.test(attrs)) continue;
    if (templated && hasBareSlot(text.slice(at, at + m[0].length))) continue;
    hits.push({ line: lineOf(code, at), message: '<img> has no alt attribute: describe the image, or alt="" if it is decorative.' });
  }
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Marketing copy and SEO. These read the copy itself, so strings are kept;   */
/* only comments are blanked (stripJsComments, stripHtmlComments).            */
/* -------------------------------------------------------------------------- */

const PROSE = /\.(tsx|jsx|html?|md|mdx)$/i;
/** Files whose visible text is copy: the prose files, and the templates (their markup). */
const COPY = (f: string): boolean => PROSE.test(f) || TEMPLATE.test(f);
const HTML = /\.html?$/i;
const MARKDOWN = /\.mdx?$/i;
const NEXT_PAGE = /(^|\/)app\/(?:.*\/)?page\.[jt]sx$/i;
const ROUTE_PAGE = /(^|\/)(?:app\/(?:.*\/)?page|pages\/.*)\.[jt]sx$/i;

/** Markdown with fenced code blocks blanked, so a code sample is not read as copy. */
const stripFences = (text: string): string => text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, blankKeepLines);

/**
 * JS or TSX with its comments blanked and its strings kept. A `//` opens a comment only at a line start or after a space,
 * `;`, `{`, `}` or `)`, so the `//` of a URL in copy (`https://`) is not read as one.
 */
export function stripJsComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "/" && text[i + 1] === "/" && (i === 0 || /[\s;{})]/.test(text.charAt(i - 1)))) {
      while (i < text.length && text[i] !== "\n") out += blank(text[i++]);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += blank(text[i++]);
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c !== "`" && text[i] === "\n") break;
        out += text[i++];
      }
      if (text[i] === c) out += text[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Segment {
  line: number;
  text: string;
}

const JSX_TEXT = /(?<=>)[^<>{}]+(?=[<{])/g;
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
/** Attributes whose value is an address, a class or an id, not copy: `href="/robust-plan"` is not a sentence. */
const NOT_COPY_ATTR = /\b(?:href|src|to|className|class|id|key|name|rel|target|type|style|data-[\w-]+)\s*=\s*\{?\s*$/;
const MD_LINK_TARGET = /\]\([^)\n]*\)/g;

/** The copy a reader sees, in pieces with their line: markdown prose, template text between tags, or the text between tags plus the string literals of code. Import lines are not copy. */
function copySegments(text: string, file: string): Segment[] {
  if (MARKDOWN.test(file)) {
    return stripFences(stripHtmlComments(text))
      .replace(MD_LINK_TARGET, "]()")
      .split("\n")
      .map((t, i) => ({ line: i + 1, text: t }));
  }
  if (TEMPLATE.test(file)) {
    // Only the visible text between tags: attribute values and template code are not copy in a template.
    const src = markupOf(text, file);
    return [...src.matchAll(JSX_TEXT)].map((m) => ({ line: lineOf(src, m.index ?? 0), text: m[0] }));
  }
  const src = HTML.test(file) ? stripHtmlComments(text) : stripJsComments(text);
  const lines = src.split("\n");
  const out: Segment[] = [];
  for (const m of src.matchAll(JSX_TEXT)) out.push({ line: lineOf(src, m.index ?? 0), text: m[0] });
  for (const m of src.matchAll(STRING_LITERAL)) {
    const at = m.index ?? 0;
    const line = lineOf(src, at);
    if (/^\s*import\b/.test(lines[line - 1] ?? "") || NOT_COPY_ATTR.test(src.slice(Math.max(0, at - 40), at))) continue;
    out.push({ line, text: m[1] ?? m[2] ?? m[3] ?? "" });
  }
  return out;
}

export const BANNED_WORDS = ["revolutionary", "seamless", "cutting-edge", "unlock", "elevate", "leverage", "robust", "game-changer", "empower", "delve"] as const;
/** A word with its inflections: "elevate" also matches "elevating", "unlock" also matches "unlocked". */
const inflected = (w: string): string => (w.endsWith("e") ? `${w.slice(0, -1)}(?:e|es|ed|ing|ly)` : `${w}(?:s|es|ed|ing|ly)?`);
const BANNED = new RegExp(`\\b(?:${BANNED_WORDS.map(inflected).join("|")})\\b`, "gi");

/** A ban-list word in the copy. Identifiers, comments and template syntax are not copy, so `onUnlock`, `// robust` and `{{ robust }}` pass. */
export function bannedWords(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const seg of copySegments(text, file)) {
    for (const m of seg.text.matchAll(BANNED)) {
      const key = `${seg.line}:${m[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ line: seg.line, message: `"${m[0]}" is hype: say the specific thing the product does (copywriting pack).` });
    }
  }
  return hits;
}

interface Link {
  line: number;
  tag: string;
  label: string;
}

const ELEMENT = /<(button|a|Link|Button)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^{}]*\})*)>([^<]*)<\/\1\s*>/g;
const MD_LINK = /(?<!!)\[([^\]\n]+)\]\(([^)\n]*)\)/g;

/** The text of a plain-text child: `Submit` and `{"Submit"}` are both Submit. A dynamic child stays as written, so it never matches. */
const plainLabel = (raw: string): string => raw.trim().replace(/^\{\s*["'`]/, "").replace(/["'`]\s*\}$/, "").trim();

/** The source a structure check reads: template markup, HTML or JS/TSX with the comments blanked. */
const readable = (text: string, file: string): string => (TEMPLATE.test(file) ? markupOf(text, file) : HTML.test(file) ? stripHtmlComments(text) : stripJsComments(text));

/** Each <a>, <Link>, <button> or <Button> whose child is plain text, and each markdown link: its line, tag and label. */
function links(text: string, file: string): Link[] {
  if (MARKDOWN.test(file)) {
    const src = stripFences(stripHtmlComments(text));
    return [...src.matchAll(MD_LINK)].map((m) => ({ line: lineOf(src, m.index ?? 0), tag: "a", label: (m[1] ?? "").trim() }));
  }
  const src = readable(text, file);
  return [...src.matchAll(ELEMENT)].map((m) => ({ line: lineOf(src, m.index ?? 0), tag: m[1] ?? "", label: plainLabel(m[3] ?? "") }));
}

const GENERIC_CTA = /^(submit|click here|learn more|read more|go)$/i;

/** A button or link whose whole text is a generic call to action. The word is matched exactly, so "Submit the form" passes. */
export function genericCta(text: string, file: string): Hit[] {
  return links(text, file)
    .filter((l) => GENERIC_CTA.test(l.label))
    .map((l) => ({ line: l.line, message: `"${l.label}" does not say what the reader gets: word the CTA with the outcome, e.g. "Start free trial".` }));
}

const VAGUE_LINK = /^(click here|here)$/i;

/** A link (not a button) whose text is "click here" or "here": it tells a reader and a crawler nothing about the target. */
export function seoLinkText(text: string, file: string): Hit[] {
  return links(text, file)
    .filter((l) => (l.tag === "a" || l.tag === "Link") && VAGUE_LINK.test(l.label))
    .map((l) => ({ line: l.line, message: `link text "${l.label}" names nothing: name the target page in the link text.` }));
}

const METADATA_EXPORT = /export\s+(?:const|let|var|async\s+function|function)\s+(?:metadata|generateMetadata)\b|export\s*\{[^}]*\b(?:metadata|generateMetadata)\b/;
const TITLE = /<title[\s>]/i;
const DESCRIPTION = /<meta\b[^>]*\bname\s*=\s*["']description["']/i;
const NO_TITLE = "no <title>: give the page a unique title of 50 to 60 characters, primary keyword first.";
const NO_DESCRIPTION = 'no <meta name="description">: give the page a unique description of 120 to 160 characters.';

/**
 * The title and description a document's head lacks. A head with template output may get them from the template, so
 * a missing one is not reported there.
 */
function headGaps(text: string, file: string): Hit[] {
  const markup = markupOf(text, file);
  const head = /<head\b[\s\S]*?<\/head\s*>/i.exec(text)?.[0] ?? text;
  const dynamic = TEMPLATE.test(file) && hasTemplateOutput(head);
  const hits: Hit[] = [];
  if (!dynamic && !TITLE.test(markup)) hits.push({ message: NO_TITLE });
  if (!dynamic && !DESCRIPTION.test(markup)) hits.push({ message: NO_DESCRIPTION });
  return hits;
}

/**
 * A template page. A document checks its own head. A page that names a layout is covered when its own markup has both,
 * and otherwise by the layout's head; a layout this check cannot read, or that extends another, is not judged.
 */
function templateSeo(text: string, file: string, layout: LayoutReader): Hit[] {
  if (/<html[\s>]/i.test(markupOf(text, file))) return headGaps(text, file);
  const ref = layoutRef(text, file);
  if (ref === null) return [];
  const own = markupOf(text, file);
  if (TITLE.test(own) && DESCRIPTION.test(own)) return [];
  const found: Layout | null = layout(ref, file);
  if (!found || layoutRef(found.text, found.rel) !== null) return [];
  return headGaps(found.text, found.rel).map((h) => ({ message: `${found.rel} is this page's layout; ${h.message}` }));
}

/**
 * A page with no title or meta description. A Next.js page.tsx must export metadata or generateMetadata; an .html page
 * must have a <title> and a meta description. A template page is judged through its markup and its layout (see
 * templateSeo). Anything else is not a page this check reads.
 */
export function seoMeta(text: string, file: string, layout: LayoutReader = NO_LAYOUT): Hit[] {
  if (TEMPLATE.test(file)) return templateSeo(text, file, layout);
  if (HTML.test(file)) return headGaps(text, file);
  if (METADATA_EXPORT.test(stripJsComments(text))) return [];
  return [{ line: 1, message: "page exports no metadata or generateMetadata: export a unique title and description for this page." }];
}

/** More than one <h1> in a page file. A component file is not read: a page has one H1, and a component cannot know which page it is on. */
export function multipleH1(text: string, file: string): Hit[] {
  if (TEMPLATE.test(file) && !isTemplatePage(text, file)) return [];
  const src = readable(text, file);
  const lines = [...src.matchAll(/<h1\b/gi)].map((m) => lineOf(src, m.index ?? 0));
  return lines.slice(1).map((line) => ({ line, message: `second <h1> on this page (${lines.length} in all): keep one H1 per page and make this a <h2>.` }));
}

/* -------------------------------------------------------------------------- */
/* Which files each check reads                                               */
/* -------------------------------------------------------------------------- */

const TS = /\.[cm]?tsx?$/i;
const JS = /\.[cm]?[jt]sx?$/i;
const DTS = /\.d\.[cm]?ts$/i;

/** Which files each check reads. A check that does not list a file type does not read it. Templates are read by the checks that make sense on markup. */
const APPLIES: Record<PracticeCheck, (file: string) => boolean> = {
  "file-length": (f) => isCodeFile(f),
  "function-length": (f) => JS.test(f) && !DTS.test(f),
  "no-any": (f) => TS.test(f) && !DTS.test(f),
  "presentational-data": (f) => /\.(?:[jt]sx|vue|svelte)$/i.test(f) && (/(^|\/)(components|ui)\//.test(f) || /(View|Card|Button)\.(?:[jt]sx|vue|svelte)$/.test(f)) && !/(^|\/)(tests?|__tests__)\//.test(f),
  "raw-color": (f) => (/\.(tsx|jsx|css|scss)$/i.test(f) || TEMPLATE.test(f)) && !/(^|\/)design\/tokens\.css$/.test(f),
  "img-alt": (f) => /\.(tsx|jsx|html)$/i.test(f) || TEMPLATE.test(f),
  "banned-words": (f) => COPY(f),
  "generic-cta": (f) => COPY(f),
  "seo-meta": (f) => NEXT_PAGE.test(f) || HTML.test(f) || TEMPLATE.test(f),
  "multiple-h1": (f) => HTML.test(f) || ROUTE_PAGE.test(f) || TEMPLATE.test(f),
  "seo-link-text": (f) => COPY(f),
};

const RUN: Record<PracticeCheck, (text: string, t: Thresholds, file: string, layout: LayoutReader) => Hit[]> = {
  "file-length": (text, t) => fileTooLong(text, t.maxFileLines),
  "function-length": (text, t) => functionsTooLong(text, t.maxFunctionLines),
  "no-any": (text) => noAny(text),
  "presentational-data": (text) => dataInPresentational(text),
  "raw-color": (text, _t, file) => rawColors(text, file),
  "img-alt": (text, _t, file) => imgWithoutAlt(text, file),
  "banned-words": (text, _t, file) => bannedWords(text, file),
  "generic-cta": (text, _t, file) => genericCta(text, file),
  "seo-meta": (text, _t, file, layout) => seoMeta(text, file, layout),
  "multiple-h1": (text, _t, file) => multipleH1(text, file),
  "seo-link-text": (text, _t, file) => seoLinkText(text, file),
};

/** The checks that belong to the given pack ids, in CHECK_IDS order. Custom packs have none. */
export function checksOf(packIds: string[]): PracticeCheck[] {
  return CHECK_IDS.filter((c) => packIds.includes(PACK_OF_CHECK[c]));
}

/** Every check that reads a file of this name. A file none reads is not checked mechanically. */
export function checksFor(file: string): PracticeCheck[] {
  return CHECK_IDS.filter((c) => APPLIES[c](file));
}

function readText(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const text = fs.readFileSync(abs, "utf-8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** Directories a template engine searches for a layout, relative to the root (the page's own directory is tried first). */
const LAYOUT_BASES = ["templates", "src/templates", "app/templates", "resources/views", "app/views", "views", "src/views"];
const LAYOUT_EXTS = ["", ".html.twig", ".twig", ".blade.php", ".html.erb", ".erb", ".astro", ".html.j2", ".j2", ".jinja", ".jinja2", ".njk", ".html.njk", ".liquid", ".hbs", ".mustache", ".gohtml", ".tmpl", ".html", ".php"];

/**
 * Reads the layouts a template names, from the directories a template engine searches. A relative name (Astro's
 * `../layouts/Layout.astro`) is read from the page's directory only. A layout that is not found, or outside the root, is null.
 */
function layoutReader(root: string): LayoutReader {
  const cache = new Map<string, Layout | null>();
  return (ref, from) => {
    const key = `${from}\0${ref}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const dir = path.posix.dirname(from);
    // Blade names a layout with dots: @extends('layouts.app') is layouts/app.blade.php.
    const name = /\.blade\.php$/i.test(from) && !ref.includes("/") ? ref.replace(/\./g, "/") : ref;
    const bases = ref.startsWith(".") ? [dir] : [dir, ...LAYOUT_BASES];
    let found: Layout | null = null;
    for (const base of bases) {
      for (const ext of LAYOUT_EXTS) {
        const rel = path.posix.normalize(path.posix.join(base, name + ext));
        if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) continue;
        const text = readText(path.join(root, rel));
        if (text !== null) {
          found = { rel, text };
          break;
        }
      }
      if (found) break;
    }
    cache.set(key, found);
    return found;
  };
}

/** The checks over `files` (relative to `root`). Files that are gone, binary or too large are skipped. */
export function runChecks(root: string, files: string[], checks: PracticeCheck[], thresholds: Thresholds): Finding[] {
  const out: Finding[] = [];
  const layout = layoutReader(root);
  for (const file of files) {
    const wanted = checks.filter((c) => APPLIES[c](file));
    if (!wanted.length) continue;
    const text = readText(path.join(root, file));
    if (text === null) continue;
    for (const check of wanted) {
      for (const h of RUN[check](text, thresholds, file, layout)) out.push({ packId: PACK_OF_CHECK[check], check, file, line: h.line, message: h.message });
    }
  }
  return out;
}

/** The stack of a file: its extension, with .blade.php as its own stack. */
const stackOf = (file: string): string => (/\.blade\.php$/i.test(file) ? "blade.php" : (/\.([^./]+)$/.exec(file)?.[1] ?? "").toLowerCase());

/**
 * The files of the project's main stack (the most common source or template extension) that no enabled check reads.
 * Reported as one entry, so the caller can say they are not checked mechanically and rely on the AGENTS.md rules.
 * Nothing is reported when no check is enabled.
 */
export function skippedFiles(files: string[], checks: PracticeCheck[]): Skipped[] {
  if (!checks.length) return [];
  const code = files.filter(isCodeFile);
  const counts = new Map<string, number>();
  for (const f of code) counts.set(stackOf(f), (counts.get(stackOf(f)) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (main === undefined) return [];
  const unread = code.filter((f) => stackOf(f) === main && !checks.some((c) => APPLIES[c](f)));
  const n = unread.length;
  if (!n) return [];
  const shown = unread.slice(0, 3).join(", ");
  return [{ check: null, reason: `${n} .${main} file${n === 1 ? "" : "s"} (${shown}${n > 3 ? ", …" : ""}) ${n === 1 ? "is" : "are"} read by no enabled check: not checked mechanically; rely on the AGENTS.md rules or the checklist agent audit.` }];
}

/** The findings and the skipped files of `checks` over `files`. */
export function checkFiles(root: string, files: string[], checks: PracticeCheck[], thresholds: Thresholds): Report {
  return { findings: runChecks(root, files, checks, thresholds), skipped: skippedFiles(files, checks) };
}

/** What applies to a workspace's files: the enforce mode, the thresholds, and the checks that run (the effective ones). */
export interface Applies {
  enforce: Enforce;
  thresholds: Thresholds;
  checks: PracticeCheck[];
}

/** The workspace's applicable checks, or null when none runs (no check on in its enabled packs). The enforce mode is returned, not applied. */
export function applyingTo(wsId: string): Applies | null {
  const { enforce, thresholds } = practicesOf(wsId);
  const checks = activeChecks(wsId);
  return checks.length ? { enforce, thresholds, checks } : null;
}

/** The same for the workspace a directory belongs to. Null when the directory is in no registered workspace. */
export function practicesApplying(workspaceDir: string): Applies | null {
  const wsId = owningWorkspace(workspaceDir);
  return wsId ? applyingTo(wsId) : null;
}

/** A finding as the agent reads it in a fix turn or a verify report: labelled with its pack. */
export const practiceLine = (f: Finding): string => `[${f.packId}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.message}`;

/**
 * The findings and the skipped files of the workspace's effective checks over `changedFiles` (relative to `root`, the
 * directory they are read from). `workspaceDir` picks the workspace whose packs apply; it defaults to `root`. Returns
 * nothing when no check is on. The enforce mode is not applied here: the caller decides what a finding does.
 * Never throws: a broken practices.json must not fail a turn.
 */
export function practiceReport(root: string, changedFiles: string[], workspaceDir: string = root): Report {
  try {
    const a = practicesApplying(workspaceDir);
    if (!a) return { findings: [], skipped: [] };
    return checkFiles(root, changedFiles, a.checks, a.thresholds);
  } catch (err) {
    console.warn(`[trb] practices: ${err instanceof Error ? err.message : String(err)}`);
    return { findings: [], skipped: [] };
  }
}

/**
 * The enforce mode of the workspace a directory belongs to, and the findings of its checks over `files` (relative to
 * `root`). The caller acts on them: the treeboss gate and the verify step both use this, so they read the setting alike.
 * Never throws: a broken practices.json must not fail a turn.
 */
export function practiceRun(root: string, files: string[], workspaceDir: string = root): { enforce: Enforce; findings: Finding[]; checked: number } {
  try {
    const a = practicesApplying(workspaceDir);
    if (!a) return { enforce: "off", findings: [], checked: 0 };
    if (a.enforce === "off" || !files.length) return { enforce: a.enforce, findings: [], checked: 0 };
    return { enforce: a.enforce, findings: runChecks(root, files, a.checks, a.thresholds), checked: files.length };
  } catch (err) {
    console.warn(`[trb] practices: ${err instanceof Error ? err.message : String(err)}`);
    return { enforce: "off", findings: [], checked: 0 };
  }
}

/** The findings of the workspace's effective checks over `changedFiles`. See practiceReport; the lab's review uses this. */
export function practiceFindings(root: string, changedFiles: string[], workspaceDir: string = root): Finding[] {
  return practiceReport(root, changedFiles, workspaceDir).findings;
}
