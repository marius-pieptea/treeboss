import { describe, expect, test } from "bun:test";
import { MAX_TITLE, initialDraft, qaDock, resolvePath, stepsSince, type Step } from "../../web/src/features/browser/logic";

describe("qaDock", () => {
  test("docks beside the frame from 720px and as a strip under it below", () => {
    expect(qaDock(1200)).toBe("side");
    expect(qaDock(720)).toBe("side");
    expect(qaDock(719)).toBe("strip");
    expect(qaDock(0)).toBe("strip");
  });
});

describe("stepsSince", () => {
  const ring = [0, 10, 20, 30].map((at) => ({ step: { kind: "navigate", url: `/${at}` } as Step, at }));
  test("keeps the steps at or after the time, oldest first", () => {
    expect(stepsSince(ring, 20)).toEqual(["Go to /20", "Go to /30"]);
    expect(stepsSince(ring, 0)).toHaveLength(4);
    expect(stepsSince(ring, 31)).toEqual([]);
    expect(stepsSince([], 0)).toEqual([]);
  });
  test("caps at the newest 15", () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ step: { kind: "navigate", url: `/${i}` } as Step, at: i }));
    const lines = stepsSince(long, 0);
    expect(lines).toHaveLength(15);
    expect(lines.at(-1)).toBe("Go to /29");
  });
});

describe("resolvePath", () => {
  test("puts the path on the origin of the page on screen", () => {
    expect(resolvePath("/cart", "http://localhost:3997/checkout?a=1")).toBe("http://localhost:3997/cart");
    expect(resolvePath("/cart?x=2", "http://localhost:3997/")).toBe("http://localhost:3997/cart?x=2");
  });
  test("is null with no page to take the origin from or a bad base", () => {
    expect(resolvePath("/cart", null)).toBeNull();
    expect(resolvePath("/cart", "not a url")).toBeNull();
  });
});

describe("initialDraft", () => {
  const prefill = { title: "Pay", kind: "functional" as const, steps: ["Open /cart", "Click Pay (recorded)"], expected: "A receipt", actual: "Blank" };
  test("a prefill becomes the dialog's fields as given", () => {
    expect(initialDraft(prefill, ["Go to /x"])).toEqual(prefill);
  });
  test("without one the dialog starts empty with the recorded steps", () => {
    expect(initialDraft(undefined, ["Go to /x"])).toEqual({ title: "", kind: "functional", steps: ["Go to /x"], expected: "", actual: "" });
  });
  test("a title over the limit is cut so the server does not reject the report", () => {
    expect(initialDraft({ ...prefill, title: "t".repeat(500) }, []).title).toHaveLength(MAX_TITLE);
    expect(initialDraft({ ...prefill, steps: Array.from({ length: 60 }, (_, i) => `s${i}`) }, []).steps).toHaveLength(50);
  });
});
