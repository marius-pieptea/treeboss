/**
 * The original API: sessions, pairs, MCP, skills, settings, engines, and the MCP shim's tool endpoint.
 */
import { db } from "../../db";
import { allSettings, getSetting, isSettingKey, resetSetting, setSetting } from "../../settings";
import { ASK_EFFORT, askStartModel } from "../../sessions/ask";
import { installedEngines, ENGINES } from "../../engines/registry";
import { HydraPairs, PAIR_COOKBOOK } from "../../hydra/pairs";
import { PAIR_ROLE_LIBRARY } from "../../hydra/roles";
import { McpStore } from "../../mcp/store";
import { SkillStore, defaultSkillNames } from "../../skills/store";
import { builtinStatus, missingBuiltinSkills } from "../../skills/builtin";
import { skillsUsed } from "../../sessions/skilluse";
import { parseMode, setMode } from "../../sessions/plan";
import { Hub, type HubEvent } from "../../sessions/hub";
import { executeSubagentToolStep, SUBAGENT_TOOL_NAMES } from "../../sessions/tools";
import { executePlanTool, PLAN_TOOL_NAMES } from "../../sessions/planq";
import { executeTitleTool, TITLE_TOOL_NAMES } from "../../sessions/title";
import {
  close,
  createChild,
  createLead,
  descendantsOf,
  diff,
  getSession,
  interrupt,
  listSessions,
  merge,
  readLog,
  send,
  viewSession,
  isTurnLive,
  type SessionRecord,
} from "../../sessions/manager";
import { Workspaces, owningWorkspace } from "../../workspaces";
import { workspaceScope } from "./workspaces";
import { BROWSER_TOOL_SET } from "../../browser/defs";
import { EMULATOR_TOOL_SET } from "../../emulator/defs";
import { executeEmulatorTool } from "../../emulator/tools";
import { executeBrowserTool } from "../../browser/tools";
import { COMPUTER_TOOL_SET } from "../../computer/defs";
import { executeComputerTool } from "../../computer/tools";
import { DEVSERVER_TOOL_SET, executeDevserverTool } from "../../devserver/tools";
import { EVIDENCE_TOOL_SET, executeEvidenceTool } from "../../evidence/tools";
import { QA_TOOL_SET } from "../../qa/defs";
import { executeQaTool } from "../../qa/tools";
import { executeTreebossTool, TREEBOSS_TOOL_SET } from "../../treeboss/tools";
import { CHECKLIST_TOOL_SET, executeChecklistTool } from "../../checklists/tools";
import { followSession } from "../live";
import { HttpError, json, type RouteModule } from "../http";

function needSession(id: string): SessionRecord {
  const s = getSession(id);
  if (!s) throw new HttpError(404, `No session "${id}".`);
  return s;
}

