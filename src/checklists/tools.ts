/**
 * The Lab tool a checklist pass uses: checklist_record writes one item's answer. It is not treeboss mode's tool: the trb MCP
 * server offers it when the run carries TRB_CHECKLISTS (mcp/store.ts), which the session manager sets for a session the
 * Lab registered as a checklist pass (lab/tables.ts), and the daemon refuses it for any other session.
 *
 * Like the treeboss tools, the result is always text: `Error: ...` for a call the agent can fix. The store does the work
 * (store.ts recordResult), so the rules for evidence, na, manual items and ticked items live in one place.
 */
import { UserError } from "../util";
import { checklistSessionWorkspace } from "../lab/tables";
import { recordResult, type AgentStatus } from "./store";

export const CHECKLIST_TOOL_NAMES = ["checklist_record"] as const;
export const CHECKLIST_TOOL_SET: ReadonlySet<string> = new Set(CHECKLIST_TOOL_NAMES);

const STATUSES: readonly AgentStatus[] = ["pass", "fail", "na"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function checklistToolDefs() {
  return [
    {
      name: "checklist_record" as const,
      description:
        "Record your answer for one launch checklist item: pass, fail or na. Give the evidence you read (file and line, such as app/page.tsx:12, or a URL) and a note. " +
        "na needs a reason in note. Use fail with a note when you cannot verify an item. Manual items are not recorded: a person decides them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          checklist: { type: "string", description: "The checklist's id, in brackets in the audit prompt, for example marketing-site." },
          item: { type: "string", description: "The item's id, in brackets after its text in the audit prompt, for example meta-title." },
          status: { type: "string", enum: [...STATUSES], description: "pass, fail, or na (not applicable: give the reason in note)." },
          evidence: { type: "string", description: "The file and line you read, such as app/page.tsx:12, or a URL you measured. Required for pass." },
          note: { type: "string", description: "What you saw, in a sentence. Required for na and for fail." },
        },
        required: ["checklist", "item", "status"],
      },
    },
  ];
}

/**
 * Runs one checklist tool for the session the shim speaks for. Refused unless that session is a registered checklist pass:
 * the workspace comes from the registration, never from the arguments.
 */
export function executeChecklistTool(name: string, args: Record<string, unknown>, sessionId: string): { text: string } {
  try {
    if (!CHECKLIST_TOOL_SET.has(name)) return { text: `Error: unknown tool "${name}".` };
    const workspaceId = checklistSessionWorkspace(sessionId);
    if (!workspaceId) return { text: "Error: checklist_record is for checklist audit sessions only." };
    const status = str(args.status);
    if (!status || !STATUSES.includes(status as AgentStatus)) return { text: 'Error: status must be "pass", "fail" or "na".' };
    const checklist = str(args.checklist);
    const item = str(args.item);
    if (!checklist || !item) return { text: "Error: checklist and item are required: the ids in brackets in the audit prompt." };
    const r = recordResult(workspaceId, {
      checklistId: checklist,
      itemId: item,
      status: status as AgentStatus,
      evidence: str(args.evidence),
      note: str(args.note),
    });
    return { text: `Recorded ${checklist}/${r.id}: ${r.status}${r.evidence ? ` (${r.evidence})` : ""}.` };
  } catch (err: any) {
    if (err instanceof UserError) return { text: `Error: ${err.message}` };
    return { text: `Error: checklist_record failed: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}
