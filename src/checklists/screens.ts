/**
 * The screenshot judgement of the sales-page items that are about layout: is a call to action in the first screen, does one stay
 * on screen while scrolling on a phone. A headless browser measures the served page (screens-browser.ts); this module decides
 * from the measurements, keeps the pictures and the verdicts, and says what a verdict means for an item's answer.
 *
 * The judge can refute and never pass. These items stay agent items (a check must not fake them), so the judge only ever
 * writes a fail, over an agent's pass or an item nobody answered. A person's tick, an n/a and an agent's own fail are never
 * overridden. When a later run sees the call to action, the judge takes back its own refutation (the item is unanswered again,
 * for an agent to answer); it recognises it by the evidence, a picture under shots/. Whether an agent's pass was checked is derived when read (verificationOf), from the stored verdict and the answer
 * as it stands: a changed answer is the agent's word again until the next run.
 *
 * The verdicts of a checklist are lab/checklists/shots/<checklistId>/judgements.json, next to the pictures
 * (<itemId>@<width>x<height>.png), so a picture's path works as an item's evidence. A run overwrites both through a
 * temporary file and a rename, and a second run with the same page changes nothing but the time.
 */
import fs from "fs";
import path from "path";
import { CTA_VERB, GENERIC_CTA } from "./checks";
import { CHECKLIST_DIR, UNANSWERED, patchChecklistFile, writeAtomic, type ItemAnswer } from "./files";
import { closeItemFinding, syncItemFinding } from "./findings";
import type { ProjectChecklist } from "./project";

export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** One link, button or submit input as the browser measured it. No decision is made in the page. */
export interface MeasuredAction {
  label: string;
  kind: "link" | "button";
  /** Relative to the viewport at the moment of the measure. */
  rect: { top: number; bottom: number; left: number; right: number };
  /** Displayed, not hidden, not transparent, not empty, not aria-hidden. */
  visible: boolean;
  /** The element at its centre is it or inside it: a cookie wall or overlay over it makes this false. */
  topmost: boolean;
  /** It or an ancestor is position fixed or sticky. */
  pinned: boolean;
}

/** What the browser reports for one viewport. */
export interface PageMeasure {
  viewport: ViewportName;
  /** The address after redirects. */
  url: string;
  innerHeight: number;
  scrollHeight: number;
  /** Every action on the page, measured at the top. */
  top: MeasuredAction[];
  /** The same after scrolling down a long page. Measured on mobile only; null elsewhere. */
  scrolled: MeasuredAction[] | null;
}

export interface Shot {
  viewport: ViewportName;
  measure: PageMeasure;
  /** The viewport at the top of the page. */
  png: Uint8Array;
  /** The viewport after scrolling, when the page was scrolled. */
  scrolledPng: Uint8Array | null;
}

/** Takes the shots of a page in the given viewports. The real one is screens-browser.ts; tests pass a fake, as they do for fetch. */
export type Shooter = (url: string, viewports: readonly ViewportName[]) => Promise<{ shots: Shot[] } | { error: string }>;

export type Observation = "seen" | "missing" | "unknown";

interface ViewportVerdict {
  viewport: ViewportName;
  observed: Observation;
  detail: string;
}

interface Judged {
  observed: Observation;
  reason: string;
  perViewport: ViewportVerdict[];
}

/** One item's verdict, as judgements.json holds it. */
export interface ScreenJudgement {
  itemId: string;
  url: string;
  at: string;
  /** Who judged. A model or a person can join the union later without a new file. */
  judge: "probe";
  observed: Observation;
  /** One sentence, shown as the item's message. */
  reason: string;
  shots: Array<{ viewport: ViewportName; image: string; observed: Observation; detail: string }>;
  /** The answer this verdict covers (answerKeyOf): the one it was made against, or the refutation it wrote. Any other answer is not covered by it. */
  answerKey: string;
}

const px = (n: number) => `${Math.round(n)}px`;
const size = (v: ViewportName) => `${VIEWPORTS[v].width}×${VIEWPORTS[v].height}`;

const isCta = (a: MeasuredAction) => a.visible && CTA_VERB.test(a.label) && !GENERIC_CTA.test(a.label);
const onScreen = (a: MeasuredAction, height: number) => a.rect.top < height && a.rect.bottom > 0;

