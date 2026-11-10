import { describe, expect, test } from "bun:test";
import { triageBody } from "../../web/src/features/signals/data";

describe("triageBody", () => {
  test("carries only the action when no engine or model is picked", () => {
    expect(triageBody({ action: "to_session" })).toEqual({ action: "to_session" });
  });

  test("carries the picked engine and model for a Fix", () => {
    expect(triageBody({ action: "to_session", engine: "claude", model: "opus" })).toEqual({ action: "to_session", engine: "claude", model: "opus" });
  });

  test("a roadmap or ignore action sends just the action", () => {
    expect(triageBody({ action: "ignore", engine: "claude" })).toEqual({ action: "ignore" });
    expect(triageBody({ action: "to_roadmap", engine: "claude", model: "opus" })).toEqual({ action: "to_roadmap" });
  });
});
