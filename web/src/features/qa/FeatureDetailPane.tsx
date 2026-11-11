import { useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useFeatureDetail, useRun } from "./api";
import type { BoardFeature, Run } from "./api";
import { BugCard } from "./BugCard";
import type { RowAction } from "./FeatureRow";
import { countsLine, isOpenBug, outcomeText, planCell, since, stepCell, testCell } from "./logic";
import { CellView, LABEL } from "./Status";

/** One feature: what it covers, its plan, its test runs and its bugs, with the buttons that run each stage for it alone. */
export function FeatureDetailPane({
  root,
  feature,
  busy,
  pending,
  focusBug,
  onClose,
  onAction,
  onFix,
  onStatus,
}: {
  root: string;
  feature: BoardFeature;
  busy: boolean;
  pending: boolean;
  focusBug: string | null;
  onClose: () => void;
  onAction: (a: RowAction) => void;
  onFix: (bugId: string) => void;
  onStatus: (id: string, status: "new" | "dismissed" | "shipped") => void;
}) {
  const detail = useFeatureDetail(root, feature.id);
  const f = detail.data?.feature ?? feature;
  const [runId, setRunId] = useState<string | null>(null);
  const last = detail.data?.lastRun ?? null;
  const other = useRun(root, runId && runId !== last?.id ? runId : null);
  const shown: Run | null = runId && runId !== last?.id ? (other.data?.run ?? null) : last;
  const openTab = useUi((s) => s.openTab);
  const openBugs = f.bugs.filter(isOpenBug).length;
  const plan = detail.data?.plan ?? null;
  const why = busy ? "A pipeline is running" : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col" data-feature-pane={f.id}>
      <header className="flex flex-col gap-1 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate font-semibold">{f.title}</h2>
          <IconButton label="Close" size="icon-sm" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 font-mono text-label text-fg-muted">
          <span>{f.id}</span>
          {f.where.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <Button size="xs" variant="subtle" disabled={busy} title={why} onClick={() => onAction("plan")}>
            {f.plan.kind === "ready" ? "Plan again" : "Plan"}
          </Button>
          <Button size="xs" variant="subtle" disabled={busy || f.plan.kind !== "ready"} title={why ?? (f.plan.kind !== "ready" ? "Plan it first" : undefined)} onClick={() => onAction("test")}>
            Test
          </Button>
          <Button size="xs" variant="subtle" disabled={busy || openBugs === 0} title={why ?? (openBugs === 0 ? "No open bugs" : undefined)} onClick={() => onAction("fix")}>
            Fix {openBugs > 0 && <span className="font-mono">{openBugs}</span>}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {f.summary && <p className="text-xs leading-relaxed text-fg-muted">{f.summary}</p>}
        {detail.isPending && <Spinner className="self-center" />}
        {detail.isError && <p className="text-xs text-red">{detail.error instanceof Error ? detail.error.message : "Could not load this feature."}</p>}

        <section className="flex flex-col gap-1" aria-label="Plan">
          <div className="flex items-center gap-2">
            <h3 className={LABEL}>Plan</h3>
            <CellView cell={planCell(f)} />
          </div>
          {plan?.problem && <p className="text-xs text-red">{plan.problem}</p>}
          {plan && plan.steps.length > 0 && (
            <ol className="flex flex-col">
              {plan.steps.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2 py-1 text-xs">
                  <span className="w-5 shrink-0 text-right font-mono text-label text-fg-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-fg">{s.action}</span>
                    <span className="block text-fg-muted">{s.expected}</span>
                    {s.path && (
                      <button type="button" className="font-mono text-label text-fg-muted outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60" onClick={() => openTab({ kind: "browser", url: s.path!, title: s.path! })} title="Open the path in the preview browser">
                        {s.path}
                      </button>
                    )}
                  </span>
                  <CellView cell={stepCell(s.last)} className="shrink-0" />
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="flex flex-col gap-1" aria-label="Test runs">
          <div className="flex items-center gap-2">
            <h3 className={LABEL}>Test</h3>
            <CellView cell={testCell(f)} />
          </div>
          {(detail.data?.runs ?? []).length > 0 && (
            <ul className="flex flex-col">
              {detail.data!.runs.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setRunId(r.id)} className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent/60", (runId ?? last?.id) === r.id && "bg-accent-soft")}>
                    <span className="font-mono text-label text-fg-muted">{since(r.startedAt, Date.now())}</span>
                    <span className="font-mono text-label text-fg">{countsLine(r.counts)}</span>
                    {!r.finished && <span className="text-fg-muted">unfinished</span>}
                    <span className="flex-1" />
                    {r.sessionId && (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label="Open the testing session"
                        className="flex items-center gap-1 text-fg-muted hover:text-fg"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSession(r.sessionId!);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            openSession(r.sessionId!);
                          }
                        }}
                      >
                        <ArrowUpRight className="size-3" />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {shown && (
            <ol className="flex flex-col border-t border-line pt-1">
              {shown.steps.map((s, i) => (
                <li key={s.id} className="flex items-start gap-2 py-1 text-xs">
                  <span className="w-5 shrink-0 text-right font-mono text-label text-fg-muted">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-fg">{s.action}</span>
                    {outcomeText(s.outcome) && <span className="block text-fg-muted">{outcomeText(s.outcome)}</span>}
                  </span>
                  <CellView cell={stepCell(s.outcome.state)} className="shrink-0" />
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Bugs">
          <div className="flex items-center gap-2">
            <h3 className={LABEL}>Bugs</h3>
            <span className="font-mono text-label text-fg-muted">{f.bugs.length}</span>
          </div>
          {f.bugs.length === 0 && <p className="text-xs text-fg-muted">No bugs under this feature.</p>}
          {f.bugs.map((b) => (
            <BugCard key={b.id} root={root} bug={b} busy={busy} pending={pending} focused={b.id === focusBug} onFix={onFix} onStatus={onStatus} />
          ))}
        </section>
      </div>
    </div>
  );
}
