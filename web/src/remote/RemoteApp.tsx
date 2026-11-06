/**
 * The compact view for a paired phone: sessions, one session's feed and heads, plan decisions and questions,
 * a follow-up box and Interrupt. Everything here uses only what a remote token is allowed to call (see
 * src/remote/policy.ts): a 403 anywhere else is a bug in this file, not something to work around.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronsUpDown, Octagon, Send, ShieldCheck } from "lucide-react";
import { Dialog } from "radix-ui";
import { get, onSignedOut, post, url } from "@/lib/api";
import { qk, useGlobalStream, useSession } from "@/lib/queries";
import { useSessionStream } from "@/lib/session-stream";
import { groupTools, summarizeTools, type DisplayItem } from "@/lib/transcript";
import type { PlanQuestion, PlanRecord, SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Markdown } from "@/features/agent/Markdown";
import { usePlanActions, usePlanFile, usePlanState } from "@/features/agent/plan-data";
import { answerPayload, canAnswer, dockFor, planBody, planDecisionReady, stepLabel, toggleChoice } from "@/features/agent/plan-logic";
import { Spinner } from "@/components/ui/misc";
import { elsewhere, grantsLabel, modelLabel, nearBottom, pickWorkspace, sendState, sessionFromHash, sortLeads, statusChip, windowItems, type Chip, type RemoteWorkspace } from "./logic";

const TONE: Record<Chip["tone"], string> = {
  accent: "bg-accent-soft text-accent",
  green: "bg-green/10 text-green",
  amber: "bg-amber/15 text-amber",
  red: "bg-red/10 text-red",
  muted: "bg-raised text-fg-muted",
};

function ChipView({ chip }: { chip: Chip }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium", TONE[chip.tone])}>{chip.label}</span>;
}

function useHash(): [string | null, (id: string | null) => void] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [sessionFromHash(hash), (id) => (location.hash = id ? `#${id}` : "")];
}

function Gone() {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg p-6 text-center text-fg">
      <div className="max-w-sm">
        <ShieldCheck className="mx-auto mb-4 size-9 text-fg-muted" />
        <h1 className="text-[18px] font-semibold">This device is not paired</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">Its access was revoked or has expired, or remote access is switched off. On the computer, open Settings, Remote access (or run <code className="text-accent">trb remote pair</code>) and scan the new QR code.</p>
      </div>
    </div>
  );
}

export function RemoteApp() {
  useGlobalStream(null);
  const [gone, setGone] = useState(false);
  const [sessionId, open] = useHash();
  useEffect(() => onSignedOut(() => setGone(true)), []);
  const me = useQuery({ queryKey: ["remote-me"], queryFn: () => get<{ kind: string; label?: string; grants: { terminal: boolean; files: "off" | "read" | "write" } }>("/api/remote/me"), staleTime: 60_000, retry: false });
  if (gone) return <Gone />;
  return (
    <div className="mx-auto flex h-dvh w-full max-w-xl flex-col bg-bg text-fg">
      {sessionId ? <SessionScreen key={sessionId} id={sessionId} onBack={() => open(null)} /> : <ListScreen onOpen={open} label={me.data?.label} grants={me.data?.grants} />}
    </div>
  );
}

/* ------------------------------------------------------------------ list */

function ListCard({ s, onOpen }: { s: SessionView; onOpen: (id: string) => void }) {
  const planOn = s.mode === "plan" && s.status !== "closed";
  const plan = usePlanState(s.id, planOn);
  const chip = statusChip(s, plan.data ? { pending: !!plan.data.pending, draft: plan.data.plan?.status === "draft" } : null);
  return (
    <button onClick={() => onOpen(s.id)} className="flex w-full flex-col gap-1.5 rounded-xl border border-line bg-panel p-3.5 text-left active:bg-hover">
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 min-w-0 break-words text-[15px] font-medium leading-snug">{s.title || s.id}</span>
        <ChipView chip={chip} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-fg-muted">
        <span>{modelLabel(s)}</span>
        {s.branch && <span className="truncate font-mono text-[11.5px]">{s.branch}</span>}
        <span className="ml-auto">{s.turns} turn{s.turns === 1 ? "" : "s"}</span>
      </div>
    </button>
  );
}

