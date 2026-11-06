# Feature Specification: Inspect white-screen fix, pane boundaries, session search in the sessions list

**Feature**: `050-inspect-fix-and-session-search`
**Status**: Implemented
**Input**: Turning on Inspect in the Browser tab blanked the whole app; a pane crash must never blank the app; session search belongs in the sessions list, not a separate tab.

## User Scenarios & Testing

### User Story 1 - Inspect never takes the app down (Priority: P1)

**Root cause**: the Inspect proxy forwarded HTTP to `127.0.0.1` then `[::1]`, but its WebSocket upstream tried only `127.0.0.1`. Vite binds `localhost`, often IPv6 only. The page's HMR socket opened on the proxy side and dropped at once; Vite's client reacts to a dropped socket with "server connection lost, polling for restart" and `location.reload()`, forever. The preview iframe shares a renderer process with the app (same site, different port), so the endless reload loop froze the whole app view, which rendered white. Without Inspect the iframe talks to the dev server directly, so it worked.

**Acceptance Scenarios**:

1. **Given** a dev server listening only on `[::1]` with a websocket, **When** the proxy forwards the socket, **Then** it reaches the server (falls back from `127.0.0.1` to `[::1]`).
2. **Given** Inspect on for an IPv6-only HMR dev server, **When** five seconds pass, **Then** the page loads at most a few times.

### User Story 2 - A crashing pane is recoverable (Priority: P1)

Each editor-area tab, the agent panel and the heads panel sit in an error boundary. A crash shows "This pane crashed: <name>", the error text and a "Reload pane" button; the rest of the app keeps working.

### User Story 3 - Search inside conversations from the sessions list (Priority: P2)

The sessions filter box has a toggle, "Search inside conversations". When on, the box searches transcripts (the existing FTS5 `/api/search/sessions`) and lists ranked sessions with highlighted snippets. A compact popover holds workspace, engine and date filters. Choosing a hit opens the read-only replay scrolled to, and flashing, the matching turn; the replay has "Open session" and "Export HTML". A session's menu offers "Replay (read-only)" and "Export HTML". The palette command "Search past sessions…" shows the sessions list, turns the toggle on and focuses the box. The standalone Past sessions search tab is gone; the tab kind remains only as the replay host.

## Requirements

- **FR-001**: Proxy websocket upstream tries `127.0.0.1` then `[::1]`.
- **FR-002**: `PaneBoundary` wraps each editor tab and the right panel's agent and heads panes; reload remounts only that pane.
- **FR-003**: Search toggle, filter popover and results live in the sessions sidebar; no new daemon routes.

## Out of scope

Scrolling the live conversation thread to a turn (the thread components have no turn anchors); the replay does that.
