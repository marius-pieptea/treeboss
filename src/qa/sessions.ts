/**
 * The agent's part of QA. Every kind is one session in the project itself (never a worktree), registered in
 * `qa_sessions` before its first turn so the turn gets the right tools (registry.ts):
 *
 *   draft, suggest   write `lab/qa/<slug>.proposals.md` and nothing else; the operator accepts or rejects each proposal
 *   explore          drives the app in the browser like a user, logs what is broken with bug_log, and writes the walk
 *                    as proposals, so an exploration becomes a plan that can be run again
 *   run              walks one run's steps in the browser and records each outcome with qa_record; a failed step
 *                    links the bug it logged. A run started by an end-to-end batch starts the next plan when it ends
 *   map              writes the feature map, `lab/features.md` (features.ts)
 *
 * At most one QA session works on a plan (or on the feature map) at a time. When a turn ends the driver checks that the
 * session did its work and records why not in `problem`.
 */
import { db } from "../db";
import { UserError } from "../util";
import { browserEnabled } from "../browser/chrome";
import { listFindings } from "../lab/findings";
import { realOf } from "../lab/tables";
import type { LabOpts } from "../lab/sessions";
import { withInstructions } from "../design/sessions";
import { Hub } from "../sessions/hub";
import { createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { advanceBatch, cancelBatch, createBatch, getBatch, latestBatch, type Batch } from "./batches";
import { FEATURES_FILE, featuresSignature, readFeatures } from "./features";
import { formatSource, listPlans, parsePlanSource, proposalsExist, proposalsSignature, QA_DIR, readPlan } from "./plan";
import { FEATURES_KEY, qaRow, type QaRow } from "./registry";
import { getRun, removeRun, startRun } from "./runs";
import { FOCUS, type BatchView, type Focus, type Plan, type PlanSlug, type PlanSource, type QaAsk, type QaSessionInfo, type Run, type RunId } from "./types";

const FOCUS_HINT: Record<Focus, string> = {
  errors: "failures: bad input, rejected requests, server errors, offline, what the user sees and whether they can recover",
  "edge-cases": "boundaries: empty, huge, duplicate and unusual input, double clicks, back button, reload mid-flow",
  mobile: "a narrow screen and touch: layout, tap targets, keyboard overlap, rotation",
  accessibility: "keyboard only, focus order, labels, contrast, screen reader names",
  "empty-states": "no data yet: first-time user, empty lists, zero results",
  permissions: "who may do this: signed out, wrong role, expired session",
};

/** The address of the app under test, when the operator gave one: http(s) only. */
export function parseBaseUrl(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string") throw new UserError("baseUrl must be an address.");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new UserError(`"${v}" is not an address: write it as http://localhost:3000.`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new UserError("baseUrl must be an http or https address.");
  return u.toString().replace(/\/$/, "");
}

export function parseQaAsk(kind: unknown, b: Record<string, unknown>): QaAsk {
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (kind === "draft") {
    const from = parsePlanSource(b.from);
    if (from.kind === "text" && !note) throw new UserError("Describe what to test: a draft from text needs a note.");
    return { kind: "draft", from, note };
  }
  if (kind === "explore") {
    const from = b.from === undefined || b.from === null ? ({ kind: "text" } as PlanSource) : parsePlanSource(b.from);
    return { kind: "explore", from, note, baseUrl: parseBaseUrl(b.baseUrl) };
  }
  const raw = b.focus === undefined ? [] : b.focus;
  if (!Array.isArray(raw)) throw new UserError("focus must be a list.");
  const bad = raw.find((f) => !(FOCUS as readonly unknown[]).includes(f));
  if (bad !== undefined) throw new UserError(`Unknown focus "${String(bad)}": use ${FOCUS.join(", ")}.`);
  return { kind: "suggest", focus: [...new Set(raw as Focus[])], note };
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

function sourceBlock(s: PlanSource): string {
  switch (s.kind) {
    case "spec":
      return `Source: the spec in \`${s.dir}\`. Read every file in that folder (the spec, its tasks, its acceptance criteria) and test what it promises.`;
    case "diff":
      return `Source: the change \`${s.base}..${s.head}\`. Run \`git diff ${s.base}..${s.head}\` and \`git log ${s.base}..${s.head}\`, then read the changed files. Test what a user can see or do differently, plus what the change could have broken nearby.`;
    case "page":
      return `Source: the page \`${s.path}\` of the running app. Open it in the browser with the browser tools (browser_navigate, then browser_snapshot to read it, browser_click to try it) and write the checks a person would do on it. If the app is not running, say so in your last message and write nothing.`;
    default:
      return `Source: the operator's description below (${s.kind}). Read the code the description points at when it helps.`;
  }
}

function stepsBlock(plan: Plan): string {
  if (!plan.steps.length) return "The plan has no steps yet.";
  return `The plan already has these steps. Do not repeat any of them, not even reworded:\n${plan.steps.map((s) => `- ${s.id}: ${s.action}${s.expected ? ` (expect: ${s.expected})` : ""}`).join("\n")}`;
}

/** The proposals file format and its rules, shared by draft, suggest and explore. */
function proposalsBlock(file: string, last: string): string {
  return `Write ONLY the file \`${file}\`. Change nothing else in the repository. If the file already holds proposals, keep them and add yours after them. Use exactly this format:

## Steps
1. Open the cart with two items
   path: /cart
   expect: Both items are listed and the total reads 42.00
   after: start
   why: The plan has no cart check yet

Rules:
- Number the steps 1, 2, 3 in the order they should appear. Do not write ids; they are added for you.
- \`after:\` is \`start\` or the id of an existing plan step. Several steps with the same \`after:\` stay in the order you wrote them, so give a run of new steps the same anchor.
- \`path:\` is the page to open, starting with /. Leave the line out when no page applies.
- \`expect:\` is concrete and checkable: a visible text, a number, a state, an error message. Never "works correctly" or "looks fine".
- \`why:\` is one short line: what this step guards against.
- One line per field. No other text in the file.
- ${last}`;
}

/** Where the app is, or how to find it. */
function appBlock(baseUrl: string | null): string {
  if (baseUrl) return `The app is running at ${baseUrl}. A step's path is relative to it.`;
  return "Find the running app first: check the project's dev servers (devserver_logs shows them) or the README and package scripts for the address. If nothing is running, start the dev server in the background the way the project documents, wait until it answers, and say in your last message that you started it. A step's path is relative to the app's address.";
}

/** The open bugs, so the agent links a problem it sees again instead of logging it twice. */
function openBugsBlock(root: string): string {
  const open = listFindings(root).filter((f) => f.lens === "bug" && (f.status === "new" || f.status === "accepted"));
  if (!open.length) return "There are no open bugs yet.";
  const shown = open.slice(0, 40).map((f) => `- ${f.id}: ${f.title}${f.bug?.url ? ` (${f.bug.url})` : ""}`);
  return `These bugs are already open. When what you see is one of them, use its id instead of logging it again:\n${shown.join("\n")}${open.length > shown.length ? `\n(and ${open.length - shown.length} more)` : ""}`;
}

const BROWSER =
  "Drive the app only through the browser tools, the way a person would: browser_navigate to open a page, browser_snapshot to read what is on it, browser_click, browser_type and browser_press_key to act, browser_screenshot when how it looks matters, browser_console to see errors. Judge by what the page shows, not by reading the code.";

const BUGS = `When something is wrong, call bug_log once per distinct problem, while the problem is on screen (it screenshots the page you are on and keeps the console and the server log): a short title that names what is broken, the steps from the start, what you expected and what happened. bug_log refuses a problem that looks like an open bug and names it: use that id. Never log one problem twice.
Do not fix anything, do not change any file in the repository, and do not commit. Your job is to find and report.`;

function draftPrompt(plan: Plan, ask: Extract<QaAsk, { kind: "draft" | "suggest" }>): string {
  const file = `${QA_DIR}/${plan.slug}.proposals.md`;
  const focus = ask.kind === "suggest" && ask.focus.length ? `\nFocus on these, each one a separate kind of check:\n${ask.focus.map((f) => `- ${f}: ${FOCUS_HINT[f]}`).join("\n")}\n` : "";
  const source = ask.kind === "draft" ? sourceBlock(ask.from) : `Source: the plan "${plan.title}" (${formatSource(plan.source)}). Find what it misses.`;
  const last = ask.kind === "draft" ? "Write the steps a thorough tester would run, ordered as a user would walk through them." : "Write only steps that are missing. If nothing is missing, write the file with the ## Steps heading and no steps.";
  return `You are writing a manual QA plan for "${plan.title}". A person or an agent will run each step in the browser and mark it pass or fail, so each step is one thing to do and one thing to check.

${source}
${focus}
${stepsBlock(plan)}

${proposalsBlock(file, last)}
${ask.note ? `\nThe operator's note:\n${ask.note}\n` : ""}`;
}

function explorePrompt(root: string, plan: Plan, ask: Extract<QaAsk, { kind: "explore" }>): string {
  const file = `${QA_DIR}/${plan.slug}.proposals.md`;
  const start = ask.from.kind === "page" ? `Start at the page \`${ask.from.path}\`.` : ask.from.kind === "text" || ask.from.kind === "manual" ? "" : sourceBlock(ask.from);
  return `You are exploring "${plan.title}" in the running app as a user would, to find what is broken and to turn what you did into a QA plan that can be run again.

${appBlock(ask.baseUrl)}
${start}
${BROWSER}

Walk the main path first, as a new user would. Then try what a careful tester tries: wrong, empty and very long input, double clicks, back and reload in the middle, a narrow window where layout matters, and what a user sees when something fails.

${BUGS}

${openBugsBlock(root)}

When you are done exploring, write the steps worth running again as a plan.
${stepsBlock(plan)}

${proposalsBlock(file, "Write the steps in the order a user walks them, including the ones that found a bug: a run will check them again once the bug is fixed.")}

End with a short summary: what you tried, and the bugs you logged by id.
${ask.note ? `\nWhat the operator wants explored:\n${ask.note}\n` : ""}`;
}

function runPrompt(root: string, plan: Plan, run: Run, ask: Extract<QaAsk, { kind: "run" }>): string {
  const steps = run.steps.map((s) => `- ${s.id}: ${s.action}${s.path ? `\n  page: ${s.path}` : ""}${s.expected ? `\n  expect: ${s.expected}` : ""}`).join("\n");
  return `You are running the QA plan "${plan.title}" (run ${run.id}) in the browser, as a person would by hand.

${appBlock(ask.baseUrl)}
${BROWSER}

Do the steps in order. Record each one with qa_record before you go to the next:
${steps}

How to record a step:
- pass: you did it and saw what it expects. Say in note what you saw.
- fail: it did not do what it expects. Log the bug with bug_log first (or take the id of an open bug that is the same problem), then qa_record with state fail, actual (what happened) and bug (the id).
- blocked: you could not do it (a sign-in or data the step needs is missing, the app is down, an earlier failure stops this one). Say in note what blocks it.
- skip: the step does not apply now. Say why in note.
Do not record a step you did not try. Do not change the steps: if a step is wrong or unclear, do your best reading of it and say so in note.

${BUGS}

${openBugsBlock(root)}

End with one short paragraph: how many steps passed, failed and were blocked, and the bugs by id.
${ask.note ? `\nThe operator's note:\n${ask.note}\n` : ""}`;
}

function mapPrompt(ask: Extract<QaAsk, { kind: "map" }>): string {
  return `Map the user-facing features of this product into \`${FEATURES_FILE}\`, so QA plans can be written and run per feature.

Find the features from the routes, the navigation and menus, the README and the docs. Then open the app in the browser and check each one is really there and how a user reaches it.
${appBlock(ask.baseUrl)}
${BROWSER}

A feature is one thing a user does, named the way they would say it: "Checkout", "Invite a teammate", "Reset a password". It is not a page, a component or an API. Aim for 5 to 30 features, the ones a release could break.

Write ONLY \`${FEATURES_FILE}\`, in exactly this format:

# Features

## Checkout
id: checkout
where: /cart, /checkout
A buyer pays for the cart with a saved or a new card.

Rules:
- \`id:\` lowercase letters, digits and dashes, unique.
- \`where:\` the pages it lives on, starting with /, comma separated.
- After the key lines, one or two sentences from the user's side: what they do and what they get.
- If the file exists, keep every feature in it with its id and its \`plans:\` line exactly as they are (a person or a tool links plans there). Correct its where or its text only when it is wrong, and add the features that are missing.
- Do not change any other file. If you meet something broken on the way, log it with bug_log.
${ask.note ? `\nThe operator's note:\n${ask.note}\n` : ""}`;
}

const VISIBLE: Record<QaAsk["kind"], string> = { draft: "Draft a QA plan.", suggest: "Suggest missing QA steps.", explore: "Explore the app and log what is broken.", run: "Run the QA plan in the browser.", map: "Map the product's features." };
const LABEL: Record<QaAsk["kind"], string> = { draft: "QA · draft", suggest: "QA · suggest", explore: "QA · explore", run: "QA · agent run", map: "QA · feature map" };

export function qaPrompt(plan: Plan, ask: QaAsk, root = ""): { visible: string; instructions: string; label: string } {
  let instructions: string;
  let visible = VISIBLE[ask.kind];
  switch (ask.kind) {
    case "draft":
    case "suggest":
      instructions = draftPrompt(plan, ask);
      visible = ask.kind === "draft" ? `Draft a QA plan from ${ask.from.kind === "text" || ask.from.kind === "manual" ? "this description" : formatSource(ask.from)}.` : `Suggest missing QA steps${ask.focus.length ? ` (${ask.focus.join(", ")})` : ""}.`;
      break;
    case "explore":
      instructions = explorePrompt(root, plan, ask);
      visible = `Explore "${plan.title}" in the app and log what is broken.`;
      break;
    case "run": {
      const run = getRun(ask.run);
      if (!run) throw new UserError(`No run "${ask.run}".`);
      instructions = runPrompt(root, plan, run, ask);
      visible = `Run the QA plan "${plan.title}" in the browser.`;
      break;
    }
    case "map":
      instructions = mapPrompt(ask);
      break;
  }
  return { visible: ask.note || visible, instructions, label: LABEL[ask.kind] };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

const latest = (root: string, key: string): QaRow | null => db().prepare("SELECT * FROM qa_sessions WHERE root_dir = ? AND plan = ? ORDER BY rowid DESC LIMIT 1").get(realOf(root), key) as QaRow | null;

const infoOf = (r: QaRow): QaSessionInfo => ({ sessionId: r.session_id, kind: r.kind, running: getSession(r.session_id)?.status === "running", problem: r.problem, runId: (r.run_id as RunId | null) ?? null, batchId: r.batch_id ?? null });

/** The newest QA session of a plan, whether it is still working, and why its work is unusable if it is. */
export function qaSession(root: string, slug: PlanSlug): QaSessionInfo | null {
  const r = latest(root, slug);
  return r ? infoOf(r) : null;
}

/** The newest feature-map session. */
export function mapSession(root: string): QaSessionInfo | null {
  const r = latest(root, FEATURES_KEY);
  return r ? infoOf(r) : null;
}

/** The agent browser drives explore, run and map: refuse early, with the fix, when it is off. */
function needBrowser(): void {
  if (!browserEnabled()) throw new UserError("The agent browser is off, and this QA session drives the app through it. Turn it on in Settings (or trb config set agent_browser on) and make sure Chrome is installed.");
}

/**
 * Starts a QA session. The agent runs in the project itself, never a worktree: what it writes must appear where the
 * operator is looking. The session is registered before its first turn, so the turn is offered the QA tools.
 */
export function startQaSession(root: string, slug: PlanSlug | null, ask: QaAsk, o: LabOpts = {}): SessionRecord {
  const key = ask.kind === "map" ? FEATURES_KEY : slug;
  if (!key) throw new UserError("A QA session works on a plan.");
  const plan = ask.kind === "map" ? null : readPlan(root, key as PlanSlug);
  if (plan?.problem) throw new UserError(`The plan file cannot be read (${plan.problem}).`);
  if (ask.kind === "explore" || ask.kind === "run" || ask.kind === "map") needBrowser();
  const busy = latest(root, key);
  if (busy && getSession(busy.session_id)?.status === "running") throw new UserError(ask.kind === "map" ? "A session is already mapping the features. Wait for it to finish." : `A QA session is already working on "${key}". Wait for it to finish.`);
  const t = qaPrompt(plan ?? ({ slug: FEATURES_KEY, title: "Features" } as unknown as Plan), ask, root);
  const prompt = withInstructions(t.visible, t.label, t.instructions);
  const sig = ask.kind === "map" ? featuresSignature(root) : proposalsSignature(root, key as PlanSlug);
  const register = (id: string) =>
    db()
      .prepare("INSERT OR REPLACE INTO qa_sessions (session_id, root_dir, plan, kind, problem, proposals_sig, run_id, batch_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(id, realOf(root), key, ask.kind, sig, ask.kind === "run" ? ask.run : null, ask.kind === "run" ? ask.batch : null);
  if (o.sessionId) {
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    setMode(s.id, "build");
    register(s.id);
    return send({ operator: true }, s.id, prompt);
  }
  const title = `${t.label} · ${plan?.title ?? "Features"}`.slice(0, 100);
  return createLead({ prompt, title, cwd: root, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: false, mode: "build", onCreated: register });
}

/** Starts a run of the plan and the agent session that walks it. The run goes again if the session cannot start. */
export function startAgentRun(root: string, slug: PlanSlug, a: { baseUrl?: string | null; note?: string | null; batch?: string | null } = {}, o: LabOpts = {}): { run: Run; session: SessionRecord } {
  const plan = readPlan(root, slug);
  needBrowser();
  if (qaSession(root, slug)?.running) throw new UserError(`A QA session is already working on "${slug}". Wait for it to finish.`);
  const run = startRun(root, plan);
  try {
    const session = startQaSession(root, slug, { kind: "run", run: run.id, note: a.note?.trim() ?? "", baseUrl: a.baseUrl ?? null, batch: a.batch ?? null }, o);
    return { run, session };
  } catch (e) {
    removeRun(run.id);
    throw e;
  }
}

/** A QA turn ended: check that the session did its work, and record why not in `problem`. */
export function finishQaTurn(sessionId: string): QaRow | null {
  const r = qaRow(sessionId);
  if (!r) return null;
  let problem: string | null = null;
  try {
    if (r.kind === "run") problem = runProblem(r);
    else if (r.kind === "map") problem = mapProblem(r);
    else problem = proposalsProblem(r);
  } catch (e) {
    problem = (e as Error).message;
  }
  db().prepare("UPDATE qa_sessions SET problem = ? WHERE session_id = ?").run(problem, sessionId);
  return { ...r, problem };
}

function proposalsProblem(r: QaRow): string | null {
  const plan = readPlan(r.root_dir, r.plan as PlanSlug);
  if (plan.proposalsProblem) return `The proposals file is malformed: ${plan.proposalsProblem}.`;
  if (!proposalsExist(r.root_dir, plan.slug)) return `The agent did not write ${QA_DIR}/${plan.slug}.proposals.md.`;
  if (r.proposals_sig !== null && proposalsSignature(r.root_dir, plan.slug) === r.proposals_sig) return `The agent did not add to ${QA_DIR}/${plan.slug}.proposals.md.`;
  if (!plan.proposals.length && (r.kind === "draft" || r.kind === "explore") && !plan.steps.length) return "The agent wrote no steps.";
  return null;
}

function runProblem(r: QaRow): string | null {
  const run = r.run_id ? getRun(r.run_id as RunId) : null;
  if (!run) return "The run is gone.";
  const left = run.steps.filter((s) => s.outcome.state === "pending").length;
  return left ? `The agent stopped with ${left} of ${run.steps.length} steps not recorded.` : null;
}

function mapProblem(r: QaRow): string | null {
  const map = readFeatures(r.root_dir);
  if (!map.exists) return `The agent did not write ${FEATURES_FILE}.`;
  if (r.proposals_sig !== null && featuresSignature(r.root_dir) === r.proposals_sig) return `The agent did not change ${FEATURES_FILE}.`;
  if (!map.features.length) return `${FEATURES_FILE} lists no features: each one starts with a "## " heading.`;
  return map.problem;
}

/* -------------------------------------------------------------------------- */
/* End-to-end batches                                                         */
/* -------------------------------------------------------------------------- */

const startBatchRun = (root: string, slug: PlanSlug, baseUrl: string | null, opts: LabOpts, batchId: string): void => {
  startAgentRun(root, slug, { baseUrl, batch: batchId }, opts);
};

export function batchView(b: Batch): BatchView {
  const cur = b.current ? latest(b.root, b.current) : null;
  const running = !!cur && cur.batch_id === b.id && getSession(cur.session_id)?.status === "running";
  return { id: b.id, plans: b.plans, next: b.next, current: running ? b.current : null, running, cancelled: b.cancelled, errors: b.errors, createdAt: b.createdAt };
}

export function currentBatch(root: string): BatchView | null {
  const b = latestBatch(root);
  return b ? batchView(b) : null;
}

/**
 * Runs plans one after another with an agent: the plans named, or every plan with steps. Refused while another batch
 * is still running in the project.
 */
export function startBatch(root: string, slugs: PlanSlug[] | null, baseUrl: string | null, o: LabOpts = {}): BatchView {
  needBrowser();
  const open = currentBatch(root);
  if (open?.running) throw new UserError("An end-to-end run is already going in this project. Cancel it or wait for it.");
  const all = listPlans(root);
  const pick = slugs ?? all.filter((p) => !p.problem && p.steps > 0).map((p) => p.slug);
  const known = new Set(all.map((p) => p.slug as string));
  const missing = pick.filter((s) => !known.has(s));
  if (missing.length) throw new UserError(`No plan ${missing.map((s) => `"${s}"`).join(", ")}.`);
  const plans = [...new Set(pick)];
  if (!plans.length) throw new UserError("There is no plan with steps to run.");
  const b = createBatch(root, plans, baseUrl, o);
  return batchView(advanceBatch(b.id, startBatchRun)!);
}

export function stopBatch(root: string, id: string): BatchView | null {
  const b = getBatch(id);
  if (!b || b.root !== realOf(root)) return null;
  return batchView(cancelBatch(id)!);
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

let unsubscribe: (() => void) | null = null;

export function startQaDriver(): void {
  if (unsubscribe) return;
  unsubscribe = Hub.subscribe((e) => {
    if (e.type !== "turn_end") return;
    const r = finishQaTurn(e.sessionId);
    // A batch's run ended: start its next plan. Only the batch's current run moves it on, so a stray turn cannot skip one.
    if (r?.kind === "run" && r.batch_id) {
      const b = getBatch(r.batch_id);
      if (b && b.current === r.plan) advanceBatch(b.id, startBatchRun);
    }
  });
}

export function stopQaDriver(): void {
  unsubscribe?.();
  unsubscribe = null;
}
