/**
 * Role colours. A role keeps one colour everywhere it appears (card, badge, strip, session tab), so the
 * eye learns "amber is the reviewer". Well-known roles are pinned; custom ones hash into the palette.
 */
export type Tone = "accent" | "violet" | "green" | "amber" | "blue" | "red" | "neutral";

const PINNED: Record<string, Tone> = {
  scout: "blue",
  architect: "violet",
  worker: "accent",
  frontend: "violet",
  backend: "green",
  tester: "green",
  reviewer: "amber",
  debugger: "red",
  security: "red",
  refactorer: "accent",
  docs: "blue",
  researcher: "blue",
};

const PALETTE: Tone[] = ["accent", "violet", "green", "amber", "blue", "red"];

/** FNV-1a: tiny, stable across runs and platforms (Math.random / Map order would not be). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function roleTone(role: string | null | undefined): Tone {
  if (!role) return "neutral";
  const key = role.trim().toLowerCase();
  return PINNED[key] ?? PALETTE[hashString(key) % PALETTE.length];
}

/** Static class names per tone (Tailwind needs to see them whole to generate them). */
export const toneClasses: Record<Tone, { text: string; bg: string; border: string; dot: string; ring: string }> = {
  accent: { text: "text-accent", bg: "bg-accent-soft", border: "border-accent/30", dot: "bg-accent", ring: "ring-accent/40" },
  violet: { text: "text-violet", bg: "bg-violet/10", border: "border-violet/30", dot: "bg-violet", ring: "ring-violet/40" },
  green: { text: "text-green", bg: "bg-green/10", border: "border-green/30", dot: "bg-green", ring: "ring-green/40" },
  amber: { text: "text-amber", bg: "bg-amber/10", border: "border-amber/30", dot: "bg-amber", ring: "ring-amber/40" },
  blue: { text: "text-blue", bg: "bg-blue/10", border: "border-blue/30", dot: "bg-blue", ring: "ring-blue/40" },
  red: { text: "text-red", bg: "bg-red/10", border: "border-red/30", dot: "bg-red", ring: "ring-red/40" },
  neutral: { text: "text-fg-muted", bg: "bg-raised", border: "border-line", dot: "bg-fg-faint", ring: "ring-line-strong" },
};
