import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Badge, Spinner, StatusDot } from "@/components/ui/misc";
import { canRollback, deploysOf, formatWhen, isBusy, liveOf, STATUS_DOT, STATUS_WORD, type Deploy, type DeployTarget } from "./logic";

interface Props {
  target: DeployTarget;
  deploys: Deploy[];
  onRun: (targetId: string) => void;
  onRollback: (deployId: string) => void;
}

/** One environment in the pipeline: its live deploy, its last attempt, and the actions on it. */
export function PipelineCard({ target, deploys, onRun, onRollback }: Props) {
  const [showHistory, setShowHistory] = useState(false);
  const mine = deploysOf(deploys, target.id);
  const last = mine[0] ?? null;
  const live = liveOf(mine);
  const busy = isBusy(last);

  const deploy = async () => {
    // Production is the one place a click should ask first.
    if (target.env === "prod" && !(await confirm({ title: "Deploy to prod?", description: `Ships the current workspace to ${target.provider} as prod.`, confirmLabel: "Deploy" }))) return;
    onRun(target.id);
  };
  const rollback = async () => {
    if (!live) return;
    if (!(await confirm({ title: `Roll back ${target.env}?`, description: "The deploy before the live one becomes live again.", confirmLabel: "Roll back", danger: true }))) return;
    onRollback(live.id);
  };

  const facts = [live?.version && `v${live.version}`, live?.git_sha?.slice(0, 7), last && formatWhen(last.started_at)].filter(Boolean);

  return (
    <section aria-label={`${target.env} environment`} className="flex h-full flex-col gap-2 rounded-lg border border-line bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-base font-medium text-fg">{target.env}</span>
        <Badge>{target.provider}</Badge>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {last ? (
          <>
            <StatusDot status={STATUS_DOT[last.status]} />
            <span className={last.status === "failed" ? "text-red" : "text-fg"}>{STATUS_WORD[last.status]}</span>
            {last.kind === "rollback" && <span className="text-fg-muted">(rolled back)</span>}
          </>
        ) : (
          <span className="text-fg-muted">Not deployed yet</span>
        )}
      </div>

      {live?.url ? (
        <a href={live.url} target="_blank" rel="noreferrer" className="truncate font-mono text-sm text-accent hover:underline">
          {live.url}
        </a>
      ) : target.url ? (
        <span className="truncate font-mono text-sm text-fg-muted">{target.url}</span>
      ) : null}

      {facts.length > 0 && <div className="font-mono text-xs text-fg-muted">{facts.join(" · ")}</div>}

      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" variant="outline" disabled={busy} onClick={deploy}>
          {busy && <Spinner />}
          Deploy
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !canRollback(mine)} onClick={rollback}>
          Roll back
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
          History
        </Button>
      </div>

      {showHistory && <DeployHistory deploys={mine} />}
    </section>
  );
}

/** The last few deploys of one environment. Each opens to its log tail, which is redacted on the server. */
export function DeployHistory({ deploys }: { deploys: Deploy[] }) {
  if (!deploys.length) return <p className="border-t border-line pt-2 text-sm text-fg-muted">No deploys yet.</p>;
  return (
    <ul className="flex flex-col gap-1 border-t border-line pt-2">
      {deploys.slice(0, 8).map((d) => (
        <li key={d.id}>
          <details className="rounded-md bg-raised px-2 py-1">
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <StatusDot status={STATUS_DOT[d.status]} />
              <span className="text-fg">{d.kind === "rollback" ? "Rollback" : "Deploy"}</span>
              <span className="text-fg-muted">{STATUS_WORD[d.status]}</span>
              {d.version && <span className="font-mono text-xs text-fg-muted">v{d.version}</span>}
              <span className="ml-auto whitespace-nowrap text-xs text-fg-muted">{formatWhen(d.started_at)}</span>
            </summary>
            {d.url && (
              <a href={d.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-xs text-accent hover:underline">
                {d.url}
              </a>
            )}
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel p-2 font-mono text-xs text-fg-muted">{d.log_tail || "No output."}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
