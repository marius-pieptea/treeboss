/**
 * Theme preference → what is painted. A preference picks a palette and a mode; "system" modes follow
 * the OS light/dark setting live. public/theme.js mirrors resolveTheme() for the pre-paint pass.
 */
export type ThemePref = "system" | "light" | "dark" | "catppuccin-latte" | "catppuccin-mocha" | "spritecraft" | "spritecraft-dark";
export type Palette = "default" | "catppuccin" | "spritecraft";
export type Mode = "dark" | "light";

export const THEME_OPTIONS: { value: ThemePref; label: string; hint?: string }[] = [
  { value: "system", label: "System", hint: "Light / dark" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "catppuccin-latte", label: "Catppuccin Latte" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { value: "spritecraft", label: "Spritecraft Light", hint: "Pixel parchment" },
  { value: "spritecraft-dark", label: "Spritecraft Dark", hint: "Pixel night" },
];

export const isThemePref = (v: unknown): v is ThemePref => THEME_OPTIONS.some((o) => o.value === v);

export function resolveTheme(pref: ThemePref, systemDark: boolean): { palette: Palette; mode: Mode } {
  switch (pref) {
    case "light": return { palette: "default", mode: "light" };
    case "dark": return { palette: "default", mode: "dark" };
    case "catppuccin-latte": return { palette: "catppuccin", mode: "light" };
    case "catppuccin-mocha": return { palette: "catppuccin", mode: "dark" };
    case "spritecraft": return { palette: "spritecraft", mode: "light" };
    case "spritecraft-dark": return { palette: "spritecraft", mode: "dark" };
    default: return { palette: "default", mode: systemDark ? "dark" : "light" };
  }
}

export const systemPrefersDark = () => typeof window === "undefined" || !window.matchMedia("(prefers-color-scheme: light)").matches;

export function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem("trb.theme");
    if (isThemePref(v)) return v;
    // The combined "catppuccin" choice (follow the OS) became two explicit ones.
    if (v === "catppuccin") return systemPrefersDark() ? "catppuccin-mocha" : "catppuccin-latte";
  } catch {}
  return "system";
}

export function applyTheme(palette: Palette, mode: Mode) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  if (palette === "default") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", palette);
}
