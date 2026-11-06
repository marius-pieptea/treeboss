/** Launch checklists: the catalog, the static and HTTP checks (with a fake fetch), the item state, and the prod deploy gate. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { BUILTIN_CHECKLISTS, type CheckId } from "../src/checklists/catalog";
import { checklistById, defaultChecklistsFor } from "../src/checklists/custom";
import { auditSite, makeChecker, openRepo, parsePage, readability, staticStacksOf, syllables, visibleText, type FetchFn } from "../src/checklists/checks";
import { detectStack } from "../src/checklists/stack";
import { imageSize } from "../src/checklists/image-size";
import { TEMPLATE_PROBES, TEMPLATE_STACKS } from "../src/checklists/templates";
import { checklistSessionWorkspace, isChecklistAudit } from "../src/lab/tables";
import { checklistToolDefs, executeChecklistTool } from "../src/checklists/tools";
import { attach, detach, launchBlockers, listAttached, recordResult, runAutoChecks, setItem, showAttached, stackOf, startAuditSession, startFixSession } from "../src/checklists/store";
import { answersOf, checklistPass, CHUNK_ITEMS, openItems, parseToken, passChunks } from "../src/checklists/plan";
import { createChecklistFile, fileOf, parseItemLine, patchChecklistFile, readChecklistFile, renderItemLine, type ItemAnswer } from "../src/checklists/files";
import { patchLabFinding } from "../src/checklists/findings";
import { listFindings, parseFinding } from "../src/lab/findings";
import { labTurn, startLab } from "../src/lab/sessions";
import { listSweeps } from "../src/lab/sweeps";
import { db } from "../src/db";
import { buildRunMcpConfig } from "../src/mcp/store";
import { createTarget, getDeploy, runDeploy, setEnvProvider, waitDeploy } from "../src/deploy/store";
import { checklistsRoutes } from "../src/daemon/routes/checklists";
import { makeCtx } from "../src/daemon/http";
import { getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { UserError } from "../src/util";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState } from "./helpers";

const BUN = process.execPath;
const say = (text: string) => [BUN, "-e", `console.log(${JSON.stringify(text)})`];

beforeEach(() => {
  resetState();
  setEnvProvider(null);
});
afterEach(async () => {
  setTurnRunner(null);
  setEnvProvider(null);
  await interruptAll();
});

/** A folder with these files (paths relative to it). */
function tree(files: Record<string, string>): string {
  const dir = makeDir();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const run = (root: string | null, url: string | null, fetch?: FetchFn) => makeChecker({ root, url, fetch });

/** The header bytes of a PNG of this size: signature, then an IHDR chunk. The pixel data is not needed. */
function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** A JPEG with a JFIF segment before its baseline frame header, so the reader has to skip a segment to find the size. */
function jpegBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(2 + 18 + 19 + 2);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  b.writeUInt16BE(height, 25);
  b.writeUInt16BE(width, 27);
  b.set([0xff, 0xd9], b.length - 2);
  return b;
}
/** A folder whose store/screenshots holds these images, next to an Expo app config. */
function shotsTree(shots: Record<string, Buffer | string>): string {
  const dir = tree({ "app.json": JSON.stringify({ expo: { name: "Acme", version: "1.0.0" } }), "package.json": JSON.stringify({ dependencies: { expo: "54" } }) });
  for (const [name, bytes] of Object.entries(shots)) {
    fs.mkdirSync(path.join(dir, "store/screenshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, "store/screenshots", name), bytes);
  }
  return dir;
}

/* -------------------------------------------------------------------------- */
/* The catalog                                                                */
/* -------------------------------------------------------------------------- */

describe("catalog", () => {
  test("the marketing site lists every required item from the brief", () => {
    const ids = checklistById("marketing-site")!.items.map((i) => i.id);
    for (const id of [
      "custom-404",
      "cta-above-fold",
      "meta-title",
      "meta-description",
      "og-image",
      "favicon-set",
      "robots-txt",
      "sitemap-xml",
      "img-alt",
      "viewport",
      "sticky-mobile-cta",
      "loading-states",
      "form-error-states",
      "thank-you-page",
      "privacy-page",
      "terms-page",
      "cookie-consent",
      "analytics",
      "real-contact-address",
      "compressed-images",
      "canonical",
      "html-lang",
      "structured-data",
      "performance-budget",
      "no-broken-links",
      "https-redirect",
      "social-links",
      "h1-unique",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("every item is well formed: auto items name a check, the others do not, and ids are unique per checklist", () => {
    for (const c of BUILTIN_CHECKLISTS) {
      const ids = c.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const i of c.items) {
        expect(i.hint.length).toBeGreaterThan(10);
        if (i.kind === "auto") expect(i.check).toBeDefined();
        else expect(i.check).toBeUndefined();
      }
    }
  });

  test("the CTA and sticky mobile CTA are judged by an agent, not faked", () => {
    const m = checklistById("marketing-site")!.items;
    expect(m.find((i) => i.id === "cta-above-fold")).toMatchObject({ kind: "agent", severity: "required" });
    expect(m.find((i) => i.id === "sticky-mobile-cta")).toMatchObject({ kind: "agent" });
  });

  test("defaultChecklistsFor maps recipes to checklists, and accepts tags", () => {
    const ids = (x: string | string[]) => defaultChecklistsFor(x).map((c) => c.id);
    expect(ids("saas-next")).toEqual(["marketing-site", "seo", "cro", "copywriting", "saas-app"]);
    expect(ids("expo-app")).toEqual(["mobile-release"]);
    expect(ids("vite-react")).toEqual(["marketing-site", "seo", "cro", "copywriting"]);
    expect(ids("nextjs")).toEqual(["marketing-site", "seo", "cro", "copywriting"]);
    expect(ids("hono-api")).toEqual(["api-service"]);
    expect(ids(["api"])).toEqual(["api-service"]);
    expect(ids("no-such-recipe")).toEqual([]);
  });

  test("whatever gets marketing-site also gets seo, cro and copywriting, by tag or by recipe", () => {
    const ids = (x: string | string[]) => defaultChecklistsFor(x).map((c) => c.id);
    for (const x of ["marketing", "web", ["web"], "nextjs", "vite-react", "saas-next"]) {
      const got = ids(x);
      expect(got).toContain("marketing-site");
      expect(got).toContain("seo");
      expect(got).toContain("cro");
      expect(got).toContain("copywriting");
    }
  });

  test("the three marketing checklists have the items and kinds the brief asks for", () => {
    const kinds = (id: string) => {
      const items = checklistById(id)!.items;
      const count = (k: string) => items.filter((i) => i.kind === k).length;
      return { total: items.length, auto: count("auto"), agent: count("agent"), manual: count("manual") };
    };
    expect(kinds("seo")).toEqual({ total: 16, auto: 14, agent: 1, manual: 1 });
    expect(kinds("cro")).toEqual({ total: 12, auto: 7, agent: 4, manual: 1 });
    expect(kinds("copywriting")).toEqual({ total: 9, auto: 6, agent: 3, manual: 0 });
    const checks = BUILTIN_CHECKLISTS.flatMap((c) => c.items.map((i) => i.check)).filter((x): x is CheckId => !!x);
    for (const id of NEW_CHECKS) expect(checks).toContain(id);
    expect(checks).toContain("cro-cta-text");
  });
});

/* -------------------------------------------------------------------------- */
/* Static checks on fixture folders                                           */
/* -------------------------------------------------------------------------- */

const NEXT_GOOD: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", dependencies: { next: "15.0.0", "@vercel/analytics": "1.0.0", zod: "3.0.0" } }),
  "app/layout.tsx": `export const metadata = { title: "Acme", description: "Acme makes tools for teams that ship.", openGraph: { images: ["/og.png"] }, alternates: { canonical: "/" } };
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}<a href="https://github.com/acme">GitHub</a><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: '{"@type": "Organization", "name": "Acme"}' }} /></body></html>;
}`,
  "app/page.tsx": `export default function Page() { return <main><h1>Acme</h1><img src="/hero.webp" alt="The product" /></main>; }`,
  "app/not-found.tsx": "export default function NotFound() { return <h1>Nothing here</h1>; }",
  "app/icon.png": "icon",
  "app/apple-icon.png": "apple",
  "app/robots.ts": "export default function robots() { return { rules: { userAgent: '*' } }; }",
  "app/sitemap.ts": "export default function sitemap() { return []; }",
  "app/privacy/page.tsx": "export const metadata = { title: 'Privacy' }; export default function P() { return <main>Privacy</main>; }",
  "app/terms/page.tsx": "export const metadata = { title: 'Terms' }; export default function T() { return <main>Terms</main>; }",
  "app/api/health/route.ts": "export async function GET() { return Response.json({ ok: true }); }",
  "components/CookieBanner.tsx": "export function CookieBanner() { return <div>We use cookies.</div>; }",
  "public/hero.webp": "webp",
};

describe("static checks", () => {
  test("a complete Next.js marketing folder passes every static check it can judge", async () => {
    const root = tree(NEXT_GOOD);
    const check = run(root, null);
    for (const id of ["custom-404", "meta-title", "meta-description", "og-image", "favicon", "robots", "sitemap", "img-alt", "viewport", "legal-privacy", "legal-terms", "html-lang", "canonical", "structured-data", "analytics", "cookie-consent", "image-weight", "social-links", "health"] as const) {
      const r = await check(id);
      expect({ id, status: r.status, message: r.message }).toMatchObject({ id, status: "pass" });
    }
  });

  test("a bare folder fails the checks that need files, with evidence where there is one", async () => {
    const root = tree({ "package.json": "{}", "app/page.tsx": "export default function P() { return <img src='/a.jpg' />; }", "public/huge.png": "x".repeat(400_000) });
    const check = run(root, null);
    expect((await check("custom-404")).status).toBe("fail");
    expect((await check("robots")).status).toBe("fail");
    expect((await check("sitemap")).status).toBe("fail");
    expect((await check("legal-privacy")).status).toBe("fail");
    expect((await check("meta-title")).status).toBe("fail");
    const alt = await check("img-alt");
    expect(alt.status).toBe("fail");
    expect(alt.evidence).toBe("app/page.tsx:1");
    const weight = await check("image-weight");
    expect(weight.status).toBe("fail");
    expect(weight.evidence).toBe("public/huge.png");
  });

  test("analytics without a consent banner fails, and without analytics the banner is not needed", async () => {
    const withAnalytics = tree({ "package.json": JSON.stringify({ dependencies: { "posthog-js": "1" } }) });
    expect((await run(withAnalytics, null)("cookie-consent")).status).toBe("fail");
    const without = tree({ "package.json": JSON.stringify({ dependencies: { react: "1" } }) });
    expect(await run(without, null)("cookie-consent")).toMatchObject({ status: "pass" });
    expect((await run(without, null)("analytics")).status).toBe("fail");
  });

  test("a leaked live key fails without echoing it, and an unignored .env fails", async () => {
    const leak = "sk_live_" + "abcdefghijklmnop1234";
    const root = tree({ "src/keys.ts": `export const k = "${leak}";\n`, ".gitignore": "node_modules\n" });
    const r = await run(root, null)("secrets-not-in-repo");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("Stripe live key");
    expect(JSON.stringify(r)).not.toContain(leak);
    const env = tree({ ".env": "TOKEN=1\n" });
    expect((await run(env, null)("secrets-not-in-repo")).status).toBe("fail");
    const ignored = tree({ ".env": "TOKEN=1\n", ".gitignore": ".env\n" });
    expect((await run(ignored, null)("secrets-not-in-repo")).status).toBe("pass");
  });

  test("a webhook without a signature check fails; with one it passes", async () => {
    const pkg = JSON.stringify({ dependencies: { stripe: "1" } });
    const bad = tree({ "package.json": pkg, "src/webhooks/stripe.ts": "export async function POST(req) { return new Response(JSON.stringify(await req.json())); }" });
    expect((await run(bad, null)("webhook-signature")).status).toBe("fail");
    const good = tree({ "package.json": pkg, "src/webhooks/stripe.ts": "export async function POST(req) { stripe.webhooks.constructEvent(body, sig, secret); }" });
    expect((await run(good, null)("webhook-signature")).status).toBe("pass");
    expect((await run(tree({ "package.json": "{}" }), null)("webhook-signature")).status).toBe("unknown");
  });

  test("CI migrations, rate limits and CORS are read from the repo", async () => {
    const ci = tree({ ".github/workflows/deploy.yml": "steps:\n  - run: bun run db:migrate\n", "src/api.ts": "app.use(cors());\n", "package.json": JSON.stringify({ dependencies: { "hono-rate-limiter": "1" } }) });
    const c = run(ci, null);
    expect((await c("migrations-in-ci")).status).toBe("pass");
    expect((await c("rate-limit")).status).toBe("pass");
    const cors = await c("cors-policy");
    expect(cors.status).toBe("fail");
    expect(cors.message).toContain("every origin");
  });

  test("the mobile checks read app.json, eas.json and the store listing", async () => {
    const ok = tree({
      "app.json": JSON.stringify({
        expo: {
          name: "Acme",
          version: "1.2.0",
          scheme: "acme",
          icon: "./assets/icon.png",
          splash: { image: "./assets/splash.png" },
          ios: { bundleIdentifier: "com.acme.app", infoPlist: { NSCameraUsageDescription: "Scan a code to add an item." }, privacyManifests: {} },
          android: { package: "com.acme.app" },
        },
      }),
      "assets/icon.png": "i",
      "assets/splash.png": "s",
      "eas.json": JSON.stringify({ build: { production: { channel: "production" } } }),
      "store/metadata.json": JSON.stringify({ name: "Acme", subtitle: "Tools", keywords: "tools,teams", description: "Tools.", privacyUrl: "https://acme.test/privacy" }),
      "package.json": JSON.stringify({ dependencies: { expo: "54", "expo-camera": "1", "@sentry/react-native": "6" } }),
    });
    fs.mkdirSync(path.join(ok, "store/screenshots"), { recursive: true });
    fs.writeFileSync(path.join(ok, "store/screenshots/1.png"), pngBytes(1290, 2796));
    fs.writeFileSync(path.join(ok, "store/screenshots/2.png"), pngBytes(1080, 1920));
    fs.writeFileSync(path.join(ok, "store/screenshots/3.png"), pngBytes(1080, 1920));
    const c = run(ok, null);
    for (const id of ["icon-set", "splash", "bundle-id", "app-version", "privacy-manifest", "store-screenshots", "store-metadata", "crash-reporting", "deep-links", "permission-strings", "ota-channel"] as const) {
      const r = await c(id);
      expect({ id, status: r.status, message: r.message }).toMatchObject({ id, status: "pass" });
    }
    const missing = tree({
      "app.json": JSON.stringify({ expo: { version: "0.0.0", ios: { bundleIdentifier: "com.acme.app", infoPlist: {} } } }),
      "package.json": JSON.stringify({ dependencies: { expo: "54", "expo-camera": "1" } }),
    });
    expect((await run(missing, null)("app-version")).status).toBe("fail");
    const perms = await run(missing, null)("permission-strings");
    expect(perms.status).toBe("fail");
    expect(perms.message).toContain("NSCameraUsageDescription");
    expect((await run(missing, null)("bundle-id")).status).toBe("fail");
  });

  test("the API checks read the routes and dependencies", async () => {
    const api = tree({ "src/app.ts": "app.use('/v1/*', cors({ origin: ['https://a.test'] }));\nconst log = pino();\n", "openapi.json": "{}", "package.json": JSON.stringify({ dependencies: { zod: "3", pino: "9" } }) });
    const c = run(api, null);
    expect((await c("api-versioning")).status).toBe("pass");
    expect((await c("openapi")).status).toBe("pass");
    expect((await c("structured-logs")).status).toBe("pass");
    expect((await c("cors-policy")).status).toBe("pass");
    expect((await c("input-validation")).status).toBe("pass");
  });

  test("a check that needs a URL says so instead of guessing", async () => {
    const r = await run(tree({ "package.json": "{}" }), null)("perf-budget");
    expect(r.status).toBe("unknown");
    expect(r.message).toContain("URL");
    expect((await run(null, null)("robots")).status).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP checks with a fake fetch                                              */
/* -------------------------------------------------------------------------- */

interface Reply {
  status?: number;
  type?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** A fake `fetch`: replies by exact URL, else `fallback(url)`. Records what was asked for. */
function fakeFetch(replies: Record<string, Reply>, fallback: (url: string) => Reply = () => ({ status: 404, type: "text/plain", body: "Not Found" })) {
  const seen: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const r = replies[url] ?? fallback(url);
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html; charset=utf-8", ...(r.headers ?? {}) } });
  }) as unknown as FetchFn;
  return { f, seen };
}

const page = (title: string, body = "", head = "") =>
  `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="A description long enough to read on a results page for this site."><meta property="og:image" content="https://site.test/og.png"><link rel="canonical" href="https://site.test/"><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>${head}</head><body><h1>${title}</h1><img src="/hero.webp" alt="Hero">${body}<a href="https://github.com/acme">GitHub</a><p>We use cookies. Consent is asked first.</p></body></html>`;

const LOST = `<!doctype html><html lang="en"><head><title>Lost in space</title></head><body><h1>Nothing here</h1><p>${"Head back to the home page or search. ".repeat(20)}</p></body></html>`;

function goodSite() {
  return fakeFetch(
    {
      "https://site.test/": { type: "text/html", body: page("Acme tools for teams", '<a href="/about">About</a>') },
      "https://site.test/about": { type: "text/html", body: page("About Acme", '<a href="/">Home</a>') },
      "https://site.test/robots.txt": { type: "text/plain", body: "User-agent: *\nAllow: /\nSitemap: https://site.test/sitemap.xml" },
      "https://site.test/sitemap.xml": { type: "application/xml", body: "<urlset><url><loc>https://site.test/</loc></url></urlset>" },
      "https://site.test/favicon.ico": { type: "image/x-icon", body: "ico" },
      "https://site.test/apple-touch-icon.png": { type: "image/png", body: "apple" },
      "https://site.test/privacy": { type: "text/html", body: page("Privacy") },
      "https://site.test/terms": { type: "text/html", body: page("Terms") },
      "https://site.test/api/health": { type: "application/json", body: '{"ok":true}' },
      "https://site.test/hero.webp": { type: "image/webp", body: "w" },
      "http://site.test/": { status: 301, headers: { location: "https://site.test/" } },
    },
    (url) => (url.includes("__trb_missing_") ? { status: 404, type: "text/html", body: LOST } : { status: 404, type: "text/plain", body: "Not Found" }),
  );
}

describe("HTTP checks", () => {
  test("a served site that is done passes the HTTP checks", async () => {
    const { f } = goodSite();
    const c = run(null, "https://site.test/", f);
    for (const id of ["custom-404", "meta-title", "meta-description", "h1-unique", "canonical", "html-lang", "og-image", "favicon", "robots", "sitemap", "img-alt", "viewport", "legal-privacy", "legal-terms", "cookie-consent", "analytics", "image-weight", "structured-data", "perf-budget", "broken-links", "https-redirect", "social-links", "health"] as const) {
      const r = await c(id);
      expect({ id, status: r.status, message: r.message }).toMatchObject({ id, status: "pass" });
    }
  });

  test("a broken site fails with the page, the link or the probe that shows it", async () => {
    const bad = `<html><head><title>x</title></head><body><h1>A</h1><h1>B</h1><img src="/hero.webp"><a href="/missing">m</a></body></html>`;
    const { f } = fakeFetch(
      {
        "https://bad.test/": { type: "text/html", body: bad },
        "https://bad.test/missing": { status: 404, type: "text/plain", body: "gone" },
        "http://bad.test/": { status: 200, type: "text/html", body: "plain" },
      },
      (url) => (url.includes("__trb_missing_") ? { status: 200, type: "text/html", body: bad } : { status: 404, type: "text/plain", body: "Not Found" }),
    );
    const c = run(null, "https://bad.test/", f);
    expect((await c("meta-description")).status).toBe("fail");
    expect((await c("h1-unique")).message).toContain("2 <h1>");
    expect((await c("html-lang")).status).toBe("fail");
    expect((await c("viewport")).status).toBe("fail");
    expect((await c("img-alt")).status).toBe("fail");
    const broken = await c("broken-links");
    expect(broken.status).toBe("fail");
    expect(broken.message).toContain("/missing");
    const soft = await c("custom-404");
    expect(soft.status).toBe("fail");
    expect(soft.message).toContain("soft 404");
    expect((await c("https-redirect")).status).toBe("fail");
    expect((await c("robots")).status).toBe("fail");
    expect((await c("sitemap")).status).toBe("fail");
    expect((await c("legal-privacy")).status).toBe("fail");
    expect((await c("health")).status).toBe("fail");
  });

  test("the crawl stops at 30 pages, and links beyond it are reported as unknown, not as broken", async () => {
    const links = Array.from({ length: 39 }, (_, i) => `<a href="/p${i + 1}">p${i + 1}</a>`).join("");
    const { f, seen } = fakeFetch({ "https://big.test/": { type: "text/html", body: page("Big", links) } }, (url) => (/\/p\d+$/.test(url) ? { type: "text/html", body: page("Page") } : { status: 404, type: "text/plain", body: "nope" }));
    const audit = await auditSite("https://big.test/", f, 30);
    expect(audit.pages.length).toBe(30);
    expect(audit.truncated).toBe(true);
    expect(seen.filter((u) => /\/p\d+$/.test(u)).length).toBe(29);
    const r = await makeChecker({ root: null, url: "https://big.test/", fetch: f, maxPages: 30 })("broken-links");
    expect(r.status).toBe("unknown");
    expect(r.message).toContain("beyond");
  });

  test("a served page outranks the repo when both answer, and the repo fills in when the URL is down", async () => {
    const root = tree(NEXT_GOOD);
    const { f } = fakeFetch({ "https://site.test/": { type: "text/html", body: page("Acme", "") .replace(/<meta name="description"[^>]*>/, "") } });
    const served = await makeChecker({ root, url: "https://site.test/", fetch: f })("meta-description");
    expect(served.status).toBe("fail");
    expect(served.evidence).toBe("https://site.test/");
    const down = await makeChecker({ root, url: "https://gone.test/", fetch: (() => Promise.reject(new Error("refused"))) as unknown as FetchFn })("meta-description");
    expect(down.status).toBe("pass");
  });

  test("parsePage reads the fields the checks use", () => {
    const p = parsePage(
      "https://x.test/a",
      200,
      "text/html",
      `<html><head><title> Hi   there </title><script src="/a.js"></script><script src="/b.js" defer></script></head><body><h1>x</h1><img src="p.webp"><img src="q.png" alt="q"><a href="/b#frag">b</a><a href="https://other.test/">o</a><a href="mailto:x@y.test">m</a></body></html>`,
    );
    expect(p.title).toBe("Hi there");
    expect(p.h1Count).toBe(1);
    expect(p.imgCount).toBe(2);
    expect(p.imgNoAlt).toBe(1);
    expect(p.renderBlocking).toBe(1);
    expect(p.imgSrcs).toEqual(["https://x.test/p.webp", "https://x.test/q.png"]);
    expect(p.links).toEqual(["https://x.test/b"]);
    expect(p.externalLinks).toEqual(["https://other.test/"]);
  });
});

/* -------------------------------------------------------------------------- */
/* SEO, conversion and copy checks on a served site                           */
/* -------------------------------------------------------------------------- */

const SITE = "https://ok.test";
const HOME_TITLE = "Invoice software for freelancers that get paid faster";
const HOME_DESC = "Send invoices in two clicks, track who has paid, and chase late payments automatically without awkward emails.";
const PRICING_TITLE = "Pricing plans that get freelancers paid faster";
const PRICING_DESC = "Simple monthly plans with unlimited invoices, a free trial and no setup fee. Cancel whenever you like.";
const PRIVACY_TITLE = "Privacy policy for Acme invoice software";
const PRIVACY_DESC = "How Acme collects, uses and protects the data you give us when you send and pay invoices.";
const FILLER =
  "<p>Freelancers spend hours each month chasing payments. Invoice software should do that work for you. Each invoice links to a secure payment page. Reminders go out on the schedule you choose. You see every open balance in one place. Nothing gets lost in an inbox. Clients pay by card or bank transfer. Your books update the moment the money lands.</p>";
const FAQ = "<h2>Frequently asked questions</h2><details><summary>Is there a setup fee?</summary><p>No. You pay only the monthly plan.</p></details>";
const HOME_BODY = `<h1>Get paid 3x faster with invoices you can send in two clicks</h1>
<img src="/hero.webp" alt="Invoice screen" width="800" height="600">
<a href="#start">Start my free trial</a>
<p>Free trial, no credit card. Cancel anytime.</p>
<h2>Trusted by 2,000 freelancers</h2>
<blockquote>You get paid in a week now. Dana, designer.</blockquote>
${FAQ}
<h2>Ready when you are</h2>
<form action="/signup"><input name="email" type="email" placeholder="Work email"><input type="submit" value="Start my free trial"></form>
<a href="/pricing">Pricing</a> <a href="/privacy">Privacy policy</a>
${FILLER}`;
const PRICING_BODY = `<h1>Pricing plans that get freelancers paid faster</h1>
<a href="#start">Start my free trial</a>
<p>Free trial, no credit card. Cancel anytime.</p>
<blockquote>You get paid in a week now. Dana, designer.</blockquote>
<h2>Pro</h2>
${FILLER}`;

/** A marketing page that passes the SEO, conversion and copy checks. `path` sets its canonical. */
function doc(path: string, title: string, desc: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${desc}"><link rel="canonical" href="${SITE}${path}"><meta property="og:image" content="${SITE}/og.png"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script></head><body>${body}</body></html>`;
}
const SITE_PAGES = (): Record<string, string> => ({
  "/": doc("/", HOME_TITLE, HOME_DESC, HOME_BODY),
  "/pricing": doc("/pricing", PRICING_TITLE, PRICING_DESC, PRICING_BODY),
  "/privacy": doc("/privacy", PRIVACY_TITLE, PRIVACY_DESC, `<h1>Privacy policy</h1>${FILLER}`),
});

/** The good site with edits to some pages. Each [from, to] must match, so a stale fixture fails loudly. */
function edited(edits: Record<string, Array<[string, string]>>): Record<string, string> {
  const pages = SITE_PAGES();
  for (const [path, pairs] of Object.entries(edits)) {
    for (const [from, to] of pairs) {
      if (!pages[path]!.includes(from)) throw new Error(`fixture ${path} has no "${from.slice(0, 40)}"`);
      pages[path] = pages[path]!.replace(from, to);
    }
  }
  return pages;
}

/** Serves the pages, and a robots.txt and a sitemap that list them. `extra` replaces any URL's reply. */
function served(pages: Record<string, string>, extra: Record<string, Reply> = {}) {
  const replies: Record<string, Reply> = {
    [`${SITE}/robots.txt`]: { type: "text/plain", body: "User-agent: *\nAllow: /\nSitemap: https://ok.test/sitemap.xml" },
    [`${SITE}/sitemap.xml`]: { type: "application/xml", body: `<urlset>${Object.keys(pages).map((p) => `<url><loc>${SITE}${p}</loc></url>`).join("")}</urlset>` },
    [`${SITE}/favicon.ico`]: { type: "image/x-icon", body: "ico" },
    [`${SITE}/apple-touch-icon.png`]: { type: "image/png", body: "apple" },
    [`${SITE}/hero.webp`]: { type: "image/webp", body: "w" },
  };
  for (const [p, html] of Object.entries(pages)) replies[`${SITE}${p}`] = { type: "text/html", body: html };
  return fakeFetch({ ...replies, ...extra });
}

/** The verdict of one HTTP check on the served site. */
const judge = async (pages: Record<string, string>, id: CheckId, extra: Record<string, Reply> = {}) => makeChecker({ root: null, url: `${SITE}/`, fetch: served(pages, extra).f })(id);

const NEW_CHECKS: CheckId[] = [
  "seo-title-length",
  "seo-description-length",
  "seo-unique-meta",
  "seo-heading-order",
  "seo-json-ld",
  "seo-canonical-self",
  "seo-no-noindex",
  "seo-sitemap-coverage",
  "seo-robots-rules",
  "seo-hreflang",
  "seo-anchor-text",
  "seo-twitter-card",
  "seo-indexable-html",
  "seo-image-dimensions",
  "cro-cta-first-screen",
  "cro-cta-text",
  "cro-social-proof",
  "cro-risk-reducer",
  "cro-form-fields",
  "cro-pricing-page",
  "cro-faq-before-cta",
  "copy-headline",
  "copy-readability",
  "copy-hype",
  "copy-you-we",
  "copy-placeholder",
];

describe("SEO, conversion and copy checks", () => {
  test("a site built to the rules passes every new check", async () => {
    for (const id of NEW_CHECKS) {
      const r = await judge(SITE_PAGES(), id);
      expect({ id, status: r.status, message: r.message }).toMatchObject({ id, status: "pass" });
    }
  });

  test("titles and descriptions must be 30 to 60 and 70 to 160 characters, and unique across pages", async () => {
    const short = edited({ "/": [[`<title>${HOME_TITLE}</title>`, "<title>Home</title>"]] });
    expect(await judge(short, "seo-title-length")).toMatchObject({ status: "fail" });
    expect((await judge(short, "seo-title-length")).message).toContain("title is 4 characters");
    const desc = edited({ "/": [[`content="${HOME_DESC}"`, 'content="Short."']] });
    expect((await judge(desc, "seo-description-length")).message).toContain("description is 6 characters");
    const dup = edited({ "/pricing": [[`<title>${PRICING_TITLE}</title>`, `<title>${HOME_TITLE}</title>`]] });
    const u = await judge(dup, "seo-unique-meta");
    expect(u.status).toBe("fail");
    expect(u.message).toContain("shared by /, /pricing");
  });

  test("the title and description checks read the literal text in the source, and say so when it is generated", async () => {
    const root = tree({ "app/layout.tsx": "export const metadata = { title: 'Acme', description: 'Tools.' };\n", "app/page.tsx": "export default function P() { return null; }\n" });
    const r = await run(root, null)("seo-title-length");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("title");
    expect((await run(tree({ "app/page.tsx": "export const metadata = { title: generated() };\n" }), null)("seo-title-length")).status).toBe("unknown");
    const ok = tree({ "app/layout.tsx": "export const metadata = { title: 'Invoice software for freelancers that get paid faster' };\n" });
    expect((await run(ok, null)("seo-title-length")).status).toBe("pass");
  });

  test("a skipped heading level fails and names the jump", async () => {
    const r = await judge(edited({ "/": [["<h2>Ready when you are</h2>", "<h4>Ready when you are</h4>"]] }), "seo-heading-order");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("<h4> follows <h2>");
  });

  test("JSON-LD must parse and carry an @type; a page with none fails the site", async () => {
    const broken = edited({ "/": [['"name":"Acme"}</script>', '"name":"Acme",}</script>']] });
    expect((await judge(broken, "seo-json-ld")).message).toContain("do not parse");
    const none = SITE_PAGES();
    for (const p of Object.keys(none)) none[p] = none[p]!.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    expect((await judge(none, "seo-json-ld")).message).toContain("No JSON-LD");
    const untyped = edited({ "/": [['{"@context":"https://schema.org","@type":"Organization","name":"Acme"}', '{"name":"Acme"}']] });
    expect((await judge(untyped, "seo-json-ld")).status).toBe("fail");
  });

  test("a canonical must be absolute and point at its own page", async () => {
    expect((await judge(edited({ "/": [[`href="${SITE}/"`, 'href="/"']] }), "seo-canonical-self")).message).toContain("relative");
    expect((await judge(edited({ "/pricing": [[`href="${SITE}/pricing"`, `href="${SITE}/"`]] }), "seo-canonical-self")).message).toContain("points to");
  });

  test("noindex in the meta tag or the X-Robots-Tag header fails the page", async () => {
    const meta = edited({ "/privacy": [["<head>", '<head><meta name="robots" content="noindex,follow">']] });
    expect((await judge(meta, "seo-no-noindex")).status).toBe("fail");
    const header = await judge(SITE_PAGES(), "seo-no-noindex", { [`${SITE}/pricing`]: { type: "text/html", body: SITE_PAGES()["/pricing"], headers: { "x-robots-tag": "noindex" } } });
    expect(header.status).toBe("fail");
    expect(header.evidence).toBe(`${SITE}/pricing`);
  });

  test("every crawled page is in the sitemap, and every sitemap URL answers 200", async () => {
    const pages = SITE_PAGES();
    const missing = await judge(pages, "seo-sitemap-coverage", { [`${SITE}/sitemap.xml`]: { type: "application/xml", body: `<urlset><url><loc>${SITE}/</loc></url><url><loc>${SITE}/privacy</loc></url></urlset>` } });
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("/pricing");
    const gone = await judge(pages, "seo-sitemap-coverage", { [`${SITE}/sitemap.xml`]: { type: "application/xml", body: `<urlset><url><loc>${SITE}/</loc></url><url><loc>${SITE}/pricing</loc></url><url><loc>${SITE}/privacy</loc></url><url><loc>${SITE}/gone</loc></url></urlset>` } });
    expect(gone.message).toContain("/gone (404)");
    expect((await judge(pages, "seo-sitemap-coverage", { [`${SITE}/sitemap.xml`]: { status: 404, type: "text/plain", body: "no" } })).message).toContain("not served");
  });

  test("robots.txt must not block the root and must name the sitemap", async () => {
    const blocks = await judge(SITE_PAGES(), "seo-robots-rules", { [`${SITE}/robots.txt`]: { type: "text/plain", body: "User-agent: *\nDisallow: /\nSitemap: https://ok.test/sitemap.xml" } });
    expect(blocks.status).toBe("fail");
    expect(blocks.message).toContain("blocks the site root");
    const nositemap = await judge(SITE_PAGES(), "seo-robots-rules", { [`${SITE}/robots.txt`]: { type: "text/plain", body: "User-agent: *\nAllow: /" } });
    expect(nositemap.message).toContain("does not name a sitemap");
    const private_ = await judge(SITE_PAGES(), "seo-robots-rules", { [`${SITE}/robots.txt`]: { type: "text/plain", body: "User-agent: *\nDisallow: /admin/\nSitemap: https://ok.test/sitemap.xml" } });
    expect(private_.status).toBe("pass");
  });

  test("hreflang is absent on a single-language site, and when present it must be valid and list the page itself", async () => {
    expect((await judge(SITE_PAGES(), "seo-hreflang")).message).toContain("No hreflang");
    const fr = `<link rel="alternate" hreflang="fr" href="${SITE}/fr">`;
    const en = `<link rel="alternate" hreflang="en" href="${SITE}/"><link rel="alternate" hreflang="x-default" href="${SITE}/">`;
    const bad = await judge(edited({ "/": [["<link rel=\"canonical\"", `<link rel="alternate" hreflang="english" href="${SITE}/"><link rel="canonical"`]] }), "seo-hreflang");
    expect(bad.message).toContain('invalid hreflang "english"');
    const notSelf = await judge(edited({ "/": [["<link rel=\"canonical\"", `${fr}<link rel="canonical"`]] }), "seo-hreflang");
    expect(notSelf.message).toContain("does not list the page itself");
    const good = await judge(edited({ "/": [["<link rel=\"canonical\"", `${en}<link rel="alternate" hreflang="fr" href="${SITE}/fr"><link rel="canonical"`]] }), "seo-hreflang");
    expect(good.status).toBe("pass");
  });

  test("a link that says click here fails; the destination's name passes", async () => {
    const r = await judge(edited({ "/": [['<a href="/privacy">Privacy policy</a>', '<a href="/privacy">click here</a>']] }), "seo-anchor-text");
    expect(r.status).toBe("fail");
    expect(r.message).toContain('"click here"');
  });

  test("the Twitter card, the server text and the image sizes are judged on the served HTML", async () => {
    expect((await judge(edited({ "/pricing": [['<meta name="twitter:card" content="summary_large_image">', ""]] }), "seo-twitter-card")).status).toBe("fail");
    const thin = await judge(edited({ "/privacy": [[FILLER, "<p>Short.</p>"]] }), "seo-indexable-html");
    expect(thin.message).toContain("characters of text");
    const shell = await judge(edited({ "/privacy": [["<h1>Privacy policy</h1>", '<div id="root"></div>'], [FILLER, ""]] }), "seo-indexable-html");
    expect(shell.message).toContain("drawn by JavaScript");
    const img = await judge(edited({ "/": [['width="800" height="600"', ""]] }), "seo-image-dimensions");
    expect(img.status).toBe("fail");
    expect(img.message).toContain("without width and height");
  });

  test("the first call to action sits above the first H2; a generic button fails", async () => {
    const below = await judge(edited({ "/": [['<a href="#start">Start my free trial</a>', ""]] }), "cro-cta-first-screen");
    expect(below.status).toBe("fail");
    expect(below.message).toContain("below the first H2");
    const generic = await judge(edited({ "/": [['value="Start my free trial"', 'value="Submit"']] }), "cro-cta-text");
    expect(generic.message).toContain('"Submit"');
  });

  test("social proof and a risk reducer beside the call to action are required on landing pages", async () => {
    const none = edited({
      "/": [
        ["<h2>Trusted by 2,000 freelancers</h2>", "<h2>Ready to start</h2>"],
        ["<blockquote>You get paid in a week now. Dana, designer.</blockquote>", "<p>Simple plans.</p>"],
      ],
    });
    expect((await judge(none, "cro-social-proof")).status).toBe("fail");
    const noRisk = edited({ "/": [["<p>Free trial, no credit card. Cancel anytime.</p>", "<p>Simple plans.</p>"]] });
    expect((await judge(noRisk, "cro-risk-reducer")).status).toBe("fail");
  });

  test("a form with more than five fields fails", async () => {
    const big = edited({ "/": [['<input type="submit"', '<input name="a"><input name="b"><input name="c"><input name="d"><input name="e"><input type="submit"']] });
    const r = await judge(big, "cro-form-fields");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("a form has 6 fields");
  });

  test("a pricing page is needed; with none the check fails with the reason", async () => {
    const pages = edited({ "/": [['<a href="/pricing">Pricing</a>', ""]] });
    delete pages["/pricing"];
    expect((await judge(pages, "cro-pricing-page")).status).toBe("fail");
    expect((await judge(SITE_PAGES(), "cro-pricing-page")).status).toBe("pass");
  });

  test("the FAQ must exist on the home page and come before its last call to action", async () => {
    const none = edited({ "/": [["<h2>Frequently asked questions</h2><details>", "<h2>Questions</h2><div>"], ["</details>", "</div>"]] });
    expect((await judge(none, "cro-faq-before-cta")).message).toContain("no FAQ");
    const late = edited({ "/": [[FAQ, ""], [FILLER, `${FILLER}${FAQ}`]] });
    expect((await judge(late, "cro-faq-before-cta")).message).toContain("after the last call to action");
  });

  test("the headline, the reading level, the hype and the you-to-we ratio are judged on the visible copy", async () => {
    const dull = await judge(edited({ "/": [["<h1>Get paid 3x faster with invoices you can send in two clicks</h1>", "<h1>Our story and mission</h1>"]] }), "copy-headline");
    expect(dull.message).toContain("no number, outcome or you");
    const long = "Freelancers who send invoices from one place and track every payment across every client and every project without ever opening a spreadsheet or chasing anybody by email can spend more time on the work they actually love.";
    const hard = await judge(edited({ "/pricing": [[PRICING_BODY, `<h1>Pricing plans that get freelancers paid faster</h1><a href="#start">Start my free trial</a><p>${long}</p><p>${long}</p>`]] }), "copy-readability");
    expect(hard.status).toBe("fail");
    expect(hard.message).toContain("sentences average");
    const hype = await judge(edited({ "/": [[FILLER, `${FILLER}<p>Our revolutionary, seamless platform is robust.</p>`]] }), "copy-hype");
    expect(hype.message).toContain("revolutionary");
    const we = await judge(edited({ "/pricing": [[FILLER, "<p>We built this for us. Our team ships weekly. We are proud of our work.</p>"]] }), "copy-you-we");
    expect(we.status).toBe("fail");
    expect(we.evidence).toBe(`${SITE}/pricing`);
  });

  test("placeholder copy fails: lorem ipsum, TODO, example.com", async () => {
    const r = await judge(edited({ "/privacy": [[FILLER, `${FILLER}<p>Lorem ipsum dolor sit amet.</p>`]] }), "copy-placeholder");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("Lorem ipsum");
    expect((await judge(edited({ "/": [[HOME_TITLE, "TODO"]] }), "copy-placeholder")).message).toContain("TODO");
  });

  test("the static probes read the repo: robots, noindex, image sizes, placeholder copy and the pricing page", async () => {
    const bad = tree({
      "app/robots.ts": "export default () => ({ rules: { userAgent: '*', disallow: '/' } });\n",
      "app/page.tsx": "export default function P() { return <img src='/a.png' />; }\n",
      "app/privacy/page.tsx": "export const metadata = { robots: { index: false } }; // TODO\nexport default function P() { return null; }\n",
    });
    const robots = await run(bad, null)("seo-robots-rules");
    expect(robots.status).toBe("fail");
    expect(robots.message).toContain("blocks the site root");
    expect(robots.message).toContain("does not name a sitemap");
    expect((await run(bad, null)("seo-image-dimensions")).evidence).toBe("app/page.tsx:1");
    expect((await run(bad, null)("seo-no-noindex")).status).toBe("fail");
    expect((await run(bad, null)("copy-placeholder")).message).toContain("app/privacy/page.tsx");
    expect((await run(bad, null)("cro-pricing-page")).status).toBe("fail");
    const good = tree({
      "app/robots.ts": "export default () => ({ rules: { userAgent: '*', allow: '/' }, sitemap: 'https://ok.test/sitemap.xml' });\n",
      "app/page.tsx": "export default function P() { return <img src='/a.png' width={800} height={600} alt='' />; }\n",
      "app/pricing/page.tsx": "export default function P() { return null; }\n",
    });
    for (const id of ["seo-robots-rules", "seo-image-dimensions", "seo-no-noindex", "copy-placeholder", "cro-pricing-page", "seo-hreflang"] as const) {
      expect({ id, status: (await run(good, null)(id)).status }).toMatchObject({ id, status: "pass" });
    }
  });

  test("the HTTP parse reads the fields the new checks use", () => {
    const html = `<html lang="en"><head><title>Pricing plans that get paid faster</title><link rel="alternate" hreflang="fr" href="/fr"><meta name="twitter:card" content="summary"></head><body>
      <h1>Get paid 3x faster</h1><h3>Skipped</h3><a href="/x">here</a><a href="https://other.test/">here</a>
      <a href="/start" class="btn">Get started</a><button>Submit</button><input type="submit" value="Send"><img src="a.png" alt="a">
      <form><input name="e"><select name="s"></select><input type="hidden" name="h"></form>
      <script type="application/ld+json">{"@type":"Thing"}</script><script type="application/ld+json">{nope</script>
      <details><summary>FAQ</summary></details><blockquote>Great.</blockquote></body></html>`;
    const p = parsePage(`${SITE}/`, 200, "text/html", html, "noindex");
    expect(p.h1Text).toBe("Get paid 3x faster");
    expect(p.headings).toEqual([1, 3]);
    expect(p.h2At).toBe(null);
    expect(p.noindex).toBe(true);
    expect(p.twitterCard).toBe("summary");
    expect(p.hreflangs).toEqual([{ lang: "fr", href: "/fr" }]);
    expect(p.genericAnchors).toEqual(["here"]);
    expect(p.actions.filter((a) => a.kind === "link").map((a) => a.label)).toEqual(["here", "here", "Get started"]);
    expect(p.actions.map((a) => a.label)).toContain("Submit");
    expect(p.actions.map((a) => a.label)).toContain("Send");
    expect(p.formFields).toEqual([2]);
    expect(p.jsonLdBlocks).toBe(2);
    expect(p.jsonLdBroken).toBe(1);
    expect(p.imgNoDims).toBe(1);
    expect(p.faqAt).not.toBe(null);
    expect(p.socialProof).toBe(true);
    expect(p.text).toContain("Get paid 3x faster");
    expect(p.text).not.toContain("<");
  });

  test("the readability estimate: short plain sentences score high, a dense one scores low", () => {
    const easy = readability("The cat sat on the mat. The dog ran to the park.");
    expect(easy.avgSentence).toBe(6);
    expect(easy.flesch).toBeGreaterThan(90);
    const dense = readability("Notwithstanding considerable organizational interdependencies, institutional stakeholders consistently underestimate multidimensional implementation complexities.");
    expect(dense.flesch).toBeLessThan(30);
    expect(readability("").words).toBe(0);
  });

  test("the syllable heuristic counts vowel groups, the silent e and -ed", () => {
    expect(syllables("the")).toBe(1);
    expect(syllables("make")).toBe(1);
    expect(syllables("table")).toBe(2);
    expect(syllables("education")).toBe(4);
    expect(syllables("reading")).toBe(2);
    expect(syllables("walked")).toBe(1);
  });

  test("visible text drops scripts, styles and the head, and ends a sentence at each block", () => {
    const t = visibleText("<head><title>T</title></head><style>p{}</style><script>var x = 1;</script><nav><a>Home</a></nav><p>Hello there.</p>");
    expect(t).not.toContain("var x");
    expect(t).not.toContain("p{}");
    expect(t).not.toContain("T ");
    expect(t).toBe("Home. Hello there.");
  });
});

/* -------------------------------------------------------------------------- */
/* State, the checks run, and the fix prompt                                  */
/* -------------------------------------------------------------------------- */

const bareWorkspace = (files: Record<string, string> = { "package.json": JSON.stringify({ name: "acme" }) + "\n" }) => {
  const dir = makeRepo(files);
  return { dir, id: Workspaces.open(dir).id };
};

describe("state", () => {
  test("attach and detach", () => {
    const { id } = bareWorkspace();
    const a = attach(id, "marketing-site");
    expect(a.items.length).toBe(BUILTIN_CHECKLISTS.find((c) => c.id === "marketing-site")!.items.length);
    expect(a.progress.passing).toBe(0);
    expect(a.progress.requiredPassing).toBe(0);
    expect(attach(id, "marketing-site").id).toBe("marketing-site");
    expect(listAttached(id).map((c) => c.id)).toEqual(["marketing-site"]);
    expect(detach(id, "marketing-site")).toBe(true);
    expect(detach(id, "marketing-site")).toBe(false);
    expect(listAttached(id)).toEqual([]);
    expect(() => attach(id, "no-such")).toThrow(UserError);
    expect(() => showAttached(id, "saas-app")).toThrow(/not attached/);
  });

  test("ticks, unticks and notes are stored per item, and a note alone does not change the status", () => {
    const { id } = bareWorkspace();
    attach(id, "marketing-site");
    const t = setItem(id, "marketing-site", "loading-states", { checked: true, note: "Checked on 3G" });
    expect(t).toMatchObject({ status: "pass", source: "manual", note: "Checked on 3G" });
    expect(setItem(id, "marketing-site", "loading-states", { checked: false }).status).toBe("unknown");
    const n = setItem(id, "marketing-site", "loading-states", { note: "Waiting on design" });
    expect(n).toMatchObject({ status: "unknown", source: "manual", note: "Waiting on design" });
    expect(() => setItem(id, "marketing-site", "no-such-item", { checked: true })).toThrow(/no item/);
    expect(() => setItem(id, "saas-app", "oauth", { checked: true })).toThrow(/not attached/);
  });

  test("the checks store their answers, and a manual tick is left alone by the next run", async () => {
    const dir = makeRepo({ "package.json": "{}\n", "app/page.tsx": "export default function P() { return null; }\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    setItem(id, "marketing-site", "custom-404", { checked: true, note: "Served by the CDN" });
    const r = await runAutoChecks(id);
    expect(r.skipped).toBe(1);
    expect(r.results.find((x) => x.itemId === "custom-404")).toBeUndefined();
    const meta = r.results.find((x) => x.itemId === "meta-title")!;
    expect(meta.status).toBe("fail");
    expect(meta.check).toBe("meta-title");
    const after = showAttached(id, "marketing-site");
    expect(after.items.find((i) => i.id === "custom-404")).toMatchObject({ status: "pass", source: "manual" });
    expect(after.items.find((i) => i.id === "meta-title")).toMatchObject({ status: "fail", source: "auto" });
    expect(after.items.find((i) => i.id === "cta-above-fold")!.status).toBe("unknown");
  });

  test("a run with a URL measures the served site, and rejects a bad URL", async () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const { f } = goodSite();
    const r = await runAutoChecks(id, { url: "https://site.test/", fetch: f });
    expect(r.results.find((x) => x.itemId === "meta-title")!.status).toBe("pass");
    expect(r.results.find((x) => x.itemId === "https-redirect")!.status).toBe("pass");
    await expect(runAutoChecks(id, { url: "not a url" })).rejects.toThrow(/not a URL/);
    await expect(runAutoChecks(id, { url: "ftp://x.test" })).rejects.toThrow(/http or https/);
  });

  test("launch blockers are the required items that do not pass, and detaching clears them", () => {
    const { id } = bareWorkspace();
    attach(id, "marketing-site");
    const blockers = launchBlockers(id);
    expect(blockers.some((b) => b.itemId === "cta-above-fold")).toBe(true);
    expect(blockers.every((b) => b.status !== "pass")).toBe(true);
    expect(blockers.some((b) => b.itemId === "sticky-mobile-cta")).toBe(false);
    detach(id, "marketing-site");
    expect(launchBlockers(id)).toEqual([]);
  });

  test("a fix pass takes the failing and unknown items; manual items are left for a person", async () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ dependencies: { next: "15" } }) });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    await runAutoChecks(id);
    const c = checklistById("marketing-site")!;
    const answers = answersOf(dir, "marketing-site");
    const fixIds = openItems(c, answers, true).map((i) => i.id);
    expect(fixIds).toContain("custom-404");
    expect(fixIds).toContain("cta-above-fold");
    expect(fixIds).not.toContain("loading-states");
    expect(openItems(c, answers, false).map((i) => i.id)).not.toContain("loading-states");
    const prompts = passChunks(dir, ["marketing-site"], true).map((t) => checklistPass(dir, t, { fix: true }).prompt).join("\n");
    expect(prompts).toContain("(custom-404)");
    expect(prompts).toContain("How to fix:");
    expect(prompts.split("Left for a person")[0]).not.toContain("(loading-states)");
    expect(prompts).toContain("(loading-states)");
  });

  test("the pass prompt hands the SEO and copy judgement items to the agent with their hints", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "seo");
    attach(id, "copywriting");
    const seo = passChunks(dir, ["seo"], true).map((t) => checklistPass(dir, t, { fix: true }).prompt).join("\n");
    expect(seo).toContain("(target-keyword)");
    expect(seo).toContain("How to fix: For each page");
    const copy = passChunks(dir, ["copywriting"], true).map((t) => checklistPass(dir, t, { fix: true }).prompt).join("\n");
    expect(copy).toContain("How to fix: Read the hero of the home page");
    expect(seo).toContain("Left for a person");
    expect(seo).toContain("(search-console)");
    expect(seo.split("Left for a person")[0]).not.toContain("(search-console)");
  });

  test("startFixSession opens a session in the workspace; a checklist with nothing to fix is refused", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "api-service");
    setTurnRunner(async () => ({ success: true, output: "done", sessionId: null, resumeRejected: false, aborted: false, timedOut: false }) as any);
    const sid = startFixSession(id, "api-service");
    expect(getSession(sid)?.title).toBe("Checklist fix: API service");
    expect(() => startFixSession(id, "marketing-site")).toThrow(/not attached/);
  });
});

