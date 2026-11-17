import { describe, expect, test } from "bun:test";
import { withInstructions } from "../src/design/sessions";
import { jobPrompt, qaLabel, type PromptInputs } from "../src/qa/prompts";
import type { Area, AreaId, Batching, BugId, Driver, Feature, FeatureId, Launch, MapUnit, Plan, Run, StepId } from "../src/qa/types";

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
    mapText: "",
    areas: [],
    plans: new Map(ids.filter((u) => u !== "map" && launch.stage !== "fix").map((u) => [fid(u), PLAN(u)])),
    runs: new Map(ids.filter((u) => launch.stage === "test").map((u, n) => [fid(u), RUN(u, n)])),
    bugs: new Map([[BUG.id, BUG]]),
    openBugs: [{ id: "bug-old", title: "Old bug", url: "http://localhost:3000/x" }],
    ...o,
  };
}

const text = (i: PromptInputs) => jobPrompt(i).instructions;
const flat_ = (s: string) => s.replace(/\s+/g, " ");
const mapLaunch = (unit: MapUnit): Launch => ({ stage: "map", units: [unit] });

const launches: Record<string, { each: Launch; together: Launch }> = {
  map: { each: { stage: "map", units: ["map"] }, together: { stage: "map", units: ["map"] } },
  plan: { each: { stage: "plan", units: [fid("checkout")] }, together: { stage: "plan", units: [fid("checkout"), fid("discount")] } },
  test: { each: { stage: "test", units: [fid("checkout")] }, together: { stage: "test", units: [fid("checkout"), fid("discount")] } },
  fix: { each: { stage: "fix", units: [BUG.id] }, together: { stage: "fix", units: [BUG.id, "bug-two" as BugId] } },
};

