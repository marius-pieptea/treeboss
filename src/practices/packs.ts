/**
 * The built-in practice packs: maintainability rule sets an operator switches on per workspace. An enabled pack tells
 * every agent its rules (store.ts writes them into AGENTS.md / CLAUDE.md), and where a check exists the gate and
 * `trb practices check` look for violations (checks.ts). Each check belongs to exactly one pack.
 */

export const STACKS = ["web", "mobile", "api", "any"] as const;
export type Stack = (typeof STACKS)[number];

/** The mechanical checks. Every id is owned by one built-in pack (see PACKS). */
export const CHECK_IDS = ["file-length", "function-length", "no-any", "presentational-data", "raw-color", "img-alt", "banned-words", "generic-cta", "seo-meta", "multiple-h1", "seo-link-text"] as const;
export type PracticeCheck = (typeof CHECK_IDS)[number];

export interface PackDef {
  id: string;
  title: string;
  summary: string;
  appliesTo: Stack[];
  /** Short imperative lines for agents. At most 8. */
  rules: string[];
  /** Skill names the agent should load for this pack, as in the skills folder. Rendered as "Use the X skill if available". */
  skills?: string[];
  checks?: PracticeCheck[];
}

export const PACKS: PackDef[] = [
  {
    id: "kiss",
    title: "KISS",
    summary: "Keep it simple: the plainest design that meets the requirement.",
    appliesTo: ["any"],
    rules: [
      "Choose the simplest design that meets the requirement; add complexity only when a real case needs it.",
      "Prefer a plain function to a class, factory or framework layer.",
      "Replace nested conditionals with early returns.",
      "Name things for what they do; a reader should not have to trace the code to understand a name.",
      "Do not add a dependency for a few lines of code.",
      "If a function needs a comment to say what each section does, split it.",
    ],
  },
  {
    id: "yagni",
    title: "YAGNI",
    summary: "You aren't gonna need it: build only what the task asks for.",
    appliesTo: ["any"],
    rules: [
      "Build only what the current task and its acceptance need.",
      "No option, flag, config value or extension point for a case that does not exist yet.",
      "No abstraction with a single implementation; inline it until a second real use appears.",
      "No backwards-compatibility or migration code for data nothing has yet.",
      "Say in one line what you left out.",
    ],
  },
  {
    id: "smart-dumb-components",
    title: "Smart / dumb components",
    summary: "Containers own data, effects and state; presentational components only render props.",
    appliesTo: ["web", "mobile"],
    rules: [
      "Container components own data fetching, effects and state, and pass what the view needs as props.",
      "Presentational components take props and return JSX: no fetch, no query hooks, no imports of the api or data modules.",
      "Presentational components keep only local UI state (open, hover, draft text), never server data.",
      "Keep a container thin: it wires data to a view and renders no markup beyond that view.",
      "Shared display pieces live in components/ui and stay free of data access.",
    ],
    checks: ["presentational-data"],
  },
  {
    id: "small-units",
    title: "Small units",
    summary: "Short files and short functions, each doing one step.",
    appliesTo: ["any"],
    rules: [
      "Keep each file under the file line limit; split by responsibility when it grows past it.",
      "Keep each function under the function line limit; extract a named helper for each step.",
      "Return early instead of nesting; one level of nesting is the goal.",
      "Take an options object instead of a long parameter list.",
    ],
    checks: ["file-length", "function-length"],
  },
  {
    id: "feature-folders",
    title: "Feature folders",
    summary: "Group code by feature, not by file type.",
    appliesTo: ["any"],
    rules: [
      "Group code by feature (features/<name>/) with its components, data hooks and tests together.",
      "Import across features only through a shared module (lib/, components/ui), never another feature's internals.",
      "Keep code used by one feature inside that feature; move it to shared code once a second feature uses it.",
      "Keep a feature's API calls in its data module.",
    ],
  },
  {
    id: "strict-types",
    title: "Strict types",
    summary: "No escape hatches in TypeScript: no any, no non-null assertions.",
    appliesTo: ["web", "mobile", "api"],
    rules: [
      "No `any` and no `as any`; use `unknown` and narrow it.",
      "No non-null assertion `!`; narrow with a check or handle the missing case.",
      "Give exported functions explicit parameter and return types.",
      "Model a closed set of values as a union type, not a free string.",
      "Fix a type error at its source instead of casting around it with `as`.",
    ],
    checks: ["no-any"],
  },
  {
    id: "test-the-logic",
    title: "Test the logic",
    summary: "Decision logic lives in pure functions with unit tests; components stay thin.",
    appliesTo: ["any"],
    rules: [
      "Move decision logic out of components and handlers into pure functions in a *-logic.ts file.",
      "Unit-test every pure function, including the edge cases that change its result.",
      "Keep the component thin: it calls the logic and does not compute.",
      "Test parsing, validation and state transitions first.",
    ],
  },
  {
    id: "design-tokens",
    title: "Design tokens",
    summary: "Colors, sizes and spacing come from design/tokens.css, never from literals.",
    appliesTo: ["web"],
    rules: [
      "Use colors, sizes, spacing, radii and shadows only from design/tokens.css, through var(--…).",
      "No raw hex, rgb or hsl color in .tsx, .jsx or .css outside the tokens file.",
      "Do not invent a size, spacing or radius the tokens do not define; add the token to DESIGN.md and tokens.css first.",
      "Use the type scale's step names, never arbitrary pixel sizes for text.",
    ],
    checks: ["raw-color"],
  },
  {
    id: "a11y-basics",
    title: "Accessibility basics",
    summary: "Names, labels and alt text for the things every user needs.",
    appliesTo: ["web", "mobile"],
    rules: [
      "Every <img> has an alt attribute: a description, or alt=\"\" when it is decorative.",
      "Use a button, link or input for anything clickable; never a clickable div.",
      "Give icon-only buttons an aria-label.",
      "Give every form field a visible label bound to its input.",
      "Keep the focus outline visible; if you remove one, replace it.",
      "Never convey status by color alone; add a word or an icon.",
    ],
    checks: ["img-alt"],
  },
  {
    id: "ponytail",
    title: "Ponytail",
    summary: "Lazy senior dev: the smallest change that fully solves the task.",
    appliesTo: ["any"],
    rules: [
      "Write the smallest change that fully solves the task; finish every part it needs, including callers, tests and fixtures.",
      "Reuse what exists first (a helper, component, pattern, or installed dependency); never add a dependency for a few lines.",
      "No abstraction, option, config or \"for later\" code nobody asked for. Deletion beats addition.",
      "Fix a bug at the root: grep every caller of the function first, then fix the shared code once.",
      "New non-trivial logic (a branch, loop, parser, money or security) gets one small test or an assert.",
      "A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.",
      "Never cut validation at trust boundaries, error handling that prevents data loss, security or accessibility.",
      "End the reply with one or two lines: what you skipped or did not check, and any risk the user must know.",
    ],
  },
  {
    id: "pstack",
    title: "pstack principles",
    summary: "Engineering principles from pstack by Lauren Tan: prove it works, fix root causes, and delete before you add.",
    appliesTo: ["any"],
    rules: [
      "Before you call a task done, check the real artifact by running it or reading the actual value; 'it compiles' and a self-report are not proof.",
      "Reproduce each bug, then fix the first place the system went wrong; a guard, retry or swallowed error that covers a state that should never exist only hides the bug.",
      "After two or more fixes that share one assumption have failed, write the assumption down and test it before the next fix.",
      "Test what callers can observe (return values, errors, saved state, requests sent), not internal calls; derive each expected value from the requirement, not from a run of the code.",
      "Split multi-step work into small units, run each unit's check before starting the next, and write the failing test before its fix.",
      "Replace a growing if/else chain, or two booleans that must stay in sync, with one structure: a state machine, a lookup table or a discriminated union.",
      "Collapse a pass-through layer that repeats the methods and arguments of the layer below it, and derive each value from its source instead of keeping a second copy in sync.",
      "When a new internal API replaces an old one, migrate every caller and delete the old API and its dead code in the same change; keep no compatibility layer unless outside users depend on it.",
    ],
    skills: [
      "principle-prove-it-works",
      "principle-fix-root-causes",
      "principle-attack-the-premise",
      "principle-test-behavior-not-implementation",
      "principle-sequence-verifiable-units",
      "principle-model-the-domain",
      "principle-minimize-reader-load",
      "principle-subtract-before-you-add",
      "principle-migrate-callers-then-delete-legacy-apis",
    ],
  },
  {
    id: "cro",
    title: "Conversion (CRO)",
    summary: "Marketing pages that turn a visitor into a sign-up: one clear action, proof and low risk at each ask.",
    appliesTo: ["web"],
    rules: [
      "Give each page one primary CTA, the same action every time, and repeat it after each major section.",
      'Word every CTA with the outcome ("Start free trial", "Get my audit"); never "Submit", "Learn more" or "Go".',
      "Put the value prop, the audience and the CTA above the fold in the hero; on a dedicated landing page, remove the site navigation.",
      "Next to each CTA, add social proof (logos, testimonials with name and role, numbers) and risk reducers (free trial, no card, guarantee).",
      "Ask for five form fields or fewer, only what the next step needs; validate each field inline as the user leaves it.",
      "Put an objection-handling FAQ before the final CTA.",
      "Lay out pricing plans side by side with the same rows, and highlight the recommended plan.",
      "Wire the page's primary CTA to a named analytics conversion event, and check that the event fires.",
    ],
    checks: ["generic-cta"],
  },
  {
    id: "copywriting",
    title: "Copywriting",
    summary: "Marketing copy that leads with the reader's problem, in plain words, with proof instead of claims.",
    appliesTo: ["web"],
    rules: [
      'Lead with the customer\'s problem and the outcome they get; write "you" far more often than "we", and no feature before its benefit.',
      'Make each headline specific, with a concrete number or outcome ("Cut invoice errors by 40% in a week", not "Better invoicing").',
      "Write the subhead to say who the page is for and how the product works, in one sentence.",
      "Give each section one idea, and let its heading name that idea.",
      "Write bullets benefit first, then the feature in a few words.",
      "Use plain words, sentences under 20 words, at a grade 8 reading level. Never use these: revolutionary, seamless, cutting-edge, unlock, elevate, leverage, robust, game-changer, empower, delve.",
      "Back each claim with proof: a number, a named customer, a measured result. Cut any claim that has none.",
      "Keep the brand's voice from DESIGN.md or the brand docs in the repo; when neither exists, match the product's existing copy.",
    ],
    checks: ["banned-words"],
  },
  {
    id: "seo",
    title: "SEO",
    summary: "Pages a search engine can find, read and show well: titles, headings, links, structured data and server rendering.",
    appliesTo: ["web"],
    rules: [
      "Give every page a unique title of 50 to 60 characters and a meta description of 120 to 160 characters, with the primary keyword in the first words of each.",
      "Use exactly one H1 per page, and nest H2 and H3 in order without skipping a level.",
      "Use descriptive kebab-case URLs (/pricing/invoice-software), and a canonical tag that holds the page's own absolute URL.",
      "Add JSON-LD: Organization on the home page, SoftwareApplication or Product on product pages, FAQPage where a FAQ shows, BreadcrumbList on nested pages.",
      'Write internal links whose text names the target page; never "click here" or "here".',
      "Give every image alt text that describes it, an explicit width and height, lazy loading below the fold, and WebP or AVIF.",
      "Render indexable content on the server (SSR or SSG), never only in the browser; keep sitemap.xml and robots.txt in step with the routes.",
      "Set Open Graph (og:title, og:description, og:image) and Twitter card tags on every page.",
    ],
    checks: ["seo-meta", "multiple-h1", "seo-link-text"],
  },
];

export const packById = (id: string): PackDef | undefined => PACKS.find((p) => p.id === id);

/** The check each built-in check id belongs to. */
export const PACK_OF_CHECK: Record<PracticeCheck, string> = Object.fromEntries(PACKS.flatMap((p) => (p.checks ?? []).map((c) => [c, p.id]))) as Record<PracticeCheck, string>;
