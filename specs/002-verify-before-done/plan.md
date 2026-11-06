# Implementation Plan: Verify before done

**Feature**: `002-verify-before-done` | **Spec**: [spec.md](./spec.md)

## Summary

`src/verify/` has detect (commands from the project), store (config and runs, lazily created tables), run (spawn with timeout and output tail) and loop (`verifyAfterTurn`, chained after the spec and docs hooks and before goal evaluation). When the loop sends a fix turn it tells the manager so goal evaluation waits for that turn's end. The session view gains `verify` and `done`.

## Technical Context

- **Language / runtime**: TypeScript on Bun
- **Storage**: SQLite tables `verify_config`, `verify_runs`, `session_verify`
- **Testing**: `bun test` with the fake turn runner

## Hooks into shared code

- `sessions/manager.ts`: chain verify before goal; `verify` and `done` on the session view.
- `sessions/goal.ts`: a failing verification means "not met".
- `daemon/server.ts`: route modules registered.
- Web: a per-session verify switch in the session header (`VerifyToggle.tsx`; it superseded the status strip in the composer, which no longer exists), the settings on the Settings > Verification page (`VerifyPage.tsx`, spec 040), which replaced a section in the Checkpoints dialog.
