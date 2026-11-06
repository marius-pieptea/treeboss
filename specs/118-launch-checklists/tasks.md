# Tasks: Launch checklists

- [x] T001 Catalog of four checklists as data, with kinds, severities and recipe-to-checklist defaults
- [x] T002 Static checks over fixture folders (web, mobile, API, secrets, CI)
- [x] T003 HTTP checks: crawl up to 30 pages, probe paths, soft 404, redirects, with an injected fetch
- [x] T004 Item state, manual pinning, attach and detach, lazily created tables
- [x] T005 Auto-check runner with one run per check, and the fix prompt and session
- [x] T006 Deploy gate on prod, with force threaded through the run route and the CLI
- [x] T007 HTTP routes and the `trb checklist` CLI
- [x] T008 Web panel: progress, items by category, run with a URL picker, fix, attach
- [x] T009 Tests for the checks, state, the gate and the routes
- [x] T010 Register the routes, the CLI command and the factory tab (routes in src/daemon/server.ts, `trb checklist` in src/cli/main.ts, and the panel as the Checklists view of the Lab tab in web/src/features/lab/LabTab.tsx, not a factory page)
- [x] T011 A screenshot-based judgement for the CTA items: a refute-only screen judge on Run checks (src/checklists/screens.ts, screens-browser.ts; judgements under lab/checklists/shots/<id>/; `ItemState.verification`). It withdraws its own refutation when a later run sees the CTA and never writes pass
- [x] T012 Check store-screenshot sizes from image headers, not by hand (src/checklists/image-size.ts; the catalog hint is updated)
- [x] T013 SEO (16 items: 14 auto, 1 agent, 1 manual), Conversion (12: 7 auto, 4 agent, 1 manual) and Copywriting (9: 6 auto, 3 agent) checklists in the catalog, tagged marketing and web
- [x] T014 Parser reads visible text, headings, actions, forms, JSON-LD validity, hreflang, X-Robots-Tag and the sitemap with each URL's status; `/pricing` is probed
- [x] T015 Readability: syllable heuristic and Flesch reading ease, no dependency
- [x] T016 Static probes for titles, descriptions, robots, noindex, image sizes, placeholder copy, pricing; HTTP probes positive and negative through a fake fetch; defaults and fix prompt
- [x] T017 Scaffold recipes list their checklists explicitly (src/scaffold/recipes.ts). The Next.js and Vite + React recipes list `["marketing-site", "seo", "cro", "copywriting"]` and the Hono API recipe lists `["api-service"]`
- [x] T018 Sales-page judgement items get served URLs in the fix prompt (src/checklists/urls.ts)
- [x] T019 The CRO page speed budget reuses perf-budget, so no separate item was added
- [x] T020 Stack detection from files and manifests, with evidence and template extensions, for the stacks in FR-014 (`src/checklists/stack.ts`)
- [x] T021 Static probes declare their stacks (`stacks` on each probe, enforced by the `Probes` type); a probe on another stack reads unknown with the reason (FR-015)
- [x] T022 Item status `na` with a required reason, and source `agent`; `reason` column added lazily; launch blockers treat na as settled and unknown as blocking (FR-016)
- [x] T023 `checklist_record` tool for audit sessions: `TRB_CHECKLISTS` on the trb MCP server, the daemon accepts it only from registered audit sessions, ids validated against the workspace (FR-017, FR-018)
- [x] T024 `startAuditSession` with the stack and its evidence, every open item, the hints and the recording rules; fixPrompt and "Fix with agent" cover unverified items (FR-007)
- [x] T025 Routes `POST …/checklists/audit` and `GET …/checklists/stack`; CLI `trb checklist audit [<id>] [--fix]` and `trb checklist stack` (FR-020)
- [x] T026 Web panel: detected stack, "Audit with agent", "Fix with agent" as audit and fix, na with its reason, source badges, not-verified count, link to the audit session
- [x] T027 Tests: stack fixtures (Next, Slim and Twig, Laravel, Rails, plain HTML, Django, Flask, Expo, Node, unknown), gating on a Twig fixture, record validation, blocker semantics, the audit prompt, the run config and the routes
- [x] T028 Agent answers are checked against the screenshot: the screen judge refutes a pass the served page contradicts and marks one it agrees with as checked (src/checklists/screens.ts). Other judgement about the served site is still a person's
- [x] T029 Stack-specific static probes for Twig, Blade and ERB (src/checklists/templates.ts)
- [x] T030 Checklist state as `lab/checklists/<id>.md`: parser and serializer with line-level atomic edits, the SQLite attachment and item tables no longer used, one import on the first read (src/checklists/files.ts, store.ts)
- [x] T031 Failing items as Lab findings with `checklist: <id>/<item>`, one per item; pass ships; Lab dismissal marks a recommended item n/a and a required one is refused (src/checklists/findings.ts)
- [x] T032 Audits and fixes as a Lab sweep of the `checklist` lens, chunked by category at about ten items, registered per workspace before the first turn; audits.ts removed (src/checklists/plan.ts, launch.ts, src/lab/tables.ts)
- [x] T033 `checklist_record` kept as the Lab tool, workspace from the registration; no `lab_finding` tool, for the reason in the Storage section
- [x] T034 Stack moved to src/stack.ts with a re-export; every Lab pass prompt names the stack and its evidence (src/lab/stack-context.ts)
- [x] T035 UI: finding link on each failing item, lens filter and item link in the Lab list, runnable lenses only in the picker
- [x] T036 Tests: file round-trip and in-place edits, the import, fail-to-finding and pass-to-shipped, dismissal round-trip and the required refusal, the deploy gate from files, sweep chunking, stack in lab prompts
- [x] T038 A check's message is kept: a `message` key on the answer line (src/checklists/files.ts), read in `viewOf`
- [x] T039 A separate `reason` key: an old `(note:)` on an agent line reads as reason, the legacy import splits them, and a note no longer overwrites the reason (src/checklists/files.ts)
- [x] T040 The catalog is editable: `<home>/checklists.json` holds the operator's overrides of built-ins and the custom checklists; the effective catalog (built-ins with their overrides, then custom) is what every reader uses (src/checklists/custom.ts)
- [x] T041 Validation: kebab-case checklist and item ids, unique item ids, a hint on every item, severity required or recommended, kind auto only with a `check` that is a CheckId from checks.ts, and no check on an agent or manual item
- [x] T042 Built-ins show as modified when overridden, and "reset to default" removes the override; an override equal to the shipped content is dropped; a fork copies what it leaves out; a custom checklist can be deleted, a built-in cannot (it is reset)
- [x] T043 Project-only items: `(custom)` lines in lab/checklists/<id>.md carry their own category, severity, kind and hint; a file from before this parses as it did (src/checklists/files.ts, project.ts)
- [x] T044 Disable an item for this project: status na, source manual, note "disabled for this project", pinned like a tick; its open finding ships; enabling clears the answer
- [x] T045 Reconcile on every read: a new item starts unknown, a removed catalog item's line is dropped, a changed text or category is rewritten with its answer kept, and project items are kept (files.ts reconcileChecklistFile)
- [x] T046 Routes: GET /api/checklists/catalog, GET/PUT/DELETE /api/checklists/catalog/:id, POST /api/checklists/catalog (with forkOf), POST /api/checklists/catalog/:id/reset; per project POST …/checklists/:id/items, PATCH item with disabled, DELETE a project item (src/daemon/routes/checklists.ts)
- [x] T047 CLI: `trb checklist new|edit|reset|rm` (edit opens the JSON in $EDITOR or reads --file) and `trb checklist item add|disable|rm` (src/cli/commands/checklists.ts)
- [x] T048 Web: ChecklistsEditor (checklists with built-in, modified and custom badges; title, summary and tags; items with text, category, severity, kind, check only for auto, hint, up and down; add, delete, fork, reset, delete), a Checklists page in Settings, "Manage checklists", "Disable for this project" and "Add item to this project" in the panel (web/src/features/checklists/)
- [x] T049 Tests: tests/checklists-custom.test.ts (merge, override and reset, validation, reconcile keeps state, per-project disable and custom items round-trip, the routes) and tests/web/checklists-editor.test.ts (form, moves, validation)
- [x] T050 Deleting a custom checklist ships its open findings in every project (src/checklists/custom.ts, `shipChecklistFindings`)
- [x] T051 Removing a project item, detaching a checklist, or a reconcile drop ships the matching findings (`shipChecklistFindings` in src/lab/findings.ts)
- [x] T052 Disabling a required item is refused, like dismissal (FR-022)
- [x] T053 The editor and the panel are browsed at about 1100px, 1440x900 and 1920x1080, light and dark; the `$EDITOR` path of `trb checklist new|edit` is quoted (src/cli/commands/checklists.ts)

## Known gaps

These are choices, not open tasks. They are not checkboxes, so the specs view does not count them.

- T037 Lab sorts findings by payoff, which is impact over effort, by design. The Lab's Checklists view shows the checklist's own order.
- T050 (the leftover) Deleting a custom checklist leaves its per-project file (`lab/checklists/<id>.md`) in place. The answers are kept, and the checklist is no longer listed or run. This is on purpose: deleting committed files in other repos is not trb's call.
