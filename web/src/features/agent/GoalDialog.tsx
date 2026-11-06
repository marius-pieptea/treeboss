/** Set a goal: what done looks like, an optional command that proves it, and how long the agent may keep going. */
import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { type GoalDraft, draftProblems, emptyDraft } from "./goal-logic";

export function GoalDialog({ open, onOpenChange, initial, busy, confirmLabel = "Start", onSave, onRemove }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: GoalDraft | null; busy?: boolean; confirmLabel?: string; onSave: (d: GoalDraft) => void; onRemove?: () => void }) {
  const [draft, setDraft] = useState<GoalDraft>(initial ?? emptyDraft());
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(initial ?? emptyDraft());
      setTouched(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = draftProblems(draft);
  const invalid = Object.keys(problems).length > 0;
  const submit = () => {
    setTouched(true);
    if (!invalid) onSave(draft);
  };
  const num = (v: string, fallback: number) => (v === "" ? NaN : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={520}
      title={
        <span className="flex items-center gap-2">
          <Target className="size-4 text-accent" /> Set a goal
        </span>
      }
      description="The agent keeps working turn after turn until the goal is met or the budget runs out. You can stop it any time."
      footer={
        <>
          {onRemove && (
            <Button variant="dangerGhost" className="mr-auto" onClick={onRemove}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (touched && invalid)} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}>
        <Field label="Goal" hint={touched && problems.text ? <span className="text-red">{problems.text}</span> : "What done looks like, in a sentence or a short list."}>
          <Textarea autoFocus data-goal-text value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="All tests in src/auth pass and the login page shows the new error states" rows={3} />
        </Field>
        <Field label="Check command (optional)" hint="Runs in the project after every turn. Exit 0 means done. Without one, the agent says when it is done.">
          <Input data-goal-check value={draft.check} onChange={(e) => setDraft({ ...draft, check: e.target.value })} placeholder="bun test" className="font-mono" spellCheck={false} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max turns" hint={touched && problems.maxTurns ? <span className="text-red">{problems.maxTurns}</span> : undefined}>
            <Input type="number" min={1} max={100} value={Number.isNaN(draft.maxTurns) ? "" : draft.maxTurns} onChange={(e) => setDraft({ ...draft, maxTurns: num(e.target.value, draft.maxTurns) })} />
          </Field>
          <Field label="Max minutes" hint={touched && problems.maxMinutes ? <span className="text-red">{problems.maxMinutes}</span> : undefined}>
            <Input type="number" min={1} max={720} value={Number.isNaN(draft.maxMinutes) ? "" : draft.maxMinutes} onChange={(e) => setDraft({ ...draft, maxMinutes: num(e.target.value, draft.maxMinutes) })} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
