# TreeBoss roadmap

<!--
This file is the roadmap. Edit it here or from the Roadmap view; both write the same text.

  ## Now            an H2 is a lane. Rename, add or reorder lanes freely.
  - [ ] Title {#r1} (spec: specs/003-chat) (docs: docs/architecture.md) (tag: infra) (target: 2026-Q4)
    Indented lines under an item are its description.
  - [x] A checked item is shipped.

(spec: ...) points at a specs/ folder: its tasks.md drives the progress bar.
(docs: ...) points at any file or folder. (tag: a, b) can list several. (target: ...) is a date,
a month (2026-11) or a quarter (2026-Q4). {#rN} is the item's id: the app adds it on first edit, keep it.
-->

## Now


## Next

## Later

## Done

- [x] Engine usage limits on hover {#r1} (spec: specs/108-engine-usage-limits-hover) (docs: docs/ARCHITECTURE.md)
  Hovering the engine icon in the composer shows the plan windows the engine last reported (Claude's 5-hour window, what is left, when it resets) and how long ago.
  Claude's numbers come from its own stream. Grok's come from a short `grok agent stdio` session, and Cursor's from its dashboard API with the token in its CLI auth file.
  Grok and Cursor are read at most every 5 minutes, and the daemon stores the last reading.
- [x] Investigation runs {#r2} (spec: specs/106-investigation-runs) (docs: README.md)
  Creating an investigation starts an agent run that reverse-engineers the target with the browser or REA, and each run is kept with its live status.
  Several runs per investigation, Run again reopens a closed one, and a refusal (evidence off, no browser, no REA, a missing path) is shown with its reason.
- [ ] Plan usage for Codex in the Usage card {#r15} (spec: specs/121-plan-usage-every-engine)
  Codex's 5-hour/weekly/monthly windows from its token_count rate_limits. OpenCode and Antigravity still have no source.
- [ ] pstack in the core {#r16} (spec: specs/120-pstack) (docs: README.md) (tag: factory, skills)
  Cursor's pstack workflow ships built in: its skills and agents are seeded on start, two Hydra recipes run its team (one with a Codex builder), and a practice pack writes its principles into AGENTS.md.
  Upstream updates come through a vendor script, and an edited copy is kept. A skill the pack drops is retired, and a SHA-256 per vendored file is checked by tests.
  Still open: the full test run and the proof on an empty home.
- [x] Releases and changelog {#r14} (spec: specs/119-releases-changelog) (docs: README.md) (tag: factory, deploy)
  A release covers a range of commits from a base the operator picks (a tag, a commit or a date). An agent drafts the changelog for that range, the operator edits it, and publishing bumps the version files, commits and tags. `trb release` and the Factory's Releases page drive it.
  A product note can be published, a monorepo release picks its package folder, and `trb release undo` reverts a published release.
  Live checks: a run against a real GitHub remote, and a draft with a real engine.
- [x] Launch checklists {#r13} (spec: specs/118-launch-checklists) (docs: README.md) (tag: factory, deploy)
  What must pass before a product ships, with automatic checks against a dev server or deploy URL. A prod deploy is refused while a required item is open, unless forced.
- [x] Target detection and REA readiness {#r3} (spec: specs/107-target-detection-rea-readiness) (docs: README.md)
  Investigations work out their target kind from the target itself (web, Electron, binary, Android or other), and the kind and its reason are shown.
  treeboss checks what REA needs (Ghidra and its JDK, apktool, adb, the jadx jar) in trb doctor and Settings > MCP > rea, and passes the engine paths to REA itself.
- [x] Practice packs {#r12} (spec: specs/117-practice-packs) (docs: README.md) (tag: factory, quality)
  Built-in maintainability rules (KISS, YAGNI, smart and dumb components, strict types, design tokens and more) written into each workspace's AGENTS.md, with mechanical checks where a rule can be checked.
- [x] Signals loop: Sentry, PostHog and feedback into the roadmap {#r11} (spec: specs/116-signals-loop) (docs: docs/ARCHITECTURE.md) (tag: factory, signals)
  Sentry issues, PostHog metrics and a feedback widget (a public token endpoint) come in as signals. Triage turns one into a finding, a roadmap item or a session, or ignores it.
  Sync runs on `trb signals sync` or from a `signals_sync` schedule.
- [x] Mobile pipeline with Expo and EAS {#r10} (spec: specs/115-mobile-pipeline) (docs: docs/ARCHITECTURE.md) (tag: factory, mobile)
  Cloud builds, store submissions and over-the-air updates through `eas-cli`, a store listing check, and an Expo Go preview with a QR code.
  Live check: a real build, submit and update. It needs an EAS account.
- [x] Deploy targets, rollback, domains and releases {#r9} (spec: specs/114-deploy-release) (docs: docs/ARCHITECTURE.md) (tag: factory, deploy)
  Cloudflare, Vercel, Fly and a custom command per environment, with a deploy history and rollback to the previous live artifact. `trb domain` points DNS at a target. `trb release` bumps the version, writes the changelog and tags.
  Live checks: the fly and wrangler rollback forms against the installed CLIs. They need `flyctl` and `wrangler`.
- [x] CI workflow and PR flow from sessions {#r8} (spec: specs/113-ci-pr-flow) (docs: docs/ARCHITECTURE.md) (tag: factory, ci)
  `trb ci init` writes a GitHub Actions workflow from the project's checks. `trb pr` pushes a session's branch, opens its PR, reads the checks and merges, through `gh`.
  An autopilot run started with `--open-pr` (opt-in) waits on the checks of the PR it opened.
- [x] Products and portfolio {#r4} (spec: specs/109-products-portfolio) (docs: docs/ARCHITECTURE.md) (tag: factory, products)
  A product is what you ship: its repos (workspaces attached to it), a status from idea to archived, and a monthly budget. `trb portfolio` shows every product with its roadmap progress, last verify and spend against budget.
- [x] Environments and encrypted secrets {#r7} (spec: specs/112-envs-secrets) (docs: docs/ARCHITECTURE.md) (tag: factory, security)
  Per-workspace dev, staging, prod and custom environments. Values are encrypted at rest and reach the dev server, deploys, mobile builds and signal sources only on the server side. `trb secret` and `trb env` manage them.
  A session's worktree outside the workspace folder gets its workspace's secrets too.
- [x] Golden stacks {#r6} (spec: specs/111-golden-stacks) (docs: docs/ARCHITECTURE.md) (tag: factory, scaffold)
  The `saas-next` (auth, billing, database, observability) and `expo-app` recipes scaffold a project with its template files and a generated CI workflow in one run. The `saas-monorepo` recipe runs one generator per subfolder, and the editor shows the template files.
  Live checks: a real scaffold type-checked against the current APIs, and the Better Auth, Stripe and Sentry APIs checked against their current releases. Both need network access.
- [x] Autopilot queue and schedules {#r5} (spec: specs/110-autopilot-queue-schedules) (docs: docs/ARCHITECTURE.md) (tag: factory, autopilot)
  The daemon works through a spec's open tasks one at a time, checks each, ticks it, and stops at the gates the operator chose. Cron schedules run prompts, dependency updates, lab sweeps and project checks.
  A run started with `--open-pr` (opt-in) opens a pull request per task and waits for its checks before it ticks the task.
