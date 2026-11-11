import { describe, expect, test } from "bun:test";
import { bugBody } from "../../web/src/features/browser/LogBugDialog";

const base = { title: " Cart total is wrong ", kind: "logic" as const, steps: ["open cart"], expected: "", actual: "", url: "http://localhost:3000/cart", port: 3000, shot: null, screenshot: false, console: true, logs: false };

describe("the body of a logged bug", () => {
  test("it carries the feature the bug was filed under", () => {
    expect(bugBody({ ...base, feature: "cart" })).toMatchObject({ title: "Cart total is wrong", feature: "cart" });
  });

  test("no feature is sent as null, not left out", () => {
    expect(bugBody({ ...base, feature: null })).toHaveProperty("feature", null);
  });
});
