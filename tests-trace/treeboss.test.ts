import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START treeboss\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END treeboss\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import type { TurnResult } from "../src/engines/runner";
import { setSetting } from "../src/settings";
import { FIX_HEADER, MAX_FIX_ATTEMPTS, designViolations, docsViolation, fixPrompt, hexLiterals, isSource, isUi, parseDiff, parseTier, roadmapViolation, specViolation } from "../src/treeboss/gate";
import { AFTER_RESEARCH_PICK, RESEARCH_RULES } from "../src/treeboss/research";
import { treebossBlock } from "../src/treeboss/rules";
import { bumpAttempts, getState, isTreeboss, markDelivered, migrateTable, setOperatorTier, setTier, setTreeboss } from "../src/treeboss/store";
import { makeDir, makeRepo, resetState } from "./helpers";

const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  resetState();
  getState("-"); // makes sure the table exists
  db().exec("DELETE FROM session_treeboss");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** Poll until `check` holds, or fail after `timeoutMs`. */
async function until(check: () => boolean, label: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}
const idle = (id: string) => until(() => getSession(id)!.status !== "running", `${id} to settle`);

describe("the tier the agent declares", () => {
  test("a tier line inside a fenced code block is not the agent's statement, backticks or tildes alike", () => {
    expect(parseTier("```\nTREEBOSS_TIER: area\n```\nTREEBOSS_TIER: tweak")).toBe("tweak");
    expect(parseTier("~~~text\nTREEBOSS_TIER: area\n~~~")).toBeNull();
    // A fence closes only with the same character and at least as many of them.
    expect(parseTier("````\n```\nTREEBOSS_TIER: area\n```\n````")).toBeNull();
    expect(parseTier("```\nTREEBOSS_TIER: area\n~~~\nTREEBOSS_TIER: feature")).toBeNull();
    // An unclosed fence runs to the end of the text, as in markdown.
    expect(parseTier("```\nTREEBOSS_TIER: area")).toBeNull();
    expect(parseTier("Plan:\n```\nTREEBOSS_TIER: area\n```\nTREEBOSS_TIER: feature\nDone.")).toBe("feature");
  });

  test("the line is read wherever it sits, bold or plain; the last statement wins; none is null", () => {
    expect(parseTier("TREEBOSS_TIER: feature\nDone.")).toBe("feature");
    expect(parseTier("Working on it.\n**TREEBOSS_TIER: area**\n")).toBe("area");
    expect(parseTier("  `TREEBOSS_TIER: tweak`")).toBe("tweak");
    expect(parseTier("TREEBOSS_TIER: tweak\nactually\nTREEBOSS_TIER: feature")).toBe("feature");
    expect(parseTier("the tier is TREEBOSS_TIER: feature, inline")).toBeNull();
    expect(parseTier("TREEBOSS_TIER: huge")).toBeNull();
    expect(parseTier("")).toBeNull();
  });

  test("the gate reads it from every text block of the turn, not only the final answer", async () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      // The tier line is in an earlier message, before the tool calls; the final answer has none.
      o.onLog?.("TREEBOSS_TIER: tweak\nA small rename, I will look first.");
      o.onLog?.("[fake] → Edit(src/base.ts)");
      write(o.cwd, "src/base.ts", "export const b = 1;\n");
      o.onLog?.("Renamed it.");
      return result("Done.");
    });
    const s = createLead({ prompt: "rename a", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "passed", "the gate to record the turn");
    expect(getState(s.id)).toMatchObject({ tier: "tweak", tierSource: "agent" });
    // A tweak owes no docs or spec: had the gate read the tier as the default (feature), it would have sent a fix turn.
    expect(prompts.length).toBe(1);
  });
});

