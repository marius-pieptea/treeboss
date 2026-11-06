import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Smartphone, Trash2 } from "lucide-react";
import { del, get, post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Select, Switch } from "@/components/ui/form";
import { Badge, Skeleton } from "@/components/ui/misc";
import { countdown, grantsLabel, modeBlocked, MODES, pairingShowable, secondsLeft, type RemoteModeId } from "@/remote/logic";
import { api as settingsApi } from "./data";
import { PageShell } from "./shared";

interface Device {
  id: string;
  label: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  user_agent: string | null;
}
interface Status {
  mode: RemoteModeId;
  enabled: boolean;
  listen: { address: string | null; port: number | null; error: string | null; simulated: boolean };
  detected: { lan: { ip: string; iface: string } | null; tailscale: { state: string; ip?: string; dnsName?: string; message: string } };
  grants: { terminal: boolean; files: "off" | "read" | "write" };
  base: { origin: string | null; kind: string | null; reachable: boolean; note: string; warning: string | null };
  tokens: Device[];
}
interface Pairing {
  url: string;
  expires_at: string;
  reachable: boolean;
  note: string;
  warning: string | null;
  qr_svg: string;
}

const KEY = ["remote", "status"] as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

function Row({ title, help, children }: { title: string; help: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-x-6 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        <p className="mt-0.5 max-w-[60ch] text-xs leading-relaxed text-fg-muted">{help}</p>
      </div>
      <div className="flex items-center pt-0.5">{children}</div>
    </div>
  );
}

function PairPanel({ pairing, onClose }: { pairing: Pairing; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = secondsLeft(pairing.expires_at, now);
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start gap-5">
        {pairingShowable(pairing.url) ? <img alt="QR code to pair a phone" src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qr_svg)}`} className={left ? "size-44 rounded-lg bg-white p-1" : "size-44 rounded-lg bg-white p-1 opacity-20"} /> : null}
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="font-medium">{left ? `Scan with the phone camera. Valid for ${countdown(left)}, one use.` : "This code has expired."}</div>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">After scanning, tap <em>Pair this device</em> on the phone. Once paired it can watch sessions, approve plans, answer questions, send follow-ups and interrupt, until you revoke it below.</p>
          {pairing.warning && <p className="mt-2 text-xs text-amber">{pairing.warning}</p>}
          {!pairing.reachable && <p className="mt-2 text-xs text-amber">A phone cannot reach this address yet: {pairing.note}</p>}
          {pairing.reachable && <p className="mt-2 text-xs text-fg-muted">{pairing.note}</p>}
          <div className="mt-2 flex items-center gap-1.5">
            <code data-testid="pair-url" className="min-w-0 flex-1 break-all rounded bg-raised px-2 py-1 font-mono text-[11px]">{pairing.url}</code>
            <Button size="icon" variant="ghost" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(pairing.url).then(() => toast.success("Link copied"))}>
              <Copy />
            </Button>
          </div>
          <Button size="sm" variant="outline" className="mt-3" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </section>
  );
}

function ModePicker({ s, onChoose, busy }: { s: Status; onChoose: (m: RemoteModeId) => void; busy: boolean }) {
  return (
    <div role="radiogroup" aria-label="Remote access mode" className="grid gap-2 sm:grid-cols-3">
      {MODES.map((m) => {
        const blocked = modeBlocked(m.id, s.detected);
        const active = s.mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-mode={m.id}
            disabled={busy || (!!blocked && !active)}
            onClick={() => onChoose(m.id)}
            className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed ${active ? "border-accent bg-panel" : "border-line hover:bg-raised"} ${blocked && !active ? "opacity-70" : ""}`}
          >
            <div className="text-[13px] font-medium">{m.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{m.blurb}</p>
            {blocked && !active && <p className="mt-1.5 text-xs leading-relaxed text-amber">{blocked}</p>}
          </button>
        );
      })}
    </div>
  );
}

function StatusBlock({ s }: { s: Status }) {
  const l = s.listen;
  return (
    <section data-testid="remote-status" className="rounded-xl border border-line px-4 py-3 text-[13px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-fg-muted">Listening on</dt>
        <dd className="font-mono text-xs">{l.address ? `${l.address}:${l.port}` : l.simulated ? "not opened (test mode)" : "nothing yet"}</dd>
        <dt className="text-fg-muted">Phones open</dt>
        <dd className="font-mono text-xs break-all">{s.base.origin ?? "no address available"}</dd>
      </dl>
      {s.mode === "lan" && s.base.warning && <p className="mt-2 text-xs leading-relaxed text-amber">{s.base.warning}</p>}
      {s.mode === "tailscale" && <p className="mt-2 text-xs leading-relaxed text-fg-muted">{s.detected.tailscale.message}</p>}
      {l.error && <p className="mt-2 text-xs leading-relaxed text-amber">{l.error}</p>}
    </section>
  );
}

