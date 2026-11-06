# Implementation Plan: Remote access modes, and removing the Cloudflare deploy

**Feature**: `030-remote-modes-and-remove-cloudflare` | **Spec**: [spec.md](./spec.md)

## Summary

One setting, `remote_mode`, replaces three. `src/remote/network.ts` detects the LAN address and Tailscale (detection only). `src/remote/listener.ts` owns a second `Bun.serve` on exactly one address, reconciled on setting changes and every 5 s. `hosts.ts` derives the Host allow-list from the mode. The pairing route builds the link from the same detection and never returns loopback unless `--local` is asked for.

## Technical Context

- **Dependencies**: none added.
- **Storage**: `settings` row `remote_mode`; a one-time `migrateRemoteMode()` converts and deletes the old rows. `remote_tokens` unchanged. The old `deploys` / `deploy_config` tables are not touched.
- **Test seams**: `startServer({ remoteServe })` (a recorder replaces the real second listener), `TRB_REMOTE_INTERFACES` (JSON interface list), `TRB_TAILSCALE_BIN` (a fake script; `none` = not installed), `TRB_REMOTE_NO_LISTEN=1` (daemon never opens the second listener; used by CLI tests and the UI script, which reach the daemon through a loopback Host).
- **Testing**: `bun test` binds loopback only.

## Constitution Check

Default off, no new exposure unless chosen, default deny unchanged. The second listener binds one address, never a wildcard.

## Project Structure

```text
src/remote/network.ts      LAN pick, Tailscale detection, assertModeAvailable
src/remote/listener.ts     second listener lifecycle
src/remote/hosts.ts        mode, per-mode Host rules, migration
src/settings.ts            remote_mode, onSettingChanged
src/daemon/server.ts       listen() factory, remoteServe, reconcile hooks, loopback-Host refusal on the second listener
src/daemon/routes/remote.ts status + pair
src/cli/commands/remote.ts --local, status
web/src/features/settings/RemotePage.tsx, web/src/remote/logic.ts
docs/REMOTE.md
```
