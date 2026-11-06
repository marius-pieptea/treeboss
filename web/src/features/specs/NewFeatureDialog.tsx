import { useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { previewSlug } from "./logic";

/** Name a feature: this allocates specs/NNN-name/ with a spec.md skeleton, and nothing else. */
export function NewFeatureDialog({ open, onOpenChange, busy, nextNumber, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; busy?: boolean; nextNumber: string; onCreate: (name: string, description: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);
  const slug = previewSlug(name);
  const submit = () => slug && !busy && onCreate(name.trim(), description.trim());
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={480}
      title={
        <span className="flex items-center gap-2">
          <FolderPlus className="size-4 text-accent" /> New feature
        </span>
      }
      description="Creates a folder under specs/ with a spec.md to fill in. Nothing is built yet."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" data-new-feature-confirm disabled={!slug || busy} onClick={submit}>
            Create feature
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}>
        <Field label="Name" hint={slug ? <span className="font-mono">specs/{nextNumber}-{slug}/</span> : "A few words: what the feature is."}>
          <Input autoFocus data-new-feature-name value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && submit()} placeholder="Add CSV export to the orders page" />
        </Field>
        <Field label="What should it do? (optional)" hint="In the requester's words. The Specify step turns it into a real spec.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Export the visible rows as CSV, keep the current filters, do not change the JSON API." />
        </Field>
      </div>
    </Dialog>
  );
}
