/** Screenshot judgement of the CTA items (screens.ts): the pure judges, the refute-only rule and the derived verification. */
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { SCREEN_ITEMS, answerKeyOf, judgeCtaAboveFold, judgeScreens, judgeStickyCta, readJudgements, refutation, verificationOf, VIEWPORTS, type MeasuredAction, type PageMeasure, type ScreenJudgement, type Shooter, type Shot, type ViewportName } from "../src/checklists/screens";
import { SALES_PAGE_ITEMS } from "../src/checklists/urls";
import { fileOf, readChecklistFile, type ItemAnswer } from "../src/checklists/files";
import { projectChecklist } from "../src/checklists/project";
import { attach, launchBlockers, recordResult, runAutoChecks, setItem, showAttached } from "../src/checklists/store";
import { checklistPass, passChunks } from "../src/checklists/plan";
import type { FetchFn } from "../src/checklists/checks";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState } from "./helpers";

const action = (label: string, top: number, over: Partial<MeasuredAction> = {}): MeasuredAction => ({
  label,
  kind: "link",
  rect: { top, bottom: top + 44, left: 20, right: 220 },
  visible: true,
  topmost: true,
  pinned: false,
  ...over,
});

const measure = (viewport: ViewportName, top: MeasuredAction[], over: Partial<PageMeasure> = {}): PageMeasure => ({
  viewport,
  url: "http://127.0.0.1:4321/",
  innerHeight: VIEWPORTS[viewport].height,
  scrollHeight: VIEWPORTS[viewport].height * 4,
  top,
  scrolled: viewport === "mobile" ? [] : null,
  ...over,
});

describe("judgeCtaAboveFold", () => {
  test("a call to action in the first screen of both viewports is seen", () => {
    const j = judgeCtaAboveFold([measure("desktop", [action("Start free trial", 300)]), measure("mobile", [action("Start free trial", 400)])]);
    expect(j.observed).toBe("seen");
    expect(j.perViewport.map((p) => p.observed)).toEqual(["seen", "seen"]);
  });

  test("one below the fold on mobile is missing, and the reason names the viewport and the pixels", () => {
    const j = judgeCtaAboveFold([measure("desktop", [action("Start free trial", 300)]), measure("mobile", [action("Start free trial", 1180)])]);
    expect(j.observed).toBe("missing");
    expect(j.reason).toContain("mobile");
    expect(j.reason).toContain("1180px");
    expect(j.reason).toContain("844");
    expect(j.perViewport.find((p) => p.viewport === "desktop")!.observed).toBe("seen");
  });

  test("seen on desktop only is missing, and a page with no call to action says so", () => {
    const j = judgeCtaAboveFold([measure("desktop", [action("Get started", 300)]), measure("mobile", [action("About us", 100)])]);
    expect(j.observed).toBe("missing");
    expect(j.reason).toContain("mobile: no call to action");
  });

  test("a covered, hidden or generic button is not a call to action", () => {
    for (const a of [action("Start free trial", 300, { topmost: false }), action("Start free trial", 300, { visible: false }), action("Submit", 300), action("Learn more", 300)]) {
      expect(judgeCtaAboveFold([measure("desktop", [a]), measure("mobile", [a])]).observed).toBe("missing");
    }
  });

  test("a viewport that was not measured cannot be judged", () => {
    const j = judgeCtaAboveFold([measure("desktop", [action("Start free trial", 300)])]);
    expect(j.observed).toBe("unknown");
  });
});

