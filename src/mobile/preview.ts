/**
 * A device preview for an Expo app: `expo start --tunnel`, one process per project directory, and the
 * exp:// URL it prints, with a QR code, so a phone can open the app in Expo Go even off the LAN.
 *
 * The devserver manager only starts package.json scripts and cannot pass --tunnel, so the preview owns its
 * process here. It is started on first request and kept until it exits or stopExpoPreview is called.
 */
import { qrSvg } from "../remote/qr";
import { detectMobile } from "./detect";
import { MobileError } from "./eas";

export interface ExpoPreview {
  url: string;
  /** A QR code for the URL, as an SVG string. */
  svg: string;
  startedAt: string;
  /** False when a preview was already running and was reused. */
  started: boolean;
}

interface Running {
  url: string;
  startedAt: string;
  proc: Bun.Subprocess;
}

const running = new Map<string, Running>();
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /exp:\/\/[^\s"'`]+(?=[\s"'`])/;

/** The first exp:// address in CLI output. The URL must be followed by a delimiter, so a half-written one is not taken. */
export function findPreviewUrl(text: string): string | null {
  return URL_RE.exec(text.replace(ANSI, ""))?.[0] ?? null;
}

function command(): string[] {
  return [Bun.which("npx") ?? "npx", "--yes", "expo", "start", "--tunnel", "--non-interactive"];
}

function waitForUrl(proc: Bun.Subprocess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new MobileError(`expo start did not print a tunnel URL within ${Math.round(timeoutMs / 1000)}s.`)));
      proc.kill();
    }, timeoutMs);
    const read = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const dec = new TextDecoder();
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        text += dec.decode(chunk, { stream: true });
        const url = findPreviewUrl(text);
        if (url) settle(() => resolve(url));
      }
    };
    void read(proc.stdout as ReadableStream<Uint8Array>);
    void read(proc.stderr as ReadableStream<Uint8Array>);
    proc.exited.then((code) => settle(() => reject(new MobileError(`expo start exited ${code} before it printed a tunnel URL.${text.trim() ? `\n${text.replace(ANSI, "").trim().split("\n").slice(-6).join("\n")}` : ""}`))));
  });
}

/** The live preview for a project, starting `expo start --tunnel` when none is running. */
export async function expoGoUrl(dir: string, opts: { timeoutMs?: number } = {}): Promise<ExpoPreview> {
  if (!detectMobile(dir).isExpo) throw new MobileError("This is not an Expo project, so there is no Expo Go preview.");
  const live = running.get(dir);
  if (live && live.proc.exitCode === null) return { url: live.url, svg: qrSvg(live.url), startedAt: live.startedAt, started: false };
  const proc = Bun.spawn(command(), { cwd: dir, env: { ...process.env, CI: "1", BROWSER: "none", NO_COLOR: "1" } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const url = await waitForUrl(proc, opts.timeoutMs ?? 120_000);
  const entry: Running = { url, startedAt: new Date().toISOString(), proc };
  running.set(dir, entry);
  void proc.exited.then(() => {
    if (running.get(dir) === entry) running.delete(dir);
  });
  return { url, svg: qrSvg(url), startedAt: entry.startedAt, started: true };
}

/** Stops the preview of a project. Returns false when none was running. */
export function stopExpoPreview(dir: string): boolean {
  const live = running.get(dir);
  if (!live) return false;
  running.delete(dir);
  live.proc.kill();
  return true;
}

/** For the daemon's shutdown: every preview process goes with it. */
export function stopAllExpoPreviews(): void {
  for (const dir of [...running.keys()]) stopExpoPreview(dir);
}
