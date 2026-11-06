/**
 * The daemon's HTTP surface. Local only (127.0.0.1).
 *
 *   /api/*        JSON + SSE + WebSocket, authenticated: `Authorization: Bearer <token>` (the CLI, the MCP
 *                 shim) or the HttpOnly session cookie (the web UI).
 *   /_auth        trades a one-time ticket for that cookie (see ui.ts).
 *   everything else  the built web UI.
 *
 * Why a daemon at all: a coding turn is a child process that can run for an hour, a lead's subagents
 * outlive any one terminal, and the MCP shim a CLI engine spawns needs something to call back.
 *
 * Routes live in routes/*.ts as small modules; this file only authenticates and dispatches.
 */
import { VERSION } from "../version";
import { HttpError, bodyOf, json, makeCtx, safeEqual, type RouteModule } from "./http";
import { coreRoutes } from "./routes/core";
import { workspaceRoutes } from "./routes/workspaces";
import { fsRoutes } from "./routes/fs";
import { gitRoutes } from "./routes/git";
import { terminalRoutes, terminalSocket, type TerminalSocketData } from "./routes/terminal";
import { streamRoutes } from "./routes/stream";
import { agentRoutes } from "./routes/agents";
import { modelRoutes } from "./routes/models";
import { skillsImportRoutes } from "./routes/skills_import";
import { goalPlanRoutes } from "./routes/goalPlan";
import { sessionModelRoutes } from "./routes/sessionModel";
import { planqRoutes } from "./routes/planq";
import { askRoutes } from "./routes/ask";
import { codegraphRoutes } from "./routes/codegraph";
import { handoffRoutes } from "./routes/handoff";
import { specsRoutes } from "./routes/specs";
import { attachmentsRoutes } from "./routes/attachments";
import { docsRoutes } from "./routes/docs";
import { roadmapRoutes } from "./routes/roadmap";
import { productRoutes } from "./routes/products";
import { autopilotRoutes } from "./routes/autopilot";
import { ciRoutes } from "./routes/ci";
import { deployRoutes } from "./routes/deploy";
import { releasesRoutes } from "./routes/releases";
import { checklistsRoutes } from "./routes/checklists";
import { mobileRoutes } from "./routes/mobile";
import { secretsRoutes } from "./routes/secrets";
import { labRoutes } from "./routes/lab";
import { qaRoutes } from "./routes/qa";
import { signalsRoutes, isPublicSignalsPath, feedbackIntake } from "./routes/signals";
import { memoryRoutes } from "./routes/memory";
import { practicesRoutes } from "./routes/practices";
import { evidenceRoutes } from "./routes/evidence";
import { reaRoutes } from "./routes/rea";
import { scaffoldRoutes } from "./routes/scaffold";
import { designFoldRoutes, designRoutes } from "./routes/design";
import { sessionsExtRoutes } from "./routes/x_sessions";
import { settingsExtRoutes } from "./routes/x_settings";
import { gitExtRoutes } from "./routes/x_git";
import { fsExtRoutes } from "./routes/x_fs";
import { browserExtRoutes } from "./routes/x_browser";
import { emulatorRoutes } from "./routes/emulator";
import { lifecycleRoutes } from "./routes/lifecycle";
import { contextRoutes } from "./routes/context";
import { searchRoutes } from "./routes/search";
import { devserverRoutes } from "./routes/x_devserver";
import { COOKIE, cookieFrom, mintTicket, redeemTicket, serveStatic, sessionCookie } from "./ui";
import { remoteRoutes } from "./routes/remote";
import { getTerminal } from "../terminal/pty";
import { authenticateRemote, closeAllRemoteSockets, handlePair, remoteOriginOk, sweepSockets, trackSocket, untrackSocket, type Principal } from "../remote/auth";
import { hostAllowed, isLoopbackName, isLoopbackPeer, migrateRemoteMode, ownerMayAuthenticate, remoteConfig } from "../remote/hosts";
import { reconcileListener, stopListener, type ServeFn } from "../remote/listener";
import { refreshTailscale } from "../remote/network";
import { remoteAllowed, remoteMaySocket } from "../remote/policy";
import { liveSocket, type LiveSocketData } from "./live";
import { RootError } from "../workspaces";
import { ConflictError } from "../fs/files";
import { GitError } from "../git/ops";
import { SessionError } from "../sessions/manager";
import { UserError } from "../util";
import { onSettingChanged } from "../settings";

export { VERSION };

export interface ServerOptions {
  port: number;
  token: string;
  onShutdown?: () => void;
  /** Interface of the always-on listener. Loopback; tests only ever pass loopback. */
  hostname?: string;
  /** Opens the second listener for remote_mode lan/tailscale (remote/listener.ts). Tests inject a fake so nothing real is bound. */
  remoteServe?: ServeFn;
}

