/**
 * Choosing a port for a dev server, and telling the server about it.
 *
 * Every directory gets its own port: the search starts at an offset derived from the directory, so a head's
 * worktree lands on the same port each time when it is free, and two heads never fight over one.
 */
import net from "net";
import type { PackageManager } from "./detect";

export const PORT_MIN = 4100;
export const PORT_MAX = 4899;

export function canBind(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The first free port from this directory's own starting point, skipping `taken` (ports we already handed out). */
export async function pickPort(seed: string, taken: Iterable<number> = [], bindable: (p: number) => Promise<boolean> = canBind): Promise<number> {
  const skip = new Set(taken);
  const span = PORT_MAX - PORT_MIN + 1;
  const start = hash(seed) % span;
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start + i) % span);
    if (skip.has(port)) continue;
    // Both families: a server on ::1 only would not stop a 127.0.0.1 bind, but the browser may still resolve to it.
    if ((await bindable(port)) && (await canBind(port, "::1").catch(() => true))) return port;
  }
  throw new Error(`No free port between ${PORT_MIN} and ${PORT_MAX}.`);
}

/**
 * Extra arguments that make the script listen on `port`. Env `PORT` covers most servers (express, CRA, next
 * reads it too); vite and a few others ignore it, so those get a flag, but only when the script is a plain
 * call of that tool (a wrapper like `concurrently` would take the flag for itself).
 */
export function portArgs(script: string | undefined, port: number): string[] {
  const s = script ?? "";
  if (!s || /\b(concurrently|npm-run-all|run-p|run-s|turbo|nx)\b|&&|;|\|/.test(s)) return [];
  if (/\bvite\b/.test(s)) return ["--port", String(port), "--strictPort"];
  if (/\bnext\b/.test(s)) return ["-p", String(port)];
  if (/\b(astro|nuxt|nuxi|svelte-kit|sveltekit)\b/.test(s)) return ["--port", String(port)];
  return [];
}

/** The command line with the port arguments appended the way each package manager passes them on. */
export function withPortArgs(command: string, pm: PackageManager | null, args: string[]): string {
  if (!args.length) return command;
  const quoted = args.join(" ");
  if (pm === "npm" || pm === "pnpm") return `${command} -- ${quoted}`;
  return `${command} ${quoted}`;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/;

/** A port a dev server announced in its output ("Local: http://localhost:5173/"). */
export function portFromOutput(line: string): number | null {
  const m = URL_RE.exec(line);
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535 ? p : null;
}
