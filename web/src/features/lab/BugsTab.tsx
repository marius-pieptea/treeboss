import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BadgeCheck, Bot, Bug, Check, Hammer, Undo2, X } from "lucide-react";
import { WhoPicker, useWho, type Who } from "@/components/agent-who";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { partUrl } from "@/features/evidence/data";
import { openSession } from "@/features/agent/agent-commands";
import { useUi } from "@/lib/store";
import { bus } from "@/lib/bus";
import { cn } from "@/lib/utils";
import { type Actions, type Finding } from "./data";
import { takePendingBugs } from "./views";
import { LabGate, LabPage, SweepRow, useLabView } from "./shared";
import { bugState, BUG_KINDS, byKind, fixableBugs, hasScreenshot, IMPACT_TONE, isBug, kindCounts, runningFix, unconfirmed, type BugState, type KindFilter } from "./logic";

const BUG_TONE: Record<BugState, "red" | "accent" | "amber" | "green" | "neutral"> = { open: "red", fixing: "accent", "needs-check": "amber", fixed: "green", dismissed: "neutral" };
const BUG_LABEL: Record<BugState, string> = { open: "open", fixing: "fixing", "needs-check": "needs check", fixed: "fixed", dismissed: "dismissed" };

/** A bug logged from the browser, by a person or a QA agent: the page it was seen on, a thumbnail of what was captured, and the ways to deal with it. */
function BugCard({ root, f, who, actions, busy, fixBlocked, onOpenSession, focused }: { root: string; f: Finding; who: Who; actions: Actions; busy: boolean; fixBlocked: string | null; onOpenSession: (id: string) => void; focused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const openTab = useUi((s) => s.openTab);
  const state = bugState(f, f.fixRunning);
  const closed = state === "fixed" || state === "dismissed";
  const go = (p: Promise<{ session?: { id: string } }>) => void p.then((r) => r.session && onOpenSession(r.session.id)).catch(() => {});
  const url = f.bug?.url ?? "";
  // An agent's bug waits for a person: Confirm is the main action until then, and fix-all skips it.
  const toConfirm = unconfirmed(f) && !closed;
  return (
    <article ref={ref} data-bug={f.id} data-bug-state={state} className={cn("flex gap-3 rounded-xl border border-line bg-panel px-3 py-2.5", closed && "opacity-60", focused && "border-accent bg-accent-soft/40")}>
      {hasScreenshot(f) && <img src={partUrl(root, f.bug.capture, "screenshot.png")} alt={`Screenshot for ${f.title}`} loading="lazy" className="h-16 w-24 shrink-0 rounded-lg border border-line bg-raised object-cover object-top" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <header className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">{f.title}</h3>
          <div className="flex shrink-0 items-center gap-1">
            {f.bug?.shot === "rerender" && <Badge title="The screenshot was re-rendered from the captured page, not taken from the screen">Re-render</Badge>}
            {f.bug?.by === "agent" && (
              <Badge tone="violet" title="Logged by a QA agent while it used the app">
                <Bot className="size-3" /> agent
              </Badge>
            )}
            {toConfirm && <Badge tone="amber" title="Not confirmed by a person yet: fix-all leaves it alone">unconfirmed</Badge>}
            {f.bug && <Badge tone="blue" title="Kind of bug">{f.bug.kind}</Badge>}
            <Badge tone={IMPACT_TONE[f.impact]} title="Impact">{f.impact}</Badge>
            <Badge tone={BUG_TONE[state]}>{BUG_LABEL[state]}</Badge>
          </div>
        </header>
        {url && (
          <button type="button" onClick={() => openTab({ kind: "browser", url, title: url })} title="Open in the preview browser" className="max-w-full self-start truncate rounded px-1 font-mono text-[11px] text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
            {url}
          </button>
        )}
        {f.summary && <p className="line-clamp-2 text-[12px] leading-snug text-fg-muted">{f.summary}</p>}
        {f.problem && <p className="text-[11.5px] text-amber">{f.problem}</p>}
        <footer className="flex flex-wrap items-center gap-1.5">
          {toConfirm && (
            <Button size="xs" variant="primary" disabled={busy} onClick={() => actions.confirm.mutate(f.id)} title="You checked it and it is a real bug: fix-all may pick it up">
              <BadgeCheck /> Confirm
            </Button>
          )}
          {!closed && (
            <Button size="xs" variant={toConfirm ? "outline" : "primary"} disabled={busy || !!fixBlocked} onClick={() => go(actions.fix.mutateAsync({ id: f.id, ...who }))} title={fixBlocked ?? "Start a session that fixes this"}>
              <Hammer /> {f.fixRunning ? "Fix running" : "Fix now"}
            </Button>
          )}
          {f.fixSession && (
            <Button size="xs" variant="ghost" onClick={() => onOpenSession(f.fixSession!)}>
              <ArrowUpRight /> Open fix session
            </Button>
          )}
          <div className="flex-1" />
          {closed ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "new" })}>
              <Undo2 /> Reopen
            </Button>
          ) : (
            <>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "shipped" })}>
                <Check /> Fixed
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.setStatus.mutate({ id: f.id, status: "dismissed" })}>
                <X /> Dismiss
              </Button>
            </>
          )}
        </footer>
      </div>
    </article>
  );
}


