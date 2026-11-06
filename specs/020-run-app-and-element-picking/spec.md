# Feature Specification: Run-the-app panel and live preview element picking

**Feature**: `020-run-app-and-element-picking`
**Status**: Implemented

## Summary

Two additions around the browser preview. (1) A **Run panel** detects and manages a project's dev servers (package.json scripts, Procfile), shows the env files' keys, ports and optional database commands, and starts, stops and restarts them with live logs. Each directory (a workspace, or a Hydra head's worktree) gets its own free port so heads can run the app in parallel, and the preview auto-points at the running server. (2) **Inspect mode** in the preview: pick an element and send its selector, trimmed outerHTML, key computed styles, bounding box and a cropped screenshot to the composer; the page's console errors and failed requests go into a buffer the user can attach and the agent can read.

## User stories

- **US1 (P1)** As an operator I open Run, see detected services ("dev: bun run dev"), press Start, watch logs, and the preview opens on that server.
- **US2 (P1)** As an operator with two heads in worktrees, both run the app at once on different ports without editing anything.
- **US3 (P1)** As an operator I turn on Inspect, click an element in the preview, and the composer gets "make *this* bigger" context.
- **US4 (P2)** I can attach the preview's console errors and failed requests to my message; the agent can also call a tool to read them.
- **US5 (P2)** I can run configured migrate / seed commands from the panel.

## Requirements

- R1 Detection reads `package.json` scripts (`dev`, `start`, `serve`, `preview`, plus `db:*`/`migrate`/`seed`-like names), the package manager from the lockfile, and `Procfile` entries. Docker compose is out of scope. Nothing is executed during detection.
- R2 Env files (`.env*`) are listed by file name and **keys only**. Values are never put into any response, log line or prompt by trb.
- R3 A free port is chosen per instance (probe by binding), injected as `PORT` and, for vite/next/astro/nuxt style commands, as a port flag. The URL is also learned from the process output when it differs.
- R4 Processes are spawned by the daemon in their own process group; only pids it spawned are ever signalled; stop is SIGTERM to the group then SIGKILL after a grace period. Nothing is killed by port. All are stopped when the daemon shuts down.
- R5 Logs are a bounded ring buffer per instance, fetched with a cursor.
- R6 Inspect mode routes the preview through a loopback reverse proxy on the other loopback name (so the app's cookie never reaches it) that injects an inspector script. Only loopback targets are proxied. The script talks to the app by `postMessage`, checked against the iframe's window.
- R7 A pick is: selector, trimmed outerHTML (cap 2 KB), selected computed styles, bounding box, and a cropped screenshot taken by a headless Chrome of the page at that URL when a Chrome exists (otherwise omitted, and said so). Picks are stored under the trb home, never in the repo.
- R8 The console/network buffer keeps the last 200 entries per preview target; `preview_console` (MCP tool) and the attach button read it.
- R9 Additive: no database schema changes; routes in a new module; small edits to shared registries only.

## Out of scope

Docker, remote deploy, supervision across daemon restarts, HTTPS dev servers, HMR beyond WebSocket pass-through.
