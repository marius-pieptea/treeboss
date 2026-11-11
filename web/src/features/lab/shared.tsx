import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Empty, Skeleton, Spinner } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { fixBlock } from "./logic";
import { useLab, useLabActions, type SweepView } from "./data";

/** A sweep that is still going: how far along it is, and a way to stop starting new modules. */
export function SweepRow({ sweep: s, onCancel }: { sweep: SweepView; onCancel: () => void }) {
  const pct = s.total ? Math.round(((s.done + s.failed) / s.total) * 100) : 0;
  return (
    <div data-sweep={s.id} className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 px-3 py-2">
      <Spinner className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">
          Sweeping {s.total} modules · {s.lens}
        </div>
        <div className="text-[11.5px] text-fg-muted">
          {s.done} done, {s.running} running, {s.queued} waiting{s.failed > 0 && `, ${s.failed} could not start`}
        </div>
        {s.lastError && (
          <div className="mt-1 text-sm">
            <Badge tone="red">{s.lastError}</Badge>
          </div>
        )}
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {s.queued > 0 && (
        <Button size="xs" variant="ghost" onClick={onCancel} title="The running modules finish; the waiting ones are not started">
          <X /> Stop
        </Button>
      )}
    </div>
  );
}

/** The data both list views read: the Lab state, the actions on it, and what blocks a fix right now. Renders nothing until it loads. */
export function useLabView() {
  const { root } = useWorkspace();
  const q = useLab(root);
  const actions = useLabActions(root);
  const findings = q.data?.findings ?? [];
  const busy = actions.toRoadmap.isPending || actions.toSpec.isPending || actions.fix.isPending || actions.design.isPending || actions.setStatus.isPending;
  return { root, q, state: q.data, actions, busy, fixBlockOf: (id: string) => fixBlock(findings, id) };
}

/** The page every Lab view sits in: its title and what it is for, then the content. */
export function LabPage({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-5 py-5">
        <header className="flex items-center gap-2">
          <span className="text-accent [&_svg]:size-5">{icon}</span>
          <div>
            <h1 className="text-[15px] font-semibold">{title}</h1>
            <p className="text-[12px] text-fg-muted">{hint}</p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/** The loading and failure states of a Lab view, or null once its state is there. */
export function LabGate({ q, icon, title }: { q: { isLoading: boolean; error: unknown; data: unknown }; icon: React.ReactNode; title: string }) {
  if (q.isLoading) return <Skeleton className="m-4 h-40" />;
  if (q.error || !q.data) return <Empty icon={icon} title={`${title} could not load`} hint={(q.error as Error | null)?.message} />;
  return null;
}
