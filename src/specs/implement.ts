/**
 * Starting work from a spec: a step of the workflow, "implement" as a goal-mode session, "implement in
 * parallel" as a lead with heads, one task, and an architecture discussion.
 *
 * Every function takes the workspace directory (the daemon resolves it from a root reference) and starts
 * or continues ordinary sessions: nothing here has a runtime of its own. The specs travel with the session
 * as attachments (see attach.ts), so the next turn, a handoff and the checkbox bookkeeping all find them.
 */
import fs from "fs";
import path from "path";
import { HydraPairs, type HydraPair } from "../hydra/pairs";
import { getDaemonContext } from "../sessions/context";
import { goalBlock, setGoal, type GoalInput } from "../sessions/goal";
import { setMode } from "../sessions/plan";
import { createChild, createLead, getSession, send, SessionError, type SessionRecord } from "../sessions/manager";
import { UserError } from "../util";
import { attach, type AttachPurpose } from "./attach";
import { architecturePrompt, headTasksBrief, STEP_LABEL, stepPrompt, taskPrompt, type StepName } from "./prompts";
import { type FeatureInfo, requireFeature } from "./store";
import { CONSTITUTION_PATH } from "./templates";
import { parallelGroups, parseTasks, taskLine, type SpecTask } from "./tasks";

export interface RunOpts {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  isolate?: boolean;
  /** Continue in this open session instead of starting one. */
  sessionId?: string | null;
}

export interface SpecAttachSpec {
  path: string;
  mode?: "ref" | "inline";
  purpose?: AttachPurpose;
  state?: string | null;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function constitutionExists(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, CONSTITUTION_PATH));
}

/** What a session working from a feature gets attached: the constitution (if there is one) and the feature folder. */
function specsFor(rootDir: string, feature: FeatureInfo | null, purpose: AttachPurpose): SpecAttachSpec[] {
  const out: SpecAttachSpec[] = [];
  if (constitutionExists(rootDir)) out.push({ path: CONSTITUTION_PATH, purpose });
  if (feature) out.push({ path: feature.dir, purpose });
  return out;
}

function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function requireOpenSession(rootDir: string, id: string): SessionRecord {
  const s = getSession(id);
  if (!s) throw new UserError(`No session "${id}".`);
  if (s.status === "closed") throw new UserError(`Session ${id} is closed.`);
  if (realOf(s.base_cwd) !== realOf(rootDir)) throw new UserError(`Session ${id} works in ${s.base_cwd}, not in this workspace.`);
  return s;
}

/** The same prompt, wherever it goes: a new lead, or a message into the session already open. */
function launch(rootDir: string, prompt: string, title: string, o: RunOpts, specs: SpecAttachSpec[], extra: { mode?: "plan" | "build"; goal?: GoalInput | null } = {}): SessionRecord {
  if (o.sessionId) {
    const s = requireOpenSession(rootDir, o.sessionId);
    for (const a of specs) attach(s.id, a.path, { mode: a.mode, purpose: a.purpose, state: a.state });
    if (extra.mode) setMode(s.id, extra.mode);
    if (extra.goal) {
      setGoal(s.id, extra.goal, { kickoff: false });
      return send({ operator: true }, s.id, `${prompt}\n\n${goalBlock({ text: extra.goal.text, check_cmd: extra.goal.check ?? null, max_turns: extra.goal.maxTurns ?? 12, max_minutes: extra.goal.maxMinutes ?? 60 })}`);
    }
    return send({ operator: true }, s.id, prompt);
  }
  return createLead({
    prompt,
    title,
    cwd: rootDir,
    engine: o.engine,
    model: o.model,
    effort: o.effort,
    agent: o.agent,
    pairId: o.pairId,
    isolate: o.isolate,
    mode: extra.mode ?? null,
    goal: extra.goal ?? null,
    specs,
  });
}

/* -------------------------------------------------------------------------- */
/* Workflow steps                                                             */
/* -------------------------------------------------------------------------- */

