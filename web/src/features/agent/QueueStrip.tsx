/** The messages lined up behind the running turn: edit, reorder, remove, or send one now. */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, CornerDownRight, Pencil, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { forSession, preview } from "./queue-logic";
import { sendQueuedNow, useQueue } from "./queue-store";

function EditRow({ text, onSave, onCancel }: { text: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="flex items-start gap-1">
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(5, Math.max(1, value.split("\n").length))}
        aria-label="Edit queued message"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSave(value);
          }
        }}
        className="min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-panel px-2 py-1 text-[12.5px] leading-[1.45] text-fg outline-none focus:border-accent/60"
      />
      <IconButton label="Save (Enter)" size="icon-sm" onClick={() => onSave(value)} disabled={!value.trim()}>
        <Check />
      </IconButton>
      <IconButton label="Cancel (Esc)" size="icon-sm" onClick={onCancel}>
        <X />
      </IconButton>
    </div>
  );
}

export function QueueStrip({ sessionId, running }: { sessionId: string; running: boolean }) {
  const all = useQueue((s) => s.queue);
  const { edit, move, remove } = useQueue.getState();
  const items = forSession(all, sessionId);
  const [editing, setEditing] = useState<string | null>(null);
  if (!items.length) return null;

  return (
    <div role="list" aria-label="Queued messages" className="mx-2.5 -mb-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-t-lg border border-b-0 border-line bg-surface-2/60 px-2 pb-2 pt-1.5">
      <div className="flex items-center gap-1.5 pb-0.5 text-[10.5px] uppercase tracking-wide text-fg-faint">
        {items.length} queued
        <span className="normal-case tracking-normal">{running ? "· sent in order as each turn finishes" : "· waiting: the last turn was stopped or failed"}</span>
      </div>
      {items.map((m, i) => (
        <div key={m.id} role="listitem" className="group flex min-w-0 items-center gap-1 py-0.5 text-[12.5px] text-fg">
          {editing === m.id ? (
            <div className="min-w-0 flex-1">
              <EditRow
                text={m.text}
                onSave={(t) => {
                  edit(m.id, t);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <>
              <span className="w-4 shrink-0 text-right font-mono text-[10.5px] text-fg-faint">{i + 1}</span>
              <span className={cn("min-w-0 flex-1 truncate", m.design && "text-fg-muted")} title={m.text}>
                {m.design ? <span className="mr-1 font-mono text-[10.5px] text-accent">design</span> : null}
                {preview(m.text)}
              </span>
              <span className="flex shrink-0 items-center opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <IconButton label="Move up" size="icon-xs" disabled={i === 0} onClick={() => move(m.id, -1)}>
                  <ArrowUp />
                </IconButton>
                <IconButton label="Move down" size="icon-xs" disabled={i === items.length - 1} onClick={() => move(m.id, 1)}>
                  <ArrowDown />
                </IconButton>
                <IconButton label="Edit" size="icon-xs" onClick={() => setEditing(m.id)}>
                  <Pencil />
                </IconButton>
                <IconButton label={running ? "Stop the turn and send this now" : "Send now"} size="icon-xs" onClick={() => void sendQueuedNow(m.id, running)}>
                  <CornerDownRight />
                </IconButton>
                <IconButton label="Remove" size="icon-xs" onClick={() => remove(m.id)}>
                  <X />
                </IconButton>
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
