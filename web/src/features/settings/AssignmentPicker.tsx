import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Checkbox, Input } from "@/components/ui/form";
import { Badge, SegTabs } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { AssignMode } from "./agents-logic";

export interface AssignItem {
  name: string;
  description?: string;
  enabled: boolean;
}

/**
 * Choose which skills (or MCP servers) an agent may use: everything enabled, a named subset, or nothing.
 * A globally disabled item is listed but marked: disabling is the kill switch, so ticking it grants nothing.
 */
export function AssignmentPicker({ noun, items, mode, selected, onChange, loading }: { noun: "skill" | "MCP server"; items: AssignItem[]; mode: AssignMode; selected: string[]; onChange: (next: { mode: AssignMode; selected: string[] }) => void; loading?: boolean }) {
  const [filter, setFilter] = useState("");
  const known = useMemo(() => new Set(items.map((i) => i.name)), [items]);
  const missing = selected.filter((n) => !known.has(n));
  const q = filter.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q));
  const plural = noun === "skill" ? "skills" : "MCP servers";

  const toggle = (name: string, on: boolean) => onChange({ mode, selected: on ? [...selected, name] : selected.filter((n) => n !== name) });

  return (
    <div className="flex flex-col gap-2">
      <SegTabs
        value={mode}
        onChange={(m) => onChange({ mode: m, selected })}
        items={[
          { value: "all", label: "All enabled" },
          { value: "only", label: "Only these", badge: mode === "only" ? <span className="rounded bg-accent-soft px-1 font-mono text-[10px] text-accent">{selected.length}</span> : undefined },
          { value: "none", label: "None" },
        ]}
      />
      {mode === "all" && <p className="text-xs text-fg-muted">Every enabled {noun} is available, including ones you add later.</p>}
      {mode === "none" && <p className="text-xs text-fg-muted">No {plural}. The agent works with what its engine ships with.</p>}
      {mode === "only" && (
        <div className="animate-slide-up overflow-hidden rounded-lg border border-line bg-raised/40">
          <div className="relative border-b border-line p-1.5">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${plural}`} className="h-7 border-0 bg-transparent pl-7 text-xs" aria-label={`Filter ${plural}`} />
          </div>
          <div className="max-h-[188px] overflow-y-auto p-1" role="group" aria-label={`Assigned ${plural}`}>
            {loading && <div className="px-2 py-3 text-xs text-fg-faint">Loading…</div>}
            {!loading && items.length === 0 && <div className="px-2 py-3 text-xs text-fg-faint">No {plural} yet. Add some in Settings, then assign them here.</div>}
            {shown.map((i) => {
              const on = selected.includes(i.name);
              return (
                <label key={i.name} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-hover", !i.enabled && "opacity-70")}>
                  <Checkbox checked={on} onChange={(v) => toggle(i.name, v)} label={i.name} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-mono text-[12px]">
                      {i.name}
                      {!i.enabled && (
                        <Badge tone="amber" title="Disabled globally. Assigning it grants nothing until it is enabled again.">
                          disabled, stays off
                        </Badge>
                      )}
                    </span>
                    {i.description && <span className="line-clamp-1 block text-[11px] text-fg-muted">{i.description}</span>}
                  </span>
                </label>
              );
            })}
            {items.length > 0 && shown.length === 0 && <div className="px-2 py-3 text-center text-xs text-fg-faint">Nothing matches “{filter}”.</div>}
            {missing.map((n) => (
              <label key={n} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                <Checkbox checked onChange={() => toggle(n, false)} label={n} />
                <span className="font-mono text-[12px] text-red">{n}</span>
                <span className="text-[11px] text-red">no longer exists: untick to remove</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-2.5 py-1 text-[11px] text-fg-faint">
            <button className="outline-none hover:text-fg focus-visible:text-fg" onClick={() => onChange({ mode, selected: [...new Set([...selected, ...shown.map((i) => i.name)])] })}>
              Tick shown
            </button>
            <button className="outline-none hover:text-fg focus-visible:text-fg" onClick={() => onChange({ mode, selected: selected.filter((n) => !shown.some((i) => i.name === n)) })}>
              Clear shown
            </button>
            <span className="flex-1" />
            <span>
              {selected.length} of {items.length}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
