/**
 * Plan mode: a session that may read, search and ask questions but not change anything.
 *
 * The mode is a column on the session, so it survives a daemon restart and applies to every turn until
 * the operator flips it. Each engine is held read-only by its own flag where it has one (see
 * `engines/registry.ts`); the preamble below is the part every engine gets, so an engine without a
 * switch is still told, and the ones with a switch know what the sandbox is for.
 */
import { db } from "../db";
import { Hub } from "./hub";
import { appendLog, getSession, send, SessionError, type SessionRecord } from "./manager";
import { beginSpecWrite } from "../specs/attach";
import { architectureApproval } from "../specs/prompts";

export type SessionMode = "build" | "plan" | "ask";

export const APPROVE_MESSAGE = "Implement the plan above. Plan mode is off: you may edit files and run commands now.";

export function parseMode(v: unknown): SessionMode | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "plan" || v === "build" || v === "ask") return v;
  throw new SessionError(`Unknown mode "${String(v)}". Use "build", "plan" or "ask".`);
}

/**
 * Prepended to every turn of a plan-mode session, resumed or not: the mode can flip between turns.
 * With the questionnaire tools wired (`tools`), the agent asks through `plan_ask` and hands in the plan
 * with `plan_submit`; without a daemon behind it, it falls back to one batch of questions in plain text.
 */
export function planPreamble(opts: { tools?: boolean; depth?: "quick" | "spec" } = {}): string {
  if (opts.tools) {
    return [
      "# Plan mode",
      "",
      "You are in plan mode, which is read-only. Do not create, edit, move or delete files, install anything, or run a command that changes state.",
      "",
      "1. Explore first with your read-only tools: read files, search, list. (Some engines also allow commands that only inspect, such as git log; none allow a command that changes state.) Learn what the task touches before asking anything.",
      "2. Ask only what the code cannot answer and that changes the plan. Use the `plan_ask` tool (the trb MCP server), ONE question per call, 2 to 4 options, exactly one marked recommended with a one-line reason. Three to six questions in total; fewer if the task is clear. Each call waits for the user, so never batch questions into plain text.",
      "3. When you have enough, call `plan_submit` exactly once with the title, a short summary (mention the user's decisions), ordered steps (each with the files it touches), and the risks. Then stop: write no further text and do not start implementing.",
      "",
      "The daemon saves your plan as a markdown file in the workspace for the user to read, edit and approve: you never write that file, and the plan is not a chat message. After a request for changes, read that file (it may hold the user's edits) and call `plan_submit` again with the whole revised plan; it is saved over the same file as the next version.",
      ...(opts.depth === "spec"
        ? [
            "",
            "This plan becomes a specification feature (`specs/NNN-name/spec.md` and `plan.md`). Write `summary` as what is being built and why, in the requester's terms. Put what the system MUST do in `requirements` and measurable outcomes in `success_criteria`, one line each, and keep `steps` to the implementation approach. Anything you could not settle goes in `open_questions`: each becomes a clarification marker in the spec.",
          ]
        : []),
      "",
      "If the user answers with a note or skips a question, take your recommended option and say so in the summary. If `plan_ask` or `plan_submit` fail or are missing, ask your questions as one numbered message with a recommended answer each, then write the plan as your final message.",
      "",
      "",
    ].join("\n");
  }
  return [
    "# Plan mode",
    "",
    "You are in plan mode, which is read-only. Explore first: read files, search, run commands that only inspect (ls, git log, git diff, a test list). Do not create, edit, move or delete files, install anything, or run a command that changes state.",
    "",
    "If something that changes the plan is unclear, ask the user. Put every question in one message, numbered, at most five, each with your recommended answer, then stop and wait.",
    "Otherwise finish with the plan as your final message: the goal in one line, the approach and why, the files to touch, the steps in order, the risks, and how you will verify it.",
    "Do not start implementing. The user approves the plan first.",
    "",
    "",
  ].join("\n");
}

/** Flip a session's mode. Logged, so the transcript shows where plan mode began and ended. */
export function setMode(id: string, mode: SessionMode): SessionRecord {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  if (s.status === "closed") throw new SessionError(`Session ${id} is closed.`);
  if ((s as any).mode === mode) return s;
  db().prepare("UPDATE sessions SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(mode, id);
  const was = (s as any).mode as SessionMode | undefined;
  if (mode === "ask") appendLog(s, null, "[ask] ask mode on: read-only questions, nothing is written", "info");
  else if (mode === "plan") appendLog(s, null, "[plan] plan mode on: read-only until you approve a plan", "info");
  else appendLog(s, null, was === "ask" ? "[ask] ask mode off: the agent may edit again" : "[plan] plan mode off: the agent may edit again", "info");
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return getSession(id)!;
}

/** The operator approved the plan: leave plan mode and tell the agent to build it. */
export function approvePlan(id: string): SessionRecord {
  const s = getSession(id);
  if (!s) throw new SessionError(`No session "${id}".`);
  if ((s as any).mode !== "plan") throw new SessionError(`Session ${id} is not in plan mode.`);
  if (s.status === "running") throw new SessionError(`Session ${id} is still working. Wait for the plan first.`);
  // An architecture discussion may write the spec files and nothing else (specs/attach.ts).
  const specWrite = beginSpecWrite(id);
  setMode(id, "build");
  return send({ operator: true }, id, specWrite ? architectureApproval() : APPROVE_MESSAGE);
}
