import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, AtSign, BookOpen, Bot, ClipboardCopy, CornerDownLeft, Eye, GitBranch, MoreHorizontal, Network, Pencil, Play, ShieldCheck, Slash, Square, SquareTerminal, Trash2, UserRoundCog, WifiOff, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, get, post, url } from "@/lib/api";
import { qk, useAgents, usePairs, useSession } from "@/lib/queries";
import { useSessionStream } from "@/lib/session-stream";
import { useUi, useWs } from "@/lib/store";
import { isMac } from "@/lib/hooks";
import type { TranscriptItem } from "@/lib/transcript";
import type { SessionView, TerminalInfo, TurnRow } from "@/lib/types";
import { cn, money, tokens } from "@/lib/utils";
import { DropdownMenu, Tooltip } from "@/components/ui/overlay";
import { Badge, Kbd, Skeleton, StatusDot } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { Transcript, type SessionLabels } from "./Transcript";
import { FileLinkScope } from "./FileLinks";
import { Composer } from "./Composer";
import { ChatThread, PendingTurn } from "./ChatThread";
import { ThreadActionsProvider } from "@/features/checkpoints/ThreadActions";
import { useSessionVerify, VerifyToggle } from "@/features/checkpoints/VerifyToggle";
import { openVerifySettings } from "@/features/checkpoints/commands";
import { setFollowView, useFollowView } from "@/features/context/follow";
import { WaitingChip } from "./WaitingChip";
import { openHandoff } from "./HandoffDialog";
import { loadViewMode, otherMode, saveViewMode, shelfFor, terminalResume, type ViewMode } from "./chat-logic";
import { useHeadActions } from "@/features/heads/actions";
import { FailureCard, RunStrip, TurnSummary } from "./RunStrip";
import { NextSteps } from "./NextSteps";
import { bus } from "@/lib/bus";
import { openSession, registerAgentCommands, startNewSession } from "./agent-commands";
import { NewSessionButton, SessionSwitcher } from "./SessionSwitcher";
import { ensureTurnWatcher } from "./turn-watcher";
import { draftKey, drafts } from "@/lib/drafts";
import { useDaemonOnline } from "./health";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { ModeBadge } from "./ModeBadge";
import { showsModelMark } from "@/lib/models-logic";

const EXAMPLES = ["Explain how this project is structured", "Find and fix any failing tests", "Add input validation to the public API", "Review my uncommitted changes and point out bugs"];

