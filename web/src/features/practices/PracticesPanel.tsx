import { useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/form";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { CheckRow } from "./CheckRow";
import { PackBadge, PracticesEditor } from "./PracticesEditor";
import { usePracticeActions, usePracticeCatalog, usePracticeSettings, type CheckReport, type Enforce, type Pack, type PracticeFinding, type PracticeSettings, type Thresholds } from "./data";
import { checkOn, ruleOn, switchedOf, toggled, withSwitched } from "./logic";

const ENFORCE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "warn", label: "Warn" },
  { value: "fix", label: "Fix" },
];
const ENFORCE_HINT: Record<Enforce, string> = {
  off: "Checks do not run after a turn.",
  warn: "Findings are reported in the verify results and the log. Nothing is sent back to the agent.",
  fix: "A finding is sent back to the agent as a fix turn, with the same retries as a failing check.",
};

/** The packs of this workspace as toggle cards, how findings are enforced, the thresholds, and a check of the whole repo. */
export function PracticesPanel() {
  const { workspace } = useWorkspace();
  const ws = workspace.id;
  const catalog = usePracticeCatalog();
  const settings = usePracticeSettings(ws);
  const actions = usePracticeActions(ws);
  const [draft, setDraft] = useState<Thresholds | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [managing, setManaging] = useState(false);

  const enabled = settings.data?.enabled ?? [];
  const toggle = (id: string, on: boolean) => actions.save.mutate({ enabled: on ? [...enabled, id] : enabled.filter((x) => x !== id) });
  const saveThresholds = () => {
    if (!draft) return;
    actions.save.mutate({ thresholds: draft }, { onSuccess: () => setDraft(null) });
  };

  if (managing) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <PracticesEditor onBack={() => setManaging(false)} />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3 p-3" aria-label="Practice packs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[length:var(--text-sm)] text-fg-muted">Rules every agent here follows. The enabled packs' checks run after each turn that changes files here.</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="subtle" size="sm" onClick={() => setManaging(true)}>
            <ListChecks /> Manage packs
          </Button>
          <Button variant="subtle" size="sm" onClick={() => actions.check.mutate(undefined, { onSuccess: setReport })} disabled={actions.check.isPending || !enabled.length}>
            <ShieldCheck /> {actions.check.isPending ? "Checking…" : "Check now"}
          </Button>
        </div>
      </div>

      {settings.data && (
        <Field label="When a check finds something" hint={ENFORCE_HINT[settings.data.enforce]}>
          <Select
            aria-label="Enforce mode"
            size="sm"
            className="max-w-xs"
            value={settings.data.enforce}
            options={ENFORCE_OPTIONS}
            onChange={(v) => actions.save.mutate({ enforce: v as Enforce })}
          />
        </Field>
      )}

      {catalog.isLoading || settings.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Packs">
          {(catalog.data?.packs ?? []).map((p) => (
            <PackCard key={p.id} pack={p} settings={settings.data} on={enabled.includes(p.id)} busy={actions.save.isPending} onToggle={(v) => toggle(p.id, v)} onSwitch={(off) => actions.save.mutate({ off })} />
          ))}
        </ul>
      )}

      {settings.data && <ThresholdsForm value={draft ?? settings.data.thresholds} dirty={draft !== null} busy={actions.save.isPending} onChange={setDraft} onReset={() => setDraft(null)} onSave={saveThresholds} />}

      {report && <Findings report={report} />}
      {report?.skipped.map((s) => (
        <p key={s.reason} className="text-[length:var(--text-sm)] text-fg-muted">
          {s.reason}
        </p>
      ))}
    </section>
  );
}