export function RemotePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => get<Status>("/api/remote/status"), refetchInterval: 5000 });
  const s = q.data;
  const [pairing, setPairing] = useState<Pairing | null>(null);

  const set = useMutation({
    mutationFn: (v: { key: string; value: string }) => settingsApi.config.set(v.key, v.value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const pair = useMutation({
    mutationFn: () => post<Pairing>("/api/remote/pair", {}),
    onSuccess: setPairing,
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/remote/tokens/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toast.error(e.message),
  });
  const revokeAll = useMutation({
    mutationFn: () => post<{ revoked: number }>("/api/remote/revoke-all", {}),
    onSuccess: (r) => {
      toast.success(`Revoked ${r.revoked} device${r.revoked === 1 ? "" : "s"}`);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });

  const choose = async (mode: RemoteModeId) => {
    if (!s || mode === s.mode) return;
    if (mode === "lan") {
      const ok = await confirm({
        title: "Allow phones on your local network?",
        description: "This is plain http. Anyone on the same Wi-Fi or Ethernet can see the traffic, including the pairing link. Phones you pair can read your sessions and make agents run code in your workspaces. Use it only on a network you trust.",
        confirmLabel: "Use local network",
        danger: true,
      });
      if (!ok) return;
    }
    if (mode === "off") setPairing(null);
    set.mutate({ key: "remote_mode", value: mode });
  };

  return (
    <PageShell title="Remote access" description="Open the compact view from a phone: approve plans, answer questions, watch heads, send follow-ups and interrupt. Off by default; pick one way in: your local network or Tailscale. Every request is authenticated with a token that only a one-time QR code can create, and each device can be revoked.">
      {q.isLoading && <Skeleton className="h-64" />}
      {s && (
        <>
          <ModePicker s={s} onChoose={(m) => void choose(m)} busy={set.isPending} />
          {s.mode !== "off" && <StatusBlock s={s} />}

          <div className="overflow-hidden rounded-xl border border-line">
            <Row title="Terminals" help="Off: a remote device cannot open a terminal. On: it gets a shell on this computer. Leave off unless you need it.">
              <Switch checked={s.grants.terminal} disabled={!s.enabled} label="Allow terminals" onChange={async (v) => { if (!v || (await confirm({ title: "Allow terminals from remote devices?", description: "Any paired device could run commands on this computer.", confirmLabel: "Allow", danger: true }))) set.mutate({ key: "remote_allow_terminal", value: v ? "on" : "off" }); }} />
            </Row>
            <Row title="Workspace files" help="Off, read, or read and write. Writing lets a paired device change files directly.">
              <Select size="sm" className="w-40" value={s.grants.files} disabled={!s.enabled} aria-label="Workspace files" onChange={(v) => set.mutate({ key: "remote_allow_files", value: v })} options={[{ value: "off", label: "No access" }, { value: "read", label: "Read" }, { value: "write", label: "Read and write" }]} />
            </Row>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="primary" size="md" disabled={!s.enabled || !s.base.origin || pair.isPending} onClick={() => pair.mutate()}>
              <Smartphone /> Pair a phone
            </Button>
            {!s.enabled && <span className="text-xs text-fg-muted">Choose Local network or Tailscale first.</span>}
            {s.enabled && !s.base.origin && <span className="text-xs text-amber">{s.base.note}</span>}
          </div>
          {pairing && <PairPanel pairing={pairing} onClose={() => { setPairing(null); void qc.invalidateQueries({ queryKey: KEY }); }} />}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Paired devices</h2>
              {s.tokens.length > 1 && (
                <Button size="xs" variant="dangerGhost" onClick={async () => (await confirm({ title: "Revoke every device?", description: "All paired phones are signed out at once.", confirmLabel: "Revoke all", danger: true })) && revokeAll.mutate()}>
                  Revoke all
                </Button>
              )}
            </div>
            <div className="overflow-hidden rounded-xl border border-line">
              {s.tokens.length === 0 && <p className="px-4 py-5 text-center text-xs text-fg-muted">No paired devices.</p>}
              {s.tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      {t.label} <Badge tone="neutral">{t.id}</Badge>
                    </div>
                    <div className="text-[11.5px] text-fg-muted">
                      Paired {when(t.created_at)} · last seen {when(t.last_seen_at)}
                      {t.last_ip ? ` from ${t.last_ip}` : ""} · expires {when(t.expires_at)}
                    </div>
                    <div className="text-[11.5px] text-fg-faint">Can: {grantsLabel(s.grants)}</div>
                  </div>
                  <Button size="sm" variant="dangerGhost" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
                    <Trash2 /> Revoke
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}
