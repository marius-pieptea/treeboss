import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Empty, SegTabs, Skeleton, Spinner } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { useSignalActions, useSignals, type Signal, type SignalFilter, type SignalSource, type SignalStatus, type TriageAction } from "./data";

const SOURCES: Array<{ value: SignalFilter["source"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "sentry", label: "Errors" },
  { value: "feedback", label: "Feedback" },
  { value: "posthog", label: "Metrics" },
  { value: "manual", label: "Notes" },
];
const STATUSES: Array<{ value: SignalFilter["status"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "linked", label: "Linked" },
  { value: "triaged", label: "Working" },
  { value: "ignored", label: "Ignored" },
];

const SEVERITY_TONE = { critical: "red", high: "amber", medium: "neutral", low: "neutral" } as const;
const STATUS_TONE: Record<SignalStatus, "neutral" | "green" | "violet"> = { new: "neutral", linked: "green", triaged: "violet", ignored: "neutral" };
const SOURCE_LABEL: Record<SignalSource, string> = { sentry: "Sentry", posthog: "PostHog", feedback: "Feedback", manual: "Note" };

const ACTIONS: Array<{ action: TriageAction; label: string }> = [
  { action: "to_finding", label: "Finding" },
  { action: "to_roadmap", label: "Roadmap" },
  { action: "to_session", label: "Fix" },
  { action: "ignore", label: "Ignore" },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The numbers PostHog reported, one tile each. The value is the latest sync's. */
function MetricTiles({ metrics }: { metrics: Signal[] }) {
  if (!metrics.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {metrics.map((m) => (
        <div key={m.id} className="rounded-lg border border-line bg-panel p-3">
          <div className="truncate text-[11px] text-fg-muted" title={m.title}>
            {m.title}
          </div>
          <div className="mt-1 font-mono text-[18px] font-semibold text-fg">{Number(m.meta.value ?? 0).toLocaleString()}</div>
          <div className="mt-1 text-[11px] text-fg-faint">updated {when(String(m.meta.updatedAt ?? m.lastSeen))}</div>
        </div>
      ))}
    </div>
  );
}

function SignalRow({ s, busy, onTriage }: { s: Signal; busy: boolean; onTriage: (action: TriageAction) => void }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SEVERITY_TONE[s.severity]}>{s.severity}</Badge>
          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
          <span className="font-mono text-[11px] text-fg-muted">{SOURCE_LABEL[s.source]}</span>
          <span className="font-mono text-[11px] text-fg-muted">{s.count}×</span>
          <span className="font-mono text-[11px] text-fg-faint">{when(s.lastSeen)}</span>
        </div>
        <div className="mt-1 truncate text-[13px] font-medium text-fg" title={s.title}>
          {s.title}
        </div>
        {s.body && <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] text-fg-muted">{s.body}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] text-fg-faint">
          <span>{s.id}</span>
          {s.linkedRef && <span className="text-fg-muted">→ {s.linkedRef}</span>}
          {s.url && (
            <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline">
              open <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
      {s.status === "new" && (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {ACTIONS.map((a) => (
            <Button key={a.action} size="xs" variant={a.action === "ignore" ? "ghost" : "subtle"} disabled={busy} onClick={() => onTriage(a.action)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

export function SignalsInbox() {
  const { root } = useWorkspace();
  const [filter, setFilter] = useState<SignalFilter>({ source: "all", status: "new" });
  const list = useSignals(root, filter);
  const { sync, triage } = useSignalActions(root);
  const busy = triage.isPending;

  const data = list.data;
  const none = data && !data.sources.sentry && !data.sources.posthog;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold text-fg">Signals</h2>
        <span className="text-[11px] text-fg-muted">What users and production report back</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Spinner /> : <RefreshCw />}
            Sync
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SegTabs value={filter.source} onChange={(v) => setFilter((f) => ({ ...f, source: v }))} items={SOURCES} />
        <SegTabs value={filter.status} onChange={(v) => setFilter((f) => ({ ...f, status: v }))} items={STATUSES} />
      </div>

      {none && <div className="rounded-lg border border-line bg-raised p-3 text-[11px] text-fg-muted">Sentry and PostHog are not set up for this project yet. Add their keys to the project's secrets, then sync.</div>}

      {list.isError && <div className="text-[11px] text-red">{(list.error as Error).message}</div>}

      {data && <MetricTiles metrics={data.metrics} />}

      {list.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : data && data.signals.length ? (
        <ul className="flex flex-col gap-2">
          {data.signals.map((s) => (
            <SignalRow key={s.id} s={s} busy={busy} onTriage={(action) => triage.mutate({ id: s.id, action })} />
          ))}
        </ul>
      ) : (
        <Empty title="No signals here" hint="Sync to pull errors and metrics, or add the feedback widget to your site (trb signals widget)." />
      )}
    </div>
  );
}

export default SignalsInbox;
