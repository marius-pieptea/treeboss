import type { BoardBug } from "./api";
import { BugCard } from "./BugCard";
import { LABEL } from "./Status";

/** Bugs no feature claims, by hand or by URL. A feature can be picked for each. */
export function UnsortedBugs({
  root,
  bugs,
  features,
  busy,
  pending,
  focusBug,
  onFix,
  onStatus,
  onFeature,
}: {
  root: string;
  bugs: BoardBug[];
  features: Array<{ id: string; title: string }>;
  busy: boolean;
  pending: boolean;
  focusBug: string | null;
  onFix: (id: string) => void;
  onStatus: (id: string, status: "new" | "dismissed" | "shipped") => void;
  onFeature: (id: string, feature: string | null) => void;
}) {
  if (bugs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-line px-3 py-2" aria-label="Bugs without a feature">
      <div className="flex h-7 items-center gap-2">
        <h2 className={LABEL}>Bugs without a feature</h2>
        <span className="font-mono text-label text-fg-muted">{bugs.length}</span>
      </div>
      {bugs.map((b) => (
        <BugCard key={b.id} root={root} bug={b} busy={busy} pending={pending} focused={b.id === focusBug} features={features} onFix={onFix} onStatus={onStatus} onFeature={onFeature} />
      ))}
    </section>
  );
}
