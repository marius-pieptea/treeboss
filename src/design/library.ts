/**
 * The design system library: what New app and the Design view offer. A system is data (a name, a
 * description, a DESIGN.md and a tokens.css) and every one is editable, the shipped ones included.
 *
 * Storage: `<trb home>/design-systems.json` holds ALL systems in display order, never a workspace. The
 * shipped defaults are seeded once as ordinary entries (`builtinId` remembers which default an entry came
 * from, so it can be reset); a deleted default stays deleted until "Restore missing defaults". This is the
 * same model as templates (scaffold/recipes.ts).
 *
 *   { "version": 1, "seeded": ["neutral", ...], "systems": [ ... ] }
 */
import fs from "fs";
import path from "path";
import { home } from "../paths";
import { UserError } from "../util";
import { BUILTIN_SYSTEMS } from "./builtins";
import { parseTokens, type TokenSummary } from "./contract";

export interface DesignSystem {
  id: string;
  name: string;
  description: string;
  /** The DESIGN.md text. */
  design: string;
  /** The design/tokens.css text. */
  tokens: string;
  /** The shipped default this entry was seeded from, if any. */
  builtinId?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Ids that would collide with routes. */
const RESERVED = new Set(["reorder", "restore-defaults"]);
const MAX_DESIGN = 200_000;
const MAX_TOKENS = 100_000;

const short = (v: unknown, max: number): string =>
  String(v ?? "")
    .trim()
    .slice(0, max);

/** Check and normalise a system from the outside. */
export function validateSystem(raw: unknown): DesignSystem {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = String(r.id ?? "").trim().toLowerCase();
  if (!ID.test(id) || RESERVED.has(id)) throw new UserError("A design system id is lowercase letters, digits and dashes (at most 40 characters).");
  const name = String(r.name ?? "").trim();
  if (!name || name.length > 60) throw new UserError("A design system needs a name of at most 60 characters.");
  const design = typeof r.design === "string" ? r.design.replace(/\r\n/g, "\n") : "";
  if (!design.trim()) throw new UserError("A design system needs its DESIGN.md text.");
  if (design.length > MAX_DESIGN || design.includes("\0")) throw new UserError(`DESIGN.md is limited to ${MAX_DESIGN / 1000} KB of text.`);
  const tokens = typeof r.tokens === "string" ? r.tokens.replace(/\r\n/g, "\n") : "";
  if (tokens.length > MAX_TOKENS || tokens.includes("\0")) throw new UserError(`tokens.css is limited to ${MAX_TOKENS / 1000} KB of text.`);
  const out: DesignSystem = { id, name, description: short(r.description, 300), design: design.endsWith("\n") ? design : `${design}\n`, tokens: tokens && !tokens.endsWith("\n") ? `${tokens}\n` : tokens };
  const b = typeof r.builtinId === "string" ? r.builtinId.trim() : "";
  if (b && BUILTIN_SYSTEMS.some((d) => d.id === b)) out.builtinId = b;
  return out;
}

/** A free id derived from a name: "My Brand" → "my-brand", then "my-brand-2" … */
export function idFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "system";
  let id = RESERVED.has(base) ? `${base}-1` : base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/* ------------------------------------------------------------------ the store */

interface Store {
  version: 1;
  seeded: string[];
  systems: DesignSystem[];
}

const file = (): string => path.join(home(), "design-systems.json");
const asDefault = (d: (typeof BUILTIN_SYSTEMS)[number]): DesignSystem => ({ ...d, builtinId: d.id });

function parse(text: string): Store | null {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.systems)) return null;
  const systems: DesignSystem[] = [];
  for (const x of v.systems) {
    try {
      const s = validateSystem(x);
      if (!systems.some((o) => o.id === s.id)) systems.push(s);
    } catch {
      // a hand-edited entry that no longer validates is skipped, not fatal
    }
  }
  const seeded = Array.isArray(v.seeded) ? v.seeded.filter((s: unknown) => typeof s === "string") : [];
  return { version: 1, seeded, systems };
}

function write(s: Store): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, file());
}

