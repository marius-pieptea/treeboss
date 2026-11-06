# Feature Specification: Launch checklists

**Feature**: `118-launch-checklists`
**Status**: Implemented
**Input**: Checklists for what a product must have before it ships, attached to a workspace by kind: a marketing site, a SaaS app, a mobile release, an API service. Each item tracks its state. A machine checks what it can, an agent is handed what needs fixing, and a person confirms the rest. Required items gate prod deploys.

## User Scenarios & Testing

### User Story 1 - See what blocks a launch (Priority: P1)

I attach the marketing-site checklist to a workspace and see the items grouped by category, with how many required ones pass. Each item says whether a machine, an agent or a person decides it.

**Independent Test**: `trb checklist attach marketing-site`, then `trb checklist show marketing-site`: every item is listed with its kind and status, and the progress reads "0 of N required passing".

**Acceptance Scenarios**:

1. **Given** a workspace, **When** I attach a checklist, **Then** its items show "not checked" until a run or a tick sets them.
2. **Given** an attached checklist, **When** I detach it, **Then** its item state is forgotten and the deploy gate no longer uses it.

### User Story 2 - Run the automatic checks against the folder and the served site (Priority: P1)

"Run checks" reads the repository (static checks) and, with a URL, crawls the running dev server or the deploy target (up to 30 pages). The served page wins when it answers; the repository decides when it does not.

**Independent Test**: a folder without `app/not-found.tsx` fails the custom 404 check, with that folder as the evidence. A crawl of a site without `/robots.txt` fails the robots check, with the URL as the evidence.

**Acceptance Scenarios**:

1. **Given** a page with no description, **When** I run the checks with its URL, **Then** the description check fails and names the page.
2. **Given** a missing page that answers 200, **When** the 404 check runs, **Then** it fails as a soft 404.
3. **Given** a check that needs a URL, **When** I run without one, **Then** it says "unknown" and why, and never "pass".

### User Story 3 - Hand the failures to an agent (Priority: P2)

"Fix with agent" starts a session in the workspace with a prompt that lists the failing automatic checks and the judgement items (CTA above the fold, the offline state, the demo account), each with a hint. Manual items are left for a person.

### User Story 4 - Confirm what only a person can (Priority: P2)

I tick an item with a note, for example "Checked the 404 on a phone". A tick pins the item: the next run leaves it alone. Untick it to hand it back to the checks.

### User Story 5 - Block a prod deploy until required items pass (Priority: P1)

`trb deploy prod` is refused while a required item of an attached checklist does not pass, and the error lists each one. `--force` deploys anyway. Other environments are not gated.

**Acceptance Scenarios**:

1. **Given** a required item that fails, **When** I deploy prod, **Then** the deploy is refused and the message names each blocker.
2. **Given** the same, **When** I deploy with force, **Then** the deploy runs.
3. **Given** a required item that fails, **When** I deploy dev, **Then** the deploy runs.

### User Story 6 - Go past the basics on marketing pages (Priority: P2)

A marketing site also gets three checklists that go deeper than marketing-site: SEO (metadata length and uniqueness, indexing rules, the sitemap against the crawl, the words a crawler reads), Conversion (one call to action above the first H2, a risk reducer beside it, social proof, short forms, a pricing page, the FAQ before the last call to action) and Copywriting (a specific headline, readable sentences, no hype words, you over we, placeholder copy).

**Independent Test**: attach `seo`, `cro` and `copywriting` to a workspace with a served site, run the checks with its URL. A page with a 4-character title fails the title check, and a page with "Get paid 3x faster" in its H1 and a free-trial line beside its button passes the headline and risk checks.

**Acceptance Scenarios**:

1. **Given** a marketing workspace, **When** I attach a checklist, **Then** `seo`, `cro` and `copywriting` attach with `marketing-site` when they come from the same recipe or tag.
2. **Given** a page whose visible text averages more than 20 words a sentence, **When** the checks run, **Then** the reading-level check fails and names the page.
3. **Given** a judgement item (target keyword, brand voice, proof for claims), **When** I fix with an agent, **Then** the prompt carries its hint, which names the page files to read.

### User Story 7 - Audit a project on any stack (Priority: P1)