/* -------------------------------------------------------------------------- */
/* The prod deploy gate                                                       */
/* -------------------------------------------------------------------------- */

describe("deploy gate", () => {
  test("a prod deploy is refused while required items fail, and force goes through", async () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ name: "acme", version: "1.0.0" }) + "\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const prod = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: say("ok") } });
    let refused: unknown = null;
    try {
      runDeploy(prod.id);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(UserError);
    expect((refused as Error).message).toContain("Prod deploy refused");
    expect((refused as Error).message).toContain("Custom 404 page");
    const forced = runDeploy(prod.id, { force: true });
    await waitDeploy(forced.id);
    expect(getDeploy(forced.id)!.status).toBe("succeeded");
  });

  test("other environments are not gated, and a detached checklist no longer gates prod", async () => {
    const dir = makeRepo({ "package.json": JSON.stringify({ name: "acme", version: "1.0.0" }) + "\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const dev = createTarget({ workspaceId: id, env: "dev", provider: "command", config: { argv: say("ok") } });
    const d = runDeploy(dev.id);
    await waitDeploy(d.id);
    expect(getDeploy(d.id)!.status).toBe("succeeded");
    detach(id, "marketing-site");
    const prod = createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: say("ok") } });
    const p = runDeploy(prod.id);
    await waitDeploy(p.id);
    expect(getDeploy(p.id)!.status).toBe("succeeded");
  });
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

