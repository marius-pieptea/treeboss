# Artifacts tab: build plan

Status: sketches approved by the owner (2026-11-26). Sketches: `docs/plans/schite-artifacts-2026-11/preview.html` (9 boards, `project/*.dc.html`).
Builders: follow this file literally. UI copy is English and must match the strings below character for character.

## 1. Decisions

Approved:
- New singleton editor tab **Artifacts** (like Evidence), opened from the activity rail (Layers icon, after Checklists) and the command palette.
- Wide: list 364px (`bg-panel`) | `PaneSplitter` | detail (`bg-bg`). Below 760px of tab width: the list only; a row opens the detail in its place with a back arrow.
- Own artifacts: TreeBoss reads the HTML back and shows it in `<iframe sandbox="allow-scripts" srcdoc>`. Artifacts shared by others: only a summary, plus **Open live view**.
- Account errors are shown once, as a banner over the list. A per-artifact error is shown only in its preview.
- "Remove from list" only. Deleting on claude.ai is never offered (it cannot be done headless).
- Removing is not confirmed: a toast with Undo.
- Reads are lazy: never read all artifacts at once. Every read costs about 10–20 s and one short Claude turn on the subscription.

Rejected: a phone layout (desktop/web app only); violet/accent on this screen (artifacts are not agent orchestration); auto-import of every claude.ai artifact (open question Q1).

## 2. Artboards

| Board | Shows | File |
|---|---|---|
| Wide · Empty | 0 items, both empty states | `project/Wide-Empty.dc.html` |
| Wide · 3 artifacts | grouped by date, own design open, ⋯ menu | `project/Wide-Three-Own.dc.html` |
| Wide · 43 artifacts | grouped by session, preview loading, Undo toast | `project/Wide-Many-Loading.dc.html` |
| Wide · Shared with you | summary card + Open live view | `project/Wide-Shared.dc.html` |
| Wide · Live view | desktop embedded browser | `project/Wide-LiveView.dc.html` |
| Narrow 600 · 1 artifact | bad link pasted | `project/Narrow-One-BadLink.dc.html` |
| Narrow 600 · Detail | back arrow, two action rows | `project/Narrow-Detail.dc.html` |
| Narrow 600 · Errors | the 4 errors | `project/Narrow-Errors.dc.html` |
| Entry points | rail, tab strip, palette | `project/Entry-Points.dc.html` |

## 3. Facts the build relies on (claude 2.1.318, tested on this machine)

- The `Artifact` tool exists only when the claude process has env `CLAUDE_CODE_ARTIFACT=1`. It needs a claude.ai Pro/Max/Team/Enterprise login.
- publish: the tool_use input is `{action:"publish", file_path, title, icon, description}`. The tool_result is plain text: `Published <path> at https://claude.ai/artifact/<id> (Version 1, version id <v>) ...`.
- URL shapes: `https://claude.ai/artifact/<id>` and `https://claude.ai/code/artifact/<uuid>`. One regex for both: `/https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/`.
- read needs `path:"index.html"` and `out_dir`. Without `path` it errors with "takes only url, prompt and page". It writes a file, so the headless run needs `--permission-mode bypassPermissions`. The result is `File saved: "<path>" (N bytes, "text/html", sha256 …)` plus the content. Shared artifacts return only a summary, steered by `prompt`.
- list returns lines `- (mine) <title> — https://claude.ai/artifact/<id> — updated <date>`, plus a page_token hint.
- claude.ai cannot be framed (`frame-ancestors 'self'`). A plain fetch returns only the JS shell.

## 4. Data contract (shared by all slices; S1 defines it, the others only import it)

