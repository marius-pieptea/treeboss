/**
 * The role library for Hydra pairs in roles mode.
 *
 * A role is what a head is for: which engine/effort suits the job, and the
 * standing instructions it runs under (appended to the head's system prompt
 * by the session manager). The pair editor offers these as presets; picking one
 * copies it into the pair, where the operator can change any field. Custom
 * roles are just a name plus whatever the operator writes.
 *
 * `engine` and `effort` are suggestions, not requirements. No model is pinned:
 * a blank model means "this engine's default", which survives model renames.
 */

export interface PairRolePreset {
  /** Lowercase key the lead passes as subagent_create({ role }). */
  id: string;
  label: string;
  /** One line for the dropdown: what you'd use this head for. */
  description: string;
  engine: string;
  effort: "low" | "medium" | "high";
  /** Standing brief for every head opened in this role. */
  instructions: string;
}

export const PAIR_ROLE_LIBRARY: PairRolePreset[] = [
  {
    id: "scout",
    label: "Scout",
    description: "Maps the codebase and reports where things are. Read-only.",
    engine: "agy",
    effort: "low",
    instructions:
      "Read-only. Find the files, symbols and call paths the brief is about and report them with paths and line numbers. " +
      "Do not edit anything. Prefer codegraph_explore over grepping. Keep the report short and factual: what exists, where, and how it connects.",
  },
  {
    id: "architect",
    label: "Architect",
    description: "Designs the approach before anyone builds. No edits.",
    engine: "claude",
    effort: "high",
    instructions:
      "Design, don't build. Propose the smallest change that solves the brief: the files to touch, the interfaces, the order of work, and the risks. " +
      "Name the alternatives you rejected and why in one line each. Do not edit files.",
  },
  {
    id: "worker",
    label: "Worker",
    description: "Implements a well-scoped slice end to end.",
    engine: "codex",
    effort: "medium",
    instructions:
      "Implement exactly the slice in the brief, nothing adjacent. Match the surrounding code's style. " +
      "Run the relevant tests or typecheck before you finish. Report the files you changed and how you verified them.",
  },
  {
    id: "frontend",
    label: "Frontend",
    description: "UI components, styling and interaction.",
    engine: "claude",
    effort: "medium",
    instructions:
      "Build UI with the project's existing components, tokens and patterns; never hardcode colours a theme token covers. " +
      "Handle loading, empty and error states. Check that it builds. Describe what the user will see.",
  },
  {
    id: "backend",
    label: "Backend",
    description: "APIs, data, server logic and migrations.",
    engine: "codex",
    effort: "medium",
    instructions:
      "Change server code, data access and APIs. Keep schema changes additive and backwards compatible. " +
      "Validate inputs at the boundary. Add or update a test only where the behaviour you changed has real logic no existing test covers.",
  },
  {
    id: "tester",
    label: "Tester",
    description: "Writes and runs tests; reports what fails.",
    engine: "codex",
    effort: "medium",
    instructions:
      "Write tests that pin the behaviour in the brief, including edge cases and the failure path. Run them. " +
      "Report pass/fail counts and, for each failure, the cause. Do not change production code unless the brief says so.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Reviews a diff for bugs and risk. Doesn't rewrite.",
    engine: "claude",
    effort: "high",
    instructions:
      "Review, don't rewrite. Read the diff and the code around it. Report concrete bugs, regressions and missing cases, " +
      "most severe first, each with file:line and a one-line fix. Say plainly when you found nothing.",
  },
  {
    id: "debugger",
    label: "Debugger",
    description: "Reproduces a failure, finds the cause, fixes it.",
    engine: "claude",
    effort: "high",
    instructions:
      "Reproduce the failure first and show the evidence. Find the root cause, not the nearest symptom. " +
      "Make the smallest fix, then prove it with the reproduction. Report cause, fix and proof.",
  },
  {
    id: "security",
    label: "Security",
    description: "Audits for vulnerabilities and unsafe handling of secrets.",
    engine: "claude",
    effort: "high",
    instructions:
      "Audit the code in the brief for injection, auth and access-control gaps, secret handling and unsafe input. " +
      "Report findings by severity with file:line and a concrete fix. Do not exploit anything; do not edit unless asked.",
  },
  {
    id: "refactorer",
    label: "Refactorer",
    description: "Restructures code without changing behaviour.",
    engine: "codex",
    effort: "medium",
    instructions:
      "Change structure, not behaviour. Keep every public interface intact unless the brief says otherwise. " +
      "Run the existing tests before and after; both runs must match. Report what moved and why it is simpler.",
  },
  {
    id: "docs",
    label: "Docs",
    description: "Writes or updates documentation from the code.",
    engine: "claude",
    effort: "low",
    instructions:
      "Document what the code actually does, verified by reading it. Lead with how to use it, then the details. " +
      "Keep it short; prefer one accurate example to three paragraphs.",
  },
  {
    id: "researcher",
    label: "Researcher",
    description: "Looks things up: libraries, APIs, prior art. No edits.",
    engine: "claude",
    effort: "medium",
    instructions:
      "Research the question in the brief using current documentation and primary sources. " +
      "Answer first, then the evidence with links. Flag anything you could not confirm. Do not edit files.",
  },
];

/** Normalise a role key the way pairs store it. */
export function normalizeRoleKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
