/**
 * The feature map: `lab/features.md`, one section per thing a user can do, with the pages it lives on. The map stage of
 * a pipeline writes it; a person can edit it like any file.
 *
 *   # Features
 *
 *   ## Checkout
 *   id: checkout
 *   where: /cart, /checkout
 *   A buyer pays for the cart with a saved or a new card.
 *
 *   ## Apply a discount code
 *   id: apply-discount
 *   parent: checkout
 *   where: /cart
 *   A buyer enters a code and sees the total drop.
 *
 * Key lines come first in a section, in any order; the rest is the summary. A missing id is made from the title. A
 * `parent:` names a top-level feature (one level only). A `plans:` line from an older map is read and ignored.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { FEATURE_ID, LAB_DIR } from "../lab/findings";
import { featureForUrl } from "./pipeline";
import type { Feature, FeatureId } from "./types";

export { featureForUrl };

export const FEATURES_FILE = `${LAB_DIR}/features.md`;
const MAX_BYTES = 256 * 1024;
const KEY = /^(id|where|parent|plans)\s*:\s*(.*)$/i;

const fileOf = (root: string): string => path.join(root, FEATURES_FILE);
const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter(Boolean);
export const featureId = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "feature";

export function parseFeatures(text: string): { features: Feature[]; problem: string | null } {
  const lines = text.split(/\r?\n/);
  const found: Array<{ id: FeatureId; title: string; where: string[]; parent: string | null; summary: string }> = [];
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
    let parent: string | null = null;
    const body: string[] = [];
    let keys = true;
    for (; i < lines.length && !/^##\s/.test(lines[i]!); i++) {
      const line = lines[i]!;
      const k = keys ? KEY.exec(line.trim()) : null;
      if (k) {
        const name = k[1]!.toLowerCase();
        if (name === "id") id = k[2]!.trim();
        else if (name === "where") where = list(k[2]!);
        else if (name === "parent") parent = k[2]!.trim() || null;
        continue;
      }
      if (line.trim()) keys = false;
      if (!keys) body.push(line);
    }
    if (id !== null && !FEATURE_ID.test(id)) {
      problems.push(`"${title}" has the id "${id}": use lowercase letters, digits and dashes.`);
      id = null;
    }
    let fid = id ?? featureId(title);
    if (seen.has(fid)) {
      problems.push(`Two features have the id "${fid}": the second one ("${title}") is listed as ${fid}-2.`);
      for (let n = 2; seen.has(fid); n++) fid = `${id ?? featureId(title)}-${n}`;
    }
    seen.add(fid);
    found.push({ id: fid as FeatureId, title, where, parent, summary: body.join("\n").trim() });
  }
  const declared = new Map(found.map((f) => [f.id as string, f.parent]));
  const features = found.map((f): Feature => {
    let parent: FeatureId | null = null;
    if (f.parent !== null) {
      if (f.parent === f.id || !declared.has(f.parent)) problems.push(`"${f.title}" has the parent "${f.parent}", which is not a feature: it is shown at the top level.`);
      else if (declared.get(f.parent) !== null) problems.push(`"${f.title}" has the parent "${f.parent}", which has a parent itself: features nest one level only, so it is shown at the top level.`);
      else parent = f.parent as FeatureId;
    }
    return { id: f.id, title: f.title, where: f.where, parent, summary: f.summary };
  });
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

export function readFeatures(root: string): { features: Feature[]; problem: string | null; exists: boolean; updatedAt: number | null } {
  let updatedAt: number | null = null;
  try {
    updatedAt = Math.floor(fs.statSync(fileOf(root)).mtimeMs);
  } catch {
    return { features: [], problem: null, exists: false, updatedAt };
  }
  try {
    const text = readText(root);
    if (text === null) return { features: [], problem: null, exists: false, updatedAt: null };
    return { ...parseFeatures(text), exists: true, updatedAt };
  } catch (e) {
    return { features: [], problem: (e as Error).message, exists: true, updatedAt };
  }
}

/** A hash of the file as it is now, or null when there is none: tells whether a map job changed it. */
export function featuresSignature(root: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(fileOf(root))).digest("hex");
  } catch {
    return null;
  }
}