`src/artifacts/types.ts` (S1):
```ts
export type ArtifactIntent = "document" | "slides" | "design" | "other";
export type ArtifactOwner = "mine" | "shared" | "unknown";
export type ArtifactError = "not_signed_in" | "no_plan" | "no_access" | "too_old" | "read_failed";
export interface Artifact { id: string; url: string; title: string; intent: ArtifactIntent; owner: ArtifactOwner; source: "created" | "pasted";
  sessionId: string | null; sessionTitle: string | null; createdAt: number; updatedAt: number | null; lastReadAt: number | null;
  htmlPath: string | null; summary: string | null; error: ArtifactError | null; errorText: string | null; }
export type AccountState = "ok" | "not_signed_in" | "no_plan" | "too_old" | "unknown";
export const MIN_CLAUDE_VERSION = "2.1.318";
```
`id` is the id taken from the URL (the regex group). Times are epoch ms.

HTTP (S2), all under the daemon's auth like the evidence routes:
- `GET /api/artifacts` → `{ items: Artifact[], account: { state: AccountState, version: string | null } }`, newest `createdAt` first, no limit.
- `POST /api/artifacts` body `{ url }` → `{ item }`, or 400 `{ error }` (copy in S2).
- `DELETE /api/artifacts/:id` → `{ ok: true }`. `POST /api/artifacts/:id/restore` → `{ item }` (Undo; S2 keeps the removed row for 30 s).
- `POST /api/artifacts/:id/refresh` → `{ item }` (runs one read; 409 `{ error: "Already reading." }` if a read is running for this id).
- `POST /api/artifacts/refresh` → `{ account, updated: number }` (runs `list`; updates title/updatedAt/owner of known ids only).
- `GET /api/artifacts/:id/html` → `text/html` body of `htmlPath`, 404 if none.

## 5. Slices (one head each; no file is shared between slices)

Merge order: S1 → S2 → S4 → S3. S3 and S4 can be built in parallel against sections 4 and S4's export contract.

### S1 · Backend store and capture (size: medie)

Files (only these):
- new `src/artifacts/types.ts` (section 4), new `src/artifacts/store.ts`, new `src/artifacts/capture.ts`
- `src/db.ts`: add the table in `migrate()` (same style as `CREATE TABLE IF NOT EXISTS evidence`, line ~173):
  `artifacts(id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL DEFAULT 'other', owner TEXT NOT NULL DEFAULT 'unknown', source TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, last_read_at INTEGER, html_path TEXT, summary TEXT, error TEXT, error_text TEXT, removed_at INTEGER)` plus `CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at)`. Old databases get the table on start; there is no backfill: old sessions simply have no artifacts.
- `src/engines/stream.ts`: add `onArtifact?: (a: { url: string; title: string; filePath: string }) => void` to `extras` of `createStreamAccumulator`. Keep a map `tool_use id → input` for blocks with `name === "Artifact"` and `input.action === "publish"` (both the `assistant` content path ~line 855 and the `tool_use` event ~line 824). On the matching `tool_result` (the `user` path ~line 875 and `tool_result` ~line 833), if not `is_error`, run `parsePublished(text)` from `capture.ts`; when it gives a URL, call `extras.onArtifact({ url, title: input.title ?? "", filePath: input.file_path ?? "" })`. Do not change any existing output line.
- `src/engines/runner.ts`: pass `opts.onArtifact` into the `extras` at line ~176 (add it to the run options type).
- `src/sessions/manager.ts`: where the turn is run, pass `onArtifact: (a) => recordPublished({ ...a, sessionId: <the trb session id> })`.
- `src/engines/registry.ts`: claude engine only: `env: { ...baseEnv(), CLAUDE_CODE_ARTIFACT: "1" }` in every invocation the `claude` EngineDef builds (line ~227 and siblings for claude). Other engines unchanged.

Functions:
- `capture.ts`: `parsePublished(text: string): string | null` (regex in section 3, first match, returns the full URL); `artifactIdFromUrl(url): string | null`; `intentFromPath(filePath, title): ArtifactIntent` (`.pptx`/"slides"/"deck" → slides; "design"/"mockup"/"ui" → design; `.md`/`.html` with "doc"/"spec"/"notes"/"report" → document; else other).
- `store.ts`: `recordPublished({url,title,filePath,sessionId})` (upsert: a new version of the same id updates `title`, `updated_at`, clears `html_path` so the next open reads again; `source='created'`, `owner='mine'`); `addPasted(url)`; `listArtifacts()` (excludes `removed_at` not null; joins the session title); `getArtifact(id)`; `markRemoved(id)` / `restore(id)` / `purgeRemoved(olderThanMs)`; `saveRead(id, {htmlPath?, summary?, owner?, title?})` (sets `last_read_at`, clears `error`); `saveError(id, error, errorText)`.

