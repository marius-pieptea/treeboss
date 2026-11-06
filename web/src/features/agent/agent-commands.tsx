/**
 * Palette commands for the agent. Registered once for the page's life (not tied to a component): the panel is
 * unmounted whenever the Heads tab is showing, and "New session" should still work then.
 */
import { Bot, ClipboardCopy, Hammer, ClipboardList, MessageCircleQuestion, MessageSquarePlus, Minimize2, Square, TextCursorInput, ArrowRightLeft, Gauge, TreePine } from "lucide-react";
import { toast } from "sonner";
import { useCommandStore, type Command } from "@/lib/commands";
import { bus } from "@/lib/bus";
import { get, post, url } from "@/lib/api";
import { qk, queryClient } from "@/lib/queries";
import { useUi } from "@/lib/store";
import type { SessionDetail, SessionView } from "@/lib/types";
import { setSessionTreeboss } from "./TreebossControl";
import { sessionTreeboss } from "./treeboss-logic";
import { openHandoff } from "./HandoffDialog";

const activeSessionId = (): string | null => {
  const s = useUi.getState();
  return s.current ? (s.byWs[s.current]?.activeSession ?? null) : null;
};

export function startNewSession(): void {
  const ui = useUi.getState();
  ui.setActiveSession(null);
  ui.setRightTab("agent");
  setTimeout(() => bus.emit("focus-composer"), 40);
}

export function openSession(id: string): void {
  const ui = useUi.getState();
  ui.setActiveSession(id);
  ui.setRightTab("agent");
}

function sessionsInCache(): SessionView[] {
  const ws = useUi.getState().current;
  if (!ws) return [];
  const seen = new Map<string, SessionView>();
  // The prefix also matches the closed-sessions infinite query ({ pages }), so only array entries are session lists.
  for (const [, data] of queryClient.getQueriesData<SessionView[]>({ queryKey: qk.sessions(ws) })) if (Array.isArray(data)) for (const s of data) if (s.depth === 0) seen.set(s.id, s);
  return [...seen.values()].filter((s) => s.status !== "closed");
}

