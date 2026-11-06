import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Textarea } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { FOCUSES, type Focus } from "./api";

export function SuggestDialog({ open, onOpenChange, busy, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; busy: boolean; onSubmit: (focus: Focus[], note: string) => void }) {
  const [focus, setFocus] = React.useState<Focus[]>([]);
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setFocus([]);
      setNote("");
    }
  }, [open]);
  const toggle = (f: Focus, on: boolean) => setFocus((cur) => (on ? [...cur, f] : cur.filter((x) => x !== f)));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Suggest missing steps"
      description="The agent reads the plan and proposes steps it lacks. You accept or reject each one."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => onSubmit(focus, note.trim())}>
            Suggest
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">Focus on</legend>
          {FOCUSES.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-[13px] text-fg">
              <Checkbox checked={focus.includes(f.id)} onChange={(on) => toggle(f.id, on)} label={f.label} />
              {f.label}
            </label>
          ))}
        </fieldset>
        <Field label="Note" hint="Optional. Anything the agent should know.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
