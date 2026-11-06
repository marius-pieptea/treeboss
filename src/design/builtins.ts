/**
 * The design systems that ship with trb: four original, brand-neutral starting points. Each is built from one
 * small spec so its DESIGN.md and tokens.css cannot disagree. Once seeded into the library they are plain
 * text the operator edits like any other system.
 */
import { contractMarkdown, DESIGN_FILE, TOKENS_FILE } from "./contract";

type Role = "bg" | "surface" | "surface-2" | "border" | "text" | "text-muted" | "primary" | "primary-fg" | "accent" | "success" | "warning" | "danger" | "focus";
type Palette = Record<Role, string>;

interface SystemSpec {
  id: string;
  name: string;
  description: string;
  personality: string;
  keywords: string[];
  fonts: { sans: string; display: string; mono: string; load: string };
  light: Palette;
  dark: Palette;
  /** --text-xs … --text-4xl, in rem. */
  scale: [number, number, number, number, number, number, number, number];
  leading: { tight: number; normal: number };
  radius: { sm: string; md: string; lg: string };
  shadow: { light: [string, string, string]; dark: [string, string, string] };
  motion: { fast: string; base: string; ease: string };
  color: string[];
  type: string[];
  layout: string[];
  shape: string[];
  motionRules: string[];
  components: string[];
  dos: string[];
  donts: string[];
}

const ROLE_USE: Record<Role, string> = {
  bg: "Page background",
  surface: "Cards, panels, popovers",
  "surface-2": "Subtle fills: hover rows, inputs, code blocks",
  border: "Dividers and control outlines",
  text: "Body text and headings",
  "text-muted": "Secondary text, captions, placeholders",
  primary: "The one main action per view, links, selected state",
  "primary-fg": "Text and icons on primary",
  accent: "Highlights, badges, charts; never a second primary button",
  success: "Positive status",
  warning: "Needs attention",
  danger: "Destructive actions and errors",
  focus: "Focus ring",
};

const ROLES = Object.keys(ROLE_USE) as Role[];
const SPACE: Array<[string, number]> = [["1", 4], ["2", 8], ["3", 12], ["4", 16], ["6", 24], ["8", 32], ["12", 48], ["16", 64]];
const SCALE_NAMES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"];
const px = (rem: number): string => `${Math.round(rem * 16 * 10) / 10}px`;

function colorVars(p: Palette, shadow: [string, string, string], indent: string): string {
  const lines = ROLES.map((r) => `${indent}--color-${r}: ${p[r]};`);
  lines.push(`${indent}--shadow-sm: ${shadow[0]};`, `${indent}--shadow-md: ${shadow[1]};`, `${indent}--shadow-lg: ${shadow[2]};`);
  return lines.join("\n");
}

export function tokensCss(s: SystemSpec): string {
  const scale = s.scale.map((v, i) => `  --text-${SCALE_NAMES[i]}: ${v}rem;`).join("\n");
  const space = SPACE.map(([k, v]) => `  --space-${k}: ${v / 16}rem;`).join("\n");
  return `/*
 * ${s.name}: design tokens. Read ${DESIGN_FILE} for how to use them.
 * The variable names are the trb token contract, shared by every design system, so systems can be swapped
 * without touching components. Add tokens when a screen needs one; do not rename or remove these.
 * Fonts: ${s.fonts.load}
 */
:root {
  color-scheme: light dark;

${colorVars(s.light, s.shadow.light, "  ")}

  --font-sans: ${s.fonts.sans};
  --font-display: ${s.fonts.display};
  --font-mono: ${s.fonts.mono};
${scale}
  --leading-tight: ${s.leading.tight};
  --leading-normal: ${s.leading.normal};

${space}

  --radius-sm: ${s.radius.sm};
  --radius-md: ${s.radius.md};
  --radius-lg: ${s.radius.lg};
  --radius-full: 9999px;

  --duration-fast: ${s.motion.fast};
  --duration-base: ${s.motion.base};
  --ease-out: ${s.motion.ease};
}

/* Dark: follows the system unless the page forces light with data-theme="light". */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${colorVars(s.dark, s.shadow.dark, "    ")}
  }
}

/* Forced dark, whatever the system says. */
:root[data-theme="dark"] {
${colorVars(s.dark, s.shadow.dark, "  ")}
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-base: 0ms;
  }
}
`;
}

