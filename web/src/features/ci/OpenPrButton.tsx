import { GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { useOpenSessionPr } from "./data";

/**
 * Pushes a session's branch and opens its PR, then opens the PR in a new tab. A session that already has an open
 * PR gets that one back instead of a second.
 */
export function OpenPrButton({ sessionId, className }: { sessionId: string; className?: string }) {
  const open = useOpenSessionPr();

  const run = async () => {
    try {
      const r = await open.mutateAsync({ sessionId });
      window.open(r.pr.url, "_blank", "noopener,noreferrer");
    } catch {
      /* the mutation already said why */
    }
  };

  return (
    <Button size="sm" variant="outline" className={className} disabled={open.isPending} onClick={() => void run()} data-open-pr>
      {open.isPending ? <Spinner /> : <GitPullRequest />} Open PR
    </Button>
  );
}
