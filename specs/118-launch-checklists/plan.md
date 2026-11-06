# Plan: Launch checklists

- `src/checklists/catalog.ts`: the four checklists as data, `CheckId`, and `defaultChecklistsFor`.
- `src/checklists/checks.ts`: static probes over a `Repo` (files, package.json, app config, workflows); HTTP probes over a `SiteAudit` (a crawl of up to 30 pages plus the probe paths, with an injected `FetchFn`); `makeChecker`, which prefers the served site and falls back to the repo. Pure `parsePage` reads HTML with regexes.
- `src/checklists/store.ts`: tables `workspace_checklists` and `checklist_items` (created lazily). `attach`, `detach`, `listAttached`, `showAttached`, `setItem`, `runAutoChecks`, `fixPrompt`, `startFixSession` (via `createLead`), `launchBlockers`.
- `src/deploy/store.ts`: `runDeploy(targetId, { force })` refuses a prod run while `launchBlockers` is non-empty. Only `runDeploy` is gated.
- `src/daemon/routes/checklists.ts`: the catalog, attach, detach, item PATCH, run, the URL picker list, and fix.
- `src/daemon/routes/deploy.ts` and `src/cli/commands/deploy.ts`: `force` passed through (one line each).
- `src/cli/commands/checklists.ts`: `trb checklist ls|attach|detach|show|check|tick|fix`.
- Web: `web/src/features/checklists/data.ts` (queries and mutations) and `ChecklistPanel.tsx` (progress, items by category, run with a URL picker, fix with agent, attach).
- `src/checklists/screens.ts` and `screens-browser.ts`: a headless browser measures the served page and the module judges the two layout items from the measurements. It can refute and never pass. `image-size.ts` reads PNG and JPEG sizes, `urls.ts` lists the URLs for the Run menu and the fix prompt, and `templates.ts` holds the Twig, Blade and ERB probes.
- Tests: `tests/checklists.test.ts` (catalog, static checks on fixture folders, HTTP checks with a fake fetch and the crawl cap, state and pinning, the fix prompt and session, the deploy gate, routes).

Registered outside this folder: the routes in `src/daemon/server.ts`, the CLI in `src/cli/main.ts`, and the panel as the Checklists view of the Lab tab (`web/src/features/lab/LabTab.tsx`). The README describes launch checklists and the ROADMAP lists the item.
