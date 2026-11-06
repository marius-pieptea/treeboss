/**
 * The built-in prompts for each step of the spec workflow:
 *
 *   constitution → specify → clarify → plan → tasks → analyze → implement
 *
 * Each states which files to read, which file to write, and the exact formats, so any engine can run a
 * step without the `specify` tool or its slash commands. They are plain text: the UI and the CLI send
 * them as the first message of a session (or a follow-up in an open one) and attach the same files as
 * context. The wording is this app's own; the file layout and the task-line format are Spec Kit's.
 */
import { CONSTITUTION_PATH } from "./templates";
import type { FeatureInfo } from "./store";
import { type SpecTask, taskLine } from "./tasks";

export type StepName = "constitution" | "specify" | "clarify" | "plan" | "tasks" | "analyze" | "implement";

export const STEP_ORDER: StepName[] = ["constitution", "specify", "clarify", "plan", "tasks", "analyze", "implement"];

export const STEP_LABEL: Record<StepName, string> = {
  constitution: "Constitution",
  specify: "Specify",
  clarify: "Clarify",
  plan: "Plan",
  tasks: "Tasks",
  analyze: "Analyze",
  implement: "Implement",
};

export const TASK_FORMAT = [
  "Every task is one line in tasks.md, exactly:",
  "",
  "    - [ ] T001 [P] [US1] Description with the exact file path",
  "",
  "- Start with a checkbox: `- [ ]` open, `- [x]` done.",
  "- Task ids are sequential, T001, T002, in the order the work is done.",
  "- `[P]` only when the task can run alongside its neighbours: it touches different files and waits on no unfinished task.",
  "- `[US1]`, `[US2]`… only in a user-story phase, naming the story from spec.md. Setup, foundational and polish tasks carry no story label.",
  "- Every task names the exact file it creates or changes.",
  "- Group tasks under `## Phase N: Title` headings: Setup, Foundational, then one phase per user story in priority order (each independently testable), then Polish.",
].join("\n");

export interface StepContext {
  feature?: FeatureInfo | null;
  /** What the operator typed: the feature request, a clarification topic, a note. */
  input?: string | null;
  /** The questionnaire tools are wired for this session. */
  askTool?: boolean;
}

function files(f: FeatureInfo | null | undefined, which: Array<"spec" | "plan" | "tasks" | "research" | "data-model" | "quickstart">): string {
  if (!f) return "";
  const have: Record<string, boolean> = { spec: f.files.spec, plan: f.files.plan, tasks: f.files.tasks, research: f.files.research, "data-model": f.files.dataModel, quickstart: f.files.quickstart };
  return which.filter((w) => have[w]).map((w) => `- \`${f.dir}/${w}.md\``).join("\n") + (which.includes("data-model") && f.files.contracts.length ? `\n- \`${f.dir}/contracts/\` (${f.files.contracts.length} file${f.files.contracts.length === 1 ? "" : "s"})` : "");
}

function need(f: FeatureInfo | null | undefined, step: StepName): FeatureInfo {
  if (!f) throw new Error(`The ${step} step needs a feature.`);
  return f;
}

const NOTE = (input?: string | null) => (input?.trim() ? `\n\nFrom the operator:\n${input.trim()}` : "");

