/**
 * The subagent tool surface: what a running session can call to open and manage children.
 *
 * One definition, one transport: the `trb mcp-serve` shim (src/mcp/serve.ts) exposes these over
 * MCP to CLI engines, forwarding each call to the daemon, which lands in `executeSubagentTool`.
 * Descriptions are the agent's only manual for these tools: keep them exact.
 */
import { engineIds } from "../engines/registry";
import { UserError, clean } from "../util";
import {
  SessionError,
  close,
  createChild,
  getSession,
  interrupt,
  listForCaller,
  merge,
  overlappingHeads,
  owns,
  send,
  viewSession,
  type Caller,
  type HeadOverlap,
} from "./manager";
import { waitStep, type WaitOutcome } from "./waiting";
import { withReceipt } from "./receipts";

/** Shared by subagent_create, subagent_send and subagent_merge: makes a retry of the same call a no-op. */
const COMMAND_ID_PROP = {
  type: "string",
  description:
    "Optional. A unique id you make for this one call (e.g. a UUID). If you retry a call with the same command_id, you get the first call's result back and nothing is done twice. Use a new id for each new action.",
};

export const SUBAGENT_TOOL_NAMES = ["subagent_create", "subagent_send", "subagent_wait", "subagent_list", "subagent_interrupt", "subagent_close", "subagent_merge"] as const;
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

