/** Terminal API: create / list / kill over HTTP; attach over WebSocket (see `terminalSocket`). */
import { resolveRoot } from "../../workspaces";
import { getSession } from "../../sessions/manager";
import { getEngine, resolveBinary } from "../../engines/registry";
import { createTerminal, getTerminal, killTerminal, listTerminals, renameTerminal, resizeTerminal, subscribeTerminal, terminalScrollback, writeTerminal } from "../../terminal/pty";
import { HttpError, json, type RouteModule } from "../http";

export const terminalRoutes: RouteModule = (c) => {
  let m: RegExpMatchArray | null;
  if (c.path === "/api/terminals" && c.method === "GET") return json({ terminals: listTerminals(c.q("root") ?? undefined) });

  if (c.path === "/api/terminals" && c.method === "POST") {
    const root = resolveRoot(String(c.body.root ?? ""));
    let command: string[] | undefined;
    let title: string | undefined = c.body.title;
    // Continue an agent's conversation by hand, in the directory it worked in.
    if (c.body.resumeSession) {
      const s = getSession(String(c.body.resumeSession));
      if (!s) throw new HttpError(404, "No such session.");
      const def = getEngine(s.engine);
      const bin = def ? resolveBinary(def) : null;
      if (!def || !bin) throw new HttpError(400, `${s.engine} is not installed.`);
      if (!s.cli_session_id) throw new HttpError(400, "That session has no engine conversation to resume yet.");
      const resume = interactiveResume(s.engine, bin, s.cli_session_id);
      if (!resume) throw new HttpError(400, `${def.label} has no interactive resume.`);
      command = resume;
      title = title ?? `${s.role ?? s.engine}: ${s.title}`.slice(0, 40);
    }
    return json({ terminal: createTerminal({ rootRef: root.ref, cwd: root.dir, cols: c.body.cols, rows: c.body.rows, title, command }) }, 201);
  }

  if ((m = c.match(/^\/api\/terminals\/([^/]+)$/))) {
    const t = getTerminal(m[1]);
    if (!t) throw new HttpError(404, "No such terminal.");
    if (c.method === "GET") return json({ terminal: t });
    if (c.method === "PATCH") {
      renameTerminal(t.id, String(c.body.title ?? t.title));
      return json({ terminal: getTerminal(t.id) });
    }
    if (c.method === "DELETE") return json({ killed: killTerminal(t.id) });
  }
  return null;
};

/** The engine's own interactive "continue this conversation" command. */
export function interactiveResume(engine: string, bin: string, id: string): string[] | null {
  switch (engine) {
    case "claude":
      return [bin, "--resume", id];
    case "codex":
      return [bin, "resume", id];
    case "cursor":
      return [bin, "--resume", id];
    case "opencode":
      return [bin, "--session", id];
    default:
      return null;
  }
}

/**
 * WebSocket protocol, JSON frames both ways.
 *   client → { type: "input", data } | { type: "resize", cols, rows }
 *   server → { t: "replay", d } (once, on attach) | { t: "out", d } | { t: "exit", code }
 */
export interface TerminalSocketData {
  kind: "term";
  termId: string;
  unsubscribe?: (() => void) | null;
}

export const terminalSocket = {
  open(ws: { data: TerminalSocketData; send(s: string): void; close(code?: number): void }) {
    const t = getTerminal(ws.data.termId);
    if (!t) return ws.close(4404);
    // Subscribe before replaying so no output falls in the gap.
    ws.data.unsubscribe = subscribeTerminal(t.id, (msg) => ws.send(JSON.stringify(msg)));
    ws.send(JSON.stringify({ t: "replay", d: terminalScrollback(t.id), cols: t.cols, rows: t.rows }));
    if (!t.alive) ws.send(JSON.stringify({ t: "exit", code: t.exitCode }));
  },
  message(ws: { data: TerminalSocketData }, raw: string | Buffer) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") writeTerminal(ws.data.termId, msg.data);
    else if (msg.type === "resize") resizeTerminal(ws.data.termId, Number(msg.cols), Number(msg.rows));
  },
  close(ws: { data: TerminalSocketData }) {
    ws.data.unsubscribe?.();
  },
};