export function startServer(opts: ServerOptions) {
  const startedAt = Date.now();
  const modules: RouteModule[] = [skillsImportRoutes, goalPlanRoutes, sessionModelRoutes, planqRoutes, askRoutes, attachmentsRoutes, specsRoutes, docsRoutes, roadmapRoutes, productRoutes, autopilotRoutes, ciRoutes, deployRoutes, releasesRoutes, checklistsRoutes, mobileRoutes, labRoutes, qaRoutes, signalsRoutes, memoryRoutes, practicesRoutes, evidenceRoutes, reaRoutes, scaffoldRoutes, designRoutes, codegraphRoutes, coreRoutes({ onShutdown: opts.onShutdown }), remoteRoutes, handoffRoutes, secretsRoutes, workspaceRoutes, fsRoutes, gitRoutes, terminalRoutes, streamRoutes, agentRoutes, modelRoutes, sessionsExtRoutes, settingsExtRoutes, gitExtRoutes, fsExtRoutes, browserExtRoutes, emulatorRoutes, lifecycleRoutes, devserverRoutes];
  // Context chips are folded into the prompt before the core session routes see the request, so this goes first.
  modules.unshift(contextRoutes, searchRoutes);
  // A design turn is wrapped before the context chips are folded in front of it (see routes/design.ts).
  modules.unshift(designFoldRoutes);

  /** Same-origin check for requests that carry the cookie, which a hostile page could otherwise trigger. */
  const originOk = (req: Request, port: number): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true; // not a browser fetch from another page
    return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };

  /**
   * Who is calling. The owner (the 0600 bearer token, or the cookie `trb ui` signs in) counts only on a loopback Host from a
   * loopback peer; anything else must present a paired device's remote token, which is refused while remote access is off.
   */
  const authenticate = (req: Request, peer: string | null): Principal | null => {
    if (ownerMayAuthenticate(req.headers.get("host") ?? "", peer)) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth.startsWith("Bearer ") && safeEqual(auth.slice(7), opts.token)) return { kind: "owner", via: "bearer" };
      const cookie = cookieFrom(req);
      if (cookie && safeEqual(cookie, opts.token)) return { kind: "owner", via: "cookie" };
    }
    return authenticateRemote(req, peer);
  };

  const route = async (req: Request, url: URL, port: number, peer: string | null): Promise<Response> => {
    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, version: VERSION, pid: process.pid, uptime_sec: Math.round((Date.now() - startedAt) / 1000) });
    }

    // Sign-in: a ticket in, a cookie out, then on to the app.
    if (url.pathname === "/_auth" && req.method === "GET") {
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!redeemTicket(ticket)) return new Response("This sign-in link has expired or was already used. Run `trb ui` again.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
      const to = url.searchParams.get("to") ?? "/";
      // Only ever back into the app: no open redirect through a crafted `to`.
      const dest = to.startsWith("/") && !to.startsWith("//") ? to : "/";
      return new Response(null, { status: 302, headers: { location: dest, "set-cookie": sessionCookie(opts.token), "cache-control": "no-store" } });
    }

    // A phone pairs here with a one-time code (404 unless remote access is on).
    if (url.pathname === "/_pair") return handlePair(req, url, peer, url.protocol === "https:" || (isLoopbackPeer(peer) && req.headers.get("x-forwarded-proto") === "https"));

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
      return serveStatic(url.pathname, req.headers.get("host") ?? undefined);
    }

    // The feedback widget's POST carries its own token in the path, so it is the one API route owners do not authenticate.
    if (isPublicSignalsPath(url.pathname)) return feedbackIntake(req, url, peer);

    const principal = authenticate(req, peer);
    if (!principal) throw new HttpError(401, "Missing or wrong credentials. The CLI uses ~/.treeboss/token; the browser signs in with `trb ui`.");
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (principal.kind === "remote") {
      // Default deny: a remote device reaches only what policy.ts lists (plus terminals/files the owner granted).
      const verdict = remoteAllowed(req.method, url.pathname, remoteConfig().grants);
      if (!verdict.ok) throw new HttpError(403, verdict.reason);
      if (mutating && !remoteOriginOk(req)) throw new HttpError(403, "Cross-origin request refused.");
    } else if (principal.via === "cookie" && mutating && !originOk(req, port)) throw new HttpError(403, "Cross-origin request refused.");

    if (url.pathname === "/api/ui/ticket" && req.method === "POST") {
      if (principal.kind !== "owner" || principal.via !== "bearer") throw new HttpError(403, "Tickets are issued to the CLI only.");
      return json({ ticket: mintTicket() });
    }

    const ctx = makeCtx(req, url, await bodyOf(req));
    ctx.principal = principal;
    for (const mod of modules) {
      const res = await mod(ctx);
      if (res) return res;
    }
    throw new HttpError(404, `No route ${req.method} ${url.pathname}.`);
  };

  const primaryHost = opts.hostname ?? "127.0.0.1";
  const listen = (hostname: string, port: number) => Bun.serve<TerminalSocketData | LiveSocketData>({
    hostname,
    port,
    // A subagent_wait holds its request open; 255s is Bun's maximum idle timeout.
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // DNS-rebinding guard: a hostile page that resolves its own name to 127.0.0.1 still sends its own Host.
      // Non-loopback hosts are admitted only while remote access is on (remote/hosts.ts).
      const peer = srv.requestIP(req)?.address ?? null;
      const hostHeader = req.headers.get("host") ?? "";
      if (!hostAllowed(hostHeader)) return json({ error: "Bad host." }, 403);
      // The remote listener serves its own address or name only: a loopback Host there is not a local request.
      if (srv.hostname !== primaryHost && isLoopbackName(hostHeader)) return json({ error: "Bad host." }, 403);
      try {
        /** Who may open a socket: the owner on loopback, or a remote device the policy lets in. */
        const socketPrincipal = (path: string): Principal => {
          const who = authenticate(req, peer);
          if (!who) throw new HttpError(401, "Not signed in.");
          if (who.kind === "owner") {
            if (!originOk(req, srv.port as number)) throw new HttpError(403, "Cross-origin request refused.");
          } else {
            if (!remoteOriginOk(req)) throw new HttpError(403, "Cross-origin request refused.");
            const verdict = remoteMaySocket(path, remoteConfig().grants);
            if (!verdict.ok) throw new HttpError(403, verdict.reason);
          }
          return who;
        };
        if (url.pathname === "/api/live") {
          const who = socketPrincipal(url.pathname);
          if (srv.upgrade(req, { data: { kind: "live", subs: new Map(), remoteId: who.kind === "remote" ? who.id : undefined } satisfies LiveSocketData })) return undefined as unknown as Response;
          throw new HttpError(400, "Expected a WebSocket upgrade.");
        }
        const ws = /^\/api\/terminals\/([^/]+)\/ws$/.exec(url.pathname);
        if (ws) {
          const who = socketPrincipal(url.pathname);
          if (!getTerminal(ws[1])) throw new HttpError(404, "No such terminal.");
          const data = { kind: "term", termId: ws[1], remoteId: who.kind === "remote" ? who.id : undefined } as TerminalSocketData;
          if (srv.upgrade(req, { data })) return undefined as unknown as Response;
          throw new HttpError(400, "Expected a WebSocket upgrade.");
        }
        return await route(req, url, srv.port as number, peer);
      } catch (err: any) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        if (err instanceof RootError) return json({ error: err.message }, err.status);
        if (err instanceof GitError) return json({ error: err.message, detail: err.stderr || undefined }, err.status);
        if (err instanceof SessionError || err instanceof UserError) return json({ error: err.message }, 400);
        if (err instanceof ConflictError) return json({ error: err.message, conflict: true, mtime: err.mtime }, 409);
        console.error(`[trb] ${req.method} ${url.pathname}:`, err);
        return json({ error: err?.message ?? "Internal error." }, 500);
      }
    },
    websocket: {
      open: (ws) => {
        const rid = (ws.data as any).remoteId as string | undefined;
        if (rid) trackSocket(rid, ws as any);
        return (ws.data as any).kind === "live" ? liveSocket.open(ws as any) : terminalSocket.open(ws as any);
      },
      message: (ws, msg) => ((ws.data as any).kind === "live" ? liveSocket.message(ws as any, msg as any) : terminalSocket.message(ws as any, msg as any)),
      close: (ws) => {
        const rid = (ws.data as any).remoteId as string | undefined;
        if (rid) untrackSocket(rid, ws as any);
        return (ws.data as any).kind === "live" ? liveSocket.close(ws as any) : terminalSocket.close(ws as any);
      },
    },
  });
  const server = listen(primaryHost, opts.port);

  // The second listener (lan / tailscale): one specific address, moved or closed live when the mode changes.
  const serveRemote = opts.remoteServe ?? ((host: string, port: number) => listen(host, port));
  const reconcile = () => reconcileListener(server.port as number, serveRemote);
  migrateRemoteMode();
  reconcile();
  // Tailscale answers in the background: listen as soon as it does, not on the first sweep.
  if (remoteConfig().mode === "tailscale") void refreshTailscale().then(reconcile, () => {});
  const unsubscribe = onSettingChanged((key) => key === "remote_mode" && reconcile());

  // Cut the connections of a revoked, expired or switched-off device without waiting for its next message,
  // and follow the network (a new Wi-Fi address, Tailscale coming up).
  const sweeper = setInterval(() => {
    try {
      sweepSockets();
      reconcile();
    } catch {}
  }, 5000);
  sweeper.unref?.();

  return {
    server,
    port: server.port as number,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      clearInterval(sweeper);
      unsubscribe();
      closeAllRemoteSockets("Daemon stopping.");
      stopListener();
      server.stop(true);
    },
  };
}

export { COOKIE };
