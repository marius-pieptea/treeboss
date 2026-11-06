/**
 * What a turn needs to know about the daemon it runs under: the URL and token its MCP shim
 * calls back on. Set by the daemon at startup. Absent in a bare library use (a test), in which
 * case a turn simply runs without the subagent tools.
 */
export interface DaemonContext {
  url: string;
  token: string;
}

let ctx: DaemonContext | null = null;

export function setDaemonContext(next: DaemonContext | null): void {
  ctx = next;
}

export function getDaemonContext(): DaemonContext | null {
  return ctx;
}