/** Bugs logged from the browser by a person or a QA agent, with the page they were seen on. */
export function BugsTab() {
  const { root, q, state, actions, busy, fixBlockOf } = useLabView();
  const [who, setWho] = useWho();
  const [kind, setKind] = useState<KindFilter>("all");
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    const take = () => {
      const i = takePendingBugs();
      if (!i?.finding) return;
      setKind("all");
      setFocusId(i.finding);
    };
    take();
    return bus.on("bugs-open", take);
  }, []);
  const bugs = useMemo(() => (state?.findings ?? []).filter(isBug), [state?.findings]);
  const kinds = useMemo(() => kindCounts(bugs), [bugs]);
  const shownBugs = useMemo(() => byKind(bugs, kind), [bugs, kind]);
  const fixable = useMemo(() => fixableBugs(bugs).length, [bugs]);
  const anyFix = useMemo(() => runningFix(state?.findings ?? []), [state?.findings]);
  const fixSweepOpen = (state?.sweeps ?? []).some((s) => s.kind === "fix" && !s.cancelled && (s.running > 0 || s.queued > 0));

  if (!state) return <LabGate q={q} icon={<Bug />} title="Bugs" />;

  return (
    <LabPage icon={<Bug />} title="Bugs" hint="Bugs logged from the browser by you or by a QA agent, with the page they were seen on. Confirm an agent's bug before fix-all picks it up.">
      {state.sweeps
        .filter((s) => s.kind === "fix" && (s.running > 0 || s.queued > 0))
        .map((s) => (
          <SweepRow key={s.id} sweep={s} onCancel={() => actions.cancelSweep.mutate(s.id)} />
        ))}
      <section className="flex flex-col gap-3" aria-label="Bugs">
        <div className="flex flex-wrap items-center gap-2">
          <WhoPicker who={who} onChange={setWho} inline />
          <div className="flex-1" />
          {bugs.length > 0 && (
            <Select
              size="sm"
              className="w-40"
              aria-label="Filter bugs by kind"
              value={kind}
              onChange={(v) => setKind(v as KindFilter)}
              options={[{ value: "all", label: `All kinds · ${kinds.all}` }, ...BUG_KINDS.map((k) => ({ value: k, label: `${k[0]!.toUpperCase()}${k.slice(1)} · ${kinds[k]}` }))]}
            />
          )}
          <Button variant="primary" size="sm" disabled={fixable === 0 || fixSweepOpen || !!anyFix || busy} onClick={() => actions.fixAllBugs.mutate(who)} title={fixSweepOpen ? "A fix-all run is already going" : anyFix ? fixBlockOf("") ?? undefined : "Fix the open bugs one after another"}>
            {actions.fixAllBugs.isPending ? <Spinner className="size-3.5" /> : <Hammer />} Fix all open ({fixable})
          </Button>
        </div>
        {bugs.length === 0 ? (
          <Empty icon={<Bug />} title="No bugs logged" hint="Press Log bug on a page in the browser, or run a QA plan with an agent." />
        ) : (
          shownBugs.length === 0 ? (
            <Empty icon={<Bug />} title={`No ${kind} bugs`} hint="Pick another kind to see the rest." />
          ) : (
            shownBugs.map((b) => <BugCard key={b.id} root={root} f={b} who={who} actions={actions} busy={busy} fixBlocked={fixBlockOf(b.id)} onOpenSession={openSession} focused={b.id === focusId} />)
          )
        )}
      </section>
    </LabPage>
  );
}