export interface ToolDef {
  name: SubagentToolName;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export function subagentToolDefs(): ToolDef[] {
  const engines = engineIds().join(", ");
  return [
    {
      name: "subagent_create",
      description:
        "Open a live subagent: a child agent that works on a self-contained brief in parallel while you keep going, and whose final answer " +
        "comes back to you through subagent_wait in this same turn. Returns immediately with its id. Use it to fan work out (several independent " +
        "slices at once), to get a second engine/model's take, or to hand a specialist one bounded job. The brief must stand alone: the child does " +
        "not see your conversation. When a Hydra pair governs this session, heads run on the pair's heads config (or the role you pass) and any " +
        "other engine/model is refused: only the operator changes the pair. The child gets its own git worktree when the workspace is a repo " +
        "(bring its changes back with subagent_merge). Pass `files` (the repo-relative paths or directory prefixes it will touch) so the result can warn you when another open, unmerged head of yours is on the same files: " +
        "that is a warning, not a refusal, and the head still opens. If you get one, merge the other head first, or send this work to that head with subagent_send instead. " +
        "Pass command_id to make the call retry-safe: a retry with the same id returns the first head instead of opening a second. " +
        `Engines: ${engines}.`,
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "Self-contained instructions: the goal, the relevant files/paths and context, constraints, and exactly what to report back." },
          title: { type: "string", description: "Short label for your own bookkeeping." },
          role: { type: "string", description: "Hydra pair role (e.g. scout, worker, reviewer): takes that role's engine/model/effort." },
          agent: { type: "string", description: "A specialized agent to run the head as: its standing instructions, skills and MCP servers apply. Optional; a pair role may already name one." },
          engine: { type: "string", description: `Override the engine. One of: ${engines}. Refused when it is outside a governing Hydra pair.` },
          model: { type: "string", description: "Override the model id for that engine. Refused when it is outside a governing Hydra pair." },
          effort: { type: "string", description: "Override reasoning effort (low, medium, high...)." },
          isolate: { type: "boolean", description: "true/omitted: own git worktree when the workspace is a repo (safe for parallel edits). false: share your workspace directly." },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              'Optional. Repo-relative paths or directory prefixes this head will touch, e.g. ["src/sessions/", "tests/receipts.test.ts"]. Heads of yours that are open and not merged, and that touch the same files, are reported back as a warning. Name what you know; leave it out when you do not know.',
          },
          command_id: COMMAND_ID_PROP,
        },
        required: ["brief"],
      },
    },
    {
      name: "subagent_send",
      description:
        "Send a follow-up to one of your idle subagents. It resumes with its full context (it remembers its brief and previous answer). " +
        "Returns immediately; collect the answer with subagent_wait. Fails if that subagent is still working: wait for it, or interrupt it first. " +
        "Pass command_id to make the call retry-safe: a retry with the same id returns the first result and does not send the message twice.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subagent id from subagent_create." },
          message: { type: "string", description: "The follow-up instruction or answer to its question." },
          command_id: COMMAND_ID_PROP,
        },
        required: ["id", "message"],
      },
    },
    {
      name: "subagent_wait",
      description:
        'Wait for your subagents and get their answers. Blocks until all of `ids` finish (mode "all", default) or the first one does (mode "any"). ' +
        "Omit ids to wait on every subagent you have open. This is ONE call however long the work takes (up to about 15 minutes): it costs you nothing while it blocks, " +
        "so do not poll and do not set a short timeout_sec just to check in. Only if a subagent is still running when that budget ends is it reported as running, " +
        "and then you may call again. Each finished subagent comes back with its final answer, status, changed-file stats and cost. " +
        'An answer an earlier wait already returned is listed under already_delivered, and does not end a mode "any" wait.',
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Subagent ids. Omit to wait on all your open subagents." },
          mode: { type: "string", enum: ["all", "any"], description: "all (default): wait for every id. any: return when the first finishes." },
          timeout_sec: { type: "number", description: "Optional ceiling in seconds for this call. Leave it out to wait for the work to finish (the daemon caps one call at its wait budget)." },
        },
      },
    },
    {
      name: "subagent_list",
      description:
        "List the subagents you opened (open ones by default; include_closed for all). Pass id to get one subagent's full record, including its complete last answer when it was too long to inline.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, include_closed: { type: "boolean" } } },
    },
    {
      name: "subagent_interrupt",
      description:
        "Stop a subagent's current turn. The session survives: a later subagent_send resumes it where it was cut off, and any edits it made in its worktree are kept as a work-in-progress commit.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "subagent_close",
      description:
        "Close a subagent you no longer need (interrupting it first if it is still working). Frees its slot against your cap and removes its worktree. A branch with unmerged changes is kept; merge first if you want them.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "subagent_merge",
      description:
        "Bring a worktree subagent's committed changes into YOUR workspace as uncommitted edits, so you can review and keep them like your own work. " +
        "Applies nothing if the patch conflicts, and says how to resolve it. Not needed for shared-workspace subagents, whose edits are already in place. " +
        "Pass command_id to make the call retry-safe: a retry with the same id returns the first result and does not apply the patch twice.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, command_id: COMMAND_ID_PROP }, required: ["id"] },
    },
  ];
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The warning for one open head that overlaps a new one. Names the head, its files, and what to do instead of a second head. */
function overlapWarning(o: HeadOverlap): string {
  return (
    `Overlaps with your open head ${o.id} "${o.title}" (not merged) on ${o.files.join(", ")}. ` +
    `Merge that head first (subagent_merge) if it is finished and passes, or send this work to it with subagent_send({"id": "${o.id}", "message": "..."}) ` +
    `instead of working the same files in parallel. This head was still opened.`
  );
}

function describeWait(res: Extract<WaitOutcome, { sessions: unknown }>): string {
  if (res.sessions.length === 0) return json({ subagents: [], note: "You have no open subagents." });
  const stillRunning = res.sessions.filter((s) => s.status === "running").map((s) => s.id);
  return json({
    subagents: res.sessions.map((s) => viewSession(s)),
    waited_sec: Math.round(res.elapsedMs / 1000),
    ...(stillRunning.length ? { still_running: stillRunning, note: res.aborted ? "Your turn was interrupted while waiting." : "Some are still working. Call subagent_wait again for them." } : {}),
    ...(res.delivered.length ? { already_delivered: res.delivered, delivered_note: "An earlier subagent_wait already returned these answers: nothing new from them." } : {}),
  });
}

/** One block of subagent_wait: `pending` asks the caller (the MCP shim) to come back with `_resume` for the same wait. */
async function waitText(args: Record<string, unknown>, caller: Caller, resume: string | null): Promise<{ text: string; pending?: string }> {
  try {
    const out = await waitStep(
      {
        ids: Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : [],
        mode: args.mode === "any" ? "any" : "all",
        timeoutSec: typeof args.timeout_sec === "number" ? args.timeout_sec : null,
        resume: resume ?? (typeof args._resume === "string" ? args._resume : null),
      },
      caller,
    );
    if (!("sessions" in out)) return { text: "", pending: out.pending };
    return { text: describeWait(out) };
  } catch (err: any) {
    if (err instanceof SessionError || err instanceof UserError) return { text: `Error: ${err.message}` };
    return { text: `Error: subagent tool "subagent_wait" failed: ${err?.message ?? String(err)}` };
  }
}