const NEEDS: Partial<Record<StepName, { file: keyof FeatureInfo["files"]; said: string }>> = {
  clarify: { file: "spec", said: "Specify first: there is no spec.md yet." },
  plan: { file: "spec", said: "Specify first: there is no spec.md yet." },
  tasks: { file: "plan", said: "Plan first: there is no plan.md yet." },
  analyze: { file: "spec", said: "Specify first: there is no spec.md yet." },
  implement: { file: "tasks", said: "Run the tasks step first: there is no tasks.md yet." },
};

export function checkStep(step: StepName, feature: FeatureInfo | null): void {
  if (step === "constitution") return;
  if (!feature) throw new UserError(`The ${STEP_LABEL[step]} step needs a feature.`);
  const need = NEEDS[step];
  if (need && !feature.files[need.file]) throw new UserError(need.said);
}

export function startStep(rootDir: string, step: StepName, o: RunOpts & { feature?: string | null; input?: string | null }): { session: SessionRecord; feature: FeatureInfo | null } {
  const feature = step === "constitution" ? null : o.feature ? requireFeature(rootDir, o.feature) : null;
  checkStep(step, feature);
  if (step === "implement") return { session: startImplement(rootDir, feature!.id, o).session, feature };
  // The agent asks in its reply: the questionnaire tool only exists in plan mode, and these steps write files.
  const prompt = stepPrompt(step, { feature, input: o.input, askTool: false });
  const title = step === "constitution" ? "Constitution" : `${STEP_LABEL[step]}: ${feature!.title}`;
  const specs = step === "constitution" ? (constitutionExists(rootDir) ? [{ path: CONSTITUTION_PATH, purpose: "step" as const }] : []) : specsFor(rootDir, feature, "step");
  return { session: launch(rootDir, prompt, title.slice(0, 100), o, specs), feature };
}

/* -------------------------------------------------------------------------- */
/* Implement                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The goal's check: tasks.md exists and holds no open checkbox. With a test command, that must pass too.
 * It runs in the session's own directory (which may be a worktree), so it is an awk script and not the
 * parser; it follows the parser's rules: a checkbox inside a fenced block is not a task, and one with no
 * description is not either.
 */
const OPEN_TASKS_AWK = "/^[[:space:]]*(```|~~~)/{f=!f;next} !f&&/^[[:space:]]*[-*+][[:space:]]*\\[ \\][[:space:]]*[^[:space:]]/{o=1} END{exit o}";

export function implementCheck(featureDir: string, test?: string | null): string {
  const f = shq(`${featureDir}/tasks.md`);
  const base = `test -f ${f} && awk ${shq(OPEN_TASKS_AWK)} ${f}`;
  const t = String(test ?? "").trim();
  return t ? `${base} && ( ${t} )` : base;
}

function openTasks(rootDir: string, f: FeatureInfo): { tasks: SpecTask[]; open: SpecTask[]; total: number } {
  const parsed = parseTasks(fs.readFileSync(path.join(rootDir, f.dir, "tasks.md"), "utf-8"));
  if (parsed.total === 0) throw new UserError(`${f.dir}/tasks.md has no tasks yet. Run the Tasks step first.`);
  const open = parsed.tasks.filter((t) => !t.done);
  if (!open.length) throw new UserError(`All ${parsed.total} tasks in ${f.dir}/tasks.md are already done.`);
  return { tasks: parsed.tasks, open, total: parsed.total };
}

export interface ImplementOpts extends RunOpts {
  /** A command that must also pass for the goal to count as met (the project's tests). */
  test?: string | null;
  maxTurns?: number | null;
  maxMinutes?: number | null;
  input?: string | null;
}

function goalFor(f: FeatureInfo, open: number, total: number, o: ImplementOpts): GoalInput {
  return {
    text: `Complete every open task in ${f.dir}/tasks.md (${open} of ${total} are open), in order, ticking each as it is done and verified.${o.test?.trim() ? ` The project's checks must pass: ${o.test.trim()}.` : ""}`,
    check: implementCheck(f.dir, o.test),
    maxTurns: o.maxTurns ?? Math.min(40, Math.max(12, Math.ceil(open / 2))),
    maxMinutes: o.maxMinutes ?? (open > 20 ? 120 : 60),
  };
}

