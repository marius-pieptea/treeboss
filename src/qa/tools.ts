/**
 * Executors for qa_record and bug_log. They run in the daemon for the session the MCP shim speaks for: the project and
 * the run come from that session's registration (registry.ts), never from the arguments, so an agent cannot write
 * into another project or another run. The result is always text: `Error: ...` for a call the agent can fix.
 */
import { BrowserError, act, ctxConsole, getContext } from "../browser/manager";
import { browserEnabled } from "../browser/chrome";
import { logBug, MAX_BUG_NOTE, MAX_BUG_STEP, MAX_BUG_STEPS, MAX_BUG_TITLE } from "../lab/capture";
import { BUG_KINDS, listFindings, noteFinding, readFinding, type BugKind, type Finding } from "../lab/findings";
import { UserError } from "../util";
import { QA_TOOL_SET } from "./defs";
import { qaRow } from "./registry";
import { currentStep, getRun, parseOutcome, setOutcome } from "./runs";
import { stepId } from "./plan";
import type { RunId } from "./types";

export { QA_TOOL_SET };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const STOP = new Set(["the", "and", "for", "with", "not", "does", "doesn", "when", "after", "from", "into", "page", "shows", "this", "that", "are", "was", "but", "its", "has", "have", "can", "cannot"]);
const words = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
};

/**
 * An open bug that is probably the same problem: the same title (ignoring case and punctuation), or a title sharing at
 * least two and half of its words (not counting filler words) with one seen on the same page. Cheap on purpose: the
 * agent can override it with new: true.
 */
export function similarBug(title: string, url: string, open: Finding[]): Finding | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = norm(title);
  const w = words(title);
  const p = pathOf(url);
  for (const f of open) {
    if (norm(f.title) === t) return f;
    if (!p || pathOf(f.bug?.url ?? "") !== p) continue;
    const o = words(f.title);
    const shared = [...w].filter((x) => o.has(x)).length;
    if (shared >= 2 && shared / Math.min(w.size, o.size) >= 0.5) return f;
  }
  return null;
}

function linesOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new UserError("steps must be a list of text lines.");
  const lines = (v as string[]).map((x) => x.replace(/^\s*\d+[.)]\s*/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length > MAX_BUG_STEPS) throw new UserError(`A bug takes at most ${MAX_BUG_STEPS} steps.`);
  if (lines.some((l) => l.length > MAX_BUG_STEP)) throw new UserError(`A step is over ${MAX_BUG_STEP} characters: shorten it.`);
  return lines;
}

async function record(sessionId: string, args: Record<string, unknown>): Promise<string> {
  const r = qaRow(sessionId);
  if (!r || r.kind !== "run" || !r.run_id) return "Error: qa_record is for a QA agent run. In an exploration, log bugs with bug_log and write the steps to the proposals file.";
  const state = str(args.state);
  if (!["pass", "fail", "blocked", "skip"].includes(state)) return 'Error: state must be "pass", "fail", "blocked" or "skip".';
  const run = getRun(r.run_id as RunId);
  if (!run) return `Error: the run ${r.run_id} is gone.`;
  const id = stepId(str(args.step));
  if (!run.steps.some((s) => s.id === id)) return `Error: step ${id} is not in run ${run.id}. Its steps are ${run.steps.map((s) => s.id).join(", ")}.`;
  const bug = str(args.bug);
  if (state === "fail") {
    if (!str(args.actual)) return "Error: a failed step needs actual: what happened instead.";
    if (!bug) return "Error: a failed step needs bug: log it with bug_log first (or use the id of the open bug that is the same problem).";
    try {
      readFinding(r.root_dir, bug);
    } catch {
      return `Error: there is no bug "${bug}" in this project. Use the id bug_log returned.`;
    }
  }
  if ((state === "blocked" || state === "skip") && !str(args.note)) return `Error: a ${state} step needs a note saying why.`;
  const outcome = parseOutcome(state === "fail" ? { state, actual: args.actual, bug } : { state, note: args.note });
  const after = setOutcome(run.id, id, outcome);
  if (state === "fail") noteFinding(r.root_dir, bug, `Seen failing in QA run ${run.id} of plan "${r.plan}", step ${id}.`);
  const done = after.steps.filter((s) => s.outcome.state !== "pending").length;
  const next = currentStep(after);
  return `Recorded ${id}: ${state}. ${done} of ${after.steps.length} steps recorded.${next ? ` Next pending: ${next.id} "${next.action}".` : " Every step is recorded: finish with your summary."}`;
}

