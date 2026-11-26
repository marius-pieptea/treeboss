import { useEffect, useState } from "react";
import {
  ChevronLeft,
  Copy,
  ExternalLink,
  Globe,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { DropdownMenu } from "@/components/ui/overlay";
import { bus } from "@/lib/bus";
import { draftKey, drafts } from "@/lib/drafts";
import { useElementSize } from "@/lib/hooks";
import { useSessions } from "@/lib/queries";
import { useUi, useWs } from "@/lib/store";
import { cn } from "@/lib/utils";
import { artifactHtmlUrl, openExternal, type AccountStatus, type Artifact } from "./data";
import { ErrorPanel } from "./ErrorPanel";
import { formatRelativeTime, formatShortDateTime, sessionLabel } from "./format";
import { LiveView } from "./LiveView";

export function Detail({
  item,
  account,
  narrow,
  reading,
  readError,
  onBack,
  onRefresh,
  onAutoRead,
  onRemove,
}: {
  item: Artifact;
  account: AccountStatus;
  narrow: boolean;
  reading: boolean;
  readError: string | null;
  onBack?: () => void;
  onRefresh: (id: string) => void;
  onAutoRead: (id: string) => void;
  onRemove: (item: Artifact) => void;
}) {
  const [containerRef, containerSize] = useElementSize<HTMLDivElement>();
  const current = useUi((s) => s.current);
  const ws = useWs();
  const sessions = useSessions(current).data;
  const [liveOpen, setLiveOpen] = useState(false);

  const isReading = reading;
  const compactHeader = narrow || (containerSize.width > 0 && containerSize.width < 520);

  useEffect(() => {
    setLiveOpen(false);
  }, [item.id]);

  useEffect(() => {
    if (item.lastReadAt === null && !item.error) {
      onAutoRead(item.id);
    }
  }, [item.id, item.lastReadAt, item.error, onAutoRead]);

  const openSession = (sessionId: string) => {
    const ui = useUi.getState();
    ui.setActiveSession(sessionId);
    ui.setRightTab("agent");
  };

  const askAgent = () => {
    const ownOpen =
      item.sessionId && sessions?.some((s) => s.id === item.sessionId && s.status !== "closed")
        ? item.sessionId
        : null;
    const sid = ownOpen ?? ws.activeSession;
    if (!sid) {
      toast("Open a session first.");
      return;
    }
    const key = draftKey(current, sid);
    const base = `About this artifact: ${item.url} `;
    const addition = item.owner === "shared" && item.summary ? `${base}\n\nSummary: ${item.summary}` : base;
    const existing = drafts.get(key);
    drafts.set(key, existing ? `${existing}\n\n${addition}` : addition);
    const ui = useUi.getState();
    ui.setActiveSession(sid);
    ui.setRightTab("agent");
    bus.emit("focus-composer");
  };

  const copyLink = () => {
    void navigator.clipboard.writeText(item.url).then(() => toast.success("Link copied"));
  };

  const triggerRefresh = () => {
    setLiveOpen(false);
    onRefresh(item.id);
  };

  const moreEntries = [
    { label: "Ask an agent", icon: <MessageSquare />, onSelect: askAgent },
    { label: "Refresh", icon: <RefreshCw />, onSelect: triggerRefresh, disabled: isReading },
    { label: "Copy link", icon: <Copy />, onSelect: copyLink },
    { separator: true },
    { label: "Remove from list", icon: <Trash2 />, danger: true, onSelect: () => onRemove(item) },
  ];

  const metaLine = (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {item.owner === "shared" ? <Badge tone="blue">shared with you</Badge> : <Badge>{item.intent}</Badge>}
      <span className="font-mono text-label text-fg-muted">
        {item.sessionId ? (
          <>
            from{" "}
            <button
              type="button"
              onClick={() => openSession(item.sessionId!)}
              className="text-accent underline underline-offset-2 hover:opacity-80"
            >
              {sessionLabel(item)}
            </button>
            {" · created "}
            {formatShortDateTime(item.createdAt)}
            {item.updatedAt ? ` · updated ${formatRelativeTime(item.updatedAt)}` : ""}
          </>
        ) : (
          <>pasted {formatShortDateTime(item.createdAt)}</>
        )}
      </span>
    </div>
  );

  const iconActions = (
    <>
      <IconButton label="Refresh" onClick={triggerRefresh} disabled={isReading}>
        <RefreshCw className={cn(isReading && "animate-spin-fast")} />
      </IconButton>
      <IconButton label="Copy link" onClick={copyLink}>
        <Copy />
      </IconButton>
      <DropdownMenu
        align="end"
        entries={moreEntries}
        trigger={<IconButton label="More"><MoreHorizontal /></IconButton>}
      />
    </>
  );

  const primaryActions = (
    <>
      <Button variant="subtle" onClick={askAgent}>
        <MessageSquare />
        Ask an agent
      </Button>
      <Button variant="outline" onClick={() => openExternal(item.url)}>
        <ExternalLink />
        Open in claude.ai
      </Button>
    </>
  );

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-bg">
      <div className="shrink-0 border-b border-line bg-panel px-4 py-3">
        <div className="flex items-start gap-2">
          {narrow && onBack && (
            <IconButton label="Back" onClick={onBack} className="-ml-1.5 shrink-0">
              <ChevronLeft />
            </IconButton>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight text-fg">{item.title || item.url}</h2>
            {metaLine}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {!compactHeader && primaryActions}
            {iconActions}
          </div>
        </div>
        {compactHeader && <div className="mt-2 flex flex-wrap items-center gap-2">{primaryActions}</div>}
      </div>

      {liveOpen ? (
        <LiveView url={item.url} onClose={() => setLiveOpen(false)} />
      ) : isReading ? (
        <>
          <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-3 font-mono text-label text-fg-muted">
            <RefreshCw className="size-3 shrink-0 animate-spin-fast text-fg-faint" />
            <span>Reading from claude.ai…</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="flex h-full flex-col gap-3 rounded-lg border border-line bg-panel p-6">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="min-h-32 flex-1" />
            </div>
          </div>
        </>
      ) : readError ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorPanel
            error="read_failed"
            errorText={readError}
            url={item.url}
            version={account.version}
            onRetry={triggerRefresh}
            onRemove={() => onRemove(item)}
            retrying={isReading}
          />
        </div>
      ) : item.error ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorPanel
            error={item.error}
            errorText={item.errorText}
            url={item.url}
            version={account.version}
            onRetry={triggerRefresh}
            onRemove={() => onRemove(item)}
            retrying={isReading}
          />
        </div>
      ) : item.htmlPath ? (
        <>
          <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-3 font-mono text-label text-fg-muted">
            <ShieldCheck className="size-3 shrink-0 text-fg-faint" />
            <span>
              Local copy · read {item.lastReadAt ? formatRelativeTime(item.lastReadAt) : "just now"} · sandboxed
            </span>
          </div>
          <div className="min-h-0 flex-1 p-4">
            <div className="h-full overflow-hidden rounded-lg border border-line bg-panel">
              <iframe
                key={`${item.id}:${item.lastReadAt ?? ""}`}
                title={item.title || "Artifact preview"}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                src={artifactHtmlUrl(item.id)}
                className="h-full w-full border-0 bg-panel"
              />
            </div>
          </div>
        </>
      ) : item.summary ? (
        <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
          <div className="flex max-w-[760px] flex-col gap-4">
            <div className="rounded-lg border border-line bg-raised p-3">
              <div className="text-label font-medium uppercase tracking-label text-fg-muted">
                Summary from claude.ai
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{item.summary}</p>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">
                Someone else owns this artifact, so TreeBoss can only read its summary. To see the page itself, open it in a browser view signed in to claude.ai.
              </p>
              <Button variant="primary" size="md" onClick={() => setLiveOpen(true)}>
                <Globe />
                Open live view
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorPanel
            error="read_failed"
            errorText="No preview is stored for this artifact yet."
            url={item.url}
            version={account.version}
            onRetry={triggerRefresh}
            onRemove={() => onRemove(item)}
            retrying={isReading}
          />
        </div>
      )}
    </div>
  );
}
