import { getSetting } from "../settings";

/**
 * One-shot completions from a small local model, through Ollama's HTTP API. Not an engine: an engine runs an
 * agent with tools and a session; this is a single question and a single answer, for chores like naming a session.
 */
export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** The model's full answer. Throws when the provider is off, the server is not running, or the call times out. */
export async function complete(o: CompleteOptions): Promise<string> {
  if (getSetting("llm_provider") !== "ollama") throw new Error("The local model is off (llm_provider).");
  const base = getSetting("ollama_url").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getSetting("ollama_model"),
      system: o.system,
      prompt: o.prompt,
      stream: false,
      think: false,
      keep_alive: "30m",
      options: { num_predict: o.maxTokens, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(getSetting("llm_timeout_sec") * 1000),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}.`);
  const body = (await res.json()) as { response?: unknown };
  return typeof body.response === "string" ? body.response : "";
}
