import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Bug, ClipboardCheck, Copy, ExternalLink, Globe, Laptop, Maximize2, Monitor, MousePointerClick, Play, RotateCw, RotateCcw, Smartphone, Tablet, TerminalSquare, ZoomIn, ZoomOut, Zap } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useUi, useWs, type Tab } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { useElementSize } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { DropdownMenu } from "@/components/ui/overlay";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { Empty } from "@/components/ui/misc";
import { freshPorts, usePorts, previewUrl } from "../terminal/usePorts";
import { DEVICES, clampZoom, computeFrame, defaultResponsiveWidth, followFrame, isLocationMessage, isStepMessage, normalizeUrl, pushStep, qaDock, resolvePath, stepLines, stepsSince, type BugPrefill, type TimedStep, reachability, titleFor, userFacingUrl, MIN_RESPONSIVE_W } from "./logic";
import { useBrowserPrefs } from "./prefs";
import { AgentBrowser } from "./AgentBrowser";
import { ModeSwitch } from "./ModeSwitch";
import { takeShot, type Shot } from "./capture";
import { LogBugDialog } from "./LogBugDialog";
import { isAgentUrl } from "./agent-logic";
import { RunPanel } from "../run/RunPanel";
import { QaPanel } from "../qa/QaPanel";
import { clearIssues, insertIntoComposer, openProxy, sendPick, useIssues, useRunInfo } from "../run/data";
import { errorCount, formatIssuesForComposer, isPickMessage, loopbackPort, previewTarget, proxiedUrl, runRoot } from "../run/logic";
// Registers the palette commands and the "an agent is using the browser" nudge as soon as the app loads.
import "./discover";

export { openBrowserTab } from "./discover";

type Phase = "idle" | "checking" | "loading" | "loaded" | "down" | "slow";

const DEVICE_ICON = { responsive: Maximize2, phone: Smartphone, tablet: Tablet, laptop: Laptop, desktop: Monitor } as const;

// A dev server on this machine may need scripts, forms and its own storage; nothing else. No top navigation,
// no pointer lock, no camera. It runs on a different origin than the app, so it cannot reach the app's session.
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

/** One tab, two views: a preview of a dev server (an iframe) or the agent's own browser, live. */
export function BrowserTab({ tab }: { tab: Extract<Tab, { kind: "browser" }> }) {
  return isAgentUrl(tab.url) ? <AgentBrowser tab={tab} /> : <PreviewBrowser tab={tab} />;
}