function aboveFold(m: PageMeasure | undefined, viewport: ViewportName): ViewportVerdict {
  if (!m) return { viewport, observed: "unknown", detail: "the page was not measured" };
  const ctas = m.top.filter(isCta);
  const inFold = ctas.filter((a) => onScreen(a, m.innerHeight));
  const seen = inFold.find((a) => a.topmost);
  if (seen) return { viewport, observed: "seen", detail: `"${seen.label}" at ${px(seen.rect.top)}` };
  if (inFold.length) return { viewport, observed: "missing", detail: `"${inFold[0]!.label}" is in the first screen but covered by another element` };
  const first = [...ctas].sort((a, b) => a.rect.top - b.rect.top)[0];
  if (first) return { viewport, observed: "missing", detail: `first call to action "${first.label}" at ${px(first.rect.top)}, below ${px(m.innerHeight)}` };
  return { viewport, observed: "missing", detail: `no call to action in the first screen (${size(viewport)})` };
}

/** Folds per-viewport verdicts into one: a miss on any viewport refutes, an unmeasured one cannot be judged, else seen. */
function fold(per: ViewportVerdict[], seenReason: string): Judged {
  const missing = per.filter((p) => p.observed === "missing");
  const unknown = per.filter((p) => p.observed === "unknown");
  const observed: Observation = missing.length ? "missing" : unknown.length ? "unknown" : "seen";
  const bad = observed === "missing" ? missing : unknown;
  return { observed, reason: observed === "seen" ? seenReason : bad.map((p) => `${p.viewport}: ${p.detail}`).join("; "), perViewport: per };
}

/** A call to action (CTA_VERB, not GENERIC_CTA) that is visible, on top and inside the first screen, on every viewport. */
export function judgeCtaAboveFold(measures: PageMeasure[]): Judged {
  const per = (["desktop", "mobile"] as const).map((v) => aboveFold(measures.find((m) => m.viewport === v), v));
  return fold(per, "a call to action is in the first screen on desktop and mobile");
}

/** Mobile only. A page under two screens tall is too short to need one; else a pinned, visible call to action must be on screen after scrolling. */
export function judgeStickyCta(measures: PageMeasure[]): Judged {
  const m = measures.find((x) => x.viewport === "mobile");
  const verdict = ((): ViewportVerdict => {
    const viewport = "mobile";
    if (!m) return { viewport, observed: "unknown", detail: "the page was not measured" };
    if (m.scrollHeight < 2 * m.innerHeight) return { viewport, observed: "unknown", detail: `the page is ${(m.scrollHeight / m.innerHeight).toFixed(1)} screens tall, too short to need a sticky call to action` };
    if (!m.scrolled) return { viewport, observed: "unknown", detail: "the page was not scrolled" };
    const stays = m.scrolled.find((a) => isCta(a) && a.topmost && a.pinned && onScreen(a, m.innerHeight));
    if (stays) return { viewport, observed: "seen", detail: `"${stays.label}" stays on screen after scrolling` };
    return { viewport, observed: "missing", detail: "after scrolling, no call to action stays on screen (a fixed bottom bar or a sticky header button)" };
  })();
  return fold([verdict], "a fixed call to action stays on screen after scrolling on mobile");
}

interface ScreenSpec {
  viewports: readonly ViewportName[];
  /** Which picture of the viewport is the evidence. */
  shot: "top" | "scrolled";
  judge: (measures: PageMeasure[]) => Judged;
}

/** The items judged from a screenshot. urls.ts derives the sales-page items from these keys. */
export const SCREEN_ITEMS = {
  "cta-above-fold": { viewports: ["desktop", "mobile"], shot: "top", judge: judgeCtaAboveFold },
  "sticky-mobile-cta": { viewports: ["mobile"], shot: "scrolled", judge: judgeStickyCta },
} as const satisfies Record<string, ScreenSpec>;

export type ScreenItemId = keyof typeof SCREEN_ITEMS;
export const isScreenItem = (id: string): id is ScreenItemId => Object.hasOwn(SCREEN_ITEMS, id);

/** The part of an answer a verdict is made against. */
export const answerKeyOf = (a: ItemAnswer): string => `${a.status}|${a.source ?? ""}|${a.evidence ?? ""}`;

/** Whether an answer is a refutation this judge wrote: a check's fail that cites one of its pictures. */
const isOwnRefutation = (a: ItemAnswer): boolean => a.status === "fail" && a.source === "auto" && !!a.evidence?.startsWith(`${SHOTS_DIR}/`);

