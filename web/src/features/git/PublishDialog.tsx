import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import { get, url } from "@/lib/api";
import { gitActions, useBusy } from "./actions";

/** Create a GitHub repository from this folder: name, private or public, then `gh repo create --push`. */
export function PublishDialog({ root, defaultName, open, onOpenChange }: { root: string; defaultName: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const busy = useBusy((s) => !!s.busy.publish);
  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const gh = useQuery({ queryKey: ["git", root, "gh"], queryFn: () => get<{ installed: boolean; user: string | null }>(url.git(root, "gh")), enabled: open, staleTime: 0 });
  const ready = !!gh.data?.user;
  const valid = /^(?:[A-Za-z0-9-]+\/)?[A-Za-z0-9._-]{1,100}$/.test(name.trim());

  const submit = async () => {
    if (!ready || !valid || busy) return;
    if (await gitActions(root).publish({ name: name.trim(), visibility, description: description.trim() || undefined })) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Publish to GitHub"
      description={gh.data?.user ? `Creates a new repository on the account ${gh.data.user}, adds it as origin and pushes.` : "Creates a new repository, adds it as origin and pushes."}
      footer={
        <>
          <Button variant="ghost" size="md" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={submit} disabled={!ready || !valid || busy}>
            {busy ? <Loader2 className="animate-spin-fast" /> : null} Create {visibility} repository
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {gh.isLoading ? (
          <div className="text-xs text-fg-muted">Checking the GitHub CLI…</div>
        ) : !gh.data?.installed ? (
          <div className="text-xs text-fg-muted">
            The GitHub CLI was not found. Install it from <span className="font-mono">cli.github.com</span>, then run <span className="font-mono">gh auth login</span>.
          </div>
        ) : !gh.data.user ? (
          <div className="text-xs text-fg-muted">
            The GitHub CLI is not signed in. Run <span className="font-mono">gh auth login</span> in a terminal, then reopen this.
          </div>
        ) : null}
        <Field label="Repository name">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} className="font-mono" autoFocus />
        </Field>
        <Field label="Visibility" hint={visibility === "private" ? "Only you and people you invite can see it." : "Anyone on the internet can see it."}>
          <SegTabs
            value={visibility}
            onChange={setVisibility}
            items={[
              { value: "private", label: "Private" },
              { value: "public", label: "Public" },
            ]}
          />
        </Field>
        <Field label="Description (optional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