const bullets = (xs: string[]): string => xs.map((x) => `- ${x}`).join("\n");

export function designMd(s: SystemSpec): string {
  const table = ROLES.map((r) => `| \`--color-${r}\` | \`${s.light[r]}\` | \`${s.dark[r]}\` | ${ROLE_USE[r]} |`).join("\n");
  const scale = s.scale.map((v, i) => `\`${SCALE_NAMES[i]}\` ${px(v)}`).join(" · ");
  return `# ${s.name} design system

> ${s.description}

This file is the design contract for this project: every agent reads it before UI work. The values live in \`${TOKENS_FILE}\`. Components use the tokens (\`var(--color-primary)\`, or the styling setup's mapping of them, such as a Tailwind theme), never raw hex values, pixel sizes or font names.

## Personality

${s.personality}

Keywords: ${s.keywords.join(", ")}.

## Color

Both themes are defined. \`prefers-color-scheme\` picks one; \`data-theme="light"\` or \`"dark"\` on \`<html>\` forces one.

| Token | Light | Dark | Use |
|---|---|---|---|
${table}

${bullets(s.color)}

## Typography

- Families: \`--font-sans\` for body and UI, \`--font-display\` for headings, \`--font-mono\` for code and tabular figures.
- Loading: ${s.fonts.load}
- Scale: ${scale}. Line height \`--leading-tight\` (${s.leading.tight}) for headings, \`--leading-normal\` (${s.leading.normal}) for text.
${bullets(s.type)}

## Space and layout

- A 4px grid: \`--space-1\` (4px), \`-2\` (8), \`-3\` (12), \`-4\` (16), \`-6\` (24), \`-8\` (32), \`-12\` (48), \`-16\` (64). Every margin, padding and gap is one of these.
${bullets(s.layout)}

## Shape and elevation

- Radius: \`--radius-sm\` ${s.radius.sm} (chips, inputs), \`--radius-md\` ${s.radius.md} (buttons, cards), \`--radius-lg\` ${s.radius.lg} (dialogs, large panels), \`--radius-full\` for pills and avatars.
- Shadows: \`--shadow-sm\` (raised controls), \`--shadow-md\` (popovers, menus), \`--shadow-lg\` (dialogs).
${bullets(s.shape)}

## Motion

- \`--duration-fast\` ${s.motion.fast} for hover and press, \`--duration-base\` ${s.motion.base} for panels and dialogs, always with \`--ease-out\`. Both drop to 0 under \`prefers-reduced-motion\`.
${bullets(s.motionRules)}

## Components

${bullets(s.components)}

## Do

${bullets(s.dos)}

## Don't

${bullets(s.donts)}

## Accessibility

- Text contrast at least 4.5:1 (3:1 for text at \`--text-xl\` and up) in both themes. Check new color pairs before using them.
- Every interactive element shows a 2px \`--color-focus\` ring with a 2px offset on keyboard focus.
- Hit targets are at least 40px tall on touch layouts. Never convey state by color alone: pair it with an icon or text.

## Token contract

${contractMarkdown()}

A screen that needs a value the tokens do not have adds a token here and in \`${TOKENS_FILE}\` first.
`;
}

