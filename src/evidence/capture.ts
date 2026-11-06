/**
 * Capturing a page for the evidence store: the rendered DOM, the accessibility tree, the design values the
 * page really uses (computed, so a stylesheet's intent does not matter), the assets and requests it made,
 * and a screenshot. Everything is read from the page the agent browser already has open; this file starts no
 * navigation of its own.
 *
 * What is NOT kept: request or response headers and bodies, cookies and storage. Resource Timing gives
 * the list of what loaded without any of those, so a capture cannot leak a session token that way. The
 * HTML and the text parts still pass through `redact` for token-shaped strings.
 */
import type { Page } from "playwright-core";
import { redact } from "../search/redact";

const MAX_HTML_BYTES = 2_000_000;
const MAX_SNAPSHOT_CHARS = 120_000;
const MAX_FULL_PAGE_PX = 8000;

export interface PageCapture {
  title: string;
  url: string;
  summary: string;
  files: Record<string, string | Buffer>;
}

interface InPage {
  colors: { text: Array<[string, number]>; background: Array<[string, number]>; border: Array<[string, number]> };
  fonts: { families: Array<[string, number]>; sizes: Array<[string, number]>; weights: Array<[string, number]>; lineHeights: Array<[string, number]> };
  radii: Array<[string, number]>;
  shadows: Array<[string, number]>;
  spacing: Array<[string, number]>;
  cssVars: Record<string, string>;
  meta: Record<string, string>;
  scripts: string[];
  stylesheets: string[];
  images: string[];
  loadedFonts: string[];
  counts: { elements: number; links: number; forms: number; inputs: number; buttons: number };
  resources: Array<{ url: string; type: string; bytes: number; ms: number }>;
}

/** Runs inside the page. Self-contained: nothing from this module is in scope there. */
function inspect(maxElements: number): InPage {
  const top = (m: Map<string, number>, n = 24): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const bump = (m: Map<string, number>, k: string) => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  const transparent = (c: string) => !c || c === "transparent" || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c);
  const text = new Map<string, number>();
  const background = new Map<string, number>();
  const border = new Map<string, number>();
  const families = new Map<string, number>();
  const sizes = new Map<string, number>();
  const weights = new Map<string, number>();
  const lineHeights = new Map<string, number>();
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();
  const spacing = new Map<string, number>();

  const all = Array.from(document.body?.querySelectorAll("*") ?? []);
  const step = Math.max(1, Math.ceil(all.length / maxElements));
  for (let i = 0; i < all.length; i += step) {
    const el = all[i] as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) {
      bump(text, cs.color);
      bump(families, cs.fontFamily);
      bump(sizes, cs.fontSize);
      bump(weights, cs.fontWeight);
      bump(lineHeights, cs.lineHeight);
    }
    if (!transparent(cs.backgroundColor)) bump(background, cs.backgroundColor);
    if (parseFloat(cs.borderTopWidth) > 0 && !transparent(cs.borderTopColor)) bump(border, cs.borderTopColor);
    if (cs.borderTopLeftRadius !== "0px") bump(radii, cs.borderTopLeftRadius);
    if (cs.boxShadow !== "none") bump(shadows, cs.boxShadow);
    for (const v of [cs.paddingTop, cs.paddingLeft, cs.marginTop, cs.marginLeft, cs.rowGap, cs.columnGap]) if (v && v !== "0px" && v !== "normal" && v !== "auto") bump(spacing, v);
  }

  const cssVars: Record<string, string> = {};
  let n = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin stylesheet: its rules are not readable
    }
    for (const rule of Array.from(rules)) {
      const sr = rule as CSSStyleRule;
      if (!sr.selectorText || !/(^|,)\s*(:root|html)\s*(,|$)/.test(sr.selectorText)) continue;
      for (const name of Array.from(sr.style)) {
        if (name.startsWith("--") && n < 300) {
          cssVars[name] = sr.style.getPropertyValue(name).trim();
          n++;
        }
      }
    }
  }

  const meta: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll("meta"))) {
    const key = m.getAttribute("name") || m.getAttribute("property");
    const val = m.getAttribute("content");
    if (key && val && Object.keys(meta).length < 40) meta[key] = val.slice(0, 300);
  }
  const abs = (u: string | null) => {
    try {
      return u ? new URL(u, location.href).href : "";
    } catch {
      return "";
    }
  };
  const uniq = (xs: string[], max = 200) => [...new Set(xs.filter(Boolean))].slice(0, max);
  const fontsLoaded: string[] = [];
  document.fonts?.forEach((f) => fontsLoaded.push(`${f.family} ${f.weight} ${f.style} (${f.status})`));

  return {
    colors: { text: top(text), background: top(background), border: top(border) },
    fonts: { families: top(families, 10), sizes: top(sizes), weights: top(weights, 10), lineHeights: top(lineHeights, 12) },
    radii: top(radii, 12),
    shadows: top(shadows, 8),
    spacing: top(spacing, 24),
    cssVars,
    meta,
    scripts: uniq(Array.from(document.scripts).map((s) => abs(s.getAttribute("src")))),
    stylesheets: uniq(Array.from(document.querySelectorAll("link[rel~=stylesheet]")).map((l) => abs(l.getAttribute("href")))),
    images: uniq(Array.from(document.images).map((i) => abs(i.currentSrc || i.getAttribute("src")))),
    loadedFonts: uniq(fontsLoaded, 40),
    counts: { elements: all.length, links: document.links.length, forms: document.forms.length, inputs: document.querySelectorAll("input,select,textarea").length, buttons: document.querySelectorAll("button,[role=button]").length },
    resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).slice(0, 600).map((e) => ({ url: e.name, type: e.initiatorType, bytes: e.transferSize || e.encodedBodySize || 0, ms: Math.round(e.duration) })),
  };
}

