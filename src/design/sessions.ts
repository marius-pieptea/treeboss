/**
 * Design work done by an agent: ordinary sessions in the workspace, with a prompt from here.
 *
 *   brief     write DESIGN.md and design/tokens.css from a description of the product and its feel
 *   url       derive an ORIGINAL system from a reference site (browser tools when the engine has them)
 *   codebase  write down the system the existing UI already implies, and list where it drifts
 *   wire      import tokens.css into the app and map the tokens into its styling setup
 *   review    compare the UI to DESIGN.md, list violations with file:line, fix the clear-cut ones
 *
 * brief and url brainstorm first by default: the first turn asks up to five questions and writes
 * design/directions.html with two or three directions; the user's reply picks one and the next turn writes
 * the files. The rules (guidance.ts) are shared with the skills that ship with trb.
 *
 * The three generating kinds also add the AGENTS.md rule, so every later session reads the result.
 */
import { UserError } from "../util";
import { createLead, getSession, send, type SessionRecord } from "../sessions/manager";
import { setMode } from "../sessions/plan";
import { contractMarkdown, DESIGN_FILE, TOKENS_FILE } from "./contract";
import { BUILTIN_SYSTEMS } from "./builtins";
import { addDesignRule, readDesign } from "./workspace";
import { AFTER_PICK, antiGenericMarkdown, CRITIQUE, directionLibraryMarkdown, DIRECTIONS_PAGE, DISCOVERY_RULES, EXTRACTION_RULES } from "./guidance";

export const DESIGN_KINDS = ["brief", "url", "codebase", "wire", "review"] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

/** Kinds that can start with a brainstorm turn (questions and directions before any file is written). */
export const BRAINSTORM_KINDS: DesignKind[] = ["brief", "url"];

export interface DesignStartOpts {
  /** The brief, the reference URL, or extra instructions (wire, review). */
  input?: string | null;
  /** brief and url: ask and propose directions first, write the files after the user picks. Default true. */
  brainstorm?: boolean;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  agent?: string | null;
  pairId?: string | null;
  isolate?: boolean;
  /** Send into this open session instead of starting one. */
  sessionId?: string | null;
}

const TITLES: Record<DesignKind, string> = { brief: "Design system from a brief", url: "Design system from a reference", codebase: "Design system from the code", wire: "Wire design tokens", review: "Design review" };

/** The shape every generated DESIGN.md follows: the section list of the shipped ones. */
const SHAPE = `DESIGN.md sections, in order: a one-line summary quote; Personality (a paragraph and 3-5 keywords); Color (a table of every color token with its light value, dark value and use, then rules); Typography (families, how to load them, the scale in px, rules); Space and layout (the 4px grid, max widths, gaps); Shape and elevation; Motion; Components (buttons, inputs, cards, navigation, empty states: sizes, states, which tokens); Do; Don't; Accessibility; Token contract.`;

const TOKENS_RULES = `${TOKENS_FILE} sets every contract token in a \`:root\` block (light), repeats the color and shadow tokens for dark inside \`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }\` and again under \`:root[data-theme="dark"]\`, and zeroes the durations under \`prefers-reduced-motion\`. Plain CSS custom properties only: no build step, no framework syntax. The token contract (names every system sets; add more if needed, never rename these):

${contractMarkdown()}`;

const QUALITY = `Check every text/background pair you define for at least 4.5:1 contrast in both themes, and fix the palette until it passes. Keep it to one primary and at most one accent. Use the shipped example as the bar for depth, not for taste: decide this project's own personality.

Avoid these generic patterns unless the brief explicitly asks for them:
${antiGenericMarkdown()}

${CRITIQUE}`;

function example(): string {
  const n = BUILTIN_SYSTEMS[0]!;
  return `For the expected depth, here is the start of a shipped example ("${n.name}"); write your own content, not a variant of it:\n\n\`\`\`md\n${n.design.split("\n").slice(0, 28).join("\n")}\n…\n\`\`\``;
}

const ENDING = (what: string) => `When you are done, say in a few lines what the system is (personality, primary color, type), and anything ${what}.`;

const NO_COPY = "Do not copy the reference's logo, name, illustrations, icons or proprietary fonts (choose freely available fonts with a similar character), and do not name the reference brand in the files. Exact colors may shift so the palette is this project's own and passes contrast.";

