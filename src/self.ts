import path from "path";

/**
 * How to re-invoke this program as a child (the MCP shim a CLI engine spawns).
 * `bun run src/cli/main.ts …` today; `TRB_SELF="/usr/local/bin/trb"` once it is
 * a compiled binary.
 */
export function selfInvocation(): { command: string; args: string[] } {
  const override = process.env.TRB_SELF?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  // A `bun build --compile` binary is its own entry point: re-run it with no script path.
  if (import.meta.dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]~BUN/.test(import.meta.dir)) return { command: process.execPath, args: [] };
  return { command: process.execPath, args: [path.resolve(import.meta.dir, "cli", "main.ts")] };
}
