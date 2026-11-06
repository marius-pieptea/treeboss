# Feature Specification: Mobile / Remote View

**Feature**: `021-remote-mobile-view`
**Status**: Implemented; its access switches and tunnel setup are superseded by spec 030
**Input**: Open the UI from a phone: approve plans, answer plan questions, watch heads, send follow-ups, interrupt. A compact layout, and a secure way to reach the daemon: QR pairing with a short-lived one-time code that mints a scoped, revocable session token. Network exposure opt-in and off by default.

## User Scenarios & Testing

### User Story 1 - Pair a phone (Priority: P1)

In Settings, Remote access, the operator turns remote access on and clicks Pair a phone. A QR code shows a link with a one-time code valid for 2 minutes. The phone opens it, taps Pair, and lands in the compact remote view with its own token.

**Why this priority**: nothing else works without it.

**Independent Test**: a pair code redeems exactly once, expires, is rate limited, and yields a token that works on the allowed API and nothing else.

**Acceptance Scenarios**:

1. **Given** remote access off, **When** anyone requests `/_pair` or presents a remote token, **Then** it is refused (404 / 401).
2. **Given** a valid code, **When** redeemed twice, **Then** the second fails.
3. **Given** too many bad codes from one address, **Then** pairing answers 429 with Retry-After.

### User Story 2 - Supervise from the phone (Priority: P1)

The remote view lists sessions, shows a session's transcript and heads live, shows the pending plan or plan question with Approve / Request changes / answer buttons, a follow-up box and an Interrupt button.

### User Story 3 - Revoke (Priority: P1)

Every paired device is listed in settings (label, created, last seen, expiry) and can be revoked; revoking closes its live sockets. Turning remote access off does the same for all.

### Edge Cases

- A remote token tries terminals, files, git, config, MCP, skills, session creation, close, merge, spawn, shutdown: 403.
- Terminal and file access can be granted explicitly in settings (`remote_allow_terminal`, `remote_allow_files`).
- Owner credentials (the 0600 token, the `trb_session` cookie) are never honoured on non-loopback hosts or peers.
- A hostile page with a LAN-IP Host header or a DNS-rebinding name is rejected by the Host allow-list.

## Requirements

- **FR-001**: `remote_access` setting, default `off`. Off: no pairing, remote tokens refused.
- **FR-002**: `remote_bind` setting, default `loopback`; `lan` binds 0.0.0.0 only when remote access is also on. Takes effect on daemon start.
- **FR-003**: Pair codes: 192-bit random, single use, 120 s TTL, at most 5 outstanding, created only by the owner.
- **FR-004**: Pairing is rate limited per peer address and globally.
- **FR-005**: Remote tokens: 256-bit random, only the SHA-256 is stored, 30-day expiry (`remote_token_days`), carried in an HttpOnly SameSite=Strict cookie (Secure over https), listed, revocable.
- **FR-006**: Every `/api/*` request and WebSocket upgrade authenticates; remote principals pass a default-deny allow-list in `src/remote/policy.ts`.
- **FR-007**: The live socket for a remote token cannot follow the agent browser; sockets close on revoke, expiry, or remote access turning off.
- **FR-008**: Host allow-list: loopback names always; private-IP literals only when `remote_bind=lan`; names in `remote_hosts` (a tunnel hostname).
- **FR-009**: Compact remote UI at `/remote`.
- **FR-010**: Superseded by spec 030: the three switches and the tunnel setup were replaced by one `remote_mode` (off, lan, tailscale).

## Success Criteria

- **SC-001**: A phone is paired in under 30 seconds.
- **SC-002**: The auth boundary tests cover each denied class above.

## Assumptions

- Sending a follow-up or approving a plan lets a remote token make an agent run code in the workspace. That is the point of the feature and is stated in the pairing dialog; it is why terminals and files stay separately gated.
