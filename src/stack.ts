/**
 * The stack of a project, read from its files and manifests: which framework renders the pages, and which template
 * files hold the markup. The static checks (checks.ts) run only on the stacks they understand; the agent audit reads
 * the rest (the Lab passes read it too: every prompt names the stack, see lab/sessions.ts).
 *
 * Detection never runs anything. The first rule that matches wins, so the order goes from the JS meta-frameworks, to
 * the server frameworks, to the static site generators, to plain HTML. A rule that matches returns the evidence that
 * decided it: one line per file or dependency.
 */
import type { Repo } from "./checklists/checks";

export const STACKS = [
  "nextjs",
  "nuxt",
  "astro",
  "sveltekit",
  "remix",
  "vite-spa",
  "plain-static-html",
  "hugo",
  "jekyll",
  "eleventy",
  "php-slim-twig",
  "laravel",
  "symfony",
  "wordpress",
  "rails",
  "django",
  "flask",
  "expo",
  "node",
  "unknown",
] as const;
export type Stack = (typeof STACKS)[number];

export interface StackDetection {
  stack: Stack;
  /** The extensions of the template files the markup lives in, such as ".twig". Empty when the stack has none. */
  templateExts: string[];
  /** Why this stack: one line per file, manifest or dependency that decided it. */
  evidence: string[];
}

/** Where each stack keeps its routes and markup. The agent audit reads this to know where to look. */
export const STACK_HINTS: Record<Stack, string> = {
  nextjs: "Pages are app/**/page.tsx (or pages/), layouts are app/**/layout.tsx. Metadata is an exported metadata object or generateMetadata.",
  nuxt: "Pages are pages/**/*.vue, layouts are layouts/*.vue. Head tags come from useHead or useSeoMeta.",
  astro: "Pages are src/pages/**/*.astro (and .md), layouts are in src/layouts. Head tags sit in the layout's <head>.",
  sveltekit: "Routes are src/routes/**/+page.svelte. Head tags are in <svelte:head> or the layout.",
  remix: "Routes are app/routes/*.tsx. Each route exports meta (and links) for its head tags.",
  "vite-spa": "The shell is index.html. Routes are in src/ (a router such as React Router). Head tags are in index.html or in a head component.",
  "plain-static-html": "Pages are the .html files. Each page carries its own <head>.",
  hugo: "Templates are layouts/**/*.html, content is in content/, and site settings are in the hugo config file.",
  jekyll: "Templates are _layouts/*.html and _includes/. Pages are .md or .html files with front matter.",
  eleventy: "Templates are in the input folder (.njk, .liquid, .md or .html), layouts are under _includes.",
  "php-slim-twig": "Routes are registered on the Slim app (public/index.php or a routes file, ->get and ->map). Markup is in the .twig templates (templates/ or views/).",
  laravel: "Routes are in routes/web.php. Views are resources/views/**/*.blade.php, and the layout is the one they @extend.",
  symfony: "Routes are attributes on src/Controller classes or in config/routes. Templates are templates/**/*.html.twig.",
  wordpress: "Templates are the active theme's *.php files under wp-content/themes/. Head output comes from wp_head() in header.php.",
  rails: "Routes are in config/routes.rb. Views are app/views/**/*.html.erb, and the layout is app/views/layouts/application.html.erb.",
  django: "URLs are in each app's urls.py. Templates are in templates/ folders as *.html, and the base template is extended by the rest.",
  flask: "Routes are the @app.route functions (app.py or the package). Templates are in templates/*.html.",
  expo: "Screens are app/**/*.tsx (Expo Router) or App.tsx. App config is app.json or app.config.*.",
  node: "No framework was recognised, but package.json lists dependencies. Routes are in the entry file (src/index.ts, server.ts, app.ts) or a routes folder.",
  unknown: "No known framework was found. Find the entry points and templates yourself, and record only what the code shows.",
};

/** The files at the root or one folder down whose repo path matches. Deeper folders (vendor, build output) are not searched. */
function shallow(repo: Repo, re: RegExp): string[] {
  return repo.files.filter((f) => f.split("/").length <= 2 && re.test(f));
}

/** The composer.json requirements, as "name version" evidence keyed by package name. */
function composerRequires(repo: Repo): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of shallow(repo, /(^|\/)composer\.json$/)) {
    let j: Record<string, Record<string, string>> = {};
    try {
      j = JSON.parse(repo.text(f) ?? "{}");
    } catch {
      continue;
    }
    for (const key of ["require", "require-dev"]) for (const [name, version] of Object.entries(j[key] ?? {})) out.set(name, `${f} requires ${name} ${version}`);
  }
  return out;
}

const NEXT_PAGE = /(^|\/)(src\/)?app\/(.*\/)?(page|layout)\.(tsx|jsx|ts|js|mdx)$/;

/** One rule per stack: the evidence that proves it, or an empty list. */
type Rule = (repo: Repo) => string[];

const dep = (repo: Repo, re: RegExp): string | null => [...repo.deps()].find((d) => re.test(d)) ?? null;
const depEvidence = (repo: Repo, re: RegExp): string[] => {
  const d = dep(repo, re);
  return d ? [`package.json depends on ${d}`] : [];
};
const fileEvidence = (repo: Repo, re: RegExp, why: string): string[] => shallow(repo, re).slice(0, 1).map((f) => `${f} ${why}`);
const composerEvidence = (repo: Repo, names: string[]): string[] => {
  const req = composerRequires(repo);
  return names.map((n) => req.get(n)).filter((x): x is string => !!x);
};
const textEvidence = (repo: Repo, re: RegExp, text: RegExp, why: string): string[] => {
  const f = shallow(repo, re).find((x) => text.test(repo.text(x) ?? ""));
  return f ? [`${f} ${why}`] : [];
};

