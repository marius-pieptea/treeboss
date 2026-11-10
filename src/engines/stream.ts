/**
 * Turns an engine's NDJSON event stream into readable progress lines and
 * recovers the final answer, session id and token usage from it.
 *
 * Ported from Omni's `harness/stream_json.ts` (minus the ACP/devin branches,
 * which this daemon does not drive yet). Two jobs, and the second is the easy
 * one to get wrong: the raw NDJSON must NOT become a turn's `output`. Callers
 * (a lead agent reading `subagent_wait`, a script reading `trb run --json`)
 * want the assistant's final text with the protocol stripped.
 *
 * Shapes handled, each verified against the CLI that emits it:
 *   claude  `--output-format stream-json`: system/init, assistant, user, result, rate_limit_event
 *   codex   `exec --json`: thread.started, item.*, turn.completed|failed
 *   cursor  `-p --output-format stream-json`: tool_call started|completed, thinking, plus claude-shaped
 *   agy     `--output-format stream-json`: { event: init | step_update | result }
 *   opencode `run --format json`: step_start, text, tool_use (completed, self-contained), step_finish
 */
import { truncate } from "../util";
import { compactLine, type ContextSample, type UsageEvent } from "./context";

/** A turn's token consumption, summed. Numbers, not nullables: see `cliUsage()`. */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  numTurns: number;
  /** Only the terminal `result` event carries a cost; an interrupted run has tokens and no cost. */
  totalCostUsd: number | null;
  model: string | null;
}

export const MAX_TURNS_SUBTYPE = "error_max_turns";
export const MAX_TURNS_TERMINAL_REASON = "max_turns";

/**
 * Messages that positively identify a refused resume. Deliberately narrow:
 * matching loosely would turn an ordinary mid-run error into a silent restart
 * from scratch, throwing away the context the resume existed to keep.
 */
export const RESUME_REJECTED_PATTERNS = [
  /no conversation found/i,
  /session .{0,40}not found/i,
  /could not (?:find|resume) session/i,
  /invalid session id/i,
  /--resume.{0,40}(?:invalid|unknown|not found)/i,
  // Codex `exec resume <id>` against a missing thread (codex-cli 0.151.0, stderr, exit 1).
  /no rollout found for thread id/i,
  /thread\/resume failed/i,
];

export function looksLikeResumeRejection(text: string): boolean {
  if (!text) return false;
  return RESUME_REJECTED_PATTERNS.some((re) => re.test(text));
}

export interface StreamAccumulator {
  /** Feed raw stdout chunks. Handles partial lines across chunk boundaries. */
  push(chunk: string): void;
  /** Flush a trailing partial line. Call once the process closes. */
  end(): void;
  /** The `result` field when the stream produced one, else the last assistant text. Never the NDJSON. */
  finalText(): string;
  /** True once a terminal event arrived, i.e. the protocol completed. */
  completed(): boolean;
  /** True when the terminal event reported an error. */
  isError(): boolean;
  /** The engine's session id, so an interrupted turn can be resumed rather than restarted. */
  sessionId(): string | null;
  /** The provider refused the session we asked to resume (retry fresh; the same id would be refused again). */
  resumeRejected(): boolean;
  /** The raw `usage` object from the terminal event, if any. */
  usage(): unknown | null;
  /** Token usage, whether or not the stream reached a terminal event. */
  cliUsage(): StreamUsage | null;
  /** The run stopped at the `--max-turns` ceiling. */
  maxTurnsHit(): boolean;
  /** The latest context-size reading, or null when the engine reports none. */
  context(): ContextSample | null;
  /** Tool calls seen so far. */
  toolCount(): number;
}

function describeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== "") return truncate(input[k]);
    }
    return "";
  };
  switch (name) {
    case "Bash":
    case "bash":
    case "run_command":
      return pick("command", "CommandLine");
    case "Read":
    case "read":
    case "view_file":
      return pick("file_path", "path", "notebook_path", "AbsolutePath");
    case "Write":
    case "write":
    case "write_to_file":
    case "Edit":
    case "edit":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "NotebookEdit":
      return pick("file_path", "path", "notebook_path", "TargetFile");
    case "Glob":
    case "glob":
    case "find_by_name":
    case "Grep":
    case "grep":
    case "grep_search":
      return pick("pattern", "Pattern", "query", "Query");
    case "list_dir":
    case "list":
      return pick("DirectoryPath", "path", "directory");
    case "WebFetch":
    case "webfetch":
      return pick("url", "Url");
    case "WebSearch":
    case "websearch":
    case "search_web":
      return pick("query", "Query");
    case "Task":
      return pick("description", "prompt", "Prompt");
    case "TodoWrite":
    case "todowrite":
      return "";
    default:
      return truncate(input, 100);
  }
}

function extractCursorToolInfo(toolCallObj: any): { name: string; arg: string } {
  if (!toolCallObj || typeof toolCallObj !== "object") return { name: "tool", arg: "" };
  if (toolCallObj.shellToolCall?.args?.command) return { name: "Bash", arg: toolCallObj.shellToolCall.args.command };
  if (toolCallObj.shellToolCall?.description) return { name: "Bash", arg: toolCallObj.shellToolCall.description };
  if (toolCallObj.readFileToolCall?.args?.path) return { name: "Read", arg: toolCallObj.readFileToolCall.args.path };
  if (toolCallObj.writeToFileToolCall?.args?.path) return { name: "Write", arg: toolCallObj.writeToFileToolCall.args.path };
  if (toolCallObj.editFileToolCall?.args?.path) return { name: "Edit", arg: toolCallObj.editFileToolCall.args.path };
  if (toolCallObj.listDirectoryToolCall?.args?.path) return { name: "ListDir", arg: toolCallObj.listDirectoryToolCall.args.path };
  if (toolCallObj.grepToolCall?.args?.pattern) return { name: "Grep", arg: toolCallObj.grepToolCall.args.pattern };
  const keys = Object.keys(toolCallObj);
  if (keys.length > 0) {
    const topKey = keys[0];
    const cleaned = topKey.replace(/ToolCall$/i, "");
    const inner = toolCallObj[topKey]?.args || toolCallObj[topKey];
    return { name: cleaned || topKey, arg: truncate(inner, 80) };
  }
  return { name: "tool", arg: "" };
}

const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

const sizeLabel = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

