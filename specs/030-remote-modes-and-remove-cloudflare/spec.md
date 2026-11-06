# Feature Specification: Remote access modes, and removing the Cloudflare deploy

**Feature**: `030-remote-modes-and-remove-cloudflare`
**Status**: Implemented
**Input**: The owner's infrastructure is not Cloudflare. Remove the Cloudflare Pages deploy feature and the Cloudflare Tunnel documentation entirely. Replace the three remote switches (`remote_access`, `remote_bind`, `remote_hosts`) with one setting, `remote_mode`: `off`, `lan` or `tailscale`, with a pairing link that is always a real network address.

## User Scenarios & Testing

### User Story 1 - Pair a phone on the same Wi-Fi (Priority: P1)

In Settings, Remote access, the operator picks **Local network**, confirms a warning that this is plain http visible to anyone on the network, and clicks Pair a phone. The QR and the link text use the computer's detected LAN address (docker, bridge, VM, VPN and Tailscale interfaces are skipped).

**Independent Test**: with injected interfaces, the link host is the `en0` address, never `127.0.0.1`; the Host allow-list accepts exactly that address.

**Acceptance Scenarios**:

1. **Given** mode `lan`, **When** a request carries `Host: 192.168.1.20` (the detected address), **Then** it is served; **When** it carries any other private address, a tailnet name or a rebinding name, **Then** 403.
2. **Given** no usable LAN address, **When** the operator chooses `lan`, **Then** the setting is refused with a plain message.
3. **Given** mode `lan`, **Then** the daemon listens on the LAN address only (a second listener), never `0.0.0.0`.

### User Story 2 - Pair a phone over Tailscale (Priority: P1)

The operator picks **Tailscale**. trb detects it through the CLI, listens on the tailnet address only, and builds the link from the MagicDNS name (or the `100.x` address when MagicDNS is off).

**Acceptance Scenarios**:

1. **Given** Tailscale running, **Then** Host `my-mac.tail1234.ts.net` and `100.101.102.103` are accepted and the LAN address is refused.
2. **Given** Tailscale not installed, stopped or signed out, **When** the operator chooses it, **Then** it is refused and the UI shows a plain instruction (no link).
3. **Given** Tailscale stops after enabling, **When** pairing is requested, **Then** it is refused; no link, and never a fallback to loopback.

### User Story 3 - Switch or turn off (Priority: P1)

Changing the mode takes effect at once: the old listener closes, a new one opens, and every open remote socket is closed. `off` stops the second listener and refuses every paired device. Devices stay listed and revocable.

### User Story 4 - Existing installs (Priority: P2)

Old settings migrate once at daemon start: `remote_access=on` with `remote_bind=lan` becomes `lan`; every other combination (including a tunnel setup, `on` + `loopback`) becomes `off`. The old rows are deleted. Nothing destructive happens to the `remote_tokens` table.

### Edge Cases

- The UI never renders a QR or link that points at `localhost`, `127.x`, `::1` or `0.0.0.0` (`pairingShowable`). The API never returns one either, except for the explicit `trb remote pair --local`, which prints that the link is not for phones and is refused while the mode is `off`.
- The second listener also refuses a loopback `Host`: a LAN peer cannot use `Host: 127.0.0.1`.
- The tailnet address cannot be bound (Tailscale userspace networking): the status page says so, and the documented fallback is `tailscale serve` (see Design decision).
- The address changes (new Wi-Fi network, Tailscale coming up): a 5 s check moves the listener and closes remote sockets.

## Requirements

- **FR-001**: `remote_mode` setting: `off` (default), `lan`, `tailscale`. Validated; `lan` and `tailscale` are refused while their address cannot be detected. `remote_access`, `remote_bind` and `remote_hosts` no longer exist.
- **FR-002**: `off`: only `127.0.0.1` is bound and `/_pair` is 404. `lan` / `tailscale`: a second listener on exactly one detected address (never `0.0.0.0`), started, moved and stopped live.
- **FR-003**: Host allow-list per mode: loopback names; `lan`: the one detected LAN IPv4; `tailscale`: the exact MagicDNS name and tailnet IPv4. Nothing else.
- **FR-004**: LAN address selection skips loopback, link-local, docker/bridge/VM/VPN/tunnel/Tailscale interfaces and non-RFC 1918 addresses, preferring `en*`, `eth*`, `wl*`.
- **FR-005**: Tailscale detection runs the `tailscale` CLI (`ip -4`, `status --json`) and validates the output (CGNAT range, DNS-name shape).
- **FR-006**: Pairing link and QR use the mode's address; a text copy of the link is always shown; `lan` shows the plain-http warning in the UI and the CLI.
- **FR-007**: A mode or address change closes every open remote socket.
- **FR-008**: Unchanged from spec 021: pair codes (192-bit, single use, 120 s, max 5), hashed revocable tokens, default-deny policy, rate limits, grants for terminals and files off by default, owner credentials ignored on non-loopback Host or peer.
- **FR-009**: The Cloudflare Pages deploy feature is removed: `src/deploy`, its routes and 403 rules, `trb deploy`, the Settings Deploy page and palette command, docs, spec 022, tests, and the stale-deploy hook. Existing `deploys` / `deploy_config` tables in users' databases are left orphaned and never touched.
- **FR-010**: Settings > Remote access: a three-way mode selector, live status (listening address, link), QR, device list with revoke, and the terminal/files grants.

## Design decision: Tailscale

Two ways to expose the daemon on a tailnet:

1. **Bind the tailnet IPv4 directly** (chosen). The OS delivers only tailnet traffic to that address, the LAN is not exposed, and no other process is needed. It works wherever Tailscale runs with a network interface (the macOS app, Linux with `tailscaled`, Windows).
2. **Loopback plus `tailscale serve`**. Safe too, and the only option under Tailscale's userspace networking, but it needs a manual command and the link becomes `https://<name>/` on port 443.

(1) is the default because it needs nothing beyond choosing the mode. If binding fails, trb reports it, switches the offered link to `https://<name>/`, and docs/REMOTE.md documents (2) as the fallback; the Host allow-list already accepts the MagicDNS name, and the owner's credentials stay ignored on that Host. `tailscale funnel` (public) is warned against.

## Success Criteria

- **SC-001**: Each mode's Host rule, mode-switch socket closing, migration, listener address and the no-localhost-link rule are covered in `tests/remote-auth.test.ts` and `tests/remote-cli.test.ts`, with no network address bound.
- **SC-002**: `scripts/ui-remote.ts` pairs a phone-sized headless Chrome through the real UI in `tailscale` mode (fake CLI, Host simulated on loopback).
- **SC-003**: No `cloudflare`, `cloudflared`, `wrangler` or deploy references remain in code or docs outside the historic note in spec 021.

## Assumptions

- A pairing code in a plain-http LAN link can be seen by others on that network; that is why the warning is explicit and why codes are single use and last two minutes.
- The tailnet address behaves as a point-to-point interface address on the OS; spoofed packets from other interfaces are dropped by default reverse-path filtering. This was not tested against a real tailnet (see the final report).