describe("routes", () => {
  test("catalog, attach, item tick and detach over HTTP", async () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    const u = (p: string) => new URL(`http://localhost${p}`);
    const call = async (method: string, p: string, body: Record<string, unknown> = {}) => {
      const res = await checklistsRoutes(makeCtx(new Request(u(p), { method }), u(p), body));
      return res!;
    };
    expect((await call("GET", "/api/checklists")).status).toBe(200);
    const att = await call("POST", `/api/workspaces/${id}/checklists`, { checklistId: "api-service" });
    expect(att.status).toBe(201);
    const tick = await call("PATCH", `/api/workspaces/${id}/checklists/api-service/items/pagination`, { checked: true });
    expect((await tick.json()).item.status).toBe("pass");
    await expect(call("PATCH", `/api/workspaces/${id}/checklists/api-service/items/pagination`, { checked: "yes" })).rejects.toThrow(/checked must be/);
    expect((await call("DELETE", `/api/workspaces/${id}/checklists/api-service`)).status).toBe(200);
    await expect(call("GET", "/api/workspaces/w_missing/checklists")).rejects.toThrow(/No workspace/);
  });

  test("the stack is read over HTTP, and an audit starts a session with 201 and fails loudly for a checklist not attached", async () => {
    stubTurns();
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    const u = (p: string) => new URL(`http://localhost${p}`);
    const call = async (method: string, p: string, body: Record<string, unknown> = {}) => (await checklistsRoutes(makeCtx(new Request(u(p), { method }), u(p), body)))!;
    const stack = await (await call("GET", `/api/workspaces/${id}/checklists/stack`)).json();
    expect(stack.stack).toBe("php-slim-twig");
    expect(stack.evidence).toContain("composer.json requires slim/slim ^4.12");
    await expect(call("POST", `/api/workspaces/${id}/checklists/audit`, { checklistId: "marketing-site" })).rejects.toThrow(/not attached/);
    await call("POST", `/api/workspaces/${id}/checklists`, { checklistId: "marketing-site" });
    const audit = await call("POST", `/api/workspaces/${id}/checklists/audit`, { checklistId: "marketing-site", fix: true });
    expect(audit.status).toBe(201);
    const { sessionId } = await audit.json();
    expect(getSession(sessionId)?.title).toBe("Checklist fix: Marketing site");
    await expect(call("POST", `/api/workspaces/${id}/checklists/audit`, { fix: "yes" })).rejects.toThrow(/fix must be/);
  });
});