The project is a PHP Slim 4 site with Twig, a Laravel app, a Rails app, or anything else the static checks do not read. Its stack is detected from its files, and each static check runs only on a stack it understands. Twig, Blade and ERB templates have their own static probes (`src/checklists/templates.ts`). The others say "not checkable statically for <stack>: left to the agent audit". "Audit with agent" starts a session that reads the code and templates for that stack, and records an answer for each open item with its evidence: pass, fail, or na with a reason. "Fix with agent" does the same and fixes the failing items first.

**Independent Test**: attach `marketing-site` to a folder with `composer.json` (slim/slim, twig/twig) and `templates/*.twig`. `trb checklist stack` names `php-slim-twig` with the composer line as evidence; the custom 404 check reads "unknown: not checkable statically for php-slim-twig". `trb checklist audit marketing-site` starts a session whose prompt names the stack and lists every open item; each answer the agent records shows its source as agent, with the file and line it read.

**Acceptance Scenarios**:

1. **Given** a Twig site, **When** I run the checks, **Then** no Next-only check reports a pass or a fail, and each says why it is unknown.
2. **Given** an open item the checks cannot judge, **When** the audit agent records pass with a file and line, **Then** the item shows pass with source agent, and a later "Run checks" leaves it alone.
3. **Given** a required item the agent marks n/a with a reason, **When** I deploy prod, **Then** the item does not block the deploy.
4. **Given** an item a person ticked by hand, **When** the agent tries to record it, **Then** the record is refused until the tick is removed.
5. **Given** a manual item, **When** the agent is asked about it, **Then** the agent reports what it sees and does not record it.

### Edge Cases

- A URL that answers nothing is unreachable: the HTTP checks say unknown and the repository decides.
- A folder with no recognised framework is "unknown". A folder with package.json dependencies and no framework is "node", which the dependency checks read.
- A crawl stops at 30 pages. Links beyond it are reported as unknown, not as broken.
- A check that finds a leaked key names the kind of key and where it is, and never echoes the value.
- A `.env` file that is not git-ignored fails the secrets check.
- Icons stay PNG: the image format rule skips favicon and apple-icon files, but the size rule still applies to them.

## Requirements

### Functional Requirements

