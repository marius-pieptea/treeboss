/** A new page, or a new decision record. Nothing is written until the button is pressed. */
import { useEffect, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import { slug } from "./logic";

export function NewPageDialog({ open, onOpenChange, docsDir, nextAdr, busy, initialKind = "page", onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; docsDir: string; nextAdr: string; busy?: boolean; initialKind?: "page" | "adr"; onCreate: (a: { path?: string; title: string; kind: "page" | "adr" }) => void }) {
  const [kind, setKind] = useState<"page" | "adr">("page");
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setTitle("");
      setPath("");
      setPathEdited(false);
    }
  }, [open, initialKind]);

  const suggested = slug(title);
  const shownPath = kind === "adr" ? `decisions/${nextAdr}-${suggested || "decision"}.md` : pathEdited ? path : suggested ? `${suggested}.md` : "";
  const ok = title.trim().length > 0 && (kind === "adr" || shownPath.trim().length > 0);
  const submit = () => ok && !busy && onCreate({ title: title.trim(), kind, ...(kind === "page" ? { path: shownPath.trim() } : {}) });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={460}
      title={
        <span className="flex items-center gap-2">
          <FilePlus2 className="size-4 text-accent" /> New {kind === "adr" ? "decision record" : "page"}
        </span>
      }
      description={kind === "adr" ? "A short record of one decision: the context, what was decided, what follows." : "A markdown page in the docs folder. Link it from the index when it is ready."}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" data-new-page-confirm disabled={!ok || busy} onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && submit()}>
        <SegTabs
          value={kind}
          onChange={setKind}
          items={[
            { value: "page", label: "Page" },
            { value: "adr", label: "Decision record" },
          ]}
        />
        <Field label="Title">
          <Input autoFocus data-new-page-title value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "adr" ? "Use SQLite for session state" : "Release process"} />
        </Field>
        <Field label="File" hint={`Inside ${docsDir}/. Folders are created as needed.`}>
          <Input
            data-new-page-path
            value={shownPath}
            disabled={kind === "adr"}
            onChange={(e) => {
              setPath(e.target.value);
              setPathEdited(true);
            }}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
      </div>
    </Dialog>
  );
}
