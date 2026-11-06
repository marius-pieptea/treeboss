/**
 * Plug-in points for context that other modules own. The preview (a running app and its console) does not
 * exist in every build, so `@browser` asks whatever registered itself and says so plainly when nothing did.
 */
export type ConsoleSource = (root: string) => string[] | null | Promise<string[] | null>;

let consoleSource: ConsoleSource | null = null;

/** The preview feature calls this once with a function returning the latest console errors for a root (null: no preview open). */
export function registerConsoleSource(fn: ConsoleSource | null): void {
  consoleSource = fn;
}

export async function previewConsoleErrors(root: string): Promise<string[] | null> {
  if (!consoleSource) return null;
  try {
    return await consoleSource(root);
  } catch {
    return null;
  }
}