describe("judgeStickyCta", () => {
  const pinned = action("Start free trial", 760, { pinned: true });

  test("a pinned call to action still on screen after scrolling is seen", () => {
    expect(judgeStickyCta([measure("mobile", [], { scrolled: [pinned] })]).observed).toBe("seen");
  });

  test("a call to action that scrolled away, or is not pinned, is missing", () => {
    expect(judgeStickyCta([measure("mobile", [], { scrolled: [action("Start free trial", 760)] })]).observed).toBe("missing");
    expect(judgeStickyCta([measure("mobile", [], { scrolled: [] })]).observed).toBe("missing");
    expect(judgeStickyCta([measure("mobile", [], { scrolled: [action("Start free trial", -300, { pinned: true })] })]).observed).toBe("missing");
  });

  test("a page shorter than two screens is too short to need one", () => {
    const j = judgeStickyCta([measure("mobile", [], { scrollHeight: 1200, scrolled: [] })]);
    expect(j.observed).toBe("unknown");
    expect(j.reason).toContain("too short");
  });

  test("no mobile measure is unknown", () => {
    expect(judgeStickyCta([measure("desktop", [pinned])]).observed).toBe("unknown");
  });
});

describe("the registry", () => {
  test("every screen item is a sales-page item, without a second list to keep in step", () => {
    for (const id of Object.keys(SCREEN_ITEMS)) expect(SALES_PAGE_ITEMS.has(id)).toBe(true);
    expect(SALES_PAGE_ITEMS.has("value-prop-hero")).toBe(true);
  });
});

const judgement = (observed: ScreenJudgement["observed"], answer: ItemAnswer, over: Partial<ScreenJudgement> = {}): ScreenJudgement => ({
  itemId: "cta-above-fold",
  url: "http://127.0.0.1:4321/",
  at: "2026-10-29T10:00:00.000Z",
  judge: "probe",
  observed,
  reason: observed === "missing" ? "mobile: first call to action \"Start free trial\" at 1180px, below 844px" : "a call to action in the first screen",
  shots: [{ viewport: "mobile", image: "lab/checklists/shots/marketing-site/cta-above-fold@390x844.png", observed, detail: "x" }],
  answerKey: answerKeyOf(answer),
  ...over,
});

const answer = (status: ItemAnswer["status"], source: ItemAnswer["source"], evidence: string | null = null, note: string | null = null): ItemAnswer => ({ status, source, evidence, message: null, reason: null, note });

describe("refutation", () => {
  test("a missing call to action turns an agent pass into an auto fail that cites the picture", () => {
    const cur = { ...answer("pass", "agent", "app/page.tsx:12"), reason: "Hero has a button" };
    const next = refutation(cur, judgement("missing", cur))!;
    expect(next).toEqual({ status: "fail", source: "auto", evidence: "lab/checklists/shots/marketing-site/cta-above-fold@390x844.png", message: expect.stringContaining("1180px"), reason: null, note: null });
  });

  test("it fails an unanswered item and rewrites an earlier auto answer", () => {
    expect(refutation(answer("unknown", null), judgement("missing", answer("unknown", null)))!.status).toBe("fail");
    const old = answer("fail", "auto", "x.png", "old reason");
    expect(refutation(old, judgement("missing", old))!.message).toContain("1180px");
  });

  test("a person's note on an unanswered item survives the refutation, an agent's reason does not", () => {
    const noted = answer("unknown", null, null, "waiting on design");
    expect(refutation(noted, judgement("missing", noted))).toMatchObject({ status: "fail", note: "waiting on design", message: expect.stringContaining("1180px") });
    const agent = { ...answer("pass", "agent", "app/page.tsx:1", "operator note"), reason: "the hero has a button" };
    expect(refutation(agent, judgement("missing", agent))).toMatchObject({ reason: null, note: "operator note" });
  });

  test("a manual answer, an na and an agent fail are never overridden", () => {
    for (const cur of [answer("pass", "manual"), answer("na", "manual", null, "dismissed in Lab"), answer("na", "agent", "app/page.tsx:1", "no landing page"), answer("fail", "agent", null, "no button")]) {
      expect(refutation(cur, judgement("missing", cur))).toBeNull();
    }
  });

  test("seen and unknown never write anything: the judge cannot pass an item", () => {
    for (const cur of [answer("pass", "agent", "a:1"), answer("unknown", null), answer("fail", "agent"), answer("fail", "auto")]) {
      expect(refutation(cur, judgement("seen", cur))).toBeNull();
      expect(refutation(cur, judgement("unknown", cur))).toBeNull();
    }
  });

  test("a seen page withdraws the judge's own refutation back to unanswered, never to a pass", () => {
    const own = answer("fail", "auto", "lab/checklists/shots/marketing-site/cta-above-fold@390x844.png", "mobile: no call to action");
    const next = refutation(own, judgement("seen", own))!;
    expect(next).toEqual({ status: "unknown", source: null, evidence: null, message: null, reason: null, note: null });
    expect(refutation(own, judgement("unknown", own))).toBeNull();
    for (const other of [answer("fail", "auto", "app/page.tsx:3"), answer("fail", "agent", "lab/checklists/shots/x.png"), answer("pass", "manual", "lab/checklists/shots/x.png")]) {
      expect(refutation(other, judgement("seen", other))).toBeNull();
    }
  });

  test("an answer that already is the refutation is left as it is", () => {
    const cur = answer("pass", "agent", "a:1");
    const once = refutation(cur, judgement("missing", cur))!;
    expect(refutation(once, judgement("missing", cur))).toBeNull();
  });
});

