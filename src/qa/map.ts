/**
 * The feature map: `lab/features.md`, one section per thing a user can do, with the pages it lives on. Map jobs write it
 * through `qa_map` (submitMap below, the only writer); a person can edit it like any file.
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
 * A big product splits the map into areas. A `# <title>` heading whose next line is `area: <id>` starts one (with its own
 * `where:` and summary); the `##` features after it belong to it until the next area heading. A file with no area heading
 * is the flat layout above.
 *
 * Key lines come first in a section, in any order; the rest is the summary. A missing id is made from the title. A
 * `parent:` names a top-level feature (one level only). A `plans:` line is read and ignored. A submission
 * may also carry `was: <old-id>` on an entry and `drop: id1, id2` lines (see carryIds); neither is kept in the file.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { db } from "../db";
import { UserError } from "../util";
import { FEATURE_ID, LAB_DIR } from "../lab/findings";
import type { Area, AreaId, Feature, FeatureId, Job, JobId, MapFeature, MapUnit, MapWrite } from "./types";

export const FEATURES_FILE = `${LAB_DIR}/features.md`;
const MAX_BYTES = 1024 * 1024;
const KEY = /^(id|where|parent|plans|was)\s*:\s*(.*)$/i;
const AREA_KEY = /^(where)\s*:\s*(.*)$/i;
const AREA_LINE = /^area\s*:\s*(.*)$/i;
const DROP = /^drop\s*:\s*(.*)$/i;

const UNSORTED = "unsorted" as AreaId;

const fileOf = (root: string): string => path.join(root, FEATURES_FILE);
const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter(Boolean);
export const featureId = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "feature";

export interface FeatureMap {
  areas: Area[];
  features: MapFeature[];
  layout: "flat" | "areas";
  exists: boolean;
  problem: string | null;
  updatedAt: number | null;
}

/** One `##` entry as written: ids and parent are still the author's words. `was` and `drop` only mean something in a submission. */
export interface DraftFeature { id: string | null; was: string | null; title: string; where: string[]; parent: string | null; summary: string }

interface Entry extends DraftFeature { area: AreaId | null }
interface AreaBlock extends Area { start: number; end: number }

interface Scan {
  areas: AreaBlock[];
  entries: Entry[];
  drops: string[];
  problems: string[];
  preambleEnd: number;
}