describe("hex colors", () => {
  test("3, 6 and 8 digit literals are found, lower-cased; words, ids and 4-digit runs are not", () => {
    expect(hexLiterals("color: #FFF; bg: #aabbcc; x: #11223380; #app #abcd #add-ons")).toEqual(["#fff", "#aabbcc", "#11223380"]);
  });

  test("an added line in a UI file passes when the token exists and fails with file and line when it does not", () => {
    const tokens = "--color-accent: #6d28d9;\n--color-danger: #B91C1C;";
    const diff = [
      "diff --git a/web/Panel.tsx b/web/Panel.tsx",
      "--- a/web/Panel.tsx",
      "+++ b/web/Panel.tsx",
      "@@ -3 +3,2 @@",
      "-old",
      '+  color: "#6D28D9",',
      '+  border: "#ff0000",',
      "diff --git a/src/x.ts b/src/x.ts",
      "@@ -1 +1 @@",
      '+const c = "#ff0000";',
    ].join("\n");
    const changes = parseDiff(diff);
    expect(changes.files).toEqual(["web/Panel.tsx", "src/x.ts"]);
    expect(changes.added.map((a) => [a.file, a.line])).toEqual([
      ["web/Panel.tsx", 3],
      ["web/Panel.tsx", 4],
      ["src/x.ts", 1],
    ]);
    // Only UI files are scanned: the .ts file's literal is not a design violation.
    expect(designViolations(changes, tokens)).toEqual(["web/Panel.tsx:4 uses #ff0000, which is not a token in design/tokens.css"]);
  });

  test("the tokens are read from a real file, so a value written with different case still matches", () => {
    const dir = makeDir();
    write(dir, "design/tokens.css", ":root { --color-text: #1A1A1C; }\n");
    const css = fs.readFileSync(path.join(dir, "design/tokens.css"), "utf-8");
    const changes = parseDiff(["diff --git a/a.css b/a.css", "@@ -0,0 +1 @@", "+  color: #1a1a1c;"].join("\n"));
    expect(designViolations(changes, css)).toEqual([]);
  });

  test("test files and non-UI files are never design-checked", () => {
    expect(isUi("web/Panel.tsx")).toBe(true);
    expect(isUi("web/Panel.test.tsx")).toBe(false);
    expect(isUi("tests/panel.css")).toBe(false);
    expect(isUi("src/a.ts")).toBe(false);
  });
});

describe("the docs and spec checks", () => {
  test("a tweak is never asked for docs or a spec", () => {
    expect(docsViolation("tweak", ["src/a.ts"], "docs")).toBeNull();
    expect(specViolation("tweak", ["src/a.ts"], 0)).toBeNull();
  });

  test("feature or area source changes need a doc: a page in the docs folder, or a root *.md", () => {
    expect(isSource("src/a.ts")).toBe(true);
    expect(isSource("src/a.test.ts")).toBe(false);
    expect(isSource("docs/a.md")).toBe(false);
    expect(docsViolation("feature", ["src/a.ts"], "docs")).toMatch(/1 source file changed \(src\/a\.ts\)/);
    expect(docsViolation("area", ["src/a.ts", "docs/a.md"], "docs")).toBeNull();
    expect(docsViolation("feature", ["src/a.ts", "README.md"], "docs")).toBeNull();
    expect(docsViolation("feature", ["src/a.ts", "src/README.md"], "docs")).not.toBeNull();
    // Tests are not source, so a test-only change owes no doc.
    expect(docsViolation("feature", ["tests/a.test.ts"], "docs")).toBeNull();
  });

  test("feature or area needs a spec: attached to the session, or a change under specs/ or .specify/", () => {
    expect(specViolation("feature", ["src/a.ts"], 0)).toMatch(/no spec is attached/);
    expect(specViolation("area", ["src/a.ts"], 1)).toBeNull();
    expect(specViolation("feature", ["src/a.ts", "specs/001-x/spec.md"], 0)).toBeNull();
    expect(specViolation("feature", ["src/a.ts", ".specify/memory/constitution.md"], 0)).toBeNull();
    expect(specViolation("feature", ["src/a.ts", "specsx/a.md"], 0)).not.toBeNull();
  });

  test("the fix turn lists the violations, and says it is a gate fix", () => {
    const text = fixPrompt(["a.tsx:1 uses #fff", "docs missing"], 1);
    expect(text.startsWith(FIX_HEADER)).toBe(true);
    expect(text).toContain("- a.tsx:1 uses #fff");
    expect(text).toContain(`fix 1 of ${MAX_FIX_ATTEMPTS}`);
    const many = Array.from({ length: 25 }, (_, i) => `v${i}`);
    expect(fixPrompt(many, 2)).toContain("- and 5 more");
  });

  test("the fix turn asks for the whole task's outcome, not only the fix, and lets a rule that does not apply say so", () => {
    const text = fixPrompt(["docs missing"], 1);
    expect(text).toContain("finish anything left of the original task");
    expect(text).toContain("the outcome of the whole task: what was built, and what the fixes changed");
    expect(text).toContain("If a rule does not apply to this change, say which one and why");
    expect(text).not.toContain("then stop");
  });

  test("the messages name the spec and roadmap tools, never the trb CLI", () => {
    const messages = [
      specViolation("feature", ["src/a.ts"], 0),
      roadmapViolation("area", ["src/a.ts"], "ROADMAP.md"),
      docsViolation("feature", ["src/a.ts"], "docs"),
      fixPrompt([specViolation("feature", ["src/a.ts"], 0)!, roadmapViolation("area", ["src/a.ts"], "ROADMAP.md")!], 1),
    ].filter((m): m is string => Boolean(m));
    for (const m of messages) expect(m).not.toMatch(/\btrb\b/);
    expect(specViolation("feature", ["src/a.ts"], 0)).toContain("`spec_new`");
    expect(specViolation("feature", ["src/a.ts"], 0)).toContain("`spec_attach`");
  });

  test("feature and area need the roadmap file to change; a tweak does not, and the message names roadmap_propose", () => {
    expect(roadmapViolation("tweak", ["src/a.ts"], "ROADMAP.md")).toBeNull();
    expect(roadmapViolation("feature", ["src/a.ts"], "ROADMAP.md")).toMatch(/ROADMAP\.md did not change/);
    expect(roadmapViolation("feature", ["src/a.ts"], "ROADMAP.md")).toContain("`roadmap_propose`");
    expect(roadmapViolation("area", ["src/a.ts", "ROADMAP.md"], "ROADMAP.md")).toBeNull();
    // A roadmap in a subfolder is a different file.
    expect(roadmapViolation("area", ["src/a.ts", "docs/ROADMAP.md"], "ROADMAP.md")).not.toBeNull();
    expect(roadmapViolation("area", ["plans/ROADMAP.md"], "plans/ROADMAP.md")).toBeNull();
  });
});