/** A URL without its query and fragment: a signed asset link carries its secret there. */
export function stripQuery(raw: string): string {
  try {
    const u = new URL(raw);
    return u.protocol === "data:" ? "data:" : `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return raw.slice(0, 200);
  }
}

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}\n… [truncated: ${s.length - max} more characters]` : s);

export async function capturePage(page: Page, o: { fullPage?: boolean; console?: Array<{ level: string; text: string }> } = {}): Promise<PageCapture> {
  const url = page.url();
  if (!url || url === "about:blank") throw new Error("The browser has no page open. Navigate somewhere first.");
  const title = await page.title().catch(() => "");

  const found = await page.evaluate(inspect, 800);
  const html = redact(Buffer.from(await page.content()).subarray(0, MAX_HTML_BYTES).toString("utf-8"));
  const snapshot = redact(cap(await page.ariaSnapshot({ mode: "ai" } as any).catch(() => ""), MAX_SNAPSHOT_CHARS));

  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (o.fullPage !== false) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    if (h > MAX_FULL_PAGE_PX) clip = { x: 0, y: 0, width: 1280, height: MAX_FULL_PAGE_PX };
  }
  const shot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: o.fullPage !== false, clip, timeout: 15_000 });

  const { resources, cssVars, ...design } = found;
  const requests = resources.map((r) => ({ ...r, url: stripQuery(r.url) }));
  const byType: Record<string, number> = {};
  for (const r of requests) byType[r.type] = (byType[r.type] ?? 0) + 1;

  const files: Record<string, string | Buffer> = {
    "page.html": html,
    "snapshot.txt": snapshot,
    "screenshot.jpg": shot,
    "styles.json": JSON.stringify({ tokens: cssVars, ...design, note: "Values are computed styles sampled from up to 800 visible elements, most used first: [value, count]." }, null, 2),
    "network.json": JSON.stringify({ note: "Resource Timing entries: what loaded, not failed requests, headers or bodies. Query strings are removed.", byType, requests }, null, 2),
    "assets.json": JSON.stringify({ scripts: design.scripts.map(stripQuery), stylesheets: design.stylesheets.map(stripQuery), images: design.images.map(stripQuery), fonts: design.loadedFonts }, null, 2),
    "meta.json": JSON.stringify({ url, title, capturedAt: new Date().toISOString(), viewport: page.viewportSize(), counts: design.counts, meta: design.meta, fullPage: o.fullPage !== false, clipped: Boolean(clip) }, null, 2),
  };
  if (o.console?.length) files["console.json"] = JSON.stringify(o.console.slice(-80), null, 2);

  const colors = design.colors.background.slice(0, 3).map(([c]) => c).join(", ");
  const font = design.fonts.families[0]?.[0]?.split(",")[0]?.replace(/["']/g, "").trim();
  const summary = `${design.counts.elements} elements, ${requests.length} requests, ${design.scripts.length} scripts, ${design.stylesheets.length} stylesheets${font ? `; main font ${font}` : ""}${colors ? `; backgrounds ${colors}` : ""}.`;
  return { title: title || url, url, summary, files };
}
