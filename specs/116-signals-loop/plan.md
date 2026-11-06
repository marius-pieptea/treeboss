# Plan: Signals loop

- `src/signals/types.ts`: shared shapes (signal, source result, env and fetch injection, `SourceError`).
- `src/signals/store.ts`: tables `signals` and `signal_tokens`, created lazily; upsert, list, update, feedback tokens.
- `src/signals/sources/sentry.ts`, `src/signals/sources/posthog.ts`: REST and HogQL reads, each with a `sync…` that never throws.
- `src/signals/sync.ts`: `syncSignals(workspaceId, { envProvider, fetch })`, `sourcesConfigured`.
- `src/signals/feedback.ts`: intake rules, per-peer rate limiter, widget snippet.
- `src/signals/triage.ts`: `triageSignal`, `autoTriagePrompt`. Writes findings by hand in lab's format (lab has no create function), roadmap items through `addRoadmapItem`, sessions through `createLead`.
- `src/daemon/routes/signals.ts`: authenticated routes plus `feedbackIntake` for the public path. `server.ts` calls it for the public path before owner authentication.
- `src/cli/commands/signals.ts`: `trb signals ls|sync|triage|token|widget`. Registered in `main.ts`.
- Web: `web/src/features/signals/` (`data.ts` hooks, `SignalsInbox.tsx`). Mounted as the Signals page of the factory tab (`web/src/features/factory/FactoryView.tsx`).
- Tests: `tests/signals.test.ts`, with fake fetch and the existing fake engine.