describe("per-session state", () => {
  test("a session with no row follows the global setting", () => {
    expect(isTreeboss("s-a")).toBe(false);
    setSetting("treeboss_mode", "on");
    expect(isTreeboss("s-a")).toBe(true);
    setSetting("treeboss_mode", "off");
    expect(isTreeboss("s-a")).toBe(false);
  });

  test("a session's own choice wins over the global setting, both ways", () => {
    setSetting("treeboss_mode", "on");
    setTreeboss("s-b", false);
    expect(isTreeboss("s-b")).toBe(false);
    setSetting("treeboss_mode", "off");
    setTreeboss("s-c", true);
    expect(isTreeboss("s-c")).toBe(true);
  });

  test("switching on again sends the rules again; delivery marks the session on", () => {
    setTreeboss("s-d", true);
    markDelivered("s-d");
    expect(getState("s-d").delivered).toBe(true);
    setTreeboss("s-d", false);
    setTreeboss("s-d", true);
    expect(getState("s-d")).toMatchObject({ enabled: true, delivered: false });
    markDelivered("s-e");
    expect(getState("s-e")).toMatchObject({ enabled: true, delivered: true });
  });

  test("tier and fix attempts are kept per session", () => {
    setTreeboss("s-f", true);
    setTier("s-f", "area");
    expect(bumpAttempts("s-f")).toBe(1);
    expect(bumpAttempts("s-f")).toBe(2);
    expect(getState("s-f")).toMatchObject({ tier: "area", tierSource: "agent", attempts: 2 });
    expect(getState("s-g")).toMatchObject({ tier: null, tierSource: null, attempts: 0, lastCheck: null });
  });

  test("an operator's tier wins over what the agent declares until it is cleared; setting one starts the attempts over", () => {
    setTreeboss("s-h", true);
    expect(bumpAttempts("s-h")).toBe(1);
    setOperatorTier("s-h", "tweak");
    expect(getState("s-h")).toMatchObject({ tier: "tweak", tierSource: "operator", attempts: 0 });
    setTier("s-h", "area");
    expect(getState("s-h")).toMatchObject({ tier: "tweak", tierSource: "operator" });
    setOperatorTier("s-h", null);
    expect(getState("s-h")).toMatchObject({ tier: null, tierSource: null });
    setTier("s-h", "area");
    expect(getState("s-h")).toMatchObject({ tier: "area", tierSource: "agent" });
  });

  test("a table from before the tier_source and last_check columns is migrated in place, and its rows still read", () => {
    db().exec("ALTER TABLE session_treeboss DROP COLUMN tier_source");
    db().exec("ALTER TABLE session_treeboss DROP COLUMN last_check");
    db().exec("INSERT INTO session_treeboss (session_id, enabled, tier, attempts, delivered) VALUES ('s-old', 1, 'area', 1, 1)");
    migrateTable(db());
    migrateTable(db()); // a second run finds the columns and changes nothing
    expect(getState("s-old")).toMatchObject({ enabled: true, tier: "area", tierSource: "agent", attempts: 1, delivered: true, lastCheck: null });
  });
});

