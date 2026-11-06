import { Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/form";
import { Badge, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { MAX_BUILD, type EvidenceItem, type FindingKind, type FindingStatus } from "./data";

export const FINDING_LABEL: Record<FindingKind, string> = { feature: "Feature", ui: "UI design" };
const STATUSES: FindingStatus[] = ["new", "planned", "built", "dismissed"];
const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: s }));

/** A status Select that saves on change. Words only: a status is never shown by color alone. */
export function FindingStatusSelect({ item, onChange, className }: { item: EvidenceItem; onChange: (status: FindingStatus) => void; className?: string }) {
  return <Select size="sm" value={item.finding_status ?? "new"} onChange={(v) => onChange(v as FindingStatus)} options={STATUS_OPTIONS} aria-label={`Status of ${item.title}`} className={cn("w-28 shrink-0", className)} />;
}

function FindingRow({ item, checked, active, onCheck, onOpen, onStatus }: { item: EvidenceItem; checked: boolean; active: boolean; onCheck: (v: boolean) => void; onOpen: () => void; onStatus: (s: FindingStatus) => void }) {
  return (
    <li className={cn("flex items-center gap-2 border-b border-line px-3 py-2 hover:bg-hover", active && "bg-primary-soft")}>
      <Checkbox checked={checked} onChange={onCheck} label={`Select ${item.title}`} />
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.title}</span>
          {item.source === "rea" && <Badge title="Produced by REA">REA</Badge>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <span>{item.finding && FINDING_LABEL[item.finding]}</span>
          {item.url && <span className="min-w-0 truncate font-mono">{item.url}</span>}
        </span>
      </button>
      <FindingStatusSelect item={item} onChange={onStatus} />
    </li>
  );
}

function Group({ label, items, selected, selectedId, onToggle, onOpen, onStatus }: { label: string; items: EvidenceItem[]; selected: string[]; selectedId: string | null; onToggle: (id: string, on: boolean) => void; onOpen: (id: string) => void; onStatus: (id: string, s: FindingStatus) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col">
      <h3 className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-fg-muted">
        {label} <span className="font-mono normal-case tracking-normal text-fg-muted">{items.length}</span>
      </h3>
      <ul>
        {items.map((i) => (
          <FindingRow key={i.id} item={i} checked={selected.includes(i.id)} active={selectedId === i.id} onCheck={(on) => onToggle(i.id, on)} onOpen={() => onOpen(i.id)} onStatus={(s) => onStatus(i.id, s)} />
        ))}
      </ul>
    </div>
  );
}

/** Findings the operator can build: features and UI designs, with a status each and multi-select for a build. */
export function FindingsSection({ items, selected, selectedId, onToggle, onOpen, onStatus, onBuild, building }: { items: EvidenceItem[]; selected: string[]; selectedId: string | null; onToggle: (id: string, on: boolean) => void; onOpen: (id: string) => void; onStatus: (id: string, s: FindingStatus) => void; onBuild: () => void; building: boolean }) {
  const features = items.filter((i) => i.finding === "feature");
  const ui = items.filter((i) => i.finding === "ui");
  const group = { selected, selectedId, onToggle, onOpen, onStatus };
  return (
    <section aria-label="Findings" className="flex flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="flex-1 text-xs font-medium uppercase tracking-wider text-fg-muted">Findings</span>
        <Button variant="primary" disabled={!selected.length || selected.length > MAX_BUILD || building} onClick={onBuild} title={selected.length > MAX_BUILD ? `Build at most ${MAX_BUILD} findings at a time` : "Hand the selected findings to a new agent session as a build brief"}>
          {building ? <Spinner /> : <Hammer />} Build selected{selected.length ? ` (${selected.length})` : ""}
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="px-3 pb-3 text-xs leading-relaxed text-fg-muted">No features or UI designs yet. Write a note and pick Feature or UI design, or ask an agent to record one.</p>
      ) : (
        <>
          <Group label="Features" items={features} {...group} />
          <Group label="UI designs" items={ui} {...group} />
        </>
      )}
    </section>
  );
}