function PreviewBrowser({ tab }: { tab: Extract<Tab, { kind: "browser" }> }) {
  const { workspace, root } = useWorkspace();
  const updateTab = useUi((s) => s.updateTab);
  const { device: deviceId, rotated, zoom, fit, set: setPrefs } = useBrowserPrefs();
  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES[0];
  const ui = useMemo(() => ({ origin: location.origin, hostname: location.hostname, port: location.port }), []);
  const { ports } = usePorts(workspace.path, false);
  const qc = useQueryClient();

  const [paneRef, pane] = useElementSize<HTMLDivElement>();
  const [wrapRef, wrap] = useElementSize<HTMLDivElement>();
  const [hist, setHist] = useState<{ stack: string[]; i: number }>(() => {
    const first = tab.url ? normalizeUrl(tab.url, ui) : null;
    return first?.ok ? { stack: [first.url], i: 0 } : { stack: [], i: -1 };
  });
  const current = hist.i >= 0 ? hist.stack[hist.i] : null;
  // What the iframe is loaded with. It lags `current` when the page itself moved, so the frame is not reloaded under the user.
  const [frameUrl, setFrameUrl] = useState(current);
  const frameAt = useRef<string | null>(null);
  const [input, setInput] = useState(current ?? tab.url ?? "");
  const [error, setError] = useState<string | null>(tab.url && !current ? (normalizeUrl(tab.url, ui) as { error?: string }).error ?? null : null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [nonce, setNonce] = useState(0);
  const [respW, setRespW] = useState<number | null>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const navigate = useCallback(
    (raw: string, push = true) => {
      const r = normalizeUrl(raw, ui);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      setInput(r.url);
      setHist((h) => (push ? (h.stack[h.i] === r.url ? h : { stack: [...h.stack.slice(0, h.i + 1), r.url], i: h.i + 1 }) : h));
      updateTab(tab.id, { url: r.url, title: titleFor(r.url) });
      if (r.rewrittenHost) toast(`Opened as ${new URL(r.url).host}`, { description: "Previews use the other loopback name so the app's session cookie is never sent to your dev server." });
      if (hist.stack[hist.i] === r.url && push) {
        setFrameUrl(r.url);
        setNonce((n) => n + 1);
      }
    },
    [ui, updateTab, tab.id, hist],
  );

  // Run panel and Inspect mode (the proxy that adds element picking and console capture).
  const { inspect, runOpen, qaOpen } = useBrowserPrefs();
  const qaWidth = usePaneWidth("browser.qa", 320);
  const dock = qaDock(wrap.width);
  const ws = useWs();
  const runRef = runRoot(ws.activeSession, workspace.id);
  const runInfo = useRunInfo(runRef);
  const devTarget = previewTarget(runInfo.data?.instances ?? []);
  const wantOpen = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const targetPort = loopbackPort(current);
  const canInspect = targetPort !== null;
  const inspecting = inspect && canInspect;
  const [proxyPort, setProxyPort] = useState<{ target: number; port: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const issues = useIssues(targetPort, inspecting);
  const issueList = issues.data?.issues ?? [];
  // Loopback previews always go through the proxy: it is the only way to see the page's location from outside the frame.
  const frameSrc = !frameUrl ? null : canInspect ? (proxyPort && proxyPort.target === targetPort && loopbackPort(frameUrl) === targetPort ? proxiedUrl(frameUrl, proxyPort.port) : null) : frameUrl;

  useEffect(() => {
    if (!targetPort) return;
    let live = true;
    void openProxy(targetPort)
      .then((r) => live && setProxyPort({ target: targetPort, port: r.port }))
      .catch((e: Error) => toast.error(`Inspect: ${e.message}`));
    return () => {
      live = false;
    };
  }, [targetPort]);

  // The preview follows the dev server: when the operator started one from the Run panel, or when nothing is open yet.
  useEffect(() => {
    if (!devTarget?.url || devTarget.status !== "running") return;
    if (wantOpen.current || (!current && phase === "idle")) {
      wantOpen.current = false;
      navigate(devTarget.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devTarget?.key, devTarget?.status]);

  const stepsRef = useRef<TimedStep[]>([]);
  // Messages from the injected script. Only the preview frame's own window is believed.
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (isLocationMessage(e.data)) {
        if (!proxyPort || !targetPort) return;
        const url = userFacingUrl(e.data.href, proxyPort.port, targetPort);
        if (!url) return;
        frameAt.current = url;
        setHist((h) => followFrame(h, url, !!e.data.replace));
      } else if (isStepMessage(e.data)) {
        stepsRef.current = pushStep(stepsRef.current, e.data.step, Date.now());
      } else if (e.data?.type === "trb-ready") {
        if (picking) iframeRef.current.contentWindow?.postMessage({ type: "trb-pick-mode", on: true }, "*");
      } else if (e.data?.type === "trb-pick-cancel") setPicking(false);
      else if (isPickMessage(e.data) && current) {
        setPicking(false);
        const pageUrl = new URL(String(e.data.path ?? "/"), current).toString();
        const id = toast.loading("Capturing the element…");
        sendPick({ url: pageUrl, pick: e.data })
          .then((r) => {
            insertIntoComposer(r.text);
            toast.success(`Picked ${r.pick.selector.slice(0, 60)}`, { id, description: r.pick.screenshot ? "Details and a cropped screenshot were added to your message." : `Added to your message (no screenshot: ${r.pick.screenshotNote ?? "unavailable"}).` });
          })
          .catch((err: Error) => toast.error(err.message, { id }));
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [picking, current, proxyPort, targetPort]);

  const togglePick = () => {
    const next = !picking;
    setPicking(next);
    iframeRef.current?.contentWindow?.postMessage({ type: "trb-pick-mode", on: next }, "*");
  };
  useEffect(() => setPicking(false), [current, nonce, inspecting]);

  // History moves (back/forward) and the page's own navigation change the address without going through navigate().
  useEffect(() => {
    if (!current) return;
    setInput(current);
    updateTab(tab.id, { url: current, title: titleFor(current) });
    if (current !== frameAt.current) setFrameUrl(current);
  }, [current, tab.id, updateTab]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") setHist((h) => (h.i > 0 ? { ...h, i: h.i - 1 } : h));
      else if (e.key === "ArrowRight") setHist((h) => (h.i < h.stack.length - 1 ? { ...h, i: h.i + 1 } : h));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Load whenever the framed address (or a reload) changes: check the server, then frame it.
  useEffect(() => {
    if (!frameUrl) {
      setPhase("idle");
      return;
    }
    let cancelled = false;
    if (slowTimer.current) clearTimeout(slowTimer.current);
    setPhase("checking");
    void freshPorts(qc)
      .then((listening) => reachability(frameUrl, listening))
      .catch(() => "unknown" as const)
      .then((p) => {
      if (cancelled) return;
      if (p === "down") {
        setPhase("down");
        return;
      }
      setPhase("loading");
      slowTimer.current = setTimeout(() => setPhase((ph) => (ph === "loading" ? "slow" : ph)), 12_000);
      });
    return () => {
      cancelled = true;
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [frameUrl, nonce, qc]);

  const frame = useMemo(() => {
    // 16px of margin around the frame, and a strip above it for the size readout.
    const avail = { w: Math.max(0, pane.width - 32), h: Math.max(0, pane.height - 16 - 36) };
    const responsiveW = respW ?? defaultResponsiveWidth(avail.w, zoom);
    return computeFrame({ device, rotated, avail, zoom, fit, responsiveW });
  }, [pane, device, rotated, zoom, fit, respW]);

  const [bug, setBug] = useState<{ shot: Shot | null; url: string; port: number | null; steps: string[]; prefill?: BugPrefill; done?: (findingId: string | null) => void } | null>(null);
  const canLogBug = !!current && (phase === "loaded" || phase === "slow");
  // The shot comes first: once the dialog opens it covers the page.
  const logBug = async (prefill?: BugPrefill, done?: (findingId: string | null) => void) => {
    if (!current || !canLogBug) {
      if (done) {
        toast.error("Open the page first, then log the bug.");
        done(null);
      }
      return;
    }
    const iframe = iframeRef.current;
    const shot = iframe ? await takeShot(iframe, { pane: paneRef.current?.getBoundingClientRect() }) : null;
    setBug({ shot, url: current, port: targetPort, steps: stepLines(stepsRef.current), prefill, done });
  };
  const logBugRef = useRef(logBug);
  logBugRef.current = logBug;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        void logBugRef.current();
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyQ") {
        e.preventDefault();
        const p = useBrowserPrefs.getState();
        p.set({ qaOpen: !p.qaOpen });
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reload = () => {
    setFrameUrl(current);
    setNonce((n) => n + 1);
  };

  const dragStart = useRef<{ x: number; w: number } | null>(null);
  const loading = phase === "checking" || phase === "loading";
  const showFrame = current && frameSrc && (phase === "loading" || phase === "loaded" || phase === "slow");
  const isDevice = device.id !== "responsive";
  const DeviceIcon = DEVICE_ICON[device.kind];

  const portEntries = ports.map((p) => ({ label: `localhost:${p.port}  ·  ${p.command}`, icon: <Zap />, onSelect: () => navigate(previewUrl(p.port)) }));

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="relative flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-2 [scrollbar-width:none]">
        <ModeSwitch tab={tab} mode="preview" className="mr-1" />
        <IconButton label="Back" shortcut="Alt+←" size="icon-sm" disabled={hist.i <= 0} onClick={() => { setHist((h) => ({ ...h, i: h.i - 1 })); }}>
          <ArrowLeft />
        </IconButton>
        <IconButton label="Forward" shortcut="Alt+→" size="icon-sm" disabled={hist.i >= hist.stack.length - 1} onClick={() => { setHist((h) => ({ ...h, i: h.i + 1 })); }}>
          <ArrowRight />
        </IconButton>
        <IconButton label="Reload" size="icon-sm" disabled={!current} onClick={reload}>
          <RotateCw className={cn(loading && "animate-spin-fast")} />
        </IconButton>
        <form
          className="relative min-w-[140px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(input);
          }}
        >
          <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setInput(current ?? "");
                setError(null);
                e.currentTarget.blur();
              }
            }}
            placeholder="localhost:3000"
            spellCheck={false}
            aria-label="Address"
            aria-invalid={!!error}
            className={cn("h-7 pl-8 font-mono text-xs", error && "border-red/60")}
          />
        </form>
        <DropdownMenu
          entries={portEntries.length ? portEntries : [{ label: "No dev servers found in this workspace", disabled: true }]}
          align="end"
          trigger={
            <Button variant="ghost" size="sm" className="gap-1 px-2 font-mono text-[11px]" aria-label="Detected dev servers">
              <Zap className={cn(ports.length && "text-accent")} />
              {ports.length || ""}
            </Button>
          }
        />
        <IconButton label="Run: dev servers, database, logs" size="icon-sm" onClick={() => setPrefs({ runOpen: !runOpen })} className={cn(runOpen && "bg-active text-fg")}>
          <Play />
        </IconButton>
        <IconButton
          label={canInspect ? (inspect ? "Inspect is on: element picking and console capture (click to turn off)" : "Inspect: pick elements, capture console errors") : "Inspect works on localhost previews"}
          size="icon-sm"
          disabled={!canInspect && !inspect}
          onClick={() => setPrefs({ inspect: !inspect })}
          className={cn(inspect && "bg-active text-accent")}
        >
          <MousePointerClick />
        </IconButton>
        <IconButton label="Log bug: save this page, its console and the server log as a finding" shortcut="Alt+B" size="icon-sm" disabled={!canLogBug} onClick={() => void logBug()}>
          <Bug />
        </IconButton>
        <IconButton label="QA panel: run a test plan against this page" shortcut="Alt+Q" size="icon-sm" onClick={() => setPrefs({ qaOpen: !qaOpen })} className={cn(qaOpen && "bg-active text-fg")}>
          <ClipboardCheck />
        </IconButton>
        {inspecting && (
          <>
            <Button variant={picking ? "primary" : "outline"} size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!frameSrc || phase !== "loaded"} onClick={togglePick}>
              {picking ? "Click an element (Esc)" : "Pick"}
            </Button>
            <DropdownMenu
              align="end"
              entries={
                issueList.length
                  ? [
                      { label: `Attach ${Math.min(issueList.length, 40)} to message`, onSelect: () => targetPort && insertIntoComposer(formatIssuesForComposer(targetPort, issueList)) },
                      { label: "Clear", onSelect: () => targetPort && void clearIssues(targetPort).then(() => qc.invalidateQueries({ queryKey: ["preview-issues"] })) },
                      ...issueList.slice(-8).reverse().map((i) => ({ label: `${i.level}: ${i.text.slice(0, 90)}`, disabled: true })),
                    ]
                  : [{ label: "No console errors or failed requests", disabled: true }]
              }
              trigger={
                <Button variant="ghost" size="sm" className="gap-1 px-2 font-mono text-[11px]" aria-label="Console errors and failed requests">
                  <TerminalSquare className={cn(errorCount(issueList) > 0 && "text-red")} />
                  {issueList.length || ""}
                </Button>
              }
            />
          </>
        )}
        <span className="mx-0.5 h-4 w-px bg-line" />
        <DropdownMenu
          entries={DEVICES.map((d) => {
            const I = DEVICE_ICON[d.kind];
            return { label: d.w ? `${d.label}  ${d.w}×${d.h}` : d.label, icon: <I />, checked: d.id === device.id, onSelect: () => setPrefs({ device: d.id }) };
          })}
          trigger={
            <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-xs" aria-label="Device">
              <DeviceIcon /> {device.label}
            </Button>
          }
        />
        <IconButton label="Rotate" size="icon-sm" disabled={!isDevice} onClick={() => setPrefs({ rotated: !rotated })} className={cn(rotated && "bg-active text-fg")}>
          <RotateCcw />
        </IconButton>
        <IconButton label="Fit to pane" size="icon-sm" onClick={() => setPrefs({ fit: !fit })} className={cn(fit && isDevice && "bg-active text-fg")} disabled={!isDevice}>
          <Maximize2 />
        </IconButton>
        <IconButton label="Zoom out" size="icon-sm" disabled={fit && isDevice} onClick={() => setPrefs({ zoom: clampZoom(zoom - 0.1) })}>
          <ZoomOut />
        </IconButton>
        <button onClick={() => setPrefs({ zoom: 1 })} disabled={fit && isDevice} className="w-9 text-center font-mono text-[10.5px] text-fg-faint outline-none hover:text-fg disabled:opacity-40" aria-label="Reset zoom">
          {Math.round((isDevice && fit ? frame.scale : zoom) * 100)}%
        </button>
        <IconButton label="Zoom in" size="icon-sm" disabled={fit && isDevice} onClick={() => setPrefs({ zoom: clampZoom(zoom + 0.1) })}>
          <ZoomIn />
        </IconButton>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <IconButton label="Copy URL" size="icon-sm" disabled={!current} onClick={() => current && void navigator.clipboard.writeText(current).then(() => toast.success("URL copied"))}>
          <Copy />
        </IconButton>
        <IconButton label="Open in system browser" size="icon-sm" disabled={!current} onClick={() => current && window.open(current, "_blank", "noopener,noreferrer")}>
          <ExternalLink />
        </IconButton>
        {loading && <div className="sweep absolute inset-x-0 bottom-0 h-[2px] bg-accent/20" />}
      </div>

      {error && (
        <div className="flex animate-slide-up items-center gap-2 border-b border-red/30 bg-red/10 px-3 py-1.5 text-xs text-red">
          <AlertTriangle className="size-3.5 shrink-0" /> {error}
        </div>
      )}
      {phase === "slow" && (
        <div className="flex animate-slide-up items-center gap-2 border-b border-amber/30 bg-amber/10 px-3 py-1.5 text-xs text-amber">
          <AlertTriangle className="size-3.5 shrink-0" />
          Still loading. If it stays blank, the site may refuse to be shown in a frame.
          <Button size="xs" variant="ghost" onClick={() => current && window.open(current, "_blank", "noopener,noreferrer")} className="ml-auto text-amber">
            Open in system browser
          </Button>
        </div>
      )}

      <div ref={wrapRef} className={cn("flex min-h-0 flex-1", dock === "strip" ? "flex-col" : "flex-row")}>
      <div ref={paneRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,var(--line)_1px,transparent_1px)] [background-size:16px_16px]">
        {!current && phase === "idle" && (
          <Empty
            icon={<Globe />}
            title="Preview a dev server"
            hint="Type an address above, e.g. :3000 or localhost:5173."
            action={
              ports.length ? (
                <div className="flex flex-wrap justify-center gap-1.5">
                  {ports.map((p) => (
                    <Button key={p.port} size="sm" variant="outline" onClick={() => navigate(previewUrl(p.port))}>
                      <Zap className="text-accent" /> :{p.port}
                    </Button>
                  ))}
                </div>
              ) : undefined
            }
          />
        )}

        {phase === "down" && current && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm animate-slide-up text-center">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl border border-line bg-raised text-amber">
                <AlertTriangle className="size-5" />
              </div>
              <h3 className="text-[13.5px] font-semibold">Can't reach {new URL(current).host}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">Is the dev server running? Start it in a terminal, then retry.</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="primary" onClick={reload}>
                  <RotateCw /> Retry
                </Button>
                <Button variant="outline" onClick={() => useUi.getState().setBottomTab("terminal")}>
                  <TerminalSquare /> Open terminal
                </Button>
              </div>
            </div>
          </div>
        )}

        {showFrame && (
          <div className="flex min-h-full min-w-full items-start justify-center px-4 pb-4 pt-[34px]">
            <div className="relative shrink-0" style={{ width: frame.width * frame.scale, height: frame.height * frame.scale }}>
              <div className={cn("absolute left-0 top-0 origin-top-left overflow-hidden bg-white shadow-pop ring-1 ring-line-strong", device.kind === "phone" ? "rounded-[26px]" : device.kind === "tablet" ? "rounded-[18px]" : "rounded-md")} style={{ width: frame.width, height: frame.height, transform: `scale(${frame.scale})` }}>
                <iframe
                  ref={iframeRef}
                  key={`${frameSrc}#${nonce}`}
                  src={frameSrc ?? undefined}
                  title={`Preview of ${current}`}
                  sandbox={SANDBOX}
                  referrerPolicy="no-referrer"
                  allow=""
                  onLoad={() => {
                    if (slowTimer.current) clearTimeout(slowTimer.current);
                    setPhase("loaded");
                  }}
                  className="size-full border-0 bg-white"
                />
              </div>
              {!isDevice && (
                <div
                  role="separator"
                  aria-label="Resize preview width"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragStart.current = { x: e.clientX, w: frame.width };
                  }}
                  onPointerMove={(e) => {
                    if (!dragStart.current) return;
                    setRespW(Math.max(MIN_RESPONSIVE_W, Math.round(dragStart.current.w + (e.clientX - dragStart.current.x) / frame.scale)));
                  }}
                  onPointerUp={() => (dragStart.current = null)}
                  onPointerCancel={() => (dragStart.current = null)}
                  onDoubleClick={() => setRespW(null)}
                  className="group absolute -right-3 top-0 flex h-full w-3 cursor-col-resize items-center justify-center"
                >
                  <div className="h-10 w-1 rounded-full bg-line-strong transition-colors group-hover:bg-accent" />
                </div>
              )}
              <div className="pointer-events-none absolute -top-5 left-0 font-mono text-[10.5px] text-fg-faint">
                {frame.width} × {frame.height}
                {frame.scale !== 1 && ` · ${Math.round(frame.scale * 100)}%`}
              </div>
            </div>
          </div>
        )}
      </div>
      {qaOpen && (
        <>
          {dock === "side" && <PaneSplitter paneKey="browser.qa" fallback={320} min={280} max={440} invert />}
          <div className={cn("shrink-0 overflow-hidden bg-panel", dock === "strip" && "h-[280px] border-t border-line")} style={dock === "side" ? { width: qaWidth } : undefined}>
            <QaPanel
              root={root}
              currentUrl={current}
              onNavigate={(path) => {
                const url = resolvePath(path, current ?? devTarget?.url ?? null);
                if (url) navigate(url);
                else toast.error("Open the page first, then follow the path.");
              }}
              onFail={(draft, done) => void logBug({ title: draft.title, kind: draft.kind, steps: draft.steps, expected: draft.expected, actual: draft.actual }, done)}
              recordedSince={(t) => stepsSince(stepsRef.current, t)}
              compact={dock === "strip"}
            />
          </div>
        </>
      )}
      </div>
      <LogBugDialog open={!!bug} onOpenChange={(o) => !o && setBug(null)} root={root} url={bug?.url ?? current ?? ""} port={bug?.port ?? null} shot={bug?.shot ?? null} steps={bug?.steps ?? []} prefill={bug?.prefill} onLogged={(id) => bug?.done?.(id)} />
      {runOpen && (
        <div className="h-[300px] shrink-0 border-t border-line">
          <RunPanel
            root={runRef}
            onOpenUrl={(u) => navigate(u)}
            onStarted={() => {
              wantOpen.current = true;
            }}
            onClose={() => setPrefs({ runOpen: false })}
          />
        </div>
      )}
    </div>
  );
}
