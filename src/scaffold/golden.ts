/**
 * Golden stacks: opinionated production starters shipped as built-in recipes. They use the same model as every
 * other recipe (generator, steps, conventions, repos, tag) plus `files`, template files written after the generator.
 *
 * Steps are argv, like everything else, so `bun pm pkg set key=value` edits package.json without a shell. The
 * generator runs first and writes the base project; the template files then add what a generator cannot: the
 * schema, auth, billing, health, analytics and tests. A template never overwrites a file the generator made.
 */
import type { Recipe, SubProject } from "./recipes";
import { DB_TS, DRIZZLE_CONFIG_TS, SCHEMA_TS } from "./templates/saas-next/database";
import { AUTH_CLIENT_TS, AUTH_ROUTE_TS, AUTH_TS, ENV_TS, LOGIN_PAGE_TSX } from "./templates/saas-next/auth";
import { BILLING_TS, CHECKOUT_ROUTE_TS, PORTAL_ROUTE_TS, PRICING_PAGE_TSX, WEBHOOK_ROUTE_TS } from "./templates/saas-next/billing";
import { ANALYTICS_TS, HEALTH_ROUTE_TS, INSTRUMENTATION_CLIENT_TS, INSTRUMENTATION_TS } from "./templates/saas-next/observability";
import { ENV_EXAMPLE, ENV_TEST_TS, PLAYWRIGHT_CONFIG_TS, SMOKE_SPEC_TS, VITEST_CONFIG_TS } from "./templates/saas-next/project";
import { API_TEST_TS, API_TS, APP_CONFIG_TS, EAS_JSON, ENV_EXAMPLE as APP_ENV_EXAMPLE, METADATA_JSON, SENTRY_TS } from "./templates/expo-app/app";
import { BUNFIG_TOML, ROOT_PACKAGE_JSON, SHARED_INDEX_TS, SHARED_PACKAGE_JSON, SHARED_TSCONFIG } from "./templates/saas-monorepo/root";
import { renderWorkflow, WORKFLOW_PATH, type WorkflowInputs } from "../ci/workflow";

/** The saas-next app is a bun project with typecheck, lint and test scripts (SAAS_STEPS) and a Playwright config. */
const SAAS_CI_INPUTS: WorkflowInputs = {
  packageManager: "bun",
  lockfile: "bun.lock",
  cargo: false,
  go: false,
  python: false,
  pythonProject: false,
  requirements: false,
  playwright: "playwright.config.ts",
  verify: [
    { name: "typecheck", cmd: "bun run typecheck" },
    { name: "lint", cmd: "bun run lint" },
    { name: "test", cmd: "bun run test" },
  ],
};
const SAAS_CI = renderWorkflow(SAAS_CI_INPUTS);

const SAAS_RULES = [
  "Auth: Better Auth. The server instance and currentUser() are in src/lib/auth.ts, the React client in src/lib/auth-client.ts, and the catch-all route in src/app/api/auth/[...all]/route.ts. Read the signed-in user with currentUser(await headers()); do not parse session cookies yourself.",
  "Billing: Stripe. The client, subscriptionFor, hasAccess and syncSubscription are in src/lib/billing.ts. Checkout, the portal and the webhook are src/app/api/billing/checkout, src/app/api/billing/portal and src/app/api/stripe/webhook. Gate paid features with hasAccess(await subscriptionFor(user.id)). Only the webhook writes the subscription table.",
  "Database: the Drizzle schema is src/db/schema.ts and the client is db in src/db/index.ts. After a schema change run bun run db:generate, commit the new files in drizzle/, and apply them with bun run db:migrate.",
  "Environment: every key the app reads is listed in .env.example, and .env is the local copy. Server code reads keys with env() or optionalEnv() from src/lib/env.ts. Browser code reads NEXT_PUBLIC_ keys as process.env.NAME literals, which Next needs in order to inline them.",
  "Add each new environment key to .env.example in the same change, with an empty or example value. Keep .env.example committed; if .gitignore lists .env*, add !.env.example under it.",
  "Analytics: server events go through track() in src/lib/analytics.ts. Browser PostHog and Sentry start in src/instrumentation-client.ts; server-side Sentry starts in src/instrumentation.ts.",
  "Health: GET /api/health in src/app/api/health/route.ts checks the database and returns 503 when it cannot answer. Keep it cheap and unauthenticated.",
  "Tests: unit tests are src/**/*.test.ts, run with bun run test (vitest). Browser smoke tests are in e2e/, run with bun run test:e2e (Playwright). It starts bun run dev unless PLAYWRIGHT_BASE_URL is set.",
  "The build reads the database and auth keys when its modules load, so copy .env.example to .env before bun run build.",
];