describe("the rules block", () => {
  test("it names the tier line, the design files, the spec and roadmap tools and the constitution", () => {
    const text = treebossBlock();
    expect(text).toContain("TREEBOSS_TIER: tweak");
    expect(text).toContain("DESIGN.md");
    expect(text).toContain("design/tokens.css");
    expect(text).toContain("`spec_new`");
    expect(text).toContain("`spec_attach`");
    expect(text).toContain("`roadmap_propose`");
    expect(text).toContain("ROADMAP.md");
    expect(text).toContain(".specify/memory/constitution.md");
    expect(text).toContain(RESEARCH_RULES.split("\n")[0]!);
  });

  test("the block never tells the agent to run the trb CLI, which is not on PATH in a project", () => {
    expect(treebossBlock()).not.toMatch(/\btrb\b/);
    expect(treebossBlock()).not.toMatch(/\bspec new\b|\bconstitution init\b/);
  });

  test("the area research steps and the after-the-pick steps are both in the block, the pick steps after the research", () => {
    const text = treebossBlock();
    expect(text).toContain(RESEARCH_RULES);
    expect(text).toContain(AFTER_RESEARCH_PICK);
    expect(text).toContain("### After the pick");
    expect(text.indexOf(RESEARCH_RULES)).toBeLessThan(text.indexOf(AFTER_RESEARCH_PICK));
  });

  test("the engine is told once: on the first turn, not on a resumed one, and again after switching on", async () => {
    const dir = makeDir();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return result("TREEBOSS_TIER: tweak\nok");
    });
    const s = createLead({ prompt: "rename the button", engine: "fake", cwd: dir, treeboss: true });
    await idle(s.id);
    send({ operator: true }, s.id, "and the next one");
    await idle(s.id);
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain("# Treeboss mode");
    expect(prompts[1]).not.toContain("# Treeboss mode");
    expect(getState(s.id).delivered).toBe(true);

    setTreeboss(s.id, false);
    setTreeboss(s.id, true);
    send({ operator: true }, s.id, "once more");
    await idle(s.id);
    expect(prompts[2]).toContain("# Treeboss mode");
  });

  test("a session that never chose gets nothing while the global setting is off", async () => {
    const dir = makeDir();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return result("ok");
    });
    const s = createLead({ prompt: "hello", engine: "fake", cwd: dir });
    await idle(s.id);
    expect(prompts[0]).not.toContain("# Treeboss mode");
    expect(isTreeboss(s.id)).toBe(false);
  });
});

