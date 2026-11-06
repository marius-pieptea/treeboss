import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { readFinding } from "../src/lab/findings";
import { readRoadmap, createRoadmap } from "../src/roadmap/store";
import { getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { makeCtx, HttpError } from "../src/daemon/http";
import { isPublicSignalsPath, feedbackIntake, signalsRoutes } from "../src/daemon/routes/signals";
import { acceptFeedback, FEEDBACK_MAX_BYTES, parseFeedback, resetFeedbackLimits, takeFeedbackSlot, widgetSnippet, FEEDBACK_RATE } from "../src/signals/feedback";
import { ensureFeedbackToken, feedbackTokenOf, getSignal, listSignals, upsertSignal, workspaceOfFeedbackToken } from "../src/signals/store";
import { sourcesConfigured, syncSignals } from "../src/signals/sync";
import { posthogConfig, syncPosthog, eventCountsSql, activeUsersSql } from "../src/signals/sources/posthog";
import { sentryConfig, syncSentry } from "../src/signals/sources/sentry";
import { autoTriagePrompt, triageSignal } from "../src/signals/triage";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...({} as object) });

const SENTRY_ENV = { SENTRY_AUTH_TOKEN: "sntry-secret-token", SENTRY_ORG: "acme", SENTRY_PROJECT: "web" };
const POSTHOG_ENV = { POSTHOG_API_KEY: "phx-secret-key", POSTHOG_PROJECT_ID: "123" };

