import { confirm } from "@/components/ui/dialogs";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { openChecklists } from "@/features/lab/open";
import type { LaunchBlocker } from "./logic";

export interface Refusal {
  targetId: string;
  blockers: LaunchBlocker[];
}

const BLOCKER_WORD: Record<LaunchBlocker["status"], string> = { pass: "passing", fail: "failing", unknown: "not checked yet" };

interface Props {
  refusal: Refusal | null;
  onClose: () => void;
  onDeployAnyway: (targetId: string) => void;
}

/** A prod deploy the launch checklists refused: the required items still open, and the two ways on from here. */
export function LaunchBlockedDialog({ refusal, onClose, onDeployAnyway }: Props) {
  const count = refusal?.blockers.length ?? 0;
  const plural = count === 1 ? "" : "s";

  const deployAnyway = async () => {
    if (!refusal) return;
    const ok = await confirm({
      title: "Deploy to prod anyway?",
      description: `${count} required launch check${plural} not passing. The deploy goes ahead without ${count === 1 ? "it" : "them"}.`,
      confirmLabel: "Deploy anyway",
      danger: true,
    });
    if (ok) onDeployAnyway(refusal.targetId);
  };

  const showChecklists = () => {
    onClose();
    openChecklists();
  };

  return (
    <Dialog
      open={!!refusal}
      onOpenChange={(o) => !o && onClose()}
      width={480}
      title="Prod deploy blocked"
      description={`${count} required launch check${plural} not passing.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" onClick={showChecklists}>
            Open checklists
          </Button>
          <Button variant="danger" onClick={deployAnyway}>
            Deploy anyway
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1.5" aria-label="Blocking launch checks">
        {refusal?.blockers.map((b, i) => (
          <li key={`${b.checklistTitle}-${i}`} className="flex items-start justify-between gap-3 rounded-md border border-line px-2.5 py-1.5">
            <span className="min-w-0 text-sm text-fg">{b.text}</span>
            <span className="shrink-0 text-xs text-fg-muted">
              {b.checklistTitle} · {BLOCKER_WORD[b.status]}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
