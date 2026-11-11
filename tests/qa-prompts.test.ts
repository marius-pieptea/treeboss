import { describe, expect, test } from "bun:test";
import { jobPrompt, qaLabel, type PromptInputs } from "../src/qa/prompts";
import type { Batching, BugId, Driver, Feature, FeatureId, Launch, Plan, Run, StepId } from "../src/qa/types";

const fid = (s: string) => s as FeatureId;
const FEATURES: Feature[] = [
  { id: fid("checkout"), title: "Checkout", where: ["/cart", "/checkout"], parent: null, summary: "A buyer pays for the cart." },
  { id: fid("discount"), title: "Apply a discount code", where: ["/cart"], parent: fid("checkout"), summary: "A buyer enters a code." },
];
const PLAN = (id: string): Plan => ({ feature: fid(id), title: `Plan of ${id}`, intro: "Covers the happy path.", problem: null, steps: [{ id: "s-aaaa" as StepId, action: "Open the cart", expected: "Two items listed", path: "/cart" as never }] });
const RUN = (id: string, n: number): Run => ({ id: `qa_${id}${n}`, feature: id, startedAt: 1, sessionId: null, steps: [{ id: "s-aaaa", action: "Open the cart", expected: "Two items listed", path: "/cart", outcome: { state: "pending" } }] });
const BUG = { id: "bug-total" as BugId, path: "lab/findings/bug-total.md", title: "Total ignores the code", url: "http://localhost:3000/cart", kind: "logic", capture: "ev_1", body: "Steps to reproduce\n1. Add a code" };

function inputs(launch: Launch, o: Partial<PromptInputs> = {}): PromptInputs {
  const ids = launch.units as readonly string[];
  return {
    launch,
    batching: "each",
    driver: { kind: "agent" } as Driver,
    pairCap: null,
    note: "",
    baseUrl: "http://localhost:3000",
    features: FEATURES,
    plans: new Map(ids.filter((u) => u !== "map" && launch.stage !== "fix").map((u) => [fid(u), PLAN(u)])),
    runs: new Map(ids.filter((u) => launch.stage === "test").map((u, n) => [fid(u), RUN(u, n)])),
    bugs: new Map([[BUG.id, BUG]]),
    openBugs: [{ id: "bug-old", title: "Old bug", url: "http://localhost:3000/x" }],
    ...o,
  };
}

const text = (i: PromptInputs) => jobPrompt(i).instructions;
const flat = (s: string) => s.replace(/\s+/g, " ");

const launches: Record<string, { each: Launch; together: Launch }> = {
  map: { each: { stage: "map", units: ["map"] }, together: { stage: "map", units: ["map"] } },
  plan: { each: { stage: "plan", units: [fid("checkout")] }, together: { stage: "plan", units: [fid("checkout"), fid("discount")] } },
  test: { each: { stage: "test", units: [fid("checkout")] }, together: { stage: "test", units: [fid("checkout"), fid("discount")] } },
  fix: { each: { stage: "fix", units: [BUG.id] }, together: { stage: "fix", units: [BUG.id, "bug-two" as BugId] } },
};

describe("every stage's prompt shares its blocks", () => {
  for (const stage of ["map", "plan", "test", "fix"] as const) {
    for (const batching of ["each", "together"] as Batching[]) {
      test(`${stage} ${batching}: app, note and the open bugs`, () => {
        const t = text(inputs(launches[stage]![batching], { batching, note: "Focus on the new card form" }));
        expect(t).toContain("The app is running at http://localhost:3000.");
        expect(t).toContain("The operator's note:\nFocus on the new card form");
        if (stage !== "fix") expect(t).toContain("- bug-old: Old bug (http://localhost:3000/x)");
        if (stage !== "fix") expect(t).toContain("browser_navigate");
      });
    }
  }
  test("without a base url the agent is told how to find the app", () => {
    expect(text(inputs(launches.map!.each, { baseUrl: null }))).toContain("Find the running app first");
  });
  test("no open bugs says so", () => {
    expect(text(inputs(launches.plan!.each, { openBugs: [] }))).toContain("There are no open bugs yet.");
  });
  test("no unconfirmed language is left", () => {
    for (const stage of ["map", "plan", "test", "fix"] as const) expect(text(inputs(launches[stage]!.each)).toLowerCase()).not.toContain("unconfirmed");
  });
});

describe("map", () => {
  test("writes only features.md in the documented format", () => {
    const t = text(inputs(launches.map!.each));
    expect(t).toContain("Map the user-facing features of this product into `lab/features.md`");
    expect(t).toContain("parent: checkout");
    expect(t).toContain("Drop any `plans:`");
    expect(t).toContain("Change no other file.");
    expect(t).not.toContain("You lead a Hydra pair");
  });
  test("a pair splits the areas, fills the cap and writes the file alone", () => {
    const t = text(inputs(launches.map!.each, { driver: { kind: "pair", pairId: "p" }, pairCap: 4 }));
    expect(t).toContain("You lead a Hydra pair.");
    expect(t).toContain("at most 4");
    expect(t).not.toContain("{cap}");
    expect(flat(t)).toContain("Do NOT write any file");
    expect(t).toContain("Then YOU write lab/features.md alone");
  });
});