const SPECS: SystemSpec[] = [
  {
    id: "neutral",
    name: "Neutral",
    description: "A calm, precise product UI: cool grays, one indigo accent, compact density. Good for dashboards, SaaS and internal tools.",
    personality: "Quiet and exact. The interface steps back so the user's data is the loudest thing on screen. Hierarchy comes from weight, size and space, not from color; color is reserved for meaning (action, status).",
    keywords: ["precise", "calm", "dense", "trustworthy"],
    fonts: { sans: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`, display: `"Inter", ui-sans-serif, system-ui, sans-serif`, mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`, load: "Inter (400, 500, 600, 700) and JetBrains Mono (400, 500) from Google Fonts or the framework's font loader (next/font, @fontsource)." },
    light: { bg: "#ffffff", surface: "#ffffff", "surface-2": "#f4f6f9", border: "#e3e7ee", text: "#0f172a", "text-muted": "#5b6577", primary: "#4f46e5", "primary-fg": "#ffffff", accent: "#0284c7", success: "#15803d", warning: "#b45309", danger: "#dc2626", focus: "#6366f1" },
    dark: { bg: "#0b0f17", surface: "#121826", "surface-2": "#1a2232", border: "#273246", text: "#e6e9ef", "text-muted": "#97a1b3", primary: "#8b93ff", "primary-fg": "#0b0f17", accent: "#38bdf8", success: "#4ade80", warning: "#fbbf24", danger: "#f87171", focus: "#a5b4fc" },
    scale: [0.75, 0.875, 0.9375, 1.0625, 1.25, 1.5, 1.875, 2.25],
    leading: { tight: 1.2, normal: 1.55 },
    radius: { sm: "4px", md: "6px", lg: "10px" },
    shadow: { light: ["0 1px 2px rgb(15 23 42 / 0.06)", "0 4px 12px rgb(15 23 42 / 0.08)", "0 16px 40px rgb(15 23 42 / 0.14)"], dark: ["0 1px 2px rgb(0 0 0 / 0.4)", "0 4px 12px rgb(0 0 0 / 0.45)", "0 16px 40px rgb(0 0 0 / 0.55)"] },
    motion: { fast: "120ms", base: "200ms", ease: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    color: ["Surfaces separate by a 1px `--color-border`, not by shadow; shadows are for things that float.", "One `--color-primary` button per view. Secondary actions are outlined or ghost buttons in `--color-text`.", "Status colors appear as text, icons or a 10-15% tint behind text, never as large fills."],
    type: ["Body text is `--text-base` (15px). Dense tables may drop to `--text-sm`; nothing below `--text-xs`.", "Headings use weight 600 and `--leading-tight`; a page has one `--text-2xl` title at most.", "Numbers in tables use `--font-mono` or `font-variant-numeric: tabular-nums`."],
    layout: ["Content max width 1200px for app screens, 720px for reading. Sidebars 240-280px.", "Inside a card `--space-4`; between cards `--space-4` to `--space-6`; between page sections `--space-12`.", "Align to a 12-column grid on wide screens; one column under 640px."],
    shape: ["Cards are `--color-surface` with a border and no shadow at rest; `--shadow-sm` only on hover when the whole card is clickable."],
    motionRules: ["Animate opacity and transform only. Nothing bounces."],
    components: ["Buttons: 32px tall (36px on touch), `--text-sm` weight 500, `--radius-md`, horizontal padding `--space-3`. Primary is filled; secondary has a border; ghost has neither until hover.", "Inputs: 32px tall, `--color-surface` fill, 1px border that turns `--color-primary` on focus with the focus ring.", "Tables: header row in `--text-xs` uppercase `--color-text-muted`; rows separated by borders; hover row `--color-surface-2`.", "Empty states: an icon, one sentence on what goes here, one primary action."],
    dos: ["Use space and weight to build hierarchy before reaching for color.", "Keep labels short and sentence case.", "Show loading with skeletons the shape of the content."],
    donts: ["Gradients, glassmorphism or decorative illustrations in the app shell.", "More than one accent color on a screen.", "Centered body text longer than two lines."],
  },
  {
    id: "editorial",
    name: "Editorial",
    description: "Warm paper, ink and a terracotta accent, with a serif display face. For content-led sites, blogs, portfolios and marketing pages.",
    personality: "Considered and literate, like a well-set magazine. Generous margins, a confident serif for headings and long, comfortable lines of text. It reads first and decorates second.",
    keywords: ["warm", "literate", "spacious", "crafted"],
    fonts: { sans: `"Source Sans 3", ui-sans-serif, system-ui, sans-serif`, display: `"Fraunces", "Iowan Old Style", Georgia, serif`, mono: `"IBM Plex Mono", ui-monospace, Menlo, monospace`, load: "Fraunces (variable, opsz 9-144, 400-700), Source Sans 3 (400, 600) and IBM Plex Mono (400) from Google Fonts or the framework's font loader." },
    light: { bg: "#fbf8f3", surface: "#ffffff", "surface-2": "#f3eee6", border: "#e4dccf", text: "#1c1917", "text-muted": "#6b625a", primary: "#a1401c", "primary-fg": "#fffaf5", accent: "#1e3a8a", success: "#3f6212", warning: "#a16207", danger: "#b91c1c", focus: "#c2410c" },
    dark: { bg: "#151311", surface: "#1d1a17", "surface-2": "#27231f", border: "#3a342e", text: "#ede6dc", "text-muted": "#a89f94", primary: "#f0a27a", "primary-fg": "#1c1209", accent: "#9cb8f5", success: "#a3c76d", warning: "#f2b65a", danger: "#f19494", focus: "#f59e6b" },
    scale: [0.8125, 0.9375, 1.0625, 1.25, 1.5, 2, 2.75, 3.5],
    leading: { tight: 1.1, normal: 1.65 },
    radius: { sm: "2px", md: "4px", lg: "6px" },
    shadow: { light: ["0 1px 0 rgb(28 25 23 / 0.06)", "0 6px 18px rgb(28 25 23 / 0.08)", "0 18px 48px rgb(28 25 23 / 0.12)"], dark: ["0 1px 0 rgb(0 0 0 / 0.4)", "0 6px 18px rgb(0 0 0 / 0.45)", "0 18px 48px rgb(0 0 0 / 0.55)"] },
    motion: { fast: "150ms", base: "260ms", ease: "cubic-bezier(0.22, 1, 0.36, 1)" },
    color: ["The page is `--color-bg` paper; `--color-surface` white is for raised things only (cards, forms).", "Terracotta `--color-primary` marks links and the main call to action. Ink blue `--color-accent` is for small highlights: pull quotes, tags, a single chart series.", "Rules (horizontal lines) in `--color-border` divide sections, in the manner of print."],
    type: ["Headings in `--font-display`, weight 500-600, `--leading-tight`, with slight negative tracking (-0.01em) from `--text-2xl` up.", "Body copy is `--text-base` (17px) with `--leading-normal` and a measure of 60-72 characters.", "Small caps or `--text-xs` uppercase with 0.08em tracking for kickers and labels."],
    layout: ["Reading column 680px; wide figures may break out to 1040px. Page gutters at least `--space-6`, `--space-12` on desktop.", "Vertical rhythm: paragraphs `--space-4` apart, sections `--space-16`.", "Asymmetric layouts are welcome: a narrow label column beside a wide text column."],
    shape: ["Corners are nearly square. Cards lean on borders and space, with `--shadow-sm` at most."],
    motionRules: ["Reveal content with a short fade and 8px rise as it enters; never animate text while it is being read."],
    components: ["Buttons: text in `--font-sans` weight 600, `--radius-sm`, 40px tall. Primary filled terracotta; secondary is an underlined text link with an arrow.", "Links: `--color-primary`, underlined with 1px offset 3px; underline thickens on hover.", "Blockquotes: `--font-display` italic at `--text-xl`, a 2px `--color-primary` rule on the left.", "Images: full-bleed or in the reading column, with a `--text-sm` `--color-text-muted` caption."],
    dos: ["Let whitespace do the work; resist filling the margins.", "Pair one large display heading with plenty of air.", "Use real typographic quotes, dashes and ellipses."],
    donts: ["Rounded, bubbly components or pill buttons.", "Pure white backgrounds for whole pages, or pure black text.", "More than two type families on a page."],
  },
  {
    id: "bold",
    name: "Bold",
    description: "High contrast black and white with an acid-lime accent, square corners and hard shadows. For launches, developer tools and products that want to be noticed.",
    personality: "Loud, direct and a little brutal. Thick borders, big type and a single electric accent. Every element looks deliberate; nothing is soft or vague.",
    keywords: ["confident", "graphic", "high-contrast", "direct"],
    fonts: { sans: `"Space Grotesk", ui-sans-serif, system-ui, sans-serif`, display: `"Space Grotesk", ui-sans-serif, system-ui, sans-serif`, mono: `"Space Mono", ui-monospace, Menlo, monospace`, load: "Space Grotesk (400, 500, 700) and Space Mono (400, 700) from Google Fonts or the framework's font loader." },
    light: { bg: "#ffffff", surface: "#ffffff", "surface-2": "#f2f2ec", border: "#0a0a0a", text: "#0a0a0a", "text-muted": "#4a4a4a", primary: "#0a0a0a", "primary-fg": "#ffffff", accent: "#d4ff3a", success: "#15803d", warning: "#b45309", danger: "#e11d48", focus: "#2563eb" },
    dark: { bg: "#0a0a0a", surface: "#121212", "surface-2": "#1c1c1c", border: "#f5f5f5", text: "#f5f5f5", "text-muted": "#b0b0b0", primary: "#d4ff3a", "primary-fg": "#0a0a0a", accent: "#d4ff3a", success: "#4ade80", warning: "#fbbf24", danger: "#fb7185", focus: "#60a5fa" },
    scale: [0.75, 0.875, 1, 1.25, 1.5, 2, 3, 4.5],
    leading: { tight: 1.0, normal: 1.5 },
    radius: { sm: "0px", md: "0px", lg: "0px" },
    shadow: { light: ["2px 2px 0 0 #0a0a0a", "4px 4px 0 0 #0a0a0a", "8px 8px 0 0 #0a0a0a"], dark: ["2px 2px 0 0 #f5f5f5", "4px 4px 0 0 #f5f5f5", "8px 8px 0 0 #d4ff3a"] },
    motion: { fast: "80ms", base: "160ms", ease: "cubic-bezier(0.3, 0, 0, 1)" },
    color: ["Borders are 2px `--color-border` (solid black in light, white in dark): they define every surface.", "Lime `--color-accent` is a highlighter: a marker behind a word, a badge, a hover fill. Text on lime is always `#0a0a0a`.", "Never lime text on white: it fails contrast."],
    type: ["Display headings at `--text-3xl`-`--text-4xl`, weight 700, `--leading-tight`, tracking -0.03em, often uppercase for short lines.", "Labels, metadata and numbers in `--font-mono` `--text-sm`.", "Body `--text-base` weight 400; keep paragraphs short."],
    layout: ["Content max width 1280px; strong grid with visible borders between cells.", "Sections separated by a full-width 2px rule and `--space-16`.", "Overlap is allowed: a card offset over a border, a sticker-style badge on a corner."],
    shape: ["Everything is square (`--radius-*` are 0) except `--radius-full` for status dots.", "Hard offset shadows (`--shadow-sm`…`--shadow-lg`) replace blur; pressing a button removes its shadow and shifts it by the same offset."],
    motionRules: ["Snappy, mechanical: translate on press, no fades longer than `--duration-base`."],
    components: ["Buttons: 44px tall, 2px border, `--shadow-sm`, `--font-mono` uppercase `--text-sm` weight 700. Primary filled `--color-primary`; on hover the fill turns `--color-accent` with black text.", "Inputs: 2px border, square, 44px tall; focus adds `--shadow-sm` and the focus ring.", "Cards: `--color-surface`, 2px border, `--shadow-md`; a clickable card lifts to `--shadow-lg`.", "Tags: `--font-mono` `--text-xs` uppercase on `--color-accent`."],
    dos: ["Commit to the contrast: black, white, one lime.", "Make headings large enough to be a layout element.", "Show structure with borders and grids."],
    donts: ["Soft shadows, blur or gradients.", "Rounded corners or pastel tints.", "Lime used for body text or large backgrounds in light mode."],
  },
  {
    id: "soft",
    name: "Soft",
    description: "Rounded, friendly and airy: lavender primary, teal accent, generous radii and soft shadows. For consumer apps, onboarding flows and anything that should feel approachable.",
    personality: "Warm, encouraging and easy. Rounded shapes, soft tinted surfaces and friendly copy make the product feel safe to explore. Delight is welcome in small doses.",
    keywords: ["friendly", "approachable", "playful", "light"],
    fonts: { sans: `"Nunito", ui-rounded, ui-sans-serif, system-ui, sans-serif`, display: `"Nunito", ui-rounded, ui-sans-serif, system-ui, sans-serif`, mono: `"Fira Code", ui-monospace, Menlo, monospace`, load: "Nunito (400, 600, 700, 800) and Fira Code (400) from Google Fonts or the framework's font loader." },
    light: { bg: "#fbfaff", surface: "#ffffff", "surface-2": "#f3effc", border: "#e7e1f5", text: "#28233d", "text-muted": "#6c6684", primary: "#6d4dff", "primary-fg": "#ffffff", accent: "#0d9488", success: "#16a34a", warning: "#d97706", danger: "#e11d48", focus: "#a78bfa" },
    dark: { bg: "#15131f", surface: "#1d1a2b", "surface-2": "#262238", border: "#352f4c", text: "#ece9f7", "text-muted": "#a39dbe", primary: "#a68bff", "primary-fg": "#15131f", accent: "#2dd4bf", success: "#4ade80", warning: "#fbbf24", danger: "#fb7185", focus: "#c4b5fd" },
    scale: [0.75, 0.875, 1, 1.125, 1.375, 1.75, 2.25, 2.75],
    leading: { tight: 1.2, normal: 1.6 },
    radius: { sm: "8px", md: "14px", lg: "22px" },
    shadow: { light: ["0 1px 3px rgb(76 56 160 / 0.08)", "0 8px 24px rgb(76 56 160 / 0.12)", "0 24px 60px rgb(76 56 160 / 0.18)"], dark: ["0 1px 3px rgb(0 0 0 / 0.4)", "0 8px 24px rgb(0 0 0 / 0.45)", "0 24px 60px rgb(0 0 0 / 0.55)"] },
    motion: { fast: "140ms", base: "240ms", ease: "cubic-bezier(0.34, 1.3, 0.64, 1)" },
    color: ["Surfaces are white cards on a faintly lavender `--color-bg`; `--color-surface-2` tints group related content.", "Teal `--color-accent` marks progress and success moments (streaks, completed steps); lavender `--color-primary` is for actions.", "Status uses a soft tint background with darker text, never a saturated block."],
    type: ["Headings weight 800 at `--text-2xl`+, 700 below, `--leading-tight`.", "Body `--text-base` weight 400, `--leading-normal`; UI labels weight 600.", "Copy is friendly and short: say what happens, in the user's words."],
    layout: ["Mobile first: one column, 20px side gutters, cards `--space-4` apart; content max width 960px on desktop.", "Padding inside cards `--space-6`; sections `--space-12` apart.", "Bottom navigation on mobile, sidebar from 1024px."],
    shape: ["Cards `--radius-lg` with `--shadow-sm`; buttons and inputs `--radius-md`; chips and avatars `--radius-full`.", "No hard borders on cards in light mode: shadow and tint separate them."],
    motionRules: ["The easing has a slight overshoot: use it for things that appear (toasts, checkmarks), not for page transitions.", "Celebrate completions with a short scale-in (0.9 to 1) of the check icon."],
    components: ["Buttons: 44px tall, `--radius-md` (or `--radius-full` for a single hero action), weight 700. Primary filled lavender; secondary `--color-surface-2` fill with `--color-primary` text.", "Inputs: 44px tall, `--color-surface-2` fill, no border until focus, `--radius-md`.", "Cards: `--color-surface`, `--radius-lg`, `--shadow-sm`, padding `--space-6`.", "Progress: thick (8px) `--radius-full` bars in `--color-accent` on `--color-surface-2`."],
    dos: ["Round everything a touch more than feels necessary.", "Use illustration or emoji sparingly for empty and success states.", "Write button labels as verbs: Save, Start, Add habit."],
    donts: ["Sharp corners, 1px hairline borders or dense tables.", "Pure black text or saturated red blocks.", "Long paragraphs; break them up or cut them."],
  },
];

export interface BuiltinSystem {
  id: string;
  name: string;
  description: string;
  design: string;
  tokens: string;
}

export const BUILTIN_SYSTEMS: BuiltinSystem[] = SPECS.map((s) => ({ id: s.id, name: s.name, description: s.description, design: designMd(s), tokens: tokensCss(s) }));
