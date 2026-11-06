import { describe, expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "../../web/src/lib/fuzzy";

describe("fuzzy file matching", () => {
  test("a file's full base name finds it (the boundary jump must not strand later letters)", () => {
    expect(fuzzyScore("math", "src/utils/math.ts")).not.toBeNull();
    expect(fuzzyScore("greet", "src/greet.ts")).not.toBeNull();
    expect(fuzzyScore("server.ts", "src/server.ts")).not.toBeNull();
  });
  test("every query letter must appear, in order", () => {
    expect(fuzzyScore("xyz", "src/greet.ts")).toBeNull();
    expect(fuzzyScore("tsg", "src/greet.ts")).toBeNull();
  });
  test("a name match beats a directory match, and shorter paths win ties", () => {
    const r = fuzzyFilter("greet", ["greet/other/readme.md", "src/greet.ts", "src/greeting-helper.ts"]);
    expect(r[0].path).toBe("src/greet.ts");
  });
  test("initials work across word boundaries", () => {
    expect(fuzzyFilter("uim", ["src/utils/math.ts", "src/unrelated.txt"])[0].path).toBe("src/utils/math.ts");
  });
  test("an empty query lists files without scoring", () => {
    expect(fuzzyFilter("", ["a", "b"]).map((m) => m.path)).toEqual(["a", "b"]);
  });
  test("matched indices point at the matched letters", () => {
    const m = fuzzyScore("gt", "src/greet.ts")!;
    expect(m.indices.map((i) => "src/greet.ts"[i]).join("")).toBe("gt");
  });
});
