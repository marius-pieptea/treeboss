import { useState } from "react";
import { Hammer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";
import type { BoardBug } from "./api";
import { BugCard } from "./BugCard";
import { prunePickedBugs, selectableBugs } from "./logic";

export function BugList({
  root,
  bugs,
  busy,
  pending,
  focusBug,
  features,
  onFix,
  onFixMany,
  onStatus,
  onFeature,
}: {
  root: string;
  bugs: BoardBug[];
  busy: boolean;
  pending: boolean;
  focusBug: string | null;
  features?: Array<{ id: string; title: string }>;
  onFix: (id: string) => void;
  onFixMany: (ids: string[]) => void;
  onStatus: (id: string, status: "new" | "dismissed" | "shipped") => void;
  onFeature?: (id: string, feature: string | null) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const selectable = selectableBugs(bugs);
  const multi = selectable.length > 1;
  const ticked = prunePickedBugs(picked, bugs);
  const all = ticked.length === selectable.length;
  const why = busy ? "A pipeline is running. Wait for it or stop it." : undefined;
  return (
    <>
      {multi && (
        <div className="flex h-7 items-center gap-2" data-bug-bulk>
          <Checkbox checked={all ? true : ticked.length > 0 ? "indeterminate" : false} onChange={() => setPicked(all ? [] : selectable.map((b) => b.id))} label="Pick every open bug" />
          <span className="font-mono text-label text-fg-muted">{ticked.length ? `${ticked.length} of ${selectable.length} picked` : `${selectable.length} open`}</span>
          <div className="flex-1" />
          <Button
            size="xs"
            variant="subtle"
            disabled={ticked.length === 0 || busy || pending}
            title={why ?? "Start one session run that fixes the picked bugs"}
            onClick={() => {
              onFixMany(ticked);
              setPicked([]);
            }}
          >
            <Hammer /> {ticked.length ? `Fix ${ticked.length} picked` : "Fix picked"}
          </Button>
        </div>
      )}
      {bugs.map((b) => (
        <BugCard
          key={b.id}
          root={root}
          bug={b}
          busy={busy}
          pending={pending}
          focused={b.id === focusBug}
          features={features}
          onFix={onFix}
          onStatus={onStatus}
          onFeature={onFeature}
          pick={multi && selectable.includes(b) ? { checked: ticked.includes(b.id), onChange: (on) => setPicked(on ? [...ticked, b.id] : ticked.filter((x) => x !== b.id)) } : undefined}
        />
      ))}
    </>
  );
}