/** Ids are not decided here, so one pass serves the file and a submission. */
function scan(text: string): Scan {
  const lines = text.split("\n");
  const at: number[] = [];
  let pos = 0;
  for (const l of lines) {
    at.push(pos);
    pos += l.length + 1;
  }
  const isAreaHead = (n: number): boolean => /^#\s+\S/.test(lines[n] ?? "") && AREA_LINE.test((lines[n + 1] ?? "").trim());
  const isHead = (n: number): boolean => /^##\s/.test(lines[n] ?? "") || isAreaHead(n);

  const areas: AreaBlock[] = [];
  const entries: Entry[] = [];
  const drops: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let current: AreaId | null = null;
  let preambleEnd = -1;
  const mark = (n: number) => {
    if (preambleEnd < 0) preambleEnd = at[n]!;
  };
  const takeDrop = (line: string): boolean => {
    const d = DROP.exec(line.trim());
    if (d) drops.push(...list(d[1]!));
    return !!d;
  };

  let i = 0;
  while (i < lines.length) {
    if (isAreaHead(i)) {
      mark(i);
      const title = /^#\s+(.+?)\s*$/.exec(lines[i]!)![1]!;
      const start = at[i]!;
      let id: string = AREA_LINE.exec(lines[i + 1]!.trim())![1]!.trim();
      if (!FEATURE_ID.test(id)) {
        problems.push(`The area "${title}" has the area id "${id}": use lowercase letters, digits and dashes.`);
        id = featureId(title);
      }
      let aid = id;
      if (seen.has(aid)) {
        problems.push(`Two areas have the id "${aid}": the second one ("${title}") is listed as ${aid}-2.`);
        for (let n = 2; seen.has(aid); n++) aid = `${id}-${n}`;
      }
      seen.add(aid);
      let where: string[] = [];
      const body: string[] = [];
      let keys = true;
      for (i += 2; i < lines.length && !isHead(i); i++) {
        const line = lines[i]!;
        if (takeDrop(line)) continue;
        const k = keys ? AREA_KEY.exec(line.trim()) : null;
        if (k) {
          where = list(k[2]!);
          continue;
        }
        if (line.trim()) keys = false;
        if (!keys) body.push(line);
      }
      current = aid as AreaId;
      areas.push({ id: current, title, where, summary: body.join("\n").trim(), start, end: text.length });
      continue;
    }
    const line = lines[i]!;
    const head = /^##\s+(.+?)\s*$/.exec(line);
    i++;
    if (!head) {
      takeDrop(line);
      continue;
    }
    mark(i - 1);
    const title = head[1]!;
    let id: string | null = null;
    let was: string | null = null;
    let where: string[] = [];
    let parent: string | null = null;
    const body: string[] = [];
    let keys = true;
    for (; i < lines.length && !isHead(i); i++) {
      const line = lines[i]!;
      if (takeDrop(line)) continue;
      const k = keys ? KEY.exec(line.trim()) : null;
      if (k) {
        const name = k[1]!.toLowerCase();
        if (name === "id") id = k[2]!.trim();
        else if (name === "was") was = k[2]!.trim() || null;
        else if (name === "where") where = list(k[2]!);
        else if (name === "parent") parent = k[2]!.trim() || null;
        continue;
      }
      if (line.trim()) keys = false;
      if (!keys) body.push(line);
    }
    entries.push({ id, was, title, where, parent, summary: body.join("\n").trim(), area: current });
  }
  areas.forEach((a, n) => {
    a.end = areas[n + 1]?.start ?? text.length;
  });
  return { areas, entries, drops, problems, preambleEnd: preambleEnd < 0 ? text.length : preambleEnd };
}

export function parseMap(text: string): Omit<FeatureMap, "exists" | "updatedAt"> {
  const s = scan(text);
  const problems = [...s.problems];
  const seen = new Set<string>();
  const found = s.entries.map((e) => {
    let id = e.id;
    if (id !== null && !FEATURE_ID.test(id)) {
      problems.push(`"${e.title}" has the id "${id}": use lowercase letters, digits and dashes.`);
      id = null;
    }
    let fid = id ?? featureId(e.title);
    if (seen.has(fid)) {
      problems.push(`Two features have the id "${fid}": the second one ("${e.title}") is listed as ${fid}-2.`);
      for (let n = 2; seen.has(fid); n++) fid = `${id ?? featureId(e.title)}-${n}`;
    }
    seen.add(fid);
    return { ...e, fid };
  });
  const declared = new Map(found.map((f) => [f.fid, f.parent]));
  const features = found.map((f): MapFeature => {
    let parent: FeatureId | null = null;
    if (f.parent !== null) {
      if (f.parent === f.fid || !declared.has(f.parent)) problems.push(`"${f.title}" has the parent "${f.parent}", which is not a feature: it is shown at the top level.`);
      else if (declared.get(f.parent) !== null) problems.push(`"${f.title}" has the parent "${f.parent}", which has a parent itself: features nest one level only, so it is shown at the top level.`);
      else parent = f.parent as FeatureId;
    }
    return { id: f.fid as FeatureId, title: f.title, where: f.where, parent, summary: f.summary, area: f.area };
  });
  const areas = s.areas.map(({ id, title, where, summary }): Area => ({ id, title, where, summary }));
  if (areas.length && features.some((f) => f.area === null)) problems.push("Some features come before the first area heading, so no area job maps them: move them under an area.");
  return { areas, features, layout: areas.length ? "areas" : "flat", problem: problems.length ? problems.join(" ") : null };
}