/** A build session in goal mode: it keeps going until tasks.md has no open boxes (and the tests pass). */
export function startImplement(rootDir: string, featureRef: string, o: ImplementOpts = {}): { session: SessionRecord; feature: FeatureInfo; open: number } {
  const feature = requireFeature(rootDir, featureRef);
  checkStep("implement", feature);
  const { open, total } = openTasks(rootDir, feature);
  const prompt = [stepPrompt("implement", { feature, input: o.input }), "", "Open now (in order):", ...open.slice(0, 8).map((t) => `- ${taskLine(t)}`), ...(open.length > 8 ? [`- … and ${open.length - 8} more in the file`] : [])].join("\n");
  const session = launch(rootDir, prompt, `Implement: ${feature.title}`.slice(0, 100), o, specsFor(rootDir, feature, "implement"), { goal: goalFor(feature, open.length, total, o) });
  return { session, feature, open: open.length };
}

export interface ParallelResult {
  /** "parallel" when heads were opened, "sequential" when it fell back and why. */
  mode: "parallel" | "sequential";
  note: string | null;
  session: SessionRecord;
  heads: Array<{ id: string; tasks: string[] }>;
  skipped: Array<{ tasks: string[]; reason: string }>;
}

function headsPair(o: ImplementOpts): { pair: HydraPair | null; why: string | null } {
  if (o.pairId) {
    const p = HydraPairs.find(o.pairId);
    if (!p) throw new UserError(`No Hydra pair "${o.pairId}". See \`trb pair list\`.`);
    if (p.mode !== "heads") throw new UserError(`Pair "${p.title}" runs heads by role. Pick a heads pair, or open the heads from the lead yourself.`);
    return { pair: p, why: null };
  }
  const all = HydraPairs.list().filter((p) => p.mode === "heads");
  if (all.length === 0) return { pair: null, why: "No Hydra pair with heads is configured, so this runs sequentially. Create one under Settings → Hydra pairs to fan out." };
  if (all.length > 1) throw new UserError(`Several heads pairs exist (${all.map((p) => p.title).join(", ")}): choose one.`);
  return { pair: all[0], why: null };
}

/**
 * One head per group of `[P]` tasks in the first open parallel run, under a lead that merges and carries on.
 * Falls back to the sequential goal session, and says why, when there is no heads pair or nothing to
 * parallelise.
 */
export function startImplementParallel(rootDir: string, featureRef: string, o: ImplementOpts & { maxHeads?: number | null } = {}): ParallelResult {
  const feature = requireFeature(rootDir, featureRef);
  checkStep("implement", feature);
  const { open, total } = openTasks(rootDir, feature);
  const sequential = (note: string): ParallelResult => ({ mode: "sequential", note, session: startImplement(rootDir, feature.id, o).session, heads: [], skipped: [] });

  if (o.sessionId) throw new UserError("Parallel implement starts its own lead: pick a heads pair instead of an open session.");
  const { pair, why } = headsPair(o);
  if (!pair) return sequential(why!);
  const maxHeads = Math.max(1, Math.min(o.maxHeads ?? pair.max_heads ?? 4, 8));
  const groups = parallelGroups(parseTasks(fs.readFileSync(path.join(rootDir, feature.dir, "tasks.md"), "utf-8")), maxHeads);
  if (groups.length < 2) return sequential("There is no run of two or more open [P] tasks in one phase, so this runs sequentially.");

  const ids = groups.map((g) => g.map((t) => t.id ?? `line ${t.line + 1}`));
  const prompt = [
    stepPrompt("implement", { feature, input: o.input }),
    "",
    "## You are leading",
    `Heads have been opened for you, one per group of parallel tasks (see \`subagent_list\`):`,
    ...ids.map((g, i) => `- head ${i + 1}: ${g.join(", ")}`),
    "",
    "Wait for them with `subagent_wait`, read each result, check the work, and `subagent_merge` what is good. The heads do not tick tasks.md: you do, after merging, for the tasks that really landed.",
    "Then carry on with the remaining open tasks yourself, in order (open more heads for a later run of `[P]` tasks if it pays off). End every reply with `TASKS_DONE:` and the ids that are finished and merged.",
  ].join("\n");

  const lead = createLead({
    prompt,
    title: `Implement (parallel): ${feature.title}`.slice(0, 100),
    cwd: rootDir,
    engine: o.engine,
    model: o.model,
    effort: o.effort,
    agent: o.agent,
    pairId: pair.id,
    isolate: o.isolate,
    goal: goalFor(feature, open.length, total, o),
    specs: specsFor(rootDir, feature, "implement"),
  });

  const heads: ParallelResult["heads"] = [];
  const skipped: ParallelResult["skipped"] = [];
  groups.forEach((g, i) => {
    try {
      const child = createChild({ caller: { operator: true }, parentId: lead.id, brief: headTasksBrief(feature, g), title: `${ids[i].join(", ")}: ${g[0].text}`.slice(0, 100) });
      attach(child.id, feature.dir, { purpose: "head", delivered: true });
      heads.push({ id: child.id, tasks: ids[i] });
    } catch (err: any) {
      skipped.push({ tasks: ids[i], reason: err instanceof SessionError || err instanceof UserError ? err.message : String(err?.message ?? err) });
    }
  });
  return { mode: "parallel", note: skipped.length ? `${skipped.length} group(s) could not get a head: ${skipped.map((s) => s.reason).join(" | ")}` : null, session: getSession(lead.id)!, heads, skipped };
}

