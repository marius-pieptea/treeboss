/** Pure logic for the Run panel and the preview's Inspect mode. */

export interface RunService {
  id: string;
  label: string;
  kind: "dev" | "task";
  dir: string;
  command: string;
  source: "package.json" | "Procfile";
  script?: string;
}
export interface EnvFile {
  file: string;
  keys: string[];
}
export interface Detected {
  packageManager: string | null;
  services: RunService[];
  db: RunService[];
  envFiles: EnvFile[];
}
export type RunStatus = "starting" | "running" | "stopping" | "stopped" | "exited" | "failed";
export interface Instance {
  key: string;
  service: string;
  kind: "dev" | "task";
  command: string;
  status: RunStatus;
  pid: number | null;
  port: number | null;
  url: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  owner: string;
}
export interface RunInfo {
  root: string;
  dir: string;
  detected: Detected;
  instances: Instance[];
}
export interface LogLine {
  seq: number;
  stream: "out" | "err" | "sys";
  text: string;
}
export interface Issue {
  ts: number;
  level: "error" | "warning" | "page-error" | "failed-request";
  text: string;
  url?: string;
  page?: string;
}

/** The directory the Run panel works on: the open session's working copy (a head's worktree), else the workspace. */
export const runRoot = (activeSession: string | null | undefined, workspaceId: string): string => (activeSession && activeSession.startsWith("s_") ? activeSession : workspaceId);

export const isLive = (i: Instance | undefined | null): boolean => !!i && (i.status === "starting" || i.status === "running" || i.status === "stopping");

/** The dev server the preview should point at: a running one beats a starting one; newest first. */
export function previewTarget(instances: Instance[]): Instance | null {
  const dev = instances.filter((i) => i.kind === "dev" && i.url && (i.status === "running" || i.status === "starting"));
  dev.sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === "running" ? -1 : 1));
  return dev[0] ?? null;
}

export function statusLabel(i: Instance | undefined | null): string {
  if (!i) return "Not started";
  switch (i.status) {
    case "starting":
      return "Starting…";
    case "running":
      return i.kind === "task" ? "Running…" : "Running";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "exited":
      return "Done";
    case "failed":
      return i.exitCode !== null ? `Failed (exit ${i.exitCode})` : "Failed";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The dev-server port behind a preview address, when it is a loopback one (the only kind Inspect can proxy). */
export function loopbackPort(url: string | null): number | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return null;
    const p = Number(u.port || 80);
    return p >= 1 && p <= 65535 ? p : null;
  } catch {
    return null;
  }
}

/** The preview address, served by the inspecting proxy: same host name (already the "other" loopback name), proxy port. */
export function proxiedUrl(url: string, proxyPort: number): string {
  const u = new URL(url);
  u.port = String(proxyPort);
  return u.toString();
}

/** What a picked element message from the page must look like before the app forwards it. */
export function isPickMessage(d: unknown): d is { type: "trb-pick"; selector: string; path?: string } & Record<string, unknown> {
  return !!d && typeof d === "object" && (d as any).type === "trb-pick" && typeof (d as any).selector === "string" && (d as any).selector.length > 0;
}

export function formatIssuesForComposer(port: number, issues: Issue[]): string {
  if (!issues.length) return "";
  const lines = issues.slice(-40).map((i) => `- ${i.level}${i.page ? ` ${i.page}` : ""}: ${i.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return `[Console errors and failed requests from the live preview (localhost:${port})]\n${lines.join("\n")}\n`;
}

export function errorCount(issues: Issue[]): number {
  return issues.filter((i) => i.level !== "warning").length;
}
