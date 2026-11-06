/**
 * The automatic checks of the launch checklists (catalog.ts names them).
 *
 * Each check has a static probe (read the workspace folder: files, package.json, config) and/or an HTTP probe (a
 * running dev server or a deploy URL, crawled with `fetch`). When a URL is given and answers, the HTTP probe wins:
 * it is what is actually served. Otherwise the static probe decides. A check that cannot tell says "unknown" and
 * why; it never guesses a pass.
 *
 * `fetch` is injectable (FetchFn), so tests run against fake responses. HTML is read with light regexes: no DOM,
 * no new dependencies. Evidence is a repo path (`src/app/x.tsx:12`) or a URL.
 */
import fs from "fs";
import path from "path";
import { readStoreMetadata } from "../mobile/store";
import { isTemplateStack, TEMPLATE_PROBES, TEMPLATE_STACKS, templatesOf } from "./templates";
import { fitsPlay, imageSize, IPHONE_SIZES_TEXT, isIphoneSize, PLAY_MIN_SHOTS, type ImageSize } from "./image-size";
import type { CheckId } from "./catalog";
import { detectStack, STACKS, type Stack, type StackDetection } from "../stack";

export type CheckStatus = "pass" | "fail" | "unknown";
export interface CheckResult {
  status: CheckStatus;
  evidence: string | null;
  message: string;
}
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const pass = (message: string, evidence: string | null = null): CheckResult => ({ status: "pass", evidence, message });
const fail = (message: string, evidence: string | null = null): CheckResult => ({ status: "fail", evidence, message });
const unknown = (message: string): CheckResult => ({ status: "unknown", evidence: null, message });
const NEEDS_URL = "Needs a running app or a deploy URL. Run the checks with a URL to measure what is served.";
const NEEDS_ROOT = "Needs the workspace folder to read.";
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* -------------------------------------------------------------------------- */
/* The repo (static probes)                                                   */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".expo", ".turbo", ".vercel", ".cache", ".reference", "dist", "build", "out", "coverage", "Pods"]);
const MAX_FILES = 20_000;
const MAX_READ = 1_000_000;
/** The files whose text a grep reads. */
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|mdx?|json|ya?ml|prisma|sql|toml)$/i;

export interface Repo {
  root: string;
  /** Repo-relative, forward-slash paths. node_modules, .git, build output and .reference are skipped. */
  files: string[];
  text(rel: string): string | null;
  size(rel: string): number;
  /** Dependency names from every package.json in the folder. */
  deps(): Set<string>;
}

export function openRepo(root: string): Repo {
  const files: string[] = [];
  const stack = [""];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile()) files.push(r);
    }
  }
  const cache = new Map<string, string | null>();
  const text = (rel: string): string | null => {
    if (!cache.has(rel)) {
      let v: string | null = null;
      try {
        const abs = path.join(root, rel);
        if (fs.statSync(abs).size <= MAX_READ) v = fs.readFileSync(abs, "utf-8");
      } catch {
        v = null;
      }
      cache.set(rel, v);
    }
    return cache.get(rel) ?? null;
  };
  let depSet: Set<string> | null = null;
  return {
    root,
    files,
    text,
    size(rel) {
      try {
        return fs.statSync(path.join(root, rel)).size;
      } catch {
        return 0;
      }
    },
    deps() {
      if (!depSet) {
        depSet = new Set();
        for (const f of files.filter((x) => x === "package.json" || x.endsWith("/package.json"))) {
          try {
            const j = JSON.parse(text(f) ?? "{}");
            for (const k of ["dependencies", "devDependencies", "peerDependencies"]) for (const n of Object.keys(j[k] ?? {})) depSet.add(n);
          } catch {}
        }
      }
      return depSet;
    },
  };
}

/** The first source file whose text matches, with the 1-based line of the match. */
function grep(repo: Repo, re: RegExp, filter: RegExp = SOURCE): { file: string; line: number } | null {
  for (const f of repo.files) {
    if (!filter.test(f)) continue;
    const t = repo.text(f);
    if (!t) continue;
    const m = re.exec(t);
    if (m) return { file: f, line: t.slice(0, m.index).split("\n").length };
  }
  return null;
}
const hit = (g: { file: string; line: number }) => `${g.file}:${g.line}`;
const depMatch = (repo: Repo, re: RegExp): string | null => [...repo.deps()].find((d) => re.test(d)) ?? null;

const htmlFiles = (repo: Repo) => repo.files.filter((f) => /\.html?$/i.test(f));
const nextPages = (repo: Repo) => repo.files.filter((f) => /(^|\/)(src\/)?app\/(.*\/)?page\.(tsx|jsx|ts|js|mdx)$/.test(f) && !/(^|\/)api\//.test(f));
const isNext = (repo: Repo) => nextPages(repo).length > 0;
/** A route or document named `names` (privacy, terms, status...), as a Next.js page or a plain file. */
const hasPage = (repo: Repo, names: string) =>
  repo.files.find((f) => new RegExp(`(^|/)(${names})(/page\\.(tsx|jsx|ts|js|mdx)|/index\\.(html|astro|vue|svelte)|\\.(html|md|mdx|tsx|jsx|astro|vue|svelte))$`, "i").test(f) && !/(^|\/)api\//.test(f)) ?? null;

const ANALYTICS_SRC = /googletagmanager|gtag\(|gtag\/js|plausible\.io|plausible\(|data-domain=|posthog\.init|umami|fathom|hotjar|mixpanel\.init|\/_vercel\/insights|@vercel\/analytics|static\.cloudflareinsights/i;
const ANALYTICS_DEPS = /^(@vercel\/analytics|@vercel\/speed-insights|posthog-js|react-ga4?|plausible|@plausible|@segment\/analytics-next|@next\/third-parties|mixpanel-browser|hotjar|@fathom|@umami)/;
const CONSENT_DEPS = /cookie|consent|c15t|klaro|onetrust|cookiebot|iubenda|axeptio/i;
const SOCIAL_HREF = /https?:\/\/(www\.)?(facebook|x|twitter|linkedin|instagram|youtube|tiktok|github)\.com/i;
const STRUCTURED_TYPES = new Set(["Organization", "Product", "SoftwareApplication", "WebSite", "LocalBusiness"]);

function analyticsStatic(repo: Repo): string | null {
  const dep = depMatch(repo, ANALYTICS_DEPS);
  if (dep) return `package ${dep}`;
  const g = grep(repo, ANALYTICS_SRC);
  return g ? hit(g) : null;
}

/** The export that sets a metadata key (title or description) in a layout or page. */
const exportsMeta = (t: string, key: string) => /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata|const\s+generateMetadata)/.test(t) && new RegExp(`\\b${key}\\s*:`).test(t);

/** A page sets the key itself, or an ancestor layout does (the page inherits it). */
function inheritsMeta(repo: Repo, page: string, key: string): boolean {
  if (exportsMeta(repo.text(page) ?? "", key)) return true;
  let dir = path.posix.dirname(page);
  for (;;) {
    for (const ext of ["tsx", "jsx", "ts", "js"]) {
      const t = repo.text(path.posix.join(dir, `layout.${ext}`));
      if (t && exportsMeta(t, key)) return true;
    }
    if (dir === "." || path.posix.basename(dir) === "app") break;
    dir = path.posix.dirname(dir);
  }
  return false;
}

const HTML_META_DESC = /<meta\b(?=[^>]*name=["']description["'])(?=[^>]*content=["'][^"']+["'])[^>]*>/i;
const HTML_TITLE = /<title[^>]*>[^<]+<\/title>/i;

function metaStatic(repo: Repo, key: "title" | "description"): CheckResult {
  const pages = nextPages(repo);
  if (pages.length) {
    const missing = pages.filter((p) => !inheritsMeta(repo, p, key));
    if (!missing.length) return pass(`All ${plural(pages.length, "page")} set ${key} metadata (directly or in a layout)`, pages[0]!);
    return fail(`${plural(missing.length, "page")} without ${key} metadata: ${missing.slice(0, 3).join(", ")}`, missing[0]!);
  }
  const html = htmlFiles(repo);
  if (!html.length) return unknown("No pages found: no app/**/page.tsx and no .html files.");
  const ok = key === "title" ? HTML_TITLE : HTML_META_DESC;
  const missing = html.filter((f) => !ok.test(repo.text(f) ?? ""));
  if (!missing.length) return pass(`All ${plural(html.length, "HTML page")} have a ${key}`, html[0]!);
  return fail(`${plural(missing.length, "HTML page")} without a ${key}: ${missing.slice(0, 3).join(", ")}`, missing[0]!);
}

/* -------------------------------------------------------------------------- */
/* Expo config (mobile checks)                                                */
/* -------------------------------------------------------------------------- */

interface ExpoConfig {
  file: string;
  /** Parsed app.json (its `expo` object when there is one). Null for a dynamic app.config.*, where only text is read. */
  json: any | null;
  text: string;
}

function expoConfig(repo: Repo): ExpoConfig | null {
  const j = repo.files.find((f) => f === "app.json");
  if (j) {
    const raw = repo.text(j) ?? "";
    try {
      const parsed = JSON.parse(raw);
      return { file: j, json: parsed.expo ?? parsed, text: raw };
    } catch {
      return { file: j, json: null, text: raw };
    }
  }
  const dyn = repo.files.find((f) => /^app\.config\.(ts|js|mjs|cjs)$/.test(f));
  return dyn ? { file: dyn, json: null, text: repo.text(dyn) ?? "" } : null;
}

/** A value from app.json, or for a dynamic config, whether the key is named in the source. */
function cfgValue(cfg: ExpoConfig, keys: string[]): unknown {
  if (cfg.json) return keys.reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), cfg.json);
  return undefined;
}
const cfgNamed = (cfg: ExpoConfig, key: string) => new RegExp(`\\b${key}\\s*:\\s*["'\`\\w]`).test(cfg.text);
const nonEmpty = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v !== undefined && v !== null);
/** An asset path from app config, as a repo-relative path ("./assets/x.png" becomes "assets/x.png"). */
const assetPath = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/^\.\//, "") : null);

/* -------------------------------------------------------------------------- */
/* The site (HTTP probes)                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_PAGES = 30;
/** Sitemap URLs whose status is fetched. A longer sitemap is reported as truncated. */
export const MAX_SITEMAP_URLS = 200;
const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|css|js|map|xml|txt|json|woff2?|ttf|mp4|webm|mp3)$/i;
const PROBE_PATHS = ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/apple-touch-icon.png", "/privacy", "/privacy-policy", "/terms", "/terms-of-service", "/contact", "/status", "/pricing", "/health", "/healthz", "/api/health", "/api/healthz"];
const HEALTH_PATHS = ["/health", "/healthz", "/api/health", "/api/healthz"];
const ANALYTICS_HTML = /googletagmanager|gtag\(|gtag\/js|plausible|posthog|umami|fathom|hotjar|mixpanel|\/_vercel\/insights|@vercel\/analytics|static\.cloudflareinsights/i;

/** A link, button or submit input on a page. `at` is its offset in the HTML, so it can be ordered against headings. */
export interface PageAction {
  label: string;
  kind: "link" | "button";
  href: string | null;
  at: number;
}

export interface PageAudit {
  url: string;
  status: number;
  type: string;
  bytes: number;
  isHtml: boolean;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  canonical: string | null;
  h1Count: number;
  imgCount: number;
  imgNoAlt: number;
  /** Images with no width or height attribute: they move the page when they load. */
  imgNoDims: number;
  imgSrcs: string[];
  viewport: boolean;
  lang: string | null;
  /** Scripts in <head> that block rendering: a src with no async, defer or type=module. */
  renderBlocking: number;
  jsonLdTypes: string[];
  /** JSON-LD blocks on the page, and how many of them do not parse or carry no @type. */
  jsonLdBlocks: number;
  jsonLdBroken: number;
  analytics: boolean;
  consent: boolean;
  /** Internal links to crawl (same origin, not assets), normalized. */
  links: string[];
  externalLinks: string[];
  /** Internal links whose text is generic: "click here", "here", "read more". */
  genericAnchors: string[];
  actions: PageAction[];
  /** Heading levels in document order (1 for h1 to 6 for h6). */
  headings: number[];
  h1Text: string | null;
  /** Offset of the first h2, or null. */
  h2At: number | null;
  /** Offset of the first FAQ heading, FAQPage data or <details>, or null. */
  faqAt: number | null;
  /** Field count of each form. Hidden, submit, reset and image fields are not counted. */
  formFields: number[];
  /** A testimonial, logo, review or rating is in the markup or the words. */
  socialProof: boolean;
  twitterCard: string | null;
  /** A meta robots, googlebot or X-Robots-Tag says noindex. */
  noindex: boolean;
  hreflangs: Array<{ lang: string; href: string }>;
  /** The visible text: what a reader sees. Block elements end a sentence. */
  text: string;
  /** An empty app root (div id root, app or __next): the page is drawn by JavaScript. */
  clientShell: boolean;
}

export interface Probe {
  status: number;
  type: string;
  body: string;
}

export interface SiteAudit {
  base: string;
  pages: PageAudit[];
  /** True when links were found beyond the page cap. They were not fetched. */
  truncated: boolean;
  /** Answers for PROBE_PATHS (robots, sitemap, icons, legal and status pages, health). Status 0 when unreachable. */
  probes: Record<string, Probe>;
  notFound: { url: string; status: number; type: string; bytes: number; title: string | null };
  /** The plain-HTTP answer for the host, when the base is https. Null for an http base. */
  httpRedirect: { status: number; location: string | null } | null;
  httpError: string | null;
  images: Array<{ url: string; status: number; type: string; bytes: number }>;
  /** What /sitemap.xml lists, with the status of each URL. Null when no sitemap is served. A sitemap index is not read past its children's names. */
  sitemap: { index: boolean; truncated: boolean; urls: Array<{ url: string; status: number }> } | null;
}

const normalize = (u: URL | string): string => {
  const x = new URL(u.toString());
  x.hash = "";
  x.search = "";
  if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
  return x.toString();
};

const attrOf = (tag: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
const clean = (s: string | null | undefined): string | null => {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v || null;
};

function collectJsonLdTypes(v: unknown, out: string[]): void {
  if (Array.isArray(v)) return v.forEach((x) => collectJsonLdTypes(x, out));
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  const t = o["@type"];
  if (typeof t === "string") out.push(t);
  else if (Array.isArray(t)) out.push(...t.filter((x): x is string => typeof x === "string"));
  if (o["@graph"]) collectJsonLdTypes(o["@graph"], out);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, e: string) => ENTITIES[e] ?? m);

/**
 * The text a reader sees: no scripts, styles or head. Block elements end a sentence, so a nav of short links does not
 * read as one long sentence, and the reading-level check is not flattered by it.
 */
export function visibleText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/?(p|li|h[1-6]|div|section|article|header|footer|nav|main|blockquote|dt|dd|tr|td|th|figcaption|button|label|form|ul|ol|table|br|hr)\b[^>]*>/gi, ". ");
  return stripTags(body)
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/(\.\s*){2,}/g, ". ")
    .replace(/^[\s.]+/, "")
    .trim()
    .slice(0, 40_000);
}

