/**
 * The feature map: `lab/features.md`, one section per thing a user can do, with the pages it lives on and the QA plans
 * that test it. An agent drafts it (kind "map" in sessions.ts); a person can edit it like any file.
 *
 *   # Features
 *
 *   ## Checkout
 *   id: checkout
 *   where: /cart, /checkout
 *   plans: checkout-happy-path, checkout-errors
 *   A buyer pays for the cart with a saved or a new card.
 *
 * Key lines come first in a section, in any order; the rest is the summary. A missing id is made from the title. The
 * coverage of a feature is read from its plans' last runs, never stored.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { LAB_DIR } from "../lab/findings";
import type { Coverage, Feature, FeaturePlan, FeatureView, PlanSummary } from "./types";

export const FEATURES_FILE = `${LAB_DIR}/features.md`;
const MAX_BYTES = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const KEY = /^(id|where|plans)\s*:\s*(.*)$/i;

const fileOf = (root: string): string => path.join(root, FEATURES_FILE);
const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter(Boolean);
export const featureId = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "feature";

export interface FeatureMap {
  features: Feature[];
  /** What in the file could not be read as written (a duplicate or malformed id). The rest is still listed. */
  problem: string | null;
  exists: boolean;
}

export function parseFeatures(text: string): { features: Feature[]; problem: string | null } {
  const lines = text.split(/\r?\n/);
  const features: Feature[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const head = /^##\s+(.+?)\s*$/.exec(lines[i]!);
    i++;
    if (!head) continue;
    const title = head[1]!;
    let id: string | null = null;
    let where: string[] = [];
    let plans: string[] = [];
    const body: string[] = [];
    let keys = true;
    for (; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
      const line = lines[i]!;
      const k = keys ? KEY.exec(line.trim()) : null;
      if (k) {
        const name = k[1]!.toLowerCase();
        if (name === "id") id = k[2]!.trim();
        else if (name === "where") where = list(k[2]!);
        else plans = list(k[2]!);
        continue;
      }
      if (line.trim()) keys = false;
      if (!keys) body.push(line);
    }
    if (id !== null && !ID.test(id)) {
      problems.push(`"${title}" has the id "${id}": use lowercase letters, digits and dashes.`);
      id = null;
    }
    let fid = id ?? featureId(title);
    if (seen.has(fid)) {
      problems.push(`Two features have the id "${fid}": the second one ("${title}") is listed as ${fid}-2.`);
      for (let n = 2; seen.has(fid); n++) fid = `${id ?? featureId(title)}-${n}`;
    }
    seen.add(fid);
    features.push({ id: fid, title, where, plans: [...new Set(plans)], summary: body.join("\n").trim() });
  }
  return { features, problem: problems.length ? problems.join(" ") : null };
}

function readText(root: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(fileOf(root));
  } catch {
    return null;
  }
  if (st.size > MAX_BYTES) throw new UserError(`${FEATURES_FILE} is ${Math.round(st.size / 1024)} KB, more than the ${MAX_BYTES / 1024} KB it may be.`);
  return fs.readFileSync(fileOf(root), "utf-8");
}

export function readFeatures(root: string): FeatureMap {
  let text: string | null;
  try {
    text = readText(root);
  } catch (e) {
    return { features: [], problem: (e as Error).message, exists: true };
  }
  if (text === null) return { features: [], problem: null, exists: false };
  return { ...parseFeatures(text), exists: true };
}

/** A hash of the file as it is now, or null when there is none: tells whether a map session changed it. */
export function featuresSignature(root: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(fileOf(root))).digest("hex");
  } catch {
    return null;
  }
}

/** Adds `slug` to the plans line of a feature, writing only that section's lines. */
export function linkPlan(root: string, id: string, slug: string): Feature {
  const text = readText(root);
  if (text === null) throw new UserError(`There is no ${FEATURES_FILE} yet: map the features first.`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const { features } = parseFeatures(text);
  const at = features.findIndex((f) => f.id === id);
  if (at < 0) throw new UserError(`No feature "${id}" in ${FEATURES_FILE}.`);
  // The at-th "## " heading is this feature's: parseFeatures reads the sections in file order.
  let n = -1;
  let head = -1;
  for (let i = 0; i < lines.length; i++) if (/^##\s+/.test(lines[i]!) && ++n === at) {
    head = i;
    break;
  }
  let last = head;
  let plansLine = -1;
  for (let i = head + 1; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
    const k = KEY.exec(lines[i]!.trim());
    if (!k) {
      if (lines[i]!.trim()) break;
      continue;
    }
    last = i;
    if (k[1]!.toLowerCase() === "plans") plansLine = i;
  }
  const f = features[at]!;
  if (f.plans.includes(slug)) return f;
  const plans = [...f.plans, slug];
  if (plansLine >= 0) lines[plansLine] = `plans: ${plans.join(", ")}`;
  else lines.splice(last + 1, 0, `plans: ${plans.join(", ")}`);
  fs.writeFileSync(fileOf(root), lines.join(eol));
  return { ...f, plans };
}

/** How well a feature is tested, from the last run of each of its plans that exists and has steps (an empty plan tests nothing). */
export function coverageOf(plans: FeaturePlan[]): Coverage {
  const real = plans.filter((p) => p.exists && p.steps > 0);
  if (!real.length) return "no-plan";
  const runs = real.map((p) => p.lastRun);
  if (runs.every((r) => !r)) return "not-run";
  if (runs.some((r) => r && r.counts.fail > 0)) return "failing";
  if (runs.every((r) => r && r.finished && r.counts.blocked === 0)) return "passing";
  return "partial";
}

export function featureViews(features: Feature[], plans: PlanSummary[]): FeatureView[] {
  const bySlug = new Map(plans.map((p) => [p.slug as string, p]));
  return features.map((f) => {
    const planInfo: FeaturePlan[] = f.plans.map((slug) => {
      const p = bySlug.get(slug);
      return p ? { slug, title: p.title, exists: true, steps: p.steps, lastRun: p.lastRun } : { slug, title: null, exists: false, steps: 0, lastRun: null };
    });
    return { ...f, planInfo, coverage: coverageOf(planInfo) };
  });
}