export function createStreamAccumulator(
  onLine: (line: string) => void,
  /**
   * Fired once, as soon as the session id is known. Load-bearing for resume: the
   * id must be persisted WHILE the turn runs, because the case it exists for is
   * the daemon dying mid-turn.
   */
  onSessionId?: (sessionId: string) => void,
  label: string = "claude",
  extras?: {
    /** The assistant's answer so far, fired each time it grows (a live reply bubble). */
    onText?: (text: string) => void;
    /** Context size readings and compactions, as they happen (see `engines/context.ts`). */
    onUsage?: (e: UsageEvent) => void;
  },
): StreamAccumulator {
  let buffer = "";
  let resultText = "";
  let lastAssistantText = "";
  let agyStepText = "";
  let sawResult = false;
  let errored = false;
  let toolCount = 0;
  let sessionId: string | null = null;
  let sawResumeRejection = false;
  let thinkingStarted = false;
  let resultUsage: unknown | null = null;
  let resultNumTurns: number | null = null;
  let resultCostUsd: number | null = null;
  let sawMaxTurns = false;
  let model: string | null = null;
  // Codex reports usage per turn, so the run total is accumulated here.
  let codexTurns = 0;
  const codexUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  // Set once codex sends exact `token_count` readings, which supersede the per-turn upper bound.
  let codexTokenCount = false;
  // tool_use id -> tool name, so a tool_result can be attributed to its call.
  const pendingTools = new Map<string, string>();
  // Context size: the latest reading, the engine's own window (when it says), and a compaction awaiting its "after".
  let lastContext: ContextSample | null = null;
  let streamWindow: number | null = null;
  let pendingCompact: { from: number | null; trigger: string | null } | null = null;

  const finishCompact = (to: number | null) => {
    if (!pendingCompact) return;
    const { from, trigger } = pendingCompact;
    pendingCompact = null;
    onLine(compactLine(label, from, to));
    extras?.onUsage?.({ kind: "compact", from, to, trigger });
  };
  const noteContext = (sample: ContextSample) => {
    if (sample.tokens <= 0) return;
    if (streamWindow && !sample.window) sample.window = streamWindow;
    // The first reading after a compaction is the "after" of the compaction.
    finishCompact(sample.tokens);
    lastContext = sample;
    extras?.onUsage?.({ kind: "context", sample });
  };
  const sampleOf = (u: any, opts: { totalInput?: boolean; approx?: boolean } = {}): ContextSample | null => {
    if (!u || typeof u !== "object") return null;
    const cacheRead = numOr0(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cached_input_tokens);
    const cacheCreation = numOr0(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? u.cache_write_input_tokens);
    const rawInput = numOr0(u.input_tokens ?? u.inputTokens);
    // OpenAI-shaped usage counts the cached portion inside `input_tokens`.
    const input = opts.totalInput ? Math.max(0, rawInput - cacheRead - cacheCreation) : rawInput;
    const output = numOr0(u.output_tokens ?? u.outputTokens);
    const tokens = input + cacheRead + cacheCreation + output;
    return tokens > 0 ? { tokens, input, cacheRead, cacheCreation, output, approx: opts.approx } : null;
  };

  const setSession = (id: unknown) => {
    if (sessionId || typeof id !== "string" || !id) return;
    sessionId = id;
    onSessionId?.(id);
  };

  const emitText = () => {
    const text = (resultText || lastAssistantText || "").trim();
    if (text) extras?.onText?.(text);
  };

  // agy streams its answer as token-sized `text_delta`s; shown one per line, the chat
  // read as two or three words per line. The step's text is buffered and shown whole.
  const flushAgyStep = () => {
    if (!agyStepText.trim()) return false;
    lastAssistantText = agyStepText;
    onLine(agyStepText.trimEnd());
    emitText();
    agyStepText = "";
    return true;
  };

  /**
   * Per-API-message usage, keyed by `message.id`. ONE API message arrives as
   * SEVERAL `assistant` events (one per content block), each repeating the same
   * id and the same cumulative usage. Summing events naively inflates a turn by
   * the number of content blocks (verified live: 4 events, one id,
   * cache_creation 23125 on every one → 92,500 for a turn that cost 23,125).
   */
  const perMessageUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>();

  const noteMessageUsage = (messageId: string | null, usage: any) => {
    if (!usage || typeof usage !== "object") return;
    const key = messageId || `anon:${perMessageUsage.size}`;
    const next = {
      input: numOr0(usage.input_tokens ?? usage.inputTokens),
      output: numOr0(usage.output_tokens ?? usage.outputTokens),
      cacheRead: numOr0(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
      cacheCreation: numOr0(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
    };
    const prev = perMessageUsage.get(key);
    // Max per field: repeated events carry a snapshot that only grows, so max is
    // right in either arrival order and cannot double-count.
    perMessageUsage.set(
      key,
      prev
        ? {
            input: Math.max(prev.input, next.input),
            output: Math.max(prev.output, next.output),
            cacheRead: Math.max(prev.cacheRead, next.cacheRead),
            cacheCreation: Math.max(prev.cacheCreation, next.cacheCreation),
          }
        : next,
    );
  };

  const summedPerTurn = () => {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const v of perMessageUsage.values()) {
      sum.input += v.input;
      sum.output += v.output;
      sum.cacheRead += v.cacheRead;
      sum.cacheCreation += v.cacheCreation;
    }
    return sum;
  };

  /**
   * Codex reports OpenAI-shaped usage: `input_tokens` is the TOTAL with cached
   * and cache-written portions inside it, the inverse of the Anthropic shape
   * stored here. Normalized once so a sum adds disjoint numbers.
   */
  const normalizeCodexUsage = (usage: unknown) => {
    if (!usage || typeof usage !== "object") return null;
    const u = usage as Record<string, unknown>;
    const total = numOr0(u.input_tokens);
    const cached = numOr0(u.cached_input_tokens);
    const written = numOr0(u.cache_write_input_tokens);
    const output = numOr0(u.output_tokens);
    if (total === 0 && output === 0) return null;
    return {
      input_tokens: Math.max(0, total - cached - written),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
      output_tokens: output,
    };
  };

  const handleEvent = (event: any) => {
    // Every claude/cursor event carries it; the first one wins, and a resumed
    // run reports the continued session rather than a new one.
    setSession(event?.session_id);
    if (!sessionId) setSession(event?.sessionId);

    // codex: exact context readings and compaction notices, when its event stream carries them
    // (`exec --json` forwards turn/item events; the app-server and rollout shapes nest under msg/payload).
    const inner = event?.msg ?? event?.payload ?? event;
    if (inner?.type === "token_count" && inner.info && typeof inner.info === "object") {
      const last = inner.info.last_token_usage ?? inner.info.total_token_usage;
      const s = sampleOf(last, { totalInput: true });
      if (s) {
        codexTokenCount = true;
        const w = numOr0(inner.info.model_context_window);
        if (w > 0) s.window = w;
        noteContext(s);
      }
      return;
    }
    if (inner?.type === "context_compacted" || (event?.type === "item.completed" && event.item?.type === "context_compaction")) {
      finishCompact(null);
      pendingCompact = { from: lastContext?.tokens ?? null, trigger: "auto" };
      return;
    }

    // `type: "result"` is the terminal event. The structural test is the
    // fallback: `type` sits late in that object, so a backend that omitted it
    // would otherwise be dropped silently.
    if (event && typeof event.is_error === "boolean" && (event.type === "result" || event.type === undefined)) {
      sawResult = true;
      errored = event.is_error === true;
      if (event.usage != null) resultUsage = event.usage;
      if (typeof event.num_turns === "number") resultNumTurns = event.num_turns;
      if (typeof event.total_cost_usd === "number") resultCostUsd = event.total_cost_usd;
      // claude reports each model's real window; that beats any table.
      if (event.modelUsage && typeof event.modelUsage === "object") {
        for (const mu of Object.values(event.modelUsage as Record<string, any>)) {
          const w = numOr0(mu?.contextWindow);
          if (w > 0) streamWindow = Math.max(streamWindow ?? 0, w);
        }
        if (streamWindow && lastContext && !lastContext.window) {
          lastContext.window = streamWindow;
          extras?.onUsage?.({ kind: "context", sample: lastContext });
        }
      }
      // Narrow on purpose: only the two fields that positively state the cap.
      // `stop_reason` is "tool_use" on capped AND plenty of healthy runs.
      if (event.subtype === MAX_TURNS_SUBTYPE || event.terminal_reason === MAX_TURNS_TERMINAL_REASON) sawMaxTurns = true;
      if (typeof event.result === "string") {
        resultText = event.result;
        if (errored && RESUME_REJECTED_PATTERNS.some((re) => re.test(resultText))) sawResumeRejection = true;
      }
      const secs = event.duration_api_ms
        ? Math.round(event.duration_api_ms / 1000)
        : event.duration_ms
          ? Math.round(event.duration_ms / 1000)
          : null;
      const tail =
        `${event.num_turns ? ` after ${event.num_turns} turn(s)` : ""}` +
        `${secs !== null ? `, ${secs}s of model time` : ""}` +
        `${toolCount > 0 ? `, ${toolCount} tool call(s)` : ""}`;
      if (sawMaxTurns) {
        onLine(`[${label}] stopped at the turn ceiling${tail} — the work done so far is kept and the session can be continued`);
        return;
      }
      onLine(`[${label}] ${errored ? "failed" : "done"}${tail}`);
      return;
    }

    // Codex `exec --json`. The namespace is disjoint from the claude shapes below.
    if (typeof event?.type === "string" && (event.type.startsWith("thread.") || event.type.startsWith("turn.") || event.type.startsWith("item."))) {
      if (event.type === "thread.started") {
        setSession(event.thread_id);
        return;
      }
      if (event.type === "turn.started") return;

      if (event.type === "item.started" || event.type === "item.updated") {
        const item = event.item;
        if (!item || typeof item !== "object") return;
        // Counted on start only, so item.completed never double-counts a tool.
        if (item.type === "command_execution") {
          if (event.type === "item.started") toolCount++;
          onLine(`[${label}] → $ ${truncate(item.command, 120)}`);
        } else if (item.type === "mcp_tool_call") {
          if (event.type === "item.started") toolCount++;
          onLine(`[${label}] → ${item.server || "mcp"}${item.tool ? `/${item.tool}` : ""}`);
        } else if (item.type === "web_search") {
          if (event.type === "item.started") toolCount++;
          onLine(`[${label}] → web search: ${truncate(item.query, 80)}`);
        } else if (item.type === "reasoning") {
          onLine(`[${label}] (thinking…)`);
        }
        return;
      }

      if (event.type === "item.completed") {
        const item = event.item;
        if (!item || typeof item !== "object") return;
        if (item.type === "agent_message") {
          if (typeof item.text === "string" && item.text.trim()) {
            lastAssistantText = item.text;
            onLine(item.text.trimEnd());
            emitText();
          }
        } else if (item.type === "command_execution") {
          const exit = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
          onLine(`[${label}]   ✓ $ ${truncate(item.command, 80)}${exit}`);
        } else if (item.type === "file_change") {
          const files = (Array.isArray(item.changes) ? item.changes : [])
            .map((c: any) => (typeof c?.path === "string" ? c.path : ""))
            .filter(Boolean)
            .join(", ");
          onLine(`[${label}]   ✓ edit ${truncate(files, 100)}`);
        } else if (item.type === "error") {
          // Carries non-fatal notices too, so it prints without failing the run.
          if (typeof item.message === "string" && item.message) onLine(`[${label}] ⚠ ${truncate(item.message, 200)}`);
        }
        return;
      }

      if (event.type === "turn.completed") {
        sawResult = true;
        errored = false;
        const normalized = normalizeCodexUsage(event.usage);
        if (normalized) {
          // `turn.completed` usage is PER TURN; the run total is accumulated.
          codexUsage.input += normalized.input_tokens;
          codexUsage.output += normalized.output_tokens;
          codexUsage.cacheRead += normalized.cache_read_input_tokens;
          codexUsage.cacheCreation += normalized.cache_creation_input_tokens;
          resultUsage = {
            input_tokens: codexUsage.input,
            output_tokens: codexUsage.output,
            cache_read_input_tokens: codexUsage.cacheRead,
            cache_creation_input_tokens: codexUsage.cacheCreation,
          };
          noteMessageUsage(`codex-turn-${perMessageUsage.size}`, normalized);
          // One turn can make several requests, so this is an upper bound on what the next one starts from.
          const s = sampleOf(event.usage, { totalInput: true, approx: true });
          if (s && !codexTokenCount) noteContext(s);
        }
        codexTurns++;
        onLine(`[${label}] done after ${codexTurns} turn(s)${toolCount > 0 ? `, ${toolCount} tool call(s)` : ""}`);
        return;
      }

      if (event.type === "turn.failed") {
        sawResult = true;
        errored = true;
        const msg = typeof event.error?.message === "string" ? event.error.message : "codex turn failed";
        if (RESUME_REJECTED_PATTERNS.some((re) => re.test(msg))) sawResumeRejection = true;
        onLine(`[${label}] turn failed: ${truncate(msg, 200)}`);
      }
      return;
    }

    // A bare `error` type is too generic to shape-match against every engine.
    if (label === "codex" && event?.type === "error") {
      const msg = typeof event.message === "string" ? event.message : JSON.stringify(event);
      onLine(`[${label}] error: ${truncate(msg, 200)}`);
      return;
    }

    // agy (Antigravity): { event: "init" | "step_update" | "result", ... }
    if (event?.event) {
      setSession(event.conversation_id);
      if (event.event === "init") {
        const tools = Array.isArray(event.init?.tools) ? event.init.tools.length : 0;
        onLine(`[${label}] session started in ${event.init?.cwd || "?"}${tools ? ` (${tools} tools)` : ""}`);
        return;
      }
      if (event.event === "step_update") {
        const su = event.step_update;
        if (!su || typeof su !== "object") return;
        if (su.step_type === "tool") {
          flushAgyStep();
          const toolName = su.tool_name || su.tool_info?.name || "tool";
          if (su.state === "ACTIVE") {
            toolCount++;
            const arg = describeToolInput(toolName, su.tool_info?.parameters || su.tool_info?.arguments || su.tool_info);
            onLine(`[${label}] → ${toolName}${arg ? `(${arg})` : ""}`);
          } else if (su.state === "DONE") {
            onLine(`[${label}]   ✓ ${toolName}`);
          } else if (su.state === "ERROR") {
            const errMsg = su.tool_info?.error?.message || (typeof su.tool_info?.error === "string" ? su.tool_info.error : "error");
            onLine(`[${label}]   ✗ ${toolName}: ${truncate(errMsg, 120)}`);
          }
          return;
        }
        if (su.step_type === "agent_response") {
          if (su.usage) {
            noteMessageUsage(`agy-step-${su.step_index ?? perMessageUsage.size}`, {
              input_tokens: su.usage.input_tokens,
              output_tokens: su.usage.output_tokens,
              cache_read_input_tokens: su.usage.cache_read_tokens || su.usage.cache_read_input_tokens || 0,
              cache_creation_input_tokens: su.usage.cache_creation_tokens || 0,
            });
          }
          if (typeof su.text_delta === "string") {
            agyStepText += su.text_delta;
          }
          if (su.state === "DONE") flushAgyStep();
        }
        return;
      }
      if (event.event === "result") {
        sawResult = true;
        const res = event.result;
        errored = res?.status !== "SUCCESS";
        if (res?.usage != null) resultUsage = res.usage;
        else if (event.usage != null) resultUsage = event.usage;
        if (typeof res?.num_turns === "number") resultNumTurns = res.num_turns;
        if (typeof res?.total_cost_usd === "number") resultCostUsd = res.total_cost_usd;
        if (typeof res?.response === "string") resultText = res.response;
        if (!flushAgyStep() && !lastAssistantText && typeof res?.response === "string" && res.response.trim()) {
          lastAssistantText = res.response;
          onLine(res.response.trimEnd());
          emitText();
        }
        const secs = res?.duration_seconds ? Math.round(res.duration_seconds) : null;
        onLine(
          `[${label}] ${errored ? "failed" : "done"}` +
            `${secs !== null ? `, ${secs}s of model time` : ""}` +
            `${toolCount > 0 ? `, ${toolCount} tool call(s)` : ""}`,
        );
        return;
      }
    }

    // opencode: { type: "step_start" | "text" | "tool_use" | "step_finish", part, sessionID }
    if (
      event?.type === "step_start" ||
      event?.type === "step_finish" ||
      (event?.type === "tool_use" && event?.part) ||
      (event?.type === "text" && event?.part)
    ) {
      setSession(event.sessionID);
      if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.trim()) {
        lastAssistantText += event.part.text;
        onLine(event.part.text.trimEnd());
        emitText();
        return;
      }
      if (event.type === "tool_use") {
        // OpenCode's JSON stream emits tool_use only when the call has finished: input and
        // output live in the same event (`part.state`). Emit start then result so the UI does
        // not leave a permanent "running" spinner.
        toolCount++;
        const toolName = event.part?.tool || "tool";
        const state = event.part?.state && typeof event.part.state === "object" ? event.part.state : {};
        const status = typeof state.status === "string" ? state.status : "completed";
        const arg = describeToolInput(toolName, state.input);
        onLine(`[${label}] → ${toolName}${arg ? `(${arg})` : ""}`);
        if (status === "pending" || status === "running") return;
        if (status === "error" || status === "failed") {
          const err =
            (typeof state.error === "string" && state.error) ||
            (typeof state.output === "string" && state.output) ||
            "error";
          onLine(`[${label}]   ✗ ${toolName}: ${truncate(err, 160)}`);
        } else {
          const raw = typeof state.output === "string" ? state.output : state.output != null ? JSON.stringify(state.output) : "";
          onLine(`[${label}]   ✓ ${toolName}${raw.length > 0 ? ` (${sizeLabel(raw.length)})` : ""}`);
        }
        return;
      }
      if (event.type === "step_finish") {
        const reason = event.part?.reason;
        // Each step reports its own tokens (`input` excludes the cache portions); summed per step id.
        const t = event.part?.tokens;
        if (t && typeof t === "object") {
          noteMessageUsage(`opencode-${event.part?.id ?? perMessageUsage.size}`, {
            input_tokens: t.input,
            output_tokens: t.output,
            cache_read_input_tokens: t.cache?.read,
            cache_creation_input_tokens: t.cache?.write,
          });
        }
        if (t && typeof t === "object") {
          const s = sampleOf({ input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cache?.read, cache_creation_input_tokens: t.cache?.write });
          if (s) noteContext(s);
        }
        if (typeof event.part?.cost === "number" && event.part.cost > 0) resultCostUsd = (resultCostUsd ?? 0) + event.part.cost;
        // "tool-calls" means another model step follows; not a terminal event.
        if (reason === "tool-calls") return;
        sawResult = true;
        errored = reason === "error" || reason === "fail";
        onLine(`[${label}] ${errored ? "failed" : "done"}${toolCount > 0 ? `, ${toolCount} tool call(s)` : ""}`);
        return;
      }
    }

    switch (event?.type) {
      case "system": {
        if (event.subtype === "init") {
          if (typeof event.model === "string" && event.model) model = event.model;
          const tools = Array.isArray(event.tools) ? event.tools.length : 0;
          onLine(
            `[${label}] session started in ${event.cwd || "?"}${event.model ? ` (model: ${event.model})` : ""}${tools ? ` (${tools} tools)` : ""}`,
          );
        }
        if (event.subtype === "compact_boundary") {
          const meta = event.compact_metadata ?? event.compactMetadata ?? {};
          const pre = numOr0(meta.pre_tokens ?? meta.preTokens) || lastContext?.tokens || null;
          finishCompact(null); // a previous one that never saw its "after"
          pendingCompact = { from: pre, trigger: typeof meta.trigger === "string" ? meta.trigger : null };
          return;
        }
        // Hook chatter and session_state_changed are protocol noise.
        return;
      }

      case "thinking": {
        if (event.subtype === "completed") {
          if (!thinkingStarted) onLine(`[${label}] (thinking…)`);
          thinkingStarted = false;
        } else if (event.subtype === "delta" && !thinkingStarted) {
          onLine(`[${label}] (thinking…)`);
          thinkingStarted = true;
        }
        return;
      }

      case "tool_call": {
        if (event.subtype === "started") {
          toolCount++;
          const info = extractCursorToolInfo(event.tool_call);
          if (event.call_id) pendingTools.set(event.call_id, info.name);
          onLine(`[${label}] → ${info.name}${info.arg ? `(${truncate(info.arg, 80)})` : ""}`);
        } else if (event.subtype === "completed") {
          const name = (event.call_id && pendingTools.get(event.call_id)) || "tool";
          if (event.call_id) pendingTools.delete(event.call_id);
          const stdout = event.tool_call?.shellToolCall?.result?.success?.stdout || event.tool_call?.result?.stdout || event.output || "";
          const bytes = typeof stdout === "string" ? stdout.length : 0;
          onLine(`[${label}]   ✓ ${name}${bytes > 0 ? ` (${sizeLabel(bytes)})` : ""}`);
        }
        return;
      }

      case "tool_use": {
        toolCount++;
        const toolName = event.tool_name || event.name || "tool";
        if (event.tool_id || event.id) pendingTools.set(event.tool_id || event.id, toolName);
        const arg = describeToolInput(toolName, event.parameters || event.input);
        onLine(`[${label}] → ${toolName}${arg ? `(${arg})` : ""}`);
        return;
      }

      case "tool_result": {
        const toolId = event.tool_id || event.tool_use_id;
        const name = (toolId && pendingTools.get(toolId)) || event.tool_name || "tool";
        if (toolId) pendingTools.delete(toolId);
        const raw = typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "");
        onLine(`[${label}]   ✓ ${name} (${sizeLabel(raw.length)})`);
        return;
      }

      case "assistant": {
        // Usage first: recorded even for an event whose content is not an array,
        // because the tokens were spent regardless of block shape.
        if (typeof event.message?.model === "string" && event.message.model) model = event.message.model;
        noteMessageUsage(typeof event.message?.id === "string" ? event.message.id : null, event.message?.usage);
        // A subagent's own messages (sidechain) say nothing about this conversation's size.
        if (!event.parent_tool_use_id) {
          const s = sampleOf(event.message?.usage);
          if (s) noteContext(s);
        }
        const content = event.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type === "tool_use") {
            toolCount++;
            if (block.id) pendingTools.set(block.id, block.name || "tool");
            const arg = describeToolInput(block.name || "", block.input);
            onLine(`[${label}] → ${block.name || "tool"}${arg ? `(${arg})` : ""}`);
          } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            lastAssistantText = block.text;
            onLine(block.text.trimEnd());
            emitText();
          } else if (block?.type === "thinking") {
            onLine(`[${label}] (thinking…)`);
          }
        }
        return;
      }

      case "user": {
        const content = event.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          const name = pendingTools.get(block.tool_use_id) || "tool";
          pendingTools.delete(block.tool_use_id);
          const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          if (block.is_error) onLine(`[${label}]   ✗ ${name}: ${truncate(raw, 160)}`);
          // Size rather than content: a tool result is often thousands of lines.
          else onLine(`[${label}]   ✓ ${name} (${sizeLabel(raw.length)})`);
        }
        return;
      }

      case "rate_limit_event": {
        const info = event.rate_limit_info;
        if (!info) return;
        extras?.onUsage?.({ kind: "limits", info });
        const pct = typeof info.utilization === "number" ? Math.round(info.utilization * 100) : null;
        onLine(`[${label}] rate limit: ${info.status || "?"}${info.rateLimitType ? ` (${info.rateLimitType})` : ""}${pct !== null ? ` — ${pct}% used` : ""}`);
        return;
      }

      default:
        return;
    }
  };

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("{")) {
      // Anything printed outside the protocol (a startup warning, a crash) is
      // still worth showing verbatim.
      if (RESUME_REJECTED_PATTERNS.some((re) => re.test(trimmed))) sawResumeRejection = true;
      onLine(trimmed);
      return;
    }
    try {
      handleEvent(JSON.parse(trimmed));
    } catch {
      onLine(trimmed);
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
      flushAgyStep();
      finishCompact(null);
    },
    context: () => lastContext,
    finalText: () => (resultText || lastAssistantText || agyStepText || "").trim(),
    completed: () => sawResult,
    isError: () => errored,
    sessionId: () => sessionId,
    resumeRejected: () => sawResumeRejection,
    usage: () => resultUsage,
    maxTurnsHit: () => sawMaxTurns,
    toolCount: () => toolCount,
    cliUsage() {
      const turnsSeen = perMessageUsage.size;
      const summed = summedPerTurn();
      const summedAny = summed.input + summed.output + summed.cacheRead + summed.cacheCreation > 0;

      // The terminal result wins when it exists: its output count is final,
      // whereas the per-assistant snapshot is taken before the message finishes
      // streaming (measured: 54 summed vs 305 final on the same four turns).
      if (sawResult && resultUsage && typeof resultUsage === "object") {
        const u = resultUsage as Record<string, unknown>;
        const pick = (...keys: string[]): number => {
          for (const k of keys) {
            const v = u[k];
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
          }
          return 0;
        };
        const fromResult = {
          inputTokens: pick("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
          outputTokens: pick("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
          cacheReadInputTokens: pick("cache_read_input_tokens", "cacheReadInputTokens"),
          cacheCreationInputTokens: pick("cache_creation_input_tokens", "cacheCreationInputTokens"),
        };
        const resultAny =
          fromResult.inputTokens + fromResult.outputTokens + fromResult.cacheReadInputTokens + fromResult.cacheCreationInputTokens > 0;
        if (resultAny || !summedAny) {
          return { ...fromResult, numTurns: resultNumTurns ?? turnsSeen, totalCostUsd: resultCostUsd, model };
        }
      }

      // No terminal event (or an empty usage block): the per-turn sum is all
      // there is. This is the interrupted-run case.
      if (!summedAny) return null;
      return {
        inputTokens: summed.input,
        outputTokens: summed.output,
        cacheReadInputTokens: summed.cacheRead,
        cacheCreationInputTokens: summed.cacheCreation,
        numTurns: resultNumTurns ?? turnsSeen,
        totalCostUsd: resultCostUsd,
        model,
      };
    },
  };
}
