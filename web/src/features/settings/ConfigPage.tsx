import { useEffect, useRef, useState } from "react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Input, Select, Switch } from "@/components/ui/form";
import { Badge, Skeleton, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { useEngines } from "@/lib/queries";
import type { Setting } from "@/lib/types";
import { api, keys, useAction, useCliLink, useConfig } from "./data";
import { SETTING_GROUPS, cliLinkOffer, coerceSetting, settingMeta, stepSetting } from "./logic";
import { PageShell, WarnNote } from "./shared";
import { useSettingsUi } from "./ui-state";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

function SettingRow({ s, engines }: { s: Setting; engines: Array<{ id: string; installed: boolean }> }) {
  const meta = settingMeta(s.key, s.default);
  const current = String(s.value);
  const [text, setText] = useState(current);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const focused = useSettingsUi((u) => u.focusedSetting === s.key);
  const rowRef = useRef<HTMLDivElement>(null);
  const set = useAction((v: string) => api.config.set(s.key, v), { invalidate: [keys.config], quiet: true });
  const reset = useAction(() => api.config.reset(s.key), { invalidate: [keys.config], quiet: true });

  // The daemon's value is the truth: follow it when it changes under us (a reset, a CLI edit).
  useEffect(() => setText(current), [current]);
  useEffect(() => {
    if (status.kind !== "saved") return;
    const t = setTimeout(() => setStatus({ kind: "idle" }), 1600);
    return () => clearTimeout(t);
  }, [status]);
  // A search hit scrolls its row into view and highlights it for a moment.
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => useSettingsUi.getState().focusSetting(null), 1600);
    return () => clearTimeout(t);
  }, [focused]);

  const commit = async (raw: string) => {
    const c = coerceSetting(meta, raw);
    if (c.value === null) return setStatus({ kind: "error", message: c.error ?? "Invalid value." });
    if (c.value === current) return setStatus({ kind: "idle" });
    setStatus({ kind: "saving" });
    try {
      await set.mutateAsync(c.value);
      setStatus({ kind: "saved" });
    } catch (e: any) {
      setStatus({ kind: "error", message: e.message });
    }
  };

  let control: React.ReactNode;
  if (meta.kind === "toggle") {
    control = <Switch checked={current === meta.options?.[1]} disabled={status.kind === "saving"} label={meta.label} onChange={(on) => void commit(meta.options?.[on ? 1 : 0] ?? "")} />;
  } else if (meta.kind === "enum" || s.key === "default_engine") {
    const opts = meta.kind === "enum" ? (meta.options ?? []).map((o) => ({ value: o, label: o })) : engines.map((e) => ({ value: e.id, label: e.id, hint: e.installed ? undefined : "not installed" }));
    if (!opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
    control = <Select size="sm" className="w-44" value={text} options={opts} onChange={(v) => { setText(v); void commit(v); }} aria-label={meta.label} />;
  } else if (meta.kind === "number") {
    control = (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" aria-label="Decrease" onClick={() => { const v = stepSetting(meta, text, -1); setText(v); void commit(v); }}>
          <Minus />
        </Button>
        <Input value={text} inputMode="numeric" onChange={(e) => { setText(e.target.value); if (status.kind === "error") setStatus({ kind: "idle" }); }} onBlur={() => void commit(text)} onKeyDown={(e) => { if (e.key === "Enter") void commit(text); if (e.key === "Escape") { setText(current); setStatus({ kind: "idle" }); } }} className={cn("h-7 w-20 text-center font-mono text-xs", status.kind === "error" && "border-red/60")} aria-label={meta.label} aria-invalid={status.kind === "error"} />
        <Button variant="outline" size="icon-sm" aria-label="Increase" onClick={() => { const v = stepSetting(meta, text, 1); setText(v); void commit(v); }}>
          <Plus />
        </Button>
      </div>
    );
  } else {
    control = <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void commit(text)} onKeyDown={(e) => e.key === "Enter" && void commit(text)} spellCheck={false} className="h-7 w-72 font-mono text-xs" placeholder="(empty)" aria-label={meta.label} />;
  }

  return (
    <div ref={rowRef} id={`setting-${s.key}`} className={cn("grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-b border-line px-4 py-3 transition-colors duration-200 last:border-b-0", focused && "bg-active")}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{meta.label}</span>
          {s.custom && <Badge tone="accent">modified</Badge>}
          {meta.restart && <Badge tone="amber" title="Read when the daemon starts">restart needed</Badge>}
        </div>
        <p className="mt-0.5 max-w-[60ch] text-xs leading-relaxed text-fg-muted">{s.help}</p>
        <div className="mt-1 font-mono text-[10.5px] text-fg-faint">
          {s.key} · default {String(s.default) === "" ? "(empty)" : String(s.default)}
        </div>
      </div>
      <div className="flex items-start gap-2 pt-0.5">
        {control}
        <div className="flex h-7 w-5 items-center justify-center">
          {status.kind === "saving" && <Spinner />}
          {status.kind === "saved" && <Check className="size-4 text-green animate-pop" />}
        </div>
        <IconButton label="Reset to default" size="icon-sm" disabled={!s.custom || reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: () => setStatus({ kind: "idle" }) })} className={cn(!s.custom && "invisible")}>
          <RotateCcw />
        </IconButton>
      </div>
      {status.kind === "error" && (
        <p role="alert" className="col-span-2 text-xs text-red animate-slide-up">
          {status.message}
        </p>
      )}
      {s.key === "port" && <p className="col-span-2 text-[11px] text-fg-faint">Takes effect the next time the daemon starts: `trb daemon restart`.</p>}
    </div>
  );
}

/** Offers to put `trb` on the PATH: the app bundles it where no terminal looks. */
function CliLinkCard() {
  const q = useCliLink();
  const install = useAction((target: string | null) => api.cliLink.install(target), { invalidate: [keys.cliLink], success: (r) => (r.note ? r.note : `Linked ${r.linked}. Open a new terminal to use trb.`) });
  const offer = q.data ? cliLinkOffer(q.data) : null;
  if (!offer) return null;
  return (
    <WarnNote>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">{offer.text}</span>
        {offer.target && (
          <Button size="xs" variant="outline" disabled={install.isPending} onClick={() => install.mutate(offer.target)}>
            {install.isPending ? <Spinner /> : null} Install the trb command
          </Button>
        )}
      </div>
    </WarnNote>
  );
}

export function ConfigPage() {
  const q = useConfig();
  const engines = useEngines();
  const list = q.data ?? [];
  const groups = [...SETTING_GROUPS, "Other" as const].map((g) => ({ name: g, items: list.filter((s) => settingMeta(s.key, s.default).group === g) })).filter((g) => g.items.length);
  const modified = list.filter((s) => s.custom).length;
  return (
    <PageShell title="Settings" description={`How the daemon runs sessions. ${modified ? `${modified} setting${modified === 1 ? " differs" : "s differ"} from the defaults.` : "Everything is at its default."} Changes apply to the next turn.`}>
      {q.isLoading && <Skeleton className="h-64" />}
      <CliLinkCard />
      {groups.map((g, gi) => (
        <section key={g.name} style={{ animationDelay: `${gi * 40}ms` }} className="animate-slide-up">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{g.name}</h2>
          <div className="overflow-hidden rounded-xl border border-line">
            {g.items.map((s) => (
              <SettingRow key={s.key} s={s} engines={engines.data ?? []} />
            ))}
          </div>
        </section>
      ))}
    </PageShell>
  );
}