describe("the toggle route and the session view", () => {
  const TOKEN = "treeboss-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
    setDaemonContext({ url: srv.url, token: TOKEN });
  });
  afterAll(() => {
    setDaemonContext(null);
    srv.stop();
  });
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  test("POST switches one session on and off, and the view says so", async () => {
    const s = createLead({ prompt: "hello", engine: "fake", cwd: makeDir() });
    await idle(s.id);
    expect(viewSession(getSession(s.id)!).treeboss).toBe(false);
    expect(await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: true })).toMatchObject({ status: 200, body: { treeboss: true } });
    expect(viewSession(getSession(s.id)!).treeboss).toBe(true);
    expect(await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: false })).toMatchObject({ body: { treeboss: false } });
    expect(isTreeboss(s.id)).toBe(false);
  });

  test("creating through the route: true and false are kept, omitted or null follows the global setting", async () => {
    setTurnRunner(async () => result("ok"));
    const create = async (extra: Record<string, unknown>) => {
      const r = await call("POST", "/api/sessions", { prompt: "hello", engine: "fake", cwd: makeDir(), ...extra });
      expect(r.status).toBe(201);
      await idle(r.body.session.id);
      return r.body.session.treeboss as boolean;
    };
    expect(await create({ treeboss: true })).toBe(true);
    setSetting("treeboss_mode", "on");
    expect(await create({ treeboss: false })).toBe(false);
    expect(await create({})).toBe(true);
    expect(await create({ treeboss: "yes" })).toBe(true);
    setSetting("treeboss_mode", "off");
    expect(await create({})).toBe(false);
    expect(await create({ treeboss: true })).toBe(true);
  });

  test("a body without a boolean is a 400, an unknown session a 404", async () => {
    const s = createLead({ prompt: "hello", engine: "fake", cwd: makeDir() });
    await idle(s.id);
    expect((await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: "yes" })).status).toBe(400);
    expect((await call("POST", "/api/sessions/s_nope/treeboss", { enabled: true })).status).toBe(404);
  });

  test("the view's treeboss_state is null while the mode is off, and carries the tier, its source, attempts and the last check once on", async () => {
    const s = createLead({ prompt: "hello", engine: "fake", cwd: makeDir() });
    await idle(s.id);
    expect(viewSession(getSession(s.id)!).treeboss_state).toBeNull();
    await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: true });
    expect(viewSession(getSession(s.id)!).treeboss_state).toEqual({ tier: null, tier_source: null, attempts: 0, max_attempts: MAX_FIX_ATTEMPTS, last_check: null });
    await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: false });
    expect(viewSession(getSession(s.id)!).treeboss_state).toBeNull();
  });

  test("POST with a tier sets the operator's override, and tier null clears it; the response carries the state", async () => {
    const s = createLead({ prompt: "hello", engine: "fake", cwd: makeDir(), treeboss: true });
    await idle(s.id);
    const set = await call("POST", `/api/sessions/${s.id}/treeboss`, { tier: "area" });
    expect(set).toMatchObject({ status: 200, body: { treeboss: true, treeboss_state: { tier: "area", tier_source: "operator", attempts: 0, max_attempts: MAX_FIX_ATTEMPTS } } });
    expect(viewSession(getSession(s.id)!).treeboss_state).toMatchObject({ tier: "area", tier_source: "operator" });
    // Both at once: the mode goes off and the tier is set; the view of a session with the mode off is null.
    const both = await call("POST", `/api/sessions/${s.id}/treeboss`, { enabled: false, tier: "tweak" });
    expect(both).toMatchObject({ status: 200, body: { treeboss: false, treeboss_state: null } });
    expect(getState(s.id)).toMatchObject({ tier: "tweak", tierSource: "operator" });
    const cleared = await call("POST", `/api/sessions/${s.id}/treeboss`, { tier: null });
    expect(cleared).toMatchObject({ status: 200, body: { treeboss: false, treeboss_state: null } });
    expect(getState(s.id)).toMatchObject({ tier: null, tierSource: null });
  });

  test("a tier must be tweak, feature, area or null, and a body with neither enabled nor tier is a 400", async () => {
    const s = createLead({ prompt: "hello", engine: "fake", cwd: makeDir() });
    await idle(s.id);
    expect((await call("POST", `/api/sessions/${s.id}/treeboss`, { tier: "huge" })).status).toBe(400);
    expect((await call("POST", `/api/sessions/${s.id}/treeboss`, { tier: 2 })).status).toBe(400);
    expect((await call("POST", `/api/sessions/${s.id}/treeboss`, {})).status).toBe(400);
    expect(getState(s.id).tierSource).toBeNull();
  });
});

