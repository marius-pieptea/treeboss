import { describe, expect, test } from "bun:test";
import type { CheckId, CheckOutcome, CheckResult, CheckStatus, Tier, TreebossViewState } from "../../web/src/lib/types";
import { TREEBOSS_TIP, extractTierLines, gateFooter, gateProgress, gateRows, sessionTreeboss, tierLabel, treebossDefault } from "../../web/src/features/agent/treeboss-logic";

describe("treeboss mode", () => {
  test("the treeboss_mode setting decides the default for new sessions; off until settings load", () => {
    expect(treebossDefault(undefined)).toBe(false);
    expect(treebossDefault([])).toBe(false);
    expect(treebossDefault([{ key: "next_steps", value: "on" }])).toBe(false);
    expect(treebossDefault([{ key: "treeboss_mode", value: "off" }])).toBe(false);
    expect(treebossDefault([{ key: "treeboss_mode", value: "on" }])).toBe(true);
  });

  test("an open session is in treeboss mode only when the daemon says so", () => {
    expect(sessionTreeboss(null)).toBe(false);
    expect(sessionTreeboss(undefined)).toBe(false);
    expect(sessionTreeboss({})).toBe(false);
    expect(sessionTreeboss({ treeboss: false })).toBe(false);
    expect(sessionTreeboss({ treeboss: true })).toBe(true);
  });

  test("the tooltip text is the agreed one", () => {
    expect(TREEBOSS_TIP).toBe("Treeboss mode: tier triage, design and docs checks, specs on the roadmap.");
  });
});

describe("treeboss gate progress", () => {
  const check = (id: CheckId, status: CheckStatus, detail: string | null = null): CheckResult => ({ id, status, detail });
  const state = (over: Partial<TreebossViewState> & { outcome?: CheckOutcome; checks?: CheckResult[] | null } = {}): TreebossViewState => {
    const { outcome = "passed", checks = null, ...rest } = over;
    return {
      tier: "feature",
      tier_source: "agent",
      attempts: 0,
      max_attempts: 3,
      ...rest,
      last_check: checks === null ? null : { turn_id: "t1", at: "2026-10-12T10:00:00Z", tier: "feature", outcome, checks },
    };
  };
  const allPass = [check("design", "pass"), check("spec", "pass"), check("roadmap", "pass"), check("docs", "pass")];

  test("no state and no check yet: nothing passed, idle, all pending", () => {
    expect(gateProgress(null)).toEqual({ passed: 0, applicable: 0, fraction: 0, tone: "idle" });
    expect(gateProgress(undefined)).toEqual({ passed: 0, applicable: 0, fraction: 0, tone: "idle" });
    expect(gateProgress(state())).toEqual({ passed: 0, applicable: 0, fraction: 0, tone: "idle" });
    expect(gateRows(null).map((r) => [r.id, r.status, r.detail])).toEqual([
      ["design", "pending", "not checked yet"],
      ["spec", "pending", "not checked yet"],
      ["roadmap", "pending", "not checked yet"],
      ["docs", "pending", "not checked yet"],
    ]);
    expect(gateRows(state())[0]).toEqual({ id: "design", label: "Design", status: "pending", detail: "not checked yet" });
  });

  test("a check with no result shows as not checked yet, in order", () => {
    const rows = gateRows(state({ outcome: "fixing", checks: [check("spec", "pass"), check("design", "fail", "missing a token")] }));
    expect(rows.map((r) => [r.id, r.label, r.status])).toEqual([
      ["design", "Design", "fail"],
      ["spec", "Spec", "pass"],
      ["roadmap", "Roadmap", "pending"],
      ["docs", "Docs", "pending"],
    ]);
    expect(rows[0].detail).toBe("missing a token");
    expect(rows[2].detail).toBe("not checked yet");
  });

  test("all passed: full fill, passed tone", () => {
    expect(gateProgress(state({ checks: allPass }))).toEqual({ passed: 4, applicable: 4, fraction: 1, tone: "passed" });
    expect(gateRows(state({ checks: allPass })).every((r) => r.status === "pass")).toBe(true);
  });

  test("one fail while fixing: three of four, fixing tone", () => {
    const checks = [check("design", "fail", "DESIGN.md has no token for the chip"), check("spec", "pass"), check("roadmap", "pass"), check("docs", "pass")];
    const p = gateProgress(state({ outcome: "fixing", attempts: 1, checks }));
    expect(p).toEqual({ passed: 3, applicable: 4, fraction: 0.75, tone: "fixing" });
    expect(gateFooter(state({ outcome: "fixing", attempts: 1, checks }))).toBe("Fixing: attempt 1 of 3");
  });

  test("skips do not count: all skip with passed is a full fill", () => {
    const checks = [check("design", "skip", "no UI change"), check("spec", "skip", "tweak"), check("roadmap", "skip", "tweak"), check("docs", "skip", "no doc affected")];
    expect(gateProgress(state({ checks }))).toEqual({ passed: 0, applicable: 0, fraction: 1, tone: "passed" });
    expect(gateRows(state({ checks }))[0]).toEqual({ id: "design", label: "Design", status: "skip", detail: "no UI change" });
  });

  test("gave up: the share that passed, gave_up tone", () => {
    const checks = [check("design", "fail", "a"), check("spec", "fail", "b"), check("roadmap", "pass"), check("docs", "pass")];
    const s = state({ outcome: "gave_up", attempts: 3, checks });
    expect(gateProgress(s)).toEqual({ passed: 2, applicable: 4, fraction: 0.5, tone: "gave_up" });
    expect(gateFooter(s)).toBe("Gave up after 3 attempts");
  });

  test("nothing built and not checked are idle, with their own footers", () => {
    expect(gateProgress(state({ outcome: "nothing_built", checks: [] })).tone).toBe("idle");
    expect(gateFooter(state({ outcome: "nothing_built", checks: [] }))).toBe("Last turn built nothing to check");
    expect(gateProgress(state({ outcome: "not_checked", checks: [] })).tone).toBe("idle");
    expect(gateFooter(state({ outcome: "not_checked", checks: [] }))).toBe("Gates run after the next turn that changes files");
    expect(gateFooter(null)).toBe("Gates run after the next turn that changes files");
  });
});