/* -------------------------------------------------------------------------- */
/* One task                                                                   */
/* -------------------------------------------------------------------------- */

export function runTask(rootDir: string, featureRef: string, taskLineIndex: number, o: RunOpts & { asHead?: boolean } = {}): SessionRecord {
  const f = requireFeature(rootDir, featureRef);
  if (!f.files.tasks) throw new UserError("This feature has no tasks.md.");
  const parsed = parseTasks(fs.readFileSync(path.join(rootDir, f.dir, "tasks.md"), "utf-8"));
  const t = parsed.tasks.find((x) => x.line === taskLineIndex);
  if (!t) throw new UserError(`Line ${taskLineIndex + 1} of tasks.md is not a task.`);
  if (t.done) throw new UserError(`${t.id ?? "That task"} is already done.`);

  if (o.asHead) {
    if (!o.sessionId) throw new UserError("A head needs a lead: open a session first, or run the task in a new session.");
    const parent = requireOpenSession(rootDir, o.sessionId);
    const child = createChild({ caller: { operator: true }, parentId: parent.id, brief: headTasksBrief(f, [t]), title: `${t.id ?? "task"}: ${t.text}`.slice(0, 100), engine: o.engine, model: o.model, effort: o.effort, agent: o.agent });
    attach(child.id, f.dir, { purpose: "head", delivered: true });
    return child;
  }
  return launch(rootDir, taskPrompt(f, t), `${t.id ?? "Task"}: ${t.text}`.slice(0, 100), o, specsFor(rootDir, f, "step"));
}

/* -------------------------------------------------------------------------- */
/* Architecture                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A plan-mode session about the design. It is read-only: it explores, asks through the questionnaire, and
 * hands in a plan whose steps are the spec-file changes. Approving that plan (the usual Approve and build)
 * lets it write those files only; afterwards the session returns to plan mode (see attach.ts).
 */
export function startArchitecture(rootDir: string, featureRef: string | null, topic: string | null, o: RunOpts = {}): { session: SessionRecord; feature: FeatureInfo | null; tools: boolean } {
  const feature = featureRef ? requireFeature(rootDir, featureRef) : null;
  const specs: SpecAttachSpec[] = specsFor(rootDir, feature, "architecture").map((a) => ({ ...a, state: "discussing" }));
  const session = launch(rootDir, architecturePrompt(feature, topic), `Architecture${feature ? `: ${feature.title}` : ""}`.slice(0, 100), o, specs, { mode: "plan" });
  return { session, feature, tools: Boolean(getDaemonContext()) };
}