export function stepPrompt(step: StepName, ctx: StepContext = {}): string {
  const f = ctx.feature ?? null;
  switch (step) {
    case "constitution":
      return [
        `# Write the project constitution`,
        ``,
        `Read first: the README, the package or build manifests, any contributing or architecture notes, the test setup, and \`${CONSTITUTION_PATH}\` if it exists.`,
        `Write: \`${CONSTITUTION_PATH}\` (create the folders if needed). Change no other file.`,
        ``,
        `Format:`,
        `- \`# <Project> Constitution\`, then one short paragraph on what the document is for.`,
        `- \`## Core Principles\` with one \`### I. Name\` heading per principle (three to six), each followed by one or two sentences stated as a rule that can be checked in review (MUST / MUST NOT), and why it exists here.`,
        `- \`## Constraints\` (platform, dependencies, compliance), \`## Workflow\` (review, testing, what done means), \`## Governance\` (how it is amended), and a final line \`**Version**: x.y.z | **Ratified**: YYYY-MM-DD | **Last Amended**: YYYY-MM-DD\`.`,
        ``,
        `Derive the principles from evidence in this repository (what it already does consistently), not from generic best practice. Replace every [PLACEHOLDER]. If the file exists, amend it: keep the principles that still hold, bump the version, and say what changed at the end of your reply.` + NOTE(ctx.input),
      ].join("\n");

    case "specify": {
      const feat = need(f, step);
      return [
        `# Specify: ${feat.title}`,
        ``,
        `Read first: \`${CONSTITUTION_PATH}\` (if it exists) and \`${feat.dir}/spec.md\` (a skeleton to fill in or revise).`,
        `Write: \`${feat.dir}/spec.md\`. Change no other file.`,
        ``,
        `Describe WHAT the feature does and WHY, never how it is built: no languages, frameworks, libraries or file names.`,
        ``,
        `Sections, in this order, keeping the headings:`,
        `1. \`# Feature Specification: <title>\`, then \`**Feature**\`, \`**Status**\`, \`**Input**\` lines.`,
        `2. \`## User Scenarios & Testing\`: user stories as \`### User Story N - Title (Priority: P1)\` in priority order. Each story is one journey that works and delivers value on its own, with **Why this priority**, **Independent Test**, and **Acceptance Scenarios** as numbered Given / When / Then lines. Then \`### Edge Cases\`.`,
        `3. \`## Requirements\`: \`### Functional Requirements\` as \`- **FR-001**: The system MUST …\`, each testable and unambiguous; and \`### Key Entities\` when data is involved (what it is, not how it is stored).`,
        `4. \`## Success Criteria\`: \`- **SC-001**: …\`, measurable and independent of technology.`,
        `5. \`## Assumptions\`: every default you chose where the request was silent.`,
        ``,
        `Where something is unknown and the answer would change scope, write \`[NEEDS CLARIFICATION: the question]\` in place (at most three in the whole file); decide everything else with a sensible default and list it under Assumptions. Set **Status** to Draft.`,
        NOTE(ctx.input) || `\nThe request: ${feat.title}.`,
      ].join("\n");
    }

    case "clarify": {
      const feat = need(f, step);
      const ask = ctx.askTool
        ? "Ask with the `plan_ask` tool, one question per call, 2 to 4 options with one recommended and why."
        : "Ask one question at a time in your reply, with 2 to 4 options and your recommendation, then wait for the answer.";
      return [
        `# Clarify: ${feat.title}`,
        ``,
        `Read first: \`${CONSTITUTION_PATH}\` (if it exists) and \`${feat.dir}/spec.md\`.`,
        `Write: \`${feat.dir}/spec.md\` only, after each answer.`,
        ``,
        `Find the gaps that would most change the plan: every \`[NEEDS CLARIFICATION]\` marker first, then ambiguity in scope, data, failure behaviour, permissions, and measurable targets. Pick the five highest-impact at most; skip anything a reasonable default settles.`,
        ask,
        ``,
        `After each answer, fold it into the right section of spec.md (rewrite the requirement or scenario; do not just append), remove the resolved marker, and record it under \`## Clarifications\` → \`### Session YYYY-MM-DD\` as \`- Q: … → A: …\`. When you are done, say which gaps remain, if any.` + NOTE(ctx.input),
      ].join("\n");
    }

    case "plan": {
      const feat = need(f, step);
      return [
        `# Plan: ${feat.title}`,
        ``,
        `Read first:`,
        `- \`${CONSTITUTION_PATH}\` (if it exists)`,
        files(feat, ["spec"]) || `- \`${feat.dir}/spec.md\``,
        `- the existing code the feature will touch (search before you decide on a structure)`,
        ``,
        `Write \`${feat.dir}/plan.md\` (always) and, in the same folder and only when they have content: \`research.md\`, \`data-model.md\`, \`contracts/\` (one file per interface), \`quickstart.md\`. Change no source code.`,
        ``,
        `plan.md sections: \`# Implementation Plan: <title>\`; \`## Summary\` (requirement + chosen approach); \`## Technical Context\` (language/runtime, dependencies, storage, testing, constraints); \`## Constitution Check\` (every principle, upheld or not; an exception needs a justification under \`## Complexity Tracking\`); \`## Project Structure\` (the files and folders this adds or changes).`,
        `Anything you could not settle from the code becomes a question in research.md with \`Decision\`, \`Rationale\` and \`Alternatives considered\`. Do not leave NEEDS CLARIFICATION in plan.md: resolve it or send the operator back to the clarify step.` + NOTE(ctx.input),
      ].join("\n");
    }

    case "tasks": {
      const feat = need(f, step);
      return [
        `# Tasks: ${feat.title}`,
        ``,
        `Read first (required, then the ones that exist):`,
        files(feat, ["plan", "spec", "data-model", "research", "quickstart"]) || `- \`${feat.dir}/plan.md\`\n- \`${feat.dir}/spec.md\``,
        `- \`${CONSTITUTION_PATH}\` (if it exists)`,
        `If plan.md is missing, stop and say the plan step comes first.`,
        `Write: \`${feat.dir}/tasks.md\`. Change no other file.`,
        ``,
        TASK_FORMAT,
        ``,
        `Add test tasks only when the spec asks for tests or the constitution requires them, and put each before the code it covers. Finish with a short \`## Dependencies\` section naming which phases block which. Every functional requirement in spec.md must be covered by at least one task.` + NOTE(ctx.input),
      ].join("\n");
    }

    case "analyze": {
      const feat = need(f, step);
      return [
        `# Analyze: ${feat.title}`,
        ``,
        `Read: \`${CONSTITUTION_PATH}\` (if it exists)`,
        files(feat, ["spec", "plan", "tasks", "data-model", "research"]),
        ``,
        `This is a read-only review: do NOT modify any file.`,
        ``,
        `Check, and report each finding with a severity (CRITICAL, HIGH, MEDIUM, LOW), the file and line or id, and the fix you recommend:`,
        `- Any plan, task or requirement that breaks a constitution principle (always CRITICAL).`,
        `- Functional requirements or success criteria that no task covers; tasks that trace to no requirement.`,
        `- Terms or numbers that disagree between spec, plan and tasks; entities in the plan that the spec does not mention.`,
        `- Vague or untestable requirements; leftover [NEEDS CLARIFICATION] markers; tasks with no file path; \`[P]\` tasks that touch the same file.`,
        ``,
        `Reply with a table of findings (ID, severity, where, what, recommendation), then coverage numbers (requirements with at least one task / total; tasks with a requirement / total), then the single next action.` + NOTE(ctx.input),
      ].join("\n");
    }

    case "implement": {
      const feat = need(f, step);
      return [
        `# Implement: ${feat.title}`,
        ``,
        `Read first: \`${CONSTITUTION_PATH}\` (if it exists)`,
        files(feat, ["tasks", "plan", "spec", "data-model", "research", "quickstart"]),
        ``,
        `Work through \`${feat.dir}/tasks.md\` in order, phase by phase. Inside a phase, tasks marked \`[P]\` can be done in any order. A task is done when its file exists, behaves as the spec says, and its tests (if any) pass.`,
        ``,
        `As soon as a task is done and verified, tick it in tasks.md (\`- [ ]\` → \`- [x]\`), changing nothing else on its line, then move on. If a task is blocked or the plan turns out to be wrong, stop and say exactly what and why; do not skip it silently or work around it.`,
        ``,
        `End every reply with a line \`TASKS_DONE: T001, T002\` listing the ids you completed in this turn (omit the line if none).` + NOTE(ctx.input),
      ].join("\n");
    }
  }
}

