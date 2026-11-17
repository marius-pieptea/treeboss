import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BoardArea } from "./api";
import { areaCell, since } from "./logic";
import { CellView } from "./Status";

export function AreaRows({ areas, busy, onRemap }: { areas: readonly BoardArea[]; busy: boolean; onRemap: (id: string) => void }) {
  if (areas.length === 0) return null;
  return (
    <ul className="flex shrink-0 flex-col border-b border-line py-1" aria-label="Areas of the map" data-areas>
      {areas.map((a) => (
        <li key={a.id} data-area={a.id} className="group flex h-7 items-center gap-2 px-3 hover:bg-hover">
          <span className="min-w-0 truncate text-xs text-fg" title={a.where.join(" ") || undefined}>
            {a.title}
          </span>
          <CellView cell={areaCell(a)} className="shrink-0" />
          <span className="w-16 shrink-0 text-xs text-fg-muted">{a.updatedAt ? since(a.updatedAt, Date.now()) : ""}</span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => onRemap(a.id)} title={busy ? "A pipeline is running" : `Map ${a.title} again`} aria-label={`Remap ${a.title}`}>
            <RefreshCw /> Remap
          </Button>
        </li>
      ))}
    </ul>
  );
}
