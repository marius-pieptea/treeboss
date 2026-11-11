import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";
import { DropdownMenu } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import type { BoardFeature } from "./api";
import { bugsCell, isOpenBug, planCell, testCell } from "./logic";
import { CellView } from "./Status";

export type RowAction = "plan" | "test" | "fix" | "stages";

export const COLS = { plan: "w-28 shrink-0", test: "w-32 shrink-0", bugs: "w-24 shrink-0" } as const;

export function FeatureRow({ f, selected, picked, busy, onOpen, onPick, onAction }: { f: BoardFeature; selected: boolean; picked: boolean; busy: boolean; onOpen: () => void; onPick: (on: boolean) => void; onAction: (a: RowAction) => void }) {
  const openBugs = f.bugs.filter(isOpenBug).length;
  const why = busy ? "A pipeline is running" : undefined;
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      data-feature={f.id}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn("group flex h-7 cursor-default items-center gap-2 px-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60", selected ? "bg-accent-soft" : "hover:bg-hover")}
    >
      <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
        <Checkbox checked={picked} onChange={onPick} label={`Pick ${f.title} for the run`} />
      </span>
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", f.depth === 1 && "pl-4")}>
        <span className="truncate text-fg">{f.title}</span>
        {f.where[0] && <span className="hidden min-w-0 truncate font-mono text-label text-fg-muted @[720px]:inline">{f.where.join(" ")}</span>}
      </span>
      <CellView cell={planCell(f)} className={COLS.plan} />
      <CellView cell={testCell(f)} className={COLS.test} />
      <CellView cell={bugsCell(f)} className={COLS.bugs} />
      <span onClick={(e) => e.stopPropagation()} className="flex w-6 shrink-0 justify-end">
        <DropdownMenu
          align="end"
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${f.title}`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal />
            </Button>
          }
          entries={[
            { label: f.plan.kind === "ready" ? "Plan again" : "Plan this feature", disabled: busy, onSelect: () => onAction("plan") },
            { label: "Test this feature", disabled: busy || f.plan.kind !== "ready", onSelect: () => onAction("test") },
            { label: openBugs ? `Fix its ${openBugs} open ${openBugs === 1 ? "bug" : "bugs"}` : "Fix its bugs", disabled: busy || openBugs === 0, onSelect: () => onAction("fix") },
            { separator: true },
            { label: "Run the stages above on it", disabled: busy, onSelect: () => onAction("stages") },
            ...(why ? [{ label: why, disabled: true }] : []),
          ]}
        />
      </span>
    </div>
  );
}