/** A rough syllable count: one per vowel group, less a silent e. Good enough for a reading-ease estimate. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return w ? 1 : 0;
  const core = w.replace(/^y/, "").replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, "");
  return Math.max(1, core.match(/[aeiouy]{1,2}/g)?.length ?? 0);
}

/** Words per sentence and the Flesch reading ease (206.835 - 1.015 words/sentence - 84.6 syllables/word) of a text. */
export function readability(text: string): { words: number; sentences: number; avgSentence: number; flesch: number } {
  const perSentence = text
    .split(/[.!?]+/)
    .map((s) => s.split(/\s+/).filter((w) => /[a-z]/i.test(w)))
    .filter((ws) => ws.length);
  const words = perSentence.flat();
  if (!words.length) return { words: 0, sentences: 0, avgSentence: 0, flesch: 0 };
  const sy = words.reduce((n, w) => n + syllables(w), 0);
  const avgSentence = words.length / perSentence.length;
  return { words: words.length, sentences: perSentence.length, avgSentence, flesch: 206.835 - 1.015 * avgSentence - 84.6 * (sy / words.length) };
}

const GENERIC_ANCHOR = /^(click here|here|read more)$/i;
/** The labels that start with an action verb. A link or button with one of these is a call to action. */
export const CTA_VERB = /^(get|start|try|sign up|signup|join|book|request|buy|subscribe|download|contact|talk|schedule|create|order|claim|apply|reserve|see (a )?demo|add to cart)\b/i;
/** Button labels that say nothing about the outcome. */
export const GENERIC_CTA = /^(submit|send|go|continue|next|ok|enter|more|learn more|click here|here|read more|button|submit form)$/i;
const SOCIAL_PROOF =
  /<blockquote\b|itemtype\s*=\s*["'][^"']*\/Review|"@type"\s*:\s*"(Review|AggregateRating)"|aggregateRating|class\s*=\s*["'][^"']*\b(testimonials?|reviews?|logos?|logo-?(cloud|wall|bar|strip|grid))\b|\btestimonials?\b|\btrusted by\b|\bloved by\b|\bcustomers? (say|love|stor)|\b\d(\.\d)?\s*\/\s*5\b|\brated \d|★/i;

/** Reads one response. Pure: the tests feed it HTML strings. `xRobots` is the X-Robots-Tag header, when the server sent one. */
export function parsePage(url: string, status: number, type: string, body: string, xRobots: string | null = null): PageAudit {
  const isHtml = status >= 200 && status < 300 && (/html/i.test(type) || /<!doctype html|<html[\s>]/i.test(body));
  const page: PageAudit = {
    url,
    status,
    type,
    bytes: Buffer.byteLength(body, "utf8"),
    isHtml,
    title: null,
    description: null,
    ogImage: null,
    canonical: null,
    h1Count: 0,
    imgCount: 0,
    imgNoAlt: 0,
    imgNoDims: 0,
    imgSrcs: [],
    viewport: false,
    lang: null,
    renderBlocking: 0,
    jsonLdTypes: [],
    jsonLdBlocks: 0,
    jsonLdBroken: 0,
    analytics: false,
    consent: false,
    links: [],
    externalLinks: [],
    genericAnchors: [],
    actions: [],
    headings: [],
    h1Text: null,
    h2At: null,
    faqAt: null,
    formFields: [],
    socialProof: false,
    twitterCard: null,
    noindex: false,
    hreflangs: [],
    text: "",
    clientShell: false,
  };
  if (!isHtml) return page;
  const html = body;
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const metaContent = (name: string): string | null => {
    for (const t of metaTags) if (new RegExp(`\\b(name|property)=["']${name}["']`, "i").test(t)) {
      const c = clean(attrOf(t, "content"));
      if (c) return c;
    }
    return null;
  };
  page.title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  page.description = metaContent("description");
  page.ogImage = metaContent("og:image");
  page.canonical = (html.match(/<link\b[^>]*>/gi) ?? []).map((t) => (/\brel\s*=\s*["']canonical["']/i.test(t) ? clean(attrOf(t, "href")) : null)).find((x) => x) ?? null;
  page.h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  page.h1Text = clean(stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  page.headings = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  const h2 = html.search(/<h2\b/i);
  page.h2At = h2 < 0 ? null : h2;
  page.twitterCard = metaContent("twitter:card");
  page.noindex = [metaContent("robots"), metaContent("googlebot"), xRobots].some((v) => /noindex/i.test(v ?? ""));
  page.viewport = metaTags.some((t) => /\bname\s*=\s*["']viewport["']/i.test(t));
  page.lang = clean(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]);
  const headStart = Math.max(0, html.search(/<head[\s>]/i));
  const headEnd = html.search(/<\/head>/i);
  const head = html.slice(headStart, headEnd < 0 ? undefined : headEnd);
  page.renderBlocking = (head.match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) ?? []).filter((t) => !/\b(async|defer)\b|type\s*=\s*["']module["']/i.test(t)).length;
  for (const b of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    page.jsonLdBlocks++;
    const before = page.jsonLdTypes.length;
    try {
      collectJsonLdTypes(JSON.parse(b[1] ?? ""), page.jsonLdTypes);
    } catch {
      page.jsonLdBroken++;
      continue;
    }
    if (page.jsonLdTypes.length === before) page.jsonLdBroken++;
  }
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  page.imgCount = imgTags.length;
  page.imgNoAlt = imgTags.filter((t) => !/\balt\s*=/i.test(t)).length;
  page.imgNoDims = imgTags.filter((t) => !(/\swidth\s*=/i.test(t) && /\sheight\s*=/i.test(t))).length;
  page.analytics = ANALYTICS_HTML.test(html);
  page.consent = /cookie|consent/i.test(html);
  for (const t of html.match(/<link\b[^>]*>/gi) ?? []) {
    const lang = attrOf(t, "hreflang");
    const href = attrOf(t, "href");
    if (/\brel\s*=\s*["']alternate["']/i.test(t) && lang && href) page.hreflangs.push({ lang: lang.trim(), href: href.trim() });
  }
  const origin = new URL(url).origin;
  const sameSite = (href: string) => {
    try {
      return new URL(href, url).origin === origin;
    } catch {
      return false;
    }
  };
  for (const t of imgTags) {
    const src = attrOf(t, "src");
    if (src) {
      try {
        page.imgSrcs.push(new URL(src, url).toString());
      } catch {}
    }
  }
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!, url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.origin === origin) {
      if (!ASSET.test(u.pathname)) page.links.push(normalize(u));
    } else page.externalLinks.push(u.toString());
  }
  page.links = [...new Set(page.links)];
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const isLink = m[1]!.toLowerCase() === "a";
    const label = clean(stripTags(m[3] ?? "")) ?? clean(attrOf(m[2] ?? "", "aria-label")) ?? "";
    const href = isLink ? clean(attrOf(m[2] ?? "", "href")) : null;
    page.actions.push({ label, kind: isLink ? "link" : "button", href, at: m.index! });
    if (isLink && href && GENERIC_ANCHOR.test(label) && sameSite(href)) page.genericAnchors.push(label);
  }
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (/\btype\s*=\s*["']?(submit|button)\b/i.test(m[0])) page.actions.push({ label: clean(attrOf(m[0], "value")) ?? "", kind: "button", href: null, at: m.index! });
  }
  page.formFields = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].map(
    (m) => (m[1]!.match(/<(input|select|textarea)\b[^>]*>/gi) ?? []).filter((t) => !/\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(t)).length,
  );
  const faq = html.search(/<h[1-6]\b[\s\S]{0,200}?\b(faq|frequently asked)|"@type"\s*:\s*"FAQPage"|<details\b/i);
  page.faqAt = faq < 0 ? null : faq;
  page.socialProof = SOCIAL_PROOF.test(html);
  page.text = visibleText(html);
  page.clientShell = /<div\b[^>]*\bid\s*=\s*["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
  return page;
}

interface Got {
  status: number;
  type: string;
  text: string;
  location: string | null;
  xRobots: string | null;
  error: string | null;
}

async function getText(f: FetchFn, url: string, init: RequestInit = {}): Promise<Got> {
  try {
    const res = await f(url, { headers: { accept: "text/html,application/xml,text/plain,*/*" }, signal: AbortSignal.timeout(8000), ...init });
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type") ?? "", text: text.slice(0, 2_000_000), location: res.headers.get("location"), xRobots: res.headers.get("x-robots-tag"), error: null };
  } catch (e) {
    return { status: 0, type: "", text: "", location: null, xRobots: null, error: errorText(e) };
  }
}

/** The status of one URL, without keeping its body. 0 when it cannot be reached. */
async function statusOf(f: FetchFn, url: string): Promise<number> {
  try {
    const res = await f(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

/** The same-origin URLs of a sitemap, each with its status. The crawled pages answer from the crawl, the rest are fetched. */
async function readSitemap(r: Got, pages: PageAudit[], f: FetchFn, origin: string): Promise<SiteAudit["sitemap"]> {
  if (r.status < 200 || r.status >= 300 || !/<urlset|<sitemapindex/i.test(r.text)) return null;
  const all = [...new Set([...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].flatMap((m) => (sameOrigin(m[1]!, origin) ? [normalize(m[1]!)] : [])))];
  const crawled = new Map(pages.map((p) => [p.url, p.status]));
  const urls = await Promise.all(all.slice(0, MAX_SITEMAP_URLS).map(async (url) => ({ url, status: crawled.get(url) ?? (await statusOf(f, url)) })));
  return { index: /<sitemapindex/i.test(r.text), truncated: all.length > MAX_SITEMAP_URLS, urls };
}

const sameOrigin = (u: string, origin: string): boolean => {
  try {
    return new URL(u).origin === origin;
  } catch {
    return false;
  }
};

async function crawl(base: URL, f: FetchFn, max: number): Promise<{ pages: PageAudit[]; truncated: boolean }> {
  const origin = base.origin;
  const queue = [normalize(base)];
  const seen = new Set(queue);
  const pages: PageAudit[] = [];
  while (queue.length && pages.length < max) {
    const url = queue.shift()!;
    const r = await getText(f, url);
    const page = parsePage(url, r.status, r.type, r.text, r.xRobots);
    pages.push(page);
    for (const l of page.links) {
      if (!seen.has(l) && l.startsWith(origin)) {
        seen.add(l);
        queue.push(l);
      }
    }
  }
  return { pages, truncated: queue.length > 0 };
}

/** Crawls the site from `baseUrl` (up to `maxPages` pages) and probes the paths the checks read. Never throws for a bad answer. */
export async function auditSite(baseUrl: string, f: FetchFn, maxPages = MAX_PAGES): Promise<SiteAudit> {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const missingUrl = `${origin}/__trb_missing_${Math.random().toString(36).slice(2, 10)}`;
  const [{ pages, truncated }, probeAnswers, nf] = await Promise.all([
    crawl(base, f, maxPages),
    Promise.all(PROBE_PATHS.map((p) => getText(f, origin + p))),
    getText(f, missingUrl),
  ]);
  const probes: Record<string, Probe> = {};
  PROBE_PATHS.forEach((p, i) => {
    const r = probeAnswers[i]!;
    probes[p] = { status: r.status, type: r.type, body: r.text.slice(0, 2000) };
  });
  const sitemap = await readSitemap(probeAnswers[PROBE_PATHS.indexOf("/sitemap.xml")]!, pages, f, origin);
  const home = pages.find((p) => p.isHtml);
  const imageUrls = (home?.imgSrcs ?? []).filter((u, i, a) => a.indexOf(u) === i).slice(0, 20);
  const images = await Promise.all(
    imageUrls.map(async (url) => {
      try {
        const res = await f(url, { signal: AbortSignal.timeout(8000) });
        const bytes = (await res.arrayBuffer()).byteLength;
        return { url, status: res.status, type: res.headers.get("content-type") ?? "", bytes };
      } catch {
        return { url, status: 0, type: "", bytes: 0 };
      }
    }),
  );
  let httpRedirect: SiteAudit["httpRedirect"] = null;
  let httpError: string | null = null;
  if (base.protocol === "https:") {
    try {
      const res = await f(`http://${base.host}/`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      httpRedirect = { status: res.status, location: res.headers.get("location") };
    } catch (e) {
      httpError = errorText(e);
    }
  }
  return {
    base: normalize(base),
    pages,
    truncated,
    probes,
    notFound: { url: missingUrl, status: nf.status, type: nf.type, bytes: Buffer.byteLength(nf.text, "utf8"), title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(nf.text)?.[1]) },
    httpRedirect,
    httpError,
    images,
    sitemap,
  };
}

const htmlPages = (s: SiteAudit) => s.pages.filter((p) => p.isHtml);
/** A path on the audited site, as an absolute URL. */
const at = (s: SiteAudit, p: string) => new URL(p, s.base).toString();
const okProbe = (s: SiteAudit, p: string) => {
  const r = s.probes[p];
  return r !== undefined && r.status >= 200 && r.status < 300;
};

/** Every HTML page that answered must pass `test` (it returns the problem, or null). */
function forPages(s: SiteAudit, label: string, test: (p: PageAudit) => string | null, pages = htmlPages(s)): CheckResult {
  if (!pages.length) {
    const first = s.pages[0];
    return fail(`No HTML page answered at ${s.base}${first ? ` (status ${first.status})` : ""}.`);
  }
  const bad = pages.map((p) => ({ p, why: test(p) })).filter((x): x is { p: PageAudit; why: string } => x.why !== null);
  if (!bad.length) return pass(`${label} (${plural(pages.length, "page")})`, pages[0]!.url);
  const list = bad.slice(0, 3).map((x) => `${new URL(x.p.url).pathname} (${x.why})`).join("; ");
  return fail(`${plural(bad.length, "page")} of ${pages.length}: ${list}`, bad[0]!.p.url);
}

const isDefaultNotFound = (s: SiteAudit) => s.notFound.bytes < 400 || /^(404|not found|cannot get)/i.test(s.notFound.title ?? "");

/* The SEO, conversion and copy helpers. The words are judged on the visible text (PageAudit.text). */

/** The least visible text a page must carry in its server HTML to be indexed as more than a shell. */
const MIN_TEXT = 300;
const HYPE = /\b(revolutionary|seamless\w*|cutting-edge|unlock\w*|elevat\w*|leverag\w*|robust|game-changers?|empower\w*|delv\w*|world-class|next-generation)\b/gi;
const PLACEHOLDER = /lorem ipsum|\bTODO\b|your company|example\.com/i;
/** A headline with a number, an outcome verb, or the reader. */
const HEADLINE = /\d|\byou(r|rs)?\b|\b(get|grow|save|cut|reduce|increase|boost|double|triple|win|ship|build|launch|earn|close|book|automate|speed|stop|fix|keep|sell|hire|learn|recover|improve|scale|manage|track|make)(s|ed|ing)?\b/i;
const RISK = /free trial|no credit card|cancel (any ?time|at any time)|money[- ]back|guarantee|risk[- ]free/i;
/** Paths that are not sales pages: judged only if they are the home page. */
const NOT_LANDING = /\/(privacy|privacy-policy|terms|terms-of-service|legal|cookies?|status|contact|imprint|blog|docs?|changelog)(\/|$)/i;
const ROBOTS_ROOT = /disallow["']?\s*:\s*\[?\s*(["']\/["']|\/\s*$)/im;
const ROBOTS_SITEMAP = /sitemap["']?\s*:/i;

const isCta = (a: PageAction) => CTA_VERB.test(a.label);
const pathOf = (u: string) => new URL(u).pathname;
const safeNorm = (u: string) => {
  try {
    return normalize(u);
  } catch {
    return u;
  }
};
const rangeProblem = (what: string, n: number, lo: number, hi: number) => (n < lo || n > hi ? `${what} is ${n} characters (${lo} to ${hi})` : null);
const countOf = (t: string, re: RegExp) => (t.match(re) ?? []).length;

/** The pages a sales check judges: the home page, and any other page that carries a call to action and is not a legal or support page. */
const landingOf = (s: SiteAudit): PageAudit[] => htmlPages(s).filter((p) => p.url === s.base || (!NOT_LANDING.test(pathOf(p.url)) && p.actions.some(isCta)));

/** One line per value that more than one page carries, naming the pages. */
function duplicates(pages: PageAudit[], label: string, pick: (p: PageAudit) => string | null): string[] {
  const by = new Map<string, PageAudit[]>();
  for (const p of pages) {
    const v = pick(p)?.toLowerCase();
    if (v) by.set(v, [...(by.get(v) ?? []), p]);
  }
  return [...by.values()].filter((ps) => ps.length > 1).map((ps) => `${label} shared by ${ps.map((p) => pathOf(p.url)).join(", ")}`);
}

/** The first heading that jumps more than one level down, or null. The page starts at level 0. */
function skippedHeading(levels: number[]): string | null {
  let prev = 0;
  for (const l of levels) {
    if (l - prev > 1) return `<h${l}> follows ${prev ? `<h${prev}>` : "the start of the page"}`;
    prev = l;
  }
  return null;
}

function robotsProblems(text: string): string[] {
  const out: string[] = [];
  if (ROBOTS_ROOT.test(text)) out.push("blocks the site root (Disallow: /)");
  if (!ROBOTS_SITEMAP.test(text)) out.push("does not name a sitemap");
  return out;
}

/** A call to action with a risk reducer within 250 characters of it. The label itself is not counted (it may say "free trial"). */
function nearCta(p: PageAudit): boolean {
  const low = p.text.toLowerCase();
  for (const label of p.actions.filter(isCta).map((a) => a.label)) {
    const needle = label.toLowerCase();
    for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, i + 1)) {
      const around = p.text.slice(Math.max(0, i - 250), i) + " " + p.text.slice(i + needle.length, i + needle.length + 250);
      if (RISK.test(around)) return true;
    }
  }
  return false;
}

/** The literal title or description of a page, read from the source: an HTML <title>, or a Next.js metadata export. Unknown when none is written as text. */
function literalMeta(r: Repo, key: "title" | "description", lo: number, hi: number): CheckResult {
  const found: Array<{ file: string; value: string }> = [];
  for (const f of r.files) {
    const t = r.text(f);
    if (!t) continue;
    if (key === "title" && /\.html?$/i.test(f)) {
      const m = /<title[^>]*>([^<]+)<\/title>/i.exec(t);
      if (m) found.push({ file: f, value: clean(m[1])! });
    } else if (/(^|\/)(layout|page)\.(tsx|jsx|ts|js|mdx)$/.test(f)) {
      const at = t.search(/export\s+const\s+metadata\b/);
      const block = at < 0 ? "" : t.slice(at, at + 1200);
      const m = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`\\n]+)["'\`]`).exec(block);
      if (m) found.push({ file: f, value: m[1]!.trim() });
    }
  }
  if (!found.length) return unknown(`The ${key} is not written as text in the source. Run the checks with a URL to measure what is served.`);
  const bad = found.filter((x) => x.value.length < lo || x.value.length > hi);
  if (!bad.length) return pass(`Every ${key} written in the source is ${lo} to ${hi} characters (${plural(found.length, "value")})`, found[0]!.file);
  return fail(`${plural(bad.length, key)} outside ${lo} to ${hi} characters: ${bad.slice(0, 3).map((x) => `${x.file} (${x.value.length})`).join(", ")}`, bad[0]!.file);
}

/* -------------------------------------------------------------------------- */
/* The probes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A probe may read the repo (static) and/or the served site (http). A static probe must name the stacks it understands:
 * the type makes a missing `stacks` a compile error. On any other stack it is not run (see makeChecker).
 */
type Probes = { http?: (s: SiteAudit) => CheckResult } & ({ static: (r: Repo) => CheckResult; stacks: readonly Stack[] } | { static?: undefined; stacks?: undefined });

/* Which stacks a static probe understands. Each set is written so that a stack outside it cannot get a false pass or fail. */
/** Any stack, unknown included: the probe reads text that means the same in every language. */
const ALL: readonly Stack[] = STACKS;
/** Pages rendered from HTML or JSX files whose head and body the probe can read: Next.js, plain HTML, and a Vite SPA shell. */
const PAGES: readonly Stack[] = ["nextjs", "plain-static-html", "vite-spa"];
/** JS and TS projects whose dependencies the probe reads from package.json. */
const APP: readonly Stack[] = ["nextjs", "nuxt", "astro", "sveltekit", "remix", "vite-spa", "expo", "node"];
/** Pages as above, plus the scripts a JS app or a static page loads (analytics, consent). */
const WEB: readonly Stack[] = [...APP, "plain-static-html"];
/** Expo and React Native apps: their app.json or app.config and store files. */
const MOBILE: readonly Stack[] = ["expo"];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk_live_[0-9a-zA-Z]{16,}/, "Stripe live key"],
  [/sk_test_[0-9a-zA-Z]{16,}/, "Stripe test key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub token"],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, "Slack token"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "private key"],
];

/** Every CheckId has an entry: the type makes a missing one a compile error. */
const PROBES: Record<CheckId, Probes> = {
  "custom-404": {
    stacks: PAGES,
    static: (r) => {
      const g = r.files.find((f) => /(^|\/)((src\/)?app\/not-found\.(tsx|jsx|ts|js)|(src\/)?pages\/404\.(tsx|jsx|ts|js)|(public\/)?404\.html)$/.test(f));
      return g ? pass("A custom 404 page exists", g) : fail("No custom 404: add app/not-found.tsx (or 404.html) with the site's header and a way home.");
    },
    http: (s) => {
      if (s.notFound.status === 200) return fail("A missing page returns 200 (a soft 404). It must return 404.", s.notFound.url);
      if (s.notFound.status !== 404) return fail(`A missing page returns ${s.notFound.status}; it must return 404.`, s.notFound.url);
      if (isDefaultNotFound(s)) return fail(`The 404 is the server default (${s.notFound.title ?? "no title"}, ${s.notFound.bytes} bytes).`, s.notFound.url);
      return pass("Missing pages return a custom 404", s.notFound.url);
    },
  },
  "meta-title": {
    stacks: PAGES,
    static: (r) => metaStatic(r, "title"),
    http: (s) => forPages(s, "Every page has a title of 70 characters or fewer", (p) => (!p.title ? "no <title>" : p.title.length > 70 ? `title is ${p.title.length} characters` : null)),
  },
  "meta-description": {
    stacks: PAGES,
    static: (r) => metaStatic(r, "description"),
    http: (s) => forPages(s, "Every page has a meta description", (p) => (!p.description ? "no meta description" : p.description.length > 200 ? `description is ${p.description.length} characters` : null)),
  },
  "h1-unique": {
    http: (s) => forPages(s, "Every page has exactly one <h1>", (p) => (p.h1Count === 1 ? null : `${p.h1Count} <h1> elements`)),
  },
  canonical: {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /alternates\s*:\s*\{[^}]*canonical|rel\s*=\s*["']canonical["']|\bcanonical\s*:/);
      return g ? pass("A canonical link is set", hit(g)) : fail("No canonical URL is set on any page.");
    },
    http: (s) => forPages(s, "Every page has a canonical link", (p) => (p.canonical ? null : "no canonical")),
  },
  "html-lang": {
    stacks: PAGES,
    static: (r) => {
      const docs = r.files.filter((f) => /(^|\/)(layout\.(tsx|jsx)|index\.html|[^/]+\.html)$/.test(f));
      const roots = docs.filter((f) => /<html[\s>]/i.test(r.text(f) ?? ""));
      if (!roots.length) return unknown("No <html> element found in the layout or the HTML files.");
      const missing = roots.filter((f) => !/<html\b[^>]*\blang\s*=/i.test(r.text(f) ?? ""));
      return missing.length ? fail(`<html> has no lang in ${missing[0]}`, missing[0]!) : pass("<html> sets lang", roots[0]!);
    },
    http: (s) => forPages(s, "Every page sets <html lang>", (p) => (p.lang ? null : "no lang")),
  },
  "og-image": {
    stacks: PAGES,
    static: (r) => {
      const file = r.files.find((f) => /(^|\/)(src\/)?app\/(.*\/)?opengraph-image\.(png|jpe?g|gif|webp|tsx|ts|js)$/.test(f));
      if (file) return pass("An Open Graph image route exists", file);
      const g = grep(r, /openGraph\s*:\s*\{[\s\S]{0,400}?images\s*:|og:image|opengraph-image\./);
      return g ? pass("Open Graph image is set", hit(g)) : fail("No Open Graph image: add app/opengraph-image.png (1200 by 630).");
    },
    http: (s) => forPages(s, "Every page has an og:image", (p) => (p.ogImage ? null : "no og:image")),
  },
  favicon: {
    stacks: PAGES,
    static: (r) => {
      const fav = r.files.find((f) => /(^|\/)((src\/)?app\/(favicon\.ico|icon\.(png|svg|ico|jpe?g))|public\/favicon\.(ico|png|svg)|favicon\.(ico|png|svg))$/i.test(f));
      const apple = r.files.find((f) => /(^|\/)((src\/)?app\/apple-icon\.(png|jpe?g)|public\/apple-touch-icon(-precomposed)?\.png|apple-touch-icon(\.png)?)$/i.test(f));
      const missing = [!fav && "favicon", !apple && "apple-touch-icon"].filter(Boolean);
      return missing.length ? fail(`Missing ${missing.join(" and ")}: add app/icon.png and app/apple-icon.png (180 by 180).`) : pass("Favicon and apple-touch-icon exist", fav ?? apple ?? null);
    },
    http: (s) => {
      const fav = okProbe(s, "/favicon.ico");
      const apple = okProbe(s, "/apple-touch-icon.png");
      const missing = [!fav && "/favicon.ico", !apple && "/apple-touch-icon.png"].filter(Boolean);
      return missing.length ? fail(`Not served: ${missing.join(", ")}.`, at(s, String(missing[0]))) : pass("Favicon and apple-touch-icon are served", at(s, "/favicon.ico"));
    },
  },
  robots: {
    stacks: PAGES,
    static: (r) => {
      const g = r.files.find((f) => /(^|\/)((src\/)?app\/robots\.(ts|js|txt)|public\/robots\.txt|robots\.txt)$/.test(f));
      return g ? pass("robots.txt exists", g) : fail("No robots.txt: add app/robots.ts or public/robots.txt.");
    },
    http: (s) => {
      const r = s.probes["/robots.txt"];
      return r && okProbe(s, "/robots.txt") && /user-agent/i.test(r.body) ? pass("/robots.txt is served", at(s, "/robots.txt")) : fail("/robots.txt is not served (or has no User-agent rule).", at(s, "/robots.txt"));
    },
  },
  sitemap: {
    stacks: PAGES,
    static: (r) => {
      const g = r.files.find((f) => /(^|\/)((src\/)?app\/sitemap\.(ts|js|xml)|public\/sitemap(-index)?\.xml|sitemap(-index)?\.xml|next-sitemap\.config\.(js|cjs|mjs|ts))$/.test(f));
      return g ? pass("sitemap exists", g) : fail("No sitemap: add app/sitemap.ts (generated) or public/sitemap.xml.");
    },
    http: (s) => {
      const r = s.probes["/sitemap.xml"];
      return r && okProbe(s, "/sitemap.xml") && /<urlset|<sitemapindex/i.test(r.body) ? pass("/sitemap.xml is served", at(s, "/sitemap.xml")) : fail("/sitemap.xml is not served as a sitemap.", at(s, "/sitemap.xml"));
    },
  },
  "img-alt": {
    stacks: PAGES,
    static: (r) => {
      let total = 0;
      let first: string | null = null;
      for (const f of r.files) {
        if (!/\.(tsx|jsx|html?|vue|svelte|astro|mdx)$/i.test(f)) continue;
        const t = r.text(f) ?? "";
        for (const m of t.matchAll(/<(img|Image)\b[^>]*>/g)) {
          total++;
          const tag = m[0];
          if (/\balt\s*=/.test(tag) || /\{\s*\.\.\./.test(tag)) continue;
          first ??= `${f}:${t.slice(0, m.index).split("\n").length}`;
        }
      }
      if (!total) return pass("No <img> or next/image elements in the source");
      return first ? fail(`An image has no alt text (first: ${first})`, first) : pass(`All ${plural(total, "image")} in the source have alt text`);
    },
    http: (s) => forPages(s, "Every image has alt text", (p) => (p.imgNoAlt ? `${plural(p.imgNoAlt, "image")} without alt` : null)),
  },
  viewport: {
    stacks: PAGES,
    static: (r) => {
      if (isNext(r)) return pass("Next.js adds the viewport meta by default");
      const html = htmlFiles(r);
      if (!html.length) return unknown("No pages found: no Next.js app and no .html files.");
      const missing = html.filter((f) => !/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(r.text(f) ?? ""));
      return missing.length ? fail(`No viewport meta in ${missing[0]}`, missing[0]!) : pass("Viewport meta is set", html[0]!);
    },
    http: (s) => forPages(s, "Every page has a viewport meta", (p) => (p.viewport ? null : "no viewport meta")),
  },
  "legal-privacy": {
    stacks: PAGES,
    static: (r) => {
      const g = hasPage(r, "privacy|privacy-policy");
      return g ? pass("A privacy policy page exists", g) : fail("No privacy policy page: add app/privacy/page.tsx.");
    },
    http: (s) => {
      const ok = ["/privacy", "/privacy-policy"].find((p) => okProbe(s, p));
      return ok ? pass(`${ok} is served`, at(s, ok)) : fail("No privacy policy page answers at /privacy or /privacy-policy.", at(s, "/privacy"));
    },
  },
  "legal-terms": {
    stacks: PAGES,
    static: (r) => {
      const g = hasPage(r, "terms|terms-of-service|terms-and-conditions");
      return g ? pass("A terms page exists", g) : fail("No terms page: add app/terms/page.tsx.");
    },
    http: (s) => {
      const ok = ["/terms", "/terms-of-service"].find((p) => okProbe(s, p));
      return ok ? pass(`${ok} is served`, at(s, ok)) : fail("No terms page answers at /terms or /terms-of-service.", at(s, "/terms"));
    },
  },
  "cookie-consent": {
    stacks: WEB,
    static: (r) => {
      if (!analyticsStatic(r)) return pass("No analytics installed, so no consent banner is needed");
      const dep = depMatch(r, CONSENT_DEPS);
      if (dep) return pass(`Consent package ${dep} is installed`);
      const g = r.files.find((f) => /(cookie|consent)/i.test(f) && /\.(tsx|jsx|vue|svelte|astro|html)$/i.test(f));
      return g ? pass("A cookie consent component exists", g) : fail("Analytics is installed but there is no cookie banner or consent gate.");
    },
    http: (s) => {
      const pages = htmlPages(s);
      if (!pages.some((p) => p.analytics)) return pass("No analytics on the pages, so no consent banner is needed");
      return pages.some((p) => p.consent) ? pass("A cookie or consent banner is on the pages", pages[0]!.url) : fail("Analytics loads but no cookie or consent banner is on the pages.", pages[0]!.url);
    },
  },
  analytics: {
    stacks: WEB,
    static: (r) => {
      const found = analyticsStatic(r);
      return found ? pass("Analytics is installed", found) : fail("No analytics installed: add one (Plausible, PostHog, GA4 or Vercel Analytics).");
    },
    http: (s) => {
      const p = htmlPages(s).find((x) => x.analytics);
      return p ? pass("An analytics script is on the pages", p.url) : fail("No analytics script on any page.", s.base);
    },
  },
  "image-weight": {
    stacks: PAGES,
    static: (r) => {
      // Icons stay PNG (iOS and browsers need them), so the format rule skips them; the size rule still applies to them.
      const icon = /(^|\/)(icon|apple-icon|favicon|apple-touch-icon|opengraph-image|twitter-image)(-[^/]*)?\.(png|jpe?g|gif|ico)$/i;
      const imgs = r.files.filter((f) => /\.(png|jpe?g|gif|bmp|tiff?|webp|avif)$/i.test(f));
      if (!imgs.length) return pass("No raster images in the repo");
      const bad = imgs.filter((f) => r.size(f) > 300_000 || (!icon.test(f) && !/\.(webp|avif)$/i.test(f)));
      if (!bad.length) return pass(`Images are WebP or AVIF and under 300 KB (${plural(imgs.length, "image")} checked)`, imgs[0]!);
      return fail(`${plural(bad.length, "image")} over 300 KB or not WebP/AVIF: ${bad.slice(0, 3).join(", ")}`, bad[0]!);
    },
    http: (s) => {
      if (!s.images.length) return pass("No images on the home page");
      const bad = s.images.filter((i) => i.bytes > 300_000 || !/webp|avif|svg|icon/i.test(i.type));
      if (!bad.length) return pass(`Home page images are modern and under 300 KB (${plural(s.images.length, "image")} checked)`, s.images[0]!.url);
      return fail(`${plural(bad.length, "image")} over 300 KB or not WebP/AVIF: ${bad.slice(0, 3).map((i) => new URL(i.url).pathname).join(", ")}`, bad[0]!.url);
    },
  },
  "structured-data": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /@type["']?\s*:\s*["'](Organization|Product|SoftwareApplication|WebSite|LocalBusiness)["']/);
      return g ? pass("Structured data is present", hit(g)) : fail("No Organization or Product JSON-LD: add it to the root layout.");
    },
    http: (s) => {
      const p = htmlPages(s).find((x) => x.jsonLdTypes.some((t) => STRUCTURED_TYPES.has(t)));
      return p ? pass("Organization or Product JSON-LD is on the pages", p.url) : fail("No Organization or Product JSON-LD on any page.", s.base);
    },
  },
  "perf-budget": {
    http: (s) =>
      forPages(s, "Pages are within the budget: HTML under 200 KB, at most 2 render-blocking scripts in <head>", (p) => {
        if (p.bytes > 200_000) return `HTML is ${Math.round(p.bytes / 1000)} KB`;
        if (p.renderBlocking > 2) return `${p.renderBlocking} render-blocking scripts in <head>`;
        return null;
      }),
  },
  "broken-links": {
    http: (s) => {
      const status = new Map(s.pages.map((p) => [p.url, p.status]));
      const from = new Map<string, string>();
      for (const p of htmlPages(s)) for (const l of p.links) if (!from.has(l)) from.set(l, p.url);
      const broken = [...from.keys()].filter((u) => status.has(u) && (status.get(u)! >= 400 || status.get(u) === 0));
      if (broken.length) {
        const list = broken.slice(0, 3).map((u) => `${new URL(u).pathname} (${status.get(u)}, linked from ${new URL(from.get(u)!).pathname})`).join("; ");
        return fail(`${plural(broken.length, "broken internal link")}: ${list}`, from.get(broken[0]!) ?? s.base);
      }
      const unchecked = [...from.keys()].filter((u) => !status.has(u));
      if (unchecked.length) return unknown(`No broken link among the crawled pages. ${plural(unchecked.length, "internal link")} lie beyond the ${s.pages.length}-page crawl and were not fetched.`);
      return pass(`No broken internal links among ${plural(s.pages.length, "crawled page")}`, s.base);
    },
  },
  "https-redirect": {
    http: (s) => {
      if (!s.base.startsWith("https:")) {
        const host = new URL(s.base).hostname;
        if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) return unknown("A local URL serves no HTTPS, so there is no redirect to check.");
        return fail("The site is served over plain HTTP.", s.base);
      }
      if (s.httpRedirect === null) return unknown(`Could not reach the plain-HTTP address: ${s.httpError ?? "no answer"}.`);
      const { status, location } = s.httpRedirect;
      if ([301, 302, 307, 308].includes(status) && (location ?? "").startsWith("https://")) return pass(`http:// redirects to https:// (${status})`, location);
      return fail(`http:// answers ${status}${location ? ` to ${location}` : ""}; it must redirect to https://.`, `http://${new URL(s.base).host}/`);
    },
  },
  "social-links": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /href\s*=\s*\{?\s*["'`]https?:\/\/(www\.)?(facebook|x|twitter|linkedin|instagram|youtube|tiktok|github)\.com/i);
      return g ? pass("A social profile is linked", hit(g)) : fail("No social profile is linked from the source.");
    },
    http: (s) => {
      const p = htmlPages(s).find((x) => x.externalLinks.some((l) => SOCIAL_HREF.test(l)));
      return p ? pass("A social profile is linked", p.url) : fail("No link to a social profile on the pages.", s.base);
    },
  },
  health: {
    stacks: APP,
    static: (r) => {
      const route = r.files.find((f) => /(^|\/)(api\/)?(health|healthz)(\/route|\/index)?\.(ts|tsx|js|jsx)$/i.test(f));
      if (route) return pass("A health route exists", route);
      const g = grep(r, /["'`]\/(api\/)?(health|healthz)["'`]/);
      return g ? pass("A health route is declared", hit(g)) : fail("No health endpoint: add GET /api/health that returns JSON with 200.");
    },
    http: (s) => {
      const ok = HEALTH_PATHS.find((p) => {
        const r = s.probes[p];
        return r !== undefined && r.status >= 200 && r.status < 300 && (/json/i.test(r.type) || /^\s*[{[]/.test(r.body));
      });
      return ok ? pass(`${ok} answers with JSON and 2xx`, at(s, ok)) : fail(`No health path (${HEALTH_PATHS.join(", ")}) answers with 2xx JSON.`, s.base);
    },
  },
  "migrations-in-ci": {
    stacks: ALL,
    static: (r) => {
      const wf = r.files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
      if (!wf.length) return fail("No CI workflow in .github/workflows: migrations do not run in CI.");
      const g = wf.find((f) => /migrat|db:migrate|drizzle-kit (migrate|push)|prisma migrate|alembic upgrade/i.test(r.text(f) ?? ""));
      return g ? pass("A CI workflow runs database migrations", g) : fail("No CI workflow runs database migrations.", wf[0]!);
    },
  },
  "rate-limit": {
    stacks: APP,
    static: (r) => {
      const dep = depMatch(r, /rate-?limit|ratelimit/i);
      if (dep) return pass(`Rate limiting package ${dep} is installed`);
      const g = grep(r, /rate[-_ ]?limit|ratelimit|rateLimiter/i);
      return g ? pass("Rate limiting is in the source", hit(g)) : fail("No rate limiting found in the source.");
    },
  },
  "webhook-signature": {
    stacks: APP,
    static: (r) => {
      const hooks = r.files.filter((f) => /webhook/i.test(f) && SOURCE.test(f));
      if (!hooks.length) return unknown("No webhook route found, so there is nothing to verify yet.");
      const g = grep(r, /constructEvent|webhooks?\.(verify|constructEvent)|verifyWebhook|verifySignature|stripe-signature|x-hub-signature|svix|createHmac|timingSafeEqual/i);
      return g ? pass("A webhook signature is verified", hit(g)) : fail(`Webhook route ${hooks[0]} has no signature check.`, hooks[0]!);
    },
  },
  "error-tracking": {
    stacks: APP,
    static: (r) => {
      const dep = depMatch(r, /^(@sentry\/|sentry$|@bugsnag|@rollbar|rollbar$|@highlight-run|@honeybadger|@airbrake|@datadog\/)/);
      if (dep) return pass(`Error tracking package ${dep} is installed`);
      const g = grep(r, /Sentry\.init|sentry\.(client|server|edge)\.config|bugsnag|Rollbar\.init/i);
      return g ? pass("Error tracking is initialized", hit(g)) : fail("No error tracking: install Sentry (or another tracker) and initialize it.");
    },
  },
  "input-validation": {
    stacks: APP,
    static: (r) => {
      const dep = depMatch(r, /^(zod|valibot|yup|joi|arktype|@sinclair\/typebox|ajv|class-validator|superstruct|@hono\/zod-validator|@hono\/valibot-validator)$/);
      return dep ? pass(`Validation library ${dep} is installed`) : fail("No schema validation library (zod, valibot, yup...) is installed.");
    },
  },
  "secrets-not-in-repo": {
    stacks: ALL,
    static: (r) => {
      const envs = r.files.filter((f) => /(^|\/)\.env(\.[^/]+)?$/.test(f) && !/\.(example|sample|template|dist)$/.test(f));
      const ignore = r.text(".gitignore") ?? "";
      if (envs.length && !/^\s*\/?\.env(\*|\.local|\.\*|$)/m.test(ignore)) {
        return fail(`${envs[0]} exists and .gitignore does not ignore .env files.`, envs[0]!);
      }
      for (const [re, what] of SECRET_PATTERNS) {
        const g = grep(r, re, SOURCE);
        // The value is never echoed: the message names the kind of key and where it is.
        if (g) return fail(`A ${what} is written in ${hit(g)}. Move it to the secrets store and rotate it.`, hit(g));
      }
      return pass(envs.length ? "Env files are git-ignored and no key is written in the source" : "No env files and no key written in the source");
    },
  },
  "status-contact": {
    stacks: PAGES,
    static: (r) => {
      const g = hasPage(r, "status|contact");
      return g ? pass("A status or contact page exists", g) : fail("No /status or /contact page.");
    },
    http: (s) => {
      const ok = ["/status", "/contact"].find((p) => okProbe(s, p));
      return ok ? pass(`${ok} is served`, at(s, ok)) : fail("No /status or /contact page answers.", at(s, "/contact"));
    },
  },
  "cors-policy": {
    stacks: APP,
    static: (r) => {
      const wild = grep(r, /origin\s*:\s*["'`]\*["'`]|Access-Control-Allow-Origin["'`]?\s*[,:]\s*["'`]\*["'`]/);
      if (wild) return fail(`Wildcard CORS origin in ${hit(wild)}. Name the allowed origins.`, hit(wild));
      const bare = grep(r, /\bcors\(\s*\)/);
      if (bare) return fail(`cors() with no options allows every origin (${hit(bare)}).`, hit(bare));
      const g = grep(r, /\bcors\s*\(|Access-Control-Allow-Origin|\borigin\s*:/i);
      return g ? pass("An explicit CORS policy is set", hit(g)) : fail("No CORS policy found.");
    },
  },
  openapi: {
    stacks: APP,
    static: (r) => {
      const file = r.files.find((f) => /(^|\/)(openapi|swagger)\.(json|ya?ml)$/i.test(f));
      if (file) return pass("An OpenAPI document exists", file);
      const dep = depMatch(r, /openapi|swagger|zod-openapi|hono-openapi|@scalar/i);
      return dep ? pass(`OpenAPI tooling ${dep} is installed`) : fail("No OpenAPI document or generator found.");
    },
  },
  "api-versioning": {
    stacks: APP,
    static: (r) => {
      const g = grep(r, /["'`]\/v\d+\/|\/api\/v\d+/);
      return g ? pass("Routes are versioned", hit(g)) : fail("No version prefix (/v1/...) found on the routes.");
    },
  },
  "structured-logs": {
    stacks: APP,
    static: (r) => {
      const dep = depMatch(r, /^(pino|winston|bunyan|loglevel|consola|tslog|@logtape\/logtape|logtape)$/);
      if (dep) return pass(`Logger ${dep} is installed`);
      const g = grep(r, /pino\(|winston\.create|createLogger\(/);
      return g ? pass("A structured logger is created", hit(g)) : fail("No structured logger (pino, winston or similar) found.");
    },
  },
  "store-metadata": {
    stacks: MOBILE,
    static: (r) => {
      const meta = readStoreMetadata(r.root);
      if (meta.issues.length) return fail(`${meta.path}: ${meta.issues.map((i) => i.problem).join(" ")}`, meta.present ? meta.path : null);
      return pass(`${meta.path} is complete and within the store limits`, meta.path);
    },
  },
  "crash-reporting": {
    stacks: MOBILE,
    static: (r) => {
      const dep = depMatch(r, /^(@sentry\/react-native|sentry-expo|@react-native-firebase\/crashlytics|expo-crashlytics|@bugsnag\/react-native|bugsnag-react-native|@sentry\/)/);
      return dep ? pass(`Crash reporting package ${dep} is installed`) : fail("No crash reporter installed (Sentry React Native, Crashlytics...).");
    },
  },
  "icon-set": {
    stacks: MOBILE,
    static: (r) => {
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const icon = assetPath(cfgValue(cfg, ["icon"])) ?? "assets/icon.png";
      return r.files.includes(icon) ? pass(`App icon ${icon} exists`, icon) : fail(`The app icon ${icon} does not exist.`, cfg.file);
    },
  },
  splash: {
    stacks: MOBILE,
    static: (r) => {
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const img = assetPath(cfgValue(cfg, ["splash", "image"]));
      if (img) return r.files.includes(img) ? pass(`Splash image ${img} exists`, img) : fail(`The splash image ${img} does not exist.`, cfg.file);
      const g = r.files.find((f) => /^assets\/splash[^/]*\.(png|jpe?g)$/i.test(f));
      return g ? pass("A splash image exists", g) : fail("No splash image: set splash.image in app config.");
    },
  },
  "bundle-id": {
    stacks: MOBILE,
    static: (r) => {
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const missing = [
        !(nonEmpty(cfgValue(cfg, ["ios", "bundleIdentifier"])) || (!cfg.json && cfgNamed(cfg, "bundleIdentifier"))) && "ios.bundleIdentifier",
        !(nonEmpty(cfgValue(cfg, ["android", "package"])) || (!cfg.json && cfgNamed(cfg, "package"))) && "android.package",
      ].filter(Boolean);
      return missing.length ? fail(`Not set: ${missing.join(", ")}.`, cfg.file) : pass("Bundle identifier and Android package are set", cfg.file);
    },
  },
  "app-version": {
    stacks: MOBILE,
    static: (r) => {
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const v = cfg.json ? cfgValue(cfg, ["version"]) : /version\s*:\s*["'](\d+\.\d+\.\d+[^"']*)["']/.exec(cfg.text)?.[1];
      if (typeof v !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) return fail("expo.version is missing or not semver (x.y.z).", cfg.file);
      if (v === "0.0.0") return fail("expo.version is still 0.0.0. Bump it for this release.", cfg.file);
      return pass(`Version ${v}`, cfg.file);
    },
  },
  "privacy-manifest": {
    stacks: MOBILE,
    static: (r) => {
      const file = r.files.find((f) => /PrivacyInfo\.xcprivacy$/.test(f));
      if (file) return pass("iOS privacy manifest exists", file);
      const cfg = expoConfig(r);
      if (cfg && (cfgValue(cfg, ["ios", "privacyManifests"]) !== undefined || (!cfg.json && /privacyManifests/.test(cfg.text)))) return pass("ios.privacyManifests is declared", cfg.file);
      return fail("No privacy manifest: declare ios.privacyManifests (or PrivacyInfo.xcprivacy). Fill the Play data safety form too.");
    },
  },
  "store-screenshots": {
    stacks: MOBILE,
    static: (r) => {
      const shots = r.files.filter((f) => /^store\/screenshots\/.+\.(png|jpe?g)$/i.test(f));
      if (!shots.length) return fail("No screenshots under store/screenshots.");
      const sized: Array<{ file: string; size: ImageSize }> = [];
      const unreadable: string[] = [];
      for (const file of shots) {
        let size: ImageSize | null = null;
        try {
          size = imageSize(fs.readFileSync(path.join(r.root, file)));
        } catch {}
        if (size) sized.push({ file, size });
        else unreadable.push(file);
      }
      if (unreadable.length) return fail(`${plural(unreadable.length, "screenshot")} with no readable PNG or JPEG header: ${unreadable.slice(0, 3).join(", ")}`, unreadable[0]!);
      const iphone = sized.find((x) => isIphoneSize(x.size));
      if (!iphone) return fail(`No screenshot is an App Store iPhone size (${IPHONE_SIZES_TEXT}, either orientation). Found ${sized.slice(0, 3).map((x) => `${x.file} (${x.size.width}x${x.size.height})`).join(", ")}.`, sized[0]!.file);
      const play = sized.filter((x) => fitsPlay(x.size));
      if (play.length < PLAY_MIN_SHOTS) return fail(`Google Play needs ${PLAY_MIN_SHOTS} screenshots with each side 320 to 3840 px and a long side at most twice the short one. ${play.length} fit.`, sized[0]!.file);
      return pass(`${plural(sized.length, "screenshot")} under store/screenshots, sizes read from the image headers: ${iphone.file} is an App Store iPhone size and ${play.length} fit Google Play`, iphone.file);
    },
  },
  "deep-links": {
    stacks: MOBILE,
    static: (r) => {
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const scheme = cfg.json ? cfgValue(cfg, ["scheme"]) : /scheme\s*:\s*["'][\w-]+["']/.exec(cfg.text)?.[0];
      return nonEmpty(scheme) ? pass("A URL scheme is set for deep links", cfg.file) : fail("No scheme in app config: deep links cannot open the app.", cfg.file);
    },
  },
  "permission-strings": {
    stacks: MOBILE,
    static: (r) => {
      const need: Record<string, string[]> = {
        "expo-camera": ["NSCameraUsageDescription"],
        "expo-image-picker": ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription"],
        "expo-media-library": ["NSPhotoLibraryUsageDescription"],
        "expo-location": ["NSLocationWhenInUseUsageDescription"],
        "expo-contacts": ["NSContactsUsageDescription"],
        "expo-calendar": ["NSCalendarsUsageDescription"],
        "expo-audio": ["NSMicrophoneUsageDescription"],
        "expo-av": ["NSMicrophoneUsageDescription"],
      };
      const deps = r.deps();
      const used = Object.keys(need).filter((d) => deps.has(d));
      if (!used.length) return pass("No permission-using Expo modules are installed");
      const cfg = expoConfig(r);
      if (!cfg) return unknown("No app.json or app.config.* found.");
      const keys = [...new Set(used.flatMap((d) => need[d]!))];
      const missing = keys.filter((k) => (cfg.json ? !nonEmpty(cfgValue(cfg, ["ios", "infoPlist", k])) : !cfg.text.includes(k)));
      return missing.length ? fail(`Missing iOS usage strings: ${missing.join(", ")}.`, cfg.file) : pass(`Usage strings set for ${used.join(", ")}`, cfg.file);
    },
  },
  "ota-channel": {
    stacks: MOBILE,
    static: (r) => {
      const raw = r.text("eas.json");
      if (raw === null) return fail("No eas.json: set a channel on each build profile.");
      try {
        const profiles = Object.values(JSON.parse(raw).build ?? {}) as Array<Record<string, unknown>>;
        return profiles.some((p) => p && typeof p.channel === "string") ? pass("A build profile sets an OTA channel", "eas.json") : fail("No build profile in eas.json sets a channel.", "eas.json");
      } catch {
        return fail("eas.json is not valid JSON.", "eas.json");
      }
    },
  },
  "seo-title-length": {
    stacks: PAGES,
    static: (r) => literalMeta(r, "title", 30, 60),
    http: (s) => forPages(s, "Every title is 30 to 60 characters", (p) => (!p.title ? "no <title>" : rangeProblem("title", p.title.length, 30, 60))),
  },
  "seo-description-length": {
    stacks: PAGES,
    static: (r) => literalMeta(r, "description", 70, 160),
    http: (s) => forPages(s, "Every description is 70 to 160 characters", (p) => (!p.description ? "no meta description" : rangeProblem("description", p.description.length, 70, 160))),
  },
  "seo-unique-meta": {
    http: (s) => {
      const pages = htmlPages(s);
      if (!pages.length) return fail(`No HTML page answered at ${s.base}.`);
      const dup = [...duplicates(pages, "title", (p) => p.title), ...duplicates(pages, "description", (p) => p.description)];
      return dup.length ? fail(dup.slice(0, 3).join("; "), pages[0]!.url) : pass(`No title or description is shared by two pages (${plural(pages.length, "page")})`, s.base);
    },
  },
  "seo-heading-order": {
    http: (s) => forPages(s, "No heading level is skipped", (p) => skippedHeading(p.headings)),
  },
  "seo-json-ld": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /application\/ld\+json/i);
      return g ? pass("JSON-LD is written in the source. The served page is parsed when the checks run with a URL", hit(g)) : fail("No JSON-LD in the source: add an Organization or WebSite block with an @type.");
    },
    http: (s) => {
      if (!htmlPages(s).some((p) => p.jsonLdBlocks > 0)) return fail("No JSON-LD on any page. Add an Organization or WebSite block with an @type.", s.base);
      return forPages(s, "Every JSON-LD block parses and has an @type", (p) => (p.jsonLdBroken ? `${plural(p.jsonLdBroken, "JSON-LD block")} do not parse or have no @type` : null));
    },
  },
  "seo-canonical-self": {
    http: (s) =>
      forPages(s, "Every canonical is absolute and points at its own page", (p) => {
        if (!p.canonical) return "no canonical";
        if (!/^https?:\/\//i.test(p.canonical)) return `canonical "${p.canonical}" is relative`;
        return safeNorm(p.canonical) === safeNorm(p.url) ? null : `canonical points to ${p.canonical}`;
      }),
  },
  "seo-no-noindex": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /noindex|robots\s*:\s*\{[^}]*\bindex\s*:\s*false/i);
      return g ? fail(`noindex is set in ${hit(g)}. Remove it from pages that should rank; keep it for previews only.`, hit(g)) : pass("No noindex in the source");
    },
    http: (s) => forPages(s, "No page is noindex", (p) => (p.noindex ? "noindex" : null)),
  },
  "seo-sitemap-coverage": {
    http: (s) => {
      const pages = htmlPages(s);
      if (!pages.length) return fail(`No HTML page answered at ${s.base}.`);
      if (!s.sitemap) return fail("/sitemap.xml is not served, so the crawled pages are not listed in it.", at(s, "/sitemap.xml"));
      if (s.sitemap.index) return unknown("/sitemap.xml is a sitemap index. Its child sitemaps are not read yet.");
      if (s.sitemap.truncated) return unknown(`/sitemap.xml lists more than ${MAX_SITEMAP_URLS} URLs. Only the first ${MAX_SITEMAP_URLS} were checked.`);
      const listed = new Set(s.sitemap.urls.map((u) => u.url));
      const bad = s.sitemap.urls.filter((u) => u.status !== 200);
      const missing = pages.map((p) => p.url).filter((u) => !listed.has(u));
      const problems: string[] = [];
      if (bad.length) problems.push(`${plural(bad.length, "sitemap URL")} not answering 200: ${bad.slice(0, 3).map((u) => `${pathOf(u.url)} (${u.status})`).join(", ")}`);
      if (missing.length) problems.push(`${plural(missing.length, "crawled page")} missing from the sitemap: ${missing.slice(0, 3).map(pathOf).join(", ")}`);
      return problems.length ? fail(problems.join("; "), at(s, "/sitemap.xml")) : pass(`Every sitemap URL answers 200, and all ${plural(pages.length, "crawled page")} are listed`, at(s, "/sitemap.xml"));
    },
  },
  "seo-robots-rules": {
    stacks: PAGES,
    static: (r) => {
      const file = r.files.find((f) => /(^|\/)((src\/)?app\/robots\.(ts|js)|public\/robots\.txt|robots\.txt)$/.test(f));
      if (!file) return fail("No robots file to read: add app/robots.ts or public/robots.txt.");
      const problems = robotsProblems(r.text(file) ?? "");
      return problems.length ? fail(`${file} ${problems.join(" and ")}.`, file) : pass(`${file} allows the site and names the sitemap`, file);
    },
    http: (s) => {
      if (!okProbe(s, "/robots.txt")) return fail("/robots.txt is not served.", at(s, "/robots.txt"));
      const problems = robotsProblems(s.probes["/robots.txt"]!.body);
      return problems.length ? fail(`/robots.txt ${problems.join(" and ")}.`, at(s, "/robots.txt")) : pass("/robots.txt allows the site and names the sitemap", at(s, "/robots.txt"));
    },
  },
  "seo-hreflang": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /hreflang|languages\s*:\s*\{/);
      return g ? unknown("hreflang is set in the source. Run the checks with a URL to check the links that are served.") : pass("No hreflang in the source, so there is nothing to validate");
    },
    http: (s) => {
      const tagged = htmlPages(s).filter((p) => p.hreflangs.length);
      if (!tagged.length) return pass("No hreflang on the pages (a single-language site needs none)", s.base);
      return forPages(
        s,
        "Every hreflang code is valid, absolute, and lists the page itself",
        (p) => {
          const bad = p.hreflangs.find((h) => !/^(x-default|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/i.test(h.lang));
          if (bad) return `invalid hreflang "${bad.lang}"`;
          if (p.hreflangs.some((h) => !/^https?:\/\//i.test(h.href))) return "an hreflang href is not absolute";
          return p.hreflangs.some((h) => safeNorm(h.href) === safeNorm(p.url)) ? null : "hreflang does not list the page itself";
        },
        tagged,
      );
    },
  },
  "seo-anchor-text": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /<a\b[^>]*>\s*(click here|here|read more)\s*<\/a>|\[(click here|here|read more)\]\(/i, /\.(tsx|jsx|html?|mdx|md|vue|svelte|astro)$/i);
      return g ? fail(`A link says "click here", "here" or "read more" (${hit(g)}). Name the destination instead.`, hit(g)) : pass("No generic link text in the source");
    },
    http: (s) => forPages(s, "Internal links use descriptive text", (p) => (p.genericAnchors.length ? `${plural(p.genericAnchors.length, "link")} with generic text (${p.genericAnchors.slice(0, 2).map((x) => `"${x}"`).join(", ")})` : null)),
  },
  "seo-twitter-card": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /twitter:card|card\s*:\s*["'](summary|summary_large_image)["']|twitter\s*:\s*\{/i);
      return g ? pass("Twitter card tags are set in the source", hit(g)) : fail("No Twitter card tags: add twitter:card (summary_large_image) to the metadata.");
    },
    http: (s) => forPages(s, "Every page has a twitter:card", (p) => (p.twitterCard ? null : "no twitter:card")),
  },
  "seo-indexable-html": {
    http: (s) =>
      forPages(s, `Every page has at least ${MIN_TEXT} characters of text in its server HTML`, (p) =>
        p.text.length >= MIN_TEXT ? null : `${p.text.length} characters of text${p.clientShell ? ", and an empty app root: the page is drawn by JavaScript" : ""}`,
      ),
  },
  "seo-image-dimensions": {
    stacks: PAGES,
    static: (r) => {
      let total = 0;
      let first: string | null = null;
      for (const f of r.files) {
        if (!/\.(tsx|jsx|html?|vue|svelte|astro)$/i.test(f)) continue;
        const t = r.text(f) ?? "";
        for (const m of t.matchAll(/<img\b[^>]*>/gi)) {
          total++;
          const tag = m[0];
          if (/\swidth\s*=/.test(tag) && /\sheight\s*=/.test(tag)) continue;
          if (/\{\s*\.\.\./.test(tag)) continue;
          first ??= `${f}:${t.slice(0, m.index).split("\n").length}`;
        }
      }
      if (first) return fail(`An <img> has no width and height (first: ${first})`, first);
      return pass(total ? `All ${plural(total, "<img>")} in the source declare width and height` : "No plain <img> elements in the source");
    },
    http: (s) => forPages(s, "Every image declares width and height", (p) => (p.imgNoDims ? `${plural(p.imgNoDims, "image")} without width and height` : null)),
  },
  "cro-cta-first-screen": {
    http: (s) =>
      forPages(
        s,
        "A call to action appears before the first H2 on each landing page",
        (p) => {
          const ctas = p.actions.filter(isCta);
          if (!ctas.length) return "no call to action";
          const h2 = p.h2At;
          return h2 === null || ctas.some((a) => a.at < h2) ? null : "the first call to action is below the first H2";
        },
        landingOf(s),
      ),
  },
  "cro-cta-text": {
    http: (s) =>
      forPages(s, "No call to action uses generic text", (p) => {
        const bad = p.actions.find((a) => (a.kind === "button" || isCta(a)) && GENERIC_CTA.test(a.label));
        return bad ? `generic button text "${bad.label}"` : null;
      }),
  },
  "cro-social-proof": {
    http: (s) => forPages(s, "Landing pages show social proof: a testimonial, logo, review or rating", (p) => (p.socialProof ? null : "no testimonial, logo, review or rating"), landingOf(s)),
  },
  "cro-risk-reducer": {
    http: (s) =>
      forPages(s, "Landing pages have a risk reducer next to the call to action", (p) => (nearCta(p) ? null : "no free trial, no card needed, cancel anytime or guarantee beside the call to action"), landingOf(s)),
  },
  "cro-form-fields": {
    http: (s) =>
      forPages(s, "Every form has five fields or fewer", (p) => {
        const big = p.formFields.find((n) => n > 5);
        return big === undefined ? null : `a form has ${big} fields`;
      }),
  },
  "cro-pricing-page": {
    stacks: PAGES,
    static: (r) => {
      const g = hasPage(r, "pricing|plans");
      return g ? pass("A pricing page exists", g) : fail("No pricing page: add app/pricing/page.tsx, or say on the home page how a buyer gets a price.");
    },
    http: (s) => {
      if (okProbe(s, "/pricing")) return pass("/pricing is served", at(s, "/pricing"));
      const crawled = htmlPages(s).find((p) => /\/(pricing|plans)$/.test(pathOf(p.url)));
      return crawled ? pass(`${pathOf(crawled.url)} is a pricing page`, crawled.url) : fail("No pricing page: nothing answers at /pricing and no crawled page links to one.", at(s, "/pricing"));
    },
  },
  "cro-faq-before-cta": {
    http: (s) => {
      const home = s.pages.find((p) => p.url === s.base && p.isHtml);
      if (!home) return fail(`No HTML page answered at ${s.base}.`);
      if (home.faqAt === null) return fail("The home page has no FAQ: add an H2 that says FAQ, with FAQPage data or <details>.", s.base);
      const last = home.actions.filter(isCta).reduce((m, a) => Math.max(m, a.at), -1);
      return last >= 0 && home.faqAt > last ? fail("The FAQ comes after the last call to action on the home page.", s.base) : pass("The FAQ comes before the final call to action", s.base);
    },
  },
  "copy-headline": {
    http: (s) =>
      forPages(
        s,
        "Each landing headline has a number, an outcome or \"you\"",
        (p) => (!p.h1Text ? "no H1 text" : HEADLINE.test(p.h1Text) ? null : `headline "${p.h1Text.slice(0, 60)}" has no number, outcome or you`),
        landingOf(s),
      ),
  },
  "copy-readability": {
    http: (s) => {
      const pages = landingOf(s);
      if (!pages.length) return fail(`No HTML page answered at ${s.base}.`);
      const judged = pages.map((p) => ({ p, r: readability(p.text) })).filter((x) => x.r.words >= 30);
      if (!judged.length) return unknown("Too little visible text on the landing pages to judge the reading level.");
      const bad = judged.find((x) => x.r.avgSentence >= 20 || x.r.flesch < 60);
      if (bad) return fail(`${pathOf(bad.p.url)}: sentences average ${bad.r.avgSentence.toFixed(1)} words and the reading ease is ${Math.round(bad.r.flesch)} (need under 20 words and 60 or more)`, bad.p.url);
      return pass(`Landing copy has sentences under 20 words and a reading ease of 60 or more (${plural(judged.length, "page")})`, judged[0]!.p.url);
    },
  },
  "copy-hype": {
    http: (s) =>
      forPages(s, "No hype or filler words in the visible text", (p) => {
        const hits = [...new Set((p.text.match(HYPE) ?? []).map((w) => w.toLowerCase()))];
        return hits.length ? `uses ${hits.slice(0, 4).join(", ")}` : null;
      }),
  },
  "copy-you-we": {
    http: (s) =>
      forPages(
        s,
        "Landing copy speaks to the reader: you and your outnumber we and our",
        (p) => {
          const you = countOf(p.text, /\b(you|your|yours)\b/gi);
          const we = countOf(p.text, /\b(we|our|ours)\b/gi);
          return you > we ? null : `you and your appear ${you} times, we and our ${we}`;
        },
        landingOf(s),
      ),
  },
  "copy-placeholder": {
    stacks: PAGES,
    static: (r) => {
      const g = grep(r, /lorem ipsum|\bTODO\b|your company|example\.com/i, /\.(tsx|jsx|html?|mdx|md|vue|svelte|astro)$/i);
      return g ? fail(`Placeholder text in ${hit(g)}. Replace it with the real copy.`, hit(g)) : pass("No placeholder copy in the page files");
    },
    http: (s) =>
      forPages(s, "No lorem ipsum, TODO, placeholder company or example.com in the copy", (p) => {
        const m = PLACEHOLDER.exec(`${p.title ?? ""} ${p.text}`);
        return m ? `found "${m[0]}"` : null;
      }),
  },
};

/* -------------------------------------------------------------------------- */
/* The runner                                                                 */
/* -------------------------------------------------------------------------- */

export interface CheckContext {
  /** The workspace folder for static probes. */
  root: string | null;
  /** The running dev server or the deploy URL for HTTP probes. */
  url: string | null;
  fetch?: FetchFn;
  maxPages?: number;
}

/**
 * Returns a runner for one "Run checks" pass. The repo is read and the site crawled at most once, however many
 * checks ask for them.
 */
export function makeChecker(ctx: CheckContext): (id: CheckId) => Promise<CheckResult> {
  const f: FetchFn = ctx.fetch ?? ((input, init) => fetch(input, init));
  let repo: Repo | null = null;
  let stack: StackDetection | null = null;
  const repoOf = (): Repo | null => (repo ??= ctx.root ? openRepo(ctx.root) : null);
  const stackOf = (r: Repo): StackDetection => (stack ??= detectStack(r));
  let site: Promise<SiteAudit> | null = null;
  // A URL that answers nothing is unreachable, not a failing site: the HTTP probes then say unknown and the repo decides.
  const siteOf = (): Promise<SiteAudit> =>
    (site ??= auditSite(ctx.url!, f, ctx.maxPages ?? MAX_PAGES).then((audit) => {
      if (!audit.pages.some((p) => p.status > 0)) throw new Error("no answer");
      return audit;
    }));

  return async (id) => {
    const probe = PROBES[id];
    let httpResult: CheckResult | null = null;
    if (probe.http && ctx.url) {
      try {
        httpResult = probe.http(await siteOf());
        if (httpResult.status !== "unknown" || !probe.static) return httpResult;
      } catch (e) {
        httpResult = unknown(`Could not reach ${ctx.url}: ${errorText(e)}`);
        if (!probe.static) return httpResult;
      }
    }
    if (probe.static) {
      const r = repoOf();
      if (!r) return unknown(NEEDS_ROOT);
      // Not run on a stack the probe does not understand: a false pass or fail would be worse than "unknown".
      const detected = stackOf(r).stack;
      if (isTemplateStack(detected) && TEMPLATE_PROBES[id]) return TEMPLATE_PROBES[id]!({ repo: r, templates: templatesOf(r, detected) });
      if (!probe.stacks.includes(detected)) return unknown(`Not checkable statically for ${detected}: left to the agent audit`);
      return probe.static(r);
    }
    if (httpResult) return httpResult;
    return unknown(NEEDS_URL);
  };
}

/** The stacks a check's static probe understands, or null when it has none. For the tests and the panel's docs. */
export function staticStacksOf(id: CheckId): readonly Stack[] | null {
  const own = PROBES[id].stacks;
  return own && TEMPLATE_PROBES[id] ? [...own, ...TEMPLATE_STACKS] : (own ?? null);
}