/* -------------------------------------------------------------------------- */
/* Stack detection, gating, the agent answers and the audit                   */
/* -------------------------------------------------------------------------- */

const NEXT_SITE = {
  "package.json": JSON.stringify({ dependencies: { next: "15", react: "19" } }),
  "app/layout.tsx": "export const metadata = { title: 'Invoice software for freelancers that get paid faster', description: 'Invoices, reminders and payouts for freelancers.' };\nexport default function L({ children }) { return <html lang='en'>{children}</html>; }\n",
  "app/page.tsx": "export default function P() { return <h1>Invoices in one place</h1>; }\n",
};
const SLIM_TWIG = {
  "composer.json": JSON.stringify({ require: { php: "^8.2", "slim/slim": "^4.12", "slim/psr7": "^1.6", "twig/twig": "^3.8" } }),
  "public/index.php": "<?php\n$app->get('/', fn ($req, $res) => $res);\n",
  "templates/base.twig": "<!doctype html><html><head><title>{% block title %}{% endblock %}</title></head><body>{% block content %}{% endblock %}</body></html>\n",
  "templates/home.twig": "{% extends 'base.twig' %}{% block content %}<h1>Invoices in one place</h1>{% endblock %}\n",
};

/** Audit sessions are real leads: their first turn is stubbed so no engine runs. */
const stubTurns = () => setTurnRunner(async () => ({ success: true, output: "done", sessionId: null, resumeRejected: false, aborted: false, timedOut: false }) as any);

