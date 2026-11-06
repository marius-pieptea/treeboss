# Feature Specification: Golden stacks

**Feature**: `111-golden-stacks`
**Status**: Implemented
**Input**: Two opinionated production starters ship as built-in recipes next to the four existing ones: `saas-next` (a Next.js SaaS with Postgres, auth, billing, errors, analytics and tests) and `expo-app` (an Expo Router mobile app that talks to a `saas-next` backend and is ready for store submission). A third, `saas-monorepo`, lays out both in one Bun workspace, one generator per subfolder.

## User Scenarios & Testing

### User Story 1 - Start a paid SaaS without wiring it by hand (Priority: P1)

I pick "SaaS (Next.js + Postgres)" in the New app dialog and give it a description. The new folder already has the database schema, sign-in with email and OAuth, Stripe checkout, the customer portal, the webhook, a health endpoint, Sentry, PostHog, unit and browser tests, and an `.env.example` that lists every key. The agent is told where each piece lives.

**Why this priority**: this is the wiring that takes a day to do correctly and that agents get wrong most often.

**Independent Test**: start a `saas-next` scaffold with a fake generator. The folder contains every template file, with the folder's name filled in, and `AGENTS.md` names where auth, billing, the schema, env and tests live.

**Acceptance Scenarios**:

1. **Given** an empty folder named `my-saas`, **When** the scaffold runs, **Then** `.env.example` has `DATABASE_URL` for database `my-saas`, and `src/app/pricing/page.tsx` says "Plans for My Saas".
2. **Given** the generator, **When** it finishes, **Then** the recipe's steps run in order (dependencies, package scripts, the first migration, Playwright's browser), and a failing step is logged, not fatal.
3. **Given** the scaffold is done, **When** I read `AGENTS.md`, **Then** it names `src/lib/auth.ts`, `src/lib/billing.ts`, `src/db/schema.ts`, `.env.example` and the test locations.

### User Story 2 - A mobile app that matches the backend (Priority: P2)

I pick "Mobile app (Expo Router)". The app has EAS profiles for development, preview and production, a config that reads its environment, an API client pointed at `EXPO_PUBLIC_API_URL`, Sentry, and store metadata (name, subtitle, description, keywords, privacy URL, screenshots folder).

**Independent Test**: start an `expo-app` scaffold with a fake generator. `eas.json` has the three profiles, `store/metadata.json` has the six fields, and `app.config.ts` keeps the generator's `app.json` values.

**Acceptance Scenarios**:

1. **Given** the Expo app, **When** I build the development profile, **Then** its bundle id ends in `.development`, and the production bundle id has no suffix.
2. **Given** a `saas-next` backend, **When** the app calls `api.get("/api/health")`, **Then** the request goes to `EXPO_PUBLIC_API_URL` with the bearer token, if one was set.

### User Story 3 - A template never destroys what the generator wrote (Priority: P1)

If the generator already created a file a template wants to write, the scaffold fails with the file's name and writes nothing from the template set. The generator's file is left as it was.

**Independent Test**: a fake generator that creates `src/lib/env.ts`. The job fails with "already exists", and `src/lib/auth.ts` is not created.

### Edge Cases

- A `{{word}}` that is not `{{name}}` or `{{title}}` is refused when the recipe is saved and when it is written, so a typo never ships as text.
- A path in `files` that is absolute, has `..`, or is inside `.git` is refused when the recipe is saved.
- A recipe saved from the editor (which does not carry `files`) keeps its template files. Sending `files: {}` clears them.
- Recipes saved before this change load unchanged: the `files` key is optional.

## Requirements

### Functional Requirements

- **FR-001**: `Recipe` MUST gain an optional `files` map (relative path to content). Recipes without it behave exactly as before.
- **FR-002**: Template files MUST be written after the generator (or starter copy) and before `git init`, so they are in the first commit.
- **FR-003**: A template file that already exists, or whose parent is a file or link, MUST cause the scaffold to fail before any template file is written.
- **FR-004**: Content MUST support `{{name}}` (the folder name as a slug) and `{{title}}` (the folder name as words). Any other placeholder MUST be refused.
- **FR-005**: Every generator and step of a golden stack MUST pass `checkArgv`: argv only, no shell.
- **FR-006**: The golden stacks MUST be built-in recipes, seeded once like the existing defaults. Existing stores gain them without losing anything.
- **FR-007**: `saas-next` MUST include: Drizzle schema and migrations, Better Auth (email and password, GitHub and Google when keyed, bearer plugin), Stripe checkout, portal and webhook (signature checked against the raw body), `/api/health`, Sentry (server and browser), PostHog (server and browser), vitest, Playwright smoke tests, and `.env.example` listing every key the code reads.
- **FR-008**: `expo-app` MUST include: `eas.json` (development, preview, production), `app.config.ts` reading the environment, an API client on `EXPO_PUBLIC_API_URL`, Sentry, `store/metadata.json`, and `store/screenshots/`.
- **FR-009**: The conventions MUST say where auth, billing, the database schema, environment keys and tests live.
- **FR-010**: A `Recipe` MAY list `projects` (`SubProject`: a folder, a generator, steps and template files), up to six, run in order after the recipe's own generator, which is then optional. A project's generator MUST run with its folder as working directory, in an empty folder the runner creates. A project folder MUST NOT start with a dot, MUST NOT be a file or a link, and MUST NOT hold a template file of the recipe's own set. A `.git` left by a project's generator MUST be removed, so the history is the root's. A project's steps run in its folder after the recipe's steps, and a failing step is logged, not fatal.
- **FR-011**: `saas-monorepo` MUST build `apps/web` from `saas-next` and `apps/mobile` from `expo-app` as projects, with `packages/shared` and the root `package.json` as the recipe's own template files. Its one CI workflow MUST sit at the root and run Playwright with `apps/web` as its working directory.

### Key Entities

- **Template file set**: a recipe's `files` map. Rendered once per scaffold with the folder's name.
- **Sub-project**: a folder of a recipe with its own generator, steps and template file set (`SubProject` in `src/scaffold/recipes.ts`).
- **Golden stack**: a built-in recipe that uses a generator, steps, conventions and a template file set.

## Success Criteria

- **SC-001**: `bun test tests/scaffold-golden.test.ts` passes: recipe validity, every step through `checkArgv`, template parsing, interpolation, overwrite refusal, and environment keys against `.env.example`.
- **SC-002**: Existing scaffold tests pass, with their default-list assertions updated for the two new defaults.

## Assumptions

- Generator commands are current `create-next-app`, `create-expo-app` (template `default`, Expo Router) and `bun pm pkg set`. These were not run against a live network in this change.
- The templates are checked for syntax only. They are not type-checked against installed Better Auth, Stripe, Drizzle or Expo packages.
- The Templates page shows a recipe's template files in a Template files panel, a list of paths with the content of the one picked (`web/src/features/scaffold/TemplatesPage.tsx`). A save from the editor keeps the entry's `projects`.
- Two generators in one scaffold run one after the other, each in its own folder. The monorepo's two apps are made by the same generators and steps as the two single stacks, so the stacks do not drift.
