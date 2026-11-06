/**
 * Static probes for the stacks that render markup from server templates: Twig (Slim and Symfony), Blade (Laravel)
 * and ERB (Rails). The probes in checks.ts read Next.js and plain HTML; these read the template files instead.
 *
 * A template is text with expressions in it (`{{ }}`, `{% %}`, `{!! !!}`, `<% %>`). Only the head and the tags a
 * check names are read, and an expression inside a tag never ends the tag. A template that extends a layout has no
 * head of its own, so the head checks read the layouts: the templates that open an <html> or <head> element.
 */
import type { CheckId } from "./catalog";
import type { CheckResult, Repo } from "./checks";
import type { Stack } from "../stack";

export const TEMPLATE_STACKS = ["php-slim-twig", "symfony", "laravel", "rails"] as const satisfies readonly Stack[];
export type TemplateStack = (typeof TEMPLATE_STACKS)[number];
export const isTemplateStack = (s: Stack): s is TemplateStack => (TEMPLATE_STACKS as readonly string[]).includes(s);

const TEMPLATE_FILE: Record<TemplateStack, RegExp> = {
  "php-slim-twig": /\.twig$/i,
  symfony: /\.twig$/i,
  laravel: /\.blade\.php$/i,
  rails: /\.erb$/i,
};

export interface Template {
  file: string;
  text: string;
  /** Opens an <html> or <head> element: a layout, not a page that extends one. */
  isDocument: boolean;
}

interface TemplateContext {
  repo: Repo;
  templates: Template[];
}
type TemplateProbe = (c: TemplateContext) => CheckResult;

const res = (status: CheckResult["status"], message: string, evidence: string | null = null): CheckResult => ({ status, evidence, message });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function templatesOf(repo: Repo, stack: TemplateStack): Template[] {
  const out: Template[] = [];
  for (const file of repo.files) {
    if (!TEMPLATE_FILE[stack].test(file)) continue;
    const text = repo.text(file);
    if (text) out.push({ file, text, isDocument: /<(html|head)[\s>]/i.test(text) });
  }
  return out;
}

/** One template expression. A `>` inside it (`$a->b`, `{{ a > b }}`) does not end the tag it sits in. */
const EXPR = String.raw`\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{!![\s\S]*?!!\}|\{#[\s\S]*?#\}|<%[\s\S]*?%>`;
const tagRe = (name: string) => new RegExp(String.raw`<${name}\b(?:${EXPR}|\{(?![{%!#])|[^<>{])*>`, "gi");
const tagsOf = (t: Template, name: string): Array<{ text: string; index: number }> => [...t.text.matchAll(tagRe(name))].map((m) => ({ text: m[0], index: m.index! }));
const hasAttr = (tag: string, name: string) => new RegExp(String.raw`\b${name}\s*=`, "i").test(tag);
const attrValue = (tag: string, name: string): string | null => new RegExp(String.raw`\b${name}\s*=\s*(["'])([\s\S]*?)\1`, "i").exec(tag)?.[2]?.trim() ?? null;
const lineAt = (t: Template, index: number) => t.text.slice(0, index).split("\n").length;

