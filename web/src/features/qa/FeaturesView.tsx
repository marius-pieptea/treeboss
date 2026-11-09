import * as React from "react";
import { Bot, Map as MapIcon, Play, Sparkles, Square } from "lucide-react";
import { WhoPicker, useWho } from "@/components/agent-who";
import { Button } from "@/components/ui/button";
import { Badge, Empty, Skeleton, Spinner } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { ago } from "@/features/specs/logic";
import { type BatchView, type Feature, useFeatures, useQaActions } from "./api";
import { Banner } from "./Banner";
import { batchLine, COVERAGE, e2ePlansOf, lastRunLine, SESSION_LABEL, sortFeatures } from "./logic";

/**
 * The feature map (lab/features.md): what a user can do, the plans that test each feature, and how their last runs
 * went. From here an agent maps the features, drafts a plan for one, and runs plans end to end, one after another.
 */
export function FeaturesView({ root, onOpenPlan }: { root: string; onOpenPlan: (slug: string) => void }) {
  const q = useFeatures(root);
  const actions = useQaActions(root);
  const [who, setWho] = useWho();
  const data = q.data;
  const features = React.useMemo(() => sortFeatures(data?.features ?? []), [data?.features]);
  const runnable = React.useMemo(() => e2ePlansOf(features), [features]);
  const mapping = !!data?.session?.running;
  const batch = data?.batch ?? null;
  const running = !!batch?.running;

  if (q.isPending) {
    return (
      <div className="grid gap-2 p-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (q.error || !data) return <div className="p-4 text-xs text-red">{(q.error as Error | null)?.message ?? "The feature map could not be read."}</div>;

  const map = () => actions.mapFeatures.mutate({ ...who });
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="shrink-0 text-[15px] font-semibold">Features</h2>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <WhoPicker who={who} onChange={setWho} inline />
              {data.exists && (
                <Button size="sm" variant="outline" disabled={mapping || actions.mapFeatures.isPending} onClick={map} title="An agent reads the code and the running app and updates lab/features.md, keeping the plans already linked">
                  <MapIcon /> Update map
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={runnable.length === 0 || running || actions.e2e.isPending}
                title={runnable.length === 0 ? "No feature has a plan with steps yet" : "An agent runs every linked plan in its own browser, one after another, and logs the bugs it finds"}
                onClick={() => actions.e2e.mutate({ plans: runnable, ...who })}
              >
                <Bot /> Run all end to end{runnable.length > 0 && <span className="font-mono">({runnable.length})</span>}
              </Button>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">What a user can do, the plans that test each feature, and how their last runs went. The map is lab/features.md: edit it like any file.</p>
          {mapping && data.session && (
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <Spinner /> {SESSION_LABEL.map}
              <button type="button" onClick={() => openSession(data.session!.sessionId)} className="text-fg underline underline-offset-2 outline-none hover:text-accent">
                Open session
              </button>
            </span>
          )}
          {data.session?.problem && !mapping && <Banner>{data.session.problem}</Banner>}
          {data.problem && <Banner>{data.problem}</Banner>}
          {batch && <BatchRow batch={batch} busy={actions.cancelBatch.isPending} onCancel={() => actions.cancelBatch.mutate(batch.id)} />}
        </header>
        {!data.exists ? (
          <Empty
            icon={<MapIcon />}
            title="No feature map yet"
            hint="An agent lists what users can do, from the code and the running app."
            action={
              <Button size="sm" variant="primary" disabled={mapping || actions.mapFeatures.isPending} onClick={map}>
                <MapIcon /> Map features
              </Button>
            }
          />
        ) : features.length === 0 ? (
          <Empty icon={<MapIcon />} title="The map lists no features" hint='Each feature starts with a "## " heading in lab/features.md.' />
        ) : (
          <ul className="flex flex-col gap-2">
            {features.map((f) => (
              <li key={f.id}>
                <FeatureCard f={f} batchBusy={running || actions.e2e.isPending} drafting={actions.planFeature.isPending} onOpenPlan={onOpenPlan} onDraft={() => actions.planFeature.mutate({ id: f.id, ...who }, { onSuccess: (r) => onOpenPlan(r.plan.slug) })} onRun={(plans) => actions.e2e.mutate({ plans, ...who })} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BatchRow({ batch, busy, onCancel }: { batch: BatchView; busy: boolean; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        {batch.running ? <Spinner /> : <Bot className="size-3.5 text-fg-muted" />}
        <span className="font-medium">{batch.running ? "End-to-end run" : "Last end-to-end run"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{batchLine(batch)}</span>
        {!batch.running && <span className="text-[11px] text-fg-faint">{ago(batch.createdAt)}</span>}
        {batch.running && !batch.cancelled && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel} title="Start no more plans. The one running now finishes.">
            <Square /> Stop after this plan
          </Button>
        )}
      </div>
      {batch.errors.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-amber">
          {batch.errors.map((e) => (
            <li key={e.plan}>
              <span className="font-mono">{e.plan}</span>: {e.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeatureCard({ f, batchBusy, drafting, onOpenPlan, onDraft, onRun }: { f: Feature; batchBusy: boolean; drafting: boolean; onOpenPlan: (slug: string) => void; onDraft: () => void; onRun: (plans: string[]) => void }) {
  const cov = COVERAGE[f.coverage];
  const runnable = e2ePlansOf([f]);
  return (
    <article data-feature={f.id} className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-3 py-2.5">
      <header className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">{f.title}</h3>
        <Badge tone={cov.tone}>{cov.label}</Badge>
      </header>
      {f.where.length > 0 && <div className="truncate font-mono text-[11px] text-fg-muted">{f.where.join("  ")}</div>}
      {f.summary && <p className="line-clamp-2 text-[12px] leading-snug text-fg-muted">{f.summary}</p>}
      {f.planInfo.length > 0 && (
        <ul className="flex flex-col gap-1">
          {f.planInfo.map((p) => (
            <li key={p.slug} className="flex items-center gap-2 text-xs">
              {p.exists ? (
                <button type="button" onClick={() => onOpenPlan(p.slug)} className="min-w-0 truncate rounded px-1 text-left text-fg underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40">
                  {p.title ?? p.slug}
                </button>
              ) : (
                <span className="min-w-0 truncate px-1 font-mono text-fg-muted">{p.slug}</span>
              )}
              {!p.exists ? <Badge title="lab/features.md names a plan that is not in lab/qa">missing</Badge> : p.lastRun ? <span className="font-mono text-fg-muted">{lastRunLine(p.lastRun)}</span> : <span className="text-fg-muted">not run</span>}
            </li>
          ))}
        </ul>
      )}
      <footer className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={drafting} onClick={onDraft} title="An agent drafts a QA plan for this feature and links it here">
          <Sparkles /> Draft a plan
        </Button>
        <Button size="xs" variant="ghost" disabled={runnable.length === 0 || batchBusy} onClick={() => onRun(runnable)} title={runnable.length === 0 ? "No plan with steps yet" : "An agent runs this feature's plans in its own browser"}>
          <Play /> Run with agent
        </Button>
      </footer>
    </article>
  );
}