describe("the gate after a turn", () => {
  const TOKENS = ":root {\n  --color-accent: #6d28d9;\n}\n";
  const PANEL = (color: string) => `export const Panel = () => <div style={{ color: "${color}" }} />;\n`;

  test("violations go back as a fix turn that names the roadmap tool; the record says fixing, then passed with each rule", async () => {
    const dir = makeRepo({ "DESIGN.md": "# Design\n", "design/tokens.css": TOKENS, "web/Panel.tsx": PANEL("#6d28d9") });
    const prompts: string[] = [];
    let outcomeWhenFixSent: string | undefined;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      if (prompts.length === 1) {
        write(o.cwd, "web/Panel.tsx", PANEL("#ff0000"));
        return result("TREEBOSS_TIER: feature\nBuilt the panel.");
      }
      outcomeWhenFixSent = getState(s.id).lastCheck?.outcome;
      write(o.cwd, "web/Panel.tsx", PANEL("#6d28d9"));
      write(o.cwd, "specs/001-panel/spec.md", "# Panel\n");
      write(o.cwd, "docs/panel.md", "# Panel\n");
      write(o.cwd, "ROADMAP.md", "- [ ] Panel (spec: specs/001-panel)\n");
      return result("Fixed. The panel is built and the roadmap item is proposed.");
    });
    const s = createLead({ prompt: "add a panel", engine: "fake", cwd: dir, treeboss: true });
    await until(() => prompts.length === 2 && getState(s.id).lastCheck?.outcome === "passed", "the fix turn to be checked");
    await Bun.sleep(300); // let the gate after the fix turn finish: it must send nothing
    expect(prompts.length).toBe(2);

    expect(prompts[1]).toContain(FIX_HEADER);
    expect(prompts[1]).toContain("web/Panel.tsx:1 uses #ff0000, which is not a token in design/tokens.css");
    expect(prompts[1]).toContain("no doc was updated");
    expect(prompts[1]).toContain("no spec is attached");
    expect(prompts[1]).toContain("ROADMAP.md did not change");
    expect(prompts[1]).toContain("`roadmap_propose`");
    expect(prompts[1]).not.toContain("# Treeboss mode");
    expect(getState(s.id)).toMatchObject({ tier: "feature", tierSource: "agent", attempts: 0 });
    expect(outcomeWhenFixSent).toBe("fixing");

    const last = getState(s.id).lastCheck!;
    expect(last).toMatchObject({ tier: "feature", outcome: "passed" });
    expect(last.checks.map((c) => [c.id, c.status])).toEqual([
      ["design", "pass"],
      ["spec", "pass"],
      ["roadmap", "pass"],
      ["docs", "pass"],
    ]);
  });

  test("a feature that changes source without a ROADMAP.md change is sent back; the record says fixing while the fix turn runs", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const prompts: string[] = [];
    let outcomeWhenFixSent: string | undefined;
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      if (prompts.length === 2) outcomeWhenFixSent = getState(s.id).lastCheck?.outcome;
      write(o.cwd, "src/a.ts", "export const a = 2;\n"); // the fix turn writes the same, so it changes nothing
      write(o.cwd, "specs/001-a/spec.md", "# A\n");
      write(o.cwd, "docs/a.md", "# A\n");
      return result("TREEBOSS_TIER: feature\nChanged a.");
    });
    const s = createLead({ prompt: "change a", engine: "fake", cwd: dir, treeboss: true });
    await until(() => prompts.length === 2 && getSession(s.id)!.status !== "running", "the fix turn to end");
    await Bun.sleep(200);
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain("# Treeboss mode");
    expect(prompts[1]).toContain("ROADMAP.md did not change");
    expect(outcomeWhenFixSent).toBe("fixing");
    // The fix turn changed nothing, so it is recorded as such, and the gate stops there.
    expect(getState(s.id).lastCheck).toMatchObject({ tier: "feature", outcome: "nothing_built" });
  });

  test("after two fix turns that do not help, the gate gives up and says so; the record keeps the failing rules", async () => {
    const dir = makeRepo({ "DESIGN.md": "# Design\n", "design/tokens.css": TOKENS, "web/Panel.tsx": PANEL("#6d28d9") });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      write(o.cwd, "web/Panel.tsx", PANEL(`#ff000${prompts.length}`));
      return result("TREEBOSS_TIER: area\nstill working");
    });
    const s = createLead({ prompt: "a new area", engine: "fake", cwd: dir, treeboss: true });
    await until(() => prompts.length === 1 + MAX_FIX_ATTEMPTS && getSession(s.id)!.status !== "running", "the last fix turn");
    await until(() => getState(s.id).lastCheck?.outcome === "gave_up", "the gate to give up");
    await Bun.sleep(300);
    expect(prompts.length).toBe(1 + MAX_FIX_ATTEMPTS);
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("[treeboss] gate gave up after 2 attempts");
    const last = getState(s.id).lastCheck!;
    expect(last).toMatchObject({ tier: "area", outcome: "gave_up" });
    expect(last.checks.every((c) => c.status === "fail")).toBe(true);
    expect(last.checks.find((c) => c.id === "design")!.detail).toContain("which is not a token in design/tokens.css");
    expect(getState(s.id).attempts).toBe(MAX_FIX_ATTEMPTS);
  });

  test("an operator's tier replaces the agent's declaration in the gate: a tweak owes no doc, spec or roadmap item", async () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      if (prompts.length === 1) return result("Nothing to build yet.");
      write(o.cwd, "src/panel.ts", "export const panel = 2;\n");
      return result("TREEBOSS_TIER: feature\nBuilt the panel.");
    });
    const s = createLead({ prompt: "hello", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "nothing_built", "the first turn to be recorded");
    expect(getState(s.id).lastCheck!.checks.every((c) => c.status === "skip")).toBe(true);

    setOperatorTier(s.id, "tweak");
    send({ operator: true }, s.id, "build the panel");
    await until(() => getState(s.id).lastCheck?.outcome === "passed" && prompts.length === 2, "the second turn to be recorded");
    await Bun.sleep(200);
    expect(prompts.length).toBe(2);
    expect(getState(s.id)).toMatchObject({ tier: "tweak", tierSource: "operator" });
    expect(getState(s.id).lastCheck!.tier).toBe("tweak");

    // Cleared: the next declaration sets the tier again (the turn changes nothing, so it is recorded as nothing built).
    setOperatorTier(s.id, null);
    send({ operator: true }, s.id, "and now the rest");
    await until(() => prompts.length === 3 && getSession(s.id)!.status !== "running", "the third turn");
    await Bun.sleep(200);
    expect(getState(s.id)).toMatchObject({ tier: "feature", tierSource: "agent" });
  });

  test("a turn that changed no files is recorded as nothing built, and research/ scratch alone is nothing built too", async () => {
    const dir = makeRepo({ "DESIGN.md": "# Design\n", "design/tokens.css": TOKENS });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      write(o.cwd, "research/candidates.html", `<p style="color:#ff0000">A</p>\n`);
      return result("TREEBOSS_TIER: area\nPick one.");
    });
    const s = createLead({ prompt: "a new area", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "nothing_built", "the research turn to be recorded");
    await Bun.sleep(200);
    expect(prompts.length).toBe(1);
    expect(getState(s.id).attempts).toBe(0);
    expect(getState(s.id).lastCheck).toMatchObject({ tier: "area", outcome: "nothing_built" });
    expect(getState(s.id).lastCheck!.checks.every((c) => c.status === "skip" && c.detail)).toBe(true);
  });

  test("a directory that is not git has no checkpoints, so nothing is checked: the log and the record both say why", async () => {
    const dir = makeDir();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      write(o.cwd, "web/Panel.tsx", PANEL("#ff0000"));
      return result("TREEBOSS_TIER: feature\nok");
    });
    const s = createLead({ prompt: "panel", engine: "fake", cwd: dir, treeboss: true });
    await idle(s.id);
    await until(() => getState(s.id).lastCheck?.outcome === "not_checked", "the record of the unchecked turn");
    await Bun.sleep(200);
    expect(prompts.length).toBe(1);
    const log = readLog(s.id).map((l) => l.text).join("\n");
    expect(log).toContain("no checkpoint for this turn");
    expect(getState(s.id).lastCheck!.checks.every((c) => c.status === "skip" && c.detail?.includes("no checkpoint"))).toBe(true);
  });

  test("a turn that did not finish is recorded as not checked, with the reason", async () => {
    const dir = makeRepo({ "a.txt": "one\n" });
    setTurnRunner(async () => ({ ...result("it broke"), success: false }));
    const s = createLead({ prompt: "break", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "not_checked", "the record of the failed turn");
    expect(getState(s.id).lastCheck!.checks[0]!.detail).toBe("the turn failed, so it was not checked.");
  });
});

describe("the roadmap and last check in the store", () => {
  test("migrateTable is idempotent and a fresh session has no record yet", () => {
    migrateTable(db());
    expect(getState("s-new")).toMatchObject({ tier: null, tierSource: null, lastCheck: null });
  });
});
