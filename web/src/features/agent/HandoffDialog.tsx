import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";
import { post, url } from "@/lib/api";
import { qk, useAgents, useEngines, usePairs, useSession } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { EffortSelect, ModelSelect } from "@/components/ui/model-select";
import { Spinner } from "@/components/ui/misc";
import { openSession } from "./agent-commands";

/** One dialog for the whole app, opened from the composer's meter, the session menu or the palette. */
export interface HandoffInit {
  engine?: string;
  model?: string;
  effort?: string;
  pair?: string;
}
const useHandoffStore = create<{ sessionId: string | null; preset: "handoff" | "switch"; init: HandoffInit | null; open: (id: string, preset: "handoff" | "switch", init: HandoffInit | null) => void; close: () => void }>((set) => ({
  sessionId: null,
  preset: "handoff",
  init: null,
  open: (sessionId, preset, init) => set({ sessionId, preset, init }),
  close: () => set({ sessionId: null }),
}));
/** `switch`: the same flow, worded for changing engine, model, effort or pair while keeping the work. `init` preselects them. */
export const openHandoff = (sessionId: string, preset: "handoff" | "switch" = "handoff", init: HandoffInit | null = null) => useHandoffStore.getState().open(sessionId, preset, init);

interface Preview {
  summary: string;
  method: "model" | "transcript";
  note?: string;
}

export function HandoffDialog() {
  const sessionId = useHandoffStore((s) => s.sessionId);
  const close = useHandoffStore((s) => s.close);
  const preset = useHandoffStore((s) => s.preset);
  const init = useHandoffStore((s) => s.init);
  return sessionId ? <Inner key={sessionId} sessionId={sessionId} preset={preset} init={init} onClose={close} /> : null;
}

function Inner({ sessionId, preset, init, onClose }: { sessionId: string; preset: "handoff" | "switch"; init: HandoffInit | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useSession(sessionId);
  const session = detail.data?.session;
  const engines = useEngines();
  const agents = useAgents();
  const pairs = usePairs();

  const [engine, setEngine] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [effort, setEffort] = useState("");
  const [pairId, setPairId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [summary, setSummary] = useState("");
  const [edited, setEdited] = useState(false);
  const [useModel, setUseModel] = useState(true);
  const seeded = useRef(false);

  useEffect(() => {
    if (session && !seeded.current) {
      seeded.current = true;
      setEngine(init?.engine ?? session.engine);
      setModel(init?.model ?? (init?.engine && init.engine !== session.engine ? "" : (session.model ?? "")));
      setAgent(session.agent ?? "");
      setEffort(init?.effort ?? session.effort ?? "");
      setPairId(init?.pair ?? session.pair ?? "");
    }
  }, [session]);

  // The summary: asked of the session by default (it can take a while), or read from the log on request.
  const preview = useQuery({
    queryKey: ["handoff-preview", sessionId, useModel],
    queryFn: () => post<Preview>(url.session(sessionId, "handoff"), { preview: true, model_summary: useModel }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (preview.data && !edited) setSummary(preview.data.summary);
  }, [preview.data, edited]);

  const start = useMutation({
    mutationFn: () =>
      post<{ session: { id: string; title: string } }>(url.session(sessionId, "handoff"), {
        summary,
        engine: engine || undefined,
        model: model || undefined,
        agent: agent || undefined,
        effort: effort || undefined,
        pair: pairId || undefined,
        instructions: instructions.trim() || undefined,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      onClose();
      openSession(r.session.id);
      toast.success("Handed off", { description: r.session.title });
    },
    onError: (e: Error) => toast.error("Could not hand off", { description: e.message }),
  });

  const installed = (engines.data ?? []).filter((e) => e.installed);
  const loading = preview.isFetching && !preview.data;
  const switched = !!session && engine !== session.engine;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={560}
      title={preset === "switch" ? "Continue with another engine" : "Hand off to a fresh session"}
      description={preset === "switch" ? "Engines cannot share a conversation, so the new session starts from this summary on the engine, model and pair you pick. The old one stays as it is." : "The new session starts with an empty context and only this summary. The old one stays as it is."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-handoff-go disabled={loading || !summary.trim() || start.isPending || !engine} onClick={() => start.mutate()}>
            {start.isPending ? <Spinner /> : <ArrowRightLeft />} {preset === "switch" ? "Continue" : "Hand off"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Summary"
          hint={
            loading ? undefined : preview.error ? (
              <span className="text-red">{(preview.error as Error).message}</span>
            ) : preview.data ? (
              <span className="flex items-center gap-1">
                {preview.data.method === "model" ? <Sparkles className="size-3 text-accent" /> : null}
                {edited ? "Edited by you." : preview.data.method === "model" ? "Written by the session itself." : "Built from the session log."} {preview.data.note && !edited ? preview.data.note : ""}
              </span>
            ) : undefined
          }
        >
          {loading ? (
            <div data-handoff-loading className="flex h-[216px] flex-col items-center justify-center gap-2 rounded-md border border-line bg-raised text-[12px] text-fg-muted">
              <Spinner />
              {useModel ? "Asking the session to summarize itself…" : "Reading the session log…"}
              {useModel && (
                <button onClick={() => setUseModel(false)} className="text-[11.5px] text-accent outline-none hover:underline focus-visible:underline">
                  Use the log instead
                </button>
              )}
            </div>
          ) : (
            <Textarea
              data-handoff-summary
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
                setEdited(true);
              }}
              rows={11}
              spellCheck={false}
              className="max-h-[300px] min-h-[216px] font-mono text-[12px] leading-relaxed"
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Engine">
            <Select
              size="sm"
              value={engine}
              onChange={(v) => {
                setEngine(v);
                setModel(v === session?.engine ? (session?.model ?? "") : "");
              }}
              options={installed.map((e) => ({ value: e.id, label: e.label }))}
              aria-label="Engine"
            />
          </Field>
          <Field label="Model">
            <ModelSelect size="sm" engine={engine || session?.engine || "claude"} value={model ?? ""} onChange={setModel} inheritedHint={switched ? undefined : session?.model ?? undefined} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effort">
            <EffortSelect engine={engine || session?.engine || ""} model={model ?? ""} value={effort} onChange={setEffort} size="sm" ariaLabel="Effort" />
          </Field>
          <Field label="Hydra pair" hint="Optional: lead with heads.">
            <Select size="sm" value={pairId} onChange={setPairId} placeholder="No pair" options={[{ value: "", label: "No pair" }, ...(pairs.data ?? []).map((p) => ({ value: p.id, label: p.title }))]} aria-label="Hydra pair" />
          </Field>
        </div>
        <Field label="Agent" hint="Optional: run the new session as a specialized agent.">
          <Select size="sm" value={agent ?? ""} onChange={setAgent} placeholder="None" options={[{ value: "", label: "None" }, ...(agents.data ?? []).map((a) => ({ value: a.name, label: a.title }))]} aria-label="Agent" />
        </Field>
        <Field label="What next" hint="Optional. Without it, the new session starts with the open tasks in the summary.">
          <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Finish the migration, then run the tests" />
        </Field>
      </div>
    </Dialog>
  );
}