const SAAS_STEPS: string[][] = [
  ["bun", "add", "drizzle-orm", "postgres", "better-auth", "stripe", "posthog-js", "posthog-node", "@sentry/nextjs"],
  ["bun", "add", "-d", "drizzle-kit", "vitest", "@playwright/test"],
  ["bun", "pm", "pkg", "set", "scripts.typecheck=tsc --noEmit"],
  ["bun", "pm", "pkg", "set", "scripts.lint=eslint ."],
  ["bun", "pm", "pkg", "set", "scripts.test=vitest run"],
  ["bun", "pm", "pkg", "set", "scripts.test:e2e=playwright test"],
  ["bun", "pm", "pkg", "set", "scripts.db:generate=drizzle-kit generate"],
  ["bun", "pm", "pkg", "set", "scripts.db:migrate=drizzle-kit migrate"],
  ["bunx", "drizzle-kit", "generate"],
  ["bunx", "playwright", "install", "chromium"],
];

export const SAAS_NEXT: Recipe = {
  id: "saas-next",
  name: "SaaS (Next.js + Postgres)",
  description: "Next.js with Postgres and Drizzle, Better Auth (email and OAuth), Stripe subscriptions, Sentry, PostHog, vitest and Playwright.",
  generate: ["bunx", "create-next-app@latest", ".", "--ts", "--tailwind", "--eslint", "--app", "--src-dir", "--import-alias", "@/*", "--use-bun", "--skip-install", "--yes"],
  steps: SAAS_STEPS,
  conventions: SAAS_RULES,
  intro: "A SaaS starter: Next.js (App Router, TypeScript), Postgres with Drizzle, Better Auth, Stripe subscriptions, Sentry, PostHog and tests.",
  starterPrompt: "This is a SaaS starter with the plumbing already in place: Next.js, Postgres with Drizzle, Better Auth, Stripe subscriptions, Sentry and PostHog. Read AGENTS.md first. Then copy .env.example to .env and fill in what you have (a local Postgres is enough to start), run bun run db:migrate, and build the app described below on top of this. Keep auth and billing where AGENTS.md says they live, and tell me how to run it.\n\nThe app: ",
  icon: "globe",
  tag: "web",
  practices: ["kiss", "yagni", "smart-dumb-components", "strict-types", "test-the-logic", "design-tokens", "ponytail", "cro", "copywriting", "seo"],
  checklists: ["saas-app", "marketing-site", "seo", "cro", "copywriting"],
  files: {
    "src/db/schema.ts": SCHEMA_TS,
    "src/db/index.ts": DB_TS,
    "drizzle.config.ts": DRIZZLE_CONFIG_TS,
    "src/lib/env.ts": ENV_TS,
    "src/lib/auth.ts": AUTH_TS,
    "src/lib/auth-client.ts": AUTH_CLIENT_TS,
    "src/app/api/auth/[...all]/route.ts": AUTH_ROUTE_TS,
    "src/app/login/page.tsx": LOGIN_PAGE_TSX,
    "src/lib/billing.ts": BILLING_TS,
    "src/app/api/billing/checkout/route.ts": CHECKOUT_ROUTE_TS,
    "src/app/api/billing/portal/route.ts": PORTAL_ROUTE_TS,
    "src/app/api/stripe/webhook/route.ts": WEBHOOK_ROUTE_TS,
    "src/app/pricing/page.tsx": PRICING_PAGE_TSX,
    "src/app/api/health/route.ts": HEALTH_ROUTE_TS,
    "src/instrumentation.ts": INSTRUMENTATION_TS,
    "src/instrumentation-client.ts": INSTRUMENTATION_CLIENT_TS,
    "src/lib/analytics.ts": ANALYTICS_TS,
    "src/lib/env.test.ts": ENV_TEST_TS,
    "vitest.config.ts": VITEST_CONFIG_TS,
    "playwright.config.ts": PLAYWRIGHT_CONFIG_TS,
    "e2e/smoke.spec.ts": SMOKE_SPEC_TS,
    ".env.example": ENV_EXAMPLE,
    [WORKFLOW_PATH]: SAAS_CI,
  },
};

