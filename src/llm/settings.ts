import { UserError } from "../util";

/**
 * Settings for the small local model that does background chores: commit drafts now, other short chores later. (Session titles are written by the session's own agent, see `src/sessions/title.ts`.)
 * Spread into the main settings table (`src/settings.ts`), so they live in the same store and show up in
 * `trb config` and the settings page like every other knob. Validation lives here, next to the defaults.
 */
export const LLM_SETTING_DEFS = {
  llm_provider: {
    type: "string",
    def: "off",
    help: "off: no local model; features keep their plain behaviour. ollama: small background tasks (commit message drafts) run on the Ollama model below, and fall back to the plain behaviour when it is not running.",
  },
  ollama_url: { type: "string", def: "http://127.0.0.1:11434", help: "Where the Ollama server listens." },
  ollama_model: { type: "string", def: "qwen2.5-coder:3b", help: "Ollama model for background tasks. Must already be pulled (`ollama pull <model>`)." },
  llm_timeout_sec: {
    type: "number",
    def: 10,
    help: "Give up on one local model call after this many seconds, and use the plain behaviour instead. The model is loaded once and kept warm by Ollama, so the first call is the slow one.",
  },
} as const;

export type LlmSettingKey = keyof typeof LLM_SETTING_DEFS;

/** Throws a UserError when `value` is not allowed for an LLM setting. Other keys pass through. */
export function validateLlmSetting(key: string, value: string): void {
  if (key === "llm_provider" && value !== "off" && value !== "ollama") throw new UserError(`llm_provider must be "off" or "ollama".`);
  if (key === "ollama_url") {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {}
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new UserError(`ollama_url must be an http:// or https:// address, e.g. http://127.0.0.1:11434.`);
  }
  if (key === "ollama_model" && !/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/.test(value.trim())) throw new UserError(`ollama_model must be a model name such as qwen2.5-coder:3b.`);
  if (key === "llm_timeout_sec" && !(Number(value) >= 1 && Number(value) <= 120)) throw new UserError("llm_timeout_sec must be between 1 and 120.");
}