- **FR-001**: The built-in checklists MUST be data (`src/checklists/catalog.ts`): marketing-site, saas-app, mobile-release, api-service. Each item has a kind (auto, agent, manual) and a severity (required, recommended).
- **FR-002**: An auto item MUST name a check. An agent or manual item MUST NOT.
- **FR-003**: The CTA above the fold and the sticky mobile CTA MUST be agent items. They MUST NOT be faked by a check.
- **FR-004**: Static checks MUST read only the workspace folder. HTTP checks MUST use an injected fetch, crawl at most 30 same-origin pages, and probe only the paths listed in `checks.ts`.
- **FR-005**: A check MUST return pass, fail or unknown with evidence (a repo path or a URL) and a message. Unknown MUST say why.
- **FR-006**: A manual tick MUST pin the item against automatic runs until it is unticked.
- **FR-007**: A fix pass (`startFixSession`, "Fix with agent") MUST take the failing and unknown items of the attached checklists. Each session's prompt MUST carry the stack, every item of its chunk with its hint, and the manual items as left for a person. It MUST open a session titled "Checklist fix: …" in the workspace and refuse when nothing is open. (Was `fixPrompt` and "Checklist audit: …"; see Storage and Lab integration.)
- **FR-008**: A prod deploy MUST be refused while a required item of an attached checklist is not passing, unless `force` is set. Other environments MUST NOT be gated.
- **FR-009**: `defaultChecklistsFor` MUST map saas-next to saas-app and marketing-site, expo-app to mobile-release, vite-react and nextjs to marketing-site, and hono-api to api-service.
- **FR-010**: No response, CLI output or check message MUST contain a secret value.
- **FR-011**: The `seo`, `cro` and `copywriting` checklists MUST carry the `marketing` and `web` tags, so `defaultChecklistsFor` gives them to everything that gets `marketing-site`. Their items MUST NOT duplicate marketing-site's (presence checks); they test length, uniqueness, validity and content.
- **FR-012**: The HTML parser MUST read the visible text (no scripts, styles or head; block elements end a sentence), headings, links and buttons with their text, forms and their field counts, JSON-LD validity, hreflang, the X-Robots-Tag header, and the sitemap with the status of each URL. It MUST stay pure and dependency-free, with `fetch` injected.
- **FR-013**: The reading-level check MUST use a syllable heuristic and the Flesch reading ease, with no dependency. A page with fewer than 30 words is not judged, and says so as unknown.
- **FR-014**: The stack of a folder MUST be detected from its files and manifests, never by running anything, and MUST return the stack, the template extensions and the evidence (`src/checklists/stack.ts`). The stacks are nextjs, nuxt, astro, sveltekit, remix, vite-spa, plain-static-html, hugo, jekyll, eleventy, php-slim-twig, laravel, symfony, wordpress, rails, django, flask, expo, node and unknown.
- **FR-015**: A static probe MUST declare the stacks it understands, and MUST NOT run on any other stack. The item then reads unknown with "Not checkable statically for <stack>: left to the agent audit". It MUST NOT report a pass or a fail. Crawl (HTTP) checks are unchanged.
- **FR-016**: An item MUST be able to be `na` (not applicable), and an `na` MUST carry a reason. A required item is settled by pass or na. Fail and unknown MUST block a prod deploy. Items record a source: auto, agent or manual. The state is a file per checklist (see Storage and Lab integration), and rows from the old tables are imported once.
- **FR-017**: An agent's answer (`checklist_record`) MUST take the checklist id, the item id, status pass, fail or na, evidence (a file and line that exists in the project, or a URL) and a note. It MUST be refused for a session that is not a registered checklist audit, for an unknown or unattached id, for a manual item, for an item a person ticked, for an na without a reason, and for a pass without evidence. The workspace comes from the audit registration, never from the arguments.
- **FR-018**: The checklist tool MUST be offered to an audit session without treeboss mode: the run carries `TRB_CHECKLISTS`, set only for a session the Lab registered as a checklist pass, and the trb MCP server advertises the tool only then.
- **FR-019**: A run of the checks MUST NOT overwrite an agent's answer with unknown. It MAY overwrite it with a pass or a fail from a check that ran.
- **FR-020**: `GET /api/workspaces/:id/checklists/stack` MUST return the detection. `POST /api/workspaces/:id/checklists/audit` MUST take `{checklistId?, fix?}` and return `{sessionId}` (201). The CLI MUST offer `trb checklist audit [<id>] [--fix]` and `trb checklist stack`. Routes and CLI keep their paths and names through the storage change.
- **FR-021**: The checklist state MUST be `lab/checklists/<id>.md` in the workspace: front matter (id, title, attached_at, last_run), then one line per item under its category. Attaching creates the file; detaching removes it. A run or an answer changes only the lines it answers and last_run. A person may edit or commit the file, and the deploy gate reads it.
- **FR-022**: A failing item MUST be a Lab finding, one per item, with `checklist: <checklistId>/<itemId>`, lens `checklist`, impact high for a required item and medium otherwise, and the hint as its first step. A pass MUST set that finding to shipped. Dismissing it in Lab MUST mark a recommended item n/a with the note "dismissed in Lab"; reopening clears that mark. A required item MUST refuse the dismissal, with the reason.
- **FR-023**: Every Lab pass prompt MUST name the detected stack and the evidence for it (`src/stack.ts`, read through `src/lab/stack-context.ts`).
- **FR-024**: A run of the checks with a URL MUST judge the layout items `cta-above-fold` and `sticky-mobile-cta` from screenshots of the served page (`src/checklists/screens.ts`, `screens-browser.ts`). The judge MUST only refute: it writes a fail over an agent's pass or an unanswered item, and it MUST NOT write a pass, so FR-003 holds. It MUST NOT override a person's tick, an n/a or an agent's own fail. When a later run sees the call to action, it MUST take back its own refutation, and the item is unanswered again for an agent to answer. The pictures and verdicts are kept under `lab/checklists/shots/<checklistId>/`, and an item's `verification` says whether an agent's pass was checked against them.
- **FR-025**: A check's message MUST be kept on the answer line (`message`), and an agent's reason (`reason`) and a person's note (`note`) MUST be separate keys, so none overwrites another. A `note` on an agent line from before `reason` existed reads as its reason.
- **FR-026**: Removing a project item, detaching a checklist, a reconcile that drops an item, and deleting a custom checklist MUST ship the matching Lab findings (`shipChecklistFindings` in `src/lab/findings.ts`). Disabling a required item MUST be refused, as its dismissal is (FR-022).
- **FR-027**: Store screenshot sizes MUST be read from the PNG and JPEG headers (`src/checklists/image-size.ts`). The URLs the pass can run against MUST be listed in the fix prompt (`src/checklists/urls.ts`).

