/**
 * Which skills a thread used. Nothing extra is recorded: every tool call is already a row in `events`, so this
 * reads them back. An engine with native skills calls `Skill({"skill":"name"})`; one without is told to read
 * `<skill dir>/SKILL.md`, which shows up as a Read of that file.
 */
import { db } from "../db";
import type { LineMeta } from "../engines/classify";

export interface SkillUse {
  skill: string;
  count: number;
  /** The first turn that used it (null when the call was not tied to a turn). */
  firstTurnId: string | null;
  /** Calls per session, so a hydra shows which head used what. */
  bySession: Record<string, number>;
}

const SKILL_ARG = /"skill"\s*:\s*"([^"]+)"/;
const SKILL_MD = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/i;

/** The skill a tool call invoked, or null. `known` keeps an ordinary Read of some other SKILL.md from counting. */
export function skillOf(meta: Pick<LineMeta, "kind" | "name" | "arg"> | null | undefined, known: ReadonlySet<string>): string | null {
  if (!meta || meta.kind !== "tool" || !meta.arg) return null;
  let name: string | null = null;
  if (meta.name === "Skill") {
    // Plugin skills are `plugin:skill`; the library knows the bare name.
    const full = SKILL_ARG.exec(meta.arg)?.[1] ?? (meta.arg.startsWith("{") ? null : meta.arg.trim());
    name = full ? (known.has(full) ? full : full.split(":").pop() ?? full) : null;
  } else if (/^(Read|read|view_file)$/.test(meta.name ?? "")) {
    name = SKILL_MD.exec(meta.arg.trim())?.[1] ?? null;
    if (name && !known.has(name)) return null;
  }
  return name || null;
}

/** Skills used across the given sessions (a lead and its subagents), most used first. */
export function skillsUsed(sessionIds: string[]): SkillUse[] {
  if (!sessionIds.length) return [];
  const marks = sessionIds.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT session_id, turn_id, data FROM events WHERE kind = 'tool' AND session_id IN (${marks}) AND (text LIKE '%Skill(%' OR text LIKE '%SKILL.md%' OR text LIKE '%SKILL.MD%') ORDER BY id`)
    .all(...sessionIds) as Array<{ session_id: string; turn_id: string | null; data: string | null }>;
  const known = new Set((db().prepare("SELECT name FROM skills").all() as Array<{ name: string }>).map((r) => r.name));
  const out = new Map<string, SkillUse>();
  for (const r of rows) {
    let meta: LineMeta | null = null;
    try {
      meta = r.data ? JSON.parse(r.data) : null;
    } catch {}
    const skill = skillOf(meta, known);
    if (!skill) continue;
    const u = out.get(skill) ?? { skill, count: 0, firstTurnId: r.turn_id, bySession: {} };
    u.count++;
    u.bySession[r.session_id] = (u.bySession[r.session_id] ?? 0) + 1;
    out.set(skill, u);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}