/** Turn 1 of a brainstorm: questions and directions, no design files. */
function brainstormPrompt(kind: "brief" | "url", input: string, common: string): string {
  const study =
    kind === "brief"
      ? `The brief:\n${input.trim()}\n\n1. Read the code first: what the product is, who it is for, and any styling that already exists.`
      : `The reference: ${input.trim()}\n\n1. Read the code first (what the product is), then study the reference. ${EXTRACTION_RULES} Write what you extracted, with the values, at the top of your reply.`;
  const directions =
    kind === "brief"
      ? `Starting points you may adapt, mix or depart from (they are genres, never copy a brand):\n${directionLibraryMarkdown()}`
      : `Make A close to the reference's feel, B the reference adapted to this product, and C a bolder departure. All three are original: ${NO_COPY}`;
  return `Design discovery for this project's design system. This turn is for choosing a direction together: do NOT write ${DESIGN_FILE} or ${TOKENS_FILE} yet, and do not change application code.

${study}
2. Questions. ${DISCOVERY_RULES}
3. Directions. ${DIRECTIONS_PAGE}
${directions}
4. Reply in this shape, then stop and wait: one line on what you understood; the questions, numbered, each with your recommended answer; A, B and C in one sentence each, with your recommendation; and "Compare them in the Design view, then reply with a letter and any changes."

${AFTER_PICK}

What the final files must meet:

${common}`;
}

export function designPrompt(kind: DesignKind, input: string, ctx: { exists: boolean; brainstorm?: boolean }): string {
  const replacing = ctx.exists ? `This project already has ${DESIGN_FILE}: read it first and replace it (and ${TOKENS_FILE}) with the new system; keep any project-specific rules from it that still apply.` : `Create ${DESIGN_FILE} at the project root and ${TOKENS_FILE}.`;
  const common = `${replacing}\n\n${SHAPE}\n\n${TOKENS_RULES}\n\n${QUALITY}\n\n${example()}`;
  const brainstorm = ctx.brainstorm === true && BRAINSTORM_KINDS.includes(kind);
  switch (kind) {
    case "brief":
      if (!input.trim()) throw new UserError("Describe the product and how it should feel.");
      if (brainstorm) return brainstormPrompt("brief", input, common);
      return `Create the design system for this project from the brief below. Look at the code first (what it is, any existing styling) so the system fits what is being built.

The brief:
${input.trim()}

${common}

Do not change application code in this turn: only ${DESIGN_FILE} and ${TOKENS_FILE}. ${ENDING("you had to guess")}`;
    case "url": {
      const url = input.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) throw new UserError("Give the reference as an http(s) URL.");
      if (brainstorm) return brainstormPrompt("url", url, common);
      return `Create the design system for this project, taking inspiration from ${url}.

Study the reference first. ${EXTRACTION_RULES}

Then write an ORIGINAL system that captures that feel for this project. ${NO_COPY}

${common}

Do not change application code in this turn. ${ENDING("you could not read from the reference")}`;
    }
    case "codebase":
      return `Write down the design system this project's UI already implies, so agents stop guessing.

Read the styling sources first: Tailwind config or \`@theme\` blocks, global CSS and CSS variables, theme files (MUI, Chakra, styled-components, shadcn \`components.json\`), and a sample of components and pages. Collect the colors, font families, font sizes, spacing, radii, shadows and transitions actually used, with counts.

Map what you find onto the token contract: where the code is consistent, use its values; where it is not, pick the dominant value and record the rest. Add a "Drift" section at the end of ${DESIGN_FILE} listing each inconsistency with file:line examples and the token it should use.

${common}

Do not change application code in this turn. ${ENDING("that looked deliberate but did not fit the contract")}`;
    case "wire":
      return `Wire this project's design system into its code. ${DESIGN_FILE} is the contract and ${TOKENS_FILE} holds the tokens.

1. Find the styling setup (Tailwind v4 \`@theme\`, Tailwind v3 \`tailwind.config\`, CSS modules, styled-components, React Native StyleSheet, …) and the global stylesheet or root layout.
2. Import ${TOKENS_FILE} once, globally. Load the fonts ${DESIGN_FILE} names with the framework's font loader if it has one.
3. Map the tokens into the styling setup so components can use them idiomatically (for Tailwind: theme colors, fonts, radii and shadows that point at the CSS variables; keep Tailwind's own spacing scale if it already matches the 4px grid). React Native has no CSS variables: generate a typed theme module from the token values instead and say so.
4. Set the page background, text color and body font from the tokens, and make dark mode follow \`prefers-color-scheme\` / \`data-theme\` as ${TOKENS_FILE} expects.
5. Replace hard-coded colors, font families and radii in existing components where the swap is mechanical. Leave anything that needs a design decision and list it.
${input.trim() ? `\nAlso: ${input.trim()}\n` : ""}
Do not change behavior. Run the type check and the build when the project has them. Say what you wired and what is left.`;
    case "review":
      return `Review this project's UI against its design system. ${DESIGN_FILE} is the contract and ${TOKENS_FILE} holds the tokens.

1. Read both files.
2. Look at the UI. If a dev server is running or you can start one, and you have browser tools, open the main screens at desktop and mobile widths in light and dark mode and take screenshots. Otherwise review the components and pages in code.
3. List every violation, grouped by severity (breaks the contract / inconsistent / polish), each with file:line, what is wrong and the token or rule it should follow. Check: raw colors, fonts, sizes, spacing or radii instead of tokens; more than one primary action per view; contrast; missing focus rings; dark mode; component sizes and states against the Components section; the Do and Don't lists; and these generic patterns:
${antiGenericMarkdown()}
4. Score the main screens with this critique and report the scores:
${CRITIQUE}
5. Fix the clear-cut violations (a raw value with an obvious token). Leave anything that needs a design decision and ask about it.
${input.trim() ? `\nFocus: ${input.trim()}\n` : ""}
End with the scores, what you fixed and what is still open.`;
  }
}

