/**
 * The one slot above the composer's box. It shows exactly one thing, by urgency (see `slotKind`): a plan question
 * the agent is blocked on, a plan waiting for a decision, a goal that is working, or the lead and its heads.
 * Nothing else lives up here, and when there is nothing the slot takes no room.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Shelf as ShelfModel } from "./chat-logic";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { goalKey } from "./goal-logic";
import { GoalBar } from "./GoalBar";
import { usePlanState } from "./plan-data";
import { dockFor } from "./plan-logic";
import { PlanReadyRow, QuestionnaireCard, usePlanAutoOpen } from "./PlanFlow";
import { ShelfStrip } from "./Shelf";
import { goalSlot, planReady, slotKind } from "./slot-logic";

export interface StatusSlotProps {
  session: SessionView | null;
  shelf: ShelfModel | null;
  onOpenHead: (id: string) => void;
}

export function StatusSlot({ session, shelf, onOpenHead }: StatusSlotProps) {
  const state = usePlanState(session?.id ?? null, !!session);
  const plan = session ? planReady(state.data, session.status) : null;
  const dock = dockFor(state.data);
  const question = session && dock.kind === "question" ? dock.question : null;
  usePlanAutoOpen(session ?? ({ id: "", mode: "build" } as SessionView), state.data?.plan?.status === "draft" ? state.data.plan : null);

  // A dismissed finished goal stays gone for that goal only: a new goal on the session shows again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(null), [session?.id]);
  const goal = session?.goal ?? null;
  const goalMode = goalSlot(goal?.status, !!goal && dismissed === goalKey(goal));

  const kind = session ? slotKind({ question: !!question, plan: !!plan, goal: goalMode, shelf: !!shelf }) : "none";

  let node: ReactNode = null;
  if (session && kind === "question" && question && state.data) node = <div data-plan-flow="question" className="max-h-[58vh] min-h-0 overflow-y-auto rounded-lg border border-violet/30 bg-violet/5"><QuestionnaireCard key={question.id} session={session} state={state.data} question={question} /></div>;
  else if (session && kind === "plan" && plan) node = <PlanReadyRow key={plan.id} session={session} plan={plan} />;
  else if (session && kind === "goal" && goal) node = <GoalBar session={session} onDismiss={() => setDismissed(goalKey(goal))} />;
  else if (kind === "shelf" && shelf) node = <ShelfStrip shelf={shelf} onOpenHead={onOpenHead} />;

  // Keep what was showing while the slot animates closed, so it does not blink out empty.
  const kept = useRef<{ kind: string; node: ReactNode } | null>(null);
  const [, drop] = useState(0);
  if (node) kept.current = { kind, node };
  // ...and let go of it once the animation is over, so a closed slot holds nothing (no hidden row, nothing to find).
  useEffect(() => {
    if (node || !kept.current) return;
    const t = setTimeout(() => {
      kept.current = null;
      drop((n) => n + 1);
    }, 260);
    return () => clearTimeout(t);
  }, [node]);
  const view = node ? { kind, node } : kept.current;

  return (
    <div data-status-slot={node ? kind : "none"} aria-hidden={!node} inert={!node} className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", node ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
      <div className="min-h-0 overflow-hidden">
        {view && (
          <div key={view.kind} className="animate-slide-up px-2.5 pt-2.5">
            {view.node}
          </div>
        )}
      </div>
    </div>
  );
}
