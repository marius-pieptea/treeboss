import { useState } from "react";
import { Section } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { Actions, RoadmapItem, RoadmapLane } from "./data";
import { AddInline } from "./AddInline";
import { DoneToggle, LinkWarning, SessionDots, SpecBar, TargetChip } from "./ItemCard";
import { Badge } from "@/components/ui/misc";
import { STATUS_LABEL } from "./logic";

const STATUS_TONE = { shipped: "green", in_progress: "accent", not_started: "neutral" } as const;

function Row({ item, selected, onOpen, onToggle, onSession }: { item: RoadmapItem; selected: boolean; onOpen: () => void; onToggle: () => void; onSession: (id: string) => void }) {
  return (
    <div
      data-row={item.key}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          if ((e.target as HTMLElement).closest("button") && e.target !== e.currentTarget) return;
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn("group flex min-h-8 cursor-pointer items-center gap-2.5 border-b border-line px-3 py-1 text-[12.5px] outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-hover", selected && "bg-accent-soft/50")}
    >
      <DoneToggle item={item} onToggle={onToggle} className="mt-0" />
      <span className="w-9 shrink-0 font-mono text-[10px] text-fg-faint">{item.id ?? "·"}</span>
      <span className={cn("min-w-0 flex-1 truncate font-medium text-fg", item.done && "text-fg-muted line-through decoration-fg-faint/60")} title={item.title}>
        {item.title}
      </span>
      <span className="hidden shrink-0 items-center gap-1 md:flex">
        {item.tags.map((t) => (
          <Badge key={t} tone="violet">
            {t}
          </Badge>
        ))}
      </span>
      <span className="hidden w-[76px] shrink-0 md:block">
        <TargetChip target={item.target} />
      </span>
      <span className="hidden w-[110px] shrink-0 lg:block">
        <SpecBar item={item} />
      </span>
      <LinkWarning item={item} />
      <span className="w-12 shrink-0">
        <SessionDots item={item} onOpen={onSession} />
      </span>
      <span className="hidden w-[78px] shrink-0 sm:block">
        <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
      </span>
    </div>
  );
}

export function ListView({ lanes, selected, actions, adding, onAdding, onOpen, onSession }: { lanes: RoadmapLane[]; selected: string | null; actions: Actions; adding: string | null; onAdding: (lane: string | null) => void; onOpen: (key: string) => void; onSession: (id: string) => void }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div data-roadmap-list className="h-full overflow-y-auto px-4 py-3">
      <div className="mx-auto flex max-w-[980px] flex-col gap-3">
        {lanes.map((lane) => (
          <Section key={lane.name} title={lane.name} count={lane.items.length} open={!closed[lane.name]} onOpenChange={(o) => setClosed((c) => ({ ...c, [lane.name]: !o }))}>
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              {lane.items.map((it) => (
                <Row key={it.key} item={it} selected={selected === it.key} onOpen={() => onOpen(it.key)} onToggle={() => actions.update.mutate({ key: it.key, patch: { done: !it.done } })} onSession={onSession} />
              ))}
              {lane.items.length === 0 && <div className="px-3 py-3 text-[12px] text-fg-faint">Nothing here yet</div>}
              <div className="border-t border-line p-1">
                <AddInline open={adding === lane.name} onOpenChange={(o) => onAdding(o ? lane.name : null)} busy={actions.add.isPending} onAdd={(title) => actions.add.mutateAsync({ lane: lane.name, title }).catch(() => {})} />
              </div>
            </div>
          </Section>
        ))}
      </div>
    </div>
  );
}
