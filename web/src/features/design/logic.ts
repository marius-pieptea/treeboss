/**
 * Pure logic behind the Design tab, the design system library page and the New app picker: the shapes the
 * daemon sends, the session kinds, the library form. No React, no network.
 */

export interface ColorToken {
  name: string;
  light: string;
  dark: string | null;
}

export interface TokenSummary {
  colors: ColorToken[];
  fonts: Array<{ name: string; value: string }>;
  radii: Array<{ name: string; value: string }>;
  count: number;
  missing: string[];
}

export interface DesignState {
  exists: boolean;
  path: string;
  rev: string;
  title: string | null;
  text: string | null;
  tokens: { path: string; exists: boolean; summary: TokenSummary | null };
  agentRule: boolean;
  matches: string | null;
  directions: { path: string; exists: boolean; html: string | null; tooLarge: boolean };
}

export interface DesignSystem {
  id: string;
  name: string;
  description: string;
  design: string;
  tokens: string;
  builtinId?: string;
}

export interface SystemView extends DesignSystem {
  isDefault: boolean;
  modified: boolean;
  summary: TokenSummary;
}

export interface SystemList {
  systems: SystemView[];
  missingDefaults: Array<{ id: string; name: string }>;
}

export type DesignKind = "brief" | "url" | "codebase" | "wire" | "review";

/** Kinds that can brainstorm first (questions and directions before any file is written). */
export const BRAINSTORM_KINDS: DesignKind[] = ["brief", "url"];

/** What the input box is for, by kind; null when the kind takes none (or only optional notes). */
export function inputFor(kind: DesignKind): { label: string; placeholder: string; required: boolean; multiline: boolean } {
  switch (kind) {
    case "brief":
      return { label: "The brief", placeholder: "A booking app for independent yoga studios. Calm, warm and premium, never clinical. Most use is on phones between classes.", required: true, multiline: true };
    case "url":
      return { label: "Reference URL", placeholder: "https://…", required: true, multiline: false };
    case "codebase":
      return { label: "Notes (optional)", placeholder: "Only look at apps/web", required: false, multiline: false };
    case "wire":
      return { label: "Notes (optional)", placeholder: "Leave the marketing pages alone", required: false, multiline: false };
    case "review":
      return { label: "Focus (optional)", placeholder: "The checkout flow", required: false, multiline: false };
  }
}

export function inputProblem(kind: DesignKind, input: string): string | null {
  const v = input.trim();
  if (kind === "brief" && !v) return "Describe the product and how it should feel.";
  if (kind === "url" && !/^https?:\/\/\S+$/i.test(v)) return "Give an http(s) URL.";
  return null;
}

/** The color tokens worth showing as a strip on a card, in contract order first. */
export function stripColors(s: TokenSummary, n = 6): ColorToken[] {
  const want = ["--color-bg", "--color-surface", "--color-text", "--color-primary", "--color-accent", "--color-border"];
  const picked = want.map((w) => s.colors.find((c) => c.name === w)).filter((c): c is ColorToken => !!c);
  for (const c of s.colors) if (picked.length < n && !picked.includes(c)) picked.push(c);
  return picked.slice(0, n);
}

/** The first family of a font stack, for a sample line: `"Inter", system-ui` → Inter. */
export const firstFamily = (stack: string): string => stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "");

/** Short label for a token name: --color-text-muted → text-muted. */
export const tokenLabel = (name: string): string => name.replace(/^--(color|font|radius)-/, "");

/* -------------------------------------------------------------------------- */
/* The library form                                                           */
/* -------------------------------------------------------------------------- */

export interface SystemForm {
  id: string;
  isNew: boolean;
  name: string;
  description: string;
  design: string;
  tokens: string;
  builtinId?: string;
}

export const toForm = (s: DesignSystem): SystemForm => ({ id: s.id, isNew: false, name: s.name, description: s.description, design: s.design, tokens: s.tokens, builtinId: s.builtinId });

export const toSystem = (f: SystemForm): DesignSystem => ({ id: f.id, name: f.name.trim(), description: f.description.trim(), design: f.design, tokens: f.tokens });

export const sameForm = (a: SystemForm, b: SystemForm): boolean => a.id === b.id && a.name === b.name && a.description === b.description && a.design === b.design && a.tokens === b.tokens;

export function slug(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 34) || "system";
  let id = base === "reorder" || base === "restore-defaults" ? `${base}-1` : base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

const BLANK_DESIGN = (name: string) => `# ${name} design system

> One line: what this system is for and how it feels.

This file is the design contract for this project: every agent reads it before UI work. The values live in \`design/tokens.css\`.

## Personality

## Color

## Typography

## Space and layout

## Shape and elevation

## Motion

## Components

## Do

## Don't

## Accessibility
`;

export function blankForm(taken: string[]): SystemForm {
  return { id: slug("new-system", taken), isNew: true, name: "New system", description: "", design: BLANK_DESIGN("New system"), tokens: ":root {\n  --color-bg: #ffffff;\n  --color-text: #111111;\n  --color-primary: #2563eb;\n}\n" };
}

export function duplicateForm(f: SystemForm, taken: string[]): SystemForm {
  const name = `${f.name} copy`.slice(0, 60);
  return { ...f, id: slug(name, taken), isNew: true, name, builtinId: undefined };
}

export function formProblem(f: SystemForm): string | null {
  if (!f.name.trim()) return "Give it a name.";
  if (!f.design.trim()) return "DESIGN.md cannot be empty.";
  return null;
}

export function moveId(ids: string[], id: string, by: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Which design system New app suggests for a template: none for APIs and CLIs, else the last one used. */
export function defaultSystemFor(tag: string, last: string | null, ids: string[]): string {
  if (/^(api|cli|lib|library|server|worker)$/i.test(tag.trim())) return "";
  if (last !== null && (last === "" || ids.includes(last))) return last;
  return ids[0] ?? "";
}