const MOBILE_RULES = [
  "Routes live in app/ (Expo Router). The root layout is app/_layout.tsx: import initSentry from lib/sentry.ts, call it at the top of the layout and wrap the layout with Sentry.wrap.",
  "Config: app.config.ts builds the app config from the environment. APP_VARIANT, set per profile in eas.json, picks development, preview or production and the bundle id suffix. Keys the app reads at runtime must start with EXPO_PUBLIC_.",
  "API: every request goes through lib/api.ts (apiFetch, api.get, api.post). The base URL is EXPO_PUBLIC_API_URL, which is the saas-next app's origin. The bearer token from sign-in goes to setAuthToken.",
  "Builds: eas.json has development, preview and production profiles. A physical phone cannot reach localhost, so point the development profile at a LAN or tunnel address when testing on a device.",
  "Store listing: store/metadata.json holds the name, subtitle, description, keywords, privacy URL and screenshots folder. Apple limits: name and subtitle 30 characters, keywords 100 characters in total, description 4000. Screenshots go in store/screenshots.",
  "Before the first preview build, replace the example.com addresses in eas.json and store/metadata.json, and set EAS_PROJECT_ID (from eas init).",
  "Expo packages are installed with bunx expo install so their versions match the SDK. Tests are bun run test (jest-expo); run the type check and lint before saying a task is done.",
];

const MOBILE_STEPS: string[][] = [
  ["bun", "install"],
  ["bunx", "expo", "install", "@sentry/react-native"],
  ["bunx", "expo", "install", "jest", "jest-expo"],
  ["bun", "add", "-d", "@types/jest"],
  ["bun", "pm", "pkg", "set", "scripts.test=jest"],
  ["bun", "pm", "pkg", "set", "jest.preset=jest-expo"],
  ["bun", "pm", "pkg", "set", "scripts.typecheck=tsc --noEmit"],
];

export const EXPO_APP: Recipe = {
  id: "expo-app",
  name: "Mobile app (Expo Router)",
  description: "An Expo Router app in TypeScript with EAS build profiles, an API client for a saas-next backend, Sentry and App Store metadata.",
  generate: ["bunx", "create-expo-app@latest", ".", "--template", "default", "--no-install", "--yes"],
  steps: MOBILE_STEPS,
  conventions: [...MOBILE_RULES],
  intro: "An Expo Router app in TypeScript, with EAS profiles, a typed API client for the backend, Sentry and store metadata.",
  starterPrompt: "This is a fresh Expo Router project with an API client, Sentry and EAS build profiles already set up. Read AGENTS.md first. Replace the demo tabs with the first screens of the app described below, call the backend through lib/api.ts, and tell me how to run it with bunx expo start.\n\nThe app: ",
  icon: "smartphone",
  tag: "mobile",
  practices: ["kiss", "smart-dumb-components", "strict-types", "test-the-logic", "design-tokens"],
  checklists: ["mobile-release"],
  files: {
    "app.config.ts": APP_CONFIG_TS,
    "eas.json": EAS_JSON,
    "lib/api.ts": API_TS,
    "lib/api.test.ts": API_TEST_TS,
    "lib/sentry.ts": SENTRY_TS,
    "store/metadata.json": METADATA_JSON,
    "store/screenshots/.gitkeep": "",
    ".env.example": APP_ENV_EXAMPLE,
  },
};

