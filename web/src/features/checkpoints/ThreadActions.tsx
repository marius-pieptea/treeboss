/**
 * Rewind and fork, where the conversation is. A user message offers "Rewind to before this message"; an agent
 * message offers "Fork from here". Both map the message to its turn id and reuse the checkpoint endpoints:
 *   GET  /api/sessions/:id/checkpoints            turns and their checkpoints
 *   POST /api/sessions/:id/turns/:turnId/rewind   files back to before the turn
 *   POST /api/sessions/:id/turns/:turnId/fork     a new isolated lead from the turn's end
 *
 * The provider wraps one session's thread (Chat or Trace); the buttons render nothing outside a provider, so a
 * head's own transcript never offers them.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, GitFork, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";
import { get, post, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { confirm } from "@/components/ui/dialogs";
import { Tooltip } from "@/components/ui/overlay";
import { openSession } from "@/features/agent/agent-commands";
import { forkState, rewindState, turnLines, type ActionState, type CheckpointRow, type TurnBrief, type TurnLine } from "./logic";

interface CheckpointsReply {
  checkpoints: CheckpointRow[];
  turns: TurnBrief[];
  can_rewind: boolean;
  closed: boolean;
}

interface Value {
  sessionId: string;
  lineOf: (turnId: string) => TurnLine | undefined;
  rewind: { run: (turnId: string) => void };
  rewindFor: (turnId: string) => ActionState;
  forkFor: (turnId: string) => ActionState;
  /** `instructions` replaces the default "carry on" brief: what the new session is to do instead. */
  fork: (turnId: string, instructions?: string) => void;
  busy: boolean;
}

const Ctx = createContext<Value | null>(null);

/** Set by the palette command: the message whose actions should be brought into view (a turn id). */
export const useThreadFocus = create<{ turnId: string | null; nonce: number; focus: (turnId: string) => void }>((set) => ({
  turnId: null,
  nonce: 0,
  focus: (turnId) => set((s) => ({ turnId, nonce: s.nonce + 1 })),
}));