const descriptionMeta = (t: Template): boolean =>
  tagsOf(t, "meta").some((m) => attrValue(m.text, "name")?.toLowerCase() === "description" && !!attrValue(m.text, "content")) ||
  // Rails: <%= tag.meta name: "description", content: ... %>
  /\bname:\s*["']description["'][^%]*\bcontent:/i.test(t.text);
const hasViewport = (t: Template) => tagsOf(t, "meta").some((m) => attrValue(m.text, "name")?.toLowerCase() === "viewport");
const hasTitle = (t: Template) => /<title\b[^>]*>\s*\S[\s\S]*?<\/title>/i.test(t.text);

const noTemplates = (): CheckResult => res("unknown", "No Twig, Blade or ERB templates found.");
const noLayout = (what: string): CheckResult => res("unknown", `No layout with a <head> found to read the ${what} from.`);

/**
 * A head key every layout must set. Fails when a layout lacks it and no template sets it anywhere, or only some
 * layouts lack it. Unknown when only page templates set it: the layout may expect each page to fill it.
 */
function headKey(c: TemplateContext, key: "title" | "description"): CheckResult {
  const has = key === "title" ? hasTitle : descriptionMeta;
  const docs = c.templates.filter((t) => t.isDocument);
  if (!docs.length) return c.templates.length ? noLayout(key) : noTemplates();
  const missing = docs.filter((t) => !has(t));
  if (!missing.length) return res("pass", `Every layout (${plural(docs.length, "template")}) sets a ${key}`, docs[0]!.file);
  const first = missing[0]!.file;
  if (!c.templates.some(has)) return res("fail", `No template sets a ${key}: add one to ${first}.`, first);
  if (missing.length === docs.length) return res("unknown", `The ${key} is set only in page templates, not in a layout. Run the checks with a URL to measure what is served.`);
  return res("fail", `${plural(missing.length, "layout")} without a ${key}: ${missing.slice(0, 3).map((t) => t.file).join(", ")}`, first);
}

function layoutTag(c: TemplateContext, what: string, ok: (t: Template) => boolean, rootOnly = false): CheckResult {
  const docs = c.templates.filter((t) => (rootOnly ? /<html[\s>]/i.test(t.text) : t.isDocument));
  if (!docs.length) return c.templates.length ? noLayout(what) : noTemplates();
  const missing = docs.filter((t) => !ok(t));
  return missing.length ? res("fail", `No ${what} in ${missing[0]!.file}`, missing[0]!.file) : res("pass", `${plural(docs.length, "layout")} set ${what}`, docs[0]!.file);
}

function imgAlt(c: TemplateContext): CheckResult {
  let total = 0;
  let first: string | null = null;
  for (const t of c.templates) {
    for (const m of tagsOf(t, "img")) {
      total++;
      if (!hasAttr(m.text, "alt")) first ??= `${t.file}:${lineAt(t, m.index)}`;
    }
    // Rails: <%= image_tag "logo.png", alt: "Acme" %>
    for (const m of t.text.matchAll(/<%=?\s*image_tag\b[\s\S]*?%>/g)) {
      total++;
      if (!/\balt\s*(:|=>)/.test(m[0])) first ??= `${t.file}:${lineAt(t, m.index!)}`;
    }
  }
  if (!total) return res("pass", "No <img> elements in the templates");
  return first ? res("fail", `An image has no alt text (first: ${first})`, first) : res("pass", `All ${plural(total, "image")} in the templates have alt text`);
}

function robots(c: TemplateContext): CheckResult {
  const file = c.repo.files.find((f) => /(^|\/)robots\.txt$/.test(f));
  if (file) return res("pass", "robots.txt exists", file);
  const route = c.repo.files.find((f) => /\.(php|rb|ya?ml)$/i.test(f) && /robots\.txt/.test(c.repo.text(f) ?? ""));
  return route ? res("pass", "A route serves robots.txt", route) : res("fail", "No robots.txt: add public/robots.txt.");
}

function textFound(c: TemplateContext, re: RegExp, found: string, missing: string): CheckResult {
  if (!c.templates.length) return noTemplates();
  for (const t of c.templates) {
    const m = re.exec(t.text);
    if (m) return res("pass", found, `${t.file}:${lineAt(t, m.index)}`);
  }
  return res("fail", missing);
}

const SOCIAL = /href\s*=\s*["']https?:\/\/(www\.)?(facebook|x|twitter|linkedin|instagram|youtube|tiktok|github)\.com/i;
const STRUCTURED = /@type["']?\s*:\s*["'](Organization|Product|SoftwareApplication|WebSite|LocalBusiness)["']/;

/** The checks that have a template probe. A stack in TEMPLATE_STACKS runs these in place of the check's own static probe. */
export const TEMPLATE_PROBES: Partial<Record<CheckId, TemplateProbe>> = {
  "meta-title": (c) => headKey(c, "title"),
  "meta-description": (c) => headKey(c, "description"),
  "html-lang": (c) => layoutTag(c, "lang on <html>", (t) => tagsOf(t, "html").some((h) => hasAttr(h.text, "lang")), true),
  viewport: (c) => layoutTag(c, "a viewport meta", hasViewport),
  "img-alt": imgAlt,
  canonical: (c) => textFound(c, /rel\s*=\s*["']canonical["']/i, "A canonical link is set", "No canonical URL is set on any page."),
  "og-image": (c) => textFound(c, /og:image/i, "Open Graph image is set", "No Open Graph image: add an og:image meta tag to the layout (1200 by 630)."),
  "structured-data": (c) => textFound(c, STRUCTURED, "Structured data is present", "No Organization or Product JSON-LD: add it to the layout."),
  "social-links": (c) => textFound(c, SOCIAL, "A social profile is linked", "No social profile is linked from the templates."),
  robots,
};
