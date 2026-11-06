/** A picked element: validation of what the page sent, and the text the composer receives. */
import fs from "fs";
import path from "path";
import { paths } from "../paths";
import { newId } from "../util";

export interface Pick {
  selector: string;
  tag: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; dpr: number };
  page: string;
  title: string;
  /** Absolute path of the cropped screenshot, when one could be taken. */
  screenshot: string | null;
  screenshotNote: string | null;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Never trust the page: clamp every field. */
export function sanitizePick(raw: any, pageUrl: string): Omit<Pick, "screenshot" | "screenshotNote"> {
  const styles: Record<string, string> = {};
  if (raw?.styles && typeof raw.styles === "object") for (const [k, v] of Object.entries(raw.styles).slice(0, 30)) if (typeof v === "string") styles[str(k, 40)] = v.slice(0, 120);
  return {
    selector: str(raw?.selector, 400),
    tag: str(raw?.tag, 30),
    text: str(raw?.text, 160),
    html: str(raw?.html, 2200),
    styles,
    box: { x: num(raw?.box?.x), y: num(raw?.box?.y), width: num(raw?.box?.width), height: num(raw?.box?.height) },
    viewport: { width: num(raw?.viewport?.width, 1280) || 1280, height: num(raw?.viewport?.height, 800) || 800, dpr: typeof raw?.viewport?.dpr === "number" ? raw.viewport.dpr : 1 },
    page: pageUrl,
    title: str(raw?.title, 120),
  };
}

export function formatPick(p: Pick): string {
  const styles = Object.entries(p.styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const lines = [
    `[Picked element from the live preview]`,
    `Selector: ${p.selector}`,
    `Page: ${p.page}${p.title ? ` ("${p.title}")` : ""}`,
    `Box: x=${p.box.x} y=${p.box.y} ${p.box.width}x${p.box.height}px (viewport ${p.viewport.width}x${p.viewport.height})`,
    p.text ? `Text: ${JSON.stringify(p.text)}` : "",
    `Computed styles: ${styles}`,
    "HTML:",
    "```html",
    p.html,
    "```",
    p.screenshot ? `Screenshot (cropped to the element): ${p.screenshot}` : p.screenshotNote ? `Screenshot: not available (${p.screenshotNote})` : "",
  ];
  return lines.filter((l) => l !== "").join("\n") + "\n";
}

export function picksDir(): string {
  const dir = path.join(paths.scratch(), "picks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newPickFile(ext: string): string {
  return path.join(picksDir(), `${newId("pick")}.${ext}`);
}