/**
 * The answer a verdict puts on an item, or null. A missing call to action fails an item that is unanswered, answered by a check
 * (an earlier refutation), or passed by an agent. A person's answer, an n/a and an agent's fail stand. A seen one takes back
 * the judge's own refutation, to unanswered. It never returns a pass, and returns null for an answer that already is the result.
 */
export function refutation(current: ItemAnswer, j: ScreenJudgement): ItemAnswer | null {
  if (j.observed === "seen") return isOwnRefutation(current) ? UNANSWERED : null;
  if (j.observed !== "missing") return null;
  const overridable = current.source === null || current.source === "auto" || (current.source === "agent" && current.status === "pass");
  if (!overridable) return null;
  const shot = j.shots.find((s) => s.observed === "missing") ?? j.shots[0];
  // An agent's reason is what it saw, which the page contradicts; a person's note stays.
  const next: ItemAnswer = { status: "fail", source: "auto", evidence: shot?.image ?? null, message: j.reason, reason: null, note: current.note };
  return next.status === current.status && next.source === current.source && next.evidence === current.evidence && next.message === current.message && next.reason === current.reason ? null : next;
}

/** What backs an agent's answer. */
export type Verification =
  | { kind: "checked"; by: "probe"; at: string; url: string; images: string[] }
  | { kind: "agents-word"; why: string };

/** Derived on every read, never stored. Null for an answer that is not an agent's: a check or a person answered it. */
export function verificationOf(itemId: string, a: ItemAnswer, j: ScreenJudgement | undefined): Verification | null {
  if (a.source !== "agent") return null;
  if (!isScreenItem(itemId) || !j) return { kind: "agents-word", why: "no screen judgement for this item" };
  if (j.answerKey !== answerKeyOf(a)) return { kind: "agents-word", why: "not judged since this answer" };
  if (j.observed === "unknown") return { kind: "agents-word", why: `the probe could not judge: ${j.reason}` };
  if (a.status !== "pass") return { kind: "agents-word", why: "the probe checks a pass, and this answer is not one" };
  if (j.observed === "missing") return { kind: "agents-word", why: `the probe disagrees: ${j.reason}` };
  return { kind: "checked", by: "probe", at: j.at, url: j.url, images: j.shots.map((s) => s.image) };
}

/** The sentence a verdict gives an item as its message, while the verdict still speaks for the answer. */
export function screenMessage(a: ItemAnswer, j: ScreenJudgement | undefined): string | null {
  return j && (a.source === "auto" || answerKeyOf(a) === j.answerKey) ? j.reason : null;
}

const SHOTS_DIR = `${CHECKLIST_DIR}/shots`;
const judgementsFile = (root: string, checklistId: string) => path.join(root, SHOTS_DIR, checklistId, "judgements.json");
const OBSERVATIONS: readonly string[] = ["seen", "missing", "unknown"];
const VIEWPORT_NAMES: readonly string[] = Object.keys(VIEWPORTS);

/** Parses one stored verdict. Anything that does not fit is dropped: a hand edit never breaks a read. */
function parseJudgement(itemId: string, v: any): ScreenJudgement | null {
  if (!v || typeof v !== "object" || v.judge !== "probe" || !OBSERVATIONS.includes(v.observed)) return null;
  if (![v.url, v.at, v.reason, v.answerKey].every((s) => typeof s === "string") || !Array.isArray(v.shots)) return null;
  const shots = v.shots.filter((s: any) => s && VIEWPORT_NAMES.includes(s.viewport) && typeof s.image === "string" && OBSERVATIONS.includes(s.observed) && typeof s.detail === "string");
  return { itemId, url: v.url, at: v.at, judge: "probe", observed: v.observed, reason: v.reason, shots, answerKey: v.answerKey };
}

/** The stored verdicts of a checklist, by item id. Empty when there are none. */
export function readJudgements(root: string, checklistId: string): Map<string, ScreenJudgement> {
  const out = new Map<string, ScreenJudgement>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(judgementsFile(root, checklistId), "utf8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw)) {
    const j = parseJudgement(id, v);
    if (j) out.set(id, j);
  }
  return out;
}