describe("stack detection", () => {
  test("Next.js is found from its dependency or its App Router pages, with the evidence", () => {
    const s = detectStack(openRepo(tree(NEXT_SITE)));
    expect(s.stack).toBe("nextjs");
    expect(s.evidence.join("\n")).toContain("package.json depends on next");
    expect(detectStack(openRepo(tree({ "app/page.tsx": "export default () => null;\n" }))).stack).toBe("nextjs");
  });

  test("Slim with Twig is php-slim-twig, reads .twig templates, and cites composer.json", () => {
    const s = detectStack(openRepo(tree(SLIM_TWIG)));
    expect(s.stack).toBe("php-slim-twig");
    expect(s.templateExts).toEqual([".twig"]);
    expect(s.evidence).toContain("composer.json requires slim/slim ^4.12");
  });

  test("Laravel is found from artisan and laravel/framework; its templates are Blade", () => {
    const s = detectStack(openRepo(tree({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }), artisan: "#!/usr/bin/env php\n", "resources/views/welcome.blade.php": "<h1>Hi</h1>\n" })));
    expect(s.stack).toBe("laravel");
    expect(s.templateExts).toEqual([".blade.php"]);
  });

  test("Rails is found from the Gemfile and reads .erb views", () => {
    const s = detectStack(openRepo(tree({ Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n", "config/application.rb": "require 'rails'\n", "app/views/layouts/application.html.erb": "<html><%= yield %></html>\n" })));
    expect(s.stack).toBe("rails");
    expect(s.templateExts).toEqual([".erb"]);
    expect(s.evidence).toContain("Gemfile declares the rails gem");
  });

  test("plain HTML, Django, Flask, Expo and a plain Node service each have their own stack", () => {
    expect(detectStack(openRepo(tree({ "index.html": "<!doctype html><html lang='en'><title>Acme</title></html>\n" }))).stack).toBe("plain-static-html");
    expect(detectStack(openRepo(tree({ "manage.py": "import django\n", "requirements.txt": "Django==5.0\n" }))).stack).toBe("django");
    expect(detectStack(openRepo(tree({ "requirements.txt": "flask==3.0\n", "app.py": "from flask import Flask\n" }))).stack).toBe("flask");
    expect(detectStack(openRepo(tree({ "package.json": JSON.stringify({ dependencies: { expo: "54" } }) }))).stack).toBe("expo");
    expect(detectStack(openRepo(tree({ "package.json": JSON.stringify({ dependencies: { express: "5" } }) }))).stack).toBe("node");
  });

  test("a folder with nothing recognisable is unknown, with the reason", () => {
    const s = detectStack(openRepo(tree({ "notes.txt": "hello\n" })));
    expect(s.stack).toBe("unknown");
    expect(s.templateExts).toEqual([]);
    expect(s.evidence.length).toBeGreaterThan(0);
  });
});

describe("gating by stack", () => {
  test("a Next-only static check returns unknown, with the stack named, on a Twig fixture", async () => {
    const root = tree(SLIM_TWIG);
    for (const id of ["custom-404", "image-weight", "favicon"] as const) {
      const r = await run(root, null)(id);
      expect({ id, status: r.status, evidence: r.evidence, message: r.message }).toEqual({ id, status: "unknown", evidence: null, message: "Not checkable statically for php-slim-twig: left to the agent audit" });
    }
  });

  test("the same check still runs on a stack it understands", async () => {
    expect((await run(tree(NEXT_SITE), null)("meta-title")).message).not.toContain("Not checkable");
  });

  test("a stack-agnostic check runs everywhere; a mobile check is not run on a Twig site", async () => {
    expect((await run(tree(SLIM_TWIG), null)("secrets-not-in-repo")).status).toBe("pass");
    expect((await run(tree(SLIM_TWIG), null)("icon-set")).message).toContain("Not checkable statically for php-slim-twig");
  });

  test("every catalog check with a static probe declares at least one stack; a crawl-only check declares none", () => {
    for (const c of BUILTIN_CHECKLISTS) {
      for (const it of c.items) {
        if (!it.check) continue;
        const stacks = staticStacksOf(it.check);
        if (stacks !== null) expect(stacks.length).toBeGreaterThan(0);
      }
    }
    expect(staticStacksOf("broken-links")).toBeNull();
  });

  test("an agent's answer on an item the checks cannot judge survives the next run", async () => {
    stubTurns();
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    await runAutoChecks(id);
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "custom-404")!.status).toBe("unknown");
    const sid = startAuditSession(id, "marketing-site", { fix: false });
    expect(executeChecklistTool("checklist_record", { checklist: "marketing-site", item: "custom-404", status: "pass", evidence: "templates/base.twig:1" }, sid).text).toMatch(/^Recorded/);
    await runAutoChecks(id);
    const kept = showAttached(id, "marketing-site").items.find((i) => i.id === "custom-404")!;
    expect({ status: kept.status, source: kept.source }).toEqual({ status: "pass", source: "agent" });
  });
});

