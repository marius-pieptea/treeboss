import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, Skeleton } from "@/components/ui/misc";
import { PipelineCard } from "./PipelineCard";
import { LaunchBlockedDialog, type Refusal } from "./LaunchBlockedDialog";
import { useDeployActions, useDeployView } from "./data";
import { launchBlockersOf, orderTargets } from "./logic";
import { openFactory } from "@/features/factory/open";

/**
 * The environment pipeline: dev, staging and prod as cards, each with its last deploy. `root` is a workspace
 * or session id. Deploys are background jobs, so the view polls while one is running.
 */
export function DeployView({ root }: { root: string }) {
  const q = useDeployView(root);
  const { run, rollback } = useDeployActions(root);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  // A prod deploy the launch checklists refuse opens the blockers dialog instead of a toast.
  const launch = (targetId: string, force = false) =>
    run.mutate({ targetId, force }, { onError: (e) => {
      const blockers = launchBlockersOf(e);
      if (blockers) setRefusal({ targetId, blockers });
    } });

  if (q.isLoading) return <Skeleton className="m-4 h-40" />;
  if (q.isError) return <p className="p-4 text-sm text-red">{q.error instanceof Error ? q.error.message : "The deploys did not load."}</p>;

  const targets = orderTargets(q.data?.targets ?? []);
  const deploys = q.data?.deploys ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg font-semibold text-fg">Deploy</h2>
          <p className="text-sm text-fg-muted">Each environment, its live deploy, and the last attempt.</p>
        </div>
        <Button variant="outline" onClick={() => openFactory("releases")}>
          Release…
        </Button>
      </header>

      {targets.length === 0 ? (
        <Empty title="No environments yet" hint={<span className="font-mono">trb deploy targets add dev &lt;provider&gt;</span>} />
      ) : (
        <ol className="flex flex-col gap-2 md:flex-row md:items-stretch">
          {targets.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && <ChevronRight aria-hidden className="mx-auto my-auto size-4 shrink-0 rotate-90 text-fg-faint md:rotate-0" />}
              <li className="min-w-0 flex-1">
                <PipelineCard target={t} deploys={deploys} onRun={(id) => launch(id)} onRollback={(id) => rollback.mutate(id)} />
              </li>
            </Fragment>
          ))}
        </ol>
      )}

      <LaunchBlockedDialog
        refusal={refusal}
        onClose={() => setRefusal(null)}
        onDeployAnyway={(id) => {
          setRefusal(null);
          launch(id, true);
        }}
      />
    </div>
  );
}
