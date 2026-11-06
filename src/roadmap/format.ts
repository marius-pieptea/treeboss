/**
 * ROADMAP.md: parse and edit.
 *
 * The file is the source of truth; the app is a lens over it. So this module never "renders" a document
 * from a model: it reads the text into lines, finds the lanes and items, and every edit replaces or moves
 * only the lines it owns. Everything else (prose, the H1, comments, blank lines, line endings, a missing
 * final newline) comes back byte for byte.
 *
 * Format (also printed at the top of a generated ROADMAP.md):
 *
 *   ## Now                                  an H2 is a lane; rename, add and reorder them freely
 *   - [ ] Title {#r12} (spec: specs/003-chat) (docs: docs/architecture.md) (tag: infra) (target: 2026-Q4)
 *     Indented lines under an item are its description.
 *   - [x] A checked item is shipped.
 *
 * Only `(spec: …)`, `(docs: …)`, `(tag: …)`, `(tags: …)` and `(target: …)` groups are read as fields;
 * any other parenthesis stays in the title. `{#rN}` is the item's id; the app adds one the first time it
 * edits an item and never changes it afterwards. An item without one still has a stable-enough key for
 * display (`t-…`, from its title); nothing is written until the item is edited.
 *
 * Not parsed (so never touched by an item edit): anything inside a fenced code block or an HTML comment
 * that starts at the left margin, and anything before the first H2.
 */
import { UserError } from "../util";

export interface Line {
  text: string;
  /** "\n", "\r\n", "\r", or "" for a last line with no newline. */
  eol: string;
}

export interface RoadmapItem {
  /** Explicit `{#id}`, or null when the file has none. */
  id: string | null;
  /** id, else a derived key. Stable across reads while the title and its position among equals do not change. */
  key: string;
  title: string;
  done: boolean;
  spec: string | null;
  docs: string | null;
  tags: string[];
  target: string | null;
  /** The indented lines under the item, with their common indent removed, joined with "\n". */
  description: string;
  lane: string;
  /** First line (the item line) and one past the last description line, as indexes into `lines`. */
  line: number;
  end: number;
  indent: string;
  marker: string;
}

export interface RoadmapLane {
  name: string;
  /** The H2 line, and one past the last line before the next H2 (or the end). */
  line: number;
  end: number;
  items: RoadmapItem[];
}

export interface ParsedRoadmap {
  lines: Line[];
  lanes: RoadmapLane[];
  /** The newline new lines are written with: the file's most common one. */
  eol: string;
  /** What the next generated id is. */
  nextId: number;
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                      */
/* -------------------------------------------------------------------------- */

export function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let j = i;
    while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
    if (j >= n) {
      out.push({ text: text.slice(i), eol: "" });
      break;
    }
    let eol = text[j]!;
    if (eol === "\r" && text[j + 1] === "\n") eol = "\r\n";
    out.push({ text: text.slice(i, j), eol });
    i = j + eol.length;
  }
  return out;
}

export const joinLines = (lines: Line[]): string => lines.map((l) => l.text + l.eol).join("");

function dominantEol(lines: Line[]): string {
  const count: Record<string, number> = {};
  for (const l of lines) if (l.eol) count[l.eol] = (count[l.eol] ?? 0) + 1;
  let best = "\n";
  let max = 0;
  for (const [k, v] of Object.entries(count)) if (v > max) (best = k), (max = v);
  return best;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const LANE_RE = /^## +(.+?)\s*$/;
const ITEM_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]+(.*?)[ \t]*$/;
const ID_RE = /\{#([A-Za-z0-9_-]+)\}/;
const FIELD_RE = /\(\s*(spec|docs|tags?|target)\s*:\s*([^()]*?)\s*\)/gi;
const FENCE_RE = /^ {0,1}(```|~~~)/;

const indentWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += ch === "\t" ? 4 : 1;
  return w;
};
const isBlank = (s: string): boolean => s.trim() === "";

/** Which lines are inside a fenced block or an HTML comment that starts at the left margin. */
function skipMask(lines: Line[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: string | null = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.text;
    if (fence) {
      mask[i] = true;
      if (/^ {0,3}(`{3,}|~{3,})\s*$/.test(t) && t.trim()[0] === fence) fence = null;
      continue;
    }
    if (comment) {
      mask[i] = true;
      if (t.includes("-->")) comment = false;
      continue;
    }
    const f = FENCE_RE.exec(t);
    if (f) {
      mask[i] = true;
      fence = f[1]![0]!;
      continue;
    }
    if (/^ {0,1}<!--/.test(t)) {
      mask[i] = true;
      if (!t.includes("-->", t.indexOf("<!--") + 4)) comment = true;
    }
  }
  return mask;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(-6);
}