function writeJudgements(root: string, checklistId: string, judgements: Map<string, ScreenJudgement>): void {
  const body: Record<string, Omit<ScreenJudgement, "itemId">> = {};
  for (const [id, { itemId: _, ...rest }] of [...judgements].sort(([a], [b]) => a.localeCompare(b))) body[id] = rest;
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const abs = judgementsFile(root, checklistId);
  if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8") === text) return;
  writeAtomic(abs, text);
}

export interface ScreenRun {
  checklistId: string;
  itemId: string;
  observed: Observation;
  /** refuted: the item fails. withdrawn: the judge's earlier refutation is taken back. checked: an agent's pass the probe agrees with. none: nothing changed. */
  applied: "refuted" | "withdrawn" | "checked" | "none";
  reason: string;
  /** Repo-relative paths of the pictures. */
  images: string[];
}

/**
 * Shoots the page once for every viewport the attached screen items need, judges each, stores the pictures and verdicts, and
 * fails the items the verdict refutes (the line through patchChecklistFile, then its finding). Without screen items nothing is
 * shot. When the shooter cannot run, no line and no stored verdict changes; each item reports why.
 */
export async function judgeScreens(root: string, checklists: ProjectChecklist[], url: string, shooter: Shooter, now: () => string = () => new Date().toISOString()): Promise<ScreenRun[]> {
  const targets = checklists.flatMap((p) => p.checklist.items.filter((i) => i.kind === "agent" && isScreenItem(i.id)).map((item) => ({ p, item, spec: SCREEN_ITEMS[item.id as ScreenItemId] as ScreenSpec })));
  if (!targets.length) return [];
  const got = await shooter(url, [...new Set(targets.flatMap((t) => t.spec.viewports))]);
  if ("error" in got) return targets.map((t) => ({ checklistId: t.p.checklist.id, itemId: t.item.id, observed: "unknown", applied: "none", reason: got.error, images: [] }));

  const at = now();
  const measures = got.shots.map((s) => s.measure);
  const runs: ScreenRun[] = [];
  for (const p of checklists) {
    const c = p.checklist;
    const mine = targets.filter((t) => t.p === p);
    if (!mine.length) continue;
    const stored = readJudgements(root, c.id);
    const updates = new Map<string, ItemAnswer>();
    const changed: Array<{ item: (typeof mine)[number]["item"]; answer: ItemAnswer; reason: string }> = [];
    for (const { item, spec } of mine) {
      const judged = spec.judge(measures);
      const shots: ScreenJudgement["shots"] = [];
      for (const v of spec.viewports) {
        const shot = got.shots.find((s) => s.viewport === v);
        const png = spec.shot === "top" ? shot?.png : shot?.scrolledPng;
        if (!shot || !png) continue;
        const image = `${SHOTS_DIR}/${c.id}/${item.id}@${VIEWPORTS[v].width}x${VIEWPORTS[v].height}.png`;
        writeAtomic(path.join(root, image), png);
        const per = judged.perViewport.find((x) => x.viewport === v);
        shots.push({ viewport: v, image, observed: per?.observed ?? "unknown", detail: per?.detail ?? "" });
      }
      const current = p.file.answers.get(item.id) ?? UNANSWERED;
      const j: ScreenJudgement = { itemId: item.id, url: measures[0]?.url ?? url, at, judge: "probe", observed: judged.observed, reason: judged.reason, shots, answerKey: answerKeyOf(current) };
      const next = refutation(current, j);
      if (next) j.answerKey = answerKeyOf(next);
      stored.set(item.id, j);
      if (next) {
        updates.set(item.id, next);
        changed.push({ item, answer: next, reason: j.reason });
      }
      const applied = next ? (next.status === "fail" ? "refuted" : "withdrawn") : verificationOf(item.id, current, j)?.kind === "checked" ? "checked" : "none";
      runs.push({ checklistId: c.id, itemId: item.id, observed: j.observed, applied, reason: applied === "withdrawn" ? `refutation withdrawn, ${j.reason}` : j.reason, images: shots.map((s) => s.image) });
    }
    writeJudgements(root, c.id, stored);
    if (!updates.size) continue;
    patchChecklistFile(root, c, updates, at);
    for (const x of changed) {
      if (x.answer.status === "fail") syncItemFinding(root, c, x.item, x.answer, x.reason);
      else closeItemFinding(root, c.id, x.item.id);
    }
  }
  return runs;
}
