# TreeBoss design system

> Terminal-grade control room for coding agents: dense, quiet, neutral graphite, near-black or near-white as the action color, violet only for agent orchestration, Geist throughout.

This file is the design contract for TreeBoss: every agent reads it before UI work. The values live in `design/tokens.css`. Components use the tokens (`var(--color-primary)`, or the styling setup's mapping of them), never raw hex values, pixel sizes or font names. Today the app reads its own variables from `web/src/styles.css`; the mapping is in [Token contract](#token-contract), and the places where code departs from this file are in [Drift](#drift).

## Personality

TreeBoss is where a person watches several coding agents at once: sessions running in parallel, diffs, a file tree, a terminal, and the live output of each agent. The interface steps back so the agent's output and the code are the loudest things on screen. Hierarchy comes from weight, size, space and mono type, not from color. The action color is graphite, the foreground itself: a near-black (light) or near-white (dark) fill means "act here" (primary buttons, selection, focus, a running agent). Violet marks agent orchestration: plans, pairs and heads. Green, amber and red mean status and nothing else. The one flourish is the pulsing dot of a running agent, because that is how a person knows the system is alive. The effort bar's level-driven sweep is the one documented exception (see Motion).

Keywords: dense, precise, quiet, technical, live.

## Color

Both themes are defined. The OS preference picks one unless the page forces a theme; `data-theme="dark"` forces dark and `data-theme="light"` forces light. Values below are the default palette in `design/tokens.css`. All text pairs pass 4.5:1 in both themes (see [Accessibility](#accessibility)).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg` | `#f4f4f5` | `#0a0a0b` | App background behind the panes |
| `--color-surface` | `#ffffff` | `#101011` | Panels: sidebars, editor, transcript |
| `--color-surface-2` | `#f0f0f1` | `#171718` | Inputs, cards, code blocks, segmented track |
| `--color-overlay` | `#ffffff` | `#1a1a1c` | Popovers, menus, dialogs, tooltips, toasts |
| `--color-border` | `rgba(0, 0, 0, 0.10)` | `rgba(255, 255, 255, 0.075)` | Dividers, card edges |
| `--color-border-strong` | `rgba(0, 0, 0, 0.20)` | `rgba(255, 255, 255, 0.15)` | Control outlines, floating-surface edges |
| `--color-text` | `#1a1a1c` | `#e6e6e8` | Body text, titles |
| `--color-text-muted` | `#55555c` | `#a1a1a9` | Secondary text, labels, hints, placeholders |
| `--color-text-faint` | `#85858c` | `#66666d` | Icons and hairline decoration only. Non-text (3:1), never text |
| `--color-hover` | `rgba(0, 0, 0, 0.05)` | `rgba(255, 255, 255, 0.045)` | Hover tint on rows and ghost controls |
| `--color-active` | `rgba(0, 0, 0, 0.09)` | `rgba(255, 255, 255, 0.085)` | Pressed or selected neutral state, subtle fills |
| `--color-primary` | `#1a1a1c` | `#f2f2f3` | The one main action per view, links, selection, running state. Graphite: the foreground color itself |
| `--color-primary-fg` | `#ffffff` | `#0a0a0b` | Text and icons on primary |
| `--color-primary-soft` | `rgba(0, 0, 0, 0.08)` | `rgba(255, 255, 255, 0.10)` | Selected row, active badge |
| `--color-accent` | `#6d28d9` | `#a78bfa` | The one accent: agent orchestration (plans, pairs, heads). Never a button fill |
| `--color-success` | `#166534` | `#4ade80` | Done, connected, added lines |
| `--color-warning` | `#9a4608` | `#fbbf24` | Stale, needs attention, partially done |
| `--color-danger` | `#b91c1c` | `#f87171` | Errors, destructive actions, removed lines |
| `--color-danger-fg` | `#ffffff` | `#1c0505` | Text and icons on danger fill |
| `--color-info` | `#1d4ed8` | `#60a5fa` | Informational tags and file-kind icons. Not status |
| `--color-focus` | `#1a1a1c` | `#f2f2f3` | Focus outline (1.5px, offset 1px) |

Rules:

1. Components ask for a role (`--color-primary`), never a hue. Tailwind's palette (`text-red-500`) is not allowed.
2. One primary and one accent. Primary is the action and the current selection. The accent is violet and belongs to agent orchestration (plans, pairs and heads); it is never a second primary.
3. Status colors carry meaning only. A status color always comes with a word or an icon, so color is not the only signal.
4. Secondary text is `--color-text-muted`. `--color-text-faint` is not text; it is for icons and decoration.
5. Alpha tints (`--color-hover`, `--color-active`, `--color-primary-soft`, or `/10` on a status color) are for states and fills, not for text.
6. Spritecraft (`data-theme="spritecraft"`, with `.dark` for the night variant) is a pixel-art theme: parchment surfaces, ink outlines, quest-green primary, VT323 body, Press Start 2P headings, Silkscreen labels, zero radius, hard-edged shadows. Defined in `tokens.css` and `web/src/styles.css`; fonts are the `@fontsource/*` packages.
7. Catppuccin palettes exist in `web/src/styles.css:72` and the terminal ANSI palette is hard-coded in `web/src/features/terminal/logic.ts:46`. Neither is covered by `tokens.css`; the terminal palette is the one sanctioned exception to "no raw hex".

## Typography

**Families.** One family for everything product-facing: Geist Variable (`--font-sans`, and `--font-display` set to the same, deliberately). The product is a single-family, technical direction, so display and body sharing one family is intentional, not a default. Geist Mono Variable (`--font-mono`) for code, paths, identifiers, counts, shortcuts and badges. Mono is the data voice of the product.

**How to load.** Self-hosted, no CDN. The `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` packages are imported at the top of `web/src/styles.css`; Vite bundles the woff2 files. Body sets `font-feature-settings: "cv11", "ss01"` (`web/src/styles.css:181`), keep it.

**Scale (px).** A dense product scale: 1px steps from 11 to 14, then larger steps for titles. It is not a modular ratio, because the density of a tool does not fit one.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 11px | Uppercase section and field labels, badges, kbd, hints, counts |
| `--text-sm` | 12px | Secondary text, segmented tabs, empty-state hints, mono paths |
| `--text-base` | 13px | Body, inputs, buttons (md), menu items, toasts |
| `--text-lg` | 14px | Dialog titles, card titles |
| `--text-xl` | 16px | Section titles in long documents |
| `--text-2xl` | 18px | Page titles (settings, welcome) |
| `--text-3xl` | 22px | Reserved, not yet used |
| `--text-4xl` | 28px | Reserved, not yet used |

Line heights: `--leading-normal` 1.45 (body, UI), `--leading-tight` 1.25 (titles), `--leading-snug` 1.375 (dense multi-line UI), `--leading-relaxed` 1.625 (help paragraphs and descriptions).

Weights: `--font-weight-normal` 400, `--font-weight-medium` 500 (labels, buttons), `--font-weight-semibold` 600 (titles, section headers). No bold (700).

Rules:

1. Only the scale above. No `text-[10.5px]`, `text-[12.5px]`, `text-[9px]` and the like.
2. Nothing smaller than 11px.
3. Uppercase only for section and field labels, with `--tracking-label` (0.08em).
4. Mono for anything a person might copy: paths, ids, numbers, model names, shortcuts.
5. Headings never use a larger family or a heavier weight to stand out; size and space do that.

## Space and layout

**Grid.** A 4px grid: `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-6` 24px, `--space-8` 32px, `--space-12` 48px, `--space-16` 64px. Layout gaps come from these.

In practice:
- Inside a control (icon to label): 4px. Between controls in a toolbar: 8px. Between groups: 12px.
- Panel and card padding: 12px. Section padding: 16px. Settings page padding: 24px top, 32px sides (`web/src/features/settings/shared.tsx:14`).
- Dense rows are 24 to 28px high; a sidebar header is 36px; a sidebar section header is 28px.

**Max widths** (layout constants, not tokens):

| Surface | Width |
|---|---|
| Chat transcript column | 760px |
| Document and markdown reading column | 820px |
| Settings page | 900px (1100px when wide) |
| Help text under a title | 62ch |
| Empty-state hint | 26ch |
| Popovers | 344 to 360px |
| Dialogs | 440px default |
| Command palette, quick open | 600 to 620px |

**Gaps and density.** Gaps between list items: 4px. Between fields in a form: 12px. The app is dense on purpose; do not add breathing room that the content does not need.

## Shape and elevation

**Radii.** `--radius-sm` 4px (badges, kbd, checkboxes), `--radius-md` 6px (buttons, inputs, menu items), `--radius-lg` 8px (popovers, menus, cards, segmented track), `--radius-xl` 12px (dialogs, empty-state icon tile), `--radius-full` (status dots, toggles, scrollbar thumb).

**Elevation.** Borders separate most things. Shadows are for things that float above the page.

| Token | Use |
|---|---|
| `--shadow-sm` | Selected segment in a segmented control, only |
| `--shadow-md` | Reserved; no current use |
| `--shadow-lg` | Popovers, menus, dialogs, tooltips, toasts, the drawer |

Cards, buttons and inputs have no shadow. Do not add glow to a control.

## Motion

**Durations.** `--duration-instant` 100ms (press, menu and tooltip open), `--duration-fast` 150ms (color and transform transitions, toggles, dialogs), `--duration-base` 200ms (height and width reveals, progress bars). `--duration-sweep-slow` 2400ms and `--duration-sweep-fast` 800ms are the two ends of the effort bar's sweep (see The one flourish).

**Curve.** One curve: `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`. No overshoot and no bounce. Tailwind's `ease-out` utility is mapped to it.

**Craft rules.** Animate `transform` and `opacity` only. Controls wind up on press (`active:scale-[0.97]`). Popovers, menus and tooltips scale from their anchor (`--radix-popper-transform-origin`). Lists reveal with the `stagger` utility (`--i` per item, `--stagger-step` 30ms, capped at six steps); never stagger content that streams in. Use `will-change` only while an animation runs.

**The one flourish.** The running-agent pulse (`animate-pulse-dot`, 1.8s, primary color). Loading shimmer and sweep (`.shimmer-text`, `.sweep`) are for in-progress text and bars only. Everything else is a plain transition.

**Sanctioned exception: the effort bar's sweep.** The effort slider's fill (`EffortSlider`, `web/src/components/ui/model-select.tsx`) carries a looping highlight (`.effort-sweep`), and its speed and strength are the effort level. The level sets `--level` (0 to 1, the stop's index over the last stop) on the fill. The duration runs from `--duration-sweep-slow` at the lowest level to `--duration-sweep-fast` at the highest: `calc(slow + (fast - slow) * level)`. The highlight is `--color-primary-fg` (the contrast color of the graphite fill) mixed at 40% (lowest level) to 45% (highest), so it stays visible on the fill in both themes. "Default" has no sweep. It is the only looping decoration outside in-progress work. It reads the effort level, not an event, so it is not a second flourish.

**Reduced motion.** The durations go to 0 under `prefers-reduced-motion` in `design/tokens.css`. The app already collapses animations under the same media query (`web/src/styles.css`, at 0s). Entrances that move (slide up, slide right, pop) become an opacity fade over `--duration-crossfade` (150ms), which is not zeroed, so the change still registers. The running pulse ring is removed, not frozen. Looping decoration (shimmer, sweep, spin) stops after one pass. The effort bar's sweep is the exception: its duration tokens are not zeroed, so it is set to `animation: none` instead, and the static fill still shows the level.

## Components

Sizes are the app's current values; they match the component code in `web/src/components/ui/`.

### Buttons (`button.tsx`)

| Size | Height | Text | Padding | Icon |
|---|---|---|---|---|
| `xs` | 24px | 11px | 0 8px | 12px |
| `sm` (default) | 28px | 12px | 0 10px | 14px |
| `md` | 32px | 13px | 0 12px | 16px |
| `icon` | 28px square | none | none | 16px |
| `icon-sm` | 24px square | none | none | 14px |

Radius: `--radius-md`. Font weight: medium. Gap between icon and label: 4px.

| Variant | Fill | Text | Use |
|---|---|---|---|
| `primary` | `--color-primary` | `--color-primary-fg` | The one main action in a view |
| `subtle` (default) | `--color-surface-2` | `--color-text` | Secondary actions, toolbars |
| `outline` | transparent, `--color-border-strong` edge | `--color-text` | Alternatives next to a primary |
| `ghost` | transparent | `--color-text-muted` | Icon buttons, inline actions |
| `danger` | `--color-danger` | `--color-danger-fg` | Destructive confirms |
| `danger-ghost` | transparent | `--color-danger` | Destructive in a menu |

States: hover (`primary` brightens 10%; the others use `--color-hover` or `--color-active`), press (scale 0.97), focus-visible (`--color-focus` outline, 1.5px, offset 1px), disabled (50% opacity; a disabled `primary` is a flat `--color-active` fill with `--color-text-faint` text, not a faded copy).

### Inputs and fields (`form.tsx`)

- Height 32px (28px in a small variant). Horizontal padding 8px. Text 13px (12px small). Radius `--radius-md`.
- Fill `--color-surface-2`; edge `--color-border`; hover edge `--color-border-strong`; focus edge `--color-primary` at 70%, fill `--color-surface`.
- Placeholder: `--color-text-muted`. Disabled: 50% opacity.
- Field label: 11px, medium, uppercase, `--tracking-label`, `--color-text-muted`. Hint under a field: 11px, `--color-text-muted`.
- Textarea: min height 64px, vertical resize only, padding 6px 8px, line height 1.625.

### Cards

A card is a `--color-surface-2` (or `--color-surface`) fill, a 1px `--color-border` edge, `--radius-lg`, 12px padding, and no shadow. A floating card (a menu, a popover, a drawer) is `--color-overlay` with a `--color-border-strong` edge and `--shadow-lg`.

### Navigation

- **Sidebar.** A 36px header with an 11px uppercase label and icon buttons on the right. Section headers are 28px with a chevron and an optional count badge (mono, 11px).
- **Rows.** Hover is `--color-hover`. A selected row is `--color-primary-soft` with `--color-primary` text. A neutral active state is `--color-active`.
- **Segmented control.** Track: `--color-surface-2`, `--radius-lg`, 2px padding. Segment: 24px high, `--radius-md`, 12px text. Selected: `--color-surface` fill, `--color-text`, `--shadow-sm`, 1px `--color-border` ring.
- **Menus and popovers.** `--color-overlay`, `--color-border-strong`, `--radius-lg`, `--shadow-lg`, 4px padding. Items: 6px by 8px padding, `--radius-md`, 13px text, `--color-hover` on highlight. Shortcuts in mono, `--color-text-muted`.
- **Dialogs.** 440px default width, top at 18% of the viewport, `--radius-xl`, `--shadow-lg`. Overlay: black at 55% with a 2px backdrop blur. Title 14px semibold; description 12px muted; footer separated by `--color-border`.
- **Tooltips.** `--color-overlay`, 11px text, `--radius-md`, `--shadow-lg`, with an optional kbd shortcut.

### Badges and status

- Badge: 18px high, 6px horizontal padding, mono, 11px, `--radius-sm`. Tones are a status color at 10% fill and 25% edge, with the status color as text. Neutral uses `--color-surface-2` and `--color-text-muted`.
- Status dot: 7px, `--radius-full`. Running uses `--color-primary` with the pulse. Idle and done use `--color-success`; failed uses `--color-danger`; closed uses `--color-text-faint`. Every dot has an `aria-label` and a title.

### Empty states (`misc.tsx`, `Empty`)

Centered column, 24px horizontal and 40px vertical padding. An icon tile: 40px square, `--radius-xl`, `--color-surface-2` fill, 1px `--color-border` edge, icon at 20px in `--color-text-faint`. Title: 13px, medium, `--color-text`. Hint: 12px, `--color-text-muted`, max 26ch. An optional `primary` button. It fades and slides in with the `--duration-base` reveal.

## Do

- Use the role tokens (`--color-text-muted`, `--color-primary`) and the spacing and radius tokens.
- Keep one primary button per view. Put the rest in `subtle`, `outline` or `ghost`.
- Use mono for every identifier, path, count and shortcut.
- Pair a status color with a word or an icon.
- Use the `Empty` component for empty states and `IconButton` (it carries a label and a tooltip) for icon-only actions.
- Keep hover states to a tint, not a new color.
- Use `--shadow-lg` only for things that float above the page.

## Don't

- Don't use `--color-text-faint` for text, placeholders or hints.
- Don't use `text-amber`, `text-green` or `text-red` for small text on a light surface. Use `--color-warning`, `--color-success` and `--color-danger`, which pass in both themes.
- Don't use Tailwind palette colors (`text-red-500`) or raw hex, rgb, oklch values in components. The terminal ANSI palette is the one exception.
- Don't use violet as a fill or on a button. Violet is the accent for agent orchestration.
- Don't put a glow on a button, a shadow on a card, or a gradient on a surface. The only gradients are the loading shimmer and sweep.
- Don't set text in a size outside the scale, and don't use bold.
- Don't add a second flourish. The running pulse is the one; the effort bar's sweep is the documented exception (see Motion).
- Don't use the generic patterns: no purple-to-blue gradients, no emoji or icon in front of every heading, no thick colored left border as the main decoration on a card, no invented metrics or testimonials, no beige or cream page backgrounds.

## Accessibility

Measured contrast (WCAG 2.x, against every surface a token is used on, including tinted hover and status-wash backgrounds):

| Pair | Light | Dark |
|---|---|---|
| `--color-text` on surfaces | 12.43 or more | 10.41 or more |
| `--color-text-muted` on surfaces and the active tint | 5.29 or more | 5.06 or more |
| `--color-primary-fg` on `--color-primary` | 17.38 | 17.69 |
| `--color-danger-fg` on `--color-danger` | 6.47 | 7.07 |
| `--color-primary` as text, on surfaces and the status wash | 12.43 or more | 11.60 or more |
| `--color-accent` as text | 5.07 or more | 4.77 or more |
| `--color-success` as text | 5.10 or more | 7.44 or more |
| `--color-warning` as text | 4.62 or more | 7.77 or more |
| `--color-danger` as text | 4.57 or more | 4.69 or more |
| `--color-info` as text | 4.79 or more | 5.10 or more |
| `--color-primary` on `--color-primary-soft` | 12.80 | 11.60 |
| `--color-focus` and `--color-text-faint`, non-text (3:1) | 3.21 or more | 3.05 or more |

These were computed from the values in `design/tokens.css`, the same way for each pair (status text is also checked on its own 13% wash). A pair not listed (a new status on a new surface, say) needs the same check before it ships.

Known gaps:

- **Control outlines.** `--color-border` is about 1.2:1 on white and `--color-border-strong` about 1.5:1. Inputs and checkboxes are identified by the border and the fill together. If a control must be found by its outline alone, add a control-outline token at 3:1.
- **Small targets.** The `icon-xs` button (20px) is below the 24px target size. Use it only in dense rows with spacing around it.

Other rules:

- Icon-only controls use `IconButton`, which sets an `aria-label` and a tooltip.
- Status is never color alone: dots have an `aria-label` and a title, and badges carry a word.
- The global `:focus-visible` outline (`web/src/styles.css:230`) is the focus indicator; it uses the app's accent, which is `--color-focus` in the contract.
- Motion is reduced under `prefers-reduced-motion`.

## Token contract

Every system sets these names. Components use these names and nothing else. The names below match `TOKEN_CONTRACT` in `src/design/contract.ts`.

- **Color:** `--color-bg`, `--color-surface`, `--color-surface-2`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-primary-fg`, `--color-accent`, `--color-success`, `--color-warning`, `--color-danger`, `--color-focus`
- **Type:** `--font-sans`, `--font-display`, `--font-mono`, `--text-xs`, `--text-sm`, `--text-base`, `--text-lg`, `--text-xl`, `--text-2xl`, `--text-3xl`, `--text-4xl`, `--leading-tight`, `--leading-normal`
- **Space:** `--space-1`, `--space-2`, `--space-3`, `--space-4`, `--space-6`, `--space-8`, `--space-12`, `--space-16`
- **Shape:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- **Motion:** `--duration-fast`, `--duration-base`, `--ease-out`

Added by this system (the contract allows more): `--color-overlay`, `--color-border-strong`, `--color-text-faint`, `--color-hover`, `--color-active`, `--color-primary-soft`, `--color-danger-fg`, `--color-info`, `--text-label` (alias of `--text-xs`, the label size; the app reads it as the `text-label` utility), `--leading-snug`, `--leading-relaxed`, `--font-weight-normal`, `--font-weight-medium`, `--font-weight-semibold`, `--tracking-label`, `--radius-xl`, `--duration-instant`, `--color-glass`, `--duration-crossfade`, `--duration-sweep-slow`, `--duration-sweep-fast`.

**Glass.** `--color-glass` is the tint the desktop app lays over the OS frosted material (macOS vibrancy, Windows acrylic) on the title bar, activity bar, sidebar and status bar. It is translucent on purpose: the material supplies the blur, the tint only sets the tone and keeps text legible. It applies only when the shell reports an active material (`data-vibrancy="on"` on `<html>`); otherwise those surfaces use the solid `--color-bg`. Editor, panels, dialogs and menus stay opaque. In the app it is `--glass` in `web/src/styles.css`, read through `bg-chrome` and `bg-window`.

**Mechanism.** `design/tokens.css` puts light values in `:root`, repeats color and shadow tokens for dark in `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and in `:root[data-theme="dark"]`, and zeroes the durations under reduced motion.

**How the app reads them today.** `web/src/styles.css` does not import `design/tokens.css`. It defines its own variables and maps them into Tailwind's theme. To move the app onto the contract without changing any screen, alias each app variable to its contract name:

| Contract | App variable (`web/src/styles.css`) | Tailwind utility |
|---|---|---|
| `--color-bg` | `--bg` (line 13) | `bg-bg` |
| `--color-surface` | `--panel` (14) | `bg-panel` |
| `--color-surface-2` | `--raised` (15) | `bg-raised` |
| `--color-overlay` | `--overlay` (16) | `bg-overlay` |
| `--color-border` | `--line` (19) | `border-line` |
| `--color-border-strong` | `--line-strong` (20) | `border-line-strong` |
| `--color-text` | `--fg` (21) | `text-fg` |
| `--color-text-muted` | `--fg-muted` (22) | `text-fg-muted` |
| `--color-text-faint` | `--fg-faint` (23) | `text-fg-faint` |
| `--color-hover` | `--hover` (17) | `bg-hover` |
| `--color-active` | `--active` (18) | `bg-active` |
| `--color-primary` / `-fg` | `--accent` (25) / `--accent-fg` (26) | `bg-accent`, `text-accent-fg` |
| `--color-primary-soft` | `--accent-soft` (27) | `bg-accent-soft` |
| `--color-accent` | `--violet` (28) | `text-violet` |
| `--color-success` | `--green` (29) | `text-green` |
| `--color-warning` | `--amber` (31) | `text-amber` |
| `--color-danger` | `--red` (30) | `text-red` |
| `--color-info` | `--blue` (32) | `text-blue` |
| `--color-focus` | `--accent` (used by the `:focus-visible` rule, styles.css:231) | |
| `--font-sans` / `--font-mono` | `--font-ui` (38) / `--font-code` (39) | `font-sans` / `font-mono` |
| `--radius-lg` | `--radius` (40) | `rounded-lg` |
| `--shadow-lg` | `--shadow` (37) | `shadow-pop` |

The app's values differ from the contract in the places listed under [Drift](#drift); the mapping is for the names, and the values in `tokens.css` are the target.

**Theme switch.** The app toggles the `dark` class on `<html>` (`web/src/styles.css:43`, `web/public/theme.js`), where the contract uses `data-theme="dark"`. Support both in the selectors when the app is aliased.

## Drift

Measured on `web/src` (`.ts` and `.tsx`). Counts are class-string occurrences unless stated. For each row: the dominant value is the one to keep, and the rest move to the token shown.

### Color

| Drift | Count | Example (file:line) | Use instead |
|---|---|---|---|
| `text-fg-faint` used as text, placeholder or hint. Light 3.0 and 2.7, dark 3.2 and 2.9 on panel and raised | 394 | `components/ui/model-select.tsx:247` (inherited hint), `components/ui/form.tsx:6` (placeholder), `components/ui/form.tsx:21` (hint) | `--color-text-muted` for text. `--color-text-faint` only for icons |
| `text-amber` as status text: 3.2:1 on light panel | 99 | `features/codegraph/CodegraphButton.tsx:367` | `--color-warning` (light `#9a4608`) |
| `text-green` as text: 3.3:1 on light panel | 53 | `features/settings/McpPage.tsx:31` ("Connected"), `features/agent/ChatThread.tsx:84` | `--color-success` (light `#166534`) |
| `text-red` as text: 4.3:1 on a light raised surface (4.8:1 on panel) | 92 | `features/explorer/ExplorerSidebar.tsx:24` (tone map) | `--color-danger` (light `#b91c1c`, 5.5:1 or more on light surfaces) |
| Muted text on the active tint over raised, light: 4.33:1 before the change | — | `web/src/styles.css:22` (`--fg-muted`) | `--color-text-muted` (light `#525d6e`, 4.96:1 minimum) |
| Danger button: `bg-red/90 text-white`. White on it is 3.31:1 dark and 4.32:1 light | 1 pattern | `components/ui/button.tsx:16` | `--color-danger` with `--color-danger-fg` |
| Primary button glow: arbitrary `shadow-[0_0_0_1px ...]` on every primary | 1 pattern | `components/ui/button.tsx:12`. Also a drop-indicator glow at `features/roadmap/Board.tsx:271` | Flat primary fill. No glow |
| Violet used outside agent orchestration: file-kind icons and a diff status tone | 4 | `shell/FileIcon.tsx:35`, `shell/FileIcon.tsx:43`, `shell/FileIcon.tsx:60`, `features/git/DiffBlocks.tsx:11` | `--color-info` or `--color-text-muted`, by meaning |
| Hard-coded ANSI palette and selection colors | 1 file | `features/terminal/logic.ts:46`, `features/terminal/logic.ts:53` | Keep. It is the sanctioned exception; values follow the theme but not the tokens |

### Type

| Drift | Count | Example (file:line) | Use instead |
|---|---|---|---|
| `text-[10.5px]` uppercase section and sidebar headers | 122 | `features/docs/DocsSidebar.tsx:184`, `features/settings/SettingsSidebar.tsx:44`, `components/ui/misc.tsx:56` | `text-xs` (11px) with `--tracking-label` |
| `text-[10px]` for badges, kbd, dividers and counts | 77 | `components/ui/misc.tsx:10` (kbd), `components/ui/misc.tsx:25` (badge) | `text-xs` (11px) |
| Sizes below 10px (`text-[9px]`, `text-[9.5px]`, `text-[8px]`) | 11 | `features/heads/HeadsPanel.tsx:69`, `features/agent/PlanFlow.tsx:184`, `features/roadmap/Timeline.tsx:91` | `text-xs` (11px) |
| `text-[11.5px]` | 69 | `features/roadmap/Timeline.tsx:69` | `text-sm` (12px) |
| `text-[12.5px]` for menus, select, toasts, search | 72 | `components/ui/overlay.tsx:55` (menus), `components/ui/form.tsx:48` (select), `main.tsx:48` (toast) | `text-base` (13px) |
| `text-xs` in Tailwind is 12px. The contract's `--text-xs` is 11px. The name is in conflict | 166 | `components/ui/misc.tsx:43` (empty hint) | Rename to `text-sm` (12px) in a mechanical pass, then `text-xs` means 11px |
| `text-[12px]` | 81 | `features/codegraph/CodegraphButton.tsx:361` | `text-sm` (12px) |
| `text-[14px]`, `text-[14.5px]`, `text-[15px]` | 32 | `features/settings/AgentsPage.tsx:28` | `text-lg` (14px) |
| `text-[18px]` page titles | 4 | `features/settings/shared.tsx:17` | `text-2xl` (18px) |
| Markdown body at `line-height: 1.6` and em-based headings | 1 rule | `web/src/styles.css:365` (1.6), `web/src/styles.css:372`–`373` (1.25em, 1.12em) | `--leading-relaxed` (1.625); heading sizes from the scale |
| `font-bold` and `font-normal` (not in the scale) | 9 | `features/roadmap/Timeline.tsx:52` (`font-normal`) | `--font-weight-semibold` and `--font-weight-normal` |
| Three uppercase tracking values: `tracking-[0.08em]`, `tracking-wide`, `tracking-wider` | 16, 25, 22 | `components/ui/form.tsx:19` (`wide`), `components/ui/misc.tsx:91` (`wider`) | `--tracking-label` (0.08em) |
| `font-display` is never a class. Only the Design feature reads `--font-display`, from other systems | 0 | `features/design/DesignTab.tsx:22` | Keep the token; set it to the sans family as here |

### Space

| Drift | Count | Example (file:line) | Use instead |
|---|---|---|---|
| `gap-1.5` (6px) and `py-1.5` (6px): off the 4px grid | 159 and 86 | `components/ui/button.tsx:7` (gap), `components/ui/form.tsx:13` (textarea padding) | `space-1` (4px) inside a control; `space-2` (8px) between controls |
| `px-2.5` (10px) and `py-2.5`: off the grid | 49 and 9 | `components/ui/form.tsx:6` (field padding) | `space-2` (8px) for fields |
| `gap-2.5` (10px): off the grid | 27 | `features/codegraph/CodegraphButton.tsx:361` | `space-2` (8px) or `space-3` (12px) |
| 2px nudges (`gap-0.5`, `mt-0.5`) | 31 and 57 | `features/codegraph/CodegraphButton.tsx:364` (`mt-0.5`) | `space-1` (4px), or 0 |
| Max widths repeated as literals (820px in three places) | 3 | `features/docs/DocViewer.tsx:26`, `features/docs/DocViewer.tsx:226`, `features/editor/MarkdownPreview.tsx:12` | Keep as layout constants in this file, or add a width token |

### Shape

| Drift | Count | Example (file:line) | Use instead |
|---|---|---|---|
| Bare `rounded` (4px) where `rounded-sm` is meant | 106 | `components/ui/misc.tsx:10` (kbd) | `rounded-sm` (same value; name it) |
| `rounded-[3px]` on checkboxes | 3 | `components/ui/form.tsx:76` | `--radius-sm` (4px) |
| `rounded-2xl` (16px) on chat bubbles | 3 | `features/agent/ChatThread.tsx:142` | `--radius-xl` (12px) |
| Arbitrary radii (`rounded-[2px]`, `rounded-[4px]`, `rounded-[18px]`, `rounded-[26px]`) | 4 | `features/git/DiffBlocks.tsx:28` (`2px`) | Nearest token, or `--radius-sm` |
| `shadow` (Tailwind default) and `shadow-sm` used for the selected segment | 13 and 5 | `components/ui/misc.tsx:75` (segmented tabs) | `--shadow-sm` |
| Z-index as literals (`z-[95]`, `z-[90]`, `z-[100]`, `z-50`, `z-20`) | 26 | `components/ui/form.tsx:48` (`z-[95]`), `components/ui/overlay.tsx:134` (`z-[90]`) | A z scale: popover 90, select 95, tooltip 100 |

### Motion

No drift: durations, the curve, overshoot and reduced motion now follow the contract.

### Components

| Drift | Count | Example (file:line) | Use instead |
|---|---|---|---|
| Disabled opacity: 50% on fields and selects, 40% on buttons and switches | 12 and 8 | `components/ui/form.tsx:6` (50%), `components/ui/button.tsx:7` (40%) | 50% for all disabled controls |
| Two uppercase label styles (10.5px sidebar headers, 11px field labels) | — | `features/docs/DocsSidebar.tsx:184` vs `components/ui/form.tsx:19` | One label style: `text-xs`, `--tracking-label` |
| Icon-only `xs` size at 20px, below the 24px target size | 1 size | `components/ui/button.tsx:25` (`icon-xs`) | Keep for dense rows only |
| Theme mechanism: `html.dark` class, not `data-theme="dark"`. Catppuccin palette via `data-theme="catppuccin"` is outside the contract | 2 | `web/src/styles.css:43`, `web/src/styles.css:72`, `web/public/theme.js` | Support both mechanisms; Catppuccin is a separate system |
