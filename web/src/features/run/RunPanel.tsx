import { useEffect, useRef, useState } from "react";
import { Database, ExternalLink, KeyRound, Play, RotateCw, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { Badge, Section, Spinner, StatusDot } from "@/components/ui/misc";
import { fetchLogs, useRunActions, useRunInfo } from "./data";
import { isLive, statusLabel, type Instance, type LogLine, type RunService } from "./logic";

/**
 * The project's runnable things: dev servers, database tasks, env files (keys only) and live logs. Sits beside
 * the preview, next to the chat. `root` is the open session's working copy, so a head in a worktree has its own
 * servers and ports.
 */
export function RunPanel({ root, onOpenUrl, onStarted, onClose }: { root: string; onOpenUrl: (url: string) => void; onStarted: () => void; onClose: () => void }) {
  const info = useRunInfo(root);
  const actions = useRunActions(root);
  const [logFor, setLogFor] = useState<string | null>(null);
  const detected = info.data?.detected;
  const byService = new Map((info.data?.instances ?? []).map((i) => [i.service, i]));

  // Follow the most recently started one unless the operator picked another.
  const instances = info.data?.instances ?? [];
  const newest = [...instances].sort((a, b) => b.startedAt - a.startedAt)[0]?.service ?? null;
  const shown = logFor && (byService.has(logFor) || detected?.services.some((s) => s.id === logFor)) ? logFor : newest;

  const row = (svc: RunService) => {
    const inst = byService.get(svc.id);
    const live = isLive(inst);
    const busy = (actions.start.isPending && actions.start.variables === svc.id) || (actions.restart.isPending && actions.restart.variables === svc.id);
    return (
      <div key={svc.id} className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover", shown === svc.id && "bg-active/60")}>
        <button className="flex min-w-0 flex-1 flex-col items-start text-left outline-none" onClick={() => setLogFor(svc.id)} title="Show its logs">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            {inst ? <StatusDot status={inst.status === "running" ? "running" : inst.status === "failed" ? "failed" : inst.status === "starting" ? "running" : "closed"} /> : <StatusDot status="closed" />}
            <span className="truncate">{svc.label}</span>
            {inst?.port && live && <Badge tone="blue">:{inst.port}</Badge>}
          </span>
          <span className="max-w-full truncate font-mono text-[10.5px] text-fg-faint">{inst?.command ?? svc.command}</span>
          <span className={cn("text-[10.5px]", inst?.status === "failed" ? "text-red" : "text-fg-muted")}>{statusLabel(inst)}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {svc.kind === "dev" && inst?.url && inst.status === "running" && (
            <IconButton label="Open in preview" size="icon-sm" onClick={() => onOpenUrl(inst.url!)}>
              <ExternalLink />
            </IconButton>
          )}
          {live ? (
            <>
              {svc.kind === "dev" && (
                <IconButton label="Restart" size="icon-sm" disabled={inst?.status === "stopping"} onClick={() => actions.restart.mutate(svc.id)}>
                  <RotateCw />
                </IconButton>
              )}
              <IconButton label="Stop" size="icon-sm" disabled={inst?.status === "stopping"} onClick={() => actions.stop.mutate(svc.id)}>
                <Square />
              </IconButton>
            </>
          ) : (
            <IconButton
              label={svc.kind === "dev" ? "Start" : "Run"}
              size="icon-sm"
              disabled={busy}
              onClick={() => {
                if (svc.kind === "dev") onStarted();
                setLogFor(svc.id);
                actions.start.mutate(svc.id);
              }}
            >
              {busy ? <Spinner /> : <Play />}
            </IconButton>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="text-xs font-semibold">Run</span>
        {info.data && <span className="truncate font-mono text-[10.5px] text-fg-faint">{info.data.dir.split("/").slice(-2).join("/")}</span>}
        <IconButton label="Close" size="icon-sm" className="ml-auto" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 w-[46%] min-w-[220px] shrink-0 overflow-y-auto border-r border-line">
        {info.isLoading && <div className="p-4 text-xs text-fg-muted">Looking for a dev server…</div>}
        {info.error && <div className="p-4 text-xs text-red">{(info.error as Error).message}</div>}
        {detected && (
          <>
            <Section title="Dev servers" count={detected.services.length}>
              {detected.services.length ? (
                <div className="px-1 pb-1">{detected.services.map(row)}</div>
              ) : (
                <p className="px-3 pb-2 text-xs leading-relaxed text-fg-muted">No <code>dev</code>, <code>start</code> or <code>serve</code> script in package.json and no Procfile here.</p>
              )}
            </Section>
            {detected.db.length > 0 && (
              <Section title={<span className="flex items-center gap-1.5"><Database className="size-3.5" /> Database</span>} count={detected.db.length}>
                <div className="px-1 pb-1">{detected.db.map(row)}</div>
              </Section>
            )}
            {detected.envFiles.length > 0 && (
              <Section title={<span className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Environment</span>} count={detected.envFiles.length} defaultOpen={false}>
                <div className="space-y-2 px-3 pb-2">
                  <p className="text-[10.5px] text-fg-faint">Keys only. Values are never read by trb; the server loads its own files.</p>
                  {detected.envFiles.map((f) => (
                    <div key={f.file}>
                      <div className="font-mono text-[11px] font-medium">{f.file}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {f.keys.length ? f.keys.map((k) => <Badge key={k}>{k}</Badge>) : <span className="text-[10.5px] text-fg-faint">no keys</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
      <Logs root={root} service={shown} instance={shown ? byService.get(shown) : undefined} />
      </div>
    </div>
  );
}

function Logs({ root, service, instance }: { root: string; service: string | null; instance: Instance | undefined }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const cursor = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const key = instance ? `${service}:${instance.startedAt}` : service;

  useEffect(() => {
    setLines([]);
    cursor.current = 0;
    if (!service) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetchLogs(root, service, cursor.current);
        if (stopped) return;
        cursor.current = r.next;
        if (r.lines.length) setLines((prev) => [...prev, ...r.lines].slice(-1500));
      } catch {}
    };
    void tick();
    const t = setInterval(() => document.visibilityState === "visible" && void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [root, service, key]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-[10.5px] uppercase tracking-wide text-fg-faint">
        Logs <span className="font-mono normal-case">{service ?? ""}</span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto bg-bg p-2 font-mono text-[10.5px] leading-[1.45]"
      >
        {!service && <div className="text-fg-faint">Start something to see its output here.</div>}
        {service && lines.length === 0 && <div className="text-fg-faint">No output yet.</div>}
        {lines.map((l) => (
          <div key={l.seq} className={cn("whitespace-pre-wrap break-all", l.stream === "err" && "text-amber", l.stream === "sys" && "text-accent")}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
