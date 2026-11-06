# Implementation Plan: Mobile / Remote View

**Feature**: `021-remote-mobile-view` | **Spec**: [spec.md](./spec.md)

## Summary

`src/remote/` holds pairing, tokens, rate limiting, the route policy and host rules. `server.ts` gets a principal (owner or remote), one policy check before dispatch, a Host/peer rule and an optional bind host. `routes/remote.ts` is the owner-only management API. The web app gets a compact `/remote` view and a settings page. `trb remote` pairs from a terminal.

## Technical Context

- **Dependencies**: `qrcode-generator` (tiny, no dependencies) for the QR.
- **Storage**: `remote_tokens` table, created by the module (no `db.ts` edit). Settings via the existing `settings` table.
- **Testing**: `bun test` on loopback only; the policy is a pure function with its own table test.

## Constitution Check

The 0600 token model is unchanged; remote tokens are additive and stricter. No exception.

## Project Structure

```text
src/remote/store.ts, pairing.ts, policy.ts, hosts.ts, qr.ts
src/daemon/routes/remote.ts
src/cli/commands/remote.ts
web/src/remote/  compact app + logic
web/src/features/settings/RemotePage.tsx
docs/REMOTE.md
tests/remote-*.test.ts
```
