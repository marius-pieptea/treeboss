import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useSpecs } from "@/features/specs/data";
import type { NewPlanInput } from "./api";
import { pathOf, sourceOf, type FromKind } from "./logic";

const KINDS: Array<{ value: FromKind; label: string }> = [
  { value: "page", label: "This page" },
  { value: "spec", label: "A spec" },
  { value: "diff", label: "This branch's changes" },
  { value: "text", label: "A description" },
  { value: "manual", label: "Blank" },
];

export function NewPlanDialog({ root, currentUrl, open, onOpenChange, busy, onSubmit }: { root: string; currentUrl: string | null; open: boolean; onOpenChange: (o: boolean) => void; busy: boolean; onSubmit: (input: NewPlanInput) => void }) {
  const page = currentUrl ? pathOf(currentUrl) : null;
  const specs = useSpecs(root);
  const dirs = specs.data?.features.map((f) => f.dir) ?? [];
  const [title, setTitle] = React.useState("");
  const [kind, setKind] = React.useState<FromKind>("manual");
  const [dir, setDir] = React.useState("");
  const [base, setBase] = React.useState("main");
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    setTitle("");
    setKind(page ? "page" : "manual");
    setDir("");
    setNote("");
  }, [open]);

  const from = sourceOf({ kind, page, dir: dir.trim(), base: base.trim() });
  const ok = title.trim() !== "" && (kind !== "text" || note.trim() !== "") && (kind === "manual" || from !== null);
  const submit = () => ok && onSubmit({ title: title.trim(), ...(from ? { from } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New QA plan"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok || busy} onClick={submit}>
            {kind === "manual" ? "Create" : "Draft plan"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Checkout flow" />
        </Field>
        <Field label="Draft from">
          <Select value={kind} onChange={(v) => setKind(v as FromKind)} options={KINDS.map((k) => ({ value: k.value, label: k.label, disabled: k.value === "page" && !page, hint: k.value === "page" ? (page ?? "no page open") : undefined }))} />
        </Field>
        {kind === "spec" && (
          <Field label="Spec folder">
            {dirs.length > 0 ? <Select value={dir} onChange={setDir} placeholder="Pick a spec" options={dirs.map((d) => ({ value: d, label: <span className="font-mono">{d}</span> }))} /> : <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="specs/001-checkout" className="font-mono" />}
          </Field>
        )}
        {kind === "diff" && (
          <Field label="Compared with" hint="The plan covers what changed since this branch or commit.">
            <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" />
          </Field>
        )}
        {kind !== "manual" && (
          <Field label={kind === "text" ? "Description" : "Note"} hint={kind === "text" ? undefined : "Optional. Anything the agent should focus on."}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "text" ? "What the feature does and who uses it." : undefined} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