Tests: new `tests/artifacts-store.test.ts` (upsert on a second publish; remove/restore; list excludes removed; 40+ rows return in order). Extend `tests/stream.test.ts`: a claude stream with an `Artifact` publish + result calls `onArtifact` once with the URL; a `code/artifact/<uuid>` URL; an `is_error` result does not call it; an `Artifact` read result does not call it.
Do not touch: anything under `web/`, `desktop/`, `src/daemon/`, `src/mcp/`, other engines' env.

### S2 · Reader, API, MCP tool (size: mare)

Files (only these): new `src/artifacts/reader.ts`, new `src/artifacts/defs.ts`, new `src/artifacts/tools.ts`, new `src/daemon/routes/artifacts.ts`; `src/daemon/server.ts` (add `artifactRoutes` to `modules`, next to `evidenceRoutes`); `src/daemon/routes/core.ts` (dispatch `artifact_read` next to the evidence dispatch, line ~121); `src/mcp/serve.ts` (push `artifactToolDefs()` always, not behind a flag).

Reader (`reader.ts`):
- `claudeVersion(): Promise<string | null>` from `claude --version`, cached 10 min. Below `MIN_CLAUDE_VERSION` → account `too_old`, no read is attempted.
- `readArtifact(id)`: out dir `path.join(paths home, "artifacts", id)` (use `paths` from `src/paths.ts`; that is `~/.treeboss/artifacts/<id>/`). Spawn `claude -p --permission-mode bypassPermissions --output-format stream-json --verbose` with env `CLAUDE_CODE_ARTIFACT=1`, cwd = out dir, prompt: `Use the Artifact tool once with action "read", url "<url>", path "index.html", out_dir "<out dir>", prompt "Summarize this artifact in 3 sentences: what it is and what it contains." Then reply with the single word done.` Timeout 90 s. Parse the `Artifact` tool_result text from the stream.
  - Result text contains `File saved:` and `<out dir>/index.html` exists → `saveRead(id, { htmlPath, owner: "mine" })`.
  - Otherwise, a non-error result → `saveRead(id, { summary: text (max 2000 chars), owner: "shared" })`.
  - Errors: `classify(text)`: login/auth/"not logged in"/"/login" → `not_signed_in`; "plan"/"subscription"/"upgrade" → `no_plan`; "403"/"404"/"not found"/"access"/"permission" → `no_access`; the Artifact tool missing from the run → `too_old`; else `read_failed`. Store the raw text in `error_text`. (Exact claude.ai wording is not known; see Q2.)
- One read per id at a time; at most 2 reads at once over all ids (a simple queue).
- `listAccount()`: same spawn with `action "list"`; parse lines with `/^- \((mine|shared)\) (.+?) — (https:\/\/claude\.ai\/\S+) — updated (.+)$/`; update known ids only; return the account state.
- Account state = the newest error of kind `not_signed_in` | `no_plan` | `too_old` from the last read or list, else `ok`; `unknown` before any call.

Routes (`routes/artifacts.ts`): the endpoints of section 4. `POST /api/artifacts` errors, exact text:
- URL on claude.ai but `/chat/` → `That is a chat link. Paste a link that starts with claude.ai/artifact/.`
- any other non-matching text → `Paste a link that starts with claude.ai/artifact/.`
- id already in the list → return the existing item with 200 (no error); a removed one is restored.
A pasted link is read once right after it is added (async; the item comes back with `lastReadAt: null`).