describe("plan", () => {
  test("each: one feature, its file, its current plan to revise", () => {
    const t = text(inputs(launches.plan!.each));
    expect(t).toContain('Write the test flow for the feature "Checkout" (id checkout) to `lab/qa/checkout.md`.');
    expect(t).toContain("It lives on: /cart, /checkout.");
    expect(t).toContain("revise it: keep good steps with their ids");
    expect(t).toContain("1. [s-aaaa] Open the cart");
    expect(t).toContain("Write new steps WITHOUT an id");
    expect(t).toContain("Write ONLY `lab/qa/checkout.md`. Change no other file and do not commit.");
    expect(t).not.toContain("Pass feature: <id> to bug_log, with");
  });
  test("a feature with no plan has nothing to revise", () => {
    expect(text(inputs(launches.plan!.each, { plans: new Map() }))).not.toContain("revise it");
  });
  test("a broken plan is rewritten, not revised", () => {
    const plans = new Map([[fid("checkout"), { ...PLAN("checkout"), problem: "no title", steps: [] }]]);
    expect(text(inputs(launches.plan!.each, { plans }))).not.toContain("revise it");
  });
  test("together: a block and a file per feature, and bug_log is told which feature", () => {
    const t = text(inputs(launches.plan!.together, { batching: "together" }));
    expect(t).toContain("Write a test flow for each of these features, one file each, in this order:");
    expect(t).toContain("`lab/qa/checkout.md`");
    expect(t).toContain("`lab/qa/discount.md`");
    expect(t).toContain("Pass feature: <id> to bug_log");
  });
  test("pair: one head per feature, shared folder, cap filled", () => {
    for (const batching of ["each", "together"] as Batching[]) {
      const t = text(inputs(launches.plan![batching], { batching, driver: { kind: "pair", pairId: "p" }, pairCap: 3 }));
      expect(t).toContain("Open one head per feature with subagent_create, isolate: false (at most 3 open");
      expect(t).toContain("each writes its own file, so there is nothing to merge");
      expect(t).not.toContain("{cap}");
    }
  });
});

describe("test", () => {
  test("each: the run and its steps, and how to record them", () => {
    const t = text(inputs(launches.test!.each));
    expect(t).toContain('Run the test flow "Checkout" (feature checkout, run qa_checkout0) in the browser');
    expect(t).toContain("- s-aaaa: Open the cart\n  page: /cart\n  expect: Two items listed");
    expect(t).toContain("How to record: pass (say what you saw in note)");
    expect(t).toContain("Do not record a step you did not try. Do not change any file.");
    expect(t).toContain("End with one paragraph: passed, failed, blocked, and the bug ids.");
  });
  test("together: every flow under its run, with the flow and feature arguments", () => {
    const t = text(inputs(launches.test!.together, { batching: "together" }));
    expect(t).toContain("Run these flows one after another, in this order.");
    expect(t).toContain("Flow checkout (run qa_checkout0)");
    expect(t).toContain("Flow discount (run qa_discount1)");
    expect(t).toContain("Pass flow: discount to qa_record and feature: discount to bug_log.");
  });
  test("a pair job is a plain session: no lead text even with the pair as driver", () => {
    expect(text(inputs(launches.test!.each, { driver: { kind: "pair", pairId: "p" }, pairCap: null }))).not.toContain("Hydra pair");
  });
});

describe("fix", () => {
  test("each: the brief, reproduce first, dismiss or ship", () => {
    const t = text(inputs(launches.fix!.each));
    expect(t).toContain("Fix this bug.");
    expect(t).toContain("Bug bug-total (lab/findings/bug-total.md): Total ignores the code");
    expect(t).toContain("Evidence capture: ev_1");
    expect(t).toContain("Reproduce it first in the browser at http://localhost:3000/cart");
    expect(t).toContain("set `status: dismissed` in lab/findings/bug-total.md");
    expect(t).toContain("set `status: shipped` in lab/findings/bug-total.md");
    expect(t).toContain("follow DESIGN.md and design/tokens.css");
  });
  test("together: one at a time, in order", () => {
    const t = text(inputs(launches.fix!.together, { batching: "together" }));
    expect(t).toContain("Fix these bugs one at a time, in this order.");
    expect(t).toContain("Bug bug-total");
    expect(t).toContain("Bug bug-two");
  });
  test("pair: heads in worktrees, merged one at a time, verified before shipping", () => {
    const t = text(inputs(launches.fix!.each, { driver: { kind: "pair", pairId: "p" }, pairCap: 2 }));
    expect(t).toContain("Open one head per bug with subagent_create (its own worktree; at most 2 open");
    expect(t).toContain("Do NOT edit lab/findings/.");
    expect(t).toContain("subagent_merge it, one at a time");
    expect(flat(t)).toContain("Do not end your turn while a head is open or unmerged.");
    expect(t).not.toContain("{cap}");
  });
});

describe("visible text and title", () => {
  test("the operator's note is what the thread shows, else a line per stage", () => {
    expect(jobPrompt(inputs(launches.plan!.each, { note: "Check mobile" })).visible).toBe("Check mobile");
    expect(jobPrompt(inputs(launches.plan!.each)).visible).toBe("Write the test flows.");
  });
  test("the title names the stage, the first unit and how many more", () => {
    expect(jobPrompt(inputs(launches.plan!.each)).title).toBe("QA · plan · Checkout");
    expect(jobPrompt(inputs(launches.plan!.together)).title).toBe("QA · plan · Checkout +1");
    expect(jobPrompt(inputs(launches.map!.each)).title).toBe("QA · map · Features");
    expect(jobPrompt(inputs(launches.fix!.each)).title).toBe("QA · fix · Total ignores the code");
    expect(qaLabel("test")).toBe("QA · test");
  });
  test("a long title is cut at 100 characters", () => {
    const long = [{ ...FEATURES[0]!, title: "x".repeat(300) }];
    expect(jobPrompt(inputs(launches.plan!.each, { features: long })).title.length).toBe(100);
  });
});