describe("treeboss tier label", () => {
  const s = (tier: Tier | null, tier_source: TreebossViewState["tier_source"]): TreebossViewState => ({ tier, tier_source, attempts: 0, max_attempts: 3, last_check: null });

  test("says who set the tier", () => {
    expect(tierLabel(null)).toBe("no tier yet");
    expect(tierLabel(s(null, null))).toBe("no tier yet");
    expect(tierLabel(s("feature", "operator"))).toBe("feature (set by you)");
    expect(tierLabel(s("tweak", "agent"))).toBe("tweak (agent)");
    expect(tierLabel(s("area", null))).toBe("area");
  });
});

describe("treeboss tier line in an assistant message", () => {
  test("plain: the line is taken out and the tier returned", () => {
    expect(extractTierLines("TREEBOSS_TIER: feature\n\nDone, the chip is in.")).toEqual({ text: "Done, the chip is in.", tier: "feature" });
  });

  test("bold and backticks are matched, as the gate matches them", () => {
    expect(extractTierLines("**TREEBOSS_TIER: area**\nBody")).toEqual({ text: "Body", tier: "area" });
    expect(extractTierLines("`TREEBOSS_TIER: tweak`\nBody")).toEqual({ text: "Body", tier: "tweak" });
    expect(extractTierLines("  *TREEBOSS_TIER:*  feature\r\nBody")).toEqual({ text: "Body", tier: "feature" });
  });

  test("a line in the middle is taken out and the text around it kept", () => {
    expect(extractTierLines("Intro line.\nTREEBOSS_TIER: feature\nMore.")).toEqual({ text: "Intro line.\nMore.", tier: "feature" });
  });

  test("several lines: the last one wins and all of them go", () => {
    expect(extractTierLines("TREEBOSS_TIER: tweak\nx\nTREEBOSS_TIER: area")).toEqual({ text: "x", tier: "area" });
  });

  test("no tier line: the text comes back unchanged, and a tier word mid-sentence is not a line", () => {
    const plain = "The tier is TREEBOSS_TIER: feature, said in passing.\n\n  indented  \n";
    expect(extractTierLines(plain)).toEqual({ text: plain, tier: null });
    expect(extractTierLines("TREEBOSS_TIER: featured")).toEqual({ text: "TREEBOSS_TIER: featured", tier: null });
    expect(extractTierLines("")).toEqual({ text: "", tier: null });
  });

  test("a tier line inside a fenced code block stays, and one outside it is taken out", () => {
    const fenced = "```\nTREEBOSS_TIER: feature\n```\nText";
    expect(extractTierLines(fenced)).toEqual({ text: fenced, tier: null });
    expect(extractTierLines("```md\nTREEBOSS_TIER: tweak\n```\nTREEBOSS_TIER: area\nok")).toEqual({ text: "```md\nTREEBOSS_TIER: tweak\n```\nok", tier: "area" });
    expect(extractTierLines("~~~\nTREEBOSS_TIER: tweak\n~~~")).toEqual({ text: "~~~\nTREEBOSS_TIER: tweak\n~~~", tier: null });
  });
});