MCP tool `artifact_read` (`defs.ts`, `tools.ts`, same shape as `src/evidence/defs.ts` / `tools.ts`): args `{ url: string (required), prompt?: string }`. Description: `Read a claude.ai artifact by its URL. For your own artifacts it saves the HTML and returns its path; for artifacts shared with you it returns a summary.` Returns text: `Saved <htmlPath> (<N> KB). It is self-contained HTML.` plus the first 4000 chars, or `Summary: <summary>`, or `Error: <errorText>`. It adds the URL to the list as `pasted` if new. Reaches claude, codex, cursor, opencode, devin and agy; grok has no trb MCP (Q4).

Tests: new `tests/artifacts-reader.test.ts` (with a fake spawn: own result → htmlPath; summary → shared; each `classify` branch; version below min → too_old without spawning; second read of the same id while one runs → 409); new `tests/artifacts-routes.test.ts` (add good URL, chat URL error text, other text error, duplicate, delete + restore, 40+ items listed). Extend `tests/evidence.test.ts` only if the MCP tool list there asserts an exact count.
Do not touch: `src/artifacts/store.ts`/`capture.ts`/`types.ts` (S1), `web/`, `desktop/`.

### S3 · Web tab (size: mare)

Files (only these): new `web/src/features/artifacts/{ArtifactsTab.tsx, List.tsx, Detail.tsx, ErrorPanel.tsx, data.ts, format.ts}`; `web/src/lib/store.ts` (Tab union: `| { id: string; kind: "artifacts"; title: string }` and its case next to `"evidence"` at line ~75); `web/src/shell/EditorArea.tsx` (lazy import + the two `case "artifacts"` next to `"evidence"`); `web/src/shell/ActivityBar.tsx` (add `"artifacts"` to `TabView` and `TAB_VIEWS`, `openTab({ kind: "artifacts", title: "Artifacts" })`, item `item("artifacts", "Artifacts", <Layers />)` right after Checklists); `web/src/shell/commands.tsx` (three commands, group "Artifacts"); `web/src/features/agent/AgentPanel.tsx` only to re-read the draft on `drafts.subscribe` if it does not already update when `drafts.set` is called from outside (check first; if it already updates, do not touch it).
Uses `LiveView` from `web/src/features/artifacts/LiveView.tsx` (S4's file; do not create or edit it).

Tokens and components: `Button`/`IconButton` (`components/ui/button`), `Input` (`ui/form`), `Badge`, `Empty`, `SegTabs`, `Skeleton` (`ui/misc`), `PaneSplitter` (`ui/splitter`) with key `"artifacts.list"`, default 364. Classes: `bg-bg`, `bg-panel`, `border-line`, `text-fg-muted`, `hover:bg-hover`, selected row `bg-accent-soft` (= `--color-primary-soft`). Sizes from DESIGN.md only (no `text-[..px]`). No `text-violet` anywhere. Icons (lucide): tab `Layers`; intent document `FileText`, slides `Presentation`, design `LayoutPanelLeft`, other `File`; `Link`, `Search`, `RefreshCw`, `Copy`, `MoreHorizontal`, `ExternalLink`, `MessageSquare`, `ChevronLeft`, `Globe`, `Trash2`, `TriangleAlert`, `Lock`, `UserRound`, `Terminal`, `ShieldCheck`.

List header (top to bottom, `p-3 gap-2`, bottom `border-line`):
1. `Layers` 16px muted, "Artifacts" (`text-lg font-semibold`), count (mono 11px muted), spacer, `IconButton` "Refresh" → `POST /api/artifacts/refresh`.
2. `Input` with `Link` icon, placeholder `Paste a claude.ai artifact link`, + `Button` "Add" (`subtle`; `primary` while the field has text). Enter adds. The 400 error is shown under the field in `text-red text-xs`; it clears on edit.
3. `Input` size sm, placeholder `Search title, session, link` (matches title, session title, URL; case-insensitive) + a select `Group: Session` / `Group: Date`, default Session, saved in the UI store.
4. `SegTabs`: `All`, `Documents` (`Docs` when the list is under 400px), `Slides`, `Designs`, `Other`, each with its count for the current search (mono).
With 0 items rows 3 and 4 are disabled (50%).

Rows (`List.tsx`): intent icon 14px muted; title `text-base font-medium truncate` (full title in `title=`); line 2 mono 11px muted: by date `<session title> · <relative time>`, by session `<relative time>`; pasted rows show `added <date>`; `owner === "shared"` adds `Badge` tone info `shared`. Group headers 28px, uppercase 11px label + count right. By session: groups sorted by newest item, sessions with no title use `Session <first 6 chars of id>`, pasted links in a group `Pasted links`, groups after the 5th start collapsed. By date: `Today`, `Yesterday`, `Earlier`. 40+ items: plain scroll, no paging (the API has no limit).

Detail (`Detail.tsx`): header `px-4 py-3`: title `text-lg font-semibold leading-tight` (wraps); line: `Badge` with the intent word (or info `shared with you`), then mono 11px muted `from <session link> · created <MMM D, HH:mm> · updated <relative>` (pasted: `pasted <MMM D, HH:mm>`). The session link opens that session (`setActiveSession` + Agents tab). Actions wide: `Button subtle` "Ask an agent", `Button outline` "Open in claude.ai" (opens the URL in the system browser via the existing external-link helper), `IconButton` "Refresh", "Copy link", "More" (menu: Ask an agent, Refresh, Copy link, separator, `Remove from list` in danger). Narrow: the icon buttons stay on the title row; Ask/Open move to a second row.
Body states:
- never read (`lastReadAt === null`, no error): start `POST …/refresh` on open, show the loading state.
- loading: 28px strip `Reading from claude.ai…` (mono 11px muted), then a card with three `Skeleton`s.
- own (`htmlPath`): strip `Local copy · read <relative> · sandboxed` with `ShieldCheck`, then a `rounded-lg border-line` card holding `<iframe sandbox="allow-scripts" srcdoc={html}>` (html from `GET …/html`). Never add `allow-same-origin`.
- shared (`summary`): card with label `Summary from claude.ai` and the summary; under it the text `Someone else owns this artifact, so TreeBoss can only read its summary. To see the page itself, open it in a browser view signed in to claude.ai.` and `Button primary md` "Open live view" → renders `<LiveView url onClose />` in place of the body.
- error: `ErrorPanel` (below).
Ask an agent: target = the artifact's session if it still exists, else the active session; `drafts.set(draftKey(current, sid), "About this artifact: <url> ")` (for shared, append `\n\nSummary: <summary>`), then `setActiveSession(sid)` and focus the Agents tab. Never sends. With no session at all: toast `Open a session first.`.
Remove: `DELETE`, then toast `Removed “<title>” from the list. It is still on claude.ai.` with action `Undo` (→ `restore`) for 30 s.

Empty states: list `No artifacts yet` / `When a Claude session publishes an artifact to your claude.ai account, it shows up here. You can also paste a link above.` (dashed border, like Evidence); detail `Nothing to preview` / `Pick an artifact on the left to see it here.`; search with no results: `Nothing matches`.

Errors (`ErrorPanel.tsx`), exact copy:
- `not_signed_in`: banner over the list (amber 6% wash, `TriangleAlert` in `text-amber`): title `Claude Code is not signed in to claude.ai`, text `Artifacts live in a claude.ai account, so TreeBoss can't read or refresh them. Run /login in Claude Code and pick your claude.ai account, then refresh. The list below is from the last read.` (`/login` in mono), button `Refresh`.
- `no_plan` (banner and detail, icon `Lock`): `Your plan does not include artifacts` / `claude.ai turned down this account for artifacts. Check which plan the account Claude Code uses is on.` Buttons: outline `Open claude.ai` (https://claude.ai), subtle `Try again`.
- `too_old` (banner and detail, icon `Terminal`): `Claude Code is too old for artifacts` / `Artifacts need Claude Code 2.1.318 or newer. This machine has <version>.` Buttons: primary `Copy claude update` (copies `claude update`), subtle `Check again`.
- `no_access` (detail only, icon `UserRound`): `You don't have access to this artifact` / `It may be private, or the owner stopped sharing it. Ask them for a new link.` Buttons: outline `Open in claude.ai`, danger-ghost `Remove from list`.
- `read_failed` (detail only, icon `TriangleAlert`): `Couldn't read this artifact` / `<errorText, max 300 chars>`. Button subtle `Try again`.

Commands (`commands.tsx`): `Open artifacts` (keywords "claude.ai artifact published slides document design"); `Add artifact link…` (opens the tab, focuses the link field); `Refresh artifacts`.

Tests: new `tests/artifacts-format.test.ts` for `format.ts` only (grouping by session/date, collapsed after 5, search match, counts per intent, `Docs` label). No browser tests.
Do not touch: `src/`, `desktop/`, `LiveView.tsx`.

### S4 · Live view (size: medie)

Files (only these): `desktop/main.cjs`, `desktop/preload.cjs`, new `web/src/features/artifacts/LiveView.tsx`, new `web/src/features/artifacts/liveview-guard.ts`.

Export contract: `export function LiveView(props: { url: string; onClose: () => void }): JSX.Element`.
- Desktop (preload exposes `window.trbDesktop?.webview === true`): turn on `webviewTag: true` in `webPreferences` (`desktop/main.cjs:125`). In `main.cjs`, on `will-attach-webview`: delete `preload`, force `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, set `partition: "persist:claude-ai"`, and `preventDefault()` unless `params.src` passes `isAllowedLiveUrl`. On the webview's contents: `will-navigate` and `setWindowOpenHandler` allow only `https://claude.ai/*` and the sign-in hosts claude.ai redirects to (Q3); anything else opens with `shell.openExternal` and is denied. `LiveView` renders a 36px bar (back, reload, read-only URL in a mono input, ghost `Close live view` with `X`) and `<webview src={url} partition="persist:claude-ai">` filling the rest.
- Web (no desktop flag): `POST /api/browser/<active session>/input` with `{ kind: "navigate", url }`, open the existing browser pane, and show in place of the body: `Opened in the browser pane. Sign-ins there are kept for this project.` + ghost `Close live view`. With no active session: `Open a session first to use the browser pane.`
- `liveview-guard.ts`: `isAllowedLiveUrl(url: string): boolean` (https only; host `claude.ai` and the agreed sign-in hosts); `main.cjs` keeps its own copy of the same list (CommonJS), with a comment pointing to this file.

Tests: new `tests/artifacts-liveview-guard.test.ts` (claude.ai artifact allowed; `http://claude.ai` refused; `claude.ai.evil.com` refused; `javascript:` refused). No Electron or browser tests.
Do not touch: `src/browser/*` (use the existing route as-is), the other files of `web/src/features/artifacts/`.

## 6. Acceptance checks (all slices, after merge)

- Compare against the boards at the 600px left pane and at ~1340px: Wide-Empty, Wide-Three-Own, Wide-Many-Loading, Wide-Shared, Narrow-*.
- Counts: 0, 1, 3, 43 items; a 43-item list scrolls with no paging and no auto-read.
- Old databases: on first start the table is created and the tab shows the empty state; old sessions have no artifacts and nothing is backfilled.
- 130% UI zoom at 600px: SegTabs fit (`Docs` label), no clipped buttons, the detail title wraps.
- Run only: `bun test tests/artifacts-store.test.ts tests/stream.test.ts` (S1), `tests/artifacts-reader.test.ts tests/artifacts-routes.test.ts` (S2), `tests/artifacts-format.test.ts` (S3), `tests/artifacts-liveview-guard.test.ts` (S4).

## 7. Open questions

- Q1. Import every artifact of the account (from `list`), or only those made in TreeBoss plus pasted ones? The plan does the second; header Refresh only updates known ones.
- Q2. The exact claude.ai error texts for no login / no plan / no access are not known; `classify()` matches keywords and falls back to `read_failed`. Capture the real texts once and tighten it.
- Q3. Which sign-in hosts does claude.ai redirect to (Google SSO, email link)? Needed for the webview allowlist.
- Q4. grok has no trb MCP, so no `artifact_read`. Is that acceptable?
- Q5. Is 2.1.318 the first version with the Artifact tool, or just the one tested? It is the floor in `MIN_CLAUDE_VERSION` for now.