function EmptyAgent({ onPick }: { onPick: (text: string) => void }) {
  const agents = useAgents();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-8 text-center">
      <div className="animate-slide-up">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl border border-line bg-raised text-accent">
          <Bot className="size-5" />
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight">What should we build?</h2>
        <p className="mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed text-fg-muted">Pick an engine, or a Hydra pair to lead several heads in parallel, then describe the change.</p>
      </div>
      <div className="flex w-full max-w-[360px] flex-col gap-1.5">
        {EXAMPLES.map((ex, i) => (
          <button key={ex} onClick={() => onPick(ex)} style={{ "--i": i } as CSSProperties} className="group animate-slide-up stagger flex items-center gap-2 rounded-lg border border-line bg-panel/50 px-3 py-2 text-left text-[12.5px] text-fg-muted outline-none transition-[border-color,color,transform] hover:border-line-strong hover:text-fg focus-visible:border-accent/60 active:scale-[0.99]">
            <span className="flex-1">{ex}</span>
            <CornerDownLeft className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
          </button>
        ))}
      </div>
      <div className="flex animate-slide-up flex-col gap-1.5 text-[11px] text-fg-faint" style={{ animationDelay: "240ms" }}>
        <span className="flex items-center justify-center gap-1.5">
          <AtSign className="size-3" /> mention a file <Kbd>@</Kbd>
        </span>
        <span className="flex items-center justify-center gap-1.5">
          <Slash className="size-3" /> commands <Kbd>/</Kbd> <span>/pair, /agent, /model, /new</span>
        </span>
      </div>
      {agents.data && (
        <div className="flex max-w-[330px] animate-slide-up flex-col items-center gap-1.5 rounded-xl border border-dashed border-line px-4 py-3 text-xs text-fg-muted" style={{ animationDelay: "300ms" }}>
          <span className="flex items-center gap-1.5 font-medium text-fg">
            <UserRoundCog className="size-3.5 text-accent" /> Specialized agents
          </span>
          {agents.data.length === 0 ? (
            <>
              <span className="leading-relaxed">An agent bundles standing instructions with the skills and tools it may use: a reviewer, a test writer, a docs editor.</span>
              <button onClick={() => useUi.getState().openTab({ kind: "settings", page: "agents", title: "Agents" })} className="font-medium text-accent outline-none hover:underline focus-visible:underline">
                Create an agent
              </button>
            </>
          ) : (
            <span className="leading-relaxed">
              Pick one in the composer to run this session as {agents.data.length === 1 ? agents.data[0].title : "an agent"}, or type <span className="font-mono">/agent {agents.data[0].name}</span>.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Title, status and the Chat | Trace switch. The detail badges (engine, effort, tokens, cost) belong to Trace. */
function Header({ session, mode, onMode, onRename, onClose, onDelete, onStop, onTerminal }: { session: SessionView | null; mode: ViewMode; onMode: (m: ViewMode) => void; onRename: () => void; onClose: () => void; onDelete: () => void; onStop: () => void; onTerminal: () => void }) {
  const pairs = usePairs();
  const agents = useAgents();
  const origin = useSession(session?.handoff_from ?? null);
  const verify = useSessionVerify(session);
  const followView = useFollowView();
  if (!session) {
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12.5px] font-medium text-fg-muted">
        <SessionSwitcher activeId={null} className="flex-1 text-[12.5px] font-medium text-fg-muted">
          <Bot className="size-3.5 shrink-0" />
          <span className="truncate">New session</span>
        </SessionSwitcher>
      </div>
    );
  }
  const pair = pairs.data?.find((p) => p.id === session.pair);
  const agent = session.agent ? agents.data?.find((a) => a.name === session.agent) : undefined;
  const total = session.tokens.input + session.tokens.output;
  const resume = terminalResume(session);
  const trace = mode === "trace";
  return (
    <div className="shrink-0 border-b border-line px-3 py-1.5">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 max-w-full text-[13px] font-medium">
          <SessionSwitcher activeId={session.id} title={`${session.title} (double-click to rename)`} onDoubleClick={onRename}>
            <StatusDot status={session.status} size={8} />
            <span className="truncate">{session.title}</span>
          </SessionSwitcher>
        </h2>
        <span className="flex-1" />
        <NewSessionButton />
        {(session.mode === "ask" || session.mode === "plan") && <ModeBadge mode={session.mode} />}
        <VerifyToggle session={session} verify={verify} />
        <div role="tablist" aria-label="View" className="flex shrink-0 items-center gap-0.5 rounded-md bg-raised p-0.5">
          {(["chat", "trace"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} data-view-mode={m} onClick={() => onMode(m)} title={`${m === "chat" ? "Chat" : "Trace"} view (${isMac ? "⌘" : "Ctrl"}.)`} className={cn("h-5 rounded px-2 text-[11px] font-medium capitalize outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent", mode === m ? "bg-panel text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg")}>
              {m}
            </button>
          ))}
        </div>
        <DropdownMenu
          align="end"
          entries={[
            { label: "Interrupt", icon: <Square />, onSelect: onStop, disabled: session.status !== "running" },
            // Resuming interactively while a turn runs would put two writers on one engine session, so it waits for idle.
            { label: "Continue in terminal", icon: <SquareTerminal />, onSelect: onTerminal, disabled: !resume.enabled, shortcut: resume.enabled ? undefined : session.status === "running" ? "when idle" : undefined },
            { label: "Hand off…", icon: <ArrowRightLeft />, onSelect: () => openHandoff(session.id), disabled: session.depth > 0 || session.status === "closed" },
            { separator: true },
            { label: "Run checks now", icon: <Play />, onSelect: () => verify.run.mutate(), disabled: !verify.canRun },
            { label: "Verification settings…", icon: <ShieldCheck />, onSelect: openVerifySettings },
            { label: "Always attach what's in view", icon: <Eye />, checked: followView, onSelect: () => setFollowView(!followView) },
            { separator: true },
            { label: "Rename…", icon: <Pencil />, onSelect: onRename },
            { label: "Copy session id", icon: <ClipboardCopy />, onSelect: () => void navigator.clipboard.writeText(session.id).then(() => toast.success(`Copied ${session.id}`)) },
            { separator: true },
            { label: "Close session", icon: <XCircle />, onSelect: onClose, disabled: session.status === "closed" },
            { label: "Delete closed session…", icon: <Trash2 />, danger: true, onSelect: onDelete, disabled: session.status !== "closed" },
          ]}
          trigger={
            <button aria-label="Session actions" title={resume.enabled ? "Session actions" : (resume.reason ?? "Session actions")} className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover">
              <MoreHorizontal className="size-4" />
            </button>
          }
        />
      </div>
      {session.waiting_on?.length ? <WaitingChip session={session} className="mt-1 ml-4" /> : null}
      {session.handoff_from && (
        <button data-lineage onClick={() => openSession(session.handoff_from!)} title="Open the session this one continues" className="mt-0.5 flex max-w-full items-center gap-1 truncate pl-4 text-left text-[11px] text-fg-faint outline-none transition-colors hover:text-fg-muted focus-visible:text-fg-muted">
          <ArrowRightLeft className="size-3 shrink-0" />
          <span className="truncate">continued from {origin.data?.session.title ?? session.handoff_from}</span>
        </button>
      )}
      {trace && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone="accent">
            <EngineIcon engine={session.engine} className="size-3" />
            {showsModelMark(session.engine, session.model) && <ModelIcon model={session.model} engine={session.engine} className="size-3" />}
            {session.engine}
            {session.model ? ` · ${session.model}` : ""}
          </Badge>
          {session.effort && <Badge>{session.effort}</Badge>}
          {pair && (
            <Badge tone="violet" title={`Hydra pair: ${pair.title}`}>
              <Network className="size-2.5" />
              {pair.title}
            </Badge>
          )}
          {session.agent && (
            <Tooltip label={<span className="block max-w-[260px]">{agent?.description || agent?.title || session.agent}</span>} side="bottom">
              <span>
                <Badge tone="blue">
                  <UserRoundCog className="size-2.5" />
                  {agent?.title ?? session.agent}
                </Badge>
              </span>
            </Tooltip>
          )}
          {session.skills && (
            <Tooltip label={<span className="block max-w-[260px] font-mono">{session.skills.length ? session.skills.join(", ") : "No skills"}</span>} side="bottom">
              <span>
                <Badge>
                  <BookOpen className="size-2.5" />
                  {session.skills.length} skill{session.skills.length === 1 ? "" : "s"}
                </Badge>
              </span>
            </Tooltip>
          )}
          {session.isolation === "worktree" && session.branch && (
            <Badge tone="green" title={`Isolated worktree on ${session.branch}`}>
              <GitBranch className="size-2.5" />
              {session.branch}
            </Badge>
          )}
          <span className="flex-1" />
          {total > 0 && (
            <span className="font-mono text-[10.5px] text-fg-faint" title={`${session.tokens.input} in / ${session.tokens.output} out / ${session.tokens.cache_read} cached`}>
              {tokens(session.tokens.input)} in · {tokens(session.tokens.output)} out
            </span>
          )}
          {session.cost_usd ? <span className="font-mono text-[10.5px] text-fg-muted">{money(session.cost_usd)}</span> : null}
        </div>
      )}
    </div>
  );
}

/** How many of a session's own messages the transcript holds. */
const userMessages = (items: TranscriptItem[], session: string) => items.filter((i) => i.type === "user" && i.session === session).length;

/** Stands in for the session id until a new session has one. */
const NEW_SESSION = "__new";

/** A message sent but not yet in the transcript: `baseline` is how many of the session's user messages were there when it went out. */
interface PendingSend {
  sid: string;
  text: string;
  baseline: number;
}

export function AgentPanel() {
  const qc = useQueryClient();
  const ws = useWs();
  const setActiveSession = useUi((s) => s.setActiveSession);
  const sid = ws.activeSession;
  const detail = useSession(sid);
  const stream = useSessionStream(sid, { tree: true });
  const online = useDaemonOnline();
  const [pending, setPending] = useState<PendingSend | null>(null);

  useEffect(() => {
    registerAgentCommands();
    ensureTurnWatcher();
  }, []);

  // The pending message ends when the transcript has it, or when the session it was sent to is left.
  useEffect(() => {
    if (!pending) return;
    if (pending.sid !== (sid ?? NEW_SESSION)) setPending(null);
    else if (userMessages(stream.transcript.items, sid ?? "") > pending.baseline) setPending(null);
  }, [pending, sid, stream.transcript.items]);

  // A queued message going out (Send now, Enter on an empty composer, a turn ending) shows in the thread at once too.
  const live = useRef({ sid, items: stream.transcript.items });
  live.current = { sid, items: stream.transcript.items };
  useEffect(() => {
    const offStart = bus.on("queue-send-start", ({ sessionId, text }) => {
      if (sessionId === live.current.sid) setPending({ sid: sessionId, text, baseline: userMessages(live.current.items, sessionId) });
    });
    const offFail = bus.on("queue-send-fail", ({ sessionId }) => setPending((p) => (p && p.sid === sessionId ? null : p)));
    return () => {
      offStart();
      offFail();
    };
  }, []);

  // Drafts are kept per workspace and session (and survive the panel unmounting and a reload), so switching away and back does not lose a half-written message.
  const key = draftKey(useUi((s) => s.current), sid);
  const [draft, setDraftState] = useState(() => drafts.get(key));
  useEffect(() => setDraftState(drafts.get(key)), [key]);
  const setDraft = useCallback(
    (v: string) => {
      drafts.set(key, v);
      setDraftState(v);
    },
    [key],
  );

  // Chat or Trace: remembered per session, and the last choice becomes the default for sessions opened later.
  const [mode, setModeState] = useState<ViewMode>(() => loadViewMode(sid));
  useEffect(() => setModeState(loadViewMode(sid)), [sid]);
  const setMode = useCallback(
    (m: ViewMode) => {
      setModeState(m);
      saveViewMode(sid, m);
    },
    [sid],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ".") {
        e.preventDefault();
        setMode(otherMode(mode));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, setMode]);
  const headActions = useHeadActions();

  // A session that no longer exists (deleted elsewhere) must not leave the panel stuck on it.
  useEffect(() => {
    if (sid && detail.error instanceof ApiError && detail.error.status === 404) setActiveSession(null);
  }, [sid, detail.error, setActiveSession]);

  const view = detail.data?.session ?? null;
  const children = detail.data?.children ?? [];
  const here = pending && pending.sid === (sid ?? NEW_SESSION) ? pending : null;
  const liveStatus = sid ? stream.status[sid] : undefined;
  const status = liveStatus ?? view?.status;
  const running = status === "running";
  // The turns table, refetched whenever the session's state changes (the global stream invalidates ["session", id]).
  // The streamed copy only refreshes when a turn starts, so it would still call a finished turn "running".
  const turns = useQuery({ queryKey: [...qk.session(sid ?? ""), "turns"], enabled: !!sid, queryFn: () => get<{ turns: TurnRow[] }>(url.session(sid!, "turns")).then((r) => r.turns), staleTime: 1000 });
  const lastTurn = turns.data?.[turns.data.length - 1] ?? stream.turns[stream.turns.length - 1];

  const labels: SessionLabels = useMemo(() => {
    const out: SessionLabels = {};
    if (view) out[view.id] = { label: view.role ?? view.engine, depth: view.depth };
    for (const c of children) out[c.id] = { label: c.role ?? c.engine, depth: c.depth };
    return out;
  }, [view, children]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    if (sid) void qc.invalidateQueries({ queryKey: qk.session(sid) });
  };

  const stop = useMutation({ mutationFn: () => post(url.session(sid!, "interrupt")), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const retry = useMutation({
    mutationFn: () => post(url.session(sid!, "send"), { message: lastTurn?.prompt ?? "Continue." }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const rename = async () => {
    if (!view) return;
    const title = await ask({ title: "Rename session", label: "Title", initial: view.title, confirmLabel: "Rename", validate: (v) => (v.trim() ? null : "A title is required") });
    if (title === null) return;
    try {
      await api("PATCH", url.session(view.id), { title });
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const closeSession = async () => {
    if (!view) return;
    const heads = children.filter((c) => c.status !== "closed").length;
    const ok = await confirm({
      title: "Close this session?",
      description: heads > 0 ? `Its ${heads} head${heads === 1 ? "" : "s"} will be closed too. Unmerged work stays on its branch.` : "Its workspace is cleaned up. Unmerged work in a worktree stays on its branch.",
      confirmLabel: "Close session",
    });
    if (!ok) return;
    try {
      await post(url.session(view.id, "close"));
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const deleteSession = async () => {
    if (!view) return;
    const ok = await confirm({ title: "Delete this session?", description: "Its transcript and records are removed. This cannot be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api("DELETE", url.session(view.id));
      drafts.dropSession(view.id);
      setActiveSession(null);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const openTerminal = async () => {
    if (!view || !terminalResume(view).enabled) return;
    try {
      const r = await post<{ terminal: TerminalInfo }>("/api/terminals", { root: view.id, resumeSession: view.id });
      useUi.getState().setBottomTab("terminal");
      window.dispatchEvent(new CustomEvent("trb:terminals-changed", { detail: { focus: r.terminal.id } }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const openHeads = children.filter((c) => c.status !== "closed");
  const footer =
    view && !running ? (
      <div className="flex flex-col gap-2">
        {status === "failed" ? <FailureCard session={view} onRetry={() => retry.mutate()} retrying={retry.isPending} /> : view.turns > 0 && lastTurn && lastTurn.status !== "running" ? <TurnSummary session={view} turn={lastTurn} heads={openHeads} /> : null}
      </div>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header session={view ? { ...view, status: status ?? view.status } : null} mode={mode} onMode={setMode} onRename={rename} onClose={closeSession} onDelete={deleteSession} onStop={() => stop.mutate()} onTerminal={openTerminal} />
      {!online && (
        <div role="status" className="flex shrink-0 animate-slide-up items-center gap-2 border-b border-amber/30 bg-amber/10 px-3 py-1.5 text-[11.5px] text-amber">
          <WifiOff className="size-3.5" /> The daemon is not answering. Reconnecting…
        </div>
      )}
      {!sid && !here ? (
        <EmptyAgent onPick={(t) => setDraft(t)} />
      ) : !sid || !stream.ready || (!view && detail.isLoading) ? (
        here ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[760px] flex-col px-4 py-4">
              <PendingTurn text={here.text} />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-3 p-4">
            <Skeleton className="ml-auto h-9 w-2/3" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-10 w-full" />
          </div>
        )
      ) : (
        <ThreadActionsProvider sessionId={sid} running={running} closed={(status ?? view?.status) === "closed"}>
          <FileLinkScope session={view} items={stream.transcript.items} running={running}>
            {mode === "chat" ? (
              <ChatThread items={stream.transcript.items} focusSession={sid} heads={children} running={running} pending={here} error={view?.error} failed={status === "failed"} onRetry={() => retry.mutate()} retrying={retry.isPending} onOpenHead={(h) => headActions.open(h)} onMergeHead={(h) => void headActions.merge(h)} />
            ) : (
              <Transcript items={stream.transcript.items} labels={labels} focusSession={sid} running={running} footer={footer} />
            )}
          </FileLinkScope>
          {/* Inside the provider: an opportunity chip can fork the thread from the turn that suggested it. */}
          <NextSteps
            turn={lastTurn}
            hidden={running || status === "failed" || status === "closed" || draft.trim().length > 0}
            onPick={(text) => {
              setDraft(text);
              bus.emit("focus-composer");
            }}
          />
        </ThreadActionsProvider>
      )}
      {mode === "trace" && running && view && <RunStrip session={view} items={stream.transcript.items} heads={children} turn={lastTurn} onStop={() => stop.mutate()} />}
      <Composer
        shelf={shelfFor(view, children)}
        onOpenHead={(id) => {
          const h = children.find((c) => c.id === id);
          if (h) headActions.open(h);
        }}
        session={view}
        running={running}
        sending={!!here && !!sid}
        draft={draft}
        setDraft={setDraft}
        onStarted={(id) => {
          // The new session takes over the pending message; its transcript has no user message yet.
          setPending((p) => (p && p.sid === NEW_SESSION ? { ...p, sid: id, baseline: 0 } : p));
          setActiveSession(id);
          refresh();
        }}
        onNewSession={startNewSession}
        onSendStart={(text) => setPending({ sid: sid ?? NEW_SESSION, text, baseline: userMessages(stream.transcript.items, sid ?? "") })}
        onSendFail={() => setPending(null)}
      />
    </div>
  );
}
