/**
 * Pure logic behind the practice packs: the draft the editor holds, its validation (the same limits the daemon applies),
 * and the switches a workspace keeps inside its enabled packs. No React, no network.
 */
import type { Pack, PackInput, Switched } from "./data";

export const MAX_RULES = 8;
export const MAX_RULE_CHARS = 200;
export const PACK_ID = /^[a-z][a-z0-9-]{1,39}$/;
const SKILL_NAME = /^[A-Za-z0-9][\w.:-]{0,79}$/;

/** What the editor holds for one pack. Rules and skills are lists; blank rows are kept while typing and dropped on save. */
export interface PackDraft {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  rules: string[];
  skills: string[];
  checks: string[];
}

export const draftOf = (p: Pack): PackDraft => ({
  id: p.id,
  title: p.title,
  summary: p.summary,
  appliesTo: [...p.appliesTo],
  rules: [...p.rules],
  skills: [...(p.skills ?? [])],
  checks: [...(p.checks ?? [])],
});

/** A new custom pack: an id no pack has, one empty rule to start from. */
export function blankDraft(taken: string[]): PackDraft {
  let id = "my-pack";
  for (let n = 2; taken.includes(id); n++) id = `my-pack-${n}`;
  return { id, title: "", summary: "", appliesTo: ["any"], rules: [""], skills: [], checks: [] };
}

/** The first thing wrong with a draft, in words the operator can act on; null when it can be saved. */
export function draftProblem(d: PackDraft, o: { isNew: boolean; builtin: boolean }): string | null {
  if (o.isNew && !PACK_ID.test(d.id.trim())) return "A pack id is 2 to 40 lowercase letters, digits or dashes, starting with a letter.";
  const title = d.title.trim();
  if (!title || title.length > 60) return "A title is 1 to 60 characters.";
  if (d.summary.trim().length > 200) return "A summary is at most 200 characters.";
  if (!d.appliesTo.length) return "Pick at least one stack the pack applies to.";
  const rules = d.rules.map((r) => r.trim()).filter(Boolean);
  if (!rules.length) return "A pack has at least one rule.";
  if (rules.length > MAX_RULES) return `A pack has at most ${MAX_RULES} rules.`;
  const long = rules.find((r) => r.length > MAX_RULE_CHARS);
  if (long) return `A rule is at most ${MAX_RULE_CHARS} characters: "${long.slice(0, 40)}…" is too long.`;
  if (rules.some((r) => /<!--|-->/.test(r))) return "A rule cannot contain HTML comment markers.";
  const bad = d.skills.map((s) => s.trim()).find((s) => s && !SKILL_NAME.test(s));
  if (bad) return `"${bad}" is not a skill name: letters, digits, dots, colons or dashes.`;
  return null;
}

/** The body a save sends: trimmed, blank rows dropped. Built-in packs send their checks; a new pack sends its id. */
export function inputOf(d: PackDraft, o: { isNew: boolean; builtin: boolean }): PackInput {
  const skills = [...new Set(d.skills.map((s) => s.trim()).filter(Boolean))];
  return {
    ...(o.isNew ? { id: d.id.trim() } : {}),
    title: d.title.trim(),
    summary: d.summary.trim(),
    appliesTo: [...new Set(d.appliesTo)],
    rules: d.rules.map((r) => r.trim()).filter(Boolean),
    skills,
    ...(o.builtin ? { checks: d.checks } : {}),
  };
}

export const sameDraft = (a: PackDraft, b: PackDraft): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Skills named by a pack that are not among the installed ones. Empty when the list is not known yet. */
export function unknownSkills(skills: string[], installed: string[] | undefined): string[] {
  if (!installed) return [];
  return skills.filter((s) => !installed.includes(s));
}

/** The switch map with one pack's switches replaced. A pack with nothing switched off is left out of the map. */
export function withSwitched(off: Record<string, Switched>, packId: string, next: Switched): Record<string, Switched> {
  const out = { ...off };
  if (next.rules.length || next.checks.length) out[packId] = next;
  else delete out[packId];
  return out;
}

export const switchedOf = (off: Record<string, Switched>, packId: string): Switched => off[packId] ?? { rules: [], checks: [] };

/** A rule's text is its key: it is on in a workspace unless its pack has it switched off there. */
export const ruleOn = (off: Record<string, Switched>, packId: string, rule: string): boolean => !switchedOf(off, packId).rules.includes(rule);

/** A check is on unless the pack no longer carries it, or the workspace switched it off. */
export const checkOn = (pack: Pack, off: Record<string, Switched>, check: string): boolean => !!pack.checks?.includes(check) && !switchedOf(off, pack.id).checks.includes(check);

/** Toggles one entry of a switch list (a rule's text, or a check's id). */
export function toggled(list: string[], item: string, on: boolean): string[] {
  return on ? list.filter((x) => x !== item) : [...new Set([...list, item])];
}