/** A fetch stand-in that records every call and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let ws: string;
let dir: string;

beforeEach(() => {
  resetState();
  setTurnRunner(null);
  resetFeedbackLimits();
  listSignals("none"); // creates the tables
  db().exec("DELETE FROM signals; DELETE FROM signal_tokens;");
  dir = makeRepo({ "a.txt": "x\n" });
  createRoadmap(dir, "Demo");
  ws = Workspaces.open(dir).id;
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const input = (over: Partial<Parameters<typeof upsertSignal>[1]> = {}) => ({
  source: "manual" as const,
  kind: "error" as const,
  externalId: "x-1",
  title: "Checkout breaks on Safari",
  severity: "high" as const,
  ...over,
});

describe("store", () => {
  test("one row per (workspace, source, external id): a second upsert updates it and keeps its status", () => {
    const a = upsertSignal(ws, input({ count: 1 }));
    expect(triageSignal(a.id, "ignore").signal.status).toBe("ignored");
    const b = upsertSignal(ws, input({ count: 9, title: "Checkout breaks on Safari 17" }));
    expect(b.id).toBe(a.id);
    expect(b.count).toBe(9);
    expect(b.title).toBe("Checkout breaks on Safari 17");
    expect(b.status).toBe("ignored");
    expect(listSignals(ws)).toHaveLength(1);
  });

  test("lists by source and status, most severe first, and keeps workspaces apart", () => {
    upsertSignal(ws, input({ externalId: "a", severity: "low", title: "low one" }));
    upsertSignal(ws, input({ externalId: "b", severity: "critical", title: "crit one", source: "sentry" }));
    upsertSignal(ws, input({ externalId: "c", severity: "high", title: "high one" }));
    const other = Workspaces.open(makeRepo()).id;
    upsertSignal(other, input({ externalId: "z" }));
    expect(listSignals(ws).map((s) => s.title)).toEqual(["crit one", "high one", "low one"]);
    expect(listSignals(ws, { source: "sentry" }).map((s) => s.title)).toEqual(["crit one"]);
    expect(listSignals(ws, { status: "linked" })).toEqual([]);
    expect(listSignals(ws, { source: "nope" })).toEqual([]);
  });

  test("refuses an unknown source, a missing title and an unknown signal id", () => {
    expect(() => upsertSignal(ws, input({ source: "tiktok" as any }))).toThrow(/Unknown signal source/);
    expect(() => upsertSignal(ws, input({ title: "  " }))).toThrow(/needs a title/);
    expect(() => getSignal("sig_missing")).toThrow(/There is no signal/);
  });
});

describe("sentry", () => {
  test("is not configured without its token, org and project, and reads nothing", async () => {
    expect(sentryConfig({ SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "o" })).toBeNull();
    const f = fakeFetch(() => json([]));
    const r = await syncSentry(ws, {}, f.fn);
    expect(r).toEqual({ source: "sentry", configured: false, upserted: 0, error: null });
    expect(f.calls).toHaveLength(0);
  });

  test("fetches unresolved issues with a bearer token and upserts them with mapped severity", async () => {
    const f = fakeFetch(() =>
      json([
        { id: "101", shortId: "WEB-1", title: "TypeError: x is undefined", culprit: "checkout.ts", permalink: "https://sentry.io/i/101", level: "fatal", count: "340", userCount: 12, lastSeen: "2026-10-27T10:00:00Z" },
        { id: "102", title: "Warning: slow query", level: "warning", count: "3", userCount: 1 },
        { id: "103", title: "Something odd", level: "debug" },
      ]),
    );
    const r = await syncSentry(ws, SENTRY_ENV, f.fn);
    expect(r).toEqual({ source: "sentry", configured: true, upserted: 3, error: null });
    expect(f.calls[0]!.url).toBe("https://sentry.io/api/0/projects/acme/web/issues/?query=is%3Aunresolved&statsPeriod=14d&limit=50");
    expect((f.calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer sntry-secret-token");
    const fatal = listSignals(ws, { source: "sentry" }).find((s) => s.externalId === "101")!;
    expect(fatal.severity).toBe("critical");
    expect(fatal.count).toBe(340);
    expect(fatal.url).toBe("https://sentry.io/i/101");
    expect(fatal.kind).toBe("error");
    expect(fatal.meta.userCount).toBe(12);
    expect(listSignals(ws, { source: "sentry" }).find((s) => s.externalId === "102")!.severity).toBe("medium");
    expect(listSignals(ws, { source: "sentry" }).find((s) => s.externalId === "103")!.severity).toBe("low");
  });

  test("a rejected token is reported without the token in the message", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 401 }));
    const r = await syncSentry(ws, SENTRY_ENV, f.fn);
    expect(r.configured).toBe(true);
    expect(r.error).toContain("401");
    expect(r.error).not.toContain("sntry-secret-token");
    expect(listSignals(ws)).toEqual([]);
  });
});

describe("posthog", () => {
  test("drops event names that could break the query, and reads its host and events from the environment", () => {
    const cfg = posthogConfig({ ...POSTHOG_ENV, POSTHOG_EVENTS: "signup, checkout ,evil'name, ok_event" });
    expect(cfg!.events).toEqual(["signup", "checkout", "ok_event"]);
    expect(cfg!.host).toBe("https://us.posthog.com");
    expect(posthogConfig({ POSTHOG_API_KEY: "k" })).toBeNull();
  });

  test("quotes event names in the SQL and counts users over 7 and 30 days", () => {
    expect(eventCountsSql(["a", "it's"])).toContain("event IN ('a', 'it''s')");
    expect(activeUsersSql(30)).toContain("INTERVAL 30 DAY");
  });

  test("stores the active-user numbers and each event count as metric signals with values in meta", async () => {
    const f = fakeFetch((url, init) => {
      expect(url).toBe("https://us.posthog.com/api/projects/123/query/");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer phx-secret-key");
      const q = JSON.parse(String(init!.body)).query.query as string;
      if (q.includes("event IN")) return json({ results: [["signup", 17]] });
      return json({ results: [[q.includes("INTERVAL 7 DAY") ? 42 : 120]] });
    });
    const r = await syncPosthog(ws, { ...POSTHOG_ENV, POSTHOG_EVENTS: "signup,checkout" }, f.fn);
    expect(r).toEqual({ source: "posthog", configured: true, upserted: 4, error: null });
    const metrics = listSignals(ws, { kind: "metric" });
    expect(metrics.map((m) => [m.externalId, m.meta.value])).toEqual(
      expect.arrayContaining([
        ["active_users_7d", 42],
        ["active_users_30d", 120],
        ["event_signup_7d", 17],
        ["event_checkout_7d", 0],
      ]),
    );
    expect(metrics.every((m) => m.source === "posthog" && m.severity === "low")).toBe(true);
    // A second sync updates the same rows rather than adding more.
    await syncPosthog(ws, POSTHOG_ENV, f.fn);
    expect(listSignals(ws, { kind: "metric" })).toHaveLength(4);
  });

  test("a failing query is reported and leaves nothing half-written", async () => {
    const f = fakeFetch(() => new Response("boom", { status: 500 }));
    const r = await syncPosthog(ws, POSTHOG_ENV, f.fn);
    expect(r.error).toContain("500");
    expect(r.error).not.toContain("phx-secret-key");
    expect(listSignals(ws)).toEqual([]);
  });
});

describe("syncSignals", () => {
  test("runs every configured source; one failing does not stop the other", async () => {
    const env = { ...SENTRY_ENV, ...POSTHOG_ENV };
    const report = await syncSignals(ws, {
      envProvider: () => env,
      fetch: async (input) => {
        if (String(input).includes("sentry.io")) throw new Error("connection reset");
        return json({ results: [[5]] });
      },
    });
    const bySource = Object.fromEntries(report.sources.map((s) => [s.source, s]));
    expect(bySource.sentry!.error).toContain("connection reset");
    // Two active-user metrics; no POSTHOG_EVENTS set, so no event counts.
    expect(bySource.posthog!.upserted).toBe(2);
    expect(report.workspaceId).toBe(ws);
  });

  test("with the default empty environment nothing is configured and nothing is fetched", async () => {
    const report = await syncSignals(ws, { fetch: async () => { throw new Error("should not be called"); } });
    expect(report.sources.every((s) => !s.configured && s.upserted === 0)).toBe(true);
    expect(sourcesConfigured({})).toEqual({ sentry: false, posthog: false });
    expect(sourcesConfigured({ ...SENTRY_ENV, ...POSTHOG_ENV })).toEqual({ sentry: true, posthog: true });
  });

  test("an unknown workspace is refused before anything is read", async () => {
    await expect(syncSignals("w_nope", { envProvider: () => SENTRY_ENV })).rejects.toThrow();
  });
});

describe("feedback intake", () => {
  const post = (token: string, body: unknown, peer = "10.0.0.1", headers: Record<string, string> = {}) => {
    const req = new Request(`http://127.0.0.1/api/signals/feedback/${token}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
    return feedbackIntake(req, new URL(req.url), peer);
  };

  test("the token is per workspace: it accepts feedback for its workspace, and rotating it cuts the old one off", async () => {
    const t1 = ensureFeedbackToken(ws);
    expect(ensureFeedbackToken(ws)).toBe(t1);
    expect(feedbackTokenOf(ws)).toBe(t1);
    expect(workspaceOfFeedbackToken(t1)).toBe(ws);
    const t2 = ensureFeedbackToken(ws, true);
    expect(t2).not.toBe(t1);
    expect((await post(t1, { message: "hi" })).status).toBe(404);
    expect((await post(t2, { message: "hi" })).status).toBe(201);
    expect(workspaceOfFeedbackToken("")).toBeNull();
  });

  test("a valid submission is stored as a feedback signal, and an identical one bumps its count", async () => {
    const t = ensureFeedbackToken(ws);
    const body = { message: "The export button does nothing", page: "https://app.example/export", rating: 1, email: "u@example.com" };
    const res = await post(t, body, "10.0.0.2");
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    await post(t, body, "10.0.0.2");
    const fb = listSignals(ws, { source: "feedback" });
    expect(fb).toHaveLength(1);
    expect(fb[0]!.count).toBe(2);
    expect(fb[0]!.kind).toBe("feedback");
    expect(fb[0]!.severity).toBe("high");
    expect(fb[0]!.url).toBe("https://app.example/export");
    expect(fb[0]!.body).toContain("From: u@example.com");
  });

  test("answers CORS preflight without a token, and refuses other methods", async () => {
    const req = new Request("http://127.0.0.1/api/signals/feedback/x", { method: "OPTIONS" });
    const res = await feedbackIntake(req, new URL(req.url), "10.0.0.3");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    const get = new Request("http://127.0.0.1/api/signals/feedback/x", { method: "GET" });
    expect((await feedbackIntake(get, new URL(get.url), "10.0.0.3")).status).toBe(405);
  });

  test("bad input is a 400, an oversized body a 413, an unknown token a 404", async () => {
    const t = ensureFeedbackToken(ws);
    expect((await post(t, "{not json")).status).toBe(400);
    expect((await post(t, { message: "   " })).status).toBe(400);
    expect((await post(t, { message: "ok", rating: 9 })).status).toBe(400);
    expect((await post(t, { message: "ok", email: "not-an-email" })).status).toBe(400);
    expect((await post(t, { message: "x".repeat(FEEDBACK_MAX_BYTES + 1) })).status).toBe(413);
    expect((await post("no-such-token", { message: "ok" })).status).toBe(404);
    expect(listSignals(ws, { source: "feedback" })).toEqual([]);
  });

  test("rate limits one peer, and leaves other peers alone", async () => {
    const t = ensureFeedbackToken(ws);
    for (let i = 0; i < FEEDBACK_RATE.max; i++) expect((await post(t, { message: `msg ${i}` }, "10.9.9.9")).status).toBe(201);
    expect((await post(t, { message: "one too many" }, "10.9.9.9")).status).toBe(429);
    expect((await post(t, { message: "other peer" }, "10.8.8.8")).status).toBe(201);
    expect(takeFeedbackSlot("10.7.7.7", 0)).toBe(true);
  });

  test("the public path is recognised so the server can exempt it from owner auth", () => {
    expect(isPublicSignalsPath("/api/signals/feedback/abc")).toBe(true);
    expect(isPublicSignalsPath("/api/signals")).toBe(false);
    expect(isPublicSignalsPath("/api/signals/sync/w_1")).toBe(false);
  });

  test("the widget snippet posts to the endpoint and cannot be broken out of by its label", () => {
    const html = widgetSnippet("https://daemon.example/api/signals/feedback/tok", { label: "</script><b>x" });
    expect(html).toContain('"endpoint":"https://daemon.example/api/signals/feedback/tok"');
    expect(html).toContain("fetch(cfg.endpoint");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("</script><b>x");
  });

  test("parseFeedback accepts only the documented fields and bounds", () => {
    expect(parseFeedback({ message: " hello ", page: "/p", rating: "4" })).toEqual({ message: "hello", page: "/p", rating: 4, email: null });
    expect(() => parseFeedback([])).toThrow();
    expect(() => parseFeedback({ message: "x", rating: 0 })).toThrow(/1 to 5/);
  });

  test("acceptFeedback keeps identical messages on different pages apart", () => {
    const a = acceptFeedback(ws, parseFeedback({ message: "same", page: "/a" }));
    const b = acceptFeedback(ws, parseFeedback({ message: "same", page: "/b" }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("triage", () => {
  test("to_roadmap adds the item to the Next lane and links the signal to it", () => {
    const s = upsertSignal(ws, input({ title: "Export is slow", body: "Takes 40 s for 1k rows", url: "https://sentry.io/i/9" }));
    const r = triageSignal(s.id, "to_roadmap");
    expect(r.roadmapItem).toMatch(/^r\d+$/);
    expect(r.signal.status).toBe("linked");
    expect(r.signal.linkedRef).toBe(r.roadmapItem!);
    const next = readRoadmap(dir).lanes.find((l) => l.name === "Next")!;
    const item = next.items.find((i) => i.id === r.roadmapItem)!;
    expect(item.title).toBe("Export is slow");
    expect(item.description).toContain(`From signal ${s.id}`);
    expect(item.tags).toEqual(expect.arrayContaining(["signal", "manual"]));
  });

  test("to_roadmap can name another lane", () => {
    const s = upsertSignal(ws, input());
    const r = triageSignal(s.id, "to_roadmap", { lane: "Later" });
    expect(readRoadmap(dir).lanes.find((l) => l.name === "Later")!.items.map((i) => i.id)).toContain(r.roadmapItem!);
  });

  test("to_finding writes a lab finding the lab can read, once", () => {
    const s = upsertSignal(ws, input({ severity: "critical", title: "Crash on save", body: "Stack trace in save.ts", url: "https://sentry.io/i/7" }));
    const r = triageSignal(s.id, "to_finding");
    expect(r.finding).toBe(`lab/findings/sig-${s.id.slice(4)}.md`);
    const f = readFinding(dir, `sig-${s.id.slice(4)}`);
    expect(f.title).toBe("Crash on save");
    expect(f.status).toBe("new");
    expect(f.lens).toBe("review");
    expect(f.impact).toBe("high");
    expect(f.body).toContain("https://sentry.io/i/7");
    expect(getSignal(s.id).linkedRef).toBe(r.finding!);
    const again = triageSignal(s.id, "to_finding");
    expect(again.finding).toBe(r.finding);
    expect(fs.readdirSync(path.join(dir, "lab", "findings"))).toHaveLength(1);
  });

  test("to_session starts a build session with the signal in its prompt, and marks it triaged", () => {
    setTurnRunner(async () => ok("done"));
    const s = upsertSignal(ws, input({ title: "Null user on checkout" }));
    const r = triageSignal(s.id, "to_session");
    expect(r.session).toMatch(/^s_/);
    const session = getSession(r.session!)!;
    expect(session.title).toBe("Fix: Null user on checkout");
    expect(session.cwd).toBe(fs.realpathSync(dir));
    expect(r.signal.status).toBe("triaged");
    expect(r.signal.meta.session).toBe(r.session);
    expect(r.signal.linkedRef).toBeNull();
  });

  test("ignore marks the signal ignored and keeps it across syncs", () => {
    const s = upsertSignal(ws, input());
    expect(triageSignal(s.id, "ignore").signal.status).toBe("ignored");
    expect(upsertSignal(ws, input()).status).toBe("ignored");
  });

  test("an unknown action or signal is refused, and nothing changes", () => {
    const s = upsertSignal(ws, input());
    expect(() => triageSignal(s.id, "delete_everything")).toThrow(/Action must be one of/);
    expect(() => triageSignal("sig_nope", "ignore")).toThrow(/There is no signal/);
    expect(getSignal(s.id).status).toBe("new");
  });

  test("the auto-triage prompt lists the new signals and forbids changes", () => {
    const a = upsertSignal(ws, input({ externalId: "a", title: "First error" }));
    upsertSignal(ws, input({ externalId: "b", title: "Second error", source: "sentry" }));
    triageSignal(a.id, "ignore");
    const prompt = autoTriagePrompt(ws);
    expect(prompt).toContain("Second error");
    expect(prompt).not.toContain(a.id);
    expect(prompt).toContain("Change no files");
    expect(autoTriagePrompt(Workspaces.open(makeRepo()).id)).toContain("no new signals");
  });
});

describe("routes", () => {
  test("GET lists signals and metrics for a workspace, and POST triage acts on one", async () => {
    upsertSignal(ws, input({ externalId: "e1", title: "Real error" }));
    upsertSignal(ws, input({ externalId: "m1", kind: "metric", source: "posthog", severity: "low", title: "Active users, last 7 days", meta: { value: 42 } }));
    const url = new URL(`http://127.0.0.1/api/signals?workspace=${ws}`);
    const list = (await signalsRoutes(makeCtx(new Request(url), url, {})))!;
    const body = await (list as Response).json();
    expect(body.signals.map((s: { title: string }) => s.title)).toEqual(["Real error"]);
    expect(body.metrics[0].meta.value).toBe(42);
    expect(body.sources).toEqual({ sentry: false, posthog: false });

    const id = body.signals[0].id;
    const tri = new URL(`http://127.0.0.1/api/signals/${id}/triage`);
    const res = (await signalsRoutes(makeCtx(new Request(tri, { method: "POST" }), tri, { action: "ignore" })))!;
    expect((res as Response).status).toBe(200);
    expect(getSignal(id).status).toBe("ignored");
  });

  test("the token routes create and rotate the feedback token, and the widget carries its endpoint", async () => {
    const u = new URL(`http://127.0.0.1/api/signals/token?workspace=${ws}`);
    const created = await (await signalsRoutes(makeCtx(new Request(u, { method: "POST" }), u, {})))!.json();
    expect(created.token).toBe(feedbackTokenOf(ws));
    const w = new URL(`http://127.0.0.1/api/signals/widget?workspace=${ws}&origin=https%3A%2F%2Fd.example`);
    const widget = await (await signalsRoutes(makeCtx(new Request(w), w, {})))!.json();
    expect(widget.endpoint).toBe(`https://d.example/api/signals/feedback/${created.token}`);
    expect(widget.html).toContain(widget.endpoint);
  });

  test("a missing workspace is a 400", async () => {
    const u = new URL("http://127.0.0.1/api/signals");
    await expect(signalsRoutes(makeCtx(new Request(u), u, {}))).rejects.toBeInstanceOf(HttpError);
  });
});