const RULES: Array<[Stack, Rule]> = [
  ["nextjs", (r) => {
    const page = r.files.find((f) => NEXT_PAGE.test(f) && !/(^|\/)api\//.test(f));
    return [...depEvidence(r, /^next$/), ...fileEvidence(r, /^next\.config\.(js|mjs|cjs|ts)$/, "configures Next.js"), ...(page ? [`${page} is an App Router page`] : [])];
  }],
  ["nuxt", (r) => [...depEvidence(r, /^nuxt$/), ...fileEvidence(r, /^nuxt\.config\.(js|mjs|ts)$/, "configures Nuxt")]],
  ["astro", (r) => [...depEvidence(r, /^astro$/), ...fileEvidence(r, /^astro\.config\.(js|mjs|ts)$/, "configures Astro")]],
  ["sveltekit", (r) => depEvidence(r, /^@sveltejs\/kit$/)],
  ["remix", (r) => depEvidence(r, /^(@remix-run\/|remix$)/)],
  ["expo", (r) => depEvidence(r, /^(expo|react-native)$/)],
  ["laravel", (r) => [...composerEvidence(r, ["laravel/framework"]), ...fileEvidence(r, /^artisan$/, "is Laravel's command line")]],
  ["symfony", (r) => composerEvidence(r, ["symfony/framework-bundle", "symfony/symfony"])],
  ["php-slim-twig", (r) => composerEvidence(r, ["slim/slim"])],
  ["wordpress", (r) => {
    const themeDir = r.files.find((f) => /^wp-content\//.test(f));
    if (themeDir) return ["wp-content/ folder exists"];
    return fileEvidence(r, /^wp-config(-sample)?\.php$/, "is the WordPress config");
  }],
  ["rails", (r) => {
    const gem = textEvidence(r, /^Gemfile$/, /^\s*gem\s+["']rails["']/m, "declares the rails gem");
    return gem.length ? gem : fileEvidence(r, /^config\/application\.rb$/, "is the Rails application file");
  }],
  ["django", (r) => textEvidence(r, /^(manage\.py|requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/, /\bdjango\b/i, "mentions Django")],
  ["flask", (r) => textEvidence(r, /^(requirements[^/]*\.txt|pyproject\.toml|Pipfile|app\.py)$/, /\bflask\b/i, "mentions Flask")],
  ["hugo", (r) => {
    const cfg = fileEvidence(r, /^hugo\.(toml|yaml|yml|json)$/, "is the Hugo config");
    if (cfg.length) return cfg;
    const layouts = r.files.some((f) => f.startsWith("layouts/"));
    return layouts && fileEvidence(r, /^config\.(toml|yaml|yml)$/, "is the config, with a layouts/ folder").length ? ["layouts/ folder and config file"] : [];
  }],
  ["jekyll", (r) => {
    const cfg = fileEvidence(r, /^_config\.ya?ml$/, "is the Jekyll config");
    if (!cfg.length) return [];
    return r.files.some((f) => f.startsWith("_layouts/")) || /jekyll/i.test(r.text("Gemfile") ?? "") ? [...cfg, "has _layouts/ or a Jekyll Gemfile"] : [];
  }],
  ["eleventy", (r) => [...depEvidence(r, /^@11ty\/eleventy$/), ...fileEvidence(r, /^(\.eleventy|eleventy\.config)\.(js|cjs|mjs)$/, "configures Eleventy")]],
  ["vite-spa", (r) => [...depEvidence(r, /^vite$/), ...fileEvidence(r, /^vite\.config\.(js|ts|mjs|cjs)$/, "configures Vite")]],
  ["plain-static-html", (r) => {
    const html = r.files.filter((f) => /\.html?$/i.test(f));
    if (!html.length || r.deps().size) return [];
    return [html.includes("index.html") ? "index.html and no package dependencies" : `${html.length} .html file(s) and no package dependencies`];
  }],
  // A JS or TS project with dependencies and no framework above: a plain Node or Hono service, or a library with a build.
  ["node", (r) => (r.deps().size ? [`package.json lists ${r.deps().size} dependencies and no framework was recognised`] : [])],
];

/** The template extensions a stack renders markup from. Some depend on the stack's own packages. */
function templatesOf(stack: Stack, repo: Repo): string[] {
  switch (stack) {
    case "php-slim-twig": {
      const req = composerRequires(repo);
      return req.has("twig/twig") || req.has("slim/twig-view") ? [".twig"] : [".php", ".html"];
    }
    case "laravel":
      return [".blade.php"];
    case "symfony":
      return [".twig"];
    case "wordpress":
      return [".php"];
    case "rails":
      return [".erb"];
    case "django":
    case "flask":
      return [".html"];
    case "jekyll":
    case "hugo":
    case "plain-static-html":
      return [".html"];
    case "eleventy":
      return [".njk", ".liquid", ".md", ".html"];
    case "nuxt":
      return [".vue"];
    case "sveltekit":
      return [".svelte"];
    case "astro":
      return [".astro"];
    default:
      return [];
  }
}

/**
 * Detects the stack of the repo. Never throws on an odd folder: a folder with nothing recognisable is "unknown", with the
 * reason in evidence.
 */
export function detectStack(repo: Repo): StackDetection {
  for (const [stack, rule] of RULES) {
    const evidence = rule(repo);
    if (evidence.length) return { stack, templateExts: templatesOf(stack, repo), evidence };
  }
  return { stack: "unknown", templateExts: [], evidence: ["no framework manifest, config or template files were recognised"] };
}
