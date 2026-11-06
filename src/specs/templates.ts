/**
 * The skeletons the Specs module writes: a constitution, a feature spec, and the empty plan and task
 * files. The headings follow the Spec Kit layout so the same folders keep working with the `specify`
 * tool; the wording is this app's own. Nothing here is written unless the operator asks for it.
 */

export const CONSTITUTION_PATH = ".specify/memory/constitution.md";
export const INIT_OPTIONS_PATH = ".specify/init-options.json";
export const SPECS_DIR = "specs";

export function constitutionTemplate(project: string): string {
  return `# ${project} Constitution

The principles every feature in this project is built under. Specs, plans and tasks must not contradict
them. Change this file on purpose, in its own commit, never as a side effect of a feature.

## Core Principles

### I. [PRINCIPLE_1_NAME]
[One or two sentences: the rule, and why it exists here.]

### II. [PRINCIPLE_2_NAME]
[One or two sentences.]

### III. [PRINCIPLE_3_NAME]
[One or two sentences.]

## Constraints

- [Technology, platform or compliance limits that are not up for debate per feature.]

## Workflow

- [How work moves: review rules, test expectations, what "done" means.]

## Governance

This constitution outranks other practice documents. An amendment states what changed and why, and
updates the version below.

**Version**: 0.1.0 | **Ratified**: [DATE] | **Last Amended**: [DATE]
`;
}

/** The spec skeleton: the sections the plan and task steps read. */
export function specTemplate(title: string, input: string, id: string): string {
  return `# Feature Specification: ${title}

**Feature**: \`${id}\`
**Status**: Draft
**Input**: ${input.replace(/\s+/g, " ").trim() || "[what was asked for, in the requester's words]"}

## User Scenarios & Testing

### User Story 1 - [Short title] (Priority: P1)

[Describe this journey in plain language: who, what they do, what they get.]

**Why this priority**: [Value it delivers and why it comes first.]

**Independent Test**: [How this story alone can be tested and still deliver value.]

**Acceptance Scenarios**:

1. **Given** [starting state], **When** [action], **Then** [observable outcome]

### Edge Cases

- What happens when [boundary condition]?
- How does the system behave when [error condition]?

## Requirements

### Functional Requirements

- **FR-001**: The system MUST [specific capability].
- **FR-002**: The system MUST [specific capability].

### Key Entities

- **[Entity]**: [What it represents, its key attributes, without implementation detail.]

## Success Criteria

- **SC-001**: [Measurable outcome, e.g. "a user completes X in under 2 minutes".]

## Assumptions

- [A reasonable default taken where the request was silent.]
`;
}

export function planTemplate(title: string, id: string): string {
  return `# Implementation Plan: ${title}

**Feature**: \`${id}\` | **Spec**: [spec.md](./spec.md)

## Summary

[The requirement in one paragraph, and the technical approach chosen for it.]

## Technical Context

- **Language / runtime**: [e.g. TypeScript on Bun]
- **Dependencies**: [libraries this feature adds or relies on]
- **Storage**: [files, database, none]
- **Testing**: [framework and where tests live]
- **Constraints**: [performance, platform, compatibility]

## Constitution Check

[Each principle in the constitution, and whether this plan upholds it. Justify any exception.]

## Project Structure

\`\`\`text
[the files and folders this feature adds or changes]
\`\`\`

## Complexity Tracking

[Only when a constitution check failed: what was chosen instead and why the simpler way was not enough.]
`;
}

export function tasksTemplate(title: string, id: string): string {
  return `# Tasks: ${title}

**Feature**: \`${id}\` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Format: \`- [ ] T001 [P] [US1] Description with exact file path\`. \`[P]\` marks a task that can run alongside its
neighbours; \`[US#]\` ties it to a user story. Tick the box when the task is done and verified.

## Phase 1: Setup

- [ ] T001 Create the project structure from the plan

## Phase 2: Foundational

- [ ] T002 [Shared work every story needs, with its file path]

## Phase 3: User Story 1 (P1)

- [ ] T003 [P] [US1] [Task with its file path]

## Phase N: Polish

- [ ] T099 Run the quickstart validation end to end
`;
}

/** "Add CSV export to orders" → "add-csv-export-to-orders", at most five words. */
export function slugify(input: string): string {
  const stop = new Set(["a", "an", "the", "to", "for", "of", "and", "in", "on", "with"]);
  const words = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const keep = words.filter((w) => !stop.has(w));
  return (keep.length ? keep : words).slice(0, 5).join("-").slice(0, 48).replace(/-+$/, "");
}

/** "add-csv-export" → "Add Csv Export" (a title for the skeleton; the agent rewrites it). */
export function titleFromSlug(slug: string): string {
  return slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
