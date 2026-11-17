import { useMemo } from "react";
import { ListChecks, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import type { BoardArea, BoardFeature } from "./api";
import { FEATURE_FILTERS, isFiltering, matchesFilter, shownLine, type FeatureFilter, type FeatureQuery } from "./logic";

export function FeatureFilterBar({ features, areas, query, shown, onChange, onSelectShown }: { features: readonly BoardFeature[]; /** The areas of the map; empty in the flat layout, where there is no area picker. */ areas: readonly BoardArea[]; query: FeatureQuery; shown: number; onChange: (q: FeatureQuery) => void; onSelectShown: () => void }) {
  const active = isFiltering(query);
  // How many features each chip alone would show, so a chip that leads nowhere says 0 before it is pressed.
  const counts = useMemo(() => Object.fromEntries(FEATURE_FILTERS.map((k) => [k.id, features.filter((f) => matchesFilter(f, k.id)).length])) as Record<FeatureFilter, number>, [features]);
  const toggle = (id: FeatureFilter) => onChange({ ...query, filters: query.filters.includes(id) ? query.filters.filter((x) => x !== id) : [...query.filters, id] });
  return (
    <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-1 border-b border-line bg-panel px-3 py-2" data-feature-filter>
      <div className="flex items-center gap-2">
        {areas.length > 0 && (
          <Combobox
            size="sm"
            value={query.area ?? ""}
            onChange={(v) => onChange({ ...query, area: v || null })}
            options={[{ value: "", label: "All areas" }, ...areas.map((a) => ({ value: a.id, label: a.title, hint: String(a.features) }))]}
            searchPlaceholder="Find an area"
            aria-label="Area"
            className="w-40 shrink-0"
          />
        )}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
          <Input
            type="search"
            value={query.text}
            onChange={(e) => onChange({ ...query, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query.text) {
                e.preventDefault();
                onChange({ ...query, text: "" });
              }
            }}
            placeholder="Find a feature by title, id, path or summary"
            aria-label="Find a feature"
            className="h-7 pl-7 text-xs [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {FEATURE_FILTERS.map((k) => {
          const on = query.filters.includes(k.id);
          return (
            <Button key={k.id} size="xs" variant="outline" aria-pressed={on} title={k.hint} onClick={() => toggle(k.id)} className={cn(on && "bg-accent-soft")}>
              {k.label}
              <span className="font-mono text-fg-muted">{counts[k.id]}</span>
            </Button>
          );
        })}
        <div className="flex-1" />
        <span className="font-mono text-label text-fg-muted" data-shown aria-live="polite">
          {shownLine(shown, features.length, active)}
        </span>
        {active && shown > 0 && (
          <Button size="xs" variant="subtle" onClick={onSelectShown} title="Pick exactly these features for the run, replacing what was picked">
            <ListChecks /> Select {shown} shown
          </Button>
        )}
        {active && (
          <Button size="xs" variant="ghost" onClick={() => onChange({ text: "", filters: [], area: null })}>
            <X /> Reset
          </Button>
        )}
      </div>
    </div>
  );
}