export function splitFields(rest: string): { title: string; id: string | null; spec: string | null; docs: string | null; tags: string[]; target: string | null } {
  let id: string | null = null;
  let spec: string | null = null;
  let docs: string | null = null;
  let target: string | null = null;
  const tags: string[] = [];
  let s = rest.replace(ID_RE, (_m, g: string) => {
    if (id === null) id = g;
    return " ";
  });
  s = s.replace(FIELD_RE, (_m, key: string, value: string) => {
    const k = key.toLowerCase();
    const v = value.trim();
    if (k === "spec") spec ??= v || null;
    else if (k === "docs") docs ??= v || null;
    else if (k === "target") target ??= v || null;
    else for (const t of v.split(",").map((x) => x.trim()).filter(Boolean)) if (!tags.includes(t)) tags.push(t);
    return " ";
  });
  const title = s.replace(/\s+/g, " ").trim();
  return { title: title || "(untitled)", id, spec, docs, tags, target };
}

export function parseRoadmap(text: string): ParsedRoadmap {
  const lines = splitLines(text);
  const mask = skipMask(lines);
  const lanes: RoadmapLane[] = [];
  const seenKeys = new Map<string, number>();

  // Lanes first: an H2 outside a skipped region.
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = LANE_RE.exec(lines[i]!.text);
    if (m) lanes.push({ name: m[1]!.replace(/\s+#+$/, "").trim(), line: i, end: lines.length, items: [] });
  }
  for (let k = 0; k < lanes.length - 1; k++) lanes[k]!.end = lanes[k + 1]!.line;

  for (const lane of lanes) {
    let i = lane.line + 1;
    while (i < lane.end) {
      const t = lines[i]!.text;
      const m = mask[i] ? null : ITEM_RE.exec(t);
      if (!m || indentWidth(m[1]!) > 3) {
        i++;
        continue;
      }
      // Description: following indented, non-blank lines, with blank lines allowed between them.
      let end = i + 1;
      let probe = i + 1;
      while (probe < lane.end) {
        const pt = lines[probe]!.text;
        if (isBlank(pt)) {
          probe++;
          continue;
        }
        if (indentWidth(/^[ \t]*/.exec(pt)![0]) >= 2 && !LANE_RE.test(pt)) {
          end = probe + 1;
          probe = end;
          continue;
        }
        break;
      }
      const f = splitFields(m[4]!);
      const descLines = lines.slice(i + 1, end).map((l) => l.text);
      const nonBlank = descLines.filter((l) => !isBlank(l));
      const common = nonBlank.length ? Math.min(...nonBlank.map((l) => indentWidth(/^[ \t]*/.exec(l)![0]))) : 0;
      const description = descLines.map((l) => (isBlank(l) ? "" : stripIndent(l, common))).join("\n");
      let key = f.id ?? `t-${fnv(f.title.toLowerCase())}`;
      if (!f.id) {
        const n = (seenKeys.get(key) ?? 0) + 1;
        seenKeys.set(key, n);
        if (n > 1) key = `${key}-${n}`;
      }
      lane.items.push({
        id: f.id,
        key,
        title: f.title,
        done: m[3] !== " ",
        spec: f.spec,
        docs: f.docs,
        tags: f.tags,
        target: f.target,
        description,
        lane: lane.name,
        line: i,
        end,
        indent: m[1]!,
        marker: m[2]!,
      });
      i = end;
    }
  }

  let max = 0;
  // Ids already in use anywhere outside comments and code (an example id in the file's own docs does not count).
  lines.forEach((l, i) => {
    if (mask[i]) return;
    for (const m of l.text.matchAll(/\{#r(\d+)\}/g)) max = Math.max(max, Number(m[1]));
  });
  return { lines, lanes, eol: dominantEol(lines), nextId: max + 1 };
}

function stripIndent(line: string, width: number): string {
  let w = 0;
  let i = 0;
  while (i < line.length && w < width && (line[i] === " " || line[i] === "\t")) {
    w += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

/* -------------------------------------------------------------------------- */
/* Editing                                                                    */
/* -------------------------------------------------------------------------- */

export interface ItemFields {
  title: string;
  done: boolean;
  description: string;
  tags: string[];
  spec: string | null;
  docs: string | null;
  target: string | null;
}

const clean = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();
/** A value inside `( … )` can hold neither parenthesis. */
const cleanValue = (s: string): string => clean(s).replace(/[()]/g, "");

function itemLine(f: ItemFields, id: string, indent: string, marker: string): string {
  const parts = [`${indent}${marker} [${f.done ? "x" : " "}] ${clean(f.title).replace(/\{#/g, "{ #")}`, `{#${id}}`];
  if (f.spec) parts.push(`(spec: ${cleanValue(f.spec)})`);
  if (f.docs) parts.push(`(docs: ${cleanValue(f.docs)})`);
  const tags = f.tags.map(cleanValue).filter(Boolean);
  if (tags.length) parts.push(`(tag: ${tags.join(", ")})`);
  if (f.target) parts.push(`(target: ${cleanValue(f.target)})`);
  return parts.join(" ");
}

function descriptionLines(description: string, indent: string): string[] {
  const body = description.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!body.trim()) return [];
  return body.split("\n").map((l) => (l.trim() ? `${indent}  ${l.replace(/\s+$/, "")}` : ""));
}

function findLane(p: ParsedRoadmap, name: string): RoadmapLane {
  const want = name.trim().toLowerCase();
  const lane = p.lanes.find((l) => l.name.toLowerCase() === want);
  if (!lane) throw new UserError(`No lane "${name}". Lanes: ${p.lanes.map((l) => l.name).join(", ") || "none"}.`);
  return lane;
}

export function findItem(p: ParsedRoadmap, key: string): RoadmapItem {
  for (const lane of p.lanes) for (const it of lane.items) if (it.key === key || it.id === key) return it;
  throw new UserError(`No roadmap item "${key}".`);
}

function removeRange(lines: Line[], from: number, to: number): Line[] {
  const removed = lines.splice(from, to - from);
  if (from >= lines.length && from > 0 && removed.length && removed[removed.length - 1]!.eol === "") lines[from - 1]!.eol = "";
  return removed;
}

/**
 * Where a new item goes in a lane: after item `index - 1` (or at the top), default the end. `pad` is set
 * for an empty lane, whose first item gets a blank line above it (and below, when something follows).
 */
function slotIn(p: ParsedRoadmap, lane: RoadmapLane, index: number | null | undefined, skip?: RoadmapItem): { at: number; pad: boolean } {
  const items = lane.items.filter((i) => i !== skip);
  const at = index === null || index === undefined ? items.length : Math.max(0, Math.min(index, items.length));
  if (at > 0) return { at: items[at - 1]!.end - 1, pad: false };
  if (items.length) return { at: items[0]!.line - 1, pad: false };
  return { at: lane.line, pad: true };
}

/** The lines to insert for a block, with the blank-line padding an empty lane wants. */
function padded(p: ParsedRoadmap, at: number, block: Line[], pad: boolean): Line[] {
  if (!pad) return block;
  const out: Line[] = [{ text: "", eol: p.eol }, ...block];
  const next = p.lines[at + 1];
  if (next && !isBlank(next.text)) out.push({ text: "", eol: p.eol });
  return out;
}

function nextEdit(p: ParsedRoadmap): { text: string } {
  return { text: joinLines(p.lines) };
}

export interface NewItem {
  lane: string;
  title: string;
  description?: string;
  tags?: string[];
  spec?: string | null;
  docs?: string | null;
  target?: string | null;
  done?: boolean;
  index?: number | null;
}

export function addItem(text: string, input: NewItem): { text: string; id: string } {
  const title = clean(input.title ?? "");
  if (!title) throw new UserError("An item needs a title.");
  const p = parseRoadmap(text);
  const lane = findLane(p, input.lane);
  const id = `r${p.nextId}`;
  const first = lane.items[0];
  const indent = first?.indent ?? "";
  const marker = first?.marker ?? "-";
  const fields: ItemFields = { title, done: input.done === true, description: input.description ?? "", tags: input.tags ?? [], spec: input.spec ?? null, docs: input.docs ?? null, target: input.target ?? null };
  const block = [itemLine(fields, id, indent, marker), ...descriptionLines(fields.description, indent)];
  const slot = slotIn(p, lane, input.index);
  insertBlock(p.lines, slot.at, padded(p, slot.at, block.map((t) => ({ text: t, eol: p.eol })), slot.pad), p.eol);
  return { ...nextEdit(p), id };
}

export interface ItemPatch {
  title?: string;
  done?: boolean;
  description?: string;
  tags?: string[];
  spec?: string | null;
  docs?: string | null;
  target?: string | null;
}

const current = (it: RoadmapItem): ItemFields => ({ title: it.title, done: it.done, description: it.description, tags: it.tags, spec: it.spec, docs: it.docs, target: it.target });

/** Edit one item. Only its own lines change; an item without an id gets one. */
export function updateItem(text: string, key: string, patch: ItemPatch): { text: string; id: string } {
  const p = parseRoadmap(text);
  const it = findItem(p, key);
  const id = it.id ?? `r${p.nextId}`;
  const next: ItemFields = { ...current(it), ...patch } as ItemFields;
  if (patch.title !== undefined && !clean(patch.title)) throw new UserError("An item needs a title.");
  const changedFields = ["title", "description", "tags", "spec", "docs", "target"].some((k) => k in patch && JSON.stringify((patch as any)[k]) !== JSON.stringify((current(it) as any)[k]));
  const original = p.lines[it.line]!;

  if (!changedFields && it.id) {
    // Just the checkbox, or nothing at all: flip the one character.
    if (patch.done !== undefined && patch.done !== it.done) {
      const at = original.text.search(/\[[ xX]\]/);
      original.text = original.text.slice(0, at + 1) + (patch.done ? "x" : " ") + original.text.slice(at + 2);
    }
    return { ...nextEdit(p), id };
  }
  const line = { text: itemLine(next, id, it.indent, it.marker), eol: original.eol };
  const descChanged = patch.description !== undefined && patch.description !== it.description;
  if (descChanged) {
    const desc = descriptionLines(next.description, it.indent);
    const oldBlock = p.lines.slice(it.line, it.end);
    const lastEol = oldBlock[oldBlock.length - 1]!.eol;
    const rebuilt = [line, ...desc.map((t) => ({ text: t, eol: p.eol }))];
    rebuilt[rebuilt.length - 1]!.eol = lastEol;
    if (rebuilt.length > 1 && !lastEol && oldBlock.length === 1) rebuilt[0]!.eol = p.eol;
    p.lines.splice(it.line, it.end - it.line, ...rebuilt);
  } else {
    p.lines[it.line] = line;
  }
  return { ...nextEdit(p), id };
}

/** Insert whole lines after index `at`, keeping each line's own ending and a missing final newline missing. */
function insertBlock(lines: Line[], at: number, block: Line[], eol: string): void {
  if (!block.length) return;
  const add = block.map((l) => ({ ...l }));
  if (at === lines.length - 1 && lines.length && lines[at]!.eol === "") {
    lines[at]!.eol = eol;
    add[add.length - 1]!.eol = "";
  }
  lines.splice(at + 1, 0, ...add);
}

/** Move an item to a lane at a position (reordering is a move inside the same lane). */
export function moveItem(text: string, key: string, laneName: string, index?: number | null): { text: string; id: string } {
  let p = parseRoadmap(text);
  let it = findItem(p, key);
  const id = it.id ?? `r${p.nextId}`;
  if (!it.id) {
    // Its own minimal edit first (the id), then the move. The item line keeps its index.
    const line = it.line;
    p = parseRoadmap(updateItem(text, key, {}).text);
    it = p.lanes.flatMap((l) => l.items).find((x) => x.line === line)!;
  }
  const lane = findLane(p, laneName);
  const block = p.lines.slice(it.line, it.end).map((l) => ({ ...l }));
  const found = slotIn(p, lane, index, it);
  const slot = found.at;
  // Where the slot lands once the block is cut out.
  const cutLen = it.end - it.line;
  const target = slot >= it.end ? slot - cutLen : slot >= it.line ? it.line - 1 : slot;
  if (block[block.length - 1]!.eol === "") block[block.length - 1]!.eol = p.eol; // it was the file's last line
  removeRange(p.lines, it.line, it.end);
  insertBlock(p.lines, target, padded(p, target, block, found.pad), p.eol);
  return { text: joinLines(p.lines), id };
}

export function deleteItem(text: string, key: string): { text: string } {
  const p = parseRoadmap(text);
  const it = findItem(p, key);
  removeRange(p.lines, it.line, it.end);
  return nextEdit(p);
}

export function addLane(text: string, name: string): { text: string } {
  const n = clean(name);
  if (!n) throw new UserError("A lane needs a name.");
  const p = parseRoadmap(text);
  if (p.lanes.some((l) => l.name.toLowerCase() === n.toLowerCase())) throw new UserError(`There is already a lane "${n}".`);
  const lines = p.lines;
  const add = [`## ${n}`];
  if (!lines.length) {
    return { text: `## ${n}${p.eol}` };
  }
  const last = lines[lines.length - 1]!;
  const needsBlank = !isBlank(last.text);
  insertBlock(lines, lines.length - 1, [...(needsBlank ? [""] : []), ...add].map((t) => ({ text: t, eol: p.eol })), p.eol);
  return nextEdit(p);
}

export function renameLane(text: string, from: string, to: string): { text: string } {
  const n = clean(to);
  if (!n) throw new UserError("A lane needs a name.");
  const p = parseRoadmap(text);
  const lane = findLane(p, from);
  if (p.lanes.some((l) => l !== lane && l.name.toLowerCase() === n.toLowerCase())) throw new UserError(`There is already a lane "${n}".`);
  p.lines[lane.line]!.text = `## ${n}`;
  return nextEdit(p);
}

/** Only an empty lane can go: removing one with items would delete work. */
export function deleteLane(text: string, name: string): { text: string } {
  const p = parseRoadmap(text);
  const lane = findLane(p, name);
  if (lane.items.length) throw new UserError(`Lane "${lane.name}" still has ${lane.items.length} item${lane.items.length === 1 ? "" : "s"}. Move or delete them first.`);
  let to = lane.line + 1;
  if (to < lane.end && isBlank(p.lines[to]!.text)) to++;
  // The last lane also takes the blank line that separated it from the one above.
  const from = lane.end === p.lines.length && to >= p.lines.length && lane.line > 0 && isBlank(p.lines[lane.line - 1]!.text) ? lane.line - 1 : lane.line;
  removeRange(p.lines, from, to);
  return nextEdit(p);
}

/* -------------------------------------------------------------------------- */
/* Template                                                                   */
/* -------------------------------------------------------------------------- */

export function roadmapTemplate(project?: string): string {
  return `# ${project ? `${project} roadmap` : "Roadmap"}

<!--
This file is the roadmap. Edit it here or from the Roadmap view; both write the same text.

  ## Now            an H2 is a lane. Rename, add or reorder lanes freely.
  - [ ] Title {#r1} (spec: specs/003-chat) (docs: docs/architecture.md) (tag: infra) (target: 2026-Q4)
    Indented lines under an item are its description.
  - [x] A checked item is shipped.

(spec: ...) points at a specs/ folder: its tasks.md drives the progress bar.
(docs: ...) points at any file or folder. (tag: a, b) can list several. (target: ...) is a date,
a month (2026-11) or a quarter (2026-Q4). {#rN} is the item's id: the app adds it on first edit, keep it.
-->

## Now

## Next

## Later
`;
}
