/**
 * Turns a progress line (as written by the stream accumulator) into a typed item the UI can render:
 * assistant text, a tool call, a tool result, thinking, a status line.
 *
 * Done by reading the line rather than threading metadata through every engine's parser: the lines are
 * all produced in one place (stream.ts) in a fixed shape, and the log stays human-readable for
 * `trb logs`. The cost is that assistant prose which happens to start with "[claude] →" would be read as a
 * tool call; that is vanishingly rare and only affects how a line is drawn.
 */
import { parseCompactLine } from "./context";

export type LineKind = "text" | "tool" | "tool_ok" | "tool_err" | "thinking" | "done" | "fail" | "info" | "stderr";

export interface LineMeta {
  kind: LineKind;
  /** tool / tool_ok / tool_err */
  name?: string;
  /** The one most useful argument: a path, a command, a pattern. */
  arg?: string;
  /** Size of a tool result, as printed ("2.0 KB"). */
  size?: string;
  /** The tail of an error or the summary of a done line. */
  detail?: string;
  /** An automatic or manual context compaction: tokens before and after (null when not reported). */
  compact?: { from: number | null; to: number | null };
}

export function classifyLine(line: string): LineMeta {
  if (line.startsWith("[stderr]")) return { kind: "stderr", detail: line.slice(8).trim() };
  if (/^\[(trb|worktree)\]/.test(line)) return { kind: "info", detail: line.replace(/^\[\w+\]\s*/, "") };

  const m = /^\[([\w-]+)\]\s+(.*)$/s.exec(line);
  if (!m) return { kind: "text" };
  const rest = m[2];

  if (rest.startsWith("(thinking")) return { kind: "thinking" };

  const compacted = parseCompactLine(rest);
  if (compacted) return { kind: "info", detail: rest, compact: compacted };

  if (rest.startsWith("→ ")) {
    const body = rest.slice(2);
    // `Name(arg)`, `$ command`, `server/tool`, `web search: q`, or a bare name.
    const call = /^([^\s(]+)\((.*)\)$/s.exec(body);
    if (call) return { kind: "tool", name: call[1], arg: call[2] };
    if (body.startsWith("$ ")) return { kind: "tool", name: "Bash", arg: body.slice(2) };
    if (body.startsWith("web search: ")) return { kind: "tool", name: "WebSearch", arg: body.slice(12) };
    return { kind: "tool", name: body.trim() };
  }

  // The header regex already swallowed the indentation after `[engine]`.
  const res = /^(✓|✗)\s+(.*)$/s.exec(rest);
  if (res) {
    const ok = res[1] === "✓";
    const body = res[2];
    // `Name (2.0 KB)`  |  `Name: error text`  |  `$ cmd (exit 0)`  |  `edit a.ts, b.ts`
    const sized = /^(.*?)\s+\(([0-9.]+ (?:B|KB))\)$/.exec(body);
    if (sized) return { kind: ok ? "tool_ok" : "tool_err", name: sized[1], size: sized[2] };
    const err = /^([^:]+):\s+(.*)$/s.exec(body);
    if (err && !ok) return { kind: "tool_err", name: err[1], detail: err[2] };
    return { kind: ok ? "tool_ok" : "tool_err", name: body };
  }

  if (/^(done|failed|stopped (at|by user)|turn failed|error:)/.test(rest)) {
    return { kind: /^(failed|turn failed|error:)/.test(rest) ? "fail" : "done", detail: rest };
  }
  if (/^(session started|rate limit|⚠|mode →|plan:|session:)/.test(rest)) return { kind: "info", detail: rest };
  return { kind: "info", detail: rest };
}
