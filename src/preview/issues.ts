/** Console errors and failed requests reported by previewed pages, kept per target dev-server port. */
import { registerConsoleSource } from "../context/sources";

export type IssueLevel = "error" | "warning" | "page-error" | "failed-request";

export interface Issue {
  ts: number;
  level: IssueLevel;
  text: string;
  url?: string;
  page?: string;
}

const RING = 200;
const MAX_TARGETS = 20;
const LEVELS: IssueLevel[] = ["error", "warning", "page-error", "failed-request"];

const buffers = new Map<number, Issue[]>();
let lastTarget: number | null = null;

export function recordIssues(target: number, raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let buf = buffers.get(target);
  if (!buf) {
    if (buffers.size >= MAX_TARGETS) buffers.delete(buffers.keys().next().value as number);
    buffers.set(target, (buf = []));
  }
  let n = 0;
  for (const e of raw.slice(0, 50)) {
    if (!e || typeof e !== "object") continue;
    const level = LEVELS.includes((e as any).level) ? ((e as any).level as IssueLevel) : "error";
    const text = String((e as any).text ?? "").slice(0, 600);
    if (!text) continue;
    buf.push({ ts: Date.now(), level, text, url: typeof (e as any).url === "string" ? (e as any).url.slice(0, 300) : undefined, page: typeof (e as any).page === "string" ? (e as any).page.slice(0, 200) : undefined });
    n++;
  }
  if (buf.length > RING) buf.splice(0, buf.length - RING);
  if (n) lastTarget = target;
  return n;
}

export function readIssues(target: number, opts: { level?: string; clear?: boolean } = {}): Issue[] {
  const buf = buffers.get(target) ?? [];
  const out = opts.level && opts.level !== "all" ? buf.filter((i) => i.level === opts.level || (opts.level === "error" && i.level === "page-error")) : [...buf];
  if (opts.clear) buffers.delete(target);
  return out;
}

export function issueCount(target: number): number {
  return buffers.get(target)?.length ?? 0;
}

export function lastIssueTarget(): number | null {
  return lastTarget;
}

export function formatIssues(target: number, issues: Issue[]): string {
  if (!issues.length) return `No console errors or failed requests recorded for localhost:${target}.`;
  const lines = issues.map((i) => `[${new Date(i.ts).toISOString().slice(11, 19)}] ${i.level}${i.page ? ` ${i.page}` : ""}: ${i.text}`);
  return `Preview issues for localhost:${target} (${issues.length}, newest last):\n${lines.join("\n")}`;
}

export function _resetIssues(): void {
  buffers.clear();
  lastTarget = null;
}

/** `@browser` in the composer reads the latest issues of the preview that last reported any. */
registerConsoleSource(() => {
  const target = lastIssueTarget();
  if (target === null) return null;
  const issues = readIssues(target);
  return issues.length ? formatIssues(target, issues).split("\n") : [];
});