const WS_KEY = "trb.remote.workspace";
const savedWorkspace = (): string | null => {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
};

/** The workspace picker: one tap target in the header, a bottom sheet with every workspace and what is running in it. */
function WorkspaceSwitcher({ list, current, onPick }: { list: RemoteWorkspace[]; current: string | null; onPick: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const away = elsewhere(list, current);
  const name = list.find((w) => w.id === current)?.name ?? "All workspaces";
  const rows: Array<{ id: string | null; name: string; running: number; failed: number }> = [{ id: null, name: "All workspaces", running: 0, failed: 0 }, ...list];
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button aria-label="Switch workspace" className="-mx-2 flex min-h-11 max-w-full items-center gap-1.5 rounded-lg px-2 active:bg-hover">
          <span className="truncate text-[18px] font-semibold tracking-tight">{name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-faint" />
          {(away.running > 0 || away.failed > 0) && <span title={`${away.running} running, ${away.failed} failed in other workspaces`} className={cn("size-2 shrink-0 rounded-full", away.failed > 0 ? "bg-red" : "bg-accent animate-pulse-dot")} />}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[70dvh] w-full max-w-xl flex-col rounded-t-2xl border border-b-0 border-line-strong bg-overlay text-fg shadow-pop outline-none">
          <Dialog.Title className="shrink-0 px-4 pb-1 pt-4 text-[13px] font-medium uppercase tracking-wide text-fg-muted">Workspace</Dialog.Title>
          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {rows.map((w) => (
              <li key={w.id ?? "all"}>
                <button onClick={() => { onPick(w.id); setOpen(false); }} aria-current={w.id === current} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-[15px] active:bg-hover">
                  <Check className={cn("size-4 shrink-0 text-accent", w.id !== current && "invisible")} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.running > 0 && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent">{w.running} working</span>}
                  {w.failed > 0 && <span className="shrink-0 rounded-full bg-red/10 px-2 py-0.5 text-[11.5px] font-medium text-red">{w.failed} failed</span>}
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ListScreen({ onOpen, label, grants }: { onOpen: (id: string) => void; label?: string; grants?: { terminal: boolean; files: "off" | "read" | "write" } }) {
  const [saved, setSaved] = useState(savedWorkspace);
  const wsq = useQuery({ queryKey: ["remote-workspaces"], queryFn: () => get<{ workspaces: RemoteWorkspace[] }>("/api/remote/workspaces").then((r) => r.workspaces), refetchInterval: 15_000, retry: false });
  const current = pickWorkspace(saved, wsq.data);
  const pick = (id: string | null) => {
    setSaved(id);
    try {
      id ? localStorage.setItem(WS_KEY, id) : localStorage.removeItem(WS_KEY);
    } catch {
      /* private mode: the choice just lasts until the page closes */
    }
  };
  // A remembered workspace is checked against the list first, so a removed one does not request a 404.
  const ready = !saved || wsq.isFetched;
  const q = useQuery({
    queryKey: [...qk.sessionsAll, "remote", current],
    enabled: ready,
    queryFn: () => get<{ sessions: SessionView[] }>(`/api/sessions?limit=60${current ? `&workspace=${current}` : ""}`).then((r) => r.sessions),
    refetchInterval: 15_000,
  });
  const leads = useMemo(() => sortLeads(q.data ?? []), [q.data]);
  const many = (wsq.data?.length ?? 0) > 1;
  return (
    <>
      <header className="shrink-0 border-b border-line px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        {many && wsq.data ? <WorkspaceSwitcher list={wsq.data} current={current} onPick={pick} /> : <h1 className="text-[18px] font-semibold tracking-tight">Sessions</h1>}
        <p className="mt-0.5 text-[12.5px] text-fg-muted">{label ? `Paired as ${label}. ` : ""}{grants ? `This device can: ${grantsLabel(grants)}.` : ""}</p>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {(!ready || q.isLoading) && <div className="flex justify-center py-10"><Spinner className="size-5" /></div>}
        {q.isError && <p className="py-8 text-center text-[14px] text-red">Could not load sessions. Pull to retry in a moment.</p>}
        {q.data && leads.length === 0 && <p className="py-10 text-center text-[14px] text-fg-muted">{current ? "No sessions in this workspace yet." : "No sessions yet. Start one on the computer and it shows up here."}</p>}
        <div className="flex flex-col gap-2.5">
          {leads.map((s) => (
            <ListCard key={s.id} s={s} onOpen={onOpen} />
          ))}
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ plan dock */

function QuestionCard({ sessionId, q, expected }: { sessionId: string; q: PlanQuestion; expected: number }) {
  const { answer } = usePlanActions(sessionId);
  const [choices, setChoices] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const draft = { choices, custom };
  return (
    <div className="rounded-xl border border-amber/40 bg-panel p-3.5">
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-amber">{stepLabel(q, expected)}</div>
      <p className="mt-1 text-[15px] font-medium leading-snug">{q.question}</p>
      <div className="mt-3 flex flex-col gap-2">
        {q.options.map((o) => {
          const on = choices.includes(o.label);
          return (
            <button key={o.label} onClick={() => { setChoices((c) => toggleChoice(q, c, o.label)); setCustom(""); }} aria-pressed={on} className={cn("min-h-11 rounded-lg border px-3 py-2 text-left text-[14px]", on ? "border-accent bg-accent-soft" : "border-line bg-raised")}>
              <span className="font-medium">{o.label}</span>
              {o.recommended && <span className="ml-2 text-[11.5px] text-accent">recommended</span>}
              {o.description && <span className="mt-0.5 block text-[12.5px] text-fg-muted">{o.description}</span>}
            </button>
          );
        })}
        {q.allow_custom && <textarea value={custom} onChange={(e) => { setCustom(e.target.value); if (!q.multi) setChoices([]); }} rows={2} placeholder="Or write your own answer" className="w-full resize-none rounded-lg border border-line bg-raised px-3 py-2 text-[15px] outline-none focus:border-accent" />}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={!canAnswer(q, draft) || answer.isPending} onClick={() => answer.mutate(answerPayload(q, draft))} className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-[14px] font-semibold text-accent-fg disabled:opacity-50">
          {answer.isPending ? "Sending…" : "Send answer"}
        </button>
        <button disabled={answer.isPending} onClick={() => answer.mutate({ question_id: q.id, skip: true })} className="min-h-11 rounded-lg px-3 text-[13.5px] text-fg-muted">
          Skip
        </button>
      </div>
    </div>
  );
}

function PlanCard({ sessionId, plan, ready }: { sessionId: string; plan: PlanRecord; ready: boolean }) {
  const { approve, changes } = usePlanActions(sessionId);
  const [full, setFull] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const file = usePlanFile(sessionId, plan.id, full);
  return (
    <div className="rounded-xl border border-amber/40 bg-panel p-3.5">
      <div className="text-[11.5px] font-medium uppercase tracking-wide text-amber">Plan{plan.version > 1 ? ` v${plan.version}` : ""} ready</div>
      <h2 className="mt-1 text-[16px] font-semibold leading-snug">{plan.title}</h2>
      {plan.summary && <p className="mt-1 text-[14px] leading-relaxed text-fg-muted">{plan.summary}</p>}
      {plan.steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-[14px]">
          {plan.steps.map((s, i) => (
            <li key={i}>{s.title}</li>
          ))}
        </ol>
      )}
      <button onClick={() => setFull((v) => !v)} className="mt-2 flex min-h-9 items-center gap-1 text-[13.5px] text-accent">
        {full ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Read the full plan
      </button>
      {full && <div className="mt-1 max-h-[45dvh] overflow-y-auto rounded-lg border border-line bg-raised p-3 text-[14px]">{file.isLoading ? <Spinner /> : file.data ? <Markdown text={planBody(file.data.text)} /> : <span className="text-fg-muted">Could not load the plan file.</span>}</div>}
      {!ready && <p className="mt-2 text-[12.5px] text-fg-muted">The agent is still finishing its turn. You can decide in a moment.</p>}
      {asking ? (
        <div className="mt-3 flex flex-col gap-2">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus placeholder="What should change?" className="w-full resize-none rounded-lg border border-line bg-raised px-3 py-2 text-[15px] outline-none focus:border-accent" />
          <div className="flex gap-2">
            <button disabled={!note.trim() || changes.isPending} onClick={() => changes.mutate({ planId: plan.id, note: note.trim() }, { onSuccess: () => { setAsking(false); setNote(""); } })} className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-[14px] font-semibold text-accent-fg disabled:opacity-50">Send changes</button>
            <button onClick={() => setAsking(false)} className="min-h-11 rounded-lg px-3 text-[13.5px] text-fg-muted">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button disabled={!ready || approve.isPending} onClick={() => approve.mutate({ planId: plan.id })} className="min-h-11 flex-1 rounded-lg bg-accent px-4 text-[14px] font-semibold text-accent-fg disabled:opacity-50">
            {approve.isPending ? "Starting…" : plan.depth === "spec" ? "Approve spec" : "Approve and build"}
          </button>
          <button disabled={!ready} onClick={() => setAsking(true)} className="min-h-11 rounded-lg border border-line px-3 text-[13.5px] disabled:opacity-50">Request changes</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ session */

function HeadsList({ heads }: { heads: SessionView[] }) {
  const [open, setOpen] = useState(true);
  const live = heads.filter((h) => h.status !== "closed");
  if (!heads.length) return null;
  return (
    <section className="rounded-xl border border-line bg-panel">
      <button onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full items-center gap-2 px-3.5 text-left text-[13.5px] font-medium">
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Heads <span className="text-fg-muted">{live.filter((h) => h.status === "running").length} working, {live.length} open</span>
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line">
          {heads.map((h) => (
            <li key={h.id} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[14px]">{h.title || h.role || h.id}</div>
                <div className="truncate text-[12px] text-fg-muted">{[h.role, modelLabel(h), h.changes ? `${h.changes.files} file${h.changes.files === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}</div>
              </div>
              <ChipView chip={statusChip(h)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedItem({ it, lead, names }: { it: DisplayItem; lead: string; names: Map<string, string> }) {
  const head = it.session !== lead ? names.get(it.session) ?? "head" : null;
  const wrap = (child: React.ReactNode) => (head ? <div className="border-l-2 border-line pl-3"><div className="mb-0.5 text-[11px] uppercase tracking-wide text-fg-faint">{head}</div>{child}</div> : <>{child}</>);
  switch (it.type) {
    case "user":
      return <div className="ml-auto line-clamp-6 max-w-[88%] whitespace-pre-wrap break-words rounded-2xl bg-accent-soft px-3.5 py-2 text-[14.5px]">{it.text}</div>;
    case "text":
      return wrap(<div className={cn("break-words text-[14.5px] leading-relaxed", head && "text-fg-muted")}><Markdown text={it.text} /></div>);
    case "tools":
      return wrap(<div className="text-[12.5px] text-fg-muted">{summarizeTools(it.tools)}{it.tools.some((t) => t.status === "err") ? " (some failed)" : it.tools.some((t) => t.status === "running") ? "…" : ""}</div>);
    case "note":
      return wrap(<div className={cn("text-[12.5px]", it.tone === "warn" ? "text-amber" : "text-fg-muted")}>{it.text}</div>);
    case "end":
      return wrap(<div className={cn("text-[12.5px]", it.ok ? "text-fg-muted" : "text-red")}>{it.ok ? "Finished" : it.text}</div>);
    default:
      return null;
  }
}

function SessionScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const detail = useSession(id);
  const stream = useSessionStream(id, { tree: true });
  const s = detail.data?.session;
  const heads = detail.data?.children ?? [];
  const planOn = s?.mode === "plan";
  const plan = usePlanState(id, planOn);
  const dock = planOn ? dockFor(plan.data) : { kind: "none" as const };
  const status = stream.status[id] ?? s?.status ?? "idle";
  const chip = s ? statusChip({ ...s, status }, plan.data ? { pending: !!plan.data.pending, draft: plan.data.plan?.status === "draft" } : null) : null;

  const [shown, setShown] = useState(60);
  const items = useMemo(() => groupTools(stream.transcript.items), [stream.transcript.items]);
  const win = windowItems(items, shown);
  const names = useMemo(() => new Map(heads.map((h) => [h.id, h.role || h.title || h.engine])), [heads]);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items.length, dock.kind, heads.length]);

  const [text, setText] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.session(id) });
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
  };
  const send = useMutation({
    mutationFn: (message: string) => post(url.session(id, "send"), { message }),
    onSuccess: () => { setText(""); pinned.current = true; refresh(); },
    onError: (e: Error) => toast.error("Could not send", { description: e.message }),
  });
  const interrupt = useMutation({
    mutationFn: () => post(url.session(id, "interrupt"), {}),
    onSuccess: refresh,
    onError: (e: Error) => toast.error("Could not interrupt", { description: e.message }),
  });
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const ss = sendState(status, text);

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onBack} aria-label="Back to sessions" className="flex size-11 shrink-0 items-center justify-center rounded-lg active:bg-hover"><ArrowLeft className="size-5" /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold leading-tight">{s?.title || id}</div>
          <div className="truncate text-[12px] text-fg-muted">{s ? [modelLabel(s), s.branch].filter(Boolean).join(" · ") : ""}</div>
        </div>
        {chip && <ChipView chip={chip} />}
        {status === "running" && (
          <button onClick={() => (armed ? (setArmed(false), interrupt.mutate()) : setArmed(true))} disabled={interrupt.isPending} className={cn("flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium", armed ? "bg-red text-white" : "border border-line")}>
            <Octagon className="size-4" /> {armed ? "Tap to stop" : "Interrupt"}
          </button>
        )}
      </header>

      <div ref={scroller} onScroll={(e) => (pinned.current = nearBottom(e.currentTarget))} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <div className="flex flex-col gap-3">
          <HeadsList heads={heads} />
          {!stream.ready && <div className="flex justify-center py-8"><Spinner className="size-5" /></div>}
          {win.hidden > 0 && <button onClick={() => setShown((n) => n + 60)} className="min-h-10 self-center text-[13px] text-accent">Show {Math.min(60, win.hidden)} earlier</button>}
          {win.items.map((it) => (
            <FeedItem key={it.id} it={it} lead={id} names={names} />
          ))}
          {dock.kind === "question" && plan.data && <QuestionCard key={dock.question.id} sessionId={id} q={dock.question} expected={plan.data.expected_total} />}
          {dock.kind === "plan" && <PlanCard key={dock.plan.id} sessionId={id} plan={dock.plan} ready={planDecisionReady(status)} />}
        </div>
      </div>

      <footer className="shrink-0 border-t border-line bg-panel px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        {ss.hint && <p className="px-1 pb-1.5 text-[12.5px] text-fg-muted">{ss.hint}</p>}
        <div className="flex items-end gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} disabled={status === "closed"} placeholder={status === "running" ? "Working…" : "Send a follow-up"} enterKeyHint="send" className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-line bg-raised px-3 py-2.5 text-[16px] outline-none focus:border-accent disabled:opacity-60" />
          <button onClick={() => send.mutate(text.trim())} disabled={!ss.canSend || send.isPending} aria-label="Send" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40">{send.isPending ? <Spinner className="text-accent-fg" /> : <Send className="size-5" />}</button>
        </div>
      </footer>
    </>
  );
}