export function parseFeatures(text: string): { features: Feature[]; problem: string | null } {
  const m = parseMap(text);
  return { features: m.features.map(({ area: _area, ...f }) => f), problem: m.problem };
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

const EMPTY = { areas: [] as Area[], features: [] as MapFeature[], layout: "flat" as const };

export function readMap(root: string): FeatureMap {
  let updatedAt: number | null = null;
  try {
    updatedAt = Math.floor(fs.statSync(fileOf(root)).mtimeMs);
  } catch {
    return { ...EMPTY, exists: false, problem: null, updatedAt };
  }
  try {
    const text = readText(root);
    if (text === null) return { ...EMPTY, exists: false, problem: null, updatedAt: null };
    return { ...parseMap(text), exists: true, updatedAt };
  } catch (e) {
    return { ...EMPTY, exists: true, problem: (e as Error).message, updatedAt };
  }
}

export function readFeatures(root: string): { features: Feature[]; problem: string | null; exists: boolean; updatedAt: number | null } {
  const { features, problem, exists, updatedAt } = readMap(root);
  return { features: features.map(({ area: _area, ...f }) => f), problem, exists, updatedAt };
}

const renderFeature = (f: Feature): string =>
  `## ${f.title}\nid: ${f.id}\n${f.parent ? `parent: ${f.parent}\n` : ""}${f.where.length ? `where: ${f.where.join(", ")}\n` : ""}${f.summary ? `${f.summary}\n` : ""}\n`;

const renderAreaHead = (a: Area): string => `# ${a.title}\narea: ${a.id}\n${a.where.length ? `where: ${a.where.join(", ")}\n` : ""}${a.summary ? `${a.summary}\n` : ""}\n`;

const renderArea = (a: Area, features: readonly Feature[]): string => renderAreaHead(a) + features.map(renderFeature).join("");

/** A section ends in one newline, plus a blank line when another section follows, so splicing never moves its neighbours. */
const closed = (s: string, last: boolean): string => `${s.trimEnd()}\n${last ? "" : "\n"}`;

function renderMap(m: Pick<FeatureMap, "areas" | "features">, preamble = "# Features"): string {
  const loose = m.features.filter((f) => f.area === null);
  const parts = [`${preamble.trimEnd()}\n\n`, loose.map(renderFeature).join("")];
  for (const a of m.areas) parts.push(renderArea(a, m.features.filter((f) => f.area === a.id)));
  return `${parts.join("").trimEnd()}\n`;
}

/** "" for an area the map lacks. */
export function sectionOf(map: FeatureMap, unit: MapUnit): string {
  if (unit === "map") return renderMap(map);
  if (unit === "areas") return `${map.areas.map(renderAreaHead).join("").trimEnd()}\n`;
  const a = map.areas.find((x) => x.id === unit.slice(5));
  return a ? closed(renderArea(a, map.features.filter((f) => f.area === a.id)), true) : "";
}

const fit = (s: string, suffix = ""): string => s.slice(0, 60 - suffix.length).replace(/-+$/, "") + suffix;
const norm = (s: string): string => s.trim().toLowerCase();
const whereKey = (w: readonly string[]): string => [...new Set(w.map((x) => x.trim()))].sort().join("\n");

/**
 * Plans, runs and bugs are keyed by feature id, so ids change only here and only by code, never because an agent
 * typed a different `id:`. An old id of the area that is neither matched nor listed in `drops` is a problem (the
 * caller rejects the submission).
 */
export function carryIds(
  before: readonly Feature[],
  after: readonly DraftFeature[],
  owned: ReadonlyMap<FeatureId, AreaId | null>,
  area: AreaId | null,
  drops: readonly string[] = [],
): { features: MapFeature[]; dropped: FeatureId[]; problems: string[] } {
  const problems: string[] = [];
  const mine = before.filter((f) => owned.get(f.id) === area);
  const match: Array<Feature | null> = after.map(() => null);
  const taken = new Set<FeatureId>();
  const take = (n: number, o: Feature) => {
    match[n] = o;
    taken.add(o.id);
  };

  const byId = new Map(mine.map((f) => [f.id as string, f]));
  after.forEach((d, n) => {
    const o = d.was ? byId.get(d.was) : undefined;
    if (o && !taken.has(o.id)) take(n, o);
  });
  after.forEach((d, n) => {
    if (match[n]) return;
    const o = mine.find((x) => !taken.has(x.id) && norm(x.title) === norm(d.title));
    if (o) take(n, o);
  });
  const key = (where: readonly string[], parent: string | null): string => `${whereKey(where)}|${parent ?? ""}`;
  const free = mine.filter((x) => !taken.has(x.id) && x.where.length);
  const drafts = after.map((d, n) => ({ d, n })).filter(({ d, n }) => !match[n] && d.where.length);
  for (const { d, n } of drafts) {
    const k = key(d.where, d.parent);
    const olds = free.filter((x) => key(x.where, x.parent) === k);
    if (olds.length === 1 && drafts.filter((o) => key(o.d.where, o.d.parent) === k).length === 1 && !taken.has(olds[0]!.id)) take(n, olds[0]!);
  }

  const used = new Set<string>(owned.keys());
  const ids: string[] = [];
  after.forEach((d, n) => {
    const kept = match[n];
    if (kept) {
      ids.push(kept.id);
      return;
    }
    let base = d.id !== null && FEATURE_ID.test(d.id) ? d.id : featureId(d.title);
    if (used.has(base) && area !== null && owned.has(base as FeatureId) && owned.get(base as FeatureId) !== area) base = fit(`${area}-${base}`);
    let id = base;
    for (let k = 2; used.has(id); k++) id = fit(base, `-${k}`);
    used.add(id);
    ids.push(id);
  });

  const dropSet = new Set(drops);
  const dropped: FeatureId[] = [];
  for (const o of mine) {
    if (taken.has(o.id)) {
      if (dropSet.has(o.id)) problems.push(`'${o.id}' is both kept and listed in drop: remove one of the two.`);
      continue;
    }
    if (dropSet.has(o.id)) dropped.push(o.id);
    else problems.push(`'${o.id}' ("${o.title}") is missing from your text: keep it (if you renamed it, write was: ${o.id} on the renamed entry) or add a line drop: ${o.id}.`);
  }

  const ref = new Map<string, string>();
  ids.forEach((id) => ref.set(id, id));
  after.forEach((d, n) => {
    if (d.id !== null && !ref.has(d.id)) ref.set(d.id, ids[n]!);
    if (d.was && !ref.has(d.was)) ref.set(d.was, ids[n]!);
  });
  const parents = after.map((d, n): string | null => {
    if (d.parent === null) return null;
    const p = ref.get(d.parent);
    if (p === undefined || p === ids[n]) {
      problems.push(`"${d.title}" has the parent "${d.parent}", which is not another feature in this text.`);
      return null;
    }
    return p;
  });
  const features = after.map((d, n): MapFeature => {
    let parent = parents[n] ?? null;
    if (parent !== null && parents[ids.indexOf(parent)] !== null) {
      problems.push(`"${d.title}" has the parent "${d.parent}", which has a parent itself: features nest one level only.`);
      parent = null;
    }
    return { id: ids[n] as FeatureId, title: d.title, where: d.where, parent: parent as FeatureId | null, summary: d.summary, area };
  });
  return { features, dropped, problems };
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** Same longest-prefix rule as featureForUrl (pipeline.ts), applied to a feature's paths. */
export function assignAreas(features: readonly Feature[], areas: readonly Area[]): MapFeature[] {
  const home = (f: Feature): AreaId => {
    let best = 0;
    let winners = new Set<AreaId>();
    for (const raw of f.where) {
      if (!raw.startsWith("/")) continue;
      const p = trimSlash(raw);
      for (const a of areas) {
        for (const aw of a.where) {
          if (!aw.startsWith("/")) continue;
          const w = trimSlash(aw);
          if (!(p === w || p.startsWith(w === "/" ? "/" : `${w}/`))) continue;
          if (w.length > best) {
            best = w.length;
            winners = new Set([a.id]);
          } else if (w.length === best) winners.add(a.id);
        }
      }
    }
    return winners.size === 1 ? [...winners][0]! : UNSORTED;
  };
  const top = new Map<FeatureId, AreaId>();
  for (const f of features) if (f.parent === null) top.set(f.id, home(f));
  return features.map((f) => ({ ...f, area: f.parent === null ? top.get(f.id)! : (top.get(f.parent) ?? UNSORTED) }));
}

const fail = (problems: readonly string[]): never => {
  throw new UserError(`Nothing was saved. Fix this and call qa_map again with the whole text: ${problems.join(" ")}`);
};

export function mapUnitOf(raw: string): MapUnit | null {
  if (raw === "map" || raw === "areas") return raw;
  const m = /^area:(.+)$/.exec(raw);
  return m && FEATURE_ID.test(m[1]!) ? (raw as MapUnit) : null;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const withoutDrops = (s: string): string => s.split("\n").filter((l) => !DROP.test(l.trim())).join("\n");
const preambleOf = (text: string, end: number): string => withoutDrops(text.slice(0, end)).trim() || "# Features";
const noun = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const idList = (ids: readonly string[]): string => ids.slice(0, 8).join(", ") + (ids.length > 8 ? ", ..." : "");

interface Plan { text: string; reply: string; dropped: FeatureId[] }

function planMap(unit: MapUnit, oldText: string | null, cur: ReturnType<typeof parseMap>, sub: Scan, text: string): Plan {
  if (unit === "areas") {
    if (sub.entries.length) return fail(["The area survey lists areas only: write each as '# Title' then 'area: id' (and where:), with no ## features. Features are mapped area by area afterwards."]);
    if (!sub.areas.length) return fail(["No areas found. Write each area as '# Title', then a line 'area: some-id', then 'where: /path, /other' and a sentence on what it covers."]);
    if (sub.problems.length) return fail(sub.problems);
    const areas = sub.areas.map(({ id, title, where, summary }): Area => ({ id, title, where, summary }));
    const placed = assignAreas(cur.features, areas);
    const stray = placed.filter((f) => f.area === UNSORTED).length;
    const all = stray && !areas.some((a) => a.id === UNSORTED) ? [...areas, { id: UNSORTED, title: "Unsorted", where: [], summary: "Features that sit under no area yet." }] : areas;
    const preamble = oldText === null ? "# Features" : preambleOf(oldText, scan(oldText).preambleEnd);
    const reply = `Saved: ${noun(all.length, "area")}. ${noun(placed.length, "feature")}${placed.length ? (stray ? `: ${placed.length - stray} placed, ${stray} in unsorted` : " placed") : ""}.`;
    return { text: renderMap({ areas: all, features: placed }, preamble), reply, dropped: [] };
  }

  const scope = unit === "map" ? null : (unit.slice(5) as AreaId);
  const owned = new Map<FeatureId, AreaId | null>(cur.features.map((f) => [f.id, scope === null ? null : f.area]));
  const head = scope === null ? null : cur.areas.find((a) => a.id === scope);
  if (scope === null) {
    if (sub.areas.length) return fail(["This job maps a flat feature list: remove the '# ...' area headings and keep only the ## features."]);
    if (cur.layout === "areas") return fail([`${FEATURES_FILE} is organized in areas, so it cannot be replaced as one flat list. Map one area at a time.`]);
  } else {
    if (!head) return fail([`There is no area "${scope}" in ${FEATURES_FILE}. Areas come first, from the area survey.`]);
    if (sub.areas.length > 1 || (sub.areas[0] && sub.areas[0].id !== scope)) return fail([`This job maps the area "${scope}" only: do not write another area heading.`]);
  }
  const r = carryIds(cur.features, sub.entries, owned, scope, sub.drops);
  const problems = [...sub.problems, ...r.problems];
  const mine = cur.features.filter((f) => owned.get(f.id) === scope);
  if (!sub.entries.length && !mine.length) problems.push("No features found: write each as '## Title' with id:, where: and a sentence on what it is.");
  if (problems.length) return fail(problems);

  let out: string;
  if (scope === null) out = renderMap({ areas: [], features: r.features }, preambleOf(text, scan(text).preambleEnd));
  else {
    const block = scan(oldText!).areas[cur.areas.indexOf(head!)]!;
    const given = sub.areas[0];
    const area: Area = given ? { id: scope, title: given.title, where: given.where, summary: given.summary } : head!;
    out = oldText!.slice(0, block.start) + closed(renderArea(area, r.features), block.end === oldText!.length) + oldText!.slice(block.end);
  }

  const before = new Map(mine.map((f) => [f.id, f.title]));
  const fresh = r.features.filter((f) => !before.has(f.id)).map((f) => f.id as string);
  const retitled = r.features.filter((f) => before.has(f.id) && before.get(f.id) !== f.title).length;
  const reply = [
    `Saved: ${noun(r.features.length, "feature")}${fresh.length ? ` (${fresh.length} new: ${idList(fresh)})` : ""}.`,
    retitled ? `Kept ids for ${retitled} retitled.` : "",
    r.dropped.length ? `Dropped: ${r.dropped.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return { text: out, reply, dropped: r.dropped };
}

/**
 * Synchronous on purpose: two jobs mapping different areas read, splice and rename without another write in between.
 * Throws a UserError that says what to fix, and writes nothing, when the text cannot be accepted.
 */
export function submitMap(root: string, job: Job, text: string): { text: string } {
  if (job.stage !== "map") throw new UserError("qa_map is for a QA map job.");
  const unit = mapUnitOf(String(job.units[0]));
  if (!unit) throw new UserError(`This job's unit "${job.units[0]}" is not a map unit: qa_map cannot write for it.`);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new UserError(`The text is over ${MAX_BYTES / 1024} KB.`);
  const onDisk = readText(root);
  const eol = onDisk?.includes("\r\n") ? "\r\n" : "\n";
  const oldText = onDisk === null ? null : onDisk.replace(/\r\n/g, "\n");
  const given = text.replace(/\r\n/g, "\n");
  const cur = oldText === null ? { ...EMPTY, problem: null } : parseMap(oldText);
  const plan = planMap(unit, oldText, cur, scan(given), given);
  const out = eol === "\n" ? plan.text : plan.text.replace(/\n/g, eol);
  if (Buffer.byteLength(out) > MAX_BYTES) throw new UserError(`${FEATURES_FILE} would be over ${MAX_BYTES / 1024} KB with this text.`);
  const changed = out !== (onDisk ?? "");
  if (changed) writeAtomic(fileOf(root), out);
  db()
    .prepare("INSERT INTO qa_map_writes (job_id, unit, changed, dropped, sig, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(job.id, unit, changed ? 1 : 0, JSON.stringify(plan.dropped), crypto.createHash("sha1").update(out).digest("hex"), Date.now());
  return { text: changed ? plan.reply : "No changes." };
}

export function mapWritesOf(job: JobId): MapWrite[] {
  const rows = db().prepare("SELECT * FROM qa_map_writes WHERE job_id = ? ORDER BY at, rowid").all(job) as Array<{ job_id: string; unit: string; changed: number; dropped: string; sig: string; at: number }>;
  return rows.map((r) => ({ job: r.job_id as JobId, unit: r.unit as MapUnit, changed: r.changed === 1, dropped: JSON.parse(r.dropped) as FeatureId[], sig: r.sig, at: r.at }));
}

/** The `at` of the newest accepted qa_map call per unit, over every job of the project. */
export function lastMapWrites(root: string): Map<string, number> {
  const rows = db().prepare("SELECT w.unit AS unit, MAX(w.at) AS at FROM qa_map_writes w JOIN qa_jobs j ON j.id = w.job_id WHERE j.root_dir = ? GROUP BY w.unit").all(root) as Array<{ unit: string; at: number }>;
  return new Map(rows.map((r) => [r.unit, r.at]));
}
