import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { Field, Input } from "@/components/ui/form";
import { ErrorNote } from "./shared";
import { api } from "./data";

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validateSkillName(n: string): string | null {
  if (!n) return "A name is required.";
  if (!SKILL_NAME.test(n)) return 'Use lowercase letters, digits, ".", "_" or "-" (start with a letter or digit).';
  return null;
}

/** Adding from a folder and importing a directory live in skills-import.tsx (they share a progress view). Shared shell: a dialog with one async action, an error line, and a primary button. */
function ActionDialog({ open, title, description, confirmLabel, busyLabel, disabled, onClose, run, children }: { open: boolean; title: string; description: string; confirmLabel: string; busyLabel: string; disabled?: boolean; onClose: () => void; run: () => Promise<void>; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={go} disabled={busy || disabled}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void go();
        }}
      >
        {children}
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Dialog>
  );
}

export function NewSkillDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);
  const err = name ? validateSkillName(name) : null;
  return (
    <ActionDialog open={open} title="New skill" description="Creates a SKILL.md with a header you can fill in. Skills are loaded by the agent when their description matches the work." confirmLabel="Create" busyLabel="Creating…" disabled={!name || !!err} onClose={onClose} run={async () => (await api.skills.create(name, description), onDone(name))}>
      <Field label="Name" hint={err ?? "Lowercase, e.g. deploy-checklist"}>
        <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus spellCheck={false} className="font-mono" placeholder="deploy-checklist" aria-invalid={!!err} />
      </Field>
      <Field label="When should it be used?">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when preparing a production release" />
      </Field>
    </ActionDialog>
  );
}
