/**
 * Ask mode: quick, read-only questions about a project.
 *
 * Same shape as plan mode (a column on the session, flippable between turns, held read-only by each engine's
 * own switch) but leaner on purpose: no skills, no extra MCP servers, no agent instructions, no worktree, a
 * tiny preamble, and a cheap model when the mode starts a session. With a CodeGraph index the agent gets only
 * its two read tools; without one it reads and searches. See `engines/registry.ts` for what each engine enforces.
 */
import { listModels } from "../engines/models";
import { getSetting } from "../settings";
import { UserError } from "../util";

/** Engines that accept a per-turn `--model` on a resumed session, so `ask_model_override` can apply there. */
export const ASK_OVERRIDE_ENGINES = ["claude", "codex"] as const;

/** Cheap defaults when `ask_models` names nothing for an engine. Others use their own default model. */
const BUILTIN_ASK_MODELS: Record<string, string> = { claude: "claude-haiku-5-5" };

/** `ask_models` is a comma list of `engine=model`: `claude=claude-haiku-5-5,codex=gpt-5-mini`. */
export function parseAskModels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const engine = part.slice(0, i).trim().toLowerCase();
    const model = part.slice(i + 1).trim();
    if (engine && model) out[engine] = model;
  }
  return out;
}

export function validateAskModels(raw: string): void {
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    if (!/^[A-Za-z0-9_.-]+\s*=\s*\S+$/.test(part.trim())) throw new UserError(`ask_models: "${part.trim()}" is not engine=model. Example: claude=claude-haiku-5-5,codex=gpt-5-mini`);
  }
}

const SMALL_MODEL = /(^|[-_.\s])(mini|small|haiku|flash|lite|nano|spark)([-_.\s]|$)/i;

/**
 * The model an ask session starts on: the operator's `ask_models` entry, else the built-in cheap default for
 * the engine, else (for engines whose catalog is known) the first small-sounding model, else null (the engine's
 * own default). `catalog` is the engine's model ids, when the caller has them.
 */
export function askModelFor(engine: string, catalog: string[] = []): string | null {
  const configured = parseAskModels(String(getSetting("ask_models") ?? ""))[engine.toLowerCase()];
  if (configured) return configured;
  if (BUILTIN_ASK_MODELS[engine]) return BUILTIN_ASK_MODELS[engine];
  return catalog.find((m) => SMALL_MODEL.test(m)) ?? null;
}

/** The cheap model a NEW ask session on `engine` starts on (reads the engine's catalog for those without a built-in). */
export async function askStartModel(engine: string): Promise<{ model: string | null; effort: string }> {
  const catalog = engine === "codex" ? (await listModels("codex").catch(() => null))?.models.map((m) => m.id) ?? [] : [];
  return { model: askModelFor(engine, catalog), effort: ASK_EFFORT };
}

/** Whether a turn in an existing ask-mode session should be run on the cheap model for this engine. */
export function askOverrideModel(engine: string, current: string | null | undefined, catalog: string[] = []): string | null {
  if (getSetting("ask_model_override") !== "on") return null;
  if (!(ASK_OVERRIDE_ENGINES as readonly string[]).includes(engine)) return null;
  const cheap = askModelFor(engine, catalog);
  return cheap && cheap !== current ? cheap : null;
}

/** New ask sessions start at low effort: a question rarely needs more. */
export const ASK_EFFORT = "low";

/** Prepended to every ask turn, resumed or not: the mode can flip between turns, and the tool set differs. Kept tiny. */
export function askPreamble(opts: { codegraph: boolean }): string {
  return [
    "# Ask mode",
    "Read-only question about this project. Do not create, edit or delete anything, and run no commands that change state.",
    opts.codegraph
      ? "Use codegraph_explore first (one call usually answers it), codegraph_node for one symbol or file. Read a file only to confirm a line you cite."
      : "Search and read the code to answer. Prefer a targeted search over reading whole files.",
    "Answer directly in a few sentences, cite file:line, say when unsure, and propose edits only if asked.",
    "",
    "",
  ].join("\n");
}

/** The question a turn asked, with the ask preamble stripped off (turn prompts store what was sent). */
export function questionOf(prompt: string): string {
  return prompt.replace(/^# Ask mode\n[\s\S]*?\n\n\n?/, "").trim();
}
