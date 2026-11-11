/**
 * What each QA job is told. Pure: text in, text out (docs/design/qa-pipeline.md §8).
 */
import type { Batching, BugId, Driver, Feature, FeatureId, Launch, Plan, Run, Stage } from "./types";

export interface PromptInputs {
  launch: Launch;
  batching: Batching;
  driver: Driver;
  pairCap: number | null;
  note: string;
  baseUrl: string | null;
  features: readonly Feature[];
  plans: ReadonlyMap<FeatureId, Plan>;
  runs: ReadonlyMap<FeatureId, Run>;
  bugs: ReadonlyMap<BugId, { id: BugId; path: string; title: string; url: string; kind: string; capture: string | null; body: string }>;
  openBugs: ReadonlyArray<{ id: string; title: string; url: string }>;
}

export const qaLabel = (stage: Stage): string => `QA · ${stage}`;

const FEATURES_FILE = "lab/features.md";
const planFile = (id: string): string => `lab/qa/${id}.md`;

const APP = (baseUrl: string | null): string =>
  baseUrl
    ? `The app is running at ${baseUrl}. A step's path is relative to it.`
    : "Find the running app first: check the project's dev servers (devserver_logs shows them) or the README and package scripts for the address. If nothing is running, start the dev server in the background the way the project documents, wait until it answers, and say in your last message that you started it. A step's path is relative to the app's address.";

const BROWSER =
  "Drive the app only through the browser tools, the way a person would: browser_navigate to open a page, browser_snapshot to read what is on it, browser_click, browser_type and browser_press_key to act, browser_screenshot when how it looks matters, browser_console to see errors. Judge by what the page shows, not by reading the code.";

const BUGS = `When something is wrong, call bug_log once per distinct problem, while the problem is on screen (it screenshots the page you are on and keeps the console and the server log): a short title that names what is broken, the steps from the start, what you expected and what happened. bug_log refuses a problem that looks like an open bug and names it: use that id. Never log one problem twice.
Pass feature: <id> to bug_log when you are asked to (several features in one job).
Do not fix anything, do not change any file in the repository, and do not commit. Your job is to find and report.`;

function openBugs(open: PromptInputs["openBugs"]): string {
  if (!open.length) return "There are no open bugs yet.";
  const shown = open.slice(0, 40).map((b) => `- ${b.id}: ${b.title}${b.url ? ` (${b.url})` : ""}`);
  return `These bugs are already open. When what you see is one of them, use its id instead of logging it again:\n${shown.join("\n")}${open.length > shown.length ? `\n(and ${open.length - shown.length} more)` : ""}`;
}

const NOTE = (note: string): string => (note ? `\nThe operator's note:\n${note}\n` : "");

const PLAN_FORMAT = `---
title: <feature title>
---
<one or two sentences: what this flow covers>
## Steps
1. [s-xxxx] <one action>
   path: /page
   expect: <one concrete, checkable result>
Rules: keep the [s-…] id of every step you keep, unchanged. Write new steps WITHOUT an id: ids are added for you.
\`path:\` starts with / and is left out when no page applies. \`expect:\` is concrete (a text, a number, a state), never
"works". No other text after ## Steps.`;

const titleOf = (i: PromptInputs, id: string): string => i.features.find((f) => f.id === id)?.title ?? id;

function featureBlock(i: PromptInputs, id: FeatureId): string {
  const f = i.features.find((x) => x.id === id);
  const where = f?.where.length ? ` It lives on: ${f.where.join(", ")}.` : "";
  return `${f?.summary ? `${f.summary}` : ""}${where}`.trim();
}

function currentPlan(plan: Plan | undefined): string {
  if (!plan || plan.problem) return "";
  const steps = plan.steps.map((s, n) => [`${n + 1}. [${s.id}] ${s.action}`, s.path ? `   path: ${s.path}` : null, s.expected ? `   expect: ${s.expected}` : null].filter((x) => x !== null).join("\n"));
  return ["---", `title: ${plan.title}`, "---", ...(plan.intro ? [plan.intro] : []), "## Steps", ...steps].join("\n");
}

function stepList(run: Run): string {
  return run.steps.map((s) => `- ${s.id}: ${s.action}${s.path ? `\n  page: ${s.path}` : ""}${s.expected ? `\n  expect: ${s.expected}` : ""}`).join("\n");
}

const HOW_TO_RECORD = `How to record: pass (say what you saw in note); fail (bug_log first, or take the id of an open bug that is the same problem, then qa_record with state fail, actual and bug); blocked (note says what blocks it); skip (note says why).`;

const pairText = (cap: number, body: string): string => `\nYou lead a Hydra pair. ${body.replaceAll("{cap}", String(cap))}\n`;