function build(): Command[] {
  const base: Command[] = [
    { id: "agent-new", group: "Agent", title: "New session", icon: <MessageSquarePlus />, keywords: "chat start", run: startNewSession },
    { id: "agent-ask", group: "Agent", title: "Ask a quick question…", icon: <MessageCircleQuestion />, keywords: "ask question mode read-only cheap", run: () => { startNewSession(); setTimeout(() => bus.emit("composer-mode", { mode: "ask" }), 60); } },
    { id: "agent-mode-build", group: "Agent", title: "Mode: Build", icon: <Hammer />, keywords: "mode build edit", run: () => bus.emit("composer-mode", { mode: "build" }) },
    { id: "agent-mode-plan", group: "Agent", title: "Mode: Plan", icon: <ClipboardList />, keywords: "mode plan read-only", run: () => bus.emit("composer-mode", { mode: "plan" }) },
    { id: "agent-mode-ask", group: "Agent", title: "Mode: Ask", icon: <MessageCircleQuestion />, keywords: "mode ask question read-only cheap", run: () => bus.emit("composer-mode", { mode: "ask" }) },
    {
      id: "agent-treeboss",
      group: "Agent",
      title: "Toggle treeboss mode",
      icon: <TreePine />,
      keywords: "treeboss tree boss triage design docs specs roadmap opinionated",
      when: () => {
        const id = activeSessionId();
        const s = id ? queryClient.getQueryData<SessionDetail>(qk.session(id))?.session : null;
        return !!s && s.status !== "closed";
      },
      run: async () => {
        const id = activeSessionId();
        const s = id ? queryClient.getQueryData<SessionDetail>(qk.session(id))?.session : null;
        if (!id || !s) return;
        await setSessionTreeboss(id, !sessionTreeboss(s)).then((on) => toast.success(on ? "Treeboss mode on" : "Treeboss mode off")).catch((e: Error) => toast.error(e.message));
      },
    },
    { id: "agent-model", group: "Agent", title: "Switch model…", icon: <Gauge />, keywords: "model switch change effort next turn", run: () => bus.emit("model-switch") },
    { id: "agent-focus", group: "Agent", title: "Focus the message box", icon: <TextCursorInput />, run: () => bus.emit("focus-composer") },
    {
      id: "agent-interrupt",
      group: "Agent",
      title: "Stop the running turn",
      icon: <Square />,
      when: () => {
        const id = activeSessionId();
        return !!id && queryClient.getQueryData<SessionDetail>(qk.session(id))?.session.status === "running";
      },
      run: async () => {
        const id = activeSessionId();
        if (id) await post(url.session(id, "interrupt")).catch((e: Error) => toast.error(e.message));
      },
    },
    {
      id: "agent-switch-engine",
      group: "Agent",
      title: "Continue with another engine…",
      icon: <ArrowRightLeft />,
      keywords: "switch harness engine claude codex cursor continue hydra pair summary",
      when: () => {
        const id = activeSessionId();
        const s = id ? queryClient.getQueryData<SessionDetail>(qk.session(id))?.session : null;
        return !!s && s.depth === 0 && s.status !== "closed";
      },
      run: async () => {
        const id = activeSessionId();
        if (id) openHandoff(id, "switch");
      },
    },
    {
      id: "agent-handoff",
      group: "Agent",
      title: "Hand off to a fresh session…",
      icon: <ArrowRightLeft />,
      keywords: "summary continue new context compact",
      when: () => {
        const id = activeSessionId();
        const s = id ? queryClient.getQueryData<SessionDetail>(qk.session(id))?.session : null;
        return !!s && s.depth === 0 && s.status !== "closed";
      },
      run: () => {
        const id = activeSessionId();
        if (id) openHandoff(id);
      },
    },
    {
      id: "agent-compact",
      group: "Agent",
      title: "Compact the context",
      icon: <Minimize2 />,
      keywords: "context window summarize",
      when: () => {
        const id = activeSessionId();
        const s = id ? queryClient.getQueryData<SessionDetail>(qk.session(id))?.session : null;
        return !!s?.can_compact && s.status === "idle";
      },
      run: async () => {
        const id = activeSessionId();
        if (id) await post(url.session(id, "compact")).then(() => toast.success("Compacting…")).catch((e: Error) => toast.error(e.message));
      },
    },
    {
      id: "agent-copy",
      group: "Agent",
      title: "Copy the last answer",
      icon: <ClipboardCopy />,
      when: () => !!activeSessionId(),
      run: async () => {
        const id = activeSessionId();
        if (!id) return;
        const d = await get<SessionDetail>(url.session(id)).catch(() => null);
        if (!d?.session.output) return void toast.message("Nothing to copy yet");
        await navigator.clipboard.writeText(d.session.output);
        toast.success("Copied the last answer");
      },
    },
  ];
  const switchTo: Command[] = sessionsInCache()
    .slice(0, 30)
    .map((s) => ({ id: `agent-open-${s.id}`, group: "Switch session", title: s.title, icon: s.status === "running" ? <Bot className="text-accent" /> : <ArrowRightLeft />, keywords: `${s.engine} ${s.id}`, run: () => openSession(s.id) }));
  return [...base, ...switchTo];
}

let registered = false;
export function registerAgentCommands(): void {
  if (registered) return;
  registered = true;
  const apply = () => useCommandStore.getState().set("agent", build());
  apply();
  // "Switch session" lists whatever the sessions queries last returned.
  let t: ReturnType<typeof setTimeout> | null = null;
  queryClient.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.query.queryKey[0] !== "sessions") return;
    if (t) clearTimeout(t);
    t = setTimeout(apply, 150);
  });
  useUi.subscribe((s, prev) => {
    if (s.current !== prev.current) apply();
  });
}
