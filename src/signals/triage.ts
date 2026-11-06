/**
 * Triage: what the operator does with a signal. Each action writes one durable thing through the module that
 * owns it, and records the link on the signal:
 *
 *   to_finding   a Lab finding file (lab/findings/sig-….md), status new            → status linked
 *   to_roadmap   a roadmap item in the "Next" lane (or a given lane)               → status linked, linked_ref = item id
 *   to_session   a build session that fixes it, the signal in its prompt           → status triaged, meta.session
 *   ignore       nothing; kept so the next sync does not bring it back as new     → status ignored
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { FINDINGS_DIR, findingsDir } from "../lab/findings";
import { addRoadmapItem, createRoadmap, readRoadmap } from "../roadmap/store";
import { createLead, getSession, send } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { resolveRoot } from "../workspaces";
import { getSignal, listSignals, updateSignal } from "./store";
import type { Impact } from "../lab/findings";
import type { Signal } from "./types";

export const TRIAGE_ACTIONS = ["to_finding", "to_roadmap", "to_session", "ignore"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export interface TriageOpts {
  /** to_roadmap: the lane. Default "Next". */
  lane?: string | null;
  /** to_session: engine, model, effort, agent and pair as for any session start. */
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  /** to_session: send into this open session instead of starting one. */
  sessionId?: string | null;
}

export interface TriageResult {
  signal: Signal;
  /** Set for to_finding: workspace-relative path of the finding. */
  finding?: string;
  /** Set for to_roadmap: the item id, e.g. r12. */
  roadmapItem?: string;
  /** Set for to_session: the session that works on it. */
  session?: string;
}

const LENS: Record<Signal["kind"], string> = { error: "review", feedback: "ux", metric: "features" };
const IMPACT: Record<Signal["severity"], Impact> = { critical: "high", high: "high", medium: "medium", low: "low" };

/** The signal as plain text an agent can act on. */
export function signalBrief(s: Signal): string {
  const lines = [`Signal ${s.id} from ${s.source} (${s.kind}, severity ${s.severity}, seen ${s.count} time${s.count === 1 ? "" : "s"}): ${s.title}`];
  if (s.url) lines.push(`Link: ${s.url}`);
  if (s.body.trim()) lines.push("", s.body.trim());
  const meta = JSON.stringify(s.meta);
  if (meta !== "{}") lines.push("", `Details: ${meta.slice(0, 1000)}`);
  return lines.join("\n");
}

/** The finding file for a signal. Written by hand here because lab has no create function; the format is lab/findings.ts's. */
function findingText(s: Signal): string {
  return `---
title: ${JSON.stringify(s.title.slice(0, 140))}
lens: ${LENS[s.kind]}
impact: ${IMPACT[s.severity]}
effort: m
status: new
---
From ${s.source} signal ${s.id}${s.url ? ` (${s.url})` : ""}, seen ${s.count} time${s.count === 1 ? "" : "s"}.

${s.body.trim() || s.title}
`;
}

function toFinding(dir: string, s: Signal): TriageResult {
  const id = `sig-${s.id.replace(/^sig_/, "")}`;
  const rel = `${FINDINGS_DIR}/${id}.md`;
  const abs = path.join(findingsDir(dir), `${id}.md`);
  // The same signal always lands on the same file, so a second triage does not duplicate the finding.
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, findingText(s));
  }
  return { signal: updateSignal(s.id, { status: "linked", linkedRef: rel }), finding: rel };
}

function toRoadmap(dir: string, s: Signal, o: TriageOpts): TriageResult {
  if (!readRoadmap(dir).exists) createRoadmap(dir);
  const description = [s.body.trim(), s.url ? `Link: ${s.url}` : "", `From signal ${s.id} (${s.source}).`].filter(Boolean).join("\n").slice(0, 1500);
  const r = addRoadmapItem(dir, { lane: o.lane?.trim() || "Next", title: s.title.slice(0, 140), description, tags: ["signal", s.source] });
  if (!r.id) throw new UserError("The roadmap did not give the new item an id.");
  return { signal: updateSignal(s.id, { status: "linked", linkedRef: r.id }), roadmapItem: r.id };
}

function toSession(dir: string, s: Signal, o: TriageOpts): TriageResult {
  const prompt = `Investigate and fix this signal.

${signalBrief(s)}

Find the code path first: the link or the culprit in the details points at it. If it cannot be reproduced from the code, say what you checked and stop. When the fix is in and verified, say what you did and which test covers it.`;
  let session;
  if (o.sessionId) {
    const cur = getSession(o.sessionId);
    if (!cur) throw new UserError(`No session "${o.sessionId}".`);
    setMode(cur.id, "build");
    session = send({ operator: true }, cur.id, prompt);
  } else {
    session = createLead({ prompt, title: `Fix: ${s.title}`.slice(0, 100), cwd: dir, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: false, mode: "build" });
  }
  return { signal: updateSignal(s.id, { status: "triaged", meta: { session: session.id } }), session: session.id };
}

/** Act on one signal. The action is one of TRIAGE_ACTIONS; anything else is refused before anything is written. */
export function triageSignal(id: string, action: string, o: TriageOpts = {}): TriageResult {
  if (!(TRIAGE_ACTIONS as readonly string[]).includes(action)) throw new UserError(`Action must be one of ${TRIAGE_ACTIONS.join(", ")}.`);
  const s = getSignal(id);
  if (action === "ignore") return { signal: updateSignal(s.id, { status: "ignored" }) };
  const dir = resolveRoot(s.workspaceId).dir;
  if (action === "to_finding") return toFinding(dir, s);
  if (action === "to_roadmap") return toRoadmap(dir, s, o);
  return toSession(dir, s, o);
}

/**
 * A prompt for an agent to cluster the new signals of a workspace and propose roadmap items. It changes nothing
 * itself: the operator applies the proposals with `trb signals triage`.
 */
export function autoTriagePrompt(workspaceId: string): string {
  const fresh = listSignals(workspaceId, { status: "new" });
  if (!fresh.length) return "There are no new signals to triage. Nothing to do.";
  const lines = fresh.slice(0, 80).map((s) => `- ${s.id} [${s.source}, ${s.kind}, ${s.severity}, seen ${s.count}x] ${s.title}${s.url ? ` ${s.url}` : ""}`);
  const more = fresh.length > 80 ? `\n(${fresh.length - 80} more not listed: run \`trb signals ls --status new\`.)` : "";
  return `Triage the new signals for this project. They come from production errors (Sentry), product metrics (PostHog), what users sent through the feedback widget, and manual notes.

Signals:
${lines.join("\n")}${more}

1. Group the signals that share a cause: the same error in several places, feedback about the same screen, a metric and an error that move together. Name each group in a few words.
2. For each group worth acting on, propose one roadmap item for the Next lane: a title, what is wrong, why it matters now (use the counts), and the signal ids it covers. Check ROADMAP.md first and leave out anything an existing item already covers.
3. Name the noise: signals that are not a product problem, or that a single user caused.
4. Change no files and start no sessions. End with the commands the operator runs to apply your proposals, one representative id per group:
   trb signals triage <id> to_roadmap
   trb signals triage <id> ignore`;
}
