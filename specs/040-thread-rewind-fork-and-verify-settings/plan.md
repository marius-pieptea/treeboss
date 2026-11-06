# Implementation Plan: Thread rewind/fork and Verification settings

**Feature**: `040-thread-rewind-fork-and-verify-settings` | **Spec**: [spec.md](./spec.md)

## Summary

`web/src/features/checkpoints/ThreadActions.tsx` provides a per-session context (checkpoints query, rewind and fork mutations, confirm) and the `RewindButton` / `ForkButton` components. `ChatThread` and `Transcript` render them on user and last-agent-text items; `AgentPanel` mounts the provider. `VerifyPage.tsx` is the Settings page; `VerifyToggle.tsx` is the per-session switch, a shield in the session header (it superseded `VerifyStrip.tsx`, the composer strip this spec first named). Pure rules (`rewindState`, `forkState`) live in `checkpoints/logic.ts` and are unit tested.

## Shared files touched (additive)

- `web/src/lib/store.ts`: `"verify"` in `SettingsPage`.
- `web/src/features/settings/SettingsTab.tsx`, `SettingsSidebar.tsx`, `commands.tsx`: case, item, title.
- `web/src/features/agent/AgentPanel.tsx`, `ChatThread.tsx`, `Transcript.tsx`, `chat-logic.ts`: provider and buttons; the user chat item carries its turn id.
- `web/src/main.tsx`: the dialog is no longer mounted.

## Verification

`bun test`, `bun run typecheck`, `bun run build:web`, and `scripts/ui-thread-actions.ts` in headless Chrome against an isolated daemon.
