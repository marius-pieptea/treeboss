import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import type { Severity } from "./data";

export interface ProjectItemDraft {
  text: string;
  category: string;
  severity: Severity;
  kind: "agent" | "manual";
  hint: string;
}

/** An item this project adds to one of its checklists: a question an agent judges, or one a person decides. Kept in the project's file. */
export function ProjectItemForm({ pending, onSubmit, onCancel }: { pending: boolean; onSubmit: (item: ProjectItemDraft) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ProjectItemDraft>({ text: "", category: "Project", severity: "recommended", kind: "agent", hint: "" });
  const set = (patch: Partial<ProjectItemDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const ready = !!draft.text.trim() && !!draft.category.trim() && !!draft.hint.trim();

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3"
      aria-label="Add item to this project"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) onSubmit({ ...draft, text: draft.text.trim(), category: draft.category.trim(), hint: draft.hint.trim() });
      }}
    >
      <p className="text-xs text-fg-muted">An item for this project only: it is kept in this project's checklist file, not in the catalog. Use Manage checklists to add one to every project.</p>
      <Field label="Item">
        <Input value={draft.text} onChange={(e) => set({ text: e.target.value })} maxLength={200} autoFocus placeholder="What must be true for this project" aria-label="Item text" />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Category">
          <Input value={draft.category} onChange={(e) => set({ category: e.target.value })} maxLength={40} aria-label="Item category" />
        </Field>
        <Field label="Kind">
          <Select
            value={draft.kind}
            onChange={(v) => set({ kind: v as "agent" | "manual" })}
            options={[
              { value: "agent", label: "Agent judges" },
              { value: "manual", label: "A person decides" },
            ]}
            aria-label="Item kind"
          />
        </Field>
        <Field label="Severity">
          <Select
            value={draft.severity}
            onChange={(v) => set({ severity: v as Severity })}
            options={[
              { value: "required", label: "Required" },
              { value: "recommended", label: "Recommended" },
            ]}
            aria-label="Item severity"
          />
        </Field>
      </div>
      <Field label="Hint" hint="What to do when it does not pass. An agent reads it first.">
        <Textarea value={draft.hint} onChange={(e) => set({ hint: e.target.value })} maxLength={500} className="h-14 text-xs" aria-label="Item hint" />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!ready || pending}>
          Add item
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
