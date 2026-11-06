/**
 * Desktop glass: the Electron shell asks the OS for a frosted material behind the window (macOS vibrancy,
 * Windows acrylic) and tells the page which one it got. When it is on, `<html data-vibrancy="on">` switches
 * the chrome surfaces to the translucent tint (styles.css). public/theme.js applies the same flag before paint.
 */
type Desktop = { glass?: string; setAppearance?: (source: "system" | "light" | "dark") => void };
const desktop = (): Desktop | undefined => (window as unknown as { treebossDesktop?: Desktop }).treebossDesktop;

export const glassSupported = () => !!desktop()?.glass;

export function readGlassPref(): boolean {
  try {
    return localStorage.getItem("trb.glass") !== "off";
  } catch {
    return true;
  }
}

export function applyGlass(on: boolean) {
  const root = document.documentElement;
  if (on && glassSupported()) root.dataset.vibrancy = "on";
  else delete root.dataset.vibrancy;
}

export function storeGlassPref(on: boolean) {
  try {
    localStorage.setItem("trb.glass", on ? "on" : "off");
  } catch {}
}

/** The OS material and native controls follow the app's mode, not the OS's, so tell the shell which one to use. */
export const setNativeAppearance = (source: "system" | "light" | "dark") => desktop()?.setAppearance?.(source);