/** One daemon request of a tool call. Only subagent_wait can answer `pending`; every other tool is a single step. */
export async function executeSubagentToolStep(name: string, args: Record<string, unknown>, caller: Caller): Promise<{ text: string; pending?: string }> {
  if (name === "subagent_wait") return waitText(args, caller, null);
  return { text: await executeSubagentTool(name, args, caller) };
}

/** Run one subagent tool for `caller`. Always returns text: `Error: ...` for a refusal the agent can act on, never a throw. */
export async function executeSubagentTool(name: string, args: Record<string, unknown>, caller: Caller): Promise<string> {
  try {
    switch (name as SubagentToolName) {
      case "subagent_create":
        return withReceipt(caller, name, args.command_id, () => {
          const s = createChild({
            caller,
            brief: String(args.brief ?? ""),
            title: clean(args.title),
            role: clean(args.role),
            agent: clean(args.agent),
            engine: clean(args.engine),
            model: clean(args.model),
            effort: clean(args.effort),
            isolate: typeof args.isolate === "boolean" ? args.isolate : "auto",
            files: args.files,
          });
          const overlaps = overlappingHeads(s);
          return json({
            ...viewSession(s, { withOutput: false }),
            ...(overlaps.length ? { warnings: overlaps.map(overlapWarning) } : {}),
            next: `Working now. Keep going with your own work, then collect the answer with subagent_wait({"ids": ["${s.id}"]}).`,
          });
        });
      case "subagent_send": {
        const id = clean(args.id);
        if (!id) return "Error: id is required.";
        return withReceipt(caller, name, args.command_id, () => {
          const s = send(caller, id, String(args.message ?? ""));
          return json({ ...viewSession(s, { withOutput: false }), next: `Follow-up delivered. Collect the answer with subagent_wait({"ids": ["${s.id}"]}).` });
        });
      }
      case "subagent_wait": {
        // Direct callers have no shim to chain the blocks: run them to the end here.
        let step = await waitText(args, caller, null);
        while (step.pending) step = await waitText(args, caller, step.pending);
        return step.text;
      }
      case "subagent_list": {
        const id = clean(args.id);
        if (id) {
          const s = getSession(id);
          if (!s || !owns(caller, s)) return `Error: no subagent "${id}" that you opened.`;
          return json({ ...viewSession(s, { full: true }), brief: s.brief });
        }
        return json({ subagents: listForCaller(caller, args.include_closed === true).map((s) => viewSession(s, { withOutput: false })) });
      }
      case "subagent_interrupt": {
        const id = clean(args.id);
        if (!id) return "Error: id is required.";
        return json(viewSession(await interrupt(caller, id), { withOutput: false }));
      }
      case "subagent_close": {
        const id = clean(args.id);
        if (!id) return "Error: id is required.";
        const s = await close(caller, id);
        return json({ ...viewSession(s, { withOutput: false }), note: s.branch ? `Closed. Unmerged branch kept: ${s.branch}.` : "Closed." });
      }
      case "subagent_merge": {
        const id = clean(args.id);
        if (!id) return "Error: id is required.";
        return withReceipt(caller, name, args.command_id, () => {
          const res = merge(caller, id);
          const text = json({ merged: res.merged, message: res.message, files: res.files });
          // Nothing applied (a conflict, or nothing to merge): a retry after the operator fixes it must look again.
          return res.merged ? text : { text, receipt: false };
        });
      }
      default:
        return `Error: unknown subagent tool "${name}".`;
    }
  } catch (err: any) {
    if (err instanceof SessionError || err instanceof UserError) return `Error: ${err.message}`;
    return `Error: subagent tool "${name}" failed: ${err?.message ?? String(err)}`;
  }
}