/** One task, for "Run this task" on a checklist row. */
export function taskPrompt(f: FeatureInfo, t: SpecTask): string {
  return [
    `# Do one task from ${f.title}`,
    ``,
    `Task: ${taskLine(t)}`,
    t.phase ? `Phase: ${t.phase}` : "",
    ``,
    `Read \`${CONSTITUTION_PATH}\` (if it exists), \`${f.dir}/plan.md\` and \`${f.dir}/spec.md\` for context, do this task and only this task, verify it, then tick it in \`${f.dir}/tasks.md\` (\`- [ ]\` → \`- [x]\` on its line, nothing else).`,
    `End your reply with \`TASKS_DONE: ${t.id ?? "…"}\` if it is done.`,
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/** A head's brief for a group of parallel tasks. */
export function headTasksBrief(f: FeatureInfo, tasks: SpecTask[]): string {
  return [
    `Implement these tasks from \`${f.dir}/tasks.md\`. Other agents are doing the other tasks of this phase at the same time, so touch only the files these tasks name.`,
    ``,
    ...tasks.map((t) => `- ${taskLine(t)}`),
    ``,
    `Read \`${CONSTITUTION_PATH}\` (if it exists), \`${f.dir}/plan.md\` and \`${f.dir}/spec.md\` for context. Verify each task. Do NOT edit tasks.md: your parent ticks the boxes. End with the ids you finished as \`TASKS_DONE: T001, T002\`, and say what is left and why.`,
  ].join("\n");
}

/** The first message of an architecture discussion. The session is read-only until the user approves. */
export function architecturePrompt(f: FeatureInfo | null, topic: string | null | undefined): string {
  return [
    `# Architecture discussion${f ? `: ${f.title}` : ""}`,
    ``,
    `We are refining the specification, not building. Read \`${CONSTITUTION_PATH}\` (if it exists)${f ? ` and the files in \`${f.dir}/\`` : ""}, and the code they concern.`,
    `Discuss the design with me: ask the questions that decide the architecture (boundaries, data ownership, failure modes, what to defer), recommend an answer to each, and challenge anything in the current spec or plan that does not hold up against the code.`,
    ``,
    `When we agree, call \`plan_submit\` with one step per file to change. Each step's title is the file (\`${f ? `${f.dir}/spec.md` : "specs/NNN-name/spec.md"}\`, \`…/plan.md\`, \`${CONSTITUTION_PATH}\`) and its detail is the exact change: the sections to add or rewrite, with the new text. I will approve it, and only then may you write those files. Source code is never part of this plan.`,
    topic?.trim() ? `\nWhat I want to settle: ${topic.trim()}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/** What the agent is told once the operator approves an architecture plan. */
export function architectureApproval(): string {
  return [
    `Plan mode is off for the specification files only. Write the agreed changes into the files named in the plan, under \`specs/\` and \`.specify/\`.`,
    `Do not edit source code, configuration or tests, and do not touch any file outside those two folders. End with the list of files you wrote.`,
  ].join(" ");
}