/** A stack as a project of a monorepo: its generator, steps and files under `dir`, minus the files only a repository root can use, with extra steps first. */
function asProject(r: Recipe, dir: string, o: { drop?: string[]; before?: string[][] } = {}): SubProject {
  const files = Object.fromEntries(Object.entries(r.files ?? {}).filter(([file]) => !o.drop?.includes(file)));
  return { dir, generate: r.generate, steps: [...(o.before ?? []), ...r.steps], ...(Object.keys(files).length ? { files } : {}) };
}

/** A stack's rules for the root AGENTS.md of a monorepo, where its paths are no longer at the root. */
const scopedRules = (dir: string, r: Recipe): string[] => r.conventions.map((rule) => `${dir} (paths are relative to it): ${rule}`);

/** Points an app at packages/shared. It runs before the app's own steps, after the root install has linked the workspace. */
const LINK_SHARED = ["bun", "pm", "pkg", "set", "dependencies.@workspace/shared=workspace:*"];

const MONOREPO_RULES = [
  "Layout: apps/web is the Next.js site and backend, apps/mobile is the Expo app, and packages/shared holds code both import as @workspace/shared (source in packages/shared/src, no build step). The rules below are per app; their paths are relative to the app's folder.",
  "Run bun install once, at the repository root: it installs every workspace into one node_modules and writes the one bun.lock. Add a dependency from inside the app that uses it (cd apps/web, then bun add x). The root package.json holds scripts only.",
  "Types both apps need (API response shapes, ids, enums) go in packages/shared/src/index.ts, not copied into each app. HealthResponse there describes GET /api/health.",
  "Scripts: bun run typecheck, lint and test at the root run every workspace that defines them, and bun run dev:web and dev:mobile start the apps. App-only scripts run as bun run --cwd apps/web <script> (db:migrate, test:e2e). CI is the one .github/workflows/ci.yml at the root: those three scripts, then Playwright in apps/web.",
];

const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];

/** The Next.js SaaS and the Expo app in one Bun workspace, built from the two stacks above so they never drift. */
export const SAAS_MONOREPO: Recipe = {
  id: "saas-monorepo",
  name: "SaaS + mobile (monorepo)",
  description: "A Bun workspace: the SaaS stack in apps/web, the Expo app in apps/mobile and shared types in packages/shared, with one CI workflow at the root.",
  generate: [],
  steps: [["bun", "install"]],
  conventions: [...MONOREPO_RULES, ...scopedRules("apps/web", SAAS_NEXT), ...scopedRules("apps/mobile", EXPO_APP)],
  intro: "A monorepo: the SaaS web app and backend (Next.js, Postgres, Better Auth, Stripe) in apps/web, an Expo mobile app in apps/mobile, and shared types in packages/shared.",
  starterPrompt: "This is a monorepo with two apps already set up: apps/web (the Next.js SaaS with auth, billing and a database) and apps/mobile (an Expo Router app that calls it), plus packages/shared for types both use. Read AGENTS.md first. Copy apps/web/.env.example to apps/web/.env and apps/mobile/.env.example to apps/mobile/.env and fill in what you have, run bun run --cwd apps/web db:migrate, then build the product described below across both apps. Keep each app's auth, billing and API client where AGENTS.md says they live, and tell me how to run both.\n\nThe product: ",
  icon: "layers",
  tag: "web",
  practices: union(SAAS_NEXT.practices, EXPO_APP.practices),
  checklists: union(SAAS_NEXT.checklists, EXPO_APP.checklists),
  files: {
    "package.json": ROOT_PACKAGE_JSON,
    "bunfig.toml": BUNFIG_TOML,
    "packages/shared/package.json": SHARED_PACKAGE_JSON,
    "packages/shared/tsconfig.json": SHARED_TSCONFIG,
    "packages/shared/src/index.ts": SHARED_INDEX_TS,
    [WORKFLOW_PATH]: renderWorkflow({ ...SAAS_CI_INPUTS, playwright: "apps/web/playwright.config.ts" }),
  },
  projects: [asProject(SAAS_NEXT, "apps/web", { drop: [WORKFLOW_PATH], before: [LINK_SHARED] }), asProject(EXPO_APP, "apps/mobile", { before: [LINK_SHARED] })],
};

export const GOLDEN_RECIPES: Recipe[] = [SAAS_NEXT, EXPO_APP, SAAS_MONOREPO];