describe("verificationOf", () => {
  const pass = answer("pass", "agent", "app/page.tsx:12");

  test("an agent pass the probe agrees with is checked, with the pictures", () => {
    expect(verificationOf("cta-above-fold", pass, judgement("seen", pass))).toEqual({
      kind: "checked",
      by: "probe",
      at: "2026-10-29T10:00:00.000Z",
      url: "http://127.0.0.1:4321/",
      images: ["lab/checklists/shots/marketing-site/cta-above-fold@390x844.png"],
    });
  });

  test("an answer given after the judgement is the agent's word again", () => {
    const later = answer("pass", "agent", "app/hero.tsx:3");
    expect(verificationOf("cta-above-fold", later, judgement("seen", pass))).toMatchObject({ kind: "agents-word", why: "not judged since this answer" });
  });

  test("an agent item with no judgement is the agent's word, and so is one the probe could not judge", () => {
    expect(verificationOf("cta-above-fold", pass, undefined)).toMatchObject({ kind: "agents-word", why: "no screen judgement for this item" });
    expect(verificationOf("value-prop-hero", pass, undefined)).toMatchObject({ kind: "agents-word", why: "no screen judgement for this item" });
    const j = judgement("unknown", pass, { reason: "the page is too short" });
    expect(verificationOf("cta-above-fold", pass, j)).toMatchObject({ kind: "agents-word" });
    expect((verificationOf("cta-above-fold", pass, j) as { why: string }).why).toContain("the page is too short");
  });

  test("auto, manual and unanswered items carry no verification", () => {
    for (const cur of [answer("fail", "auto", "x.png"), answer("pass", "manual"), answer("unknown", null)]) {
      expect(verificationOf("cta-above-fold", cur, judgement("seen", cur))).toBeNull();
    }
  });
});

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const URL_ = "http://127.0.0.1:4321/";

type FakePage = { desktop?: MeasuredAction[]; mobile?: MeasuredAction[]; scrolled?: MeasuredAction[]; scrollHeight?: number };

/** A shooter that reports these actions per viewport. `scrolled` is the mobile list after scrolling. */
function fakeShooter(opts: FakePage | { error: string }): Shooter & { calls: Array<{ url: string; viewports: readonly ViewportName[] }> } {
  const calls: Array<{ url: string; viewports: readonly ViewportName[] }> = [];
  const f = (async (url: string, viewports: readonly ViewportName[]) => {
    calls.push({ url, viewports });
    if ("error" in opts) return { error: opts.error };
    const shots: Shot[] = viewports.map((viewport) => ({
      viewport,
      measure: measure(viewport, (viewport === "desktop" ? opts.desktop : opts.mobile) ?? [], { url, scrolled: viewport === "mobile" ? (opts.scrolled ?? []) : null, ...(opts.scrollHeight ? { scrollHeight: opts.scrollHeight } : {}) }),
      png: PNG,
      scrolledPng: viewport === "mobile" ? PNG : null,
    }));
    return { shots };
  }) as Shooter & { calls: Array<{ url: string; viewports: readonly ViewportName[] }> };
  f.calls = calls;
  return f;
}

