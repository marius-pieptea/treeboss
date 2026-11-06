/**
 * The signals module over HTTP. `workspace` is a root reference (w_… or s_…), like the lab and roadmap routes.
 *
 *   GET    /api/signals?workspace=&source=&status=      signals (no metrics), most important first; metrics; which sources are set up
 *   POST   /api/signals/sync/:workspace                 pull every configured source now (sync.ts)
 *   POST   /api/signals/:id/triage                      { action, lane?, engine?, model?, effort?, agent?, pairId?, sessionId? }
 *   GET    /api/signals/token?workspace=                the feedback token, or null
 *   POST   /api/signals/token?workspace=                { rotate? } create the feedback token; rotate replaces it and the old one stops working
 *   GET    /api/signals/widget?workspace=&origin=&label=  the embeddable snippet, posting to origin's intake
 *   GET    /api/signals/triage-prompt?workspace=        the prompt that clusters new signals into roadmap proposals
 *
 * Public, NOT behind owner auth: POST /api/signals/feedback/:token. The token in the path is the credential.
 * server.ts must send that path to `feedbackIntake` before it authenticates (see isPublicSignalsPath). It answers
 * CORS, since the widget runs on the product's own site, and rate-limits per peer.
 */
import { resolveRoot } from "../../workspaces";
import { FEEDBACK_MAX_BYTES, acceptFeedback, parseFeedback, takeFeedbackSlot, widgetSnippet } from "../../signals/feedback";
import { ensureFeedbackToken, feedbackTokenOf, listSignals, workspaceOfFeedbackToken } from "../../signals/store";
import { sourcesConfigured, syncSignals } from "../../signals/sync";
import { autoTriagePrompt, triageSignal, type TriageOpts } from "../../signals/triage";
import type { EnvProvider } from "../../signals/types";
import { resolveEnv } from "../../secrets/store";
import { UserError } from "../../util";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const FEEDBACK_PREFIX = "/api/signals/feedback/";

/** Where the sources read their settings from: the workspace's production secrets (Sentry and PostHog keys). */
const envFor: EnvProvider = (ws) => resolveEnv(ws, "prod");

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The path the server sends to `feedbackIntake` before owner authentication. */
export const isPublicSignalsPath = (pathname: string): boolean => /^\/api\/signals\/feedback\/[^/]+$/.test(pathname);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

/** The workspace a raw path segment names as its token, or null for anything that is not one. */
function tokenWorkspace(raw: string): string | null {
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return token && !token.includes("/") ? workspaceOfFeedbackToken(token) : null;
}

/** The widget's POST. Every answer carries CORS headers, errors included, so the visitor's browser can read why it failed. */
export async function feedbackIntake(req: Request, url: URL, peer: string | null): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Feedback is sent with POST.");
    if (!takeFeedbackSlot(peer ?? "unknown")) throw new HttpError(429, "Too many messages from here. Try again in a minute.");
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > FEEDBACK_MAX_BYTES) throw new HttpError(413, "The message is too large.");
    const text = await req.text();
    if (Buffer.byteLength(text) > FEEDBACK_MAX_BYTES) throw new HttpError(413, "The message is too large.");
    const ws = tokenWorkspace(url.pathname.slice(FEEDBACK_PREFIX.length));
    if (!ws) throw new HttpError(404, "No such feedback form.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Body must be JSON.");
    }
    acceptFeedback(ws, parseFeedback(raw));
    return json({ ok: true }, 201, CORS);
  } catch (err: any) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, CORS);
    if (err instanceof UserError) return json({ error: err.message }, 400, CORS);
    throw err;
  }
}

function triageOpts(b: Record<string, any>): TriageOpts {
  return {
    lane: str(b.lane),
    engine: str(b.engine),
    model: str(b.model),
    effort: str(b.effort),
    agent: str(b.agent),
    pairId: str(b.pairId ?? b.pair_id),
    sessionId: str(b.sessionId ?? b.session_id),
  };
}

export const signalsRoutes: RouteModule = async (c: Ctx) => {
  if (!c.path.startsWith("/api/signals")) return null;
  const rest = c.path.slice("/api/signals".length);
  const b = c.body;

  // Every route below takes ?workspace= (or a path segment) and checks that the root exists before it reads anything.
  const workspace = (): string => {
    const ws = c.q("workspace")?.trim();
    if (!ws) throw new HttpError(400, "Pass ?workspace=<id>.");
    resolveRoot(ws);
    return ws;
  };

  if (rest === "" && c.method === "GET") {
    const ws = workspace();
    return json({
      signals: listSignals(ws, { source: c.q("source"), status: c.q("status") }).filter((s) => s.kind !== "metric"),
      metrics: listSignals(ws, { kind: "metric" }),
      sources: sourcesConfigured(envFor(ws)),
      feedback: feedbackTokenOf(ws) !== null,
    });
  }

  let m: RegExpMatchArray | null;
  if ((m = rest.match(/^\/sync\/([^/]+)$/)) && c.method === "POST") {
    const ws = decodeURIComponent(m[1]!);
    return json(await syncSignals(ws, { envProvider: envFor }));
  }

  if ((m = rest.match(/^\/([^/]+)\/triage$/)) && c.method === "POST") {
    const r = triageSignal(decodeURIComponent(m[1]!), String(b.action ?? ""), triageOpts(b));
    return json(r);
  }

  if (rest === "/token" && c.method === "GET") return json({ token: feedbackTokenOf(workspace()) });
  if (rest === "/token" && c.method === "POST") return json({ token: ensureFeedbackToken(workspace(), b.rotate === true) });

  if (rest === "/widget" && c.method === "GET") {
    const ws = workspace();
    const token = ensureFeedbackToken(ws);
    const origin = str(c.q("origin")) ?? `${c.url.protocol}//${c.req.headers.get("host") ?? ""}`;
    const endpoint = `${origin.replace(/\/+$/, "")}${FEEDBACK_PREFIX}${token}`;
    return json({ endpoint, html: widgetSnippet(endpoint, { label: str(c.q("label")) ?? undefined }) });
  }

  if (rest === "/triage-prompt" && c.method === "GET") return json({ prompt: autoTriagePrompt(workspace()) });

  return null;
};
