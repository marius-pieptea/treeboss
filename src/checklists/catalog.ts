/**
 * The built-in launch checklists, as data. A checklist attaches to a workspace (see store.ts) and its items are
 * tracked there. An item is one of three kinds:
 *
 *  - auto:   a machine checks it (`check` names the check in checks.ts). Runs in "Run checks".
 *  - agent:  needs judgement or a screenshot. A fix session can work on it; a person ticks it when done.
 *  - manual: only a person can confirm it (a store console setting, a legal review).
 *
 * `required` items gate prod deploys: while one is not passing, `trb deploy prod` is refused (see deploy/store.ts).
 * `appliesTo` tags say which recipes and products a checklist suits (see custom.ts defaultChecklistsFor).
 * The operator can override, fork or add checklists (custom.ts); the built-ins here are the shipped defaults.
 */

export type ItemKind = "auto" | "agent" | "manual";
export type Severity = "required" | "recommended";

/** Every auto check. checks.ts implements each one (PROBES is typed over this list, so a missing one is a compile error). Each is static (the repo), http (a running or deployed URL), or both. */
export const CHECK_IDS = [
  "custom-404",
  "meta-title",
  "meta-description",
  "og-image",
  "favicon",
  "robots",
  "sitemap",
  "img-alt",
  "viewport",
  "legal-privacy",
  "legal-terms",
  "cookie-consent",
  "analytics",
  "image-weight",
  "canonical",
  "html-lang",
  "structured-data",
  "perf-budget",
  "broken-links",
  "https-redirect",
  "social-links",
  "h1-unique",
  "health",
  "migrations-in-ci",
  "rate-limit",
  "webhook-signature",
  "error-tracking",
  "input-validation",
  "secrets-not-in-repo",
  "status-contact",
  "cors-policy",
  "openapi",
  "api-versioning",
  "structured-logs",
  "store-metadata",
  "crash-reporting",
  "icon-set",
  "splash",
  "bundle-id",
  "app-version",
  "privacy-manifest",
  "store-screenshots",
  "deep-links",
  "permission-strings",
  "ota-channel",
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
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface ChecklistItem {
  id: string;
  text: string;
  category: string;
  severity: Severity;
  kind: ItemKind;
  check?: CheckId;
  /** What to do when it does not pass. Shown in the panel and handed to the fix agent. */
  hint: string;
  /** A project-only item (lab/checklists/<id>.md, project.ts). Never in the catalog. */
  custom?: boolean;
}

export interface Checklist {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  items: ChecklistItem[];
}

const item = (i: ChecklistItem): ChecklistItem => i;

export const MARKETING_SITE: Checklist = {
  id: "marketing-site",
  title: "Marketing site",
  summary: "Pages that rank, load and convert: metadata, legal pages, consent, and the basics a visitor and a crawler expect.",
  appliesTo: ["marketing", "web"],
  items: [
    item({ id: "custom-404", text: "Custom 404 page", category: "Pages", severity: "required", kind: "auto", check: "custom-404", hint: "Add app/not-found.tsx (or a 404.html) with the site's header, a link home and a search or contact path." }),
    item({ id: "cta-above-fold", text: "Primary call to action above the fold", category: "Conversion", severity: "required", kind: "agent", hint: "On the home page and each landing page, the main action is visible without scrolling, on mobile and desktop. Judge it from a screenshot at 390px and 1440px wide." }),
    item({ id: "sticky-mobile-cta", text: "Sticky call to action on mobile", category: "Conversion", severity: "recommended", kind: "agent", hint: "On a phone, the primary action stays reachable while scrolling a long page (a fixed bottom bar or a sticky header button)." }),
    item({ id: "meta-title", text: "Meta title on every page", category: "SEO", severity: "required", kind: "auto", check: "meta-title", hint: "Export metadata.title (Next.js) or set <title> on each page, unique and under about 60 characters." }),
    item({ id: "meta-description", text: "Meta description on every page", category: "SEO", severity: "required", kind: "auto", check: "meta-description", hint: "Export metadata.description (Next.js) or set <meta name=\"description\"> on each page, 70 to 160 characters." }),
    item({ id: "h1-unique", text: "One H1 per page", category: "SEO", severity: "required", kind: "auto", check: "h1-unique", hint: "Each page has exactly one <h1>. Demote extra headings to h2." }),
    item({ id: "canonical", text: "Canonical URLs", category: "SEO", severity: "recommended", kind: "auto", check: "canonical", hint: "Set alternates.canonical (Next.js) or <link rel=\"canonical\"> on every page so duplicate URLs point to one." }),
    item({ id: "html-lang", text: "html lang attribute", category: "SEO", severity: "required", kind: "auto", check: "html-lang", hint: "Set <html lang=\"en\"> (or the site's language) in the root layout." }),
    item({ id: "og-image", text: "Open Graph image", category: "SEO", severity: "required", kind: "auto", check: "og-image", hint: "Add app/opengraph-image.png (or an openGraph.images entry) at 1200 by 630 so shared links show a picture." }),
    item({ id: "favicon-set", text: "Favicon set, including apple-touch-icon", category: "Design", severity: "required", kind: "auto", check: "favicon", hint: "Add app/favicon.ico (or icon.png) and app/apple-icon.png at 180 by 180." }),
    item({ id: "robots-txt", text: "robots.txt", category: "SEO", severity: "required", kind: "auto", check: "robots", hint: "Add app/robots.ts (generated) or public/robots.txt that allows crawling and names the sitemap." }),
    item({ id: "sitemap-xml", text: "sitemap.xml", category: "SEO", severity: "required", kind: "auto", check: "sitemap", hint: "Add app/sitemap.ts (generated) or public/sitemap.xml listing every public page." }),
    item({ id: "structured-data", text: "Structured data (Organization or Product)", category: "SEO", severity: "recommended", kind: "auto", check: "structured-data", hint: "Add JSON-LD with @type Organization (site) or Product (software page) to the root layout or the page." }),
    item({ id: "img-alt", text: "Alt text on every image", category: "Accessibility", severity: "required", kind: "auto", check: "img-alt", hint: "Give every <img> and next/image an alt attribute. Use alt=\"\" only for purely decorative images." }),
    item({ id: "viewport", text: "Viewport meta and mobile breakpoints", category: "Design", severity: "required", kind: "auto", check: "viewport", hint: "Include <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">. Next.js adds it by default." }),
    item({ id: "loading-states", text: "Loading states", category: "Design", severity: "recommended", kind: "manual", hint: "Every data or form action shows a visible pending state (skeleton, spinner or disabled button). Tick once checked on a slow connection." }),
    item({ id: "form-error-states", text: "Form error states", category: "Conversion", severity: "required", kind: "manual", hint: "Each form shows a clear message per field and a message on failure, and keeps what the visitor typed. Test a bad email and a server error." }),
    item({ id: "thank-you-page", text: "Thank-you page after forms", category: "Conversion", severity: "recommended", kind: "manual", hint: "A successful form submission lands on its own page (for conversion tracking) and says what happens next." }),
    item({ id: "privacy-page", text: "Privacy policy page", category: "Legal", severity: "required", kind: "auto", check: "legal-privacy", hint: "Add a /privacy page and link it in the footer. Store listings and ad networks need it." }),
    item({ id: "terms-page", text: "Terms page", category: "Legal", severity: "required", kind: "auto", check: "legal-terms", hint: "Add a /terms page and link it in the footer." }),
    item({ id: "cookie-consent", text: "Cookie banner or consent, when analytics is present", category: "Legal", severity: "required", kind: "auto", check: "cookie-consent", hint: "Add a consent banner that gates analytics until the visitor agrees. Without analytics this item passes." }),
    item({ id: "analytics", text: "Analytics installed", category: "Analytics", severity: "recommended", kind: "auto", check: "analytics", hint: "Install one analytics tool (Plausible, PostHog, GA4, Vercel Analytics) so traffic and conversions are measured." }),
    item({ id: "real-contact-address", text: "Real contact address", category: "Legal", severity: "required", kind: "manual", hint: "The footer or contact page has a working email and, for a company, a postal address. Send a test message to it." }),
    item({ id: "compressed-images", text: "Compressed images in modern formats", category: "Performance", severity: "recommended", kind: "auto", check: "image-weight", hint: "Convert photos to WebP or AVIF and keep each file under 300 KB (next/image or squoosh). SVG and ICO are exempt." }),
    item({ id: "performance-budget", text: "Performance budget: page weight and render-blocking", category: "Performance", severity: "recommended", kind: "auto", check: "perf-budget", hint: "Keep each page's HTML under 200 KB and at most two render-blocking scripts in <head>. Defer the rest." }),
    item({ id: "no-broken-links", text: "No broken internal links", category: "SEO", severity: "required", kind: "auto", check: "broken-links", hint: "Fix or remove every internal link that returns 4xx or 5xx. Redirect moved pages." }),
    item({ id: "https-redirect", text: "HTTP redirects to HTTPS", category: "Security", severity: "required", kind: "auto", check: "https-redirect", hint: "Serve a 301 from http:// to https:// at the host or the platform." }),
    item({ id: "social-links", text: "Social links", category: "Brand", severity: "recommended", kind: "auto", check: "social-links", hint: "Link the company's profiles (GitHub, X, LinkedIn, YouTube) in the footer." }),
  ],
};

/*
 * The three marketing checklists go with the marketing site (see custom.ts defaultChecklistsFor): they share its "marketing" and
 * "web" tags. They go deeper than marketing-site: lengths, uniqueness, indexing rules and the words on the page.
 */
export const SEO: Checklist = {
  id: "seo",
  title: "SEO",
  summary: "What decides whether pages rank once they are live: metadata of the right length and unique to each page, indexing rules that do not block, and content and links a crawler can read.",
  appliesTo: ["marketing", "web"],
  items: [
    item({ id: "title-length", text: "Titles are 30 to 60 characters", category: "SEO", severity: "recommended", kind: "auto", check: "seo-title-length", hint: "Write each page's title in 30 to 60 characters, with the page's main phrase first and the brand last (\"Invoice software for freelancers | Acme\"). Edit metadata.title in the page or layout, or the <title> in the HTML file. Legal pages need a real title too." }),
    item({ id: "description-length", text: "Descriptions are 70 to 160 characters", category: "SEO", severity: "recommended", kind: "auto", check: "seo-description-length", hint: "Write each page's description in 70 to 160 characters: what the page offers, for whom, and one reason to click. Edit metadata.description or the meta description tag on the page." }),
    item({ id: "unique-meta", text: "No title or description shared by two pages", category: "SEO", severity: "recommended", kind: "auto", check: "seo-unique-meta", hint: "Two pages with the same title or description compete with each other. Give each page its own, built from its H1 and purpose. A template that sets one default for every page is the usual cause." }),
    item({ id: "heading-order", text: "Heading levels do not skip", category: "SEO", severity: "recommended", kind: "auto", check: "seo-heading-order", hint: "After the H1, use H2 for sections and H3 for subsections. Never an H4 straight after an H2. Change the tag, not the size: style headings with CSS." }),
    item({ id: "json-ld", text: "JSON-LD parses and every block has an @type", category: "SEO", severity: "recommended", kind: "auto", check: "seo-json-ld", hint: "Each <script type=\"application/ld+json\"> must hold valid JSON with an @type (Organization, WebSite, Product, Article, FAQPage). Build it with JSON.stringify so quotes are escaped; a hand-written block with a trailing comma is ignored by search engines." }),
    item({ id: "canonical-self", text: "Canonical is absolute and points at the page itself", category: "SEO", severity: "recommended", kind: "auto", check: "seo-canonical-self", hint: "Each page's canonical is its own full URL: https, the production host, the path, no tracking query. A relative canonical, or one that points at the home page, tells search engines to drop the page." }),
    item({ id: "no-noindex", text: "No noindex on production pages", category: "SEO", severity: "required", kind: "auto", check: "seo-no-noindex", hint: "Remove noindex from meta robots, googlebot and the X-Robots-Tag header on pages that should rank. Keep it for preview and staging builds only, and make sure the production build does not set it." }),
    item({ id: "sitemap-coverage", text: "Sitemap lists every page, and every URL in it answers 200", category: "SEO", severity: "recommended", kind: "auto", check: "seo-sitemap-coverage", hint: "Every crawled page must appear in /sitemap.xml, and each sitemap URL must return 200 directly, with no redirect or 404. Generate the sitemap from the same route list the site uses." }),
    item({ id: "robots-rules", text: "robots.txt does not block the site and names the sitemap", category: "SEO", severity: "required", kind: "auto", check: "seo-robots-rules", hint: "Remove any \"Disallow: /\", a leftover from staging that blocks the whole site, and add a Sitemap line with the full sitemap URL. In app/robots.ts disallow only private paths and set sitemap to the production URL." }),
    item({ id: "hreflang", text: "hreflang is valid when the site has more than one language", category: "SEO", severity: "recommended", kind: "auto", check: "seo-hreflang", hint: "Needed only for translated pages. Each version lists every language, itself included, with an absolute URL and a valid code (en, fr-CA, x-default). A single-language site should have no hreflang at all." }),
    item({ id: "anchor-text", text: "Internal links use descriptive text", category: "SEO", severity: "recommended", kind: "auto", check: "seo-anchor-text", hint: "Replace \"click here\", \"here\" and \"read more\" with the name of the destination (\"read the pricing guide\"). Search engines and screen readers both use the link text to understand the target." }),
    item({ id: "twitter-card", text: "Twitter card tags on every page", category: "SEO", severity: "recommended", kind: "auto", check: "seo-twitter-card", hint: "Add twitter:card (summary_large_image) with a title and description. Without a twitter:image the Open Graph image is used. Next.js: set metadata.twitter in the root layout." }),
    item({ id: "indexable-html", text: "Content is in the server HTML, not only in JavaScript", category: "SEO", severity: "recommended", kind: "auto", check: "seo-indexable-html", hint: "Each page's HTML from the server carries at least 300 characters of visible text. A client-only app (an empty <div id=\"root\">) shows crawlers almost nothing. Render the pages on the server or prerender them." }),
    item({ id: "image-dimensions", text: "Images declare width and height, so the page does not jump", category: "Performance", severity: "recommended", kind: "auto", check: "seo-image-dimensions", hint: "Give every <img> a width and a height (its intrinsic size), or use next/image with width and height, or fill inside a box of fixed size. The browser then reserves the space before the image loads." }),
    item({ id: "target-keyword", text: "A target keyword per page, used in the title, H1 and URL", category: "SEO", severity: "recommended", kind: "agent", hint: "For each page (app/**/page.tsx, the .html files, and the URLs the last run crawled), pick one search phrase the page should win. Check that it appears in the title, the H1 and the URL slug, and fix the title and H1 in the file. If a slug would change, report it and leave the live URL alone." }),
    item({ id: "search-console", text: "Google Search Console and Bing Webmaster verified", category: "SEO", severity: "recommended", kind: "manual", hint: "Add the production site as a property in Google Search Console and in Bing Webmaster Tools, verify it (DNS is the most durable method), and submit the sitemap in both. Tick once the sitemap shows as processed." }),
  ],
};

export const CRO: Checklist = {
  id: "cro",
  title: "Conversion",
  summary: "Whether a visitor who lands on a page can act: one clear call to action near the top, reassurance where the decision is made, a short form, and a way to test what changes.",
  appliesTo: ["marketing", "web"],
  items: [
    item({ id: "cta-first-screen", text: "A call to action appears before the first H2", category: "Conversion", severity: "recommended", kind: "auto", check: "cro-cta-first-screen", hint: "The home page and each landing page has a button or link with an action (Get started, Book a demo) above the first H2, so it sits in the first screen on desktop. Move it into the hero. The sticky mobile CTA item covers phones." }),
    item({ id: "cta-one-primary", text: "One primary call to action per page", category: "Conversion", severity: "recommended", kind: "agent", hint: "On each landing page one action is the main one, and it goes to the same place wherever it appears. Other links are visibly quieter (text links or a secondary button). Find the CTAs in the page file (app/**/page.tsx or the .html) and in the served page; merge competing buttons into one." }),
    item({ id: "cta-text", text: "Call-to-action text is specific, not generic", category: "Conversion", severity: "recommended", kind: "auto", check: "cro-cta-text", hint: "Replace \"Submit\", \"Click here\", \"Go\", \"Continue\" and \"Send\" with what happens next (\"Start my free trial\", \"Send me the report\"). Edit the label in the component or page that renders the button." }),
    item({ id: "social-proof", text: "Social proof on landing pages", category: "Trust", severity: "recommended", kind: "auto", check: "cro-social-proof", hint: "Show a testimonial, a customer logo row or a review rating on the home page and each landing page, near the call to action or above the fold. A named customer and company beat an anonymous quote." }),
    item({ id: "risk-reducer", text: "A risk reducer next to the call to action", category: "Trust", severity: "recommended", kind: "auto", check: "cro-risk-reducer", hint: "Put one line beside the main button that lowers the risk: \"Free trial, no credit card\", \"Cancel anytime\" or a guarantee. Keep it within a few lines of the button, and make sure it is true." }),
    item({ id: "form-fields", text: "Forms have five fields or fewer", category: "Conversion", severity: "recommended", kind: "auto", check: "cro-form-fields", hint: "Count the visible fields in each form (hidden and submit fields do not count). The first step needs only what you need to reply: a name, a work email and one question. Ask for the rest later." }),
    item({ id: "pricing-page", text: "A pricing page exists", category: "Conversion", severity: "recommended", kind: "auto", check: "cro-pricing-page", hint: "Add /pricing (app/pricing/page.tsx) with each plan, what it includes and its price, or a clear route for custom plans. Link it from the main navigation." }),
    item({ id: "pricing-highlight", text: "One plan is highlighted on the pricing page", category: "Conversion", severity: "recommended", kind: "agent", hint: "On /pricing, the plan most buyers choose is marked (a \"Most popular\" badge plus a stronger border or button), and the other plans do not compete with it. Check the plan list in the page file and the served page at 390 and 1440 wide." }),
    item({ id: "faq-before-cta", text: "FAQ before the final call to action on the home page", category: "Conversion", severity: "recommended", kind: "auto", check: "cro-faq-before-cta", hint: "Answer the top objections (price, setup time, data, cancellation) in an FAQ, placed before the last call to action on the home page. Use an H2 that says FAQ or Frequently asked questions, and add FAQPage JSON-LD if you can." }),
    item({ id: "landing-nav", text: "Landing pages drop the full navigation", category: "Conversion", severity: "recommended", kind: "agent", hint: "A campaign landing page shows the logo and one action, not the whole menu, so the visitor has one place to go. Find the landing route (the page campaigns link to, for example app/lp/**) and remove the menu from its layout." }),
    item({ id: "conversion-events", text: "Conversion events wired to analytics", category: "Analytics", severity: "recommended", kind: "agent", hint: "Each form submit, checkout start, sign-up and call-to-action click sends one named event to the analytics tool, with the page and the button as properties. Find the handlers in the code, fire the event on success, and confirm one arrives in the analytics debugger." }),
    item({ id: "ab-test-plan", text: "A written experiment plan for the next tests", category: "Analytics", severity: "recommended", kind: "manual", hint: "Write the next two or three tests down (hypothesis, page, metric, minimum sample, how long they run) in the repo docs or the team's tracker. Tick once someone can say which test runs next." }),
  ],
};

export const COPYWRITING: Checklist = {
  id: "copywriting",
  title: "Copywriting",
  summary: "Whether the words sell: a specific headline, copy a busy reader can follow, no filler, a voice that speaks to the reader, and claims that are backed.",
  appliesTo: ["marketing", "web"],
  items: [
    item({ id: "headline-specific", text: "Headline is specific: a number, an outcome or \"you\"", category: "Copy", severity: "recommended", kind: "auto", check: "copy-headline", hint: "The H1 on each landing page names a number (\"3x faster invoices\"), an outcome (\"Get paid in seven days\") or the reader (\"Your books, closed by Friday\"). Rewrite the H1 in the page file. Keep the brand name in the title tag, not the headline." }),
    item({ id: "readability", text: "Sentences average under 20 words, with a Flesch reading ease of 60 or more", category: "Copy", severity: "recommended", kind: "auto", check: "copy-readability", hint: "Split long sentences at \"and\", \"which\" and semicolons, and swap long words for short ones (\"use\" for \"utilize\"). The check reads the visible text of each landing page; aim for a reading ease of 60 or more." }),
    item({ id: "no-hype-words", text: "No hype or filler words in the visible text", category: "Copy", severity: "recommended", kind: "auto", check: "copy-hype", hint: "Remove revolutionary, seamless, cutting-edge, unlock, elevate, leverage, robust, game-changer, empower, delve, world-class and next-generation. Say what the product does in plain words: \"syncs your calendar\" beats \"seamlessly elevates your workflow\"." }),
    item({ id: "you-over-we", text: "\"You\" and \"your\" outnumber \"we\" and \"our\"", category: "Copy", severity: "recommended", kind: "auto", check: "copy-you-we", hint: "Rewrite sentences about the company so the reader is the subject: \"You get a report every Monday\" in place of \"We send a report every Monday\". Edit the copy in the page files." }),
    item({ id: "cta-states-outcome", text: "Every call to action states an outcome", category: "Copy", severity: "recommended", kind: "auto", check: "cro-cta-text", hint: "Each button says what the visitor gets: \"Start my trial\", \"Get the checklist\". Generic labels (Submit, Click here, Go) are rewritten in the component that renders the button." }),
    item({ id: "value-prop-hero", text: "The hero says what it is, who it is for and why it is different", category: "Copy", severity: "recommended", kind: "agent", hint: "Read the hero of the home page: the page file (app/page.tsx or the .html) and the served page at 390 and 1440 wide. Within one screen it should answer three things: what the product is, who it is for, and why it beats the alternative. Rewrite the hero where one of the three is missing." }),
    item({ id: "brand-voice", text: "Copy matches the brand voice", category: "Copy", severity: "recommended", kind: "agent", hint: "Read the copy on the home page and two other pages (page files, or the served URLs from the last run) and compare it with the brand voice notes in the repo (look for a brand, voice or tone doc). Rewrite passages that sound like another company, and list the voice rules you applied." }),
    item({ id: "proof-backs-claims", text: "Every claim has proof next to it", category: "Copy", severity: "recommended", kind: "agent", hint: "Each number, superlative and \"best\" or \"fastest\" claim on the landing pages (page files and served copy) needs a source, a named customer or a measured result. Keep the claims you can back, note the source for each, and soften or remove the rest." }),
    item({ id: "no-placeholder-copy", text: "No lorem ipsum, TODO, placeholder company or example.com in the copy", category: "Copy", severity: "required", kind: "auto", check: "copy-placeholder", hint: "Search the page files and the served text for lorem ipsum, TODO, \"Your company\" and example.com, and replace each with the real text or remove it. A TODO comment in a page file counts too." }),
  ],
};

export const SAAS_APP: Checklist = {
  id: "saas-app",
  title: "SaaS app",
  summary: "Accounts, billing, limits and operations for a product people pay for: auth flows, webhooks, data rights and recovery.",
  appliesTo: ["saas"],
  items: [
    item({ id: "signup-login-logout", text: "Signup, login and logout work", category: "Accounts", severity: "required", kind: "agent", hint: "Walk the flows end to end: sign up, log in, log out, and that a logged-out visit cannot reach app pages." }),
    item({ id: "password-reset", text: "Password reset", category: "Accounts", severity: "required", kind: "agent", hint: "A reset link is emailed, expires, works once, and does not reveal whether the address has an account." }),
    item({ id: "email-verification", text: "Email verification", category: "Accounts", severity: "required", kind: "agent", hint: "New accounts verify their email before paid actions, and the verification link expires." }),
    item({ id: "oauth", text: "OAuth sign-in", category: "Accounts", severity: "recommended", kind: "agent", hint: "At least one OAuth provider is configured with its redirect URLs for each environment." }),
    item({ id: "billing-checkout-portal", text: "Billing: checkout and customer portal", category: "Billing", severity: "required", kind: "agent", hint: "A plan can be bought through checkout, and the customer can change or cancel it in the portal. Test in the provider's test mode." }),
    item({ id: "webhook-signature", text: "Billing webhook verifies its signature", category: "Billing", severity: "required", kind: "auto", check: "webhook-signature", hint: "Verify each webhook with the provider's signature (constructEvent for Stripe) before it changes any data. Reject the rest." }),
    item({ id: "plan-limits-server", text: "Plan limits enforced on the server", category: "Billing", severity: "required", kind: "agent", hint: "Every limit (seats, projects, usage) is checked in the server, not only in the UI. Call the API directly over the limit to confirm." }),
    item({ id: "transactional-email", text: "Transactional email sends and is delivered", category: "Email", severity: "required", kind: "agent", hint: "Verification, reset and receipt emails send from a verified domain with SPF and DKIM set, and not from a shared sender." }),
    item({ id: "error-tracking", text: "Error tracking", category: "Operations", severity: "required", kind: "auto", check: "error-tracking", hint: "Install Sentry (or another tracker) on the server and the client, with the release set from the git SHA." }),
    item({ id: "health-endpoint", text: "Health endpoint", category: "Operations", severity: "required", kind: "auto", check: "health", hint: "Add GET /api/health that returns 200 with a JSON body and checks the database." }),
    item({ id: "db-migrations-ci", text: "Database migrations run in CI", category: "Operations", severity: "required", kind: "auto", check: "migrations-in-ci", hint: "Run migrations in the deploy workflow before the new code starts, and fail the deploy if they fail." }),
    item({ id: "db-backups", text: "Database backups enabled and tested", category: "Operations", severity: "required", kind: "manual", hint: "Automatic backups are on with a retention you chose, and one restore was tested into a scratch database." }),
    item({ id: "rate-limiting", text: "Rate limiting on auth and public endpoints", category: "Security", severity: "required", kind: "auto", check: "rate-limit", hint: "Limit login, signup, reset and any unauthenticated endpoint per IP and per account." }),
    item({ id: "input-validation", text: "Input validation on every endpoint", category: "Security", severity: "required", kind: "auto", check: "input-validation", hint: "Validate request bodies with a schema library (zod, valibot) at the edge of every route." }),
    item({ id: "empty-states", text: "Empty states", category: "Onboarding", severity: "recommended", kind: "agent", hint: "Each list or dashboard with no data says what it will show and offers the first action." }),
    item({ id: "onboarding-first-value", text: "Onboarding gets to first value", category: "Onboarding", severity: "required", kind: "manual", hint: "A new user reaches the core result in one session without a tour. Time it with a fresh account." }),
    item({ id: "account-deletion", text: "Account deletion", category: "Privacy", severity: "required", kind: "agent", hint: "A user can delete the account in the app, and the deletion removes or anonymises personal data, including backups on a set schedule." }),
    item({ id: "data-export", text: "Data export (GDPR)", category: "Privacy", severity: "required", kind: "agent", hint: "A user can download their data as a machine-readable file (JSON or CSV) from the app." }),
    item({ id: "secrets-not-in-repo", text: "No secrets in the repository", category: "Security", severity: "required", kind: "auto", check: "secrets-not-in-repo", hint: "Move every key to the secrets store. .env files must be git-ignored; rotate any key that was committed." }),
    item({ id: "status-contact-page", text: "Status and contact page", category: "Operations", severity: "recommended", kind: "auto", check: "status-contact", hint: "Add /status (or a link to an uptime page) and /contact so customers can reach you when it breaks." }),
  ],
};

export const MOBILE_RELEASE: Checklist = {
  id: "mobile-release",
  title: "Mobile release",
  summary: "What the stores and users check before a build goes out: identity, listing, permissions, crashes, and the update channel.",
  appliesTo: ["mobile"],
  items: [
    item({ id: "icon-set", text: "App icon set", category: "Identity", severity: "required", kind: "auto", check: "icon-set", hint: "Provide a 1024 by 1024 icon without transparency (assets/icon.png), and an adaptive icon for Android." }),
    item({ id: "splash", text: "Splash screen", category: "Identity", severity: "recommended", kind: "auto", check: "splash", hint: "Provide a splash image (assets/splash.png) and set its background color in app config." }),
    item({ id: "bundle-id", text: "Bundle identifier and package name", category: "Identity", severity: "required", kind: "auto", check: "bundle-id", hint: "Set ios.bundleIdentifier and android.package in app config to the reverse-DNS id you own." }),
    item({ id: "version-bump", text: "Version and build number bumped", category: "Identity", severity: "required", kind: "auto", check: "app-version", hint: "Bump expo.version (semver) for the release. The build number is set per build." }),
    item({ id: "privacy-manifest", text: "Privacy manifest (iOS) and data safety form (Android)", category: "Privacy", severity: "required", kind: "auto", check: "privacy-manifest", hint: "Declare the data you collect in ios.privacyManifests (or PrivacyInfo.xcprivacy), and fill the Play data safety form." }),
    item({ id: "store-screenshots", text: "Store screenshots for every required size", category: "Listing", severity: "required", kind: "auto", check: "store-screenshots", hint: "Add PNG or JPEG screenshots under store/screenshots. The check reads their sizes from the image headers: at least one must be an App Store iPhone size (either orientation) and two must fit Google Play (each side 320 to 3840 px, the long side at most twice the short one). It does not check iPad sizes: confirm those yourself if the app supports iPad." }),
    item({ id: "store-metadata", text: "Store metadata within the limits", category: "Listing", severity: "required", kind: "auto", check: "store-metadata", hint: "Fill store/metadata.json: name and subtitle within 30 characters, keywords within 100, and an https privacy URL." }),
    item({ id: "crash-reporting", text: "Crash reporting", category: "Operations", severity: "required", kind: "auto", check: "crash-reporting", hint: "Install a crash reporter (Sentry React Native, Crashlytics) and upload source maps or symbols for each build." }),
    item({ id: "deep-links", text: "Deep links", category: "Navigation", severity: "recommended", kind: "auto", check: "deep-links", hint: "Set a URL scheme (app config scheme) and test that a link opens the right screen." }),
    item({ id: "offline-state", text: "Offline state", category: "Resilience", severity: "recommended", kind: "agent", hint: "With the network off, the app shows a clear offline message and recovers when it returns, without losing unsent input." }),
    item({ id: "permission-rationale", text: "Permission rationale strings", category: "Privacy", severity: "required", kind: "auto", check: "permission-strings", hint: "For each permission the app uses (camera, location, photos), set the iOS usage description to a sentence a user understands." }),
    item({ id: "review-notes-demo-account", text: "Review notes and demo account", category: "Listing", severity: "required", kind: "manual", hint: "The store review notes say how to reach every feature, and a demo account with its password is in the review form. Log in with it once." }),
    item({ id: "ota-channel", text: "OTA update channel set", category: "Release", severity: "required", kind: "auto", check: "ota-channel", hint: "Give each EAS build profile a channel (production, preview) so updates reach the right builds." }),
  ],
};

export const API_SERVICE: Checklist = {
  id: "api-service",
  title: "API service",
  summary: "What an API needs before other people depend on it: auth on every route, a contract, limits, logs, and health.",
  appliesTo: ["api"],
  items: [
    item({ id: "auth-every-route", text: "Auth on every route", category: "Security", severity: "required", kind: "agent", hint: "Every route either requires auth or is listed as public on purpose. Call each route without a token to confirm 401." }),
    item({ id: "api-versioning", text: "Versioned routes", category: "Contract", severity: "recommended", kind: "auto", check: "api-versioning", hint: "Put the API under a version prefix (/v1/...) so a breaking change has a place to go." }),
    item({ id: "openapi", text: "OpenAPI document", category: "Contract", severity: "recommended", kind: "auto", check: "openapi", hint: "Publish an OpenAPI document (openapi.json or a generated one) for every route." }),
    item({ id: "rate-limits", text: "Rate limits", category: "Security", severity: "required", kind: "auto", check: "rate-limit", hint: "Limit requests per key or IP and return 429 with a Retry-After header." }),
    item({ id: "structured-logs", text: "Structured logs", category: "Operations", severity: "recommended", kind: "auto", check: "structured-logs", hint: "Log JSON lines with a request id, route, status and duration (pino, winston or a small logger)." }),
    item({ id: "health-readiness", text: "Health and readiness endpoints", category: "Operations", severity: "required", kind: "auto", check: "health", hint: "GET /health returns 200 and GET /ready checks the database and returns 503 while it is not reachable." }),
    item({ id: "cors-policy", text: "CORS policy", category: "Security", severity: "required", kind: "auto", check: "cors-policy", hint: "Set an explicit list of allowed origins. A wildcard is only right for a public, unauthenticated API." }),
    item({ id: "pagination", text: "Pagination on list endpoints", category: "Contract", severity: "required", kind: "agent", hint: "Every list endpoint takes a limit and a cursor (or page) and caps the limit server-side." }),
  ],
};

/** The shipped checklists. The operator edits them through custom.ts (checklists.json): read the effective catalog there, not this list. */
export const BUILTIN_CHECKLISTS: Checklist[] = [MARKETING_SITE, SEO, CRO, COPYWRITING, SAAS_APP, MOBILE_RELEASE, API_SERVICE];
