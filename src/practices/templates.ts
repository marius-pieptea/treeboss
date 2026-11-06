/**
 * Template files: the markup of a server or component template (Twig, Blade, ERB, Jinja, Nunjucks, Liquid, Handlebars,
 * Mustache, Go templates, PHP, Vue, Svelte, Astro). A check reads what a visitor sees, so the template syntax is blanked
 * first. Blanking keeps every newline and every column, so a line number in the masked text is the source's line.
 */

export const TEMPLATE = /\.(twig|blade\.php|erb|jinja2?|j2|njk|liquid|hbs|mustache|tmpl|gohtml|php|vue|svelte|astro)$/i;
const BLADE = /\.blade\.php$/i;
const PHP = /\.php$/i;
const ASTRO = /\.astro$/i;
/** Svelte and Astro write expressions as {…} in the markup. The others use {{ }} and {% %}, which TAGS covers. */
const BRACES = /\.(svelte|astro)$/i;
const ERB = /\.erb$/i;

/** A layout a template page names: its path from the workspace root, and its text. */
export interface Layout {
  rel: string;
  text: string;
}
/** Reads the layout a page names. `ref` is the name as the page writes it; `from` is the page's path. Null when it is not found. */
export type LayoutReader = (ref: string, from: string) => Layout | null;
export const NO_LAYOUT: LayoutReader = () => null;

export const blankKeepLines = (s: string): string => s.replace(/[^\n]/g, " ");
export const stripHtmlComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, blankKeepLines);

/** A <script> or <style> block: code, not markup. One capture group, so split() returns the blocks at odd indexes. */
const CODE_BLOCK = /(<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>)/i;
/** The same, plus the Astro frontmatter fence at the top of the file. */
const ASTRO_CODE = /(^---\r?\n[\s\S]*?\r?\n---|<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>)/i;
/** Template syntax in the markup: {{ }}, {{{ }}}, {!! !!}, {% %} (a Liquid comment block whole), {# #}, <% %>. */
const TAGS = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}|\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|<%[\s\S]*?%>/g;
/** PHP code: <?php … ?>, <?= … ?>, or to the end of the file when it is never closed. */
const PHP_TAG = /<\?(?:[\s\S]*?\?>|[\s\S]*$)/g;
const BLADE_PHP = /@php\b[\s\S]*?@endphp\b/g;
/** A Blade directive with its arguments: @if($x), @section('title'), @endif. An @ inside a word (an email address) is not one. */
const BLADE_DIRECTIVE = /(?<![\w@.])@[A-Za-z]\w*(?:\((?:[^()]|\([^()]*\))*\))?/g;
const BRACE_EXPR = /\{[^{}]*\}/g;

/** The delimited syntax of a template ({{ }}, {% %}, <% %>, <?php ?>), blanked. Code blocks get this too: a {# #} in a style is still a comment. */
function maskDelimited(part: string, file: string): string {
  const out = PHP.test(file) ? part.replace(PHP_TAG, blankKeepLines) : part;
  return out.replace(TAGS, blankKeepLines);
}

/** The markup of a template with its syntax blanked: delimiters, Blade directives, and Svelte or Astro {expressions}. */
function maskMarkup(part: string, file: string): string {
  let out = maskDelimited(part, file);
  if (BLADE.test(file)) out = out.replace(BLADE_PHP, blankKeepLines).replace(BLADE_DIRECTIVE, blankKeepLines);
  if (BRACES.test(file)) out = out.replace(BRACE_EXPR, blankKeepLines);
  return out;
}

/**
 * The template with its syntax blanked. Unless `code` is set, its <script> and <style> blocks (and an Astro frontmatter)
 * are blanked too: they are code, not what a visitor reads. A file that is not a template is returned as it is.
 */
export function maskTemplate(text: string, file: string, opts: { code: boolean }): string {
  if (!TEMPLATE.test(file)) return text;
  const parts = text.split(ASTRO.test(file) ? ASTRO_CODE : CODE_BLOCK);
  return parts.map((part, i) => (i % 2 === 1 ? (opts.code ? maskDelimited(part, file) : blankKeepLines(part)) : maskMarkup(part, file))).join("");
}

/** What a visitor reads of a template: its markup, with the syntax, the code blocks and the HTML comments blanked. */
export const markupOf = (text: string, file: string): string => stripHtmlComments(maskTemplate(text, file, { code: false }));

/** Template output in a head: a head that has it may get its title or description from the template, so it is not judged. */
export const hasTemplateOutput = (head: string): boolean => /\{\{|\{%|\{#|<%|<\?|\{!!|@(?:include|yield|section|stack|props)\b|\bcontent_for\b/.test(head);

/**
 * The layout a template page names, as the page writes it, or null when it names none. Twig and Jinja: `{% extends %}`.
 * Blade: `@extends`. Astro: the imported layout component that the markup uses. ERB has no declared layout: a view that sets
 * `content_for :title` gets the application layout, by Rails convention.
 */
export function layoutRef(text: string, file: string): string | null {
  if (!TEMPLATE.test(file)) return null;
  if (ASTRO.test(file)) {
    for (const m of text.matchAll(/^\s*import\s+(\w+)\s+from\s+["'](\.{1,2}\/[^"']+\.astro)["']/gm)) {
      if (new RegExp(`<${m[1]}[\\s/>]`).test(text)) return m[2] ?? null;
    }
    return null;
  }
  for (const re of [/\{%-?\s*extends\s+["']([^"']+)["']/, /@extends\(\s*["']([^"']+)["']/]) {
    const named = re.exec(text)?.[1];
    if (named) return named;
  }
  if (ERB.test(file) && !/(^|\/)layouts\//.test(file) && !/(^|\/)_[^/]*$/.test(file) && /content_for\s*\(?\s*:title\b/.test(text)) return "layouts/application";
  return null;
}

/** A template that is a whole page: a document, or one that extends a layout. A partial is neither, and is not judged for SEO. */
export function isTemplatePage(text: string, file: string): boolean {
  return /<html[\s>]/i.test(markupOf(text, file)) || layoutRef(text, file) !== null;
}
