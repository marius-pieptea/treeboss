# TreeBoss guide

Everything TreeBoss does, section by section. Start with the [README](../README.md) for what it is and how to install it.

- [Factory](#factory)
- [Hydra](#hydra)
- [The UI](#the-ui)
- [Specialized agents](#specialized-agents)
- [Plan mode](#plan-mode)
- [Specs](#specs)
- [Docs](#docs)
- [Roadmap](#roadmap)
- [Design systems](#design-systems)
- [Context, compaction and handoff](#context-compaction-and-handoff)
- [Checkpoints and rewind](#checkpoints-and-rewind)
- [Verify before done](#verify-before-done)
- [Evidence](#evidence)
- [CodeGraph](#codegraph)
- [Run the app, and pick elements in the preview](#run-the-app-and-pick-elements-in-the-preview)
- [The agent browser](#the-agent-browser)
- [MCP servers and skills](#mcp-servers-and-skills)
- [Safety model](#safety-model)
- [Providers and subscriptions](#providers-and-subscriptions)
- [Settings](#settings)
- [How it fits together](#how-it-fits-together)
- [Development](#development)

## Factory

A **product** is a thing you ship: its repos (workspaces attached to it), a status from idea to archived, and an optional monthly budget. `trb portfolio` shows every product with its roadmap progress, last verify result and spend against budget. The rest of the loop runs in the same daemon:

- **Golden stacks.** Built-in recipes for the scaffolder: `saas-next` (Next.js with auth, billing, a database, health and analytics) and `expo-app` (Expo with TypeScript, EAS config, store metadata and Sentry). The generator runs first; template files then add what it cannot, including a `.github/workflows/ci.yml`.
- **Autopilot.** `trb autopilot start <spec>` works through the spec's open tasks one at a time, checks each one, ticks it, and stops at the gates you chose (`--approve-every N`, `--approve-merge`). `trb autopilot ls|show|pause|resume|stop|approve|reject`. Cron-style jobs run from `trb schedule add "<name>" --cron "<m h dom mon dow>" --kind prompt|lab_sweep|verify|deps_update|signals_sync`.
- **Environments and secrets.** `trb env add|rm|ls` (dev, staging and prod always exist) and `trb secret set|unset|ls|import|export [--env E]`. Values are encrypted with AES-256-GCM under a master key at `<home>/secrets.key` (0600). The daemon injects them into dev servers, deploys, mobile builds and signal sources. `trb secret export` writes a 0600 `.env` file when a tool needs one.
- **CI and pull requests.** `trb ci init` shows, then `--write`s, `.github/workflows/ci.yml` built from the project's own checks (an existing file is kept unless you pass `--overwrite`). `trb pr create <session>` pushes the session's branch and opens its PR; `trb pr ls|checks <n>|merge <n>` follow it through.
- **Deploy, rollback, domains and releases.** `trb deploy targets add <env> <cloudflare|vercel|fly|command>`, then `trb deploy [env]`, `trb deploy history`, `trb deploy rollback [env]`. `trb domain add|check <domain> --target <host>` points DNS at a target. `trb release plan|cut patch|minor|major` previews, or writes, the version bump, changelog, commit and tag.
- **Mobile.** `trb mobile build|builds|submit|update|preview` drives Expo and EAS: cloud builds, TestFlight and Play internal submissions, over-the-air updates, and an Expo Go URL with a QR code. `trb mobile metadata` checks `store/metadata.json`.
- **Signals.** `trb signals sync` pulls Sentry issues and PostHog metrics. `trb signals widget` prints a feedback snippet for your site; its posts land as signals. `trb signals triage <id> to_finding|to_roadmap|to_session|ignore` sends what matters into the lab and the roadmap. `trb signals ls` lists them, most important first. A `signals_sync` schedule runs the same sync on its cron. The autopilot runner and the scheduler start with the daemon, so runs and jobs carry on without an open UI.
- **Practice packs.** Maintainability rules every agent in a workspace follows: KISS, YAGNI, smart and dumb components, strict types, test the logic, design tokens, accessibility basics and Ponytail. Three web-marketing packs (`cro`, `copywriting`, `seo`) hold rules only. A pack can also name skills, and each one renders as "Use the X skill if available". `trb practices ls`, then `trb practices enable|disable <id..>` writes the chosen rules into a managed block in AGENTS.md (mirrored to CLAUDE.md) and leaves your own text alone. `trb practices check [--all]` reports violations of the packs with mechanical checks (file and function length, `any`, raw colors, missing alt text). A new app from a recipe switches on that recipe's packs.
- **Launch checklists.** What must be true before a product ships: `marketing-site`, `seo`, `cro`, `copywriting`, `saas-app`, `mobile-release` and `api-service`. The `seo`, `cro` and `copywriting` checklists crawl the site for title and description length, duplicate titles, heading hierarchy, JSON-LD, sitemap-to-crawl sync, generic CTAs, form length, social proof, reading level, banned hype words and placeholder copy. Automatic checks run against a dev server or a deploy URL; the other items are ticked by hand or by an audit agent. The static checks read the repo only on the stack they understand (Next.js, plain HTML, Expo, Node and so on, see `trb checklist stack`); on any other stack they say "not checkable statically" and the audit agent reads the code and templates instead, recording each answer with its evidence. `trb checklist ls`, `attach|detach <id>`, `show <id>`, `check [--url U]`, `tick <id> <item>`, `audit [<id>] [--fix]` and `fix <id>`. A prod deploy is refused while a required item is open, unless it is `na` with a reason. The refusal lists the blockers; `trb deploy prod --force` (or **Deploy anyway** in the UI) goes ahead anyway. A new app from a recipe attaches that recipe's checklists.

The web UI has the same things in one **Factory** view (activity bar). Its tabs are Portfolio, Autopilot (runs, with the schedules below them), Ship (pull requests, deploys and releases), Practices, Mobile, Signals and Secrets. The launch checklists are in the **Lab** view (its Checklists tab). The command palette has a "Factory: …" entry for each tab, and the session header has **Open PR** for a session's branch.

The factory calls the CLIs of the targets you use, each already signed in. Install only the ones you need: `gh` (pull requests and checks), `wrangler` (Cloudflare), `vercel`, `flyctl` (Fly), `eas-cli` (Expo and EAS). `trb doctor` does not check them yet. Sentry and PostHog read their tokens from the `prod` environment:

```sh
trb secret set SENTRY_AUTH_TOKEN --env prod      # plus SENTRY_ORG and SENTRY_PROJECT
trb secret set POSTHOG_API_KEY --env prod        # plus POSTHOG_PROJECT_ID (POSTHOG_HOST optional)
```

## Hydra

A **pair** says who leads and what the heads run on. There are two modes, and a pair is exactly one of them:

```sh
# heads mode: every head runs the same config
trb pair add --title "Opus leads Sonnet" --lead claude/claude-opus-5-5@high --heads claude/claude-sonnet-5-5@medium --max-heads 4

# roles mode: every head names a role; the 12-role library supplies each role's standing instructions
trb pair add --title "Mixed" --lead claude/claude-opus-5-5@high \
    --role scout=claude/claude-haiku-5-5@low --role worker=codex --role reviewer=claude/claude-opus-5-5@high

trb pair recipes          # starting points      trb pair roles    # the role library
trb run -p "Mixed" "migrate the billing module to the new client"
```

Spec syntax is `engine[/model][@effort]`. A pair is **binding**: the lead cannot swap a head's engine or model, only the operator can. The lead gets seven tools through trb's MCP server: `subagent_create | wait | send | list | interrupt | close | merge`.

While a Hydra run is in flight the lead's tree is shown live, each head's lines indented under its role:

```
[claude] → mcp__trb__subagent_create(…)
  worker │ [claude] → Bash(mkdir -p docs && printf '# Notes\n' > docs/notes.md …)
  worker │ Created docs/notes.md …
[claude] → mcp__trb__subagent_merge({"id":"s_beac8579fe"})
```

You can also work a subagent by hand: `trb spawn <session> "brief" -r scout`, `trb diff <id>`, `trb merge <id>`, `trb close <id>`.

## The UI

`trb ui [dir]` registers the folder as a workspace and opens a browser already signed in (a single-use ticket is traded for an HttpOnly, SameSite=Strict cookie; the token never appears in a URL). `trb .` (or `trb <dir>`) does the same for a folder you name directly.

On Windows, the installer (`TreeBoss-Setup-<version>.exe`) offers four checkboxes, all on by default: "Open with TreeBoss" in the folder right-click menu, the same for files, registering TreeBoss as an editor for code and text files (listed under Open with; your default apps are not changed), and adding `trb` to your user PATH. Uninstalling removes all four.

| | |
|---|---|
| **Agent panel** (right) | Chat with the active session: streaming transcript, tool calls grouped ("Ran 3 commands, read 2 files"), markdown, a composer (see below) with engine / model / effort / pair / worktree pickers, `@file` mentions and `/commands`. |
| **Heads panel** (right) | The lead's subagents as live cards: role, engine, what each is doing right now, +/- stats, cost. Merge, diff, follow up, interrupt, close, spawn; `j`/`k`/`Enter`/`m` from the keyboard. Click a head for its own conversation, changes, files and turns. |
| **Explorer / Search** | Lazy file tree with git badges, create / rename / move / delete, and search across files (ripgrep when installed). |
| **Editor** | CodeMirror with language packs, git change gutter, find/replace, conflict-safe saves (an agent may have edited the file), live reload of external edits, image / markdown / binary viewers. |
| **Source control** | Stage and unstage files, hunks and single lines; commit with hook output; amend; branches (create, switch, merge, delete); fetch, pull, push; stashes; a commit graph; conflict resolution; worktrees. |
| **Terminal** | Real shells that survive reloads (scrollback replayed), per-terminal tabs, file links that open in the editor, a "dev server started" prompt. |
| **Browser** | A preview tab for your dev servers with device presets. Previews load on the other loopback name (`localhost` vs `127.0.0.1`) so the signed-in cookie never reaches your dev server. |
| **Settings** | Hydra pairs (heads or roles), MCP servers (with a Test button), skills (with an editor), engines and a doctor report, daemon settings. |

### The composer

One box, one slot above it, one row below it:

- **Status slot (above the box).** It shows exactly one thing, by urgency: a plan question the agent is blocked on, then a plan waiting for your decision (*Plan: title · Open · Skip plan · Approve and build*, only once a plan file is actually written and the turn is over), then a goal that is working (progress, last check, Stop), then the lead and its heads. A finished goal gives way to the heads. When nothing needs you the slot takes no room.
- **Footer row (below the text).** Left: `+` (attach specs, plans and docs, set a goal, mention a file; arrow keys and Enter work), then the engine and model chip (and the Hydra pair). Right: the **Build | Plan | Ask** control (a fixed width: the Quick plan / Spec it depth is a caret menu on the Plan cell and shows as its icon, so nothing moves when you switch), the context ring, settings (new sessions) and Send / Stop. At narrow panel widths the model name truncates first, then labels become icons; the row never wraps.
- **Plan mode is shown by the box itself**: a violet outline and the placeholder "Describe what to plan…". Ask mode rings the box in the accent colour with "Ask about this project…". `Alt+P` steps Build → Plan → Ask from anywhere in the box (Shift+Tab stays focus navigation); the palette has "Mode: Build/Plan/Ask" and "Ask a quick question…".
- Attachments and a goal chosen for the next session sit as small chips under the text, inside the box, only while they exist.

Shortcuts: `⌘P` go to file, `⌘K` / `⌘⇧P` command palette, `⌘B` sidebar, `⌘J` or `Ctrl+\`` terminal, `⌘I` focus the composer, `⌘⇧E/F/G` explorer / search / git, `Alt+W` close tab. `bun run dev:web` runs the UI with hot reload against a running daemon.

### Switching the model in a session

The model chip of a session that already exists changes the model for the NEXT turn, between turns, on the same engine (`PUT /api/sessions/:id/model { model?, effort? }`, the chip's picker, the palette's **Switch model…**, `trb model <id> [<model>|default] [--effort e]`). The engine itself is fixed for the life of a session (engines cannot share a session): start a new one to change it.

- **When it is locked.** While a turn runs; on a session governed by a Hydra pair ("Set by the pair": the lead asks you before changing a pair's models); on a closed session; and on an engine that cannot take a model on resume (`modelOnResume: false` in the registry; none today). Only the operator can switch: no subagent tool exposes it.
- **What it does.** One `UPDATE` plus a log line (`Model changed: opus → haiku (applies to the next turn)`); every turn reads the model from the session, so the next resume passes `--model`. The chip shows a dot until that turn starts. An id missing from the engine's catalog is accepted with a warning (catalogs lag new models). `default` clears it. A model you picked by hand wins over ask mode's cheap-model override and survives mode changes.
- **Cache honesty.** A new model has no cache of the conversation, so the first turn after a switch re-reads all of it at full price. The picker says so, and above 50k tokens of context it asks before switching and names the size. Changing only the effort keeps the cache.
- **Per engine** (the flag sits next to the resume flag in each CLI's `--help`; behaviour checked with a real turn only for claude):

| engine | resume flag | model flag on a resumed turn | effort |
|---|---|---|---|
| claude | `--resume` | `--model` (verified: a resumed turn took a new model id and `--effort`, and recalled the earlier conversation) | `--effort` |
| codex | `exec resume` | `-m` | `-c model_reasoning_effort` |
| cursor | `--resume` | `--model` | `--effort` |
| opencode | `--session` | `--model` | `--variant` |
| agy | `--conversation` | `--model` | none |
| grok | `--resume` | `-m` / `--model` | `--effort` |

### Ask mode

A third session mode for quick, read-only questions about a project ("where is auth handled?", "what calls `startTurn`?"). It stays in the session like the other modes: it is per turn and flips at any time (`PUT /api/sessions/:id/mode`, the composer control, `trb send --mode ask`).

- **Read-only, and only what it needs.** With a CodeGraph index in the project the agent gets `codegraph_explore` and `codegraph_node` plus `Read`; without one, `Read`, `Glob` and `Grep`. No shell, edits, web or subagent tools, and no plan tools.
- **Lean on purpose.** An ask turn materializes no skills, attaches none of your MCP servers (CodeGraph's only), injects no agent instructions or Hydra preamble, creates no worktree, and sends no attachments except ones you attached since the last turn. It carries a ~5 line preamble: answer directly in a few sentences, cite `file:line`, say when unsure, propose edits only if asked.
- **Cheap by default.** A NEW ask session starts on the engine's cheap model at low effort: the `ask_models` setting (`claude=claude-haiku-5-5,codex=gpt-5-mini`), else Haiku for claude, a mini/small model from codex's catalog, else the engine's own default. Pick another model in the model chip and that wins; a Hydra pair or agent keeps its own. Inside an EXISTING session the model is left alone (switching invalidates the prompt cache) unless `ask_model_override` is `on`, which runs just that turn on the ask model (claude and codex only: the others do not take a model on resume).
- **What the cost looks like.** Every ask answer has a muted footer with what the question cost (`$0.0012 · 4.8k in · 299 out`), and the newest answer offers **Turn into a plan** (switches to plan mode and sends "Turn the answer above into a plan.") and **Save as doc** (a dialog with the path and the files the answer cites; the page is written only when you click Save, with generated front matter so the Docs view tracks its freshness). Each session view carries `ask_cost_usd`, the sum of its ask turns.
- **CLI.** `trb ask "<question>"` (a lead in ask mode on the cheap model; prints the answer and what it cost; `-e engine -m model -C dir`), `trb run --ask`, `trb send <id> --mode ask`.

How each engine is held read-only (the same mechanisms as plan mode where they exist; "enforced" means the CLI refuses, "prompt" means the engine is only told):

| Engine | Ask mode | Enforced or prompt |
|---|---|---|
| claude | `--tools Read,Glob,Grep` (or `Read` with an index) and `--allowedTools` for the same plus the two CodeGraph tools: the other tools are not even offered | enforced |
| codex | `sandbox_mode="read-only"`, `approval_policy="never"` (as config, so it applies on resume too) | enforced for writes; it can still run read-only shell commands, which the preamble discourages |
| cursor | `--mode ask` | enforced |
| opencode | the `plan` agent, no auto-approve | enforced |
| agy | `--mode plan`, no permission skip | enforced |
| grok | no read-only switch: it stops auto-approving, so a headless run is refused anything that needs approval | prompt plus approval |

Measured once with real claude (Haiku 5.5, low effort, the same two-sentence question on a 3-file repo, isolated home): **ask 4.8k in / 299 out, $0.0012, 3 tools offered**; **build 21.4k in / 540 out, $0.0053, 26 tools offered** (and the build turn materialized a skill). With a CodeGraph index: ask 7.8k in / 365 out, $0.0018 (2 tools); build 33.8k in / 401 out, $0.0073 (27 tools). On a repo this small a grep is cheaper than CodeGraph's answer; the index pays off as the repo grows. One run each, so read these as an order of magnitude, not a benchmark.

## Specialized agents

An **agent** is a named profile: standing instructions, optional engine / model / effort defaults, and the **skills and MCP servers it may use**. Leave an assignment unset and MCP servers get everything enabled, while skills get the **default set** (`trb config set default_skills …`: every enabled skill unless you say otherwise; they are linked into the workspace for the turn, not copied, and kept out of git); name a list and it gets only those (an empty list means none).

```sh
trb agent add reviewer -d "reviews diffs" -i "Review, don't rewrite. Report bugs by severity." -s code-review --mcp docs
trb agent add --from-role debugger          # start from one of the 12 role presets
trb run -a reviewer "review my uncommitted changes"
trb spawn <session> "audit auth" -a security-auditor
```

An agent applies to a lead (`trb run -a`, or the picker in the UI composer), to a subagent (`subagent_create({ agent })`, which a lead's brief lists), and to a **Hydra pair role** (a role can name an agent; the role's own engine and effort still win). Instructions are delivered once, when a conversation starts; a resumed turn already has them. A globally disabled skill stays off even if an agent names it. A Hydra pair is the operator's binding choice and beats an agent's own engine preference.

Skill delivery was checked against the real engines: claude loads skills through its native Skill tool, codex and cursor read them from `.agents/skills` / `.cursor/skills`, and a restricted agent genuinely does not see skills outside its list.

### pstack

pstack is Cursor's workflow plugin. The lead restates the goal, routes the task to a playbook, and hands the code to fresh subagents that it reviews before anything ships. treeboss ships it built in, so there is nothing to install. Its skills and agents are in the daemon from the first start, marked **Built-in**. Edit, reset or delete them like any other skill or agent. Restore brings back what you removed.

- **Skills**: 57 skills ship. 56 are pstack's, with their text unchanged apart from LF line endings: `setup-pstack` and `make-bot-ui` are left out, and statechart's test corpus is excluded. The 57th is `pstack-treeboss`, the adapter that maps pstack's Cursor names onto treeboss.
- **Agents**: `poteto-agent` builds one unit at a time, with small verified commits. `comment-sicko` lists the comments to cut and deletes them only when its brief asks. `pstack-explorer` investigates and is read-only by instruction. `pstack-architect` sketches designs without writing code. `pstack-verifier` checks a change on the real surface and starts its reply with PASS, PASS+NOTES or FAIL.
- **Teams**: `pstack (Claude)` runs on Claude alone: Opus leads, designs and verifies, and Sonnet explores, builds and cleans. `pstack (Claude + Codex)` runs the builder on Codex, so the verifier, on Claude Opus, is a different model family from the builder. It needs Codex signed in.
- **Principles**: `trb practices enable pstack` writes eight of its principles, and links nine principle skills, into AGENTS.md and CLAUDE.md for every agent in the workspace.
- **Cost**: pack skills are on by default. With `default_skills` at its default, `all`, a session with no skills list of its own gets every enabled skill linked into its workspace each turn. On an engine with no skills folder, the built-ins are listed in its prompt instead. The 56 upstream skills set `disable-model-invocation`, so Claude does not load their descriptions; engines without that flag may list them. **Disable all** on the Skills page, or `trb skill pack pstack off`, turns them off.

```sh
trb pair add --recipe pstack-claude-codex
trb run -p "pstack (Claude + Codex)" "add rate limiting to the login route, with tests"
```

pstack is by Lauren Tan, MIT licensed, Copyright (c) 2026 Lauren Tan. The skills are its text at commit `c742dd6` of [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), version 0.15.36. Its agents and recipes adapt its text, as [NOTICE](../NOTICE) says. The license is kept at `src/skills/packs/pstack/LICENSE`. treeboss itself is under the PolyForm Shield License 1.0.0. To update the skills, run `bun scripts/vendor-pstack.ts <checkout>` on a clean checkout of cursor/plugins.

## Plan mode

A session in plan mode is read-only: the agent explores the code, asks you questions, and hands in a plan you approve before anything is built.

- Questions come one at a time through the `plan_ask` tool: 2 to 4 options, one marked recommended with a reason, a field for your own answer, and Skip. Keys `1`-`9` pick, `Enter` confirms, Back reviews earlier answers.
- The plan arrives through `plan_submit` and is **a file**: the daemon (never the agent, which is read-only) writes `plans/YYYY-MM-DD-short-name.md` in the workspace, with front matter (title, session, created, status, mode, version), your decisions, the numbered steps with their files, risks and open questions. The folder is created by the first plan only; `PUT /api/workspaces/:id/plans-dir` moves it (default `plans`).
- It opens in its own tab as soon as it lands, rendered, under a bar: **Approve and build** (leave plan mode and send "implement the approved plan in `<path>`" with a short summary and your answers), **Skip plan** (leave plan mode, the plan stays as superseded), **Ask for changes** (the agent revises the SAME file as version N+1 with a changelog line), **Edit** (the real editor on the file) and **Promote to spec**. The bar goes away once decided and leaves a status chip. The row above the composer has the same buttons (Open, Skip plan, Approve and build) and the thread keeps a compact "Plan ready: open" chip where the plan landed.
- What you approve is the file as it stands at that moment, edits included; a snapshot is kept in the database. Bookkeeping only ever rewrites the front matter's `status` line.
- **Two depths**, chosen from the caret on the Plan side of the Build|Plan control: a quick plan is that file; *Spec it* writes `specs/NNN-name/spec.md` and `plan.md` through the Specs module (the plan's summary becomes the input, your decisions the assumptions, open questions become clarification markers), and approving it opens the feature in the Specs view and leaves a **Generate tasks** button in the plan's bar (it becomes **Implement** once `tasks.md` exists) instead of building. **Promote to spec** converts an existing quick plan the same way and marks the plan file `promoted: specs/NNN-name`.
- Plans from before plan files keep working: they read from their stored text, can be approved as before, and **Write it to a file** gives them one.
- Headless: `trb plan <session> show` (path and current text), `answer <n|r|text>` (`r` takes the recommendation), `skip` (the question), `approve`, `skip-plan`, `changes "<note>"`, `promote`, `depth quick|spec`.
- An approved plan is attached to the session by reference (its path), so a handoff and goal-mode follow-up turns point at the file instead of repeating it; the text is used only if the file is gone.
- How it is held read-only: each engine's own switch where it has one. Claude's own plan mode refuses every MCP tool, so with the questionnaire wired claude runs on an allowlist instead (read, glob, grep, web, the plan tools, the code index; no shell, no edits). Codex gets a day-long tool timeout for `trb`, since `plan_ask` waits for a person. Other engines use their default tool timeout, so a question left unanswered for long enough can time out there; the agent is told and carries on.
- A pending question is cancelled when its turn ends (interrupt, close, failure) and when the daemon restarts. If the tools are unavailable the agent falls back to one numbered batch of questions in plain text: nothing is written, so there is no plan row, and you simply reply.

## Specs

A project's specifications live as files in the repository, in the layout Spec Kit uses, so the `specify` tool keeps working on the same folders:

```text
.specify/memory/constitution.md          the principles every feature is built under
specs/001-add-csv-export/spec.md         what it does and why (no implementation detail)
                         plan.md         how it will be built
                         tasks.md        `- [ ] T001 [P] [US1] Description with the exact file path`
                         research.md  data-model.md  contracts/  quickstart.md
```

trb is a lens over those files. Nothing is copied into the database except links (which session has which spec attached), so git keeps the history and every agent reads the same text. Nothing is created until you ask: the Specs view of an empty project shows two explicit buttons, *Create constitution* and *New feature*.

- **The Specs view** lists the constitution and the features with their status (draft, planned, tasked, in progress, done) and task progress. A feature opens as a workbench: a stepper for the workflow (*Constitution → Specify → Clarify → Plan → Tasks → Analyze → Implement*) that follows the files, a tab per document (the real editor for spec, plan, research, data model, contracts and quickstart), and the tasks as a checklist with `[P]` and `[US#]` chips, phases, a filter, and a box that rewrites exactly one character of `tasks.md`.
- **Steps are built-in prompts**, not slash commands: each says which files to read, which to write, and the exact formats, so any engine can run them. Run one in a new session or in the one that is open, with the engine, model, agent and pair you pick.
- **Attach specs to a conversation** from the composer's one attach picker (`+` then *Attach specs, plans, docs*: Specs, Plans and Docs in one list, one row of chips). By default the agent gets a short pointer (where the files are, a title, task progress, a few lines of summary) and reads them when it needs them, which costs a few hundred tokens. *Paste* puts the text in the prompt, up to a size cap, and the token estimate is shown on the chip. Attachments are delivered once, a handoff carries them to the next session, and a fresh replay after a refused resume gets them again. Whatever is attached reaches the agent as one `# Attached project files` block with a section per kind (specifications, plans, documentation), and `trb attachments <session> [path…] [--inline] [--detach]` does the same from the terminal (the kind follows from where the path lives).
- **Implement** starts a goal-mode session whose check is "no open box in `tasks.md`" (plus a test command if you give one). Boxes the agent reports done (`TASKS_DONE: T001, T002`) are ticked for it if it forgot. **Implement in parallel** opens one head per group of `[P]` tasks in the first parallel run, under a lead that merges them and carries on; with no heads pair it says so and runs sequentially. **Run this task** sends one task to the open session, a new one, or a head.
- **Discuss architecture** starts a read-only plan-mode session with the constitution and feature attached. It explores, asks through the questionnaire, and hands in a plan whose steps are changes to spec files. When you approve it, it may write those files and nothing else (it is told so, and a warning is logged if anything outside `specs/` and `.specify/` changed); afterwards the session goes back to plan mode for the next round.
- Files are reached only under `specs/` and `.specify/`, through the same path guard as the file API. With `.specify/init-options.json` set to `{"feature_numbering": "timestamp"}`, new features get timestamp prefixes instead of `001`.
- Headless: `trb spec ls | new "<name>" | constitution [init] | show <feature> | tasks <feature> | step <step> [feature] | attach <session> <feature> [--inline] | implement <feature> [--parallel] | architecture [feature]`.

## Docs

What the project *is* lives in `docs/` as markdown, next to the code (the folder can be changed per project). trb is a lens over those files: nothing about a page is copied into the database except which sessions have which page attached, so git keeps the history and an agent or an editor can change a page as easily as the UI can. Nothing is created until you ask: the Docs view of a project with no `docs/` shows *Create docs folder* and *Generate overview*, and looking never writes a file.

A page can say what it describes and when it was written, in front matter:

```markdown
---
title: Architecture
covers:                      # the paths this page is about: globs, files or directories
  - src/daemon/**
  - src/sessions/**
generated:                   # written by an agent (or by you, with *Mark current*)
  commit: 1a2b3c4d5e6f
  at: 2026-10-08T10:00:00.000Z
  by: claude/opus
status: draft                # or reviewed
---
```

- **Freshness.** A page with `covers` and a `generated.commit` makes a claim that can be checked: the app counts the commits since that commit that touched the covered paths, and the files that changed, were renamed or were deleted. *Fresh* (nothing under `covers` changed, however far HEAD has moved), *drifting* (a little changed), *stale* (more than 5 covering commits or more than 8 changed files: `THRESHOLDS` in `src/docs/staleness.ts`), *unknown* (the commit is not in this repository, or it is not a git repository), *not tracked* (no commit or no covers: nothing is claimed). Two git calls per page, bounded and cached per HEAD. The header of a page reads "generated at 1a2b3c4 by claude/opus, 3 commits behind, 2 covered files changed", and expands to the files.
- **Write and refresh with an agent of your choice.** *Write documentation…*, a page's *Refresh*, and *Refresh* on the drift banner open one dialog: the kind (overview, architecture, module reference, conventions, runbook, decision record), engine, model and agent (the `docs_engine` and `docs_model` settings are the default), and *Review a plan first* (the plan questionnaire runs read-only before anything is written). The dialog asks the daemon what would run: which pages, which exist, how fresh each is, which covered files changed. The run is an ordinary session in the workspace. Its prompt gives the agent HEAD, the date and the engine/model to record, tells it to read the code first (with CodeGraph when there is an index), to write only inside the docs folder, to keep every `<!-- keep -->` … `<!-- /keep -->` block byte for byte, and to end with `DOCS_TOUCHED: a.md, b.md`.
- **The app checks the result and never edits it.** After each turn it lists the pages that changed, and for each: front matter missing or not parsing, no `covers`, a `generated.commit` that is not HEAD, a keep block that was changed or removed (compared with the page as it was when the run started, uncommitted edits included), an unbalanced marker. It also lists files outside the docs folder that changed, and pages the agent named but did not change. These appear as `[docs]` lines in the session and as a *Last run* card in the Docs view. Nothing is committed: review the diff in Source Control first.
- **Attach pages to a conversation** from the same picker, the same way as specs: a short pointer by default (title, covers, a summary line) and *paste* for a short page, with the token estimate on the chip. A stale or drifting page says so in the pointer, so the agent checks it against the code instead of repeating it. A handoff carries the attachments over.
- **Decision records** are `docs/decisions/NNNN-title.md` (Status, Context, Decision, Consequences). *New decision record* numbers the next one; *Write documentation → Decision record → From this conversation* writes one from the session that is open.
- **Mentioned in.** A page shows the specs and roadmap items that mention it (by path, or a link to its file name), read straight from `specs/`, `.specify/` and `ROADMAP.md`: no coupling to how they are structured.
- Files are reached only under the docs folder, only as markdown, through the same path guard as the file API. The viewer opens links between pages in the viewer, links to code in the editor, and loads images through the raw endpoint; *Edit* is the real editor.
- Headless: `trb docs ls | stale | new <path> [-t title] | new --adr "<title>" | init | current <page> | generate [kind] [--page <p>]… [--stale] [-e engine] [-m model] [-a agent] [--plan] [-d] | attach <session> <page> [--inline]`.

## Roadmap

The roadmap is one markdown file in the repository, `ROADMAP.md` at the root (the path can be changed per project). trb is a lens over it, the same way it is over specs: nothing about the roadmap is copied into the database except which sessions were started from which item, so git keeps the history and an agent or an editor can change the file as easily as the UI can. Nothing is created until you click *Create ROADMAP.md*, which writes this:

```markdown
## Now                                  an H2 is a lane; rename, add and reorder lanes freely
- [ ] Ship chat {#r1} (spec: specs/003-chat) (docs: docs/architecture.md) (tag: core, ux) (target: 2026-Q4)
  Indented lines under an item are its description.
- [x] A checked item is shipped.
```

`(spec: …)` points at a `specs/` folder and its `tasks.md` drives the progress bar. `(docs: …)` points at any file. `(target: …)` is a date, a month (`2026-11`), a quarter (`2026-Q4`) or a range (`2026-Q4..2027-Q1`). `{#rN}` is the item's id: the app adds it the first time it edits an item and never changes it, so an item you typed by hand stays exactly as typed until you touch it. Prose, comments, fenced code and anything before the first lane are left alone, and an edit rewrites only the lines of the item it concerns (line endings and a missing final newline included).

- **Board, List, Timeline.** The board has a column per lane; drag a card to another lane or to a new position (or Alt+arrows on a focused card, or the arrows on its corner). The list is a dense table per lane. The timeline lays the items with a target on a time axis, one band per lane, with a line for today, and parks the rest in an *Unscheduled* row (a target it cannot read is called out). Filter by text, tag, status or lane in any of them.
- **Progress.** A card with a spec link shows its done/total tasks; a link that points at nothing (a renamed spec, a deleted doc) is flagged on the card and counted in the header. A lane shows how many of its items shipped and how many tasks are done.
- **Start work from an item.** *Create spec from this item* runs the Specs module's Specify step on a feature named after the item: the folder is created and linked from the item straight away, and the session writes `spec.md` (an item that already links a spec revises that one). *Open in Specs* on the card opens the feature in the Specs workbench, and the card's progress is counted by the same tasks parser the Specs view uses. *Start building* opens a session with the item and its spec attached by reference. Sessions started this way show as dots on the card.
- **Edits made outside the app** (an agent ticking a task, a `git pull`) show up within a few seconds; an edit made from a stale view is refused instead of overwriting the change.
- Headless: `trb roadmap show | init | add "<title>" [--lane --tag --target --spec] | move <id> <lane> | done <id> | edit <id> … | rm <id> | start <id> [spec|build]`.

## Design systems

A design system is two files in the repository: `DESIGN.md` at the root (the contract in words: personality, color roles, type scale, spacing, shape, motion, component rules, do and don't) and `design/tokens.css` (the same decisions as CSS custom properties, light and dark). Applying one adds a rule to AGENTS.md (and CLAUDE.md) telling every agent to read `DESIGN.md` before UI work and to use only the tokens. Like the roadmap, trb is a view over those files: nothing about a project's design is kept in the database, and nothing is written until you choose.

Every system uses the same token names (`--color-bg … --color-focus`, `--font-sans|display|mono`, `--text-xs … --text-4xl`, `--space-1 … --space-16`, `--radius-*`, `--shadow-*`, `--duration-*`, `--ease-out`), so one system can replace another without touching components. A system may add tokens of its own.

- **The library** (Settings → *Design systems*, next to Templates) lives in `<trb home>/design-systems.json`, never in a project. trb ships four original, brand-neutral systems: *Neutral* (product UI and dashboards), *Editorial* (content sites), *Bold* (launches and dev tools) and *Soft* (consumer apps). Each has a DESIGN.md, a tokens.css and a swatch preview, and every one is editable. Shipped systems can be reset, deleted and restored the same way templates can.
- **New app** asks for a design system. The files go into the first commit, and the starter prompt tells the agent to wire the tokens into the styling setup before building screens. API templates default to *None*; otherwise the dialog suggests the system you used last.
- **Design turns happen in the composer and the thread**, like any other work. Type `/design` followed by a brief (`/design a booking app for yoga studios, calm and warm`), a URL (`/design https://…`), or `code`, `wire` or `review`, or pick *Design system…* from the composer's + menu. A *Design* chip on the composer shows the kind and whether it brainstorms; change either from the chip. The daemon wraps your message in the design instructions, so the agent gets the full prompt while the thread shows only your words, with the instructions folded under a tag. The engine, model, agent and pair are whatever the composer is set to. A design turn always runs in Build mode. `/design --quick …` skips the brainstorm.
- **The Design view** (palette icon) renders the project's DESIGN.md beside its tokens: colors in light and dark, fonts, radii, and any contract tokens that are missing. With no DESIGN.md it offers the library, or one of three ways to generate one. Each opens a new session with the Design chip set, ready for you to type:
  - *From a brief*: describe the product and its feel.
  - *From a reference site*: the agent studies the site with its browser tools and writes an **original** system with that feel. It never copies logos, names or brand assets.
  - *From this code*: the agent writes down what the current UI already implies and lists where the code drifts from it.
- **Keeping the UI on the system:** *Wire tokens* (`/design wire`) starts a turn that imports `tokens.css` globally and maps the tokens into the styling setup in use (a Tailwind v4 `@theme`, a Tailwind v3 config, CSS modules, or a typed theme module for React Native). *Review UI* (`/design review`) starts a turn that compares the running UI with DESIGN.md (taking screenshots when it can), lists violations with `file:line`, and fixes the clear-cut ones.
- **Brainstorm first** (the default for a brief or a reference site): the first turn writes no design files. The agent asks up to five questions, each with its recommended answer so you can reply "go with your defaults", and writes `design/directions.html` with two or three directions side by side (palette, type, a sample card and buttons). The thread shows a preview of that page as a card, and *Compare* opens it full size in the Design view (sandboxed: no scripts). You answer in the thread ("B, but warmer"), the next turn writes DESIGN.md and tokens.css for that direction, and the directions page is deleted. Turn brainstorming off from the chip, with `/design --quick`, or with `trb design start … --no-brainstorm` to write the files in one turn. For a reference site, the agent extracts real values from its CSS rather than recalling a brand's colors, and says the system back in one sentence before writing.
- **Critique.** Every generating session and *Review UI* scores the work 1-5 on philosophy, hierarchy, execution, specificity and restraint, fixes anything below 3, and checks a list of generic patterns (violet gradients, an emoji on every heading, invented metrics, one family for display and body by default, and so on).
- *Save to library* copies a project's system into the library, so the next project can start from it. Applying from the library over an existing DESIGN.md asks first, and is refused if the files changed since you looked.
- Headless: `trb design show | systems | apply <system> [--force] | save "<name>" | start brief|url|codebase|wire|review ["<input>"] [--no-brainstorm]`.

**Design skills that ship with trb.** `design-discovery` (ask, then propose directions), `design-critique` (the five-dimension critique and the anti-generic list) and `brand-extract` (real values from a site, with the commands to get them) are seeded into the skill store when the daemon starts, enabled, and usable in any session, e.g. "make the settings page match DESIGN.md". They are built from the same text as the design session prompts. In Settings → Skills they are marked *built-in*: edit them freely, *Reset* puts the shipped text back, and a deleted one comes back with *Restore built-in skills*. A skill of yours with the same name is never overwritten. To go further, import upstream design skills with `trb skill import <folder>` so each keeps its own license: for example Anthropic's `frontend-design` and `theme-factory` (github.com/anthropics/skills), obra's `brainstorming` (github.com/obra/superpowers) or Google Labs' `design-md` (github.com/google-labs-code/skills). The working methods are adapted from [open-design](https://github.com/nexu-io/open-design) (Apache-2.0); see NOTICE.

## Context, compaction and handoff

The composer shows how full the engine's context window is (a ring, with `84k / 200k` beside it from half full, amber from 70%, red from 90%), read from what the engine streams: claude's last message usage, codex's `token_count`, opencode's step tokens. Engines that report nothing show no meter. `trb config set context_window <tokens>` overrides the window.

Hovering the engine icon in the composer shows the plan usage the engine last reported: for claude, the 5-hour window (and a weekly one when claude sends it) as used and left, when it resets, and how long ago it was reported. The numbers come from the `rate_limit_event` claude prints during a turn, so they are as fresh as the last turn; the daemon keeps them across restarts (`GET /api/engines/<id>/limits`). Treeboss never reads an engine's login or calls a vendor usage endpoint for this. Engines that do not report limits show no card.

When an engine compacts on its own, the log gets a `Context compacted: 168k → 24k` line, drawn as a divider in Chat and Trace, and the session counts it. `trb compact <id>` (or the meter's menu) sends `/compact` to engines that take it.

`trb handoff <id>` starts a fresh session from a summary of an old one, to save tokens when a conversation has grown long. The old session writes the summary itself in a short resumed turn (or it is built from the stored log when the session is busy, closed or cannot answer). `--print` shows it without starting anything. In the UI, the meter's menu, the session menu and the palette open a dialog where you can edit the summary and pick the engine, model and agent. The new session links back ("continued from …"); the old one is left as it was.

## Checkpoints and rewind

After every turn the daemon saves the session's files (tracked, modified and untracked, never ignored ones or `node_modules`) as a commit in a hidden ref, `refs/trb/checkpoints/<session>/<turn>`. It is built with a private index, so no branch, HEAD, staging area or stash of yours is touched. A `base` checkpoint is taken before the first turn, so every turn can be rewound. The palette's **Rewind or fork from a turn…** (and the session's verification strip) open a dialog per turn:

- **Rewind to before this turn** puts the files back. It saves what is there now as an `undo` checkpoint first, never moves a branch, and tells the agent on its next message that its files were rewound. It works for isolated worktrees and plain workspaces; a session in a subfolder only ever touches that subfolder. A directory that is not a git repository has no checkpoints.
- **Fork from here** opens a new isolated session whose files start exactly where that turn left them, briefed with the conversation up to it. The original is untouched.

API: `GET /api/sessions/:id/checkpoints`, `POST /api/sessions/:id/turns/:turn/rewind`, `POST /api/sessions/:id/turns/:turn/fork`. The newest 100 checkpoints per session are kept.

## Verify before done

Verification is **off by default**; turn it on globally, per workspace or per session in the Verification tab. When on, after each turn the daemon runs the project's checks, in this order: typecheck, lint, test. They are detected from `package.json` scripts (`bun`/`pnpm`/`yarn`/`npm run` by lockfile), `Cargo.toml`, `go.mod` and Python configs, or set per workspace (Verification tab of the same dialog). A failure goes back to the agent as the next turn, with the command and its output, up to **2** times in a row by default (`max auto-fixes`, 0 turns it off; an operator message starts the count again; a fix turn that changes nothing stops the loop). A session counts as **done** only when the checks passed for its latest turn: the strip above the composer says so, and the session view carries `verify` and `done`. With a goal, a goal is not met while verification fails, even when its check passes or the agent says DONE.

Off switches: per session, per workspace, and globally (`PUT /api/verify/config {"enabled": false}`); nothing runs when off. Only lead sessions in build mode are verified, and not failed or interrupted turns. Commands time out after 300 s (per command, configurable) and are killed with their process group. `POST /api/sessions/:id/verify/run` runs them by hand; it never starts a fix turn.

## Evidence

On by default: sessions get ten tools, and the UI an **Evidence** tab. `trb evidence off` (or Settings > MCP > evidence) takes the tools away from sessions. Evidence is kept per project and grouped two ways: an **investigation** is one reverse-engineering effort on a target, worked by one or more **runs** (agent sessions), and a **finding** is one feature or UI design that a run turned up, ready to build.

| Tool | What it does |
|---|---|
| `evidence_capture_page` | Saves the page open in the agent browser: rendered HTML, accessibility tree, the colors, fonts, sizes, radii, shadows and spacing it really uses (computed, most used first), CSS variables, scripts, stylesheets, images and requests (Resource Timing), a full-page screenshot. Returns an id to cite. Filed under the session's open investigation. |
| `evidence_note` | Saves a conclusion, with the ids of the captures it rests on (`refs`, checked to exist in the same project). |
| `evidence_finding` | Saves one feature or UI design (`kind`: `feature` or `ui`) as a finding, status `new`, citing the evidence it rests on. |
| `evidence_save_result` | Saves the output of REA (or another tool) as a note with the raw result attached, so it outlives the conversation. |
| `evidence_set_status` | Sets a finding's status: `new`, `planned`, `built` or `dismissed`. Other evidence is refused. |
| `evidence_list` | Lists the project's evidence, newest first, with a word search. Filters by investigation, finding kind and finding status. |
| `evidence_read` | Reads one item or one part of it (`styles`, `assets`, `network`, `snapshot`, `html`, `screenshot`, …; `result` for saved REA output), long parts in pages. |
| `investigation_start` | Starts an investigation on a target (`web`, `electron`, `binary`, `android` or `other`). It becomes the session's open one. |
| `investigation_close` | Closes the session's open investigation (or a named one) with a summary of what was found and what is still unknown. |
| `investigation_list` | Lists the project's investigations, with their status and what each holds. |

- **Investigations.** One effort on one target: a website, an Electron app, a binary, an APK. A project can hold many, and each stays on file with its title, target, kind, status and, once closed, a summary. A session's most recent open investigation is the default for everything it files: captures, notes, findings and saved results. Another investigation of the project can be named instead. Closing keeps the evidence; the UI, `PATCH` or a new run can reopen it. Removing one unlinks its evidence by default, so captures and findings stay in the project; `withEvidence` drops them with it.
- **Target kind.** An investigation's kind defaults to **auto**: treeboss works it out from the target when the investigation is created. A URL or bare domain is `web`; a `.app` is `electron` when it carries Electron's code, else `binary` (its executable named in `Info.plist`); a `.asar` is `electron`; an `.apk`, `.aab` or `.xapk` is `android`; a Mach-O, ELF or Windows PE file is `binary`; a folder whose `package.json` depends on `electron` is `electron`. Anything else (a zip, a WebAssembly module, an unknown file) is `other`, and REA's `inspect_artifact` classifies it. Detection reads at most 8 KB of any one file and never writes. The UI shows what was decided and why ("Detected from the target: …"), and an `other` is worked out again when its run starts. A kind you choose yourself always wins.
- **Runs.** Creating an investigation in the Evidence tab defaults to **Create and run**: the investigation is recorded and an agent session starts on its target (or create it without running). A web target is captured with the agent browser, using `evidence_capture_page`. An Electron app, a binary, an APK or another target is worked through REA, and each useful result is saved with `evidence_save_result`. Either way the agent records features and UI designs with `evidence_finding`, conclusions with `evidence_note`, and ends with `investigation_close` and a summary. A run never builds anything in the project. Each run is its own row, linked to its session, so an investigation keeps all of them: **Run again** adds one, and running again on a closed investigation reopens it. The investigation shows whether it is running, finished, failed or not run, and **Open session** goes to the latest run. While a run is going the list refreshes every 3 seconds. A run that cannot start is refused with the reason (evidence off, no agent browser for a web target, no REA for another kind, a local path that does not exist, or a run already going), and the investigation is still created.
- **Findings.** A feature is behavior: what it does, its steps, its states. A UI design is how something looks: layout, components, measured colors, type, spacing. Both are notes that cite the captures they rest on. Status: `new` when recorded, `planned` when it goes into a build, `built` once an agent has built it in this project and checked it against its evidence, `dismissed` when it is not worth building. Only findings have a status.
- **Saved REA output.** `evidence_save_result` stores a tool's output right after it returns: a note whose summary says what the result shows and what limits it has, and the raw output as `rea.json` when it parses as JSON, else `rea.txt`. Secrets are redacted before anything is written, as in captures. Read it back with `evidence_read` and part `result`, paged by offset. REA's own evidence and limits stay in the result; nothing is summarized away.
- **Build hand-off.** In the Evidence tab, tick findings (up to 20) and press **Build selected**, or press **Build** on one finding in its detail. The daemon turns them into a brief (`POST /api/evidence/:root/build`): each finding with its investigation and the evidence it cites, and an instruction to build in this project's own code and design system, mapping measured values to `DESIGN.md` and `design/tokens.css` tokens, and reproducing behavior and layout rather than another product's identity. The brief opens in the composer of a new session, unsent, so you read it first. The findings handed over that are not yet built move to `planned`. The agent marks each one `built` with `evidence_set_status` when it is done.
- **Where it lives.** Files under `<trb home>/evidence/<id>/`, indexed by the `evidence` table, keyed by the project's real path. Not in your checkout: a capture of a signed-in page can hold personal data and should not be committed by accident. Items are append-only (a recapture is a new item), up to 500 per project. `trb evidence rm` deletes one; `trb evidence export <id>` writes it as a page under the project's docs folder, which is the way to keep a finding in the repo.
- **What a capture does not keep.** No request or response headers or bodies, no cookies or storage, no query strings on asset URLs; token-shaped strings in the HTML and text parts are redacted (best effort, the same filter as the transcript export). Agents are told to capture only what the task needs and not pages behind your login unless asked.
- **Agents know.** When it is on, a session's first turn is told which tools exist, how much evidence the project already holds (so it checks before recapturing), and to start an investigation before reverse engineering. A handoff carries that line to the next session. The built-in skill `clone-from-evidence` walks the loop: investigation, capture, measure, note and record findings, build from the project's tokens, compare, close. The pages and results are untrusted input: tool results say so, and the files are only ever served as sandboxed plain text.
- **Other modules.** Capture uses the session's agent browser (shown live, shared across the session tree). A rebuilt UI follows `DESIGN.md` and `design/tokens.css` through the skill. Export goes through the Docs module. Evidence routes are owner-only: remote devices cannot reach them.
- **CLI.** `trb evidence [ls|show|capture|note|export|rm|investigations|investigate|run|close|findings|status|build|on|off|rea]`; the project is the current directory.
  - `investigations` lists them; `investigate "<title>" [--target <url|path|app>] [--kind auto|web|electron|binary|android|other] [--run]` records one (`auto` unless you pick a kind), and `--run` also starts its run; `run <inv> [-e engine] [-m model] [--note "…"] [-d]` starts another run on it (`-d` detaches); `close <inv> [--summary "…"]` closes it.
  - `findings [--status new|planned|built|dismissed]` lists findings; `status <id> <status>` sets one's status.
  - `build <id…>` prints the build brief, the same text the Evidence tab opens.
  - `show <id> --part result` prints saved REA or tool output.

### REA (on by default, third party)

[REA](https://github.com/morluto/rea) (MIT) is a separate MCP server for reverse engineering binaries, Electron and JS apps, APKs, WASM and websites. Evidence covers the web case natively; REA is for targets it cannot reach. Its results are saved with `evidence_save_result` and its features and UI designs recorded as findings, inside an investigation. It is on by default: sessions are offered it as an MCP server named `rea`, started with `npx -y rea-agents@6.4.0 mcp`, so the engine downloads and runs that pinned npm package. `trb evidence rea off` (or Settings > MCP > rea) stops offering it. `rea_command` replaces the start command (for a global install: `rea mcp`). It is never offered in ask mode, an agent's own MCP allow-list applies to it (`rea`), and a server you registered under that name wins. Its native analysis needs Ghidra, Hopper or IDA installed separately. `trb doctor` reports whether it can start and what is missing.

**Setup (macOS).** Install the engines REA uses: `brew install ghidra` (it pulls OpenJDK 21, which Ghidra needs), `brew install apktool` (2.7.0 or newer), `brew install --cask android-platform-tools` (adb, needed only for a connected device) and `brew install --cask hopper-disassembler`. Hopper's free demo has vendor limits: open it once and choose demo mode before REA's first Hopper call. Put the jadx-headless-mcp 0.7.1 jar in `~/.local/share/rea/jadx/0.7.1/`; when it is missing, `trb doctor` prints the download command, which checks the SHA-256. IDA is separate: it needs IDA Pro and its upstream MCP, set with `REA_IDA_MCP_CONFIG` and `REA_ANALYSIS_PROVIDER=ida`; REA does not support IDA Free. treeboss finds these engines and passes their absolute paths to REA itself (Ghidra's install folder and JDK home, apktool, adb and the jadx jar; binwalk on Linux), so no shell profile edits are needed. A desktop app started from the Dock may not have Homebrew on its PATH: treeboss then finds `npx` under `/opt/homebrew/bin` or `/usr/local/bin` and adds its directory to REA's PATH. Node from nvm, Volta or asdf is not found that way: put it on PATH or set `rea_command` to an absolute command. `trb doctor` runs REA's own check (`rea doctor --json`, which may make npx download the pinned package the first time) and prints each gap as a `rea:` line with its fix command. Settings > MCP > rea shows the same warnings with copyable commands and a **Check again** button, which runs the deep check fresh. The Engines page runs only the quick check, which starts nothing.

## CodeGraph

Projects that already have a `.codegraph/` index give their sessions two extra tools, `codegraph_explore` and `codegraph_node`, so agents look code up instead of grepping. The daemon never builds an index by itself: only *Initialize* creates one, and only when you ask.

**It ships with the app.** CodeGraph is a pinned dependency (`@colbymchenry/codegraph`, MIT), so `bun install` fetches it and there is nothing separate to install. The binary is picked in this order: the `codegraph_bin` setting, the copy bundled with the app, then `codegraph` on PATH. The panel shows which one is in use ("bundled v1.6.2"). The bundled copy runs on its own runtime, so it needs no Node on PATH. Size: the per-platform package is about 290 MB unpacked (it carries that runtime), fetched once per machine. To upgrade, bump the exact version in `package.json` and run `bun install`; an index built by an older version is read as it is, flagged "re-index recommended", and a full re-index refreshes it. Where the platform package is missing (an unsupported platform, a blocked registry) the panel shows the installer command to copy; it is never run for you.

The status bar has one item, **CodeGraph**, with a dot: grey not initialized, green indexed, amber stale or incomplete, a spinner with the percentage while a job runs, red after a failed one. Clicking it opens the one panel that holds everything:

- **State:** state, binary source and version, files, symbols, edges, last indexed, pending changes, and why an index is stale or incomplete.
- **Initialize and index** when there is no index. Before anything runs it says about how many source files will be indexed, warns about a very large project or about directories such as `third_party/` that CodeGraph does not skip, and offers a checkbox (on by default) that appends `.codegraph/` to the project's `.gitignore` if it is not already ignored. Nothing else in that file is touched.
- **Sync** (incremental, `codegraph sync`), or **Re-index** when the index came from an older version, or **Resume: re-index** after an interrupted run.
- **The live job:** a progress bar with the phase and percentage the CLI reports, elapsed time, the latest log lines and a **Cancel** button (it kills the process and removes a `.codegraph/` that this very init created, nothing else). When it ends the panel keeps the result ("Indexed 12,005 files, 204k symbols in 10s"), or the CLI's real error with **Copy log**, until you dismiss it. Every refused or failed start is shown in the panel and as a toast.
- **Re-index (full)** and **Remove index…** (asks first; deletes only `.codegraph/`).
- Two switches saved per workspace: **Use in sessions** (follows the global `codegraph` setting until you change it) and **Keep in sync after turns**.

Jobs live in the daemon, so a reload or another tab picks a running one back up. If the daemon stops mid-job it ends the process cleanly and leaves the partial index, which the next start reports as *incomplete* instead of indexed. A job is stopped after `codegraph_timeout_min` minutes (default 30; `0` for no limit).

**Keep in sync** is off by default. When on, a turn that leaves files changed on disk triggers a background `codegraph sync` of the existing index: debounced, one at a time per index, never blocking the turn, with the outcome as an info line in the session (a failure is a line, not an error). Heads working in worktrees do not sync per turn; the main index is synced when their work is merged.

`trb codegraph [status|init|sync|index|uninit] [path]` does the same from a terminal (`init --no-gitignore` skips the `.gitignore` entry, `uninit --yes` confirms the removal, Ctrl-C cancels a running job like the button does). Over HTTP: `GET /api/workspaces/:id/codegraph` returns the status plus the project's current job, `GET .../codegraph/estimate` the file estimate, `POST .../codegraph/{init,sync,index,uninit}` start a job or remove the index, `POST /api/codegraph/jobs/:id/{cancel,dismiss}` end or clear one, and `PUT .../codegraph/prefs` sets `{use, keepInSync}`.

## Run the app, and pick elements in the preview

In the Browser tab, **Run** (the play button) opens a panel under the preview with the project's runnable things, detected without executing anything: `dev` / `start` / `serve` / `preview` scripts from `package.json` (monorepo `apps/*`, `packages/*` too; the package manager comes from the lockfile), `Procfile` entries, and database scripts (`db:*`, `migrate`, `seed`, prisma / drizzle / knex) as one-shot tasks. Each row has Start / Stop / Restart, its port, and live logs beside it. **Environment** lists the `.env*` files by their **keys only**: trb never reads values into a response, a log or a prompt (the server loads its own files).

- **A port per directory.** Each start picks a free port in 4100-4899 (stable per directory, never one already handed out), sets `PORT`, and adds `--port`/`-p` for plain vite / next / astro / nuxt scripts. The panel works on the open session's working copy, so a head in its own worktree runs its own server on its own port, in parallel with the others. The preview opens on the server you start, and follows it.
- **Safe by construction.** The daemon spawns each process in its own process group and only signals that group (SIGTERM, then SIGKILL after 4s); it never finds or kills anything by port or by name. Closing a session stops what it started, and the daemon stops everything on shutdown. `TRB_TOKEN` is not passed to the child.
- **Inspect** (the pointer button, localhost previews only) serves the preview through a small loopback reverse proxy on the other loopback name (so the app's session cookie never reaches your dev server), which injects one script. Then **Pick** highlights elements; a click sends the selector, trimmed `outerHTML`, key computed styles, bounding box and a screenshot cropped to the element into the composer. The screenshot is taken by a headless Chrome that loads the page fresh (it needs a Chrome, and a page that needs a login looks different); without one the pick says so. The bug button counts console errors, uncaught exceptions and failed requests, and attaches them to your message. Agents can read the same buffers with the `devserver_logs` and `preview_console` tools (served with the browser tools). Websockets (HMR) pass through the proxy.
- API: `GET /api/run?root=`, `POST /api/run/{start,stop,restart}`, `GET /api/run/logs`, `POST /api/preview/proxy`, `GET /api/preview/issues`, `POST /api/preview/pick`. Spec: `specs/020-run-app-and-element-picking`.

## The agent browser

Agents can drive a real browser: `browser_navigate`, `browser_snapshot` (the page as a tree with stable `[ref]`s), `browser_click`, `browser_type`, `browser_press_key`, `browser_wait_for`, `browser_screenshot` (a real image), `browser_back`, `browser_tabs`, `browser_console`, `browser_close`. The daemon owns a headless Chrome (found automatically, or set `TRB_CHROME`); a lead and its heads share one page. In the UI, the Browser tab's **Agent** mode shows the live page, and you can click, scroll and type to take over. Only http(s) is allowed (no `file:`, `chrome:`, `data:`), with caps on browsers and tabs and an idle timeout. Turn it off with `trb config set agent_browser false`.

## MCP servers and skills

```sh
trb mcp add ctx7 -- npx -y @upstash/context7-mcp           # stdio
trb mcp add docs --url https://example.com/mcp -H Authorization="Bearer …"
trb mcp import --from claude                               # copy ~/.claude.json's servers across
trb mcp test ctx7                                          # spawn it and list its tools

trb skill import ~/.claude/skills        trb skill new my-skill -d "when to use it"
trb skill add ./some-skill               trb skill disable my-skill
trb skill packs                          trb skill pack <id> on|off
```

| engine | MCP servers (and subagent tools) | skills |
|---|---|---|
| claude | `--mcp-config <file> --strict-mcp-config`: trb's list is the engine's **whole** tool surface (`trb config set mcp_isolation merge` to keep your own too) | `.claude/skills/` |
| codex | `-c mcp_servers.*` overrides, layered on `~/.codex/config.toml` | `.agents/skills/` |
| cursor | `.cursor/mcp.json` in the workspace, backed up and restored around the turn | `.cursor/skills/` |
| opencode, agy, grok | **not wired** (one-shot mode has no MCP hook): they work as heads, not as leads | prompt index (opencode), `.agents/skills`, `.grok/skills` |

Skills are copied into the workspace for the duration of a turn and removed afterwards; a skill directory that already exists there is never touched. Everything trb writes into a workspace is taken back out before a worktree is committed.

## Safety model

> [!WARNING]
> Print-mode turns cannot ask a human, so every engine runs in its "no prompts" mode (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, …). **The net is isolation, not prompting:** heads run in worktrees outside your repo, a lead runs where you point it. Treat a lead in your real checkout like `claude --dangerously-skip-permissions`, because it is. Use `trb run -w` to give a lead its own worktree too.

The daemon listens on `127.0.0.1` only, requires the bearer token on everything but `/api/health`, and refuses a non-loopback `Host` header. It does not sandbox the engines.

**Remote (phone) access is off by default** and adds nothing until you turn it on: see [docs/REMOTE.md](REMOTE.md). Pairing is a QR code with a 2-minute one-time code that mints a revocable device token; a device can watch sessions, approve plans, answer questions, send follow-ups and interrupt, and nothing else unless you grant terminals or files. Choose one mode: off (default), your local network (plain http), or Tailscale.

## Providers and subscriptions

TreeBoss does not talk to any model provider itself. It launches the official CLIs (claude, codex, cursor-agent, opencode, …) that are already installed and signed in on your machine, and those CLIs make every request under your own account. TreeBoss never reads, copies, proxies or shares your credentials or tokens, and has no API keys of its own. You are responsible for following each provider's terms of service and usage policies; running several engines in parallel (as Hydra does) uses your plan's limits faster.

## Settings

**Settings > Workspace** sets where a project keeps what the app writes for it: the plans folder (`plans`), the docs folder (`docs`) and the roadmap file (`ROADMAP.md`). They are plain relative paths inside the workspace; changing one moves nothing, it only changes where the app looks and writes next, and a path that leaves the workspace is refused.

`trb config list` shows the daemon's settings. The ones you will touch: `default_engine`, `max_depth` (2), `max_per_parent` (6), `max_concurrent` (6), `turn_idle_timeout_sec` (900: a lead blocked on its heads is *busy*, not idle), `turn_ceiling_sec` (3600: time spent waiting on working heads does not count), `turn_hard_ceiling_sec` (14400: the absolute limit, waits included), `worktree_setup_cmd` (e.g. `bun install`, run in each new worktree instead of symlinking `node_modules`), `claude_max_turns`.

## How it fits together

See [docs/ARCHITECTURE.md](ARCHITECTURE.md). In one breath: `trb` → HTTP/SSE → daemon → one child process per turn (`claude -p …`), each started with an MCP config that points back at `trb mcp-serve`, a stateless stdio shim that forwards `subagent_*` calls to the daemon tagged with the caller's session id. Ownership and depth are decided server-side, so an agent cannot act as someone else's parent.

## Development

```sh
bun test            # 530+ tests, ~65s. No model is called: a scripted engine (tests/fixtures/fake-engine) speaks claude's stream-json
bun run typecheck
bun run scripts/ui-tour.ts   # drives the whole UI in headless Chrome (needs Chrome); scripts/ui-*.ts has one per panel
TRB_HOME=/tmp/x TRB_FAKE_ENGINE=$PWD/tests/fixtures/fake-engine trb run -e fake $'SAY hi\nWRITE a.txt hello'
```

The scripted engine understands `SAY`, `WRITE`, `SLEEP`, `FAIL`, `GIT_COMMIT`, `REJECT_RESUME`, `ECHO_RESUME` and `CALL_TOOL <name> <json>`, which calls an MCP tool through the *real* `trb mcp-serve` shim, so the Hydra path is exercised end to end.