const cta = (top = 300) => [action("Start free trial", top)];

function project(): { id: string; dir: string } {
  const dir = makeRepo({ "package.json": "{}\n" });
  const id = Workspaces.open(dir).id;
  attach(id, "marketing-site");
  return { id, dir };
}
const projectsOf = (dir: string, ...ids: string[]) => ids.map((i) => projectChecklist(dir, i)!);
const answerOf = (dir: string, item: string) => readChecklistFile(dir, "marketing-site")!.answers.get(item)!;
const agentPass = (id: string, item = "cta-above-fold") => recordResult(id, { checklistId: "marketing-site", itemId: item, status: "pass", evidence: "package.json:1", note: "the hero has a button" });
const shotsDir = (dir: string) => path.join(dir, "lab/checklists/shots/marketing-site");
const judgementsText = (dir: string) => fs.readFileSync(path.join(shotsDir(dir), "judgements.json"), "utf8");
const withoutTime = (s: string) => s.replace(/"at": "[^"]*"/g, '"at": ""');
const STICKY = [action("Start free trial", 760, { pinned: true })];

describe("judgeScreens", () => {
  beforeEach(resetState);

  test("a page that shows the call to action corroborates an agent pass and leaves the line alone", async () => {
    const { id, dir } = project();
    agentPass(id);
    const before = fs.readFileSync(fileOf(dir, "marketing-site"), "utf8");
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(400), scrolled: STICKY, scrollHeight: 3000 }));
    expect(runs.find((r) => r.itemId === "cta-above-fold")).toMatchObject({ observed: "seen", applied: "checked" });
    expect(fs.readFileSync(fileOf(dir, "marketing-site"), "utf8")).toBe(before);
    const j = readJudgements(dir, "marketing-site").get("cta-above-fold")!;
    expect(j.shots.map((s) => s.image)).toEqual(["lab/checklists/shots/marketing-site/cta-above-fold@1440x900.png", "lab/checklists/shots/marketing-site/cta-above-fold@390x844.png"]);
    for (const s of j.shots) expect(fs.existsSync(path.join(dir, s.image))).toBe(true);
    expect(verificationOf("cta-above-fold", answerOf(dir, "cta-above-fold"), j)).toMatchObject({ kind: "checked" });
  });

  test("a missing call to action on mobile alone refutes an agent pass: the line fails and the finding opens", async () => {
    const { id, dir } = project();
    agentPass(id);
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(1180) }));
    expect(runs.find((r) => r.itemId === "cta-above-fold")).toMatchObject({ observed: "missing", applied: "refuted" });
    const a = answerOf(dir, "cta-above-fold");
    expect(a).toMatchObject({ status: "fail", source: "auto", evidence: "lab/checklists/shots/marketing-site/cta-above-fold@390x844.png" });
    expect(a.message).toContain("mobile");
    expect(fs.existsSync(path.join(dir, "lab/findings/checklist-marketing-site-cta-above-fold.md"))).toBe(true);
    expect(launchBlockers(id).map((b) => b.itemId)).toContain("cta-above-fold");
  });

  test("a page too short for a sticky bar is not judged, and a page with none refutes", async () => {
    const { id, dir } = project();
    agentPass(id, "sticky-mobile-cta");
    let runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(), scrollHeight: 1200 }));
    expect(runs.find((r) => r.itemId === "sticky-mobile-cta")).toMatchObject({ observed: "unknown", applied: "none" });
    expect(answerOf(dir, "sticky-mobile-cta").status).toBe("pass");
    expect(verificationOf("sticky-mobile-cta", answerOf(dir, "sticky-mobile-cta"), readJudgements(dir, "marketing-site").get("sticky-mobile-cta"))).toMatchObject({ kind: "agents-word" });
    runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(), scrolled: [action("Start free trial", 300)], scrollHeight: 4000 }));
    expect(runs.find((r) => r.itemId === "sticky-mobile-cta")).toMatchObject({ observed: "missing", applied: "refuted" });
    expect(answerOf(dir, "sticky-mobile-cta").status).toBe("fail");
  });

  test("a person's tick, an n/a and an agent's fail are never overridden, even by a missing call to action", async () => {
    const { id, dir } = project();
    setItem(id, "marketing-site", "cta-above-fold", { checked: true, note: "by hand" });
    recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "na", note: "a one-screen page" });
    const shooter = fakeShooter({ desktop: [], mobile: [], scrolled: [], scrollHeight: 4000 });
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, shooter);
    expect(runs.map((r) => r.applied)).toEqual(["none", "none"]);
    expect(answerOf(dir, "cta-above-fold")).toMatchObject({ status: "pass", source: "manual" });
    expect(answerOf(dir, "sticky-mobile-cta")).toMatchObject({ status: "na", source: "agent" });
    recordResult(id, { checklistId: "marketing-site", itemId: "sticky-mobile-cta", status: "fail", note: "no bar" });
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, shooter);
    expect(answerOf(dir, "sticky-mobile-cta")).toMatchObject({ status: "fail", source: "agent", reason: "no bar" });
  });

  test("an unanswered item is never passed by a good page, and is failed by a bad one", async () => {
    const { dir } = project();
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(), scrolled: STICKY, scrollHeight: 4000 }));
    expect(answerOf(dir, "cta-above-fold").status).toBe("unknown");
    expect(answerOf(dir, "sticky-mobile-cta").status).toBe("unknown");
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: [], mobile: [] }));
    expect(answerOf(dir, "cta-above-fold").status).toBe("fail");
  });

  test("a page that is fixed withdraws the refutation: the item is unanswered again, its finding ships, and it is not a pass", async () => {
    const { id, dir } = project();
    agentPass(id);
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(1180) }));
    expect(answerOf(dir, "cta-above-fold").status).toBe("fail");
    const finding = path.join(dir, "lab/findings/checklist-marketing-site-cta-above-fold.md");
    expect(fs.readFileSync(finding, "utf8")).toContain("status: new");
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(400), scrolled: STICKY, scrollHeight: 3000 }));
    expect(runs.find((r) => r.itemId === "cta-above-fold")).toMatchObject({ observed: "seen", applied: "withdrawn" });
    expect(runs.find((r) => r.itemId === "cta-above-fold")!.reason).toContain("withdrawn");
    expect(answerOf(dir, "cta-above-fold")).toEqual({ status: "unknown", source: null, evidence: null, message: null, reason: null, note: null });
    expect(fs.readFileSync(finding, "utf8")).toContain("status: shipped");
    const again = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(400), scrolled: STICKY, scrollHeight: 3000 }));
    expect(again.find((r) => r.itemId === "cta-above-fold")!.applied).toBe("none");
    expect(answerOf(dir, "cta-above-fold").status).toBe("unknown");
  });

  test("an agent's fail that cites a picture is the agent's own answer and is not withdrawn", async () => {
    const { id, dir } = project();
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "fail", evidence: "package.json:1", note: "no button" });
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ desktop: cta(), mobile: cta(400) }));
    expect(answerOf(dir, "cta-above-fold")).toMatchObject({ status: "fail", source: "agent" });
  });

  test("a second run with the same page changes no line and no picture, only the time of the verdict", async () => {
    const { id, dir } = project();
    agentPass(id);
    const page = { desktop: cta(), mobile: cta(1180) };
    await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter(page), () => "2026-10-29T10:00:00.000Z");
    const lines = fs.readFileSync(fileOf(dir, "marketing-site"), "utf8");
    const shots = fs.readdirSync(shotsDir(dir)).sort();
    const first = judgementsText(dir);
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter(page), () => "2026-10-29T11:00:00.000Z");
    expect(runs.find((r) => r.itemId === "cta-above-fold")!.applied).toBe("none");
    expect(fs.readFileSync(fileOf(dir, "marketing-site"), "utf8")).toBe(lines);
    expect(fs.readdirSync(shotsDir(dir)).sort()).toEqual(shots);
    expect(shots.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(withoutTime(judgementsText(dir))).toBe(withoutTime(first));
  });

  test("a shooter that cannot run changes nothing and says why for each item", async () => {
    const { id, dir } = project();
    agentPass(id);
    const before = fs.readFileSync(fileOf(dir, "marketing-site"), "utf8");
    const runs = await judgeScreens(dir, projectsOf(dir, "marketing-site"), URL_, fakeShooter({ error: "Chrome not found" }));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.observed === "unknown" && r.applied === "none" && r.reason === "Chrome not found" && r.images.length === 0)).toBe(true);
    expect(fs.readFileSync(fileOf(dir, "marketing-site"), "utf8")).toBe(before);
    expect(readJudgements(dir, "marketing-site").size).toBe(0);
  });

  test("a checklist without screen items is not shot at all", async () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "saas-app");
    const shooter = fakeShooter({ desktop: [], mobile: [] });
    expect(await judgeScreens(dir, projectsOf(dir, "saas-app"), URL_, shooter)).toEqual([]);
    expect(shooter.calls).toEqual([]);
  });

  test("a damaged judgements file reads as no judgement", () => {
    const dir = makeDir();
    fs.mkdirSync(shotsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(shotsDir(dir), "judgements.json"), "{not json");
    expect(readJudgements(dir, "marketing-site").size).toBe(0);
    fs.writeFileSync(path.join(shotsDir(dir), "judgements.json"), JSON.stringify({ "cta-above-fold": { observed: "maybe" } }));
    expect(readJudgements(dir, "marketing-site").size).toBe(0);
  });
});

