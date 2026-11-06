# Implementation Plan: Checkpoints and rewind

**Feature**: `001-checkpoints-rewind` | **Spec**: [spec.md](./spec.md)

## Summary

`src/checkpoints/` snapshots the git working tree with a private index file (`GIT_INDEX_FILE`) and plumbing (`add -A`, `write-tree`, `commit-tree`, `update-ref`), so the user's index, branches and stash are never touched. A persisted per-session index keeps the stat cache warm so repeated snapshots are cheap. Rewind reads the target tree into a private index, deletes files that exist now but not in the target, and checks the target out into the working tree with `checkout-index`. Fork uses `WorktreeManager.prepare` with a start ref.

## Technical Context

- **Language / runtime**: TypeScript on Bun
- **Dependencies**: git only
- **Storage**: SQLite table `checkpoints` (created lazily and idempotently), git refs under `refs/trb/checkpoints/`
- **Testing**: `bun test` with real temp git repos and the fake turn runner

## Hooks into shared code (each a few lines)

- `sessions/manager.ts`: snapshot a `base` before turn 1, a `turn` checkpoint after settle, a rewind notice in `send`, `startRef` on `createLead`.
- `git/worktree.ts`: optional `startRef` in `prepare`.
- `daemon/server.ts`: route modules registered.
- `web/src/main.tsx`, `agent-commands.tsx`, `Composer.tsx`: dialog host (superseded by spec 040, which removed the dialog; rewind and fork are now in `ThreadActions.tsx`), palette commands, status strip.