async function log(sessionId: string, args: Record<string, unknown>): Promise<string> {
  const r = qaRow(sessionId);
  if (!r) return "Error: bug_log is for QA sessions.";
  if (!browserEnabled()) return "Error: the agent browser is off, so there is no page to log the bug from.";
  const title = str(args.title).replace(/\s+/g, " ");
  if (!title) return "Error: title is required.";
  if (title.length > MAX_BUG_TITLE) return `Error: the title is over ${MAX_BUG_TITLE} characters.`;
  const kind = (args.kind === undefined || args.kind === null ? "functional" : str(args.kind)) as BugKind;
  if (!(BUG_KINDS as readonly string[]).includes(kind)) return `Error: kind must be one of ${BUG_KINDS.join(", ")}.`;
  const steps = linesOf(args.steps);
  const expected = str(args.expected);
  const actual = str(args.actual);
  if (!actual) return "Error: actual is required: what happened.";
  if (expected.length > MAX_BUG_NOTE || actual.length > MAX_BUG_NOTE) return `Error: expected and actual are at most ${MAX_BUG_NOTE} characters each.`;

  const c = await getContext(sessionId);
  const shoot = args.screenshot !== false;
  const page = await act(c, { label: "Logging a bug", actor: "agent", sessionId }, async (p) => ({ url: p.url(), png: shoot ? await p.screenshot({ type: "png", timeout: 10_000 }).catch(() => null) : null }));
  let u: URL;
  try {
    u = new URL(page.url);
  } catch {
    return "Error: the browser is not on a page of the app. Open the page where the bug shows, then log it.";
  }
  if (!/^https?:$/.test(u.protocol)) return "Error: the browser is not on a page of the app. Open the page where the bug shows, then log it.";

  if (args.new !== true) {
    const open = listFindings(r.root_dir).filter((f) => f.lens === "bug" && !f.problem && (f.status === "new" || f.status === "accepted"));
    const same = similarBug(title, page.url, open);
    if (same) return `Not logged: this looks like the open bug ${same.id} "${same.title}"${same.bug?.url ? ` (${same.bug.url})` : ""}. If it is the same problem, use ${same.id}. If it is a different one, call bug_log again with new: true.`;
  }

  const consoleLines = ctxConsole(c, { level: "all" })
    .filter((e) => e.level !== "info")
    .map((e) => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.level}: ${e.text}${e.url ? ` (${e.url})` : ""}`);
  const port = LOOPBACK.has(u.hostname) ? Number(u.port || (u.protocol === "https:" ? 443 : 80)) : null;
  const out = await logBug(r.root_dir, {
    title,
    kind,
    steps,
    expected,
    actual,
    url: page.url,
    port,
    shot: page.png ? { kind: "agent", png: page.png } : { kind: "none" },
    attach: { console: true, logs: true },
    consoleLines,
    byAgent: true,
  });
  const where = r.kind === "run" ? `QA run ${r.run_id} of plan "${r.plan}"` : r.kind === "explore" ? `an exploration of plan "${r.plan}"` : "the feature-map session";
  noteFinding(r.root_dir, out.finding.id, `Found by a QA agent in ${where} (session ${sessionId}). Unconfirmed until a person confirms it.`);
  return `Logged ${out.finding.id} "${out.finding.title}", unconfirmed until a person confirms it.${out.capture ? ` Evidence ${out.capture.id}.` : ""}${shoot && !page.png ? " The screenshot could not be taken." : ""}${out.shotNote ? ` ${out.shotNote}` : ""}${r.kind === "run" ? ` Pass bug: "${out.finding.id}" to qa_record.` : ""}`;
}

export async function executeQaTool(name: string, args: Record<string, unknown>, sessionId: string): Promise<{ text: string }> {
  try {
    if (!QA_TOOL_SET.has(name)) return { text: `Error: unknown tool "${name}".` };
    return { text: name === "qa_record" ? await record(sessionId, args) : await log(sessionId, args) };
  } catch (err: any) {
    if (err instanceof UserError || err instanceof BrowserError) return { text: `Error: ${err.message}` };
    return { text: `Error: ${name} failed: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}
