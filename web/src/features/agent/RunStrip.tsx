/** The live strip above the composer while a turn runs, and the cards that close a turn out. */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, GitBranch, RotateCcw, Square, Timer, Network, Wrench } from "lucide-react";
import type { SessionView, TurnRow } from "@/lib/types";
import type { TranscriptItem } from "@/lib/transcript";
import { money, tokens } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatElapsed, parseDbTime, turnDurationSec } from "./composer-logic";

/** What is happening right now, read off the tail of the transcript. */
export function liveActivity(items: TranscriptItem[]): { tool: { name: string; arg: string; session: string } | null; toolCount: number; thinking: boolean } {
  let tool: { name: string; arg: string; session: string } | null = null;
  let thinking = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!tool && it.type === "tool" && it.status === "running") tool = { name: it.name, arg: it.arg, session: it.session };
    if (it.type === "thinking" && it.active) thinking = true;
    if (tool && thinking) break;
  }
  // Tools used since the last user prompt: the size of this turn's work so far.
  let start = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === "user" || items[i].type === "turn") {
      start = i;
      break;
    }
  }
  const toolCount = items.slice(start).filter((it) => it.type === "tool").length;
  return { tool, toolCount, thinking };
}

export function RunStrip({ session, items, heads, turn, onStop }: { session: SessionView; items: TranscriptItem[]; heads: SessionView[]; turn?: TurnRow; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const started = parseDbTime(turn?.started_at) ?? (session.running_for_sec !== undefined ? Date.now() - session.running_for_sec * 1000 : now);
  const { tool, toolCount, thinking } = liveActivity(items);
  const working = heads.filter((h) => h.status === "running");
  return (
    <div className="flex h-8 shrink-0 animate-slide-up items-center gap-2.5 border-t border-line bg-accent-soft/60 px-3 text-[11.5px]">
      <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {tool ? (
          <>
            <Wrench className="size-3 shrink-0 text-accent" />
            <span className="shrink-0 font-medium text-fg">{tool.name.replace(/^mcp__([^_]+)__/, "$1 ")}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-fg-muted">{tool.arg.replace(/\s+/g, " ")}</span>
          </>
        ) : thinking ? (
          <span className="shimmer-text">Thinking…</span>
        ) : (
          <span className="text-fg-muted">Working…</span>
        )}
      </div>
      {working.length > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-violet" title={working.map((h) => h.role ?? h.engine).join(", ")}>
          <Network className="size-3" />
          {working.length} head{working.length === 1 ? "" : "s"}
        </span>
      )}
      <span className="shrink-0 font-mono text-fg-faint">{toolCount} tool{toolCount === 1 ? "" : "s"}</span>
      <span className="flex shrink-0 items-center gap-1 font-mono text-fg-muted">
        <Timer className="size-3" />
        {formatElapsed((now - started) / 1000)}
      </span>
      <button onClick={onStop} aria-label="Stop" className="flex size-5 shrink-0 items-center justify-center rounded text-fg-muted outline-none hover:bg-red/15 hover:text-red">
        <Square className="size-2.5 fill-current" />
      </button>
    </div>
  );
}

function Stat({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">{children}</span>;
}

/** The card that closes a turn: what it cost and what it changed. */
export function TurnSummary({ session, turn, heads }: { session: SessionView; turn?: TurnRow; heads: SessionView[] }) {
  const secs = turnDurationSec(turn?.started_at, turn?.finished_at);
  const interrupted = turn?.status === "cancelled";
  const all = [session, ...heads];
  const cost = turn?.cost_usd ?? null;
  const inTok = all.reduce((n, s) => n + s.tokens.input, 0);
  const outTok = all.reduce((n, s) => n + s.tokens.output, 0);
  const files = all.reduce((n, s) => n + (s.changes?.files ?? 0), 0);
  const plus = all.reduce((n, s) => n + (s.changes?.insertions ?? 0), 0);
  const minus = all.reduce((n, s) => n + (s.changes?.deletions ?? 0), 0);
  return (
    <div className="animate-slide-up rounded-lg border border-line bg-raised/60 px-3 py-2">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        {interrupted ? <Square className="size-3 fill-amber text-amber" /> : <Check className="size-3.5 animate-pop text-green" strokeWidth={3} />}
        {interrupted ? "Interrupted" : "Finished"}
        {secs !== null && <span className="font-normal text-fg-muted">in {formatElapsed(secs)}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {cost !== null && cost > 0 && <Stat>{money(cost)}</Stat>}
        {(inTok > 0 || outTok > 0) && (
          <Stat>
            {tokens(inTok)} in · {tokens(outTok)} out
          </Stat>
        )}
        {heads.length > 0 && (
          <Stat>
            {heads.length} head{heads.length === 1 ? "" : "s"}
          </Stat>
        )}
        {files > 0 && (
          <Stat>
            <GitBranch className="mr-1 inline size-3" />
            {files} file{files === 1 ? "" : "s"} <span className="text-green">+{plus}</span> <span className="text-red">−{minus}</span>
          </Stat>
        )}
        {session.branch && <Stat>{session.branch}</Stat>}
      </div>
    </div>
  );
}

export function FailureCard({ session, onRetry, retrying }: { session: SessionView; onRetry: () => void; retrying: boolean }) {
  const lines = (session.error ?? "The turn failed.").trim().split("\n");
  return (
    <div role="alert" className="animate-slide-up rounded-lg border border-red/30 bg-red/5 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-red">
        <AlertTriangle className="size-3.5" />
        The turn failed
        <Button size="xs" variant="outline" className="ml-auto" onClick={onRetry} disabled={retrying}>
          <RotateCcw /> Retry
        </Button>
      </div>
      <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-muted">{lines.slice(0, 12).join("\n")}</pre>
    </div>
  );
}
