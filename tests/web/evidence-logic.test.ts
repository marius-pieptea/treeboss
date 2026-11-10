import { describe, expect, test } from "bun:test";
import { createInvestigationBody } from "../../web/src/features/evidence/data";

describe("createInvestigationBody", () => {
  test("leaves the engine and model out when nothing was picked", () => {
    const body = createInvestigationBody({ title: "Checkout", run: true });
    expect(body).toMatchObject({ title: "Checkout", run: true });
    expect("engine" in body).toBe(false);
    expect("model" in body).toBe(false);
  });

  test("carries the picked engine and model with the run", () => {
    const body = createInvestigationBody({ title: "Checkout", target: "https://example.com", target_kind: "web", run: true, note: "the cart", engine: "claude", model: "opus" });
    expect(body).toMatchObject({ title: "Checkout", target: "https://example.com", target_kind: "web", run: true, note: "the cart", engine: "claude", model: "opus" });
  });

  test("a create-only request says run is false", () => {
    expect(createInvestigationBody({ title: "Later" })).toMatchObject({ title: "Later", run: false });
  });
});
