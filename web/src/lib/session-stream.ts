/**
 * Live transcript of a session tree: replays the stored log, then follows the daemon's event stream.
 * One LiveSource per watched session; it stays open across turns (the server only ends it on abort).
 */
import { liveSource, type LiveSource } from "./live";
import { useEffect, useReducer, useRef, useState } from "react";
import { get, url } from "./api";
import { appendLine, buildTranscript, emptyTranscript, type TranscriptState } from "./transcript";
import type { LogLine, SessionStatus, TurnRow } from "./types";

export interface StreamedSession {
  transcript: TranscriptState;
  /** Latest status the stream has seen per session id. */
  status: Record<string, SessionStatus>;
  /** False until the stored log has been loaded: show a skeleton, not an empty chat. */
  ready: boolean;
  turns: TurnRow[];
}

type Action =
  | { type: "reset" }
  | { type: "load"; lines: LogLine[]; turns: TurnRow[]; session: string }
  | { type: "line"; line: LogLine }
  | { type: "lines"; lines: LogLine[] }
  | { type: "status"; session: string; status: SessionStatus }
  | { type: "turns"; turns: TurnRow[]; session: string };

function reducer(state: StreamedSession, a: Action): StreamedSession {
  switch (a.type) {
    case "reset":
      return { transcript: emptyTranscript(), status: {}, ready: false, turns: [] };
    case "load":
      return { ...state, transcript: buildTranscript(a.lines, a.turns, a.session), turns: a.turns, ready: true };
    case "line":
      return { ...state, transcript: appendLine(state.transcript, a.line) };
    case "lines": {
      let transcript = state.transcript;
      for (const line of a.lines) transcript = appendLine(transcript, line);
      return { ...state, transcript };
    }
    case "status":
      return { ...state, status: { ...state.status, [a.session]: a.status } };
    case "turns": {
      // A new turn started: its user prompt belongs before its first line, which may already be in.
      const known = new Set(state.transcript.items.filter((i) => i.type === "user").map((i) => (i as { turnId: string }).turnId));
      const fresh = a.turns.filter((t) => !known.has(t.id));
      if (!fresh.length) return { ...state, turns: a.turns };
      const items = state.transcript.items.slice();
      for (const t of fresh) {
        const at = items.findIndex((i) => "turnId" in i && i.turnId === t.id && i.session === a.session);
        const user = { type: "user" as const, id: `u${t.id}`, session: a.session, turnId: t.id, text: t.prompt };
        if (at === -1) items.push(user);
        else items.splice(at, 0, user);
      }
      return { ...state, turns: a.turns, transcript: { ...state.transcript, items } };
    }
  }
}

/** `tree`: also stream the session's subagents (their lines carry their own session id). */
export function useSessionStream(sessionId: string | null, opts: { tree?: boolean } = {}): StreamedSession {
  const [state, dispatch] = useReducer(reducer, { transcript: emptyTranscript(), status: {}, ready: false, turns: [] });
  const tree = opts.tree ?? true;
  const [epoch, setEpoch] = useState(0);
  const lastId = useRef(0);

  useEffect(() => {
    dispatch({ type: "reset" });
    lastId.current = 0;
    if (!sessionId) return;
    let cancelled = false;
    let es: LiveSource | null = null;
    let flushPending = () => {};
    const sid = sessionId;

    const refreshTurns = async () => {
      const r = await get<{ turns: TurnRow[] }>(url.session(sid, "turns")).catch(() => null);
      if (r && !cancelled) dispatch({ type: "turns", turns: r.turns, session: sid });
    };

    (async () => {
      const [logs, turns] = await Promise.all([get<{ lines: LogLine[] }>(`${url.session(sid, "logs")}?limit=20000${tree ? "&tree=1" : ""}`).catch(() => ({ lines: [] as LogLine[] })), get<{ turns: TurnRow[] }>(url.session(sid, "turns")).catch(() => ({ turns: [] as TurnRow[] }))]);
      if (cancelled) return;
      dispatch({ type: "load", lines: logs.lines, turns: turns.turns, session: sid });
      lastId.current = logs.lines.reduce((m, l) => Math.max(m, l.id), 0);

      es = liveSource(`${url.session(sid, "events")}?since=${lastId.current}${tree ? "&tree=1" : ""}`);
      // A busy turn emits many lines a second: apply them once per frame, not one render each.
      let queued: LogLine[] = [];
      let cancelFlush: (() => void) | null = null;
      flushPending = () => {
        cancelFlush?.();
        cancelFlush = null;
        const lines = queued;
        queued = [];
        if (lines.length && !cancelled) dispatch({ type: "lines", lines });
      };
      es.addEventListener("log", (e) => {
        const l = JSON.parse((e as MessageEvent).data) as LogLine;
        lastId.current = Math.max(lastId.current, l.id);
        queued.push(l);
        if (cancelFlush) return;
        // A hidden page gets no animation frames: use a timer there so lines do not pile up unseen.
        if (document.visibilityState === "visible") {
          const h = requestAnimationFrame(flushPending);
          cancelFlush = () => cancelAnimationFrame(h);
        } else {
          const h = setTimeout(flushPending, 250);
          cancelFlush = () => clearTimeout(h);
        }
      });
      es.addEventListener("state", (e) => {
        flushPending();
        const d = JSON.parse((e as MessageEvent).data);
        dispatch({ type: "status", session: d.sessionId, status: d.status });
      });
      es.addEventListener("turn_start", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        if (d.sessionId === sid) void refreshTurns();
      });
      es.addEventListener("turn_end", (e) => {
        // A finished turn gets its status, output and cost on the turns row: pick them up.
        const d = JSON.parse((e as MessageEvent).data);
        if (d.sessionId === sid) void refreshTurns();
      });
      es.addEventListener("plan", (e) => {
        // The questionnaire's own queries listen for this (features/agent/plan-data.ts).
        const d = JSON.parse((e as MessageEvent).data);
        window.dispatchEvent(new CustomEvent("trb:plan", { detail: d.sessionId }));
      });
      es.onerror = () => {
        // The browser retries on its own with the original `since`; the transcript ignores the overlap.
      };
    })();

    return () => {
      cancelled = true;
      flushPending();
      es?.close();
    };
  }, [sessionId, tree, epoch]);

  // Expose a way to force a reload (after a daemon restart, say) without a new hook.
  useEffect(() => {
    const on = () => setEpoch((n) => n + 1);
    window.addEventListener("trb:reload-streams", on);
    return () => window.removeEventListener("trb:reload-streams", on);
  }, []);

  return state;
}
