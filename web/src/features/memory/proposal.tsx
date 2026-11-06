import { useState } from "react";
import { toast } from "sonner";
import { Brain } from "lucide-react";
import { qk } from "@/lib/queries";
import { post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { memKey, suggestRule } from "./data";
import type { QueryClient } from "@tanstack/react-query";

function Card({ id, root, initial, qc }: { id: string | number; root: string; initial: string; qc: QueryClient }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await post(`/api/memory/${root}/rules`, { text });
      void qc.invalidateQueries({ queryKey: memKey(root) });
      void qc.invalidateQueries({ queryKey: qk.fsAll(root) });
      toast.dismiss(id);
      toast.success("Saved to project memory");
    } catch (e) {
      setBusy(false);
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-line-strong bg-overlay p-3 shadow-pop">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
        <Brain className="size-3.5 text-accent" /> Save as a project rule?
      </div>
      <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} aria-label="Rule" className="text-[12.5px]" />
      <div className="text-[11px] text-fg-faint">Every engine reads it from AGENTS.md. Edit the wording first if you like.</div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => toast.dismiss(id)}>
          Dismiss
        </Button>
        <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void save()}>
          Save rule
        </Button>
      </div>
    </div>
  );
}

/** After a message is sent: if it reads like a standing convention, offer to save it (accept, edit in place, or dismiss). */
export async function proposeMemory(root: string, message: string, qc: QueryClient): Promise<void> {
  const text = await suggestRule(root, message);
  if (!text) return;
  toast.custom((id) => <Card id={id} root={root} initial={text} qc={qc} />, { duration: 20000 });
}