function PackCard({ pack: p, settings, on, busy, onToggle, onSwitch }: { pack: Pack; settings: PracticeSettings | undefined; on: boolean; busy: boolean; onToggle: (on: boolean) => void; onSwitch: (off: PracticeSettings["off"]) => void }) {
  const [open, setOpen] = useState(false);
  const off = settings?.off ?? {};
  // Switching a rule or check off here keeps it off in this workspace only; the pack itself is unchanged.
  const setSwitch = (next: { rules?: string[]; checks?: string[] }) => onSwitch(withSwitched(off, p.id, { ...switchedOf(off, p.id), ...next }));
  return (
    <li className="rounded-lg border border-line bg-panel p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--text-lg)] font-semibold">{p.title}</span>
            <Badge>{p.rules.length} rules</Badge>
            {p.appliesTo.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
            <PackBadge pack={p} />
          </div>
          <p className="mt-1 text-[length:var(--text-sm)] text-fg-muted">{p.summary}</p>
          <Button variant="ghost" size="xs" className="mt-1" aria-expanded={open} aria-controls={`pack-${p.id}`} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown /> : <ChevronRight />} {open ? "Hide rules" : "Show rules"}
          </Button>
          {open && (
            <div id={`pack-${p.id}`} className="mt-2 flex flex-col gap-3">
              <ul className="flex flex-col gap-1.5" aria-label={`${p.title} rules`}>
                {p.rules.map((r) => (
                  <li key={r}>
                    <CheckRow label={r} checked={ruleOn(off, p.id, r)} onChange={(v) => setSwitch({ rules: toggled(switchedOf(off, p.id).rules, r, v) })} className={!on ? "opacity-60" : undefined} />
                  </li>
                ))}
              </ul>
              {p.knownChecks.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Checks</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {p.knownChecks.map((c) => {
                      const carried = !!p.checks?.includes(c);
                      return (
                        <CheckRow key={c} mono label={c} checked={checkOn(p, off, c)} onChange={(v) => setSwitch({ checks: toggled(switchedOf(off, p.id).checks, c, v) })} className={carried ? undefined : "opacity-60"} />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <Switch checked={on} onChange={onToggle} disabled={busy} label={`${on ? "Turn off" : "Turn on"} ${p.title}`} />
      </div>
    </li>
  );
}

function ThresholdsForm({ value, dirty, busy, onChange, onReset, onSave }: { value: Thresholds; dirty: boolean; busy: boolean; onChange: (t: Thresholds) => void; onReset: () => void; onSave: () => void }) {
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3"
      aria-label="Check thresholds"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center gap-1.5 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">
        <SlidersHorizontal className="size-3.5" /> Thresholds
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max lines per file" hint="Small units">
          <Input type="number" min={5} max={10000} className="font-mono" value={value.maxFileLines} onChange={(e) => onChange({ ...value, maxFileLines: Number(e.target.value) })} />
        </Field>
        <Field label="Max lines per function" hint="Small units">
          <Input type="number" min={5} max={10000} className="font-mono" value={value.maxFunctionLines} onChange={(e) => onChange({ ...value, maxFunctionLines: Number(e.target.value) })} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty} onClick={onReset}>
          Reset
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || busy}>
          Save thresholds
        </Button>
      </div>
    </form>
  );
}

function Findings({ report }: { report: CheckReport }) {
  if (!report.findings.length) {
    return <Empty title={report.packs.length ? `Nothing found in ${report.checked} files` : "No packs are on"} hint={report.packs.length ? `Checked against ${report.packs.join(", ")}.` : "Turn a pack on to check it."} />;
  }
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel" aria-label="Findings">
      {report.findings.map((f, i) => (
        <FindingRow key={`${f.packId}-${f.file}-${f.line ?? 0}-${i}`} finding={f} />
      ))}
    </ul>
  );
}

function FindingRow({ finding: f }: { finding: PracticeFinding }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Badge>{f.packId}</Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[length:var(--text-sm)]">
          {f.file}
          {f.line ? `:${f.line}` : ""}
        </div>
        <div className="text-[length:var(--text-sm)] text-fg-muted">{f.message}</div>
      </div>
    </li>
  );
}