function mapPrompt(i: PromptInputs): string {
  const agent = `Map the user-facing features of this product into \`${FEATURES_FILE}\`, so a test flow can be written and run per feature.
${APP(i.baseUrl)}
${BROWSER}
A feature is one thing a user does, named the way they would say it ("Checkout", "Invite a teammate"). Write the
high-level journeys first; under each, the specific things a user does inside it, marked with \`parent: <journey id>\`
(one level only). Aim for 5 to 40 features in all.
Write ONLY \`${FEATURES_FILE}\`, in exactly this format:
# Features
## Checkout
id: checkout
where: /cart, /checkout
A buyer pays for the cart with a saved or a new card.
## Apply a discount code
id: apply-discount
parent: checkout
where: /cart
A buyer enters a code and sees the total drop.
Rules: \`id:\` lowercase letters, digits and dashes, unique. Keep every existing feature's id exactly. Drop any \`plans:\`
line. Check each feature in the browser.
${BUGS}
No feature is needed for bug_log in this job. Change no other file.
${openBugs(i.openBugs)}${NOTE(i.note)}`;
  if (i.pairCap === null) return agent;
  return (
    agent +
    pairText(
      i.pairCap,
      `Split the product into its top-level areas (navigation sections; at most {cap}). Open one head per
area with subagent_create, isolate: false. Brief each head: "Map the area <name> (<paths>) in the browser: every journey
and every specific thing a user does in it, in the features.md section format above, with parent: lines. Do NOT write
any file. Log broken things with bug_log. Return the sections as text in your final message." Wait for all heads with
subagent_wait. Then YOU write ${FEATURES_FILE} alone: merge the sections, dedupe ids, keep existing ids. Close the heads.`,
    )
  );
}

function planPrompt(i: PromptInputs, ids: readonly FeatureId[]): string {
  const together = i.batching === "together";
  const block = (id: FeatureId): string => {
    const plan = i.plans.get(id);
    const text = currentPlan(plan);
    return `${together ? `Feature "${titleOf(i, id)}" (id ${id}), file \`${planFile(id)}\`:\n` : ""}${featureBlock(i, id)}${text ? `\nThe current plan is below; revise it: keep good steps with their ids, fix wrong ones, add missing ones.\n${text}` : ""}`;
  };
  const head = together
    ? `Write a test flow for each of these features, one file each, in this order:\n${ids.map(block).join("\n\n")}`
    : `Write the test flow for the feature "${titleOf(i, ids[0]!)}" (id ${ids[0]}) to \`${planFile(ids[0]!)}\`.\n${block(ids[0]!)}`;
  const walk = together
    ? "First walk each feature in the browser as a new user: the main path, then wrong, empty and very long input, double\nclicks, back and reload mid-flow, a narrow window, and what a user sees when something fails."
    : "First walk the feature in the browser as a new user: the main path, then wrong, empty and very long input, double\nclicks, back and reload mid-flow, a narrow window, and what a user sees when something fails.";
  const write = together
    ? `Then write each flow: the steps worth running again, in the order a user walks them, including the ones that found a bug.`
    : `Then write the flow: the steps worth running again, in the order a user walks them, including the ones that found a bug.`;
  const only = together ? `Write ONLY ${ids.map((id) => `\`${planFile(id)}\``).join(", ")}, one file per feature. Change no other file and do not commit.` : `Write ONLY \`${planFile(ids[0]!)}\`. Change no other file and do not commit.`;
  const agent = `${head}
${APP(i.baseUrl)}
${BROWSER}
${walk} ${BUGS}${together ? "\nPass feature: <id> to bug_log, with the id of the feature the bug is in." : ""}
${write}
${PLAN_FORMAT}
${only}
${openBugs(i.openBugs)}${NOTE(i.note)}`;
  if (i.pairCap === null) return agent;
  return (
    agent +
    pairText(
      i.pairCap,
      `Open one head per feature with subagent_create, isolate: false (at most {cap} open; open the next
when one finishes). Brief each head with its feature's block above and: "Write ONLY lab/qa/<id>.md. Pass feature: <id>
to bug_log. Do not commit." Heads share the project folder and each writes its own file, so there is nothing to merge.
Wait for every head, read each file, and redo any head that failed or wrote no steps. Close the heads.`,
    )
  );
}

