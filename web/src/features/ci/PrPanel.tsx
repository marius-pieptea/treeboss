import { GitMerge, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Badge, Spinner } from "@/components/ui/misc";
import { canMerge, CHECKS_LABEL, CHECKS_TONE, type ChecksState } from "./logic";
import { type PrItem, useMergePr, usePrs } from "./data";

/** The open pull requests of a workspace, with their checks and a merge button. */
export function PrPanel({ workspaceId }: { workspaceId: string }) {
  const prs = usePrs(workspaceId);
  const merge = useMergePr(workspaceId);

  const mergeOne = async (pr: PrItem) => {
    const ok = await confirm({ title: `Merge #${pr.number}?`, description: `${pr.title} will be squash-merged into ${pr.base}.`, confirmLabel: "Merge" });
    if (!ok) return;
    merge.mutate({ n: pr.number });
  };

  if (prs.isLoading) {
    return (
      <div className="flex items-center gap-2 text-fg-muted">
        <Spinner /> Loading pull requests
      </div>
    );
  }
  if (prs.error) return <p className="text-red">{prs.error.message}</p>;
  if (!prs.data?.length) return <p className="text-fg-muted">No open pull requests in this workspace.</p>;

  return (
    <ul data-pr-panel className="flex flex-col divide-y divide-line rounded-lg border border-line bg-panel">
      {prs.data.map((pr) => (
        <li key={pr.number} className="flex items-center gap-3 px-3 py-2">
          <GitPullRequest className="size-4 shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="block truncate text-base text-fg hover:underline">
              <span className="font-mono text-fg-muted">#{pr.number}</span> {pr.title}
            </a>
            <div className="truncate font-mono text-[11px] text-fg-faint">
              {pr.head} → {pr.base}
              {pr.draft ? " · draft" : ""}
            </div>
          </div>
          {pr.checksState ? (
            <Badge tone={CHECKS_TONE[pr.checksState as ChecksState]} title={CHECKS_LABEL[pr.checksState as ChecksState]}>
              {CHECKS_LABEL[pr.checksState as ChecksState]}
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={merge.isPending || !canMerge(pr.checksState)}
            title={canMerge(pr.checksState) ? `Merge #${pr.number}` : "Fix the failing checks before merging"}
            onClick={() => void mergeOne(pr)}
          >
            {merge.isPending && merge.variables?.n === pr.number ? <Spinner /> : <GitMerge />} Merge
          </Button>
        </li>
      ))}
    </ul>
  );
}
