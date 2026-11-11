import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QaBoard } from "./api";
import { Dot, LABEL } from "./Status";

/** Plan files whose name is not a feature of the map. They are not run; they can be deleted. */
export function OrphanPlans({ plans, pending, onDelete }: { plans: QaBoard["plansWithoutFeature"]; pending: boolean; onDelete: (slug: string) => void }) {
  const [ask, setAsk] = useState<string | null>(null);
  if (plans.length === 0) return null;
  return (
    <section className="flex flex-col border-t border-line px-3 py-2" aria-label="Plans without a feature">
      <div className="flex h-7 items-center gap-2">
        <h2 className={LABEL}>Plans without a feature</h2>
        <span className="font-mono text-label text-fg-muted">{plans.length}</span>
      </div>
      {plans.map((p) => (
        <div key={p.slug} className="flex h-7 items-center gap-2 text-xs" data-plan={p.slug}>
          <Dot tone={p.problem ? "bad" : "idle"} label={p.problem ? "problem" : "not run"} />
          <span className="shrink-0 font-mono text-label text-fg" title={p.path}>
            {p.slug}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg-muted" title={p.problem ?? p.title}>
            {p.problem ?? p.title}
          </span>
          <span className="shrink-0 font-mono text-label text-fg-muted">{p.steps} steps</span>
          {ask === p.slug ? (
            <>
              <Button size="xs" variant="danger" disabled={pending} onClick={() => (setAsk(null), onDelete(p.slug))}>
                Delete
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setAsk(null)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="xs" variant="ghost" aria-label={`Delete the plan ${p.slug}`} onClick={() => setAsk(p.slug)}>
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