function testPrompt(i: PromptInputs, ids: readonly FeatureId[]): string {
  const together = i.batching === "together";
  const runOf = (id: FeatureId): Run => i.runs.get(id)!;
  const flows = together
    ? `Run these flows one after another, in this order.\n${ids.map((id) => `Flow ${id} (run ${runOf(id).id}): "${titleOf(i, id)}"\n${stepList(runOf(id))}\nPass flow: ${id} to qa_record and feature: ${id} to bug_log.`).join("\n\n")}`
    : `Run the test flow "${titleOf(i, ids[0]!)}" (feature ${ids[0]}, run ${runOf(ids[0]!).id}) in the browser, as a person would by hand.`;
  return `${flows}
${APP(i.baseUrl)}
${BROWSER}
${together ? "" : `Do the steps in order. Record each one with qa_record before going to the next:\n${stepList(runOf(ids[0]!))}\n`}${together ? "Do the steps of each flow in order. Record each one with qa_record before going to the next.\n" : ""}${HOW_TO_RECORD}
Do not record a step you did not try. Do not change any file.
${BUGS}
${openBugs(i.openBugs)}
End with one paragraph: passed, failed, blocked, and the bug ids.${NOTE(i.note)}`;
}

function fixPrompt(i: PromptInputs, ids: readonly BugId[]): string {
  const together = ids.length > 1 || i.batching === "together";
  const brief = (id: BugId): string => {
    const b = i.bugs.get(id);
    if (!b) return `Bug ${id}`;
    return `Bug ${b.id} (${b.path}): ${b.title}\nKind: ${b.kind}   Page: ${b.url}${b.capture ? `   Evidence capture: ${b.capture}` : ""}\n${b.body}`.trim();
  };
  const one = ids.length === 1 ? i.bugs.get(ids[0]!) : undefined;
  const reproduce = one
    ? `Reproduce it first in the browser at ${one.url}, following the steps${one.capture ? ` (read the capture ${one.capture} for the page state, console and requests)` : ""}. If you cannot reproduce it, set \`status: dismissed\` in ${one.path} and add one line under the body saying why, then stop. Otherwise fix the cause, not the symptom; keep the change to what the bug needs; for a visual bug follow DESIGN.md and design/tokens.css. Verify in the browser that it is fixed, then set \`status: shipped\` in ${one.path} and say what you changed. Do not commit.`
    : `For each bug, reproduce it first in the browser at its page, following its steps (read its evidence capture for the page state, console and requests). If you cannot reproduce it, set \`status: dismissed\` in its file and add one line under the body saying why, then go on to the next. Otherwise fix the cause, not the symptom; keep the change to what the bug needs; for a visual bug follow DESIGN.md and design/tokens.css. Verify in the browser that it is fixed, then set \`status: shipped\` in its file and say what you changed. Do not commit.`;
  const lead = together ? "Fix these bugs one at a time, in this order. Finish one (shipped or dismissed) before you\nstart the next." : "Fix this bug.";
  const agent = `${lead}\n${ids.map(brief).join("\n\n")}\n${APP(i.baseUrl)}\n${reproduce}${NOTE(i.note)}`;
  if (i.pairCap === null) return agent;
  return (
    agent +
    pairText(
      i.pairCap,
      `Open one head per bug with subagent_create (its own worktree; at most {cap} open; open the next
when one finishes). Brief each head with its bug and: "Fix the cause in your worktree, add a test when the project has
tests for that code, commit. Do NOT edit lab/findings/." As each head finishes, subagent_merge it, one at a time. If a
merge conflicts, send that head "rebase on the project and retry" and merge it after the others. After each merge,
reproduce the bug's steps in the browser against the running app: fixed → set \`status: shipped\` in its finding file;
not fixed → follow up with the head or fix it yourself; not a bug → \`status: dismissed\` with one line why. Do not end
your turn while a head is open or unmerged. Do not commit.`,
    )
  );
}

const VISIBLE: Record<Stage, string> = {
  map: "Map the product's features.",
  plan: "Write the test flows.",
  test: "Run the test flows in the browser.",
  fix: "Fix the bugs.",
};

export function jobPrompt(i: PromptInputs): { visible: string; title: string; instructions: string } {
  const l = i.launch;
  let instructions: string;
  let first: string;
  switch (l.stage) {
    case "map":
      instructions = mapPrompt(i);
      first = "Features";
      break;
    case "plan":
      instructions = planPrompt(i, l.units);
      first = titleOf(i, l.units[0]);
      break;
    case "test":
      instructions = testPrompt(i, l.units);
      first = titleOf(i, l.units[0]);
      break;
    case "fix":
      instructions = fixPrompt(i, l.units);
      first = i.bugs.get(l.units[0])?.title ?? l.units[0];
      break;
  }
  const more = l.units.length > 1 ? ` +${l.units.length - 1}` : "";
  return { visible: i.note || VISIBLE[l.stage], title: `${qaLabel(l.stage)} · ${first}${more}`.slice(0, 100), instructions };
}
