/**
 * Two read-only tools for agents: what the app's dev server is saying, and what the preview page is
 * complaining about. Definitions are in defs.ts so the MCP shim can list them without loading this.
 */
import fs from "fs";
import { getSession } from "../sessions/manager";
import { formatIssues, lastIssueTarget, readIssues } from "../preview/issues";
import { listInstances, readLogs, runningDev } from "./manager";

export { DEVSERVER_TOOL_SET } from "./defs";

export function executeDevserverTool(name: string, args: Record<string, unknown>, caller: { sessionId: string }): { text: string } {
  const s = getSession(caller.sessionId);
  if (!s) return { text: "Error: unknown session." };
  let dir: string;
  try {
    dir = fs.realpathSync(s.cwd);
  } catch {
    return { text: "Error: the working directory is gone." };
  }
  if (name === "devserver_logs") {
    const all = listInstances(dir);
    const wanted = typeof args.service === "string" && args.service ? args.service : (runningDev(dir) ?? all[0])?.service;
    if (!wanted) return { text: "Nothing has been started from the Run panel for this directory." };
    const n = Math.min(Math.max(Number(args.lines) || 80, 1), 400);
    const r = readLogs(dir, wanted, 0, n);
    const i = r.instance;
    if (!i) return { text: `No instance "${wanted}". Known: ${all.map((x) => x.service).join(", ") || "none"}.` };
    return { text: `${i.service}: ${i.status}${i.url ? ` at ${i.url}` : ""}${i.exitCode !== null ? ` (exit ${i.exitCode})` : ""}\n${r.lines.map((l) => l.text).join("\n")}` };
  }
  if (name === "preview_console") {
    const dev = runningDev(dir);
    const port = dev?.port ?? lastIssueTarget();
    if (!port) return { text: "No preview has reported anything yet (Inspect must be on in the Browser tab)." };
    const issues = readIssues(port, { level: typeof args.level === "string" ? args.level : undefined, clear: args.clear === true });
    return { text: formatIssues(port, issues) };
  }
  return { text: `Error: unknown tool "${name}".` };
}