describe("checklist_record", () => {
  /** A workspace with the marketing site attached, and an audit session for it. */
  function auditOf(files: Record<string, string> = SLIM_TWIG) {
    stubTurns();
    const dir = makeRepo(files);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const sid = startAuditSession(id, "marketing-site", { fix: false });
    return { id, sid, dir };
  }
  const record = (sid: string, args: Record<string, unknown>) => executeChecklistTool("checklist_record", args, sid).text;

  test("the tool is offered by name, with the three statuses", () => {
    const [def] = checklistToolDefs();
    expect(def!.name).toBe("checklist_record");
    expect((def!.inputSchema as any).properties.status.enum).toEqual(["pass", "fail", "na"]);
  });

  test("it writes the answer with its source and reason, and the item reads back as an agent answer", () => {
    const { id, sid } = auditOf();
    expect(record(sid, { checklist: "marketing-site", item: "cta-above-fold", status: "na", note: "The site has no call to action: it is a static listing." })).toBe("Recorded marketing-site/cta-above-fold: na.");
    const item = showAttached(id, "marketing-site").items.find((i) => i.id === "cta-above-fold")!;
    expect({ status: item.status, source: item.source, reason: item.reason }).toEqual({ status: "na", source: "agent", reason: "The site has no call to action: it is a static listing." });
    expect(record(sid, { checklist: "marketing-site", item: "h1-unique", status: "fail", note: "Two h1 elements in templates/home.twig.", evidence: "templates/home.twig:1" })).toMatch(/^Recorded/);
  });

  test("it rejects an unknown checklist, an unknown item, and a checklist that is not attached", () => {
    const { sid } = auditOf();
    expect(record(sid, { checklist: "nope", item: "meta-title", status: "pass", evidence: "templates/base.twig:1" })).toMatch(/^Error: No checklist "nope"/);
    expect(record(sid, { checklist: "marketing-site", item: "not-an-item", status: "pass", evidence: "templates/base.twig:1" })).toMatch(/^Error: marketing-site has no item "not-an-item"/);
    expect(record(sid, { checklist: "seo", item: "title-length", status: "fail", note: "x" })).toMatch(/^Error: seo is not attached/);
  });

  test("it refuses a session that is not an audit, and a status it does not know", () => {
    const { sid } = auditOf();
    expect(record("s_not_an_audit", { checklist: "marketing-site", item: "meta-title", status: "pass", evidence: "templates/base.twig:1" })).toBe("Error: checklist_record is for checklist audit sessions only.");
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "maybe", evidence: "templates/base.twig:1" })).toMatch(/^Error: status must be/);
  });

  test("it refuses a manual item, a na with no reason, a pass with no evidence, and evidence the project does not have", () => {
    const { sid } = auditOf();
    expect(record(sid, { checklist: "marketing-site", item: "loading-states", status: "pass", evidence: "templates/base.twig:1" })).toMatch(/manual item/);
    expect(record(sid, { checklist: "marketing-site", item: "cta-above-fold", status: "na" })).toMatch(/na needs a reason/);
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "pass" })).toMatch(/pass needs evidence/);
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "pass", evidence: "app/page.tsx:3" })).toMatch(/is not a file in this project/);
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "pass", evidence: "templates/base.twig:999" })).toMatch(/has \d+ lines/);
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "pass", evidence: "../outside.txt" })).toMatch(/outside the project/);
  });

  test("a manual tick pins the item: the agent is refused until the tick is removed", () => {
    const { id, sid } = auditOf();
    setItem(id, "marketing-site", "meta-title", { checked: true });
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "fail", note: "x" })).toMatch(/decided by hand/);
    setItem(id, "marketing-site", "meta-title", { checked: null });
    expect(record(sid, { checklist: "marketing-site", item: "meta-title", status: "fail", note: "x" })).toMatch(/^Recorded/);
  });
});

describe("launch blockers with agent answers", () => {
  test("na settles a required item; unknown and fail still block", () => {
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const blocks = (itemId: string) => launchBlockers(id).some((b) => b.itemId === itemId);
    expect(blocks("cta-above-fold")).toBe(true);
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "na", note: "No landing page: the site is a single listing." });
    expect(blocks("cta-above-fold")).toBe(false);
    expect(blocks("meta-title")).toBe(true);
    recordResult(id, { checklistId: "marketing-site", itemId: "meta-title", status: "fail", note: "No <title> on the page.", evidence: "templates/base.twig:1" });
    expect(launchBlockers(id).find((b) => b.itemId === "meta-title")?.status).toBe("fail");
  });

  test("the progress counts not-applicable and unverified items", () => {
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "na", note: "Not a landing page." });
    const p = showAttached(id, "marketing-site").progress;
    expect(p.requiredNotApplicable).toBe(1);
    expect(p.unverified).toBeGreaterThan(0);
  });
});

