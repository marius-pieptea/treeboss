/**
 * "Natural next step" chips. The agent is asked to end a build turn with up to three `NEXT: label | message` lines
 * (one of them may be `NEXT[opp]:`, an improvement it noticed in the code it worked on);
 * the daemon takes them out of the reply (so they never reach the transcript, the stored output or a handoff
 * summary) and keeps them on the turn, where the UI shows them under the answer.
 */

export interface NextStep {
  /** The chip: two to four words. */
  label: string;
  /** What lands in the composer when the chip is clicked. */
  prompt: string;
  /** An opportunity the agent noticed (performance, a nearby bug, duplication, a gap), not the obvious continuation. */
  opp?: boolean;
}

export const MAX_NEXT_STEPS = 3;
const MAX_LABEL = 32;
const MAX_PROMPT = 400;

export const NEXT_STEPS_INSTRUCTION = [
  "---",
  "After your reply, add up to three lines suggesting what the operator could ask next, each exactly:",
  "`NEXT: <label of two to four words> | <the message to send, one line, written as the operator would write it>`",
  "Make them concrete and grounded in this conversation (a file, a failing test, a decision you left open): the natural continuation of the work.",
  "You may also add at most one improvement you actually noticed in code you read or changed this turn (a performance problem, a bug next to your change, duplicated logic, a missing test or error path), as `NEXT[opp]: <label> | <message>`. Its message must name the file or function you saw it in. Do not search for opportunities and do not guess: if you did not see one, add none.",
  "Add nothing when the work is finished with nothing sensible to follow, or when you are asking the operator a question. Put these lines last and do not mention them.",
].join("\n");

const LINE = /^[ \t]*NEXT(\[opp\])?:[ \t]*(.*?)[ \t]*$/;

/** Drop backticks only when they wrap the whole value; a prompt that starts with a code span keeps it. */
const unwrap = (v: string) => (/^`[^`]*`$/.test(v) ? v.slice(1, -1) : v);

function parse(line: string): NextStep | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const bar = m[2].indexOf("|");
  if (bar < 1) return null;
  const label = unwrap(m[2].slice(0, bar).trim()).slice(0, MAX_LABEL);
  const prompt = unwrap(m[2].slice(bar + 1).trim()).slice(0, MAX_PROMPT);
  return label && prompt ? { label, prompt, ...(m[1] ? { opp: true } : {}) } : null;
}

/** The reply without its `NEXT:` lines, and the steps they held (at most three, one opportunity, no repeats). */
export function extractNextSteps(text: string | null | undefined): { text: string; steps: NextStep[] } {
  const src = String(text ?? "");
  if (!/^[ \t]*NEXT(\[opp\])?:/m.test(src)) return { text: src, steps: [] };
  const steps: NextStep[] = [];
  const kept: string[] = [];
  for (const line of src.split("\n")) {
    if (!LINE.test(line)) {
      kept.push(line);
      continue;
    }
    const step = parse(line);
    if (!step || steps.length >= MAX_NEXT_STEPS) continue;
    if (steps.some((s) => s.label.toLowerCase() === step.label.toLowerCase())) continue;
    if (step.opp && steps.some((s) => s.opp)) continue; // one opportunity at most
    steps.push(step);
  }
  return { text: kept.join("\n").trimEnd(), steps };
}

/** Whether a turn is asked for next steps: a lead's build turn that is not a slash command, a docs run or the setting turned off. */
export function wantsNextSteps(opts: { depth: number; mode: string | null | undefined; slash: boolean; prompt: string; enabled: boolean }): boolean {
  if (!opts.enabled || opts.slash || opts.depth !== 0) return false;
  if (opts.mode === "plan" || opts.mode === "ask") return false;
  // A docs run must end with its own `DOCS_TOUCHED:` line and nothing after it.
  return !opts.prompt.includes("DOCS_TOUCHED:");
}
