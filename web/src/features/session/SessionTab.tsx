import { useEffect, useState } from "react";
import { GitBranch, GitMerge, MoreHorizontal, Square, SquareTerminal, Terminal as TerminalIcon, X } from "lucide-react";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { useSession } from "@/lib/queries";
import type { Tab } from "@/lib/store";
import { useUi } from "@/lib/store";
import { cn, money } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Badge, Empty, Skeleton, StatusDot } from "@/components/ui/misc";
import { RoleBadge } from "@/features/heads/RoleBadge";
import { OpenPrButton } from "@/features/ci/OpenPrButton";
import { useHeadActions } from "@/features/heads/actions";
import { engineLabel, formatElapsed, isMergeReady } from "@/features/heads/model";
import { Conversation } from "./Conversation";
import { Changes } from "./Changes";
import { Files } from "./Files";
import { Info } from "./Info";
import { onSessionPane, takeSessionPane, type SessionPane } from "./intent";

/** One session (usually a head) in the editor area: its conversation, its changes, its files, its facts. */
export function SessionTab({ tab }: { tab: Extract<Tab, { kind: "session" }> }) {
  const q = useSession(tab.sessionId);
  const actions = useHeadActions();
  const [pane, setPane] = useState<SessionPane>(() => takeSessionPane(tab.sessionId) ?? "conversation");
  useEffect(() => onSessionPane(tab.sessionId, setPane), [tab.sessionId]);

  const s = q.data?.session;
  // Keep the strip's title honest as the role or title is learned.
  const updateTab = useUi((u) => u.updateTab);
  useEffect(() => {
    if (!s) return;
    const title = s.role ? `${s.role}: ${s.title}` : s.title;
    if (title !== tab.title) updateTab(tab.id, { title });
  }, [s?.role, s?.title, tab.id, tab.title, updateTab, s]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.error || !s) return <Empty title="Session not found" hint={(q.error as Error | null)?.message ?? "It may have been removed."} className="h-full" />;

  const ready = isMergeReady(s);
  const running = s.status === "running";
  const resume = async () => {
    try {
      await post("/api/terminals", { root: s.id, resumeSession: s.id }).then((r: any) => {
        useUi.getState().setBottomTab("terminal");
        window.dispatchEvent(new CustomEvent("trb:terminals-changed", { detail: { focus: r.terminal.id } }));
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="shrink-0 border-b border-line px-4 pb-0 pt-3">
        <div className="flex items-center gap-2">
          <StatusDot status={s.status} size={8} />
          <RoleBadge role={s.role} fallback={s.depth === 0 ? "lead" : s.engine} />
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={s.title}>
            {s.title}
          </h2>
          {running && <span className="font-mono text-[11px] text-accent">{s.running_for_sec === undefined ? "" : formatElapsed(s.running_for_sec)}</span>}
          {ready && (
            <Button size="sm" variant="primary" onClick={() => actions.merge(s)} className="animate-pop">
              <GitMerge /> Merge
            </Button>
          )}
          {s.branch && s.status !== "closed" && <OpenPrButton sessionId={s.id} />}
          {running && (
            <Button size="sm" variant="outline" onClick={() => actions.interrupt(s)} className="text-amber">
              <Square className="fill-current" /> Interrupt
            </Button>
          )}
          <DropdownMenu
            align="end"
            entries={[
              { label: "Open terminal here", icon: <SquareTerminal />, onSelect: () => actions.openTerminal(s), disabled: s.status === "closed" },
              { label: "Continue in the engine's own terminal UI", icon: <TerminalIcon />, onSelect: resume, disabled: s.status === "closed" || running },
              { label: "Copy branch name", icon: <GitBranch />, onSelect: () => actions.copyBranch(s), disabled: !s.branch },
              { separator: true },
              { label: "Close", icon: <X />, danger: true, disabled: s.status === "closed", onSelect: () => actions.close(s) },
            ]}
            trigger={
              <Button size="icon" variant="ghost" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            }
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 font-mono text-[11px] text-fg-muted">
          <span>{engineLabel(s)}</span>
          {s.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="size-3" /> {s.branch}
            </span>
          )}
          {s.changes && (
            <span>
              <span className="text-green">+{s.changes.insertions}</span> <span className="text-red">−{s.changes.deletions}</span> in {s.changes.files} file{s.changes.files === 1 ? "" : "s"}
            </span>
          )}
          {s.merged && <Badge tone="green">merged</Badge>}
          {s.cost_usd ? <span>{money(s.cost_usd)}</span> : null}
          <span>
            {s.turns} turn{s.turns === 1 ? "" : "s"}
          </span>
        </div>
        <div role="tablist" className="-mb-px mt-3 flex items-stretch">
          {(
            [
              ["conversation", "Conversation", null],
              ["changes", "Changes", s.changes ? s.changes.files : null],
              ["files", "Files", null],
              ["info", "Info", null],
            ] as const
          ).map(([id, label, badge]) => (
            <button key={id} role="tab" aria-selected={pane === id} onClick={() => setPane(id)} className={cn("relative flex h-8 items-center gap-1.5 px-3 text-[12.5px] font-medium outline-none transition-colors", pane === id ? "text-fg" : "text-fg-muted hover:text-fg")}>
              {label}
              {badge !== null && <span className="rounded bg-raised px-1 font-mono text-[10px] text-fg-faint">{badge}</span>}
              <span className={cn("absolute inset-x-2 bottom-0 h-px origin-center bg-accent transition-transform duration-200", pane === id ? "scale-x-100" : "scale-x-0")} />
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {pane === "conversation" && <Conversation session={s} brief={q.data?.brief ?? null} />}
        {pane === "changes" && <Changes session={s} />}
        {pane === "files" && <Files session={s} />}
        {pane === "info" && <Info session={s} />}
      </div>
    </div>
  );
}