describe("the audit prompt and session", () => {
  test("names the stack and its evidence, lists every item not passing, and tells the agent how to record", async () => {
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    await runAutoChecks(id);
    const p = passChunks(dir, ["marketing-site"], false).map((t) => checklistPass(dir, t).prompt).join("\n");
    expect(p).toContain("Detected stack: php-slim-twig (templates: .twig).");
    expect(p).toContain("composer.json requires slim/slim");
    expect(p).toContain("Routes are registered on the Slim app");
    expect(p).toContain("Read the code and templates; do not change any file.");
    expect(p).toContain("(meta-description)");
    expect(p).not.toContain("(meta-title)");
    expect(p).toContain("(cta-above-fold)");
    expect(p).toContain("Left for a person");
    expect(p).toContain("(loading-states)");
    expect(p).toContain("call checklist_record");
    expect(p).toContain("Use na only when the item does not apply");
    expect(p).toContain("Never guess");
    expect(p).not.toContain("Change the code until each one passes");
  });

  test("with fix, the failing items are changed until they pass, and the stack is named", async () => {
    const dir = makeRepo(NEXT_SITE);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    await runAutoChecks(id);
    const p = passChunks(dir, ["marketing-site"], true).map((t) => checklistPass(dir, t, { fix: true }).prompt).join("\n");
    expect(p).toContain("Detected stack: nextjs");
    expect(p).toContain("Change the code until each item passes");
    expect(p).toContain("(custom-404)");
  });

  test("an audit with no checklist attached is refused; one attached starts a session on the stack", () => {
    stubTurns();
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    expect(() => startAuditSession(id)).toThrow(/No checklist is attached/);
    attach(id, "marketing-site");
    const sid = startAuditSession(id, "marketing-site");
    expect(sid).toBeTruthy();
    expect(stackOf(id).stack).toBe("php-slim-twig");
  });

  test("the audit session is titled for its checklist and registered, so only it can record", () => {
    stubTurns();
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const sid = startAuditSession(id, "marketing-site", { fix: true });
    expect(getSession(sid)?.title).toBe("Checklist fix: Marketing site");
    expect(isChecklistAudit(sid)).toBe(true);
    expect(isChecklistAudit("s_plain_chat")).toBe(false);
  });

  test("the run config gives an audit session the checklist tool without treeboss mode", () => {
    const audit = buildRunMcpConfig({ sessionId: "s_audit", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t", checklists: true, treeboss: false });
    expect((audit.trb as { env?: unknown } | undefined)?.env).toMatchObject({ TRB_CHECKLISTS: "1", TRB_TREEBOSS: "0", TRB_SESSION: "s_audit" });
    const plain = buildRunMcpConfig({ sessionId: "s_chat", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t" });
    expect(plain.trb).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Storage: the checklist file, the import, findings and Lab passes           */
/* -------------------------------------------------------------------------- */

describe("the checklist file", () => {
  test("an item line round-trips, brackets and all, and a line that is not an item is not one", () => {
    const answer: ItemAnswer = { status: "na", source: "agent", evidence: "app/(site)/page.tsx:12", message: null, reason: "Single page (no metadata)", note: null };
    const line = renderItemLine("Meta title {x}", "meta-title", answer);
    expect(line).toBe("- [x] Meta title {x} {#meta-title} (status: na) (source: agent) (evidence: app/(site)/page.tsx:12) (reason: Single page (no metadata))");
    expect(parseItemLine(line)).toEqual({ id: "meta-title", text: "Meta title {x}", answer });
    expect(parseItemLine("## SEO")).toBeNull();
    expect(parseItemLine("- [ ] Odd {#odd} (status: maybe)")).toMatchObject({ answer: { status: "unknown", source: null } });
  });

  test("a new file has every item under its category, unanswered, and reads back with the attach time", () => {
    const dir = makeDir();
    const c = checklistById("seo")!;
    createChecklistFile(dir, c, "2026-10-28T09:00:00.000Z");
    const text = fs.readFileSync(fileOf(dir, "seo"), "utf8");
    expect(text.startsWith("---\nid: seo\ntitle: ")).toBe(true);
    for (const cat of new Set(c.items.map((i) => i.category))) expect(text).toContain(`\n## ${cat}\n`);
    const f = readChecklistFile(dir, "seo")!;
    expect(f.attachedAt).toBe("2026-10-28T09:00:00.000Z");
    expect(f.lastRun).toBeNull();
    expect(f.answers.size).toBe(c.items.length);
    expect([...f.answers.values()].every((a) => a.status === "unknown" && a.source === null)).toBe(true);
    expect(createChecklistFile(dir, c, "2026-10-29T00:00:00.000Z")).toBe(false); // a file that is there is kept
  });

  test("an edit changes only the lines it owns: a person's note and their own paragraph stay byte for byte", () => {
    const dir = makeDir();
    const c = checklistById("seo")!;
    createChecklistFile(dir, c, "2026-10-28T09:00:00.000Z");
    const [first, second] = c.items;
    let text = fs.readFileSync(fileOf(dir, "seo"), "utf8").replace(`{#${first!.id}} (status: unknown)`, `{#${first!.id}} (status: unknown) (note: check with Ana)`);
    text += "\nA paragraph the checklist does not own.\n";
    fs.writeFileSync(fileOf(dir, "seo"), text);
    const before = text.split("\n");
    patchChecklistFile(dir, c, new Map([[second!.id, { status: "pass", source: "auto", evidence: "app/layout.tsx:3", message: null, reason: null, note: null }]]), "2026-10-28T10:00:00.000Z");
    const after = fs.readFileSync(fileOf(dir, "seo"), "utf8").split("\n");
    expect(after.length).toBe(before.length);
    expect(after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null).length).toBe(2); // the item and last_run
    expect(after).toContain("A paragraph the checklist does not own.");
    expect(after.join("\n")).toContain("(note: check with Ana)");
    const f = readChecklistFile(dir, "seo")!;
    expect(f.answers.get(second!.id)).toMatchObject({ status: "pass", source: "auto", evidence: "app/layout.tsx:3" });
    expect(f.lastRun).toBe("2026-10-28T10:00:00.000Z");
  });

  test("an item whose line a person removed comes back under its category", () => {
    const dir = makeDir();
    const c = checklistById("seo")!;
    createChecklistFile(dir, c, "2026-10-28T09:00:00.000Z");
    const target = c.items[2]!;
    const text = fs.readFileSync(fileOf(dir, "seo"), "utf8").split("\n").filter((l) => !l.includes(`{#${target.id}}`)).join("\n");
    fs.writeFileSync(fileOf(dir, "seo"), text);
    expect(readChecklistFile(dir, "seo")!.answers.has(target.id)).toBe(false);
    patchChecklistFile(dir, c, new Map([[target.id, { status: "fail", source: "agent", evidence: null, message: null, reason: "Missing.", note: null }]]));
    const lines = fs.readFileSync(fileOf(dir, "seo"), "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes(`{#${target.id}}`));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(0, at).reverse().find((l) => l.startsWith("## "))).toBe(`## ${target.category}`);
  });
});

describe("the import from the SQLite tables", () => {
  test("the first read exports attachments and item state to files; the tables stay, and a detached checklist is not brought back", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    db().exec(`CREATE TABLE IF NOT EXISTS workspace_checklists (workspace_id TEXT NOT NULL, checklist_id TEXT NOT NULL, attached_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (workspace_id, checklist_id))`);
    db().exec(`CREATE TABLE IF NOT EXISTS checklist_items (workspace_id TEXT NOT NULL, checklist_id TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL, source TEXT, evidence TEXT, message TEXT, note TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, reason TEXT, PRIMARY KEY (workspace_id, checklist_id, item_id))`);
    db().prepare("INSERT INTO workspace_checklists (workspace_id, checklist_id, attached_at) VALUES (?, 'seo', '2026-10-01 09:00:00')").run(id);
    const ins = db().prepare("INSERT INTO checklist_items (workspace_id, checklist_id, item_id, status, source, evidence, note, reason, updated_at) VALUES (?, 'seo', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
    ins.run(id, "title-length", "pass", "auto", "app/layout.tsx:3", null, null);
    ins.run(id, "canonical-self", "na", "agent", "app/page.tsx:1", "Operator note", "No canonical: a single page");
    ins.run(id, "description-length", "unknown", "manual", null, "Waiting on copy", null);
    expect(fs.existsSync(fileOf(dir, "seo"))).toBe(false);

    const view = showAttached(id, "seo");
    expect(view.attachedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(view.items.find((i) => i.id === "title-length")).toMatchObject({ status: "pass", source: "auto", evidence: "app/layout.tsx:3" });
    // The reason and the operator's note stay apart in the file.
    expect(view.items.find((i) => i.id === "canonical-self")).toMatchObject({ status: "na", source: "agent", reason: "No canonical: a single page", note: "Operator note" });
    expect(view.items.find((i) => i.id === "description-length")).toMatchObject({ status: "unknown", source: "manual", note: "Waiting on copy" });
    expect((db().prepare("SELECT COUNT(*) AS n FROM checklist_items WHERE workspace_id = ?").get(id) as { n: number }).n).toBe(3);

    detach(id, "seo");
    expect(listAttached(id).map((c) => c.id)).not.toContain("seo");
  });
});

describe("failing checklist items as Lab findings", () => {
  const SLIM = () => makeRepo(SLIM_TWIG);

  test("a fail opens one finding per item, a repeat fail refreshes it, and a pass ships it", () => {
    const dir = SLIM();
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const key = "marketing-site/meta-title";
    recordResult(id, { checklistId: "marketing-site", itemId: "meta-title", status: "fail", note: "No <title> on the page." });
    recordResult(id, { checklistId: "marketing-site", itemId: "meta-title", status: "fail", note: "Still missing.", evidence: "templates/base.twig:1" });
    const mine = listFindings(dir).filter((f) => f.checklist === key);
    expect(mine.length).toBe(1);
    expect(mine[0]).toMatchObject({ lens: "checklist", impact: "high", status: "new", evidence: ["templates/base.twig:1"] });
    expect(mine[0]!.body).toContain("First step:");
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "meta-title")!.finding).toBe(mine[0]!.id);
    recordResult(id, { checklistId: "marketing-site", itemId: "meta-title", status: "pass", evidence: "templates/base.twig:1" });
    const after = listFindings(dir).filter((f) => f.checklist === key);
    expect(after.map((f) => f.status)).toEqual(["shipped"]);
  });

  test("a check that fails opens its finding, and a finding dismissed in Lab marks the item n/a until it is reopened", () => {
    const dir = SLIM();
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "fail", note: "No sticky bar on the listing." });
    const f = listFindings(dir).find((x) => x.checklist === "marketing-site/sticky-mobile-cta")!;
    expect(f.impact).toBe("medium");
    patchLabFinding(dir, f.id, { status: "dismissed" });
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "sticky-mobile-cta")).toMatchObject({ status: "na", source: "manual", note: "dismissed in Lab" });
    // a dismissed item is a decision: the next audit is refused it, and a run does not turn it back
    expect(() => recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "fail", note: "x" })).toThrow(/decided by hand/);
    patchLabFinding(dir, f.id, { status: "new" });
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "sticky-mobile-cta")).toMatchObject({ status: "unknown", source: null });
    expect(listFindings(dir).find((x) => x.id === f.id)!.status).toBe("new");
  });

  test("a required item cannot be dismissed: the refusal says why, and nothing changes", () => {
    const dir = SLIM();
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "meta-title", status: "fail", note: "No <title> on the page." });
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "meta-title")!.status).toBe("fail");
    expect(checklistById("marketing-site")!.items.find((i) => i.id === "meta-title")!.severity).toBe("required");
    const f = listFindings(dir).find((x) => x.checklist === "marketing-site/meta-title")!;
    expect(f.impact).toBe("high");
    expect(() => patchLabFinding(dir, f.id, { status: "dismissed" })).toThrow(/required launch item, so it cannot be dismissed/);
    expect(listFindings(dir).find((x) => x.id === f.id)!.status).toBe("new");
    expect(showAttached(id, "marketing-site").items.find((i) => i.id === "meta-title")!.status).toBe("fail");
    expect(launchBlockers(id).some((b) => b.itemId === "meta-title")).toBe(true);
  });

  test("a finding is parsed with its checklist key, and a Lab finding without one has none", () => {
    const f = parseFinding("lab/findings/x.md", "---\ntitle: T\nlens: checklist\nchecklist: seo/title-length\n---\nbody\n");
    expect(f).toMatchObject({ lens: "checklist", checklist: "seo/title-length" });
    expect(parseFinding("lab/findings/y.md", "---\ntitle: T\n---\n").checklist).toBeNull();
  });
});

