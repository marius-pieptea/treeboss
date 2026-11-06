/**
 * Runs one external CLI as an argv array (never a shell). Output streams to `onLog` as it arrives and is
 * also returned. Secrets are merged into the child's environment only.
 */
import type { ProviderStatus } from "./types";

export interface ExecResult {
  code: number;
  output: string;
}

export interface ExecOptions {
  cwd: string;
  /** Extra child env (secrets). Merged over the daemon's env. */
  env?: Record<string, string>;
  onLog?: (text: string) => void;
  signal?: AbortSignal;
}

export async function runArgv(argv: string[], o: ExecOptions): Promise<ExecResult> {
  if (!argv.length || !argv[0]) throw new Error("No command to run.");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (e: any) {
    const why = e?.code === "ENOENT" ? "is not installed or not on PATH" : `could not start (${e?.message ?? e})`;
    const msg = `${argv[0]} ${why}.\n`;
    o.onLog?.(msg);
    return { code: 127, output: msg };
  }
  const onAbort = () => proc.kill();
  o.signal?.addEventListener("abort", onAbort, { once: true });

  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      output += text;
      o.onLog?.(text);
    }
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  const code = await proc.exited;
  o.signal?.removeEventListener("abort", onAbort);
  return { code, output };
}

/** The first https URL in some CLI output, preferring one that matches `prefer` (for example ".workers.dev"). */
export function urlIn(output: string, prefer?: RegExp): string | null {
  const urls = [...output.matchAll(/https:\/\/[^\s'"<>)\]]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
  if (!urls.length) return null;
  return (prefer && urls.find((u) => prefer.test(u))) || urls[urls.length - 1]!;
}

/** Replace every secret value in `text` with a fixed mask. Short values are skipped (they match too much). */
export function redact(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(secrets)) if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}

/** A GET on the deploy URL with a short timeout. Reports up, down or unknown; never throws. */
export async function probeUrl(url: string | null, checkedAt = new Date().toISOString()): Promise<ProviderStatus> {
  if (!url) return { state: "unknown", url: null, httpStatus: null, checkedAt };
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
    return { state: res.status < 500 ? "up" : "down", url, httpStatus: res.status, checkedAt };
  } catch {
    return { state: "down", url, httpStatus: null, checkedAt };
  }
}