### Key Entities

- **Checklist**: id, title, summary, appliesTo tags, items. Built in.
- **Attached checklist**: workspace, checklist id, attach time.
- **Item state**: a line in the checklist's file: status (pass, fail, na or unknown), source (auto, agent or manual), evidence, the check's message, the agent's reason and the operator's note.
- **Checklist pass**: a Lab sweep of the lens `checklist`. Its chunks are about ten items each, by category; each chunk is one session.
- **Audit session**: a session the Lab registered for a workspace (`lab_checklist_sessions`). Only a registered session may record.

## Storage and Lab integration

The checklist state moved out of SQLite into the project, and the audits moved into Lab. The rules:

- **Files, not rows.** `lab/checklists/<id>.md` holds the attachment and each item's answer (src/checklists/files.ts). The format, one line per item:

  ```
  ---
  id: marketing-site
  title: "Marketing site"
  attached_at: "2026-10-28T09:00:00.000Z"
  last_run: "2026-10-28T09:12:44.000Z"
  ---
  ## SEO
  - [ ] Meta title on every page {#meta-title} (status: fail) (source: auto) (evidence: app/layout.tsx:12) (note: no title export)
  - [x] Search Console verified {#search-console} (status: pass) (source: manual)
  ```

  The checkbox mirrors the status (pass and na are ticked); the status field is what is read. Lines are matched by `{#id}`, so a line can move under its heading. Writes go through a temporary file and a rename.
- **One import.** On the first read of a workspace, rows in `workspace_checklists` and `checklist_items` are exported to files for the checklists that have no file yet. The reason and the operator's note are split into their own keys. The old tables stay where they are and are not read again; `checklist_imports` records the workspace, so a file a person deleted is not brought back.
- **Findings.** A failing item becomes a Lab finding (src/checklists/findings.ts). A check or an agent that fails it again refreshes the same finding; a pass ships it. A dismissal in Lab marks a recommended item n/a, pinned as a manual answer, so the checks leave it alone; reopening clears the mark. A required item is never dismissed.
- **Audits are Lab passes.** `startAuditSession` and `startFixSession` launch the lens `checklist` through the sweep runner (src/checklists/launch.ts, src/checklists/plan.ts): the open items are chunked by category into sessions of at most ten, run bounded in parallel and restart-safe, and each session is registered for its workspace before its first turn. `audits.ts` and the `checklist_audits` table are gone; the registry is `lab_checklist_sessions` (src/lab/tables.ts).
- **The record tool is a Lab tool.** `checklist_record` (src/checklists/tools.ts) takes the workspace from the registered session, never from the arguments. A plain Lab pass still writes its findings as files (lab/findings/), as before: an agent cannot always reach the MCP tools, so a validating `lab_finding` tool would only add a second path that fails on engines without them.
- **Stack for every pass.** `src/stack.ts` holds the detection. `src/checklists/stack.ts` re-exports it, so existing imports keep working.
- **The deploy gate reads the files.** `launchBlockers` keeps its meaning: a required item blocks unless it is pass or na.
- **UI.** The Checklists panel shows each failing item's finding; the Lab findings list filters the checklist lens and shows the item it belongs to. The Lab picker offers the runnable lenses only.

## Success Criteria

- **SC-001**: `bun test tests/checklists.test.ts tests/deploy.test.ts tests/lab*.test.ts` passes, with the file format, the import, the finding and dismissal round-trips, the blocker, the sweep chunking and the stack-in-prompt tests in it.
- **SC-002**: `bun run typecheck` passes.
- **SC-003**: On a Twig or Laravel fixture, no Next-only static check reports a pass or a fail.
- **SC-004**: A real local server audited with the HTTP checks gives the same pass and fail results as the fake-fetch tests for the same pages.

## Assumptions

- A workspace is a folder the operator works in. Checklists attach per workspace, not per product.
- Checks are heuristics on HTML and files. A pass is evidence, not proof. The agent and manual items exist for what a machine cannot judge.
- The fix agent runs through the normal session path and is told not to tick items itself.
