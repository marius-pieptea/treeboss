/**
 * Starting work from a roadmap item.
 *
 *   spec   the specs module's Specify step, seeded from the item: the item's spec folder is created (or the
 *          one it already links to is revised), the item is linked to it straight away, and the session
 *          writes spec.md. From there the item's spec has the usual stepper: clarify, plan, tasks, implement.
 *   build  a build session with the item attached by reference: the prompt names the item, its spec and
 *          docs and says where the roadmap lives; the agent reads what it needs.
 *
 * Both record which item they came from (roadmap_sessions), so the card can show its sessions.
 */
import { UserError } from "../util";
import { createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { startStep } from "../specs/implement";
import { createFeature, listFeatures } from "../specs/store";
import { slugify } from "../specs/templates";
import { ensureItemId, itemOf, readRoadmap, recordSession, updateRoadmapItem, type ItemView } from "./store";

export type StartKind = "spec" | "build";

export interface StartOpts {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  isolate?: boolean;
  /** Send into this open session instead of starting one. */
  sessionId?: string | null;
}

/** What the item says, as plain text an agent can act on. */
export function itemBrief(item: ItemView, roadmapFile: string): string {
  const lines = [`Roadmap item {#${item.id ?? item.key}} in lane "${item.lane}" of ${roadmapFile}: ${item.title}`];
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.target) lines.push(`Target: ${item.target}`);
  if (item.spec) lines.push(`Spec: ${item.spec}${item.links.spec && !item.links.spec.ok ? " (does not exist yet)" : ""}`);
  if (item.docs) lines.push(`Docs: ${item.docs}${item.links.docs && !item.links.docs.ok ? " (does not exist)" : ""}`);
  if (item.description.trim()) lines.push("", "Description:", item.description.trim());
  return lines.join("\n");
}

function buildPrompt(item: ViewWithFile): string {
  const specLine = item.spec
    ? item.links.spec?.ok
      ? `The spec is ${item.links.spec.path}: read spec.md, plan.md and tasks.md there first, work through the open tasks in order, and tick each one (- [x]) in tasks.md when it is done.`
      : `The item points at ${item.spec}, which does not exist; say so before starting.`
    : "The item has no spec. If the work is bigger than a small change, say so and propose writing one first.";
  return `Work on this roadmap item.

${itemBrief(item, item.file)}

${specLine}
${item.docs ? `Read ${item.docs} for context.` : ""}
When it is finished and verified, tick the item in ${item.file} (change its "[ ]" to "[x]") and say what you did.`.trim();
}

type ViewWithFile = ItemView & { file: string };

/** The feature folder a spec session works in: the item's own link when it points at one, else a new feature named after the item (an existing one of that name is reused). */
function featureFor(rootDir: string, itemId: string, item: ItemView): string {
  const linked = item.links.spec?.ok ? item.links.spec.path : null;
  if (linked) return linked.replace(/^specs\//, "");
  const name = slugify(item.title);
  const same = name ? listFeatures(rootDir).find((f) => f.name === name) : null;
  const feature = same ?? createFeature(rootDir, { name: item.title, description: item.description.trim() || item.title });
  updateRoadmapItem(rootDir, itemId, { spec: feature.dir });
  return feature.id;
}

export function startFromItem(rootDir: string, key: string, kind: StartKind, o: StartOpts = {}): { session: SessionRecord; itemId: string } {
  if (kind !== "spec" && kind !== "build") throw new UserError(`Unknown start kind "${kind}": use spec or build.`);
  const itemId = ensureItemId(rootDir, key);
  const file = readRoadmap(rootDir).path;
  const item: ViewWithFile = { ...itemOf(rootDir, itemId), file };

  let session: SessionRecord;
  if (kind === "spec") {
    const feature = featureFor(rootDir, itemId, item);
    session = startStep(rootDir, "specify", { ...o, feature, input: itemBrief(item, file) }).session;
  } else {
    const prompt = buildPrompt(item);
    const title = `Build: ${item.title}`.slice(0, 100);
    if (o.sessionId) {
      const s = getSession(o.sessionId);
      if (!s) throw new UserError(`No session "${o.sessionId}".`);
      setMode(s.id, "build");
      session = send({ operator: true }, s.id, prompt);
    } else {
      session = createLead({ prompt, title, cwd: rootDir, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: o.isolate === true, mode: "build" });
    }
  }
  recordSession(rootDir, itemId, session.id, kind);
  return { session, itemId };
}