/** SSE for one session (and, with `tree=1`, everything under its root): replay from `since`, then follow live. */
function sseStream(req: Request, s: SessionRecord, url: URL): Response {
  const untilIdle = url.searchParams.get("until") === "idle";
  const enc = new TextEncoder();
  let stop: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const end = () => {
        closed = true;
        stop?.();
        if (heartbeat) clearInterval(heartbeat);
      };
      const finish = () => {
        if (closed) return;
        enqueue("done", { session: viewSession(getSession(s.id) ?? s, { full: true }) });
        end();
        try {
          controller.close();
        } catch {}
      };
      const enqueue = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const emit = (event: string, data: unknown) => {
        enqueue(event, data);
        // The watched session's turn ended: that is the end of `trb run`.
        if (untilIdle && event === "turn_end" && (data as { sessionId?: string }).sessionId === s.id) finish();
      };
      stop = followSession(s, { since: Number(url.searchParams.get("since") ?? 0) || 0, tree: url.searchParams.get("tree") === "1", fromTurn: url.searchParams.get("from") === "turn" }, emit);
      if (untilIdle && !isTurnLive(s.id)) return finish();
      heartbeat = setInterval(() => enqueue("ping", { t: Date.now() }), 15_000);
      req.signal.addEventListener("abort", end);
    },
    cancel() {
      stop?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export function coreRoutes(opts: { onShutdown?: () => void }): RouteModule {
  return async (c) => {
    let mm: RegExpMatchArray | null;
    /* ---- tool calls from the MCP shim: caller is the session the shim speaks for ---- */
    if (c.path === "/api/tools/call" && c.method === "POST") {
      const sessionId = c.req.headers.get("x-trb-session");
      if (!sessionId || !getSession(sessionId)) throw new HttpError(400, "x-trb-session names no session.");
      const name = String(c.body.name ?? "");
      // The agent browser's tools (these may return images alongside the text).
      if (BROWSER_TOOL_SET.has(name)) return json(await executeBrowserTool(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId }));
      if (EMULATOR_TOOL_SET.has(name)) return json(await executeEmulatorTool(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId }));
      if (COMPUTER_TOOL_SET.has(name)) return json(await executeComputerTool(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId }));
      if (EVIDENCE_TOOL_SET.has(name)) return json(await executeEvidenceTool(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId }));
      if (DEVSERVER_TOOL_SET.has(name)) return json(executeDevserverTool(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId }));
      if ((PLAN_TOOL_NAMES as readonly string[]).includes(name)) return json(await executePlanTool(name, (c.body.args ?? {}) as Record<string, unknown>, sessionId));
      if ((TITLE_TOOL_NAMES as readonly string[]).includes(name)) return json(executeTitleTool(name, (c.body.args ?? {}) as Record<string, unknown>, sessionId));
      if (TREEBOSS_TOOL_SET.has(name)) return json(executeTreebossTool(name, (c.body.args ?? {}) as Record<string, unknown>, sessionId));
      if (CHECKLIST_TOOL_SET.has(name)) return json(executeChecklistTool(name, (c.body.args ?? {}) as Record<string, unknown>, sessionId));
      if (QA_TOOL_SET.has(name)) return json(await executeQaTool(name, (c.body.args ?? {}) as Record<string, unknown>, sessionId));
      if (!(SUBAGENT_TOOL_NAMES as readonly string[]).includes(name)) throw new HttpError(400, `Unknown tool "${name}".`);
      const out = await executeSubagentToolStep(name, (c.body.args ?? {}) as Record<string, unknown>, { sessionId });
      return json(out.pending ? { text: "", pending: out.pending } : { text: out.text });
    }

    if (c.path === "/api/shutdown" && c.method === "POST") {
      setTimeout(() => opts.onShutdown?.(), 50);
      return json({ ok: true });
    }

    if (c.path === "/api/engines" && c.method === "GET") {
      return json({
        engines: installedEngines().map((e) => {
          const def = ENGINES[e.id];
          return { id: e.id, label: e.label, installed: Boolean(e.bin), bin: e.bin, mcp: def.mcp, skills_dir: def.skillsDir, resume: def.resume };
        }),
      });
    }

    /* ---- sessions ---- */
    if (c.path === "/api/sessions" && c.method === "POST") {
      // Ask mode starts a session on the engine's cheap model at low effort, unless the caller chose a model, a pair or an agent.
      const asking = parseMode(c.body.mode) === "ask";
      const wantModel = c.body.model ? String(c.body.model) : null;
      let askModel: string | null = null;
      if (asking && !wantModel && !c.body.pair && !c.body.agent) {
        const eng = String(c.body.engine || getSetting("default_engine"));
        askModel = (await askStartModel(eng)).model;
      }
      const s = createLead({
        prompt: String(c.body.prompt ?? ""),
        title: c.body.title,
        engine: c.body.engine,
        model: wantModel ?? askModel,
        effort: c.body.effort || (askModel ? ASK_EFFORT : undefined),
        pairId: c.body.pair,
        cwd: String(c.body.cwd ?? process.cwd()),
        isolate: c.body.isolate === true,
        subagents: c.body.subagents !== false,
        agent: c.body.agent,
        skills: Array.isArray(c.body.skills) ? c.body.skills : null,
        mode: parseMode(c.body.mode),
        planDepth: c.body.plan_depth === "spec" ? "spec" : null,
        specs: Array.isArray(c.body.specs) ? c.body.specs.map((x: any) => ({ path: String(x?.path ?? ""), mode: x?.mode === "inline" ? ("inline" as const) : ("ref" as const), purpose: "context" as const })) : null,
        docs: Array.isArray(c.body.docs) ? c.body.docs.map((x: any) => ({ path: String(x?.path ?? ""), mode: x?.mode === "inline" ? ("inline" as const) : ("ref" as const), purpose: "context" as const })) : null,
        attachments: Array.isArray(c.body.attachments) ? c.body.attachments.map((x: any) => ({ path: String(x?.path ?? ""), mode: x?.mode === "inline" ? ("inline" as const) : ("ref" as const) })) : null,
        goal: c.body.goal && typeof c.body.goal === "object" ? { text: c.body.goal.text, check: c.body.goal.check, maxTurns: c.body.goal.max_turns, maxMinutes: c.body.goal.max_minutes } : null,
        treeboss: typeof c.body.treeboss === "boolean" ? c.body.treeboss : null,
      });
      return json({ session: viewSession(s, { withOutput: false }) }, 201);
    }
    if (c.path === "/api/sessions" && c.method === "GET") {
      const status = c.q("status");
      const wsId = c.q("workspace");
      const ws = wsId ? Workspaces.get(wsId) : null;
      if (wsId && !ws) throw new HttpError(404, `No workspace "${wsId}".`);
      const list = listSessions({
        within: ws ? workspaceScope(ws) : undefined,
        leadsOnly: c.q("all") !== "1",
        rootId: c.q("root") ?? undefined,
        parentId: c.q("parent") ?? undefined,
        status: (status as any) || (c.q("closed") === "1" ? null : "open"),
        limit: Number(c.q("limit") ?? 50),
      });
      return json({ sessions: list.map((s) => viewSession(s, { withOutput: false })) });
    }
    // Before /api/sessions/:id, which would otherwise take "pinned" for a session id.
    if (c.path === "/api/sessions/pinned" && c.method === "GET") {
      // Pinned leads from every workspace, oldest pin first, each with the workspace it belongs to (null if none is registered).
      const pinned = listSessions({ leadsOnly: true, pinned: true, limit: 500 }).sort((a, b) => (a.pinned_at! < b.pinned_at! ? -1 : a.pinned_at! > b.pinned_at! ? 1 : 0));
      return json({
        sessions: pinned.map((s) => {
          const wsId = owningWorkspace(s.base_cwd);
          return { ...viewSession(s, { withOutput: false }), workspace_id: wsId, workspace_name: wsId ? (Workspaces.get(wsId)?.name ?? null) : null };
        }),
      });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)$/)) && c.method === "GET") {
      const s = needSession(mm[1]);
      // workspace_id: the workspace the session belongs to (null if none is registered), so a client can switch there before opening it.
      return json({ session: viewSession(s, { full: true }), brief: s.brief, children: descendantsOf(s.id).map((k) => viewSession(k, { withOutput: false })), workspace_id: owningWorkspace(s.base_cwd) });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/send$/)) && c.method === "POST") {
      // The log cursor BEFORE the turn starts (its first line is written synchronously), so a client
      // follows only the new turn instead of replaying the whole history.
      const cursor = (db().prepare("SELECT COALESCE(MAX(id), 0) AS n FROM events").get() as { n: number }).n;
      const wantMode = parseMode(c.body.mode);
      if (wantMode) setMode(mm[1], wantMode);
      return json({ session: viewSession(send({ operator: true }, mm[1], String(c.body.message ?? "")), { withOutput: false }), cursor });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/spawn$/)) && c.method === "POST") {
      needSession(mm[1]);
      const s = createChild({ caller: { operator: true }, parentId: mm[1], brief: String(c.body.brief ?? ""), title: c.body.title, role: c.body.role, agent: c.body.agent, engine: c.body.engine, model: c.body.model, effort: c.body.effort, isolate: c.body.isolate ?? "auto" });
      return json({ session: viewSession(s, { withOutput: false }) }, 201);
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/interrupt$/)) && c.method === "POST") {
      return json({ session: viewSession(await interrupt({ operator: true }, mm[1]), { withOutput: false }) });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/close$/)) && c.method === "POST") {
      return json({ session: viewSession(await close({ operator: true }, mm[1]), { withOutput: false }) });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/merge$/)) && c.method === "POST") {
      const r = merge({ operator: true }, mm[1]);
      return json({ merged: r.merged, message: r.message, files: r.files });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/diff$/)) && c.method === "GET") {
      needSession(mm[1]);
      return diff(mm[1]).then((d) => json(d ?? { diff: "", truncated: false, note: "This session has no worktree." }));
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/logs$/)) && c.method === "GET") {
      const s = needSession(mm[1]);
      const tree = c.q("tree") === "1";
      const ids = tree ? [s.id, ...descendantsOf(s.id).map((k) => k.id)] : [s.id];
      const since = Number(c.q("since") ?? 0) || 0;
      const limit = Number(c.q("limit") ?? 2000);
      const lines = ids.flatMap((id) => readLog(id, { sinceId: since, limit }).map((r) => ({ ...r, session: id }))).sort((a, b) => a.id - b.id);
      return json({ lines });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/skills$/)) && c.method === "GET") {
      const s = needSession(mm[1]);
      const ids = c.q("tree") === "1" ? [s.id, ...descendantsOf(s.id).map((k) => k.id)] : [s.id];
      return json({ skills: skillsUsed(ids) });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/turns$/)) && c.method === "GET") {
      needSession(mm[1]);
      return json({ turns: db().prepare("SELECT id, seq, status, started_at, finished_at, cost_usd, mode, usage_json, next_json, substr(prompt, 1, 4000) AS prompt, output FROM turns WHERE session_id = ? ORDER BY seq").all(mm[1]) });
    }
    if ((mm = c.match(/^\/api\/sessions\/([^/]+)\/events$/)) && c.method === "GET") {
      return sseStream(c.req, needSession(mm[1]), c.url);
    }

    /* ---- pairs ---- */
    if (c.path === "/api/pairs" && c.method === "GET") return json({ pairs: HydraPairs.list() });
    if (c.path === "/api/pairs" && c.method === "POST") return json({ pair: c.body.recipe ? HydraPairs.fromCookbook(String(c.body.recipe)) : HydraPairs.create(c.body as any) }, 201);
    if (c.path === "/api/pairs/cookbook" && c.method === "GET") return json({ recipes: PAIR_COOKBOOK });
    if (c.path === "/api/roles" && c.method === "GET") return json({ roles: PAIR_ROLE_LIBRARY });
    if ((mm = c.match(/^\/api\/pairs\/([^/]+)$/))) {
      const pair = HydraPairs.find(mm[1]);
      if (!pair) throw new HttpError(404, `No pair "${mm[1]}".`);
      if (c.method === "GET") return json({ pair });
      if (c.method === "PATCH") return json({ pair: HydraPairs.update(pair.id, c.body as any) });
      if (c.method === "DELETE") return json({ removed: HydraPairs.remove(pair.id) });
    }

    /* ---- mcp ---- */
    if (c.path === "/api/mcp" && c.method === "GET") return json({ servers: McpStore.list() });
    if (c.path === "/api/mcp" && c.method === "POST") return json({ server: McpStore.put(c.body as any) }, 201);
    if ((mm = c.match(/^\/api\/mcp\/([^/]+)$/)) && c.method === "DELETE") return json({ removed: McpStore.remove(mm[1]) });
    if ((mm = c.match(/^\/api\/mcp\/([^/]+)\/(enable|disable)$/)) && c.method === "POST") return json({ ok: McpStore.setEnabled(mm[1], mm[2] === "enable") });

    /* ---- skills ---- */
    if (c.path === "/api/skills" && c.method === "GET") {
      const dflt = new Set(defaultSkillNames());
      return json({ skills: SkillStore.list().map((s) => ({ ...s, ...builtinStatus(s), default: dflt.has(s.name) })), missingBuiltins: missingBuiltinSkills() });
    }
    if (c.path === "/api/skills" && c.method === "POST") return json({ skill: SkillStore.add(String(c.body.path ?? ""), { name: c.body.name, overwrite: c.body.force === true }) }, 201);
    if ((mm = c.match(/^\/api\/skills\/([^/]+)$/)) && c.method === "DELETE") return json({ removed: SkillStore.remove(mm[1]) });
    if ((mm = c.match(/^\/api\/skills\/([^/]+)\/(enable|disable)$/)) && c.method === "POST") return json({ ok: SkillStore.setEnabled(mm[1], mm[2] === "enable") });

    /* ---- config ---- */
    if (c.path === "/api/config" && c.method === "GET") return json({ settings: allSettings() });
    if ((mm = c.match(/^\/api\/config\/([^/]+)$/))) {
      if (!isSettingKey(mm[1])) throw new HttpError(404, `Unknown setting "${mm[1]}".`);
      if (c.method === "PUT") {
        setSetting(mm[1], String(c.body.value ?? ""));
        return json({ ok: true });
      }
      if (c.method === "DELETE") {
        resetSetting(mm[1]);
        return json({ ok: true });
      }
    }

    return null;
  };
}
