/**
 * What a Lab pass looks for. A lens is a question put to the code; a scope (the project, a folder, the
 * current diff) is how much of it. Each lens carries its own rules about what counts as evidence, because
 * the failure of idea generation is vague advice: every finding must point at code and say how to check it.
 */
import { DESIGN_FILE } from "../design/contract";
import type { Lens } from "./findings";

export interface LensDef {
  id: Lens;
  label: string;
  /** One line for the picker. */
  hint: string;
  /** What to look for. */
  guidance: string;
  /** Read DESIGN.md before starting (UI work follows the project's tokens). */
  readsDesign?: boolean;
  /** The prompt names the roadmap's open items, so the pass does not propose them again. */
  readsRoadmap?: boolean;
  /** The prompt includes SECURITY.md, so the pass does not report what the project accepts. */
  readsSecurity?: boolean;
}

export const LENS_DEFS: Record<Lens, LensDef> = {
  features: {
    id: "features",
    label: "Features",
    hint: "Product ideas this code is one step away from",
    readsRoadmap: true,
    guidance: `Find features and improvements to existing flows that the code is already close to supporting: a half-built path, a setting nobody can reach, data that is stored but never shown, a manual step the app could do itself, a gap between two modules that already share data. Prefer small, shippable additions that reuse what exists over new subsystems. Skip anything the roadmap already lists.`,
  },
  ui: {
    id: "ui",
    label: "UI",
    hint: "Interface gaps, inconsistencies and rough flows",
    readsDesign: true,
    guidance: `Review the interface for: missing empty, loading, error and disabled states; inconsistent components or spacing; flows that take more steps than they should; weak keyboard and focus handling; contrast and accessibility gaps; layouts that break at narrow widths; copy that is unclear. If a dev server is running or you can start one and you have browser tools, look at the real screens at desktop and mobile widths in light and dark mode, and name the screenshot in the evidence. Otherwise read the components. A finding that needs a value ${DESIGN_FILE} does not have says so: the token is added to the design system first, never invented in a component.`,
  },
  ux: {
    id: "ux",
    label: "UX",
    hint: "Task flows, error recovery, first run and copy",
    readsDesign: true,
    guidance: `Walk the real user journeys and judge them as tasks, not as screens: first run and an empty project, the three or four things a user comes here to do, and what happens when each goes wrong. Look for: flows with more steps, clicks or decisions than the task needs; a state the user cannot tell they are in (nothing says it is working, saved, failed or finished); errors that say what broke but not what to do next; destructive actions without a confirmation, an undo or a clear label; settings or features nobody can find; defaults the user must change every time; copy that uses internal words; dead ends with no way back. Say which journey the finding is on and count the steps today against the steps it should take. Visual polish, spacing, contrast and tokens belong to the UI pass: skip them here. If you have browser tools and a dev server is running or can be started, do the journey for real and name the screen in the evidence; otherwise follow the code from the entry point and say so. Reading ${DESIGN_FILE} tells you the product's own words and conventions.`,
  },
  ai: {
    id: "ai",
    label: "AI",
    hint: "Where a model call would remove manual work",
    guidance: `Find places where a model could do work the user does by hand today: summarizing, drafting, classifying, extracting, explaining an error, suggesting the next step, searching by meaning. For each, say what the input and output are, where in the code it would hook in, what it would cost per use, how it fails, and what the user sees while it runs. Reject ideas where a plain function would do. Prefer opportunities that reuse existing sessions, prompts and title or commit-message style helpers.`,
  },
  perf: {
    id: "perf",
    label: "Performance",
    hint: "Slow paths, wasted work, heavy bundles",
    guidance: `Find performance problems. Prefer measured evidence: build output and bundle sizes, test or script timings, the dev server logs, query plans, row counts. Run what is cheap and safe to run, and put the number in the finding. For each finding give a "measure first" step: the exact command or check that produces the baseline, so the fix can be shown to help. When you only read the code, set \`unmeasured: true\`. Typical real problems: work repeated on every render or request, unbounded lists and queries, N+1 access, large synchronous reads, missing indexes, polling that could be pushed, bundles that load code the first screen never uses. Do not recommend micro-optimizations.`,
  },
  dx: {
    id: "dx",
    label: "DX",
    hint: "Tests, tooling, duplication, dead code",
    guidance: `Find what slows the next change down: missing tests around code that changes often, untested error paths, duplicated logic that has already drifted, dead code, unclear module boundaries, slow or flaky checks, scripts that need a README. Evidence is a file and line, or a count (how many copies, how many callers).`,
  },
  review: {
    id: "review",
    label: "Review",
    hint: "Correctness and risk in the scoped code",
    guidance: `Review the scoped code for bugs and risks: unchecked inputs, races, error paths that swallow failures, state that can go stale, behavior that contradicts a comment or a spec. Each finding names the failing input or state and what goes wrong. Security weaknesses have their own pass: report one here only when it is a plain bug that also happens to be exploitable. Do not list style preferences.`,
  },
  security: {
    id: "security",
    label: "Security",
    hint: "Auth, access control, input handling and secrets",
    readsSecurity: true,
    guidance: `Review the scoped code as someone who wants to misuse it. Start by naming the trust boundaries in scope: who can reach each entry point (HTTP routes, sockets, IPC and desktop bridges, CLI arguments, files and environment the code reads, content from outside such as web pages, model output and uploads) and what they are trusted to do. Then check, in this order:
1. Authentication: every way in is covered. How identity is established (tokens, sessions, cookies, pairing, OAuth, API keys); how credentials are generated, compared (constant time), stored, rotated, expired and revoked; login, logout, reset and recovery flows; what an unauthenticated caller can reach; routes or handlers registered outside the auth check; local-only services that trust anything on localhost; browser-reachable endpoints that lack an Origin or CSRF check.
2. Authorization: authentication is not permission. For each action, who may do it and where that is enforced: roles and scopes, ownership checks on every object id taken from the request (IDOR), checks done in the client only, privilege escalation through a settings or admin route, a read-only mode that a write path bypasses, one workspace or user reaching another's data, a check that runs before an await and a state change after it.
3. Input to dangerous sinks: path joins and symlinks that leave the allowed root, shell and process arguments built from strings, SQL built by concatenation, HTML or markdown rendered without escaping, URL fetches that can be pointed at internal addresses (SSRF), deserialization, prompt or tool-call injection from content the model reads, and permission prompts that content from the page or the model can approve.
4. Secrets and data: keys or tokens in source, logs, error messages, URLs, localStorage, crash reports or files that get committed; permissive file modes; sensitive data sent to a third party; defaults that are unsafe until configured; dependencies with known advisories, when the lockfile and a local audit command make that cheap to check.
Evidence is the file and line of the missing or wrong check plus the request, input or sequence that gets past it, written as a description: never a working exploit, and never a real secret, token or password (name where it is and show its first four characters at most). Do not attack running services, send traffic to anything but this machine, or try credentials. Rate impact by what an attacker gains and who can reach it: remote and unauthenticated is high, needs a local account or a paired device is medium. Each finding says what the check should be, and what test would prove it holds. Skip generic hardening advice with no place in the code, and skip anything the project's SECURITY.md lists as accepted.`,
  },
  checklist: {
    id: "checklist",
    label: "Checklist",
    hint: "Launch checklist items, verified in this stack",
    guidance: `Verify each launch checklist item listed in the pass against this project. Each item is a claim the checklist makes about the project: find the code that decides it, starting from where the detected stack keeps its routes and markup, and read it. Record each item once with the checklist_record tool: pass with the file and line you read, fail with what is missing or wrong, or na with the reason the item does not apply to this project. Never guess: an item you cannot show from the code is a fail, with the note saying what is missing. Judge the code, not the wording of the item.`,
  },
  bug: {
    id: "bug",
    label: "Bug",
    hint: "A bug logged from the built-in browser",
    guidance: `A bug is logged by hand from the built-in browser, with its URL and what was seen. It is fixed from its finding; no pass looks for it.`,
  },
};

export const lensDef = (l: Lens): LensDef => LENS_DEFS[l];

/** The lenses the operator picks for a run. The checklist pass is started from the checklist panel, with its items. A bug is logged from the browser, not found by a run. */
export const PICKABLE_LENSES: readonly Lens[] = (Object.keys(LENS_DEFS) as Lens[]).filter((l) => l !== "checklist" && l !== "bug");
