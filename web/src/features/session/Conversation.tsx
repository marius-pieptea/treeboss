import { useMemo, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useSessionStream } from "@/lib/session-stream";
import type { SessionView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Transcript } from "@/features/agent/Transcript";
import { FileLinkScope } from "@/features/agent/FileLinks";
import { useHeadActions } from "@/features/heads/actions";
import { conversationItems } from "./display";

/** One session's own conversation, with a box to talk back to it (it resumes with full context). */
export function Conversation({ session, brief }: { session: SessionView; brief: string | null }) {
  const stream = useSessionStream(session.id, { tree: false });
  const actions = useHeadActions();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = session.status === "running" || stream.status[session.id] === "running";
  const items = useMemo(() => conversationItems(stream.transcript.items, { session: session.id, brief, depth: session.depth }), [stream.transcript.items, session.id, session.depth, brief]);
  const labels = useMemo(() => ({ [session.id]: { label: session.role ?? session.engine, depth: 0 } }), [session.id, session.role, session.engine]);

  const send = async () => {
    const text = message.trim();
    if (!text || sending || running) return;
    setSending(true);
    if (await actions.send(session, text)) setMessage("");
    setSending(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!stream.ready ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <FileLinkScope session={session} items={items} running={running}>
            <Transcript items={items} labels={labels} running={running} focusSession={session.id} empty={<div className="p-8 text-center text-xs text-fg-faint">Nothing has been said yet.</div>} />
          </FileLinkScope>
        )}
      </div>
      <div className="shrink-0 border-t border-line bg-panel p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-line bg-raised px-2.5 py-2 transition-colors focus-within:border-accent/60">
          <textarea
            ref={ref}
            value={message}
            rows={1}
            onChange={(e) => {
              setMessage(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={session.status === "closed"}
            placeholder={session.status === "closed" ? "This head is closed" : running ? "Working… interrupt it to redirect" : `Follow up with ${session.role ?? session.engine}…  (Enter to send)`}
            aria-label="Message this head"
            className="max-h-40 min-h-5 flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-fg-faint disabled:opacity-50"
          />
          {running ? (
            <Button size="sm" variant="outline" onClick={() => actions.interrupt(session)} className="text-amber">
              <Square className="fill-current" /> Interrupt
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!message.trim() || sending || session.status === "closed"} onClick={send}>
              {sending ? <Spinner className="text-accent-fg" /> : <Send />} Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
