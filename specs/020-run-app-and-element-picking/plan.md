# Plan

- `src/devserver/detect.ts` pure detection (scripts, Procfile, env keys, db commands). `ports.ts` free-port probe and flag rules. `manager.ts` process registry and log ring, keyed by real dir + service id.
- `src/preview/proxy.ts` loopback reverse proxy (HTTP + WebSocket) with inspector injection; `inspector.ts` is the injected script; `issues.ts` console/network buffer; `shot.ts` element screenshot via playwright-core and the existing Chrome finder; `picks.ts` stores and formats a pick.
- `src/daemon/routes/x_devserver.ts` HTTP API (`/api/run/*`, `/api/preview/*`), registered in server.ts. MCP tools `devserver_logs`, `preview_console` served with the browser tools.
- Web: `features/run/` (RunPanel, data hooks, logic) opened from the Browser tab toolbar; Inspect toggle, Pick button and Issues chip in `BrowserTab`; composer receives text through a new `composer-insert` bus event.
- Tests: bun tests for detect, ports, manager lifecycle (real child process), proxy injection, pick formatting, API; web logic tests.
