import { describe, expect, test } from "bun:test";
import { scheduleCreateBody } from "../../web/src/features/autopilot/logic";

const prompt = { name: "Nightly", cron: "0 2 * * *", kind: "prompt" as const, prompt: "Summarise yesterday", enabled: true };

describe("scheduleCreateBody", () => {
  test("a prompt job carries the engine on the schedule and the model in its payload", () => {
    expect(scheduleCreateBody({ ...prompt, engine: "claude", model: "opus" })).toEqual({
      name: "Nightly",
      cron: "0 2 * * *",
      kind: "prompt",
      payload: { prompt: "Summarise yesterday", model: "opus" },
      enabled: true,
      engine: "claude",
    });
  });

  test("with no pick the job keeps its payload and sends no engine", () => {
    const body = scheduleCreateBody(prompt);
    expect(body).toEqual({ name: "Nightly", cron: "0 2 * * *", kind: "prompt", payload: { prompt: "Summarise yesterday" }, enabled: true });
    expect("engine" in body).toBe(false);
  });

  test("an engine with no model sends only the engine", () => {
    expect(scheduleCreateBody({ ...prompt, engine: "claude" })).toMatchObject({ engine: "claude", payload: { prompt: "Summarise yesterday" } });
  });

  test("other kinds keep their own payload", () => {
    expect(scheduleCreateBody({ name: "Sweep", cron: "0 9 * * 1", kind: "lab_sweep", lens: "review", enabled: false })).toEqual({ name: "Sweep", cron: "0 9 * * 1", kind: "lab_sweep", payload: { lens: "review" }, enabled: false });
    expect(scheduleCreateBody({ name: "Checks", cron: "0 9 * * 1", kind: "verify", enabled: true })).toMatchObject({ payload: {} });
  });
});
