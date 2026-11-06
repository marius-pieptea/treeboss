import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, ClipboardCopy, Eraser, GitBranch, Minus, Plus, RotateCcw, Search, SquareTerminal, X, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";
import { bus } from "@/lib/bus";
import { useRegisterCommands, type Command } from "@/lib/commands";
import { useSession } from "@/lib/queries";
import { useUi, useWs } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import type { TerminalInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IconButton, Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Input } from "@/components/ui/form";
import { Empty, Spinner } from "@/components/ui/misc";
import { ask } from "@/components/ui/dialogs";
import { PortsChip, openPreview } from "./PortsChip";
import { TerminalView, type ConnState } from "./TerminalView";
import { termHandles } from "./handles";
import { newPorts, rootLabel, MAX_FONT, MIN_FONT } from "./logic";
import { useTermPrefs } from "./prefs";
import { usePorts, previewUrl } from "./usePorts";
import { titleFor } from "../browser/logic";

const KEY = ["terminals"] as const;
/** Other panels dispatch this after creating a terminal (detail: { focus?: terminalId }). */
export const TERMINALS_CHANGED = "trb:terminals-changed";

/** Ports seen so far this page load, so "a new server started" survives the dock being closed and reopened. */
const seenPorts = new Set<number>();
let seenInitial = false;

function FindBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cs, setCs] = useState(false);
  const [res, setRes] = useState({ index: -1, count: 0 });
  const run = (value: string, caseSensitive: boolean) => setRes(termHandles.get(id)?.find(value, caseSensitive) ?? { index: -1, count: 0 });
  useEffect(() => () => termHandles.get(id)?.clearFind(), [id]);
  return (
    <div className="absolute right-3 top-2 z-10 flex animate-slide-up items-center gap-1 rounded-lg border border-line-strong bg-overlay p-1 shadow-pop">
      <Input
        autoFocus
        value={q}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        className="h-6 w-44 text-xs"
        onChange={(e) => {
          setQ(e.target.value);
          run(e.target.value, cs);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") setRes(termHandles.get(id)?.findStep(e.shiftKey ? -1 : 1) ?? res);
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="min-w-12 text-center font-mono text-[10.5px] text-fg-faint">{q ? (res.count ? `${res.index + 1}/${res.count}` : "none") : ""}</span>
      <IconButton label="Match case" size="icon-xs" className={cn(cs && "bg-active text-fg")} onClick={() => { setCs(!cs); run(q, !cs); }}>
        <span className="font-mono text-[10px] font-bold">Aa</span>
      </IconButton>
      <IconButton label="Previous match" size="icon-xs" onClick={() => setRes(termHandles.get(id)?.findStep(-1) ?? res)}>
        <ChevronUp />
      </IconButton>
      <IconButton label="Next match" size="icon-xs" onClick={() => setRes(termHandles.get(id)?.findStep(1) ?? res)}>
        <ChevronDown />
      </IconButton>
      <IconButton label="Close find" size="icon-xs" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

export function TerminalPanel() {
  const { workspace, root } = useWorkspace();
  const ws = useWs();
  const theme = useUi((s) => s.theme);
  const session = useSession(ws.activeSession);
  const qc = useQueryClient();
  const { fontSize, setFontSize, allPorts } = useTermPrefs();
  const heads = useMemo(() => (session.data?.children ?? []).filter((c) => c.status !== "closed"), [session.data]);
  const roots = useMemo(() => new Set([root, ...(ws.activeSession ? [ws.activeSession] : []), ...(session.data?.children ?? []).map((c) => c.id)]), [root, ws.activeSession, session.data]);

  const list = useQuery({
    queryKey: KEY,
    queryFn: () => get<{ terminals: TerminalInfo[] }>("/api/terminals").then((r) => r.terminals),
    refetchInterval: 8000,
  });
  const terminals = useMemo(() => (list.data ?? []).filter((t) => roots.has(t.rootRef)), [list.data, roots]);

  const activeKey = `trb.terminal.active.${root}`;
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(activeKey));
  const [mounted, setMounted] = useState<Set<string>>(new Set());
  const [conn, setConn] = useState<Record<string, { state: ConnState; code?: number | null }>>({});
  const [finding, setFinding] = useState(false);
  const pendingFocus = useRef<string | null>(null);
  const autoCreated = useRef(false);

  const active = terminals.find((t) => t.id === activeId) ?? null;
  // Keep the selection valid: a killed terminal falls back to its neighbour.
  useEffect(() => {
    if (!terminals.length) return;
    if (pendingFocus.current && terminals.some((t) => t.id === pendingFocus.current)) {
      setActiveId(pendingFocus.current);
      pendingFocus.current = null;
    } else if (!terminals.some((t) => t.id === activeId)) setActiveId(terminals[terminals.length - 1].id);
  }, [terminals, activeId]);
  useEffect(() => {
    if (!active) return;
    try {
      localStorage.setItem(activeKey, active.id);
    } catch {}
    setMounted((m) => (m.has(active.id) ? m : new Set(m).add(active.id)));
  }, [active, activeKey]);
  // A closed terminal's view is gone; forget it.
  useEffect(() => {
    setMounted((m) => {
      const live = new Set([...m].filter((id) => terminals.some((t) => t.id === id)));
      return live.size === m.size ? m : live;
    });
  }, [terminals]);

  const create = useMutation({
    mutationFn: (o: { root: string; title?: string }) => post<{ terminal: TerminalInfo }>("/api/terminals", { root: o.root, cols: 110, rows: 28, title: o.title }),
    onSuccess: ({ terminal }) => {
      qc.setQueryData<TerminalInfo[]>(KEY, (old) => [...(old ?? []), terminal]);
      setActiveId(terminal.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const newTerminal = useCallback((r = root) => create.mutate({ root: r }), [create, root]);

  // Opening the dock with nothing in it gives you a shell, not an empty box.
  useEffect(() => {
    if (list.isSuccess && terminals.length === 0 && !autoCreated.current && !create.isPending) {
      autoCreated.current = true;
      newTerminal();
    }
  }, [list.isSuccess, terminals.length, create.isPending, newTerminal]);

  useEffect(() => {
    const on = (e: Event) => {
      pendingFocus.current = (e as CustomEvent).detail?.focus ?? null;
      void qc.invalidateQueries({ queryKey: KEY });
    };
    window.addEventListener(TERMINALS_CHANGED, on);
    return () => window.removeEventListener(TERMINALS_CHANGED, on);
  }, [qc]);
  useEffect(() => bus.on("toggle-terminal", () => useUi.getState().toggleBottom()), []);

  const close = useCallback(
    async (id: string) => {
      qc.setQueryData<TerminalInfo[]>(KEY, (old) => (old ?? []).filter((t) => t.id !== id));
      await del(`/api/terminals/${id}`).catch(() => {});
      void qc.invalidateQueries({ queryKey: KEY });
    },
    [qc],
  );
  const restart = useCallback(
    async (t: TerminalInfo) => {
      const { terminal } = await post<{ terminal: TerminalInfo }>("/api/terminals", { root: t.rootRef, cols: t.cols, rows: t.rows, title: t.title }).catch((e: Error) => {
        toast.error(e.message);
        return { terminal: null };
      });
      if (!terminal) return;
      qc.setQueryData<TerminalInfo[]>(KEY, (old) => [...(old ?? []).filter((x) => x.id !== t.id), terminal]);
      setActiveId(terminal.id);
      void del(`/api/terminals/${t.id}`).catch(() => {});
    },
    [qc],
  );
  const rename = useCallback(
    async (t: TerminalInfo) => {
      const title = await ask({ title: "Rename terminal", initial: t.title, confirmLabel: "Rename", validate: (v) => (v.trim() ? null : "A name is required") });
      if (!title) return;
      qc.setQueryData<TerminalInfo[]>(KEY, (old) => (old ?? []).map((x) => (x.id === t.id ? { ...x, title: title.trim() } : x)));
      await patch(`/api/terminals/${t.id}`, { title: title.trim() }).catch((e: Error) => toast.error(e.message));
    },
    [qc],
  );

  const onState = useCallback((id: string, state: ConnState, code?: number | null) => setConn((c) => (c[id]?.state === state && c[id]?.code === code ? c : { ...c, [id]: { state, code } })), []);

  // Dev servers: the chip, and a nudge when a new one appears in this workspace.
  const { ports, loaded } = usePorts(workspace.path, allPorts);
  useEffect(() => {
    if (!loaded) return;
    const fresh = seenInitial ? newPorts(seenPorts, ports) : [];
    for (const p of ports) seenPorts.add(p.port);
    seenInitial = true;
    for (const p of fresh) toast(`Dev server on :${p.port}`, { description: p.command, action: { label: "Open preview", onClick: () => openPreview(p.port) } });
  }, [ports, loaded]);

  const step = (dir: 1 | -1) => {
    if (!terminals.length) return;
    const i = terminals.findIndex((t) => t.id === activeId);
    setActiveId(terminals[(i + dir + terminals.length) % terminals.length].id);
  };
  const copyOutput = async () => {
    const ok = await termHandles.get(activeId)?.copyOutput();
    if (ok) toast.success("Terminal output copied");
    else toast.error("Could not copy (clipboard unavailable)");
  };
  const askPreview = async () => {
    const v = await ask({ title: "Open preview", label: "URL or port", placeholder: ":3000", confirmLabel: "Open" });
    if (v) useUi.getState().openTab({ kind: "browser", url: v.trim(), title: titleFor(v.trim()) });
  };

  const cmds: Command[] = [
    { id: "term-new", group: "Terminal", title: "New terminal", icon: <SquareTerminal />, run: () => newTerminal() },
    { id: "term-kill", group: "Terminal", title: "Kill terminal", icon: <X />, when: () => !!active, run: () => { if (active) void close(active.id); } },
    { id: "term-clear", group: "Terminal", title: "Clear terminal", icon: <Eraser />, when: () => !!active, run: () => termHandles.get(activeId)?.clear() },
    { id: "term-copy", group: "Terminal", title: "Copy terminal output", icon: <ClipboardCopy />, when: () => !!active, run: () => void copyOutput() },
    { id: "term-find", group: "Terminal", title: "Find in terminal", icon: <Search />, when: () => !!active, run: () => setFinding(true) },
    { id: "term-next", group: "Terminal", title: "Next terminal", run: () => step(1), when: () => terminals.length > 1 },
    { id: "term-prev", group: "Terminal", title: "Previous terminal", run: () => step(-1), when: () => terminals.length > 1 },
    { id: "term-zin", group: "Terminal", title: "Increase terminal font size", icon: <ZoomIn />, run: () => setFontSize(fontSize + 1) },
    { id: "term-zout", group: "Terminal", title: "Decrease terminal font size", icon: <ZoomOut />, run: () => setFontSize(fontSize - 1) },
    { id: "term-preview-url", group: "Terminal", title: "Open preview of a URL…", icon: <SquareTerminal />, run: () => void askPreview() },
    ...ports.map((p) => ({ id: `term-preview-${p.port}`, group: "Terminal", title: `Open preview: localhost:${p.port} (${p.command})`, keywords: previewUrl(p.port), run: () => openPreview(p.port) })),
  ];
  useRegisterCommands("terminal", cmds, [activeId, terminals.length, ports.map((p) => p.port).join(","), fontSize]);

  const newMenu = [
    { label: "Workspace root", icon: <SquareTerminal />, onSelect: () => newTerminal(root) },
    ...(heads.length ? [{ separator: true }] : []),
    ...heads.map((h) => ({ label: `${h.role ?? h.engine}: ${h.title}`.slice(0, 48), icon: <GitBranch />, onSelect: () => newTerminal(h.id), disabled: h.isolation !== "worktree" })),
  ];

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg pr-10">
        <div role="tablist" className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {terminals.map((t) => {
            const c = conn[t.id];
            const exited = !t.alive || c?.state === "exited";
            const label = rootLabel(t.rootRef, root, heads);
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeId}
                onClick={() => setActiveId(t.id)}
                onDoubleClick={() => void rename(t)}
                onAuxClick={(e) => e.button === 1 && void close(t.id)}
                className={cn("group relative flex max-w-[200px] shrink-0 cursor-default items-center gap-1.5 border-r border-line px-3 text-[12.5px] transition-colors animate-slide-right", t.id === activeId ? "bg-panel text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
              >
                <span className={cn("absolute inset-x-0 top-0 h-px origin-left bg-accent transition-transform duration-200", t.id === activeId ? "scale-x-100" : "scale-x-0")} />
                <span className={cn("size-1.5 shrink-0 rounded-full", exited ? "bg-fg-faint" : c?.state === "reconnecting" ? "bg-amber animate-pulse-dot" : "bg-green")} title={exited ? "exited" : (c?.state ?? "running")} />
                <span className="truncate">{t.title}</span>
                {label && <span className="rounded bg-raised px-1 font-mono text-[10px] text-violet">{label}</span>}
                <button aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); void close(t.id); }} className="-mr-1 flex size-4 items-center justify-center rounded text-fg-faint opacity-0 outline-none hover:bg-active hover:text-fg focus-visible:opacity-100 group-hover:opacity-100">
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <div className="flex items-center px-1">
            <IconButton label="New terminal" size="icon-sm" onClick={() => newTerminal()}>
              {create.isPending ? <Spinner /> : <Plus />}
            </IconButton>
            <DropdownMenu entries={newMenu} trigger={<button aria-label="Choose where to open a terminal" className="flex size-5 items-center justify-center rounded text-fg-faint outline-none hover:bg-hover hover:text-fg"><ChevronDown className="size-3" /></button>} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-2">
          <PortsChip ports={ports} workspacePath={workspace.path} />
          <span className="mx-0.5 h-4 w-px bg-line" />
          <IconButton label="Find in terminal" size="icon-sm" onClick={() => setFinding((f) => !f)} disabled={!active} className={cn(finding && "bg-active text-fg")}>
            <Search />
          </IconButton>
          <IconButton label="Copy output" size="icon-sm" onClick={() => void copyOutput()} disabled={!active}>
            <ClipboardCopy />
          </IconButton>
          <IconButton label="Clear" size="icon-sm" onClick={() => termHandles.get(activeId)?.clear()} disabled={!active}>
            <Eraser />
          </IconButton>
          <span className="mx-0.5 h-4 w-px bg-line" />
          <IconButton label="Smaller text" size="icon-sm" onClick={() => setFontSize(fontSize - 1)} disabled={fontSize <= MIN_FONT}>
            <Minus />
          </IconButton>
          <span className="w-5 text-center font-mono text-[10.5px] text-fg-faint">{fontSize}</span>
          <IconButton label="Larger text" size="icon-sm" onClick={() => setFontSize(fontSize + 1)} disabled={fontSize >= MAX_FONT}>
            <Plus />
          </IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {list.isLoading || (terminals.length === 0 && create.isPending) ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : terminals.length === 0 ? (
          <Empty icon={<SquareTerminal />} title="No terminals" hint="Open a shell in the workspace." action={<Button variant="primary" onClick={() => newTerminal()}><Plus /> New terminal</Button>} />
        ) : (
          terminals
            .filter((t) => mounted.has(t.id))
            .map((t) => (
              <div key={t.id} className={cn("absolute inset-0", t.id === activeId ? "" : "hidden")}>
                <TerminalView info={t} active={t.id === activeId} fontSize={fontSize} theme={theme} onState={onState} />
              </div>
            ))
        )}
        {finding && active && <FindBar key={active.id} id={active.id} onClose={() => { setFinding(false); termHandles.get(active.id)?.focus(); }} />}
        {active && (!active.alive || conn[active.id]?.state === "exited") && (
          <div className="absolute inset-x-0 bottom-0 z-10 flex animate-slide-up items-center gap-3 border-t border-line bg-overlay/95 px-3 py-2 text-xs backdrop-blur">
            <span className="text-fg-muted">
              <Check className="mr-1 inline size-3 text-fg-faint" />
              Process exited{conn[active.id]?.code != null ? ` with code ${conn[active.id]?.code}` : ""}.
            </span>
            <Button size="xs" variant="primary" onClick={() => void restart(active)}>
              <RotateCcw /> Restart
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void close(active.id)}>
              Close
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
