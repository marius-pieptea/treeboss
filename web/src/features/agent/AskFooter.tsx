/** Under an ask answer: what the question cost, and (on the newest one) two ways to take it further. */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, FilePlus2 } from "lucide-react";
import { toast } from "sonner";
import { post, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { TurnRow } from "@/lib/types";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { fetchAskDoc, saveAskDoc } from "./ask-data";
import { PLAN_FROM_ANSWER, costLine } from "./ask-logic";

export function AskFooter({ sessionId, turn, followUps }: { sessionId: string; turn: TurnRow; followUps: boolean }) {
  const qc = useQueryClient();
  const [docOpen, setDocOpen] = useState(false);
  const cost = costLine(turn);
  const toPlan = useMutation({
    // One call: the daemon flips the session to plan mode, then sends the message.
    mutationFn: () => post(url.session(sessionId, "send"), { message: PLAN_FROM_ANSWER, mode: "plan" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    },
    onError: (e: Error) => toast.error("Could not start the plan", { description: e.message }),
  });
  if (!cost && !followUps) return null;
  return (
    <div data-ask-footer className="mt-1.5 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-faint">
      {cost && (
        <span data-ask-cost className="font-mono" title="What this question cost">
          {cost}
        </span>
      )}
      {followUps && (
        <span className="flex items-center gap-1">
          <Button size="xs" variant="ghost" data-ask-plan disabled={toPlan.isPending} onClick={() => toPlan.mutate()} title="Switch to plan mode and turn this answer into a plan">
            <ClipboardList /> Turn into a plan
          </Button>
          <Button size="xs" variant="ghost" data-ask-doc onClick={() => setDocOpen(true)} title="Save the question and answer as a docs page">
            <FilePlus2 /> Save as doc
          </Button>
        </span>
      )}
      {docOpen && <SaveDocDialog sessionId={sessionId} turnId={turn.id} onClose={() => setDocOpen(false)} />}
    </div>
  );
}

/** "Save as doc": shows where the page would go (editable) and which files it covers; writes only on Save. */
function SaveDocDialog({ sessionId, turnId, onClose }: { sessionId: string; turnId: string; onClose: () => void }) {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ["ask", "doc", sessionId, turnId], queryFn: () => fetchAskDoc(sessionId, turnId), staleTime: 0 });
  const [path, setPath] = useState<string | null>(null);
  const shown = path ?? preview.data?.path ?? "";
  const save = useMutation({
    mutationFn: () => saveAskDoc(sessionId, { turn: turnId, path: shown }),
    onSuccess: (page) => {
      void qc.invalidateQueries({ queryKey: ["docs"] });
      onClose();
      toast.success(`Saved ${page.path}`, { action: { label: "Open", onClick: () => openTab({ kind: "doc", root, path: page.path, title: page.path.replace(/^.*\//, "") }) } });
    },
    onError: (e: Error) => toast.error("Could not save the page", { description: e.message }),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save as doc"
      description="The question and this answer become a docs page, tracked for freshness against the files it cites."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-ask-doc-save disabled={!shown.trim() || save.isPending || !preview.data} onClick={() => save.mutate()}>
            Save page
          </Button>
        </>
      }
    >
      <div className="space-y-2.5 px-4 pb-3 pt-1 text-[12px]">
        {preview.isError ? (
          <p className="text-red">{(preview.error as Error).message}</p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-fg-muted">Path</span>
              <input data-ask-doc-path value={shown} onChange={(e) => setPath(e.target.value)} spellCheck={false} className="h-8 w-full rounded-md border border-line bg-bg px-2 font-mono text-[12px] outline-none focus:border-accent/60" />
            </label>
            <div>
              <span className="mb-1 block text-fg-muted">Covers</span>
              {preview.data?.covers.length ? (
                <div className="flex flex-wrap gap-1">
                  {preview.data.covers.map((c) => (
                    <span key={c} className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px]">
                      {c}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-fg-faint">{preview.isPending ? "Reading the answer…" : "The answer cites no files, so the page is not tied to any."}</span>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
