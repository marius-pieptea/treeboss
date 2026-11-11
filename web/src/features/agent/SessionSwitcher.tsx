import { useState, type ReactNode } from "react";
import { ChevronDown, MessageSquarePlus, Pencil, Plus } from "lucide-react";
import { useSessions } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { useDraftedSessions, useNewSessionDraft } from "@/lib/use-drafts";
import { cn, toMillis } from "@/lib/utils";
import { Popover } from "@/components/ui/overlay";
import { Input } from "@/components/ui/form";
import { StatusDot } from "@/components/ui/misc";
import { IconButton } from "@/components/ui/button";
import { openSession, startNewSession } from "./agent-commands";

/**
 * The session's label (and the chevron) is the switcher: search and switch between this workspace's sessions, closed ones included.
 * `children` is what the whole button shows; clicking any of it opens the list.
 */
export function SessionSwitcher({ activeId, children, title = "Switch session", className, onDoubleClick }: { activeId: string | null; children?: ReactNode; title?: string; className?: string; onDoubleClick?: () => void }) {
  const wsId = useUi((s) => s.current);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const sessions = useSessions(wsId, { closed: true });
  const drafted = useDraftedSessions();
  const newDraft = useNewSessionDraft(wsId);
  const needle = q.trim().toLowerCase();
  // Latest activity first, whatever order the server returned them in.
  const list = (sessions.data ?? [])
    .filter((s) => s.depth === 0 && (!needle || s.title.toLowerCase().includes(needle)))
    .sort((a, b) => (toMillis(b.updated_at ?? "") || 0) - (toMillis(a.updated_at ?? "") || 0));
  return (
    <Popover
      align="start"
      width={300}
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
      trigger={
        <button aria-label="Switch session" title={title} onDoubleClick={onDoubleClick} className={cn("flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 -mx-1 text-left outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover", className)}>
          {children}
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
        </button>
      }
    >
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions" className="mb-1 h-7 text-xs" />
      <ul className="flex max-h-[50vh] flex-col overflow-y-auto">
        {newDraft && !needle && (
          <li>
            <button
              onClick={() => {
                startNewSession();
                setOpen(false);
              }}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover", activeId === null && "bg-hover")}
            >
              <MessageSquarePlus className="size-3.5 shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1 truncate text-fg-muted">New session</span>
              <DraftMark />
            </button>
          </li>
        )}
        {list.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => {
                openSession(s.id);
                setOpen(false);
              }}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover", s.id === activeId && "bg-hover")}
            >
              <StatusDot status={s.status} size={7} />
              <span className={cn("min-w-0 flex-1 truncate", s.status === "closed" && "text-fg-muted")}>{s.title}</span>
              {drafted.has(s.id) && <DraftMark />}
            </button>
          </li>
        ))}
        {!list.length && !(newDraft && !needle) && <li className="px-2 py-2 text-xs text-fg-faint">{sessions.isLoading ? "Loading…" : "No sessions found"}</li>}
      </ul>
    </Popover>
  );
}

/** An unsent message waits in this session's composer. */
function DraftMark() {
  return (
    <span title="Unsent message in the composer" className="flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-fg-muted">
      <Pencil className="size-3" />
      draft
    </span>
  );
}

export function NewSessionButton() {
  return (
    <IconButton label="New session" size="icon-sm" onClick={startNewSession}>
      <Plus />
    </IconButton>
  );
}
