/**
 * `trb remote [status|pair|ls|revoke]`: pair a phone from the terminal and manage paired devices.
 * Choosing the mode is `trb config set remote_mode off|lan|tailscale`; nothing here changes it.
 */
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson } from "../fmt";

interface Device {
  id: string;
  label: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
}

const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "never");

export async function cmdRemote(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { json: { type: "boolean" }, label: { type: "string", short: "l" }, "no-qr": { type: "boolean" }, local: { type: "boolean" } });
  const sub = positionals[0] ?? "status";

  if (sub === "status") {
    const s = await api<any>("GET", "/api/remote/status");
    if (values.json) return printJson(s), 0;
    console.log(`remote mode    ${s.mode === "off" ? c.dim("off   (trb config set remote_mode lan|tailscale)") : c.green(s.mode)}`);
    if (s.mode !== "off") {
      console.log(`listening on   ${s.listen.address ? `${s.listen.address}:${s.listen.port}` : s.listen.simulated ? c.dim("(not opened: TRB_REMOTE_NO_LISTEN)") : c.yellow(s.listen.error ?? "nothing yet")}`);
      if (s.base.warning) console.log(c.yellow(s.base.warning));
    }
    console.log(`terminals      ${s.grants.terminal ? c.yellow("allowed") : "denied"}    files  ${s.grants.files === "off" ? "denied" : c.yellow(s.grants.files)}`);
    if (s.mode !== "off") console.log(`link           ${s.base.origin ?? c.yellow("none")}${s.base.origin && !s.base.reachable ? c.yellow("   (not reachable from a phone yet)") : ""}\n${c.dim(s.base.note)}`);
    console.log(`\n${s.tokens.length} paired device${s.tokens.length === 1 ? "" : "s"}${s.tokens.length ? ":" : ""}`);
    for (const t of s.tokens as Device[]) console.log(`  ${c.bold(t.id)}  ${t.label}  ${c.dim(`paired ${when(t.created_at)}, seen ${when(t.last_seen_at)}, expires ${when(t.expires_at)}`)}`);
    return 0;
  }

  if (sub === "pair") {
    const r = await api<any>("POST", "/api/remote/pair", { label: values.label, local: values.local === true });
    if (values.json) return printJson(r), 0;
    if (r.local) console.log(c.yellow("--local: this link points at 127.0.0.1 and is for development and tests. It is not for phones; a phone cannot open it."));
    if (!values["no-qr"]) console.log(`\n${r.qr_text}\n`);
    console.log(`Scan with the phone camera, or open:\n${c.bold(r.url)}\n`);
    console.log(c.dim(`One use, expires in ${r.ttl_sec} seconds. ${r.note}`));
    if (r.warning) console.log(c.yellow(r.warning));
    if (!r.reachable && !r.local) console.log(c.yellow("A phone cannot reach this address yet."));
    return 0;
  }

  if (sub === "ls" || sub === "list") {
    const { tokens } = await api<{ tokens: Device[] }>("GET", "/api/remote/tokens");
    if (values.json) return printJson({ tokens }), 0;
    if (!tokens.length) console.log(c.dim("No paired devices."));
    for (const t of tokens) console.log(`${c.bold(t.id)}  ${t.label}  ${c.dim(`paired ${when(t.created_at)}, seen ${when(t.last_seen_at)} from ${t.last_ip ?? "?"}, expires ${when(t.expires_at)}`)}`);
    return 0;
  }

  if (sub === "revoke") {
    const target = positionals[1];
    if (!target) die("Usage: trb remote revoke <device-id>|all");
    if (target === "all") {
      const r = await api<{ revoked: number }>("POST", "/api/remote/revoke-all", {});
      console.log(`revoked ${r.revoked} device${r.revoked === 1 ? "" : "s"}`);
      return 0;
    }
    await api("DELETE", `/api/remote/tokens/${encodeURIComponent(target)}`);
    console.log(`revoked ${target}`);
    return 0;
  }

  die("Usage: trb remote [status|pair [--label name] [--local]|ls|revoke <id>|all]");
}