/**
 * A prompt the thread shows as the operator's own words, with the instructions folded away behind a marker.
 * The engine reads all of it; the UI shows the part before the marker and a toggle for the rest.
 */
export const INSTRUCTIONS_MARKER = "<!-- trb:instructions";

export function withInstructions(visible: string, label: string, instructions: string): string {
  return `${visible.trim()}\n\n${INSTRUCTIONS_MARKER} ${label.replace(/-->/g, "")} -->\n${instructions}`;
}

/** The short name of each kind, for the marker the thread shows as a tag. */
const LABELS: Record<DesignKind, string> = { brief: "brief", url: "reference", codebase: "from code", wire: "wire tokens", review: "review" };

/** What the operator sees in the thread when they gave no text of their own. */
const VISIBLE: Record<DesignKind, string> = { brief: "Create the design system.", url: "Create the design system from a reference.", codebase: "Write down the design system this code already implies.", wire: "Wire the design tokens into the app.", review: "Review the UI against the design system." };

export interface DesignTurn {
  prompt: string;
  /** A title for a new session. */
  title: string;
  brainstorm: boolean;
}

/**
 * Everything a design turn needs, wherever it is started (the composer, the API, the CLI): validated, the
 * AGENTS.md rule added, and the prompt wrapped so the thread shows the operator's words.
 */
export function designTurn(rootDir: string, kind: DesignKind, input: string, o: { brainstorm?: boolean } = {}): DesignTurn {
  if (!DESIGN_KINDS.includes(kind)) throw new UserError(`Unknown design session "${kind}": use ${DESIGN_KINDS.join(", ")}.`);
  const state = readDesign(rootDir);
  if ((kind === "wire" || kind === "review") && !state.exists) throw new UserError(`There is no ${DESIGN_FILE} yet. Apply or generate a design system first.`);
  const brainstorm = o.brainstorm !== false && BRAINSTORM_KINDS.includes(kind);
  const instructions = designPrompt(kind, input, { exists: state.exists, brainstorm });
  // Point later sessions at the result from the start; the generating session writes the files it names.
  if (kind === "brief" || kind === "url" || kind === "codebase" || !state.agentRule) addDesignRule(rootDir);
  const label = `Design · ${LABELS[kind]}${brainstorm ? " · brainstorm" : ""}`;
  return { prompt: withInstructions(input.trim() || VISIBLE[kind], label, instructions), title: brainstorm ? `${TITLES[kind]} (brainstorm)` : TITLES[kind], brainstorm };
}

export function startDesign(rootDir: string, kind: DesignKind, o: DesignStartOpts = {}): SessionRecord {
  const t = designTurn(rootDir, kind, String(o.input ?? ""), { brainstorm: o.brainstorm });
  if (o.sessionId) {
    const s = getSession(o.sessionId);
    if (!s) throw new UserError(`No session "${o.sessionId}".`);
    setMode(s.id, "build");
    return send({ operator: true }, s.id, t.prompt);
  }
  return createLead({ prompt: t.prompt, title: t.title, cwd: rootDir, engine: o.engine, model: o.model, effort: o.effort, agent: o.agent, pairId: o.pairId, isolate: o.isolate === true, mode: "build" });
}
