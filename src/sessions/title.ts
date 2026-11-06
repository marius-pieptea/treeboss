/**
 * Session titles written by the agent itself. A lead's first turn is asked to call `session_title` once, before
 * anything else: the model already has the prompt and the project in context, so naming the work costs one short
 * tool call, not a second turn or a second model. The call carries the title as an argument, so nothing is parsed
 * out of the visible answer.
 *
 * Until then the title is the plain one (the prompt's first line). The tool only replaces that plain title: an
 * operator's rename, or an earlier call, is never overwritten. An engine that cannot call MCP tools, or a model
 * that skips the call, simply leaves the plain title.
 */
import { db } from "../db";
import { Hub } from "./hub";

export const TITLE_TOOL_NAMES = ["session_title"] as const;

/** The first-turn instruction. Only sent where the tool is actually offered. */
export const TITLE_INSTRUCTION =
  "Before anything else, call the `session_title` tool once with a title of 3 to 7 words that says what this session's task is. " +
  "Do not mention the title or the call in your reply.";

const MAX_TITLE = 100;

/** A session's title: the explicit one, else the first line of `text`; on one line, at most 100 characters. */
export function sessionTitle(explicit: string | null | undefined, text: string): string {
  return (explicit || text.split("\n")[0]).replace(/\s+/g, " ").slice(0, MAX_TITLE);
}

/** The title a session has until something names it: the first line of what it was asked (none, when it was asked nothing). */
export const plainTitle = (text: string | null | undefined): string => sessionTitle(null, text ?? "");

/** An agent's title as a session title: its first non-empty line, unquoted, no closing full stop. Null when under 3 characters are left. */
export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const title = line
    .replace(/^["'`“”‘’]+|["'`“”‘’.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
  return title.length >= 3 ? title : null;
}

export function titleToolDefs() {
  return [
    {
      name: "session_title" as const,
      description:
        "Name this session. Call it once, on your first turn, before other work: a title of 3 to 7 words that says what the task is " +
        "(for example \"Fix session list ordering\"). It only works while the session still has its plain title: after the operator " +
        "renames it, or after your first call, it changes nothing.",
      inputSchema: {
        type: "object" as const,
        properties: { title: { type: "string", description: "3 to 7 words, no quotes, no full stop." } },
        required: ["title"],
      },
    },
  ];
}

interface TitleRow {
  id: string;
  root_id: string;
  status: string;
  depth: number;
  title: string;
  brief: string;
}

/** Run `session_title` for the session the shim speaks for. Always text: `Error: ...` only for a call the agent can fix. */
export function executeTitleTool(name: string, args: Record<string, unknown>, sessionId: string): { text: string } {
  if (name !== "session_title") return { text: `Error: unknown tool "${name}".` };
  const s = db().prepare("SELECT id, root_id, status, depth, title, brief FROM sessions WHERE id = ?").get(sessionId) as TitleRow | undefined;
  if (!s) return { text: "Error: this session no longer exists." };
  if (s.depth !== 0) return { text: "Error: only the lead session has a title. Carry on with your brief." };
  const title = cleanTitle(String(args.title ?? ""));
  if (!title) return { text: "Error: give a title of 3 to 7 words." };
  // Only the plain title is replaced, and the UPDATE repeats that check, so a rename made this instant still wins.
  const taken = { text: `The session already has a title ("${s.title}"). Carry on with the task.` };
  if (s.title !== plainTitle(s.brief)) return taken;
  if (db().prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ?").run(title, s.id, s.title).changes === 0) return taken;
  // The sidebar and header refetch on state events.
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: s.status });
  return { text: "Title set. Carry on with the task." };
}