/** Read the store, seeding any default that has never been seeded (once). Persists only when something changed. */
function load(): Store {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file(), "utf-8");
  } catch {}
  const parsed = text !== null ? parse(text) : null;
  if (text !== null && !parsed) {
    // Hand-edited into something unreadable: keep a copy before it is replaced by the defaults.
    try {
      fs.copyFileSync(file(), `${file()}.bak`);
    } catch {}
  }
  const s = parsed ?? { version: 1 as const, seeded: [], systems: [] };
  const fresh = BUILTIN_SYSTEMS.filter((d) => !s.seeded.includes(d.id));
  if (fresh.length) {
    const taken = new Set(s.systems.map((r) => r.id));
    s.systems = [...s.systems, ...fresh.filter((d) => !taken.has(d.id)).map(asDefault)];
    s.seeded = [...s.seeded, ...fresh.map((d) => d.id)];
    write(s);
  }
  return s;
}

export function listSystems(): DesignSystem[] {
  return load().systems;
}

export function getSystem(id: string): DesignSystem {
  const s = listSystems().find((x) => x.id === id);
  if (!s) throw new UserError(`No design system "${id}".`);
  return s;
}

/** A system as the UI shows it: swatches, and whether it is a (changed) default. */
export interface SystemView extends DesignSystem {
  isDefault: boolean;
  modified: boolean;
  summary: TokenSummary;
}

const sameContent = (a: DesignSystem, b: DesignSystem): boolean => a.name === b.name && a.description === b.description && a.design === b.design && a.tokens === b.tokens;

export function listSystemViews(): { systems: SystemView[]; missingDefaults: Array<{ id: string; name: string }> } {
  const systems = load().systems;
  const views = systems.map((s) => {
    const d = BUILTIN_SYSTEMS.find((x) => x.id === s.builtinId);
    return { ...s, isDefault: !!d, modified: d ? !sameContent(s, d) || s.id !== d.id : false, summary: parseTokens(s.tokens) };
  });
  const have = new Set(systems.map((s) => s.builtinId).filter(Boolean));
  return { systems: views, missingDefaults: BUILTIN_SYSTEMS.filter((d) => !have.has(d.id)).map((d) => ({ id: d.id, name: d.name })) };
}

/** Create or replace by id. A replaced entry keeps its link to the default it came from. */
export function saveSystem(raw: unknown): DesignSystem {
  const sys = validateSystem(raw);
  const s = load();
  const i = s.systems.findIndex((x) => x.id === sys.id);
  if (i >= 0) {
    const kept = s.systems[i]!.builtinId;
    if (kept) sys.builtinId = kept;
    else delete sys.builtinId;
    s.systems[i] = sys;
  } else {
    delete sys.builtinId; // only seeding and restoring link an entry to a default
    s.systems.push(sys);
  }
  write(s);
  return sys;
}

export function deleteSystem(id: string): void {
  const s = load();
  if (!s.systems.some((x) => x.id === id)) throw new UserError(`No design system "${id}".`);
  s.systems = s.systems.filter((x) => x.id !== id);
  write(s);
}

/** Put a seeded entry back to what shipped (same position). */
export function resetSystem(id: string): DesignSystem {
  const s = load();
  const i = s.systems.findIndex((x) => x.id === id);
  if (i < 0) throw new UserError(`No design system "${id}".`);
  const d = BUILTIN_SYSTEMS.find((x) => x.id === s.systems[i]!.builtinId);
  if (!d) throw new UserError("Only design systems that came with trb have a default to go back to.");
  if (s.systems.some((x, j) => j !== i && x.id === d.id)) throw new UserError(`Another design system already uses the id "${d.id}"; rename or delete it first.`);
  s.systems[i] = asDefault(d);
  write(s);
  return s.systems[i]!;
}

/** Add back the defaults that are missing (deleted, or renamed away from). Returns what was added. */
export function restoreDefaults(): DesignSystem[] {
  const s = load();
  const have = new Set(s.systems.map((r) => r.builtinId).filter(Boolean));
  const added: DesignSystem[] = [];
  for (const d of BUILTIN_SYSTEMS) {
    if (have.has(d.id)) continue;
    const r = asDefault(d);
    if (s.systems.some((x) => x.id === r.id)) r.id = idFor(`${d.id}-default`, s.systems.map((x) => x.id));
    s.systems.push(r);
    added.push(r);
  }
  if (added.length) write(s);
  return added;
}

/** Set the display order. Unknown ids are ignored; systems not named keep their order at the end. */
export function reorderSystems(ids: string[]): DesignSystem[] {
  const s = load();
  const by = new Map(s.systems.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: DesignSystem[] = [];
  for (const id of ids) {
    const r = by.get(id);
    if (r && !seen.has(id)) {
      out.push(r);
      seen.add(id);
    }
  }
  for (const r of s.systems) if (!seen.has(r.id)) out.push(r);
  s.systems = out;
  write(s);
  return out;
}
