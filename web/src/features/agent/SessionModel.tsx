/**
 * "Run with" for a session that already exists: a Harness tab (model and effort on the same engine) and a Hydra tab
 * (attach a pair, or detach it). The two are exclusive: while a pair is attached its lead decides the model, and the
 * Harness tab says so instead of offering a picker that would disagree.
 *
 * The chip is a plain, explained button while a turn runs, for a closed session, or when the engine cannot take a model.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronDown, Lock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { put, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { qk, usePairs } from "@/lib/queries";
import type { Pair, SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EffortSlider, ModelPicker } from "@/components/ui/model-select";
import { Popover } from "@/components/ui/overlay";
import { modelChipState, modelChipTitle, needsConfirm, uncachedNote, compactTokens } from "./model-switch-logic";
import { PairList, RunTabs, type RunTab } from "./RunWith";
import { openHandoff } from "./HandoffDialog";

interface Props {
  session: SessionView;
  chipClass: string;
  chipInner: ReactNode;
  chipLabel: string;
  /** The session's pair, when it has one. */
  pair: Pair | null;
}

const leadModel = (p: Pair): string => (p.lead_model && p.lead_model !== "default" ? p.lead_model : "");

export function SessionModelChip({ session, chipClass, chipInner, chipLabel, pair }: Props) {
  const qc = useQueryClient();
  const state = modelChipState(session);
  const pending = !!session.model_pending;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<RunTab>(pair ? "hydra" : "harness");
  const [confirm, setConfirm] = useState<string | null>(null);
  // The picker calls onDone right after onChange: when the choice needs a confirmation the popover has to stay.
  const hold = useRef(false);
  const pairs = usePairs();
  const canOpen = state.kind === "switchable" || state.kind === "pair";

  useEffect(() => bus.on("model-switch", () => (canOpen ? setOpen(true) : toast.info(modelChipTitle(state, pending)))));
  useEffect(() => {
    if (open) setTab(pair ? "hydra" : "harness");
    else setConfirm(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.session(session.id) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const apply = useMutation({
    mutationFn: (body: { model?: string; effort?: string }) => put<{ warning: string | null; to: string | null }>(url.session(session.id, "model"), body),
    onSuccess: (r, body) => {
      refresh();
      if (r.warning) toast.warning(r.warning);
      if (body.model !== undefined) {
        setOpen(false);
        toast.success(`Model: ${r.to ?? "default"}`, { description: "Applies to the next turn." });
      }
    },
    onError: (e: Error) => toast.error("Could not change the model", { description: e.message }),
  });
  const setPair = useMutation({
    mutationFn: (id: string) => put<{ session: SessionView }>(url.session(session.id, "pair"), { pair: id || null, adopt: true }),
    onSuccess: (_r, id) => {
      refresh();
      setOpen(false);
      toast.success(id ? "Hydra pair attached" : "Hydra pair detached", { description: id ? "The lead follows the pair's model from the next turn; heads and rules apply too." : "The lead keeps its current model. Heads already open keep running." });
    },
    onError: (e: Error) => toast.error("Could not change the pair", { description: e.message }),
  });

  const dot = pending ? <span data-model-pending title="Applies to the next turn" className="ml-0.5 size-1.5 shrink-0 rounded-full bg-accent" /> : null;
  const title = modelChipTitle(state, pending);

  if (!canOpen) {
    // Not silent: a click says why the model cannot change right now.
    return (
      <button type="button" data-engine-chip data-model-lock={state.kind} title={title} onClick={() => toast.info(title)} className={cn(chipClass, "cursor-help")}>
        {chipInner}
        {dot}
        <Lock className="!size-2.5 shrink-0 opacity-50" />
      </button>
    );
  }

  const choose = (m: string) => {
    const next = m === "" ? "default" : m;
    if ((next === "default" ? null : next) === (session.model ?? null)) return setOpen(false);
    if (needsConfirm(session, true)) {
      hold.current = true;
      return setConfirm(next);
    }
    apply.mutate({ model: next });
  };

  const pickPair = (id: string) => {
    if (id === (session.pair ?? "")) return setOpen(false);
    const p = (pairs.data ?? []).find((x) => x.id === id);
    // A lead on another engine cannot take this conversation: that is a new session carrying a summary.
    if (p?.lead_engine && p.lead_engine !== session.engine) {
      setOpen(false);
      openHandoff(session.id, "switch", { pair: p.id, engine: p.lead_engine, model: leadModel(p), effort: p.lead_effort ?? "" });
      return;
    }
    setPair.mutate(id);
  };
  const note = uncachedNote(session);
  const pairNote = (p: Pair): string | null => {
    if (p.lead_engine && p.lead_engine !== session.engine) return `Leads with ${p.lead_engine}: continues in a new session from a summary.`;
    const m = leadModel(p);
    return m && m !== (session.model ?? "") ? `The lead switches to ${m}; the next turn re-reads the conversation uncached.` : null;
  };

  return (
    <Popover
      side="top"
      align="start"
      width={348}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button data-engine-chip data-model-switchable aria-label={`Run with: ${chipLabel}. Change it`} title={title} className={cn(chipClass, "hover:bg-hover hover:text-fg focus-visible:bg-hover")}>
          {chipInner}
          {dot}
          <ChevronDown className="!size-2.5 shrink-0 opacity-60" />
        </button>
      }
    >
      {confirm ? (
        <div data-model-confirm className="space-y-2 p-2 text-[12px]">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
            <p className="text-fg-muted">
              Switch to <span className="font-medium text-fg">{confirm}</span>? The next turn re-reads about <span className="font-medium text-fg">{compactTokens(session.context?.tokens ?? 0)} tokens</span> without the cache, so it costs more once.
            </p>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
              Back
            </Button>
            <Button size="xs" variant="primary" data-model-confirm-go disabled={apply.isPending} onClick={() => apply.mutate({ model: confirm })}>
              Switch
            </Button>
          </div>
        </div>
      ) : (
        <RunTabs tab={tab} setTab={setTab} hasPair={!!pair}>
          {tab === "harness" ? (
            pair ? (
              <div data-run-locked className="space-y-2 px-2 pb-1 pt-1 text-[12px]">
                <p className="text-fg-muted">
                  The lead follows <span className="font-medium text-violet">{pair.title}</span>:{" "}
                  <span className="font-mono text-fg">
                    {session.engine} · {session.model ?? "default"}
                    {session.effort ? ` @${session.effort}` : ""}
                  </span>
                  . A session runs a harness or a pair, not both.
                </p>
                <Button size="xs" variant="ghost" data-pair-detach disabled={setPair.isPending} onClick={() => setPair.mutate("")}>
                  Detach the pair to choose a model
                </Button>
              </div>
            ) : (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] text-fg-muted">
                  Model for the next turn. The engine stays <span className="font-medium text-fg">{session.engine}</span>.
                </div>
                <ModelPicker engine={session.engine} value={session.model ?? ""} onChange={choose} onDone={() => (hold.current ? (hold.current = false) : setOpen(false))} />
                <div className="mt-1.5 flex items-center gap-2 px-2">
                  <span className="w-11 shrink-0 text-[11px] text-fg-muted">Effort</span>
                  <EffortSlider engine={session.engine} model={session.model ?? ""} value={session.effort ?? ""} onChange={(e) => apply.mutate({ effort: e })} ariaLabel="Effort for the next turn" />
                </div>
                {note && (
                  <p data-model-cache-note className="px-2 pb-1 pt-1.5 text-[10.5px] leading-snug text-fg-faint">
                    {note}
                  </p>
                )}
                {session.depth === 0 && (
                  <div className="mt-1 border-t border-line px-1 pt-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      data-continue-with
                      onClick={() => {
                        setOpen(false);
                        openHandoff(session.id, "switch");
                      }}
                    >
                      <ArrowRightLeft /> Continue with another engine…
                    </Button>
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <PairList pairs={pairs.data ?? []} selectedId={session.pair ?? ""} onPick={pickPair} note={pairNote} disabled={setPair.isPending || session.depth !== 0} refetch={pairs.refetch} />
              <p className="px-2 pt-1 text-[10.5px] leading-snug text-fg-faint">Attaching a pair makes its lead this session's model; its heads and rules apply from the next turn.</p>
            </>
          )}
        </RunTabs>
      )}
    </Popover>
  );
}
