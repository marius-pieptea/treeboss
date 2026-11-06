/** The local model: its settings and the one-shot Ollama call. */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSetting, setSetting } from "../src/settings";
import { complete } from "../src/llm/ollama";
import { resetState } from "./helpers";

const realFetch = globalThis.fetch;

/** Stand in for Ollama: record the request, answer with `response`. */
function stubOllama(response: string | Error): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify({ response }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return sent;
}

beforeEach(() => resetState());
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("llm settings", () => {
  test("defaults keep the local model off, pointed at the usual Ollama port", () => {
    expect(getSetting("llm_provider")).toBe("off");
    expect(getSetting("ollama_url")).toBe("http://127.0.0.1:11434");
    expect(getSetting("ollama_model")).toBe("qwen2.5-coder:3b");
    expect(getSetting("llm_timeout_sec")).toBe(10);
  });

  test("rejects values that would make a call fail in a confusing way", () => {
    expect(() => setSetting("llm_provider", "openai")).toThrow('llm_provider must be "off" or "ollama".');
    expect(() => setSetting("ollama_url", "127.0.0.1:11434")).toThrow("ollama_url must be an http:// or https:// address");
    expect(() => setSetting("ollama_model", "qwen 2.5")).toThrow("ollama_model must be a model name");
    expect(() => setSetting("llm_timeout_sec", "0")).toThrow("llm_timeout_sec must be between 1 and 120.");
  });

  test("accepts a valid provider, URL, model and timeout", () => {
    setSetting("llm_provider", "ollama");
    setSetting("ollama_url", "http://localhost:11500/");
    setSetting("ollama_model", "qwen2.5-coder:1.5b");
    setSetting("llm_timeout_sec", "4");
    expect(getSetting("llm_provider")).toBe("ollama");
    expect(getSetting("ollama_model")).toBe("qwen2.5-coder:1.5b");
    expect(getSetting("llm_timeout_sec")).toBe(4);
  });
});

describe("complete", () => {
  test("posts a non-streaming request to /api/generate with the configured model", async () => {
    setSetting("llm_provider", "ollama");
    setSetting("ollama_url", "http://127.0.0.1:11434/");
    const sent = stubOllama("Fix sessions");
    expect(await complete({ system: "sys", prompt: "hi", maxTokens: 24 })).toBe("Fix sessions");
    expect(sent[0]).toMatchObject({ model: "qwen2.5-coder:3b", system: "sys", prompt: "hi", stream: false, think: false, options: { num_predict: 24 } });
  });

  test("refuses to call anything while the provider is off", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(complete({ system: "s", prompt: "p", maxTokens: 8 })).rejects.toThrow("The local model is off");
    expect(called).toBe(false);
  });
});
