/**
 * The token contract every design system follows, the rule that tells agents about it, and a small
 * tokens.css reader the UI uses for swatches.
 *
 * The contract is a list of CSS custom property names. Components use these names and nothing else, so one
 * system can replace another without touching a component. A system may add tokens of its own; it should
 * not drop or rename these.
 */

export const DESIGN_FILE = "DESIGN.md";
export const TOKENS_FILE = "design/tokens.css";

export const DESIGN_RULE = `Before any UI work, read ${DESIGN_FILE} and use the tokens in ${TOKENS_FILE} (var(--…) or the styling setup's mapping of them). Do not invent colors, fonts, sizes, spacing, radii or shadows outside it; if something is missing, add it to both files first.`;

export interface TokenGroup {
  title: string;
  names: string[];
  /** What the group is for, one line. */
  use: string;
}

export const TOKEN_CONTRACT: TokenGroup[] = [
  { title: "Color", use: "Roles, not hues: components ask for a role.", names: ["--color-bg", "--color-surface", "--color-surface-2", "--color-border", "--color-text", "--color-text-muted", "--color-primary", "--color-primary-fg", "--color-accent", "--color-success", "--color-warning", "--color-danger", "--color-focus"] },
  { title: "Type", use: "Families, then a modular scale.", names: ["--font-sans", "--font-display", "--font-mono", "--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl", "--text-4xl", "--leading-tight", "--leading-normal"] },
  { title: "Space", use: "A 4px grid; layout gaps come from here.", names: ["--space-1", "--space-2", "--space-3", "--space-4", "--space-6", "--space-8", "--space-12", "--space-16"] },
  { title: "Shape", use: "Corner radii and elevation.", names: ["--radius-sm", "--radius-md", "--radius-lg", "--radius-full", "--shadow-sm", "--shadow-md", "--shadow-lg"] },
  { title: "Motion", use: "Durations and the one easing curve.", names: ["--duration-fast", "--duration-base", "--ease-out"] },
];

export const CONTRACT_NAMES: string[] = TOKEN_CONTRACT.flatMap((g) => g.names);

/** The contract as markdown, for prompts and for the DESIGN.md of the shipped systems. */
export function contractMarkdown(): string {
  return TOKEN_CONTRACT.map((g) => `- **${g.title}** (${g.use}): ${g.names.map((n) => `\`${n}\``).join(", ")}`).join("\n");
}

/* -------------------------------------------------------------------------- */
/* Reading tokens.css                                                         */
/* -------------------------------------------------------------------------- */

export interface ColorToken {
  name: string;
  light: string;
  /** The dark-mode value, when the file sets one. */
  dark: string | null;
}

export interface TokenSummary {
  colors: ColorToken[];
  fonts: Array<{ name: string; value: string }>;
  radii: Array<{ name: string; value: string }>;
  /** Every custom property set in the light (default) scope. */
  count: number;
  /** Contract names the file does not set. */
  missing: string[];
}

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\))$/i;

/** Blocks of `selector { … }`, one level of @media nesting, comments removed. Enough for a tokens file. */
function blocks(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  const walk = (src: string, outer: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const selector = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (selector.startsWith("@")) walk(body, `${outer} ${selector}`.trim());
      else out.push({ selector: `${outer} ${selector}`.trim(), body });
      i = j;
    }
  };
  walk(text, "");
  return out;
}

function props(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const decl of body.split(";")) {
    const k = decl.indexOf(":");
    if (k < 0) continue;
    const name = decl.slice(0, k).trim();
    const value = decl.slice(k + 1).trim();
    if (name.startsWith("--") && value) m.set(name, value);
  }
  return m;
}

const isDark = (selector: string): boolean => /dark/i.test(selector);

/** What a tokens.css sets: colors (light and dark), font families, radii, and the contract names it lacks. */
export function parseTokens(css: string): TokenSummary {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const b of blocks(css)) {
    if (!/:root|html|\[data-theme/.test(b.selector) && !/^\.dark\b/.test(b.selector)) continue;
    const target = isDark(b.selector) ? dark : light;
    for (const [k, v] of props(b.body)) if (!target.has(k)) target.set(k, v);
  }
  const colors: ColorToken[] = [];
  const fonts: Array<{ name: string; value: string }> = [];
  const radii: Array<{ name: string; value: string }> = [];
  for (const [name, value] of light) {
    if (name.startsWith("--color-") || COLOR_VALUE.test(value)) colors.push({ name, light: value, dark: dark.get(name) ?? null });
    else if (name.startsWith("--font-")) fonts.push({ name, value });
    else if (name.startsWith("--radius-")) radii.push({ name, value });
  }
  return { colors, fonts, radii, count: light.size, missing: CONTRACT_NAMES.filter((n) => !light.has(n)) };
}