describe("the deploy gate reads the files", () => {
  test("an edit to the checklist file changes what blocks a prod deploy", () => {
    const { id, dir } = bareWorkspace();
    attach(id, "marketing-site");
    expect(launchBlockers(id).some((b) => b.itemId === "cta-above-fold")).toBe(true);
    const file = fileOf(dir, "marketing-site");
    const text = fs.readFileSync(file, "utf8").replace("{#cta-above-fold} (status: unknown)", "{#cta-above-fold} (status: na) (source: manual) (note: a single listing page)");
    fs.writeFileSync(file, text);
    expect(launchBlockers(id).some((b) => b.itemId === "cta-above-fold")).toBe(false);
    expect(launchBlockers(id).length).toBeGreaterThan(0);
  });
});

describe("the audit as a Lab sweep", () => {
  test("the open items are split into sessions of at most ten, every open item in exactly one", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    const ids = ["marketing-site", "seo", "cro", "copywriting"];
    for (const c of ids) attach(id, c);
    const tokens = passChunks(dir, ids, false);
    const taken = tokens.flatMap((t) => parseToken(t).items.map((i) => `${parseToken(t).checklist.id}/${i.id}`));
    const open = ids.flatMap((c) => openItems(checklistById(c)!, answersOf(dir, c), false).map((i) => `${c}/${i.id}`));
    expect(taken.length).toBe(open.length);
    expect(new Set(taken)).toEqual(new Set(open));
    expect(tokens.every((t) => parseToken(t).items.length <= CHUNK_ITEMS)).toBe(true);
    expect(tokens.length).toBeGreaterThan(ids.length);
  });

  test("a fix takes only the failing and unknown items, and a token that is not a chunk is refused", () => {
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "pass", evidence: "templates/base.twig:1" });
    const fixIds = passChunks(dir, ["marketing-site"], true).flatMap((t) => parseToken(t).items.map((i) => i.id));
    expect(fixIds).not.toContain("cta-above-fold");
    expect(fixIds).toContain("meta-title");
    expect(fixIds).not.toContain("loading-states");
    expect(() => parseToken("checklist:marketing-site:not-an-item")).toThrow(/names an item/);
    expect(() => labTurn(dir, "checklist", "project")).toThrow(/Checklist passes start from the Checklists panel/);
  });

  test("starting an audit records a sweep of one session per chunk, registered to the workspace", () => {
    stubTurns();
    const dir = makeRepo(SLIM_TWIG);
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    const chunks = passChunks(dir, ["marketing-site"], false).length;
    const sid = startAuditSession(id, "marketing-site");
    const sweep = listSweeps(dir)[0]!;
    expect(sweep).toMatchObject({ lens: "checklist", total: chunks });
    expect(isChecklistAudit(sid)).toBe(true);
    expect(checklistSessionWorkspace(sid)).toBe(id);
  });
});

describe("store screenshot sizes", () => {
  test("imageSize reads PNG and JPEG headers, and refuses anything else", () => {
    expect(imageSize(pngBytes(1290, 2796))).toEqual({ format: "png", width: 1290, height: 2796 });
    expect(imageSize(jpegBytes(1242, 2688))).toEqual({ format: "jpeg", width: 1242, height: 2688 });
    expect(imageSize(Buffer.from("not an image at all, just text"))).toBeNull();
    expect(imageSize(pngBytes(10, 10).subarray(0, 20))).toBeNull();
    expect(imageSize(jpegBytes(10, 10).subarray(0, 24))).toBeNull();
  });

  test("an App Store iPhone size in either orientation, plus two Play-sized shots, passes with the file as evidence", async () => {
    const r = await run(shotsTree({ "1.png": pngBytes(1290, 2796), "2.jpg": jpegBytes(1920, 1080), "3.png": pngBytes(1080, 1920) }), null)("store-screenshots");
    expect(r.status).toBe("pass");
    expect(r.evidence).toBe("store/screenshots/1.png");
    expect(r.message).toContain("read from the image headers");
    const landscape = await run(shotsTree({ "a.png": pngBytes(2796, 1290), "b.png": pngBytes(1080, 1920), "c.png": pngBytes(1080, 1920) }), null)("store-screenshots");
    expect(landscape.status).toBe("pass");
  });

  test("screenshots that fit Play but are no iPhone size fail, naming the sizes to use", async () => {
    const r = await run(shotsTree({ "1.png": pngBytes(1080, 1920), "2.png": pngBytes(1080, 1920) }), null)("store-screenshots");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("1290x2796");
    expect(r.message).toContain("1.png (1080x1920)");
    expect(r.evidence).toBe("store/screenshots/1.png");
  });

  test("iPhone-sized screenshots alone fail Play: too long to be a Play phone screenshot, and fewer than two fit", async () => {
    const r = await run(shotsTree({ "1.png": pngBytes(1290, 2796), "tall.png": pngBytes(300, 4000), "small.png": pngBytes(200, 200) }), null)("store-screenshots");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("Google Play needs 2");
    expect(r.message).toContain("0 fit");
  });

  test("a file that is no image, or no screenshot at all, fails", async () => {
    const bad = await run(shotsTree({ "1.png": "p" }), null)("store-screenshots");
    expect(bad.status).toBe("fail");
    expect(bad.message).toContain("no readable PNG or JPEG header");
    expect((await run(shotsTree({}), null)("store-screenshots")).message).toBe("No screenshots under store/screenshots.");
  });
});

describe("template stacks (Twig, Blade, ERB)", () => {
  const LARAVEL = { "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }), artisan: "#!/usr/bin/env php\n" };
  const RAILS = { Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n", "config/application.rb": "module Acme; end\n" };
  const SYMFONY = { "composer.json": JSON.stringify({ require: { "symfony/framework-bundle": "^7.0" } }) };
  const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const layout = (title: string, desc: string, html = '<html lang="en">', extra = "", viewport = VIEWPORT) => `<!doctype html>\n${html}<head>\n${title}\n${desc}\n${viewport}\n${extra}</head><body>\nCONTENT</body></html>\n`;

  const GOOD: Record<string, Record<string, string>> = {
    twig: { ...SYMFONY, "templates/base.html.twig": layout("<title>{% block title %}Acme invoices{% endblock %}</title>", `<meta name="description" content="{{ description|default('Invoices for freelancers.') }}">`), "templates/home.html.twig": "{% extends 'base.html.twig' %}{% block body %}<h1>Hi</h1>{% endblock %}\n" },
    blade: { ...LARAVEL, "resources/views/layouts/app.blade.php": layout("<title>@yield('title', 'Acme invoices')</title>", '<meta name="description" content="{{ $page->summary }}">', `<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">`), "resources/views/welcome.blade.php": "@extends('layouts.app')\n@section('content')<h1>Hi</h1>@endsection\n" },
    erb: { ...RAILS, "app/views/layouts/application.html.erb": layout("<title><%= content_for(:title) || 'Acme invoices' %></title>", '<meta name="description" content="<%= @page.summary %>">'), "app/views/home/index.html.erb": "<h1>Hi</h1>\n" },
  };
  const BAD: Record<string, Record<string, string>> = {
    twig: { ...SYMFONY, "templates/base.html.twig": layout("<title></title>", "", "<html>", "", "") },
    blade: { ...LARAVEL, "resources/views/layouts/app.blade.php": layout("", "", "<html>", "", "") },
    erb: { ...RAILS, "app/views/layouts/application.html.erb": layout("", "", "<html>", "", "") },
  };

  test.each(["twig", "blade", "erb"])("%s: a layout with a title, description, lang and viewport passes the head checks", async (kind) => {
    const root = tree(GOOD[kind]!);
    for (const id of ["meta-title", "meta-description", "html-lang", "viewport"] as const) {
      const r = await run(root, null)(id);
      expect({ id, status: r.status, message: r.message }).toMatchObject({ id, status: "pass" });
      expect(r.evidence).toMatch(/\.(twig|blade\.php|erb)$/);
    }
  });

  test.each(["twig", "blade", "erb"])("%s: a layout with none of them fails each head check, naming the file", async (kind) => {
    const root = tree(BAD[kind]!);
    for (const id of ["meta-title", "meta-description", "html-lang", "viewport"] as const) {
      const r = await run(root, null)(id);
      expect({ id, status: r.status }).toEqual({ id, status: "fail" });
      expect(r.evidence).toMatch(/layout|base|application/);
    }
  });

  test("a description set only in a page template is unknown, not a fail", async () => {
    const root = tree({
      ...LARAVEL,
      "resources/views/layouts/app.blade.php": layout("<title>Acme</title>", ""),
      "resources/views/page.blade.php": `@section('head')<meta content="{{ $page->summary }}" name="description">@endsection\n`,
    });
    expect((await run(root, null)("meta-description")).status).toBe("unknown");
    expect((await run(root, null)("meta-title")).status).toBe("pass");
  });

  test("a stack with no template reads unknown", async () => {
    const root = tree({ ...LARAVEL, "routes/web.php": "<?php\n" });
    expect((await run(root, null)("meta-title")).status).toBe("unknown");
  });

  test("img-alt reads an <img> whose expression holds >, and a Rails image_tag", async () => {
    const ok = tree({ ...LARAVEL, "resources/views/a.blade.php": '<img src="{{ $u->avatar }}" alt="Avatar">\n<img src="/x.png" alt="">\n' });
    expect((await run(ok, null)("img-alt")).status).toBe("pass");
    const bad = tree({ ...LARAVEL, "resources/views/a.blade.php": '<p>x</p>\n<img src="{{ $u->avatar }}">\n' });
    const r = await run(bad, null)("img-alt");
    expect(r.status).toBe("fail");
    expect(r.evidence).toBe("resources/views/a.blade.php:2");
    const erb = tree({ ...RAILS, "app/views/a.html.erb": '<%= image_tag "a.png", alt: "A" %>\n<%= image_tag "b.png" %>\n' });
    const re = await run(erb, null)("img-alt");
    expect(re.status).toBe("fail");
    expect(re.evidence).toBe("app/views/a.html.erb:2");
  });

  test("canonical, og:image, JSON-LD, social links and robots are read from the templates and public/", async () => {
    const extra = '<link rel="canonical" href="{{ url }}">\n<meta property="og:image" content="{{ asset(\'og.png\') }}">\n<script type="application/ld+json">{"@type": "Organization", "name": "Acme"}</script>\n';
    const root = tree({
      ...SYMFONY,
      "templates/base.html.twig": layout("<title>Acme</title>", "", '<html lang="en">', extra) + '<a href="https://github.com/acme">GitHub</a>\n',
      "public/robots.txt": "User-agent: *\n",
    });
    for (const id of ["canonical", "og-image", "structured-data", "social-links", "robots"] as const) {
      const r = await run(root, null)(id);
      expect({ id, status: r.status }).toEqual({ id, status: "pass" });
    }
    const bare = tree({ ...SYMFONY, "templates/base.html.twig": layout("<title>Acme</title>", "") });
    for (const id of ["canonical", "og-image", "structured-data", "social-links", "robots"] as const) expect({ id, status: (await run(bare, null)(id)).status }).toEqual({ id, status: "fail" });
  });

  test("every template probe sits on a check with a static probe, and staticStacksOf lists the template stacks", () => {
    for (const id of Object.keys(TEMPLATE_PROBES) as CheckId[]) {
      const stacks = staticStacksOf(id)!;
      expect(stacks).not.toBeNull();
      for (const s of TEMPLATE_STACKS) expect(stacks).toContain(s);
    }
  });
});
