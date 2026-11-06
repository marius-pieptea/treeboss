# Plan: Inspect fix and session search

- `src/preview/proxy.ts`: websocket upstream connects through a host list with fallback; one attempt handled once.
- `web/src/components/PaneBoundary.tsx`: class error boundary plus a test seam (`localStorage["trb.test.crash"] = "<pane>"`).
- `web/src/shell/EditorArea.tsx`, `RightPanel.tsx`: wrap panes (additive).
- `web/src/features/sessions/SessionSearch.tsx`: toggle, filter popover, results. `SessionsSidebar.tsx`: state and wiring.
- `web/src/features/transcripts/`: `TranscriptsTab` reduced to the replay view; `open.ts` opens it at a turn.
- `web/src/shell/commands.tsx`, `web/src/lib/bus.ts`: palette command emits `sessions-search`.
- Tests: `tests/preview-proxy.test.ts` (IPv6 websocket), `scripts/ui-inspect-crash.ts` (reload loop, pane card, 7 preview targets), `scripts/ui-session-search.ts`.
