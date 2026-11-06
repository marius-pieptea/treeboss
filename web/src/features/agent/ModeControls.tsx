/**
 * Build | Plan | Ask, and the goal, for the composer.
 *
 * With no session yet they shape the one about to start (state lives in the composer). With one, they act on it
 * straight away: the mode applies from the next turn, and a goal starts working at once when the session is idle.
 *
 * Build, Plan (quick or spec) and Ask live in ONE fixed-width dropdown, so nothing around it moves when a mode is
 * switched; the plan depth shows as the Plan icon.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ClipboardList, FileText, Hammer, MessageCircleQuestion, ScrollText, Target, X } from "lucide-react";
import { toast } from "sonner";
import { put, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { DropdownMenu } from "@/components/ui/overlay";
import { GoalDialog } from "./GoalDialog";
import { type GoalDraft, draftFromGoal, goalPayload } from "./goal-logic";
import { usePlanDecisions, usePlanState } from "./plan-data";
import { type Depth, type Mode, modeView, nextMode } from "./slot-logic";

export interface ModeControl {
  mode: Mode;
  depth: Depth;
  closed: boolean;
  set: (m: Mode) => void;
  toggle: () => void;
  setDepth: (d: Depth) => void;
}

/** Mode and plan depth, for a session that exists (acts on the daemon) or the next one (acts on composer state). */
export function useModeControl(session: SessionView | null, local: { mode: Mode; setMode: (m: Mode) => void; depth: Depth; setDepth: (d: Depth) => void }): ModeControl {
  const qc = useQueryClient();
  const { root } = useWorkspace();
  const closed = session?.status === "closed";
  const mode: Mode = session ? (session.mode ?? "build") : local.mode;
  const plan = usePlanState(session?.id ?? null, !!session && mode === "plan");
  const dec = usePlanDecisions(session?.id ?? "", root);
  const depth: Depth = session ? (plan.data?.depth ?? "quick") : local.depth;
  const refresh = () => {
    if (session) void qc.invalidateQueries({ queryKey: qk.session(session.id) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const setMode = useMutation({
    mutationFn: (m: Mode) => put(url.session(session!.id, "mode"), { mode: m }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error("Could not switch mode", { description: e.message }),
  });
  const set = (m: Mode) => {
    if (closed || m === mode) return;
    if (session) setMode.mutate(m);
    else local.setMode(m);
  };
  return {
    mode,
    depth,
    closed,
    set,
    toggle: () => set(nextMode(mode)),
    setDepth: (d) => {
      if (closed || d === depth) return;
      if (session) dec.depth.mutate(d);
      else local.setDepth(d);
    },
  };
}

/** One dropdown for Build / Plan / Ask. Fixed width at a given container size; the label gives way to the icon when the footer is narrow. */
export function ModeSegment({ control }: { control: ModeControl }) {
  const { mode, depth, closed } = control;
  const v = modeView(mode, depth);
  const PlanIcon = depth === "spec" ? ScrollText : ClipboardList;
  const Icon = mode === "plan" ? PlanIcon : mode === "ask" ? MessageCircleQuestion : Hammer;
  const label = mode === "plan" ? "Plan" : mode === "ask" ? "Ask" : "Build";
  const tone = mode === "plan" ? "bg-violet/15 text-violet" : mode === "ask" ? "bg-accent-soft text-accent" : "bg-raised text-fg-muted hover:text-fg";
  return (
    <div data-mode-segment data-mode={mode} data-plan-depth={depth} className="shrink-0">
      <DropdownMenu
        side="top"
        align="end"
        trigger={
          <button
            type="button"
            data-mode-trigger
            disabled={closed}
            aria-label={`Mode: ${label}`}
            title={`${mode === "plan" ? v.planTitle : mode === "ask" ? v.askTitle : "Build: the agent works on your code"} (Alt+P steps through the modes)`}
            className={cn("flex h-7 w-[34px] items-center justify-center gap-1.5 rounded-lg px-1.5 text-[11.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent/60 disabled:opacity-40 @[380px]:w-[84px]", tone)}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="hidden @[380px]:inline">{label}</span>
            <ChevronDown className="hidden size-3 shrink-0 opacity-60 @[380px]:block" />
          </button>
        }
        entries={[
          { label: "Build", icon: <Hammer />, checked: mode === "build", onSelect: () => control.set("build") },
          {
            label: "Plan: quick",
            icon: <FileText />,
            checked: mode === "plan" && depth === "quick",
            onSelect: () => {
              control.setDepth("quick");
              control.set("plan");
            },
          },
          {
            label: "Plan: spec it",
            icon: <ScrollText />,
            checked: mode === "plan" && depth === "spec",
            onSelect: () => {
              control.setDepth("spec");
              control.set("plan");
            },
          },
          { label: "Ask", icon: <MessageCircleQuestion />, checked: mode === "ask", onSelect: () => control.set("ask") },
        ]}
      />
    </div>
  );
}

export interface GoalControl {
  /** A goal is set (the next session's, or a session's working one). */
  active: boolean;
  open: () => void;
  /** The dialog; render it anywhere. */
  dialog: ReactNode;
}

export function useGoalControl(session: SessionView | null, newGoal: GoalDraft | null, setNewGoal: (g: GoalDraft | null) => void): GoalControl {
  const qc = useQueryClient();
  const [openState, setOpen] = useState(false);
  const goal = session?.goal ?? null;
  const refresh = () => {
    if (session) void qc.invalidateQueries({ queryKey: qk.session(session.id) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const setGoal = useMutation({
    mutationFn: (d: GoalDraft) => put(url.session(session!.id, "goal"), goalPayload(d)),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
    onError: (e: Error) => toast.error("Could not set the goal", { description: e.message }),
  });
  return {
    active: session ? goal?.status === "active" : !!newGoal,
    open: () => setOpen(true),
    dialog: (
      <GoalDialog
        open={openState}
        onOpenChange={setOpen}
        initial={session ? (goal ? draftFromGoal(goal) : null) : newGoal}
        busy={setGoal.isPending}
        confirmLabel={session ? "Start working" : newGoal ? "Save" : "Set goal"}
        onSave={(d) => {
          if (session) setGoal.mutate(d);
          else {
            setNewGoal(d);
            setOpen(false);
          }
        }}
        onRemove={
          !session && newGoal
            ? () => {
                setNewGoal(null);
                setOpen(false);
              }
            : undefined
        }
      />
    ),
  };
}

/** The goal chosen for the next session, as a chip inside the box: click to edit, x to drop it. */
export function GoalDraftChip({ goal, onEdit, onClear }: { goal: GoalDraft; onEdit: () => void; onClear: () => void }) {
  return (
    <span data-goal-chip className="group inline-flex h-5 max-w-[240px] items-center gap-1 rounded-md border border-accent/25 bg-accent-soft pl-1.5 pr-0.5 text-[11px] text-accent animate-pop">
      <button type="button" onClick={onEdit} title={`Goal: ${goal.text}. Click to edit.`} className="flex min-w-0 items-center gap-1 outline-none">
        <Target className="size-3 shrink-0" />
        <span className="truncate">{goal.text.split("\n")[0]}</span>
      </button>
      <button type="button" aria-label="Remove the goal" onClick={onClear} className="flex size-4 items-center justify-center rounded text-accent/70 outline-none hover:bg-accent/15 hover:text-accent focus-visible:bg-accent/15">
        <X className="size-3" />
      </button>
    </span>
  );
}