describe("every stage's prompt shares its blocks", () => {
  for (const stage of ["map", "plan", "test", "fix"] as const) {
    for (const batching of ["each", "together"] as Batching[]) {
      test(`${stage} ${batching}: app and the open bugs`, () => {
        const t = text(inputs(launches[stage]![batching], { batching, note: "Focus on the new card form" }));
        expect(t).toContain("The app is running at http://localhost:3000.");
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
  const FLAT_TEXT = "# Features\n\n## Checkout\nid: checkout\nwhere: /cart\nA buyer pays.\n";
  const flatPrompt = (o: Partial<PromptInputs> = {}) => text(inputs(launches.map!.each, { mapText: FLAT_TEXT, ...o }));

  test("the flat map is saved with qa_map, from its starting text, in the documented format", () => {
    const t = flatPrompt();
    expect(t).toContain("Map the user-facing features of this product");
    expect(t).toContain("Aim for 5 to 40 features in all.");
    expect(t).toContain("parent: checkout");
    expect(t).toContain("Drop any `plans:`");
    expect(t).toContain("Change no other file.");
    expect(t).toContain("calling qa_map with the WHOLE text for your unit");
    expect(t).toContain("Never edit `lab/features.md` yourself");
    expect(t).toContain("was: <old-id>");
    expect(t).toContain("drop: id-1, id-2");
    expect(t).toContain('"No changes." is a fine outcome');
    expect(t).toContain(`Starting text:\n\`\`\`\n${FLAT_TEXT.trim()}\n\`\`\``);
    expect(t).not.toContain("You lead a Hydra pair");
  });
  test("no prompt tells the agent to keep ids by hand or to write the file", () => {
    const areas = areasFixture();
    for (const [launch, o] of [[launches.map!.each, {}], [mapLaunch("areas"), {}], [mapLaunch("area:shop"), { areas }]] as const) {
      const t = text(inputs(launch, { mapText: "x", ...o }));
      expect(t).not.toContain("Keep every existing feature's id exactly");
      expect(t).not.toContain("Write ONLY `lab/features.md`");
      expect(t).toContain("qa_map");
    }
  });
  test("with nothing saved the agent starts from scratch", () => {
    expect(flatPrompt({ mapText: "# Features\n" })).toContain("There is nothing saved yet: start from scratch.");
  });
  test("a pair splits the areas, fills the cap, and the lead saves the merged text with qa_map", () => {
    const t = flatPrompt({ driver: { kind: "pair", pairId: "p" }, pairCap: 4 });
    expect(t).toContain("You lead a Hydra pair.");
    expect(t).toContain("at most 4");
    expect(t).not.toContain("{cap}");
    expect(flat_(t)).toContain("Do NOT write any file and do NOT call qa_map");
    expect(flat_(t)).toContain("Then YOU call qa_map once with the merged text");
  });

  const SHOP = "# Shop\narea: shop\nwhere: /cart, /checkout\nBuying things.\n\n## Checkout\nid: checkout\nwhere: /cart\nA buyer pays.\n";
  function areasFixture(): Area[] {
    return [
      { id: "shop" as AreaId, title: "Shop", where: ["/cart", "/checkout"], summary: "Buying things." },
      { id: "team" as AreaId, title: "Team", where: ["/team"], summary: "People." },
      { id: "admin" as AreaId, title: "Admin console", where: [], summary: "Staff." },
    ];
  }
  const areaPrompt = (o: Partial<PromptInputs> = {}) => text(inputs(mapLaunch("area:shop"), { mapText: SHOP, areas: areasFixture(), ...o }));

  test("an area job embeds only its own section and one line per other area", () => {
    const t = areaPrompt();
    expect(t).toContain('Map the area "Shop" of this product (/cart, /checkout)');
    expect(t).toContain("Map only this area.");
    expect(t).toContain("Aim for 5 to 40 features in this area.");
    expect(t).toContain(`Starting text:\n\`\`\`\n${SHOP.trim()}\n\`\`\``);
    expect(t).toContain("- Team (/team)\n- Admin console (no paths)");
    expect(t).not.toContain("- Shop (");
    expect(t.match(/^- (Team|Admin console|Shop) \(/gm)).toHaveLength(2);
    expect(t).not.toContain("People.");
    expect(t).toContain("calling qa_map with the WHOLE text for your unit");
    expect(t).toContain("was: <old-id>");
  });
  test("an area job and the survey never get the pair text, even when a head cap is passed", () => {
    expect(areaPrompt({ pairCap: 3 })).not.toContain("Hydra pair");
    expect(text(inputs(mapLaunch("areas"), { pairCap: 3 }))).not.toContain("Hydra pair");
  });
  test("an area job with no other area has no borders line", () => {
    expect(areaPrompt({ areas: areasFixture().slice(0, 1) })).not.toContain("The other areas");
  });

  test("the survey asks for 3 to 15 areas with no features, and embeds the areas as they are", () => {
    const t = text(inputs(mapLaunch("areas"), { mapText: "# Shop\narea: shop\nwhere: /cart\nBuying.\n" }));
    expect(t).toContain("split it into 3 to 15 areas a user would recognise");
    expect(t).toContain("# Shop\narea: shop\nwhere: /cart, /checkout\nOne line on what the area covers.");
    expect(t).toContain("Write NO features");
    expect(t).toContain("calling qa_map with the WHOLE text for your unit");
    expect(t).toContain("Starting text:\n```\n# Shop\narea: shop");
    expect(t).not.toContain("Hydra pair");
    expect(t).not.toContain("Aim for 5 to 40");
  });
  test("the title names the area, the survey, or the flat map", () => {
    expect(jobPrompt(inputs(mapLaunch("area:shop"), { areas: areasFixture() })).title).toBe("QA · map · Shop");
    expect(jobPrompt(inputs(mapLaunch("areas"))).title).toBe("QA · map · Areas");
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
    expect(flat_(t)).toContain("Do not end your turn while a head is open or unmerged.");
    expect(t).not.toContain("{cap}");
  });
});

describe("visible text and title", () => {
  test("the operator's note is what the thread shows, else a line per stage", () => {
    expect(jobPrompt(inputs(launches.plan!.each, { note: "Check mobile" })).visible).toBe("Check mobile");
    expect(jobPrompt(inputs(launches.plan!.each)).visible).toBe("Write the test flows.");
  });
  test("the operator's note reaches the model once, in the combined prompt", () => {
    for (const stage of ["map", "plan", "test", "fix"] as const) {
      for (const batching of ["each", "together"] as Batching[]) {
        const t = jobPrompt(inputs(launches[stage]![batching], { batching, note: "Focus on the new card form" }));
        const prompt = withInstructions(t.visible, qaLabel(stage), t.instructions);
        expect(prompt.split("Focus on the new card form").length - 1).toBe(1);
        expect(prompt.startsWith("Focus on the new card form\n\n")).toBe(true);
      }
    }
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
