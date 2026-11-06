import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Bot, Globe, Hand, Plus, Power, RotateCw, X, Zap } from "lucide-react";
import { useWs, type Tab } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Empty, Spinner } from "@/components/ui/misc";
import { usePorts, previewUrl } from "../terminal/usePorts";
import { accumulateWheel, keyAction, placePicture, statusLine, toBoxPoint, toPagePoint } from "./agent-logic";
import { useAgentBrowser, useBrowserStatus, type BrowserInputMsg } from "./agent-api";
import { ModeSwitch } from "./ModeSwitch";

/**
 * The agent's browser, live. What the page looks like is a picture the daemon renders; clicking, scrolling and
 * typing on it are sent to the real page, so the operator can take over at any moment and hand back by simply
 * stopping. A status line says who is driving.
 */
export function AgentBrowser({ tab }: { tab: Extract<Tab, { kind: "browser" }> }) {
  const { workspace } = useWorkspace();
  const ws = useWs();
  const sessionId = ws.activeSession;
  const status = useBrowserStatus();
  const { state, open, frame, send, close, loading } = useAgentBrowser(sessionId);
  const { ports } = usePorts(workspace.path, false);

  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const url = state?.url ?? "";
  useEffect(() => {
    if (!editing) setAddress(url === "about:blank" ? "" : url);
  }, [url, editing]);

  // The picture's box only exists once a page is open, so it is measured through a callback ref: a ref
  // attached at mount (useElementSize) would miss an element that appears later.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const setBoxNode = useCallback((n: HTMLDivElement | null) => {
    boxRef.current = n;
    setBoxEl(n);
  }, []);
  useEffect(() => {
    if (!boxEl) return;
    const ro = new ResizeObserver(([e]) => setBox({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(boxEl);
    return () => ro.disconnect();
  }, [boxEl]);
  const page = useMemo(() => ({ width: state?.width ?? 1280, height: state?.height ?? 800 }), [state?.width, state?.height]);
  const st = statusLine(state);
  const [focused, setFocused] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  /* ---- take-over: pointer, wheel, keyboard ---------------------------------------------------------- */

  const pointerToPage = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return null;
      return toPagePoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, page);
    },
    [boxRef, page],
  );

  const onClick = (e: React.MouseEvent) => {
    boxRef.current?.focus();
    const p = pointerToPage(e);
    if (!p) return;
    const bp = toBoxPoint(p, { width: box.width, height: box.height }, page);
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: bp.x, y: bp.y }]);
    setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 700);
    void send({ kind: "click", x: p.x, y: p.y, double: e.detail === 2 });
  };

  // Typed characters and wheel movement are batched: one request per burst, in order.
  const typing = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  const flushTyping = useCallback(() => {
    const t = typing.current;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (t.text) {
      const text = t.text;
      t.text = "";
      void send({ kind: "type", text });
    }
  }, [send]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a.kind === "type") {
      typing.current.text += a.text;
      if (!typing.current.timer) typing.current.timer = setTimeout(flushTyping, 60);
    } else {
      flushTyping();
      void send({ kind: "key", key: a.key });
    }
  };

  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null }>({ dx: 0, dy: 0, x: 0, y: 0, timer: null });
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !open) return;
    const on = (e: WheelEvent) => {
      const p = pointerToPage(e);
      if (!p) return;
      e.preventDefault();
      const w = wheel.current;
      const acc = accumulateWheel({ dx: w.dx, dy: w.dy }, e, page.height);
      w.dx = acc.dx;
      w.dy = acc.dy;
      w.x = p.x;
      w.y = p.y;
      if (!w.timer)
        w.timer = setTimeout(() => {
          const out: BrowserInputMsg = { kind: "scroll", dx: Math.round(w.dx), dy: Math.round(w.dy), x: w.x, y: w.y };
          w.dx = w.dy = 0;
          w.timer = null;
          void send(out);
        }, 70);
    };
    // Not passive: scrolling the picture must not also scroll the app.
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [boxRef, open, pointerToPage, page.height, send]);

  /* ---- render ----------------------------------------------------------------------------------------- */

  const placed = placePicture({ width: box.width, height: box.height }, page);
  const tabs = state?.tabs ?? [];
  const chromeMissing = status.data && !status.data.available;
  const disabled = status.data && status.data.available && !status.data.enabled;

  const toolbar = (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <ModeSwitch tab={tab} mode="agent" className="mr-1" />
      <IconButton label="Back" size="icon-sm" disabled={!open} onClick={() => void send({ kind: "back" })}>
        <ArrowLeft />
      </IconButton>
      <IconButton label="Reload" size="icon-sm" disabled={!open} onClick={() => void send({ kind: "reload" })}>
        <RotateCw className={cn(state?.busy && "animate-spin-fast")} />
      </IconButton>
      <form
        className="relative min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void send({ kind: "navigate", url: address.trim() });
          setEditing(false);
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
        <Input
          value={address}
          disabled={!sessionId}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setEditing(false);
              setAddress(url === "about:blank" ? "" : url);
              e.currentTarget.blur();
            }
          }}
          placeholder="Type an address to open it in the agent's browser"
          spellCheck={false}
          aria-label="Agent browser address"
          className="h-7 pl-8 font-mono text-xs"
        />
      </form>
      <IconButton label="Close the agent's browser" size="icon-sm" disabled={!open} onClick={() => void close()}>
        <Power />
      </IconButton>
      {state?.busy && <div className="sweep absolute inset-x-0 bottom-0 h-[2px] bg-accent/20" />}
    </div>
  );

  const tabStrip = open && tabs.length > 0 && (
    <div role="tablist" className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-bg px-1 [scrollbar-width:none]">
      {tabs.map((t) => (
        <div
          key={t.index}
          role="tab"
          aria-selected={t.active}
          onClick={() => void send({ kind: "select_tab", index: t.index })}
          className={cn("group relative flex max-w-[200px] cursor-default items-center gap-1.5 rounded-t-md px-2.5 text-[11.5px] outline-none transition-colors", t.active ? "bg-panel text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
        >
          {t.active && <span className="absolute inset-x-1 top-0 h-px bg-accent" />}
          <span className="truncate">{t.title || t.url.replace(/^https?:\/\//, "") || "New tab"}</span>
          {tabs.length > 1 && (
            <button
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                void send({ kind: "close_tab", index: t.index });
              }}
              className="flex size-4 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      <button aria-label="New tab" onClick={() => void send({ kind: "new_tab" })} className="my-auto ml-1 flex size-5 items-center justify-center rounded text-fg-faint outline-none hover:bg-hover hover:text-fg">
        <Plus className="size-3.5" />
      </button>
    </div>
  );

  const statusStrip = (
    <div className="relative flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-line bg-bg px-3 text-[11.5px]">
      <span
        className={cn(
          "flex h-[18px] items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium leading-none",
          st.tone === "agent" && "border-accent/30 bg-accent-soft text-accent",
          st.tone === "you" && "border-violet/30 bg-violet/10 text-violet",
          st.tone === "idle" && "border-line bg-raised text-fg-faint",
        )}
      >
        {st.tone === "you" ? <Hand className="size-2.5" /> : st.tone === "agent" ? <Bot className="size-2.5" /> : <span className="size-1.5 rounded-full bg-fg-faint" />}
        {st.tone === "you" ? "You" : st.tone === "agent" ? "Agent" : "Idle"}
      </span>
      <span className={cn("truncate", st.busy ? "text-fg" : "text-fg-muted")}>{st.text}</span>
      {state?.busy && <div className="sweep pointer-events-none absolute inset-0" />}
      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fg-faint">
        {open && (state?.consoleErrors ? <span className="mr-3 text-red">{state.consoleErrors} console error{state.consoleErrors === 1 ? "" : "s"}</span> : null)}
        {open && `${page.width}×${page.height}`}
      </span>
    </div>
  );

  let body: React.ReactNode;
  if (chromeMissing) {
    body = (
      <Empty
        icon={<AlertTriangle />}
        title="Chrome was not found"
        hint={status.data?.hint ?? "Install Google Chrome, or set TRB_CHROME to a Chromium executable, then restart the daemon."}
        className="[&_svg]:text-amber"
      />
    );
  } else if (disabled) {
    body = <Empty icon={<Power />} title="The agent browser is turned off" hint="Turn it on with `trb config set agent_browser on`, or in Settings." />;
  } else if (!sessionId) {
    body = <Empty icon={<Bot />} title="Start or pick a session" hint="The agent browser belongs to a session. Open one in the Agent panel, then ask it to open a page." />;
  } else if (loading) {
    body = (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  } else if (!open) {
    body = (
      <Empty
        icon={<Globe />}
        title="No page open yet"
        hint="Ask the agent to open a page, or open one yourself."
        action={
          <div className="flex w-full max-w-sm flex-col items-center gap-2">
            <form
              className="flex w-full gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (address.trim()) void send({ kind: "navigate", url: address.trim() });
              }}
            >
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="localhost:3000" spellCheck={false} className="font-mono text-xs" aria-label="Address to open" />
              <Button type="submit" variant="primary" disabled={!address.trim()}>
                Open
              </Button>
            </form>
            {ports.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {ports.map((p) => (
                  <Button key={p.port} size="sm" variant="outline" onClick={() => void send({ kind: "navigate", url: previewUrl(p.port) })}>
                    <Zap className="text-accent" /> :{p.port}
                  </Button>
                ))}
              </div>
            )}
          </div>
        }
      />
    );
  } else {
    body = (
      <div
        ref={setBoxNode}
        tabIndex={0}
        role="application"
        aria-label="Agent browser. Click the page, then type to take over."
        onFocus={() => setFocused(true)}
        onBlur={() => {
          flushTyping();
          setFocused(false);
        }}
        onKeyDown={onKeyDown}
        className={cn("relative size-full cursor-default select-none outline-none", focused && "ring-1 ring-inset ring-accent/40")}
      >
        {frame ? (
          <>
            <img src={frame.url} alt={state?.title ? `Agent browser: ${state.title}` : "Agent browser"} draggable={false} onClick={onClick} onDoubleClick={undefined} className="absolute select-none bg-white shadow-pop" style={{ left: placed.x, top: placed.y, width: placed.width, height: placed.height }} />
            {ripples.map((r) => (
              <span key={r.id} className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-pop rounded-full border-2 border-violet bg-violet/20" style={{ left: r.x, top: r.y }} />
            ))}
            {state?.busy && state.actor === "agent" && <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent/60 animate-pulse" />}
          </>
        ) : (
          <div className="flex size-full items-center justify-center">
            <Spinner className="size-5" />
          </div>
        )}
        {!focused && frame && <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-line bg-overlay/90 px-3 py-1 text-[11px] text-fg-muted shadow-pop animate-slide-up">Click the page to take over</div>}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      {toolbar}
      {tabStrip}
      {statusStrip}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle,var(--line)_1px,transparent_1px)] [background-size:16px_16px]">{body}</div>
    </div>
  );
}
