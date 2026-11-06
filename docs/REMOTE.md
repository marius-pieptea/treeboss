# Remote access (phone view)

Open trb from a phone: watch sessions and heads, approve plans, answer plan questions, send follow-ups and interrupt. **Off by default.** Nothing here is enabled automatically.

One setting decides it, `remote_mode`:

| Mode | Who can reach the daemon | Listens on |
| --- | --- | --- |
| `off` (default) | this computer only; pairing refused | `127.0.0.1` |
| `lan` | phones on the same local network (plain http) | `127.0.0.1` plus this computer's LAN address |
| `tailscale` | devices on your tailnet only | `127.0.0.1` plus this computer's tailnet address |

Choose it in **Settings > Remote access**, or `trb config set remote_mode off|lan|tailscale`. It applies at once, with no daemon restart. Changing the mode (or the address behind it) closes every open remote connection.

## Same Wi-Fi (`lan`)

```sh
trb config set remote_mode lan
trb remote pair        # prints a QR code, and the one-time link as text
```

trb picks the private IPv4 address of your Wi-Fi or Ethernet and skips docker, bridge, VM, VPN and Tailscale interfaces. The daemon opens a second listener on **that one address** (never `0.0.0.0`), so the tailnet or any other interface is not exposed. The QR and link use that address, for example `http://192.168.1.20:4477/_pair?code=...`. They never point at `localhost`.

**This is plain http.** Anyone on the same network can see the traffic, including the pairing link, and can try to guess pairing codes. Use it only on a network you trust (not a café, hotel or shared office Wi-Fi). If the computer has no usable network address, choosing `lan` is refused.

## Tailscale (`tailscale`)

Needs Tailscale installed and signed in on this computer and on the phone, both on the same tailnet.

```sh
trb config set remote_mode tailscale
trb remote pair
```

trb asks the `tailscale` command for the tailnet address (`tailscale ip -4`) and the MagicDNS name (`tailscale status --json`), and opens its second listener on **the tailnet address only**. The LAN is not exposed in this mode. The QR and link use the MagicDNS name, such as `http://my-mac.tail1234.ts.net:4477/_pair?code=...`, or the `100.x` address when MagicDNS is off. Tailscale encrypts the traffic between your devices.

If Tailscale is not installed, or is installed but stopped or signed out, choosing this mode is refused with a plain instruction (install it and sign in, or run `tailscale up`). If you switch Tailscale off later, pairing is refused and no link is shown.

### If the tailnet address cannot be bound

With Tailscale's userspace networking (no network interface) the OS has no `100.x` address to bind, and the status page shows a "could not listen" message. Keep `remote_mode` at `tailscale` and let Tailscale forward to the loopback daemon:

```sh
tailscale serve --bg 4477
```

(Use the port `trb daemon status` shows.) The link then becomes `https://my-mac.tail1234.ts.net/_pair?code=...`. Requests arrive from `127.0.0.1` with your MagicDNS name as the `Host`, which the allow-list accepts; the owner's own credentials are still ignored for any non-loopback `Host`, so only paired devices get in. `tailscale serve` stays on your tailnet; do not use `tailscale funnel`, which makes it public.

## How it is secured

- The daemon's main listener stays on `127.0.0.1`, and the 0600 `~/.treeboss/token` is unchanged. The owner's token and `trb ui` cookie are honoured **only for a loopback `Host` from a loopback peer**. Over the LAN or a tailnet they are ignored. The second listener also refuses a loopback `Host`.
- A phone authenticates with its own **remote token**: 256 random bits, stored only as a SHA-256 hash, in an HttpOnly, SameSite=Strict cookie, expiring after `remote_token_days` (30). It is listed in *Settings > Remote access* and revocable; revoking closes its open sockets at once, and turning the mode off does so immediately. No long-lived HTTP stream is allowed for a device, only the live socket.
- A token is minted only by redeeming a **one-time pairing code**: 192 random bits, valid 120 seconds, spent by its first use, at most five outstanding, in memory only. The QR opens `/_pair?code=...`, which shows a confirm button (a link preview cannot spend the code); the POST spends it. Guessing is rate limited per peer address (10/min) and globally (40/min), answering 429 with `Retry-After`.
- **Host allow-list, exact per mode.** Loopback names always. `lan`: only the detected LAN address. `tailscale`: only the MagicDNS name and the tailnet address. Any other `Host` (a different private address, a DNS-rebinding name) is refused.
- **Default deny.** A remote token reaches only `src/remote/policy.ts`'s list: sessions (read, optionally filtered to one workspace), the workspace switcher's list (`GET /api/remote/workspaces`: names and running/failed counts, no folder paths), their logs/turns/diff/plan state, `send`, `interrupt`, plan answers and plan approve / request-changes / skip, and the live socket. Everything else (config, MCP, skills, git, terminals, files, creating/closing/merging/spawning sessions, shutdown, the agent browser stream, the remote management API itself) is 403 for a remote token. A route added to the daemon later is owner-only until it is listed.
- **Grants, off by default, checked live:** `remote_allow_terminal` (a shell on this computer) and `remote_allow_files` (`read` or `write`).

What a paired phone can do is still powerful: a follow-up or plan approval makes an agent run code in the workspace, as it does from the desktop. Pair only devices you control, and revoke lost ones.

## Upgrading

The old `remote_access`, `remote_bind` and `remote_hosts` settings are gone. At the first daemon start they are converted: access on with `remote_bind=lan` becomes `lan`; everything else becomes `off`. Paired devices stay paired.

## Commands

```
trb remote [status]        mode, bound address, the link a phone would open, paired devices
trb remote pair [--label]  one-time link + terminal QR (--json for the SVG)
trb remote pair --local    loopback link for development and tests; says it is not for phones
trb remote ls | revoke <id>|all
trb config set remote_mode off|lan|tailscale
```

Settings: `remote_mode`, `remote_allow_terminal`, `remote_allow_files`, `remote_token_days`.

## Verifying it yourself

`bun test tests/remote-auth.test.ts` covers the boundaries above with injected interfaces, a fake `tailscale` and a recording listener, so nothing binds a network address. `bun run build:web && TRB_WEB_DIR=$PWD/web/dist bun run scripts/ui-remote.ts` pairs a phone-sized Chrome through the real pages on loopback.
