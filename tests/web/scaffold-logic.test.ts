import { describe, expect, test } from "bun:test";
import { scaffoldRunBody } from "../../web/src/features/scaffold/logic";

const base = { recipe: "nextjs", target: "/work/app", describe: "A habit tracker", session: true };

describe("scaffoldRunBody", () => {
  test("asks for the server's defaults when no engine is picked", () => {
    expect(scaffoldRunBody(base)).toMatchObject({ recipe: "nextjs", target: "/work/app", describe: "A habit tracker", session: true });
  });

  test("the starter session carries the picked engine and model", () => {
    expect(scaffoldRunBody({ ...base, engine: "claude", model: "opus" })).toMatchObject({ session: { engine: "claude", model: "opus" } });
  });

  test("an engine with no model still starts the session on that engine", () => {
    expect(scaffoldRunBody({ ...base, engine: "claude" })).toMatchObject({ session: { engine: "claude" } });
  });

  test("no session means no engine, and the design system travels only when set", () => {
    expect(scaffoldRunBody({ ...base, session: false, engine: "claude" })).toMatchObject({ session: false });
    expect("designSystem" in scaffoldRunBody(base)).toBe(false);
    expect(scaffoldRunBody({ ...base, design: "graphite" })).toMatchObject({ designSystem: "graphite" });
  });
});
