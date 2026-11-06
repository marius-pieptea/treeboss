import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, History, MessageSquare, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "@/components/ui/misc";
import { Markdown } from "@/features/agent/Markdown";
import { openSession } from "@/features/agent/agent-commands";
import { get } from "@/lib/api";
import { cn } from "@/lib/utils";
import { exportUrl } from "./logic";
import { useTranscripts } from "./store";

interface ReplayItem {
  kind: "text" | "tool" | "tool_ok" | "tool_err" | "done" | "fail" | "stderr";
  text: string;
  name?: string;
  arg?: string;
}
interface ReplayTurn {
  seq: number;
  status: string;
  mode: string | null;
  started_at: string;
  prompt: string;
  output: string | null;
  items: ReplayItem[];
}
interface Replay {
  session: { id: string; title: string; engine: string; model: string | null; role: string | null; base_cwd: string; created_at: string };
  turns: ReplayTurn[];
}

/** The read-only replay of one session, opened from a search hit (or a session's menu) in the sessions list. */
export function TranscriptsTab() {
  const { sessionId } = useTranscripts();
  return <div className="h-full min-w-0">{sessionId ? <ReplayView key={sessionId} id={sessionId} /> : <Empty icon={<History />} title="No session to replay" hint="Search inside conversations from the sessions list, or choose Replay on a session." className="h-full" />}</div>;
}

function ReplayView({ id }: { id: string }) {
  const { seq, tick } = useTranscripts();
  const replay = useQuery({ queryKey: ["transcript-replay", id], queryFn: () => get<Replay>(`/api/search/sessions/${id}/replay`), staleTime: 10_000 });
  const [flash, setFlash] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Jump to the matched turn once the turns are on screen, and flash it so the eye finds it.
  useEffect(() => {
    if (seq == null || !replay.data) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-turn="${seq}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    setFlash(seq);
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [seq, tick, replay.data]);

  if (replay.isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (replay.error || !replay.data) return <Empty title="Could not load the session" hint={(replay.error as Error | null)?.message} className="h-full" />;
  const { session: s, turns } = replay.data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{s.title}</div>
          <div className="truncate text-[11.5px] text-fg-faint">
            {s.engine}
            {s.model ? ` · ${s.model}` : ""} · {turns.length} turn{turns.length === 1 ? "" : "s"} · {s.created_at} · read-only replay
          </div>
        </div>
        <Button variant="subtle" size="sm" className="ml-auto" onClick={() => openSession(id)} title="Open this session in the agent panel">
          <MessageSquare /> Open session
        </Button>
        <a href={exportUrl(id)} download title="Self-contained HTML; obvious secrets are redacted">
          <Button variant="subtle" size="sm" tabIndex={-1}>
            <Download /> Export HTML
          </Button>
        </a>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-6">
          {turns.map((t) => {
            const tools = t.items.filter((i) => i.kind === "tool");
            const said = t.items.filter((i) => i.kind === "text").map((i) => i.text).join("\n\n") || t.output || "";
            return (
              <section key={t.seq} data-turn={t.seq} className={cn("rounded-lg border border-transparent p-2 transition-colors duration-700", flash === t.seq && "border-amber/50 bg-amber/10")}>
                <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-wide text-fg-faint">
                  Turn {t.seq} · {t.started_at}
                  {t.status !== "completed" ? ` · ${t.status}` : ""}
                </div>
                <div className="whitespace-pre-wrap break-words rounded-lg border border-line bg-raised px-3 py-2 text-[13px]">{t.prompt}</div>
                {tools.length > 0 && (
                  <details className="mt-2 text-[12px] text-fg-muted">
                    <summary className="cursor-pointer select-none">
                      <Wrench className="mr-1 inline size-3" />
                      {tools.length} tool call{tools.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-1 space-y-0.5 font-mono text-[11.5px]">
                      {tools.map((i, k) => (
                        <div key={k} className="truncate">
                          {i.name} {i.arg}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {said && <Markdown text={said} className="mt-2 text-[13px]" />}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
