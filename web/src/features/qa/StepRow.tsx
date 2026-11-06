import * as React from "react";
import { Ban, Check, Circle, CornerDownRight, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Kbd } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { Outcome, OutcomeInput, OutcomeState, PlanStep } from "./api";
import { outcomeDetail } from "./logic";

export const OUTCOME_ICON: Record<OutcomeState, { icon: React.ReactNode; tone: string; label: string }> = {
  pending: { icon: <Circle />, tone: "text-fg-faint", label: "Not run yet" },
  pass: { icon: <Check />, tone: "text-green", label: "Passed" },
  fail: { icon: <X />, tone: "text-red", label: "Failed" },
  skip: { icon: <SkipForward />, tone: "text-fg-muted", label: "Skipped" },
  blocked: { icon: <Ban />, tone: "text-amber", label: "Blocked" },
};

const DOT: Record<OutcomeState, string> = { pending: "bg-fg-faint", pass: "bg-green", fail: "bg-red", skip: "bg-fg-muted", blocked: "bg-amber" };

export function OutcomeIcon({ state, className }: { state: OutcomeState; className?: string }) {
  const o = OUTCOME_ICON[state];
  return (
    <span role="img" aria-label={o.label} title={o.label} className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5", o.tone, className)}>
      {o.icon}
    </span>
  );
}

export function PathChip({ path, active, onNavigate }: { path: string; active: boolean; onNavigate: (path: string) => void }) {
  return (
    <button
      type="button"
      title={`Open ${path} in the preview`}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate(path);
      }}
      className={cn("inline-flex h-[18px] max-w-full items-center gap-1 rounded-sm border px-1.5 font-mono text-[11px] leading-none outline-none transition-colors", active ? "border-accent/25 bg-accent-soft text-accent" : "border-line bg-raised text-fg-muted hover:bg-active hover:text-fg")}
    >
      <CornerDownRight className="size-3 shrink-0" />
      <span className="truncate">{path}</span>
    </button>
  );
}

export interface StepRowProps {
  step: PlanStep;
  number: number;
  outcome?: Outcome;
  /** What this step ended as in the run before: a faint marker. */
  last?: OutcomeState;
  current: boolean;
  pagePath: string | null;
  onSelect: () => void;
  onNavigate: (path: string) => void;
  children?: React.ReactNode;
}

export function StepRow({ step, number, outcome, last, current, pagePath, onSelect, onNavigate, children }: StepRowProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const detail = outcome ? outcomeDetail(outcome) : "";
  return (
    <div ref={ref} data-step={step.id} data-current={current || undefined} className={cn("rounded-lg border px-2 py-2 transition-colors", current ? "border-line-strong bg-raised" : "border-transparent hover:bg-hover")}>
      <div onClick={onSelect} className="flex cursor-default items-start gap-2">
        <span className="w-5 shrink-0 pt-px text-right font-mono text-[11px] leading-[18px] text-fg-muted">{number}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-snug text-fg">{step.action}</div>
          {step.expected && <div className="mt-1 text-xs leading-snug text-fg-muted">{step.expected}</div>}
          {step.path && (
            <div className="mt-1">
              <PathChip path={step.path} active={step.path === pagePath} onNavigate={onNavigate} />
            </div>
          )}
          {!current && detail && <div className="mt-1 line-clamp-1 text-xs text-fg-muted">{detail}</div>}
        </div>
        {last && last !== "pending" && <span role="img" aria-label={`Last run: ${last}`} title={`Last run: ${last}`} className={cn("mt-[7px] size-1.5 shrink-0 rounded-full opacity-50", DOT[last])} />}
        {outcome && <OutcomeIcon state={outcome.state} className="mt-px" />}
      </div>
      {current && children}
    </div>
  );
}

export type Ask = null | "fail" | "blocked";

export interface StepActionsProps {
  outcome: Outcome;
  ask: Ask;
  note: string;
  actual: string;
  onNote: (v: string) => void;
  onActual: (v: string) => void;
  onAsk: (a: Ask) => void;
  onMark: (o: OutcomeInput) => void;
}

/** The note box and the four outcome buttons of the step being run. Fail and blocked ask for words first. */
export function StepActions({ outcome, ask, note, actual, onNote, onActual, onAsk, onMark }: StepActionsProps) {
  const mark = (state: "pass" | "skip") => onMark({ state, note: note.trim() });
  const canFail = actual.trim() !== "";
  const canBlock = note.trim() !== "";
  return (
    <div className="mt-2 flex flex-col gap-2 pl-7">
      {ask === "fail" ? (
        <label key="fail" className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">What actually happened</span>
          <Textarea autoFocus rows={2} value={actual} onChange={(e) => onActual(e.target.value)} placeholder="The page stays blank." />
        </label>
      ) : (
        <label key={ask ?? "note"} className="flex flex-col gap-1">
          <span className="sr-only">Note</span>
          <Textarea autoFocus={ask === "blocked"} rows={1} value={note} onChange={(e) => onNote(e.target.value)} placeholder={ask === "blocked" ? "What is in the way?" : "Note (optional)"} className="min-h-8" />
        </label>
      )}
      {ask === "fail" ? (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={!canFail} onClick={() => onMark({ state: "fail", actual: actual.trim(), bug: outcome.state === "fail" ? outcome.bug : null })}>
            Fail and log bug
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAsk(null)}>
            Cancel
          </Button>
        </div>
      ) : ask === "blocked" ? (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={!canBlock} onClick={() => onMark({ state: "blocked", note: note.trim() })}>
            Mark blocked
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAsk(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => mark("pass")}>
            <Check className="text-green" /> Pass <Kbd>P</Kbd>
          </Button>
          <Button size="sm" onClick={() => onAsk("fail")}>
            <X className="text-red" /> Fail <Kbd>F</Kbd>
          </Button>
          <Button size="sm" onClick={() => mark("skip")}>
            <SkipForward /> Skip <Kbd>S</Kbd>
          </Button>
          <Button size="sm" onClick={() => (canBlock ? onMark({ state: "blocked", note: note.trim() }) : onAsk("blocked"))}>
            <Ban className="text-amber" /> Blocked <Kbd>B</Kbd>
          </Button>
        </div>
      )}
    </div>
  );
}
