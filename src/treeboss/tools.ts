/**
 * The spec and roadmap steps the treeboss rules ask for, as tools. The `trb` CLI is not on PATH in a project, so the
 * agent cannot run `trb spec new` or `trb roadmap add`; these tools call the same store functions the CLI and the web
 * call, and nothing is reimplemented here.
 *
 * Offered only to a session in treeboss mode: the shim advertises them when the run carries TRB_TREEBOSS (mcp/store.ts),
 * and the daemon refuses them for any other session, since the connection's session id is the only identity it trusts.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { attach } from "../specs/attach";
import { createFeature } from "../specs/store";
import { addRoadmapItem, addRoadmapLane, createRoadmap, readRoadmap } from "../roadmap/store";
import { getSession } from "../sessions/manager";
import { isTreeboss } from "./store";

export const TREEBOSS_TOOL_NAMES = ["spec_new", "spec_attach", "roadmap_propose"] as const;
export const TREEBOSS_TOOL_SET: ReadonlySet<string> = new Set(TREEBOSS_TOOL_NAMES);

const PROPOSED_LANE = "Proposed";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function treebossToolDefs() {
  return [
    {
      name: "spec_new" as const,
      description:
        "Create a feature's spec: allocates specs/NNN-name/ with a spec.md skeleton and returns its path. Fill that file in with the " +
        "behaviors, flows and screens, then call spec_attach with its path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "The feature's name, for example \"Add export\"." },
          description: { type: "string", description: "What the feature does, in a sentence or two." },
        },
        required: ["name"],
      },
    },
    {
      name: "spec_attach" as const,
      description: "Attach a spec to this session: a spec file or a feature folder, relative to the project (for example specs/001-add-export/spec.md). The treeboss gate needs one attached for a feature or area.",
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string", description: "The spec file or feature folder, relative to the project." } },
        required: ["path"],
      },
    },
    {
      name: "roadmap_propose" as const,
      description:
        "Propose a ROADMAP.md item: an unchecked line in the first lane (or the one named Proposed). Creates ROADMAP.md when the project has none. " +
        "Never check the item off: the operator does that when it ships.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "The item's title, short." },
          spec: { type: "string", description: "The spec's folder, for example specs/001-add-export." },
          docs: { type: "string", description: "The docs page this change updates, relative to the project." },
          description: { type: "string", description: "A line or two under the item." },
        },
        required: ["title"],
      },
    },
  ];
}

/**
 * Run one treeboss tool for the session the shim speaks for. Always text: `Error: ...` for a call the agent can fix.
 * The project is the session's base directory, as for every other tool.
 */
export function executeTreebossTool(name: string, args: Record<string, unknown>, sessionId: string): { text: string } {
  try {
    if (!TREEBOSS_TOOL_SET.has(name)) return { text: `Error: unknown tool "${name}".` };
    const s = getSession(sessionId);
    if (!s) return { text: `Error: no session "${sessionId}".` };
    if (!isTreeboss(sessionId)) return { text: "Error: treeboss mode is off for this session." };
    const root = s.base_cwd;

    switch (name) {
      case "spec_new": {
        const title = str(args.name);
        if (!title) return { text: "Error: name is required." };
        const f = createFeature(root, { name: title, description: str(args.description) });
        return { text: `Created ${f.dir}/spec.md (feature ${f.id}). Fill it in, then attach it with spec_attach, path "${f.dir}/spec.md".` };
      }

      case "spec_attach": {
        const p = str(args.path);
        if (!p) return { text: "Error: path is required: the spec file or feature folder, relative to the project." };
        const a = attach(sessionId, p);
        return { text: `Attached ${a.spec_path} to this session.` };
      }

      case "roadmap_propose": {
        const title = str(args.title);
        if (!title) return { text: "Error: title is required." };
        let state = readRoadmap(root);
        if (!state.exists) state = createRoadmap(root);
        // A roadmap with no lanes gets the Proposed lane; otherwise the lane named Proposed, else the first.
        if (!state.lanes.length) state = addRoadmapLane(root, PROPOSED_LANE);
        const lane = state.lanes.find((l) => l.name.toLowerCase() === PROPOSED_LANE.toLowerCase()) ?? state.lanes[0]!;
        const r = addRoadmapItem(root, {
          lane: lane.name,
          title,
          description: str(args.description) ?? undefined,
          spec: str(args.spec),
          docs: str(args.docs),
        });
        // The line as it now reads in the file, so the agent sees exactly what the operator will see.
        const item = r.state.lanes.flatMap((l) => l.items).find((i) => i.id === r.id);
        const file = fs.readFileSync(path.join(root, r.state.path), "utf-8").split("\n")[(item?.line ?? 1) - 1]?.replace(/\r$/, "") ?? title;
        return { text: `Proposed in ${lane.name} of ${r.state.path}:\n${file}` };
      }
    }
    return { text: `Error: unhandled tool "${name}".` };
  } catch (err: any) {
    if (err instanceof UserError) return { text: `Error: ${err.message}` };
    return { text: `Error: tool "${name}" failed: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}