const noSite = (async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })) as unknown as FetchFn;
const itemOf = (id: string, item: string) => showAttached(id, "marketing-site").items.find((i) => i.id === item)!;

describe("runAutoChecks with a shooter", () => {
  beforeEach(resetState);

  test("a refuted agent pass fails, opens its finding, blocks the deploy and tells the operator", async () => {
    const { id, dir } = project();
    agentPass(id);
    const r = await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta(1180) }) });
    expect(r.screens.find((s) => s.itemId === "cta-above-fold")).toMatchObject({ checklistId: "marketing-site", observed: "missing", applied: "refuted" });
    const item = itemOf(id, "cta-above-fold");
    expect(item).toMatchObject({ status: "fail", source: "auto", verification: null });
    expect(item.message).toContain("1180px");
    expect(item.finding).toBe("checklist-marketing-site-cta-above-fold");
    expect(answerOf(dir, "cta-above-fold").status).toBe("fail");
    expect(launchBlockers(id).find((b) => b.itemId === "cta-above-fold")).toMatchObject({ status: "fail" });
  });

  test("the deploy gate blocks only after the run: before it an agent's pass settles the item", async () => {
    const { id } = project();
    agentPass(id);
    expect(launchBlockers(id).map((b) => b.itemId)).not.toContain("cta-above-fold");
    await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta(1180) }) });
    expect(launchBlockers(id).map((b) => b.itemId)).toContain("cta-above-fold");
  });

  test("a page that agrees makes the pass checked, and an answer recorded afterwards is the agent's word again", async () => {
    const { id } = project();
    agentPass(id);
    expect(itemOf(id, "cta-above-fold").verification).toMatchObject({ kind: "agents-word", why: "no screen judgement for this item" });
    const r = await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta(400), scrolled: STICKY, scrollHeight: 3000 }) });
    expect(r.screens.find((s) => s.itemId === "cta-above-fold")!.applied).toBe("checked");
    const item = itemOf(id, "cta-above-fold");
    expect(item).toMatchObject({ status: "pass", source: "agent" });
    expect(item.verification).toMatchObject({ kind: "checked", by: "probe", url: URL_ });
    recordResult(id, { checklistId: "marketing-site", itemId: "cta-above-fold", status: "pass", evidence: "package.json:2", note: "moved the hero" });
    expect(itemOf(id, "cta-above-fold").verification).toMatchObject({ kind: "agents-word", why: "not judged since this answer" });
  });

  test("an agent item no screen judges stays the agent's word, and a check's answer has no verification", async () => {
    const { id } = project();
    attach(id, "cro");
    recordResult(id, { checklistId: "cro", itemId: "cta-one-primary", status: "pass", evidence: "package.json:1", note: "one button" });
    await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta() }) });
    expect(showAttached(id, "cro").items.find((i) => i.id === "cta-one-primary")!.verification).toMatchObject({ kind: "agents-word" });
    expect(itemOf(id, "meta-title").verification).toBeNull();
  });

  test("without a URL nothing is shot; with a shooter that fails, the run still finishes and says why", async () => {
    const { id, dir } = project();
    agentPass(id);
    const shooter = fakeShooter({ desktop: cta(), mobile: cta(1180) });
    expect((await runAutoChecks(id, { shooter })).screens).toEqual([]);
    expect(shooter.calls).toEqual([]);
    const r = await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ error: "Chrome not found" }) });
    expect(r.screens.map((s) => s.reason)).toEqual(["Chrome not found", "Chrome not found"]);
    expect(answerOf(dir, "cta-above-fold").status).toBe("pass");
  });

  test("a page that is not on this machine is not screenshotted by the default shooter", async () => {
    const { id } = project();
    const r = await runAutoChecks(id, { url: "https://site.test/", fetch: noSite });
    expect(r.screens.map((s) => s.reason)).toEqual(["only loopback pages are screenshotted", "only loopback pages are screenshotted"]);
  });

  test("running twice leaves the same lines and the same verdicts", async () => {
    const { id, dir } = project();
    agentPass(id);
    const opts = () => ({ url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta(1180) }) });
    await runAutoChecks(id, opts());
    const screenLines = () => fs.readFileSync(fileOf(dir, "marketing-site"), "utf8").split("\n").filter((l) => l.includes("{#cta-above-fold}") || l.includes("{#sticky-mobile-cta}"));
    const lines = screenLines();
    const verdicts = withoutTime(judgementsText(dir));
    const again = await runAutoChecks(id, opts());
    expect(again.screens.map((s) => s.applied)).toEqual(["none", "none"]);
    expect(screenLines()).toEqual(lines);
    expect(withoutTime(judgementsText(dir))).toBe(verdicts);
  });

  test("the fix prompt carries the verdict and the pictures", async () => {
    const { id, dir } = project();
    agentPass(id);
    await runAutoChecks(id, { url: URL_, fetch: noSite, shooter: fakeShooter({ desktop: cta(), mobile: cta(1180) }) });
    const prompt = passChunks(dir, ["marketing-site"], true).map((t) => checklistPass(dir, t, { fix: true }).prompt).join("\n");
    expect(prompt).toContain("Screenshot judgement (probe,");
    expect(prompt).toContain("missing, mobile: first call to action");
    expect(prompt).toContain("lab/checklists/shots/marketing-site/cta-above-fold@390x844.png");
  });
});