export function ThreadActionsProvider({ sessionId, running, closed, children }: { sessionId: string; running: boolean; closed: boolean; children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["checkpoints", sessionId], queryFn: () => get<CheckpointsReply>(url.session(sessionId, "checkpoints")), staleTime: 2000 });
  // A turn ending is what records a checkpoint: look again when the running state flips.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
  }, [running, sessionId, qc]);

  const lines = useMemo(() => new Map(turnLines(q.data?.turns ?? [], q.data?.checkpoints ?? []).map((l) => [l.turn.id, l])), [q.data]);
  const gate = { running, closed };

  const rewind = useMutation({
    mutationFn: (turnId: string) => post<{ turn: number; restored: number; removed: number; failed: string[] }>(`/api/sessions/${sessionId}/turns/${turnId}/rewind`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["checkpoints", sessionId] });
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] === "git" || query.queryKey[0] === "fs" });
      toast.success(`Rewound to before turn ${r.turn}`, { description: `${r.restored} restored, ${r.removed} removed${r.failed.length ? `, ${r.failed.length} could not be written` : ""}. The agent is told on its next message.` });
    },
    onError: (e: Error) => toast.error("Could not rewind", { description: e.message }),
  });
  const fork = useMutation({
    mutationFn: ({ turnId, instructions }: { turnId: string; instructions?: string }) => post<{ session: { id: string; title: string } }>(`/api/sessions/${sessionId}/turns/${turnId}/fork`, instructions ? { instructions } : {}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.sessionsAll });
      openSession(r.session.id);
      toast.success("Forked into a new session", { description: r.session.title });
    },
    onError: (e: Error) => toast.error("Could not fork", { description: e.message }),
  });

  const value: Value = {
    sessionId,
    lineOf: (id) => lines.get(id),
    rewindFor: (id) => rewindState(lines.get(id), gate),
    forkFor: (id) => forkState(lines.get(id)),
    rewind: {
      run: (turnId) => {
        const line = lines.get(turnId);
        void confirm({
          title: `Rewind to before turn ${line?.turn.seq ?? ""}?`,
          description: "Only the files go back to how they were before this message. The agent keeps its memory of the conversation and is told about the rewind on its next message. What is there now is saved first, so this can be undone. Branches are not touched.",
          confirmLabel: "Rewind files",
        }).then((ok) => ok && rewind.mutate(turnId));
      },
    },
    fork: (turnId, instructions) => fork.mutate({ turnId, instructions }),
    busy: rewind.isPending || fork.isPending,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useActions = () => useContext(Ctx);

/** Visible on hover and keyboard focus of the message; always visible where there is no hover (touch). */
const reveal = "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

function ActionButton({ state, icon, label, onClick, persistent, busy, attr }: { state: ActionState; icon: ReactNode; label: string; onClick: () => void; persistent?: boolean; busy: boolean; attr: Record<string, string> }) {
  const off = !state.enabled || busy;
  return (
    <Tooltip label={state.label} side="top">
      {/* aria-disabled, not disabled: a disabled button is skipped by the keyboard and never shows its tooltip. */}
      <button
        type="button"
        aria-label={state.enabled ? label : `${label} (unavailable)`}
        aria-disabled={off || undefined}
        onClick={() => !off && onClick()}
        {...attr}
        data-enabled={state.enabled ? "true" : "false"}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-fg-faint outline-none transition-[opacity,color,background-color] duration-100 hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-accent [&_svg]:size-3.5",
          persistent ? "opacity-100" : reveal,
          off && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-fg-faint group-hover/msg:opacity-40 group-focus-within/msg:opacity-40 [@media(hover:none)]:opacity-40",
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/** On a user's message: files back to before that message's turn. */
export function RewindButton({ turnId }: { turnId: string | null | undefined }) {
  const a = useActions();
  if (!a || !turnId) return null;
  const state = a.rewindFor(turnId);
  return <ActionButton state={state} icon={<RotateCcw />} label="Rewind to before this message" onClick={() => a.rewind.run(turnId)} busy={a.busy} attr={{ "data-rewind": turnId }} />;
}

/** On an agent's message: a new isolated lead from this turn's checkpoint. The latest message shows it persistently. */
export function ForkButton({ turnId, latest }: { turnId: string | null | undefined; latest?: boolean }) {
  const a = useActions();
  if (!a || !turnId) return null;
  const state = a.forkFor(turnId);
  return <ActionButton state={state} icon={<GitFork />} label="Fork from here" onClick={() => a.fork(turnId)} persistent={latest} busy={a.busy} attr={{ "data-fork": turnId }} />;
}

/** On an agent's message: copy its text. Sits beside Fork and shows on the same hover/focus rules. */
export function CopyButton({ text, latest }: { text: string; latest?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      },
      () => toast.error("Could not copy to the clipboard"),
    );
  };
  return <ActionButton state={{ enabled: true, label: done ? "Copied" : "Copy message" }} icon={done ? <Check /> : <Copy />} label="Copy message" onClick={copy} persistent={latest} busy={false} attr={{ "data-copy": "" }} />;
}

/** Hook for the thread: scroll to the message the palette named and flash its action. */
export function useScrollToTurn(root: React.RefObject<HTMLElement | null>): void {
  const turnId = useThreadFocus((s) => s.turnId);
  const nonce = useThreadFocus((s) => s.nonce);
  useEffect(() => {
    if (!turnId || !root.current) return;
    const btn = root.current.querySelector<HTMLElement>(`[data-rewind="${turnId}"]`) ?? root.current.querySelector<HTMLElement>(`[data-fork="${turnId}"]`);
    btn?.scrollIntoView({ block: "center", behavior: "smooth" });
    btn?.focus({ preventScroll: true });
  }, [turnId, nonce, root]);
}
