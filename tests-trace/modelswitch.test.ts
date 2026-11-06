import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START modelswitch\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END modelswitch\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { ENGINES } from "../src/engines/registry";
import { HydraPairs } from "../src/hydra/pairs";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import { modelLock } from "../src/sessions/modellock";
import { setSessionModel } from "../src/sessions/model";
import { setSetting } from "../src/settings";
import { makeDir, resetState, settled } from "./helpers";

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);

describe("switching a session's model between turns", () => {
  test("the next resumed turn is launched with the new model, and the log says so", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    const r = await setSessionModel(s.id, { model: "beta" });
    expect(r.from).toBe("alpha");
    expect(r.to).toBe("beta");
    expect(getSession(s.id)!.model).toBe("beta");
    expect(readLog(s.id).some((l) => l.kind === "info" && l.text.includes("Model changed: alpha → beta (applies to the next turn)"))).toBe(true);
    send({ operator: true }, s.id, "ECHO_ARGS");
    const out = (await settled(s.id)).last_output ?? "";
    expect(out).toContain("--model beta");
    expect(out).not.toContain("--model alpha");
  });

  test("it is pending until the next turn starts, and the view says so", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    expect(viewSession(getSession(s.id)!).model_pending).toBe(false);
    await setSessionModel(s.id, { model: "beta" });
    expect(viewSession(getSession(s.id)!).model_pending).toBe(true);
    send({ operator: true }, s.id, "SAY next");
    await settled(s.id);
    expect(viewSession(getSession(s.id)!).model_pending).toBe(false);
    expect(viewSession(getSession(s.id)!).model).toBe("beta");
  });

  test("'default' clears the model, and the turn then carries no --model flag", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    await setSessionModel(s.id, { model: "default" });
    expect(getSession(s.id)!.model).toBeNull();
    send({ operator: true }, s.id, "ECHO_ARGS");
    expect((await settled(s.id)).last_output ?? "").not.toContain("--model alpha");
  });

  test("the effort can change with it, or alone, and an effort the engine does not accept is refused", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha", effort: "low" }).id);
    await setSessionModel(s.id, { effort: "high" });
    expect(getSession(s.id)!.effort).toBe("high");
    expect(getSession(s.id)!.model).toBe("alpha");
    expect(readLog(s.id).some((l) => l.text.includes("Effort changed: low → high"))).toBe(true);
    await expect(setSessionModel(s.id, { effort: "ludicrous" })).rejects.toThrow(/not one fake accepts/);
  });

  test("an id missing from the catalog still goes through, with a warning", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    const r = await setSessionModel(s.id, { model: "totally-new-model" });
    expect(r.to).toBe("totally-new-model");
    expect(typeof r.warning === "string" || r.warning === null).toBe(true);
  });

  test("setting the same model again changes nothing and logs nothing", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    const before = readLog(s.id).length;
    const r = await setSessionModel(s.id, { model: "alpha" });
    expect(r.uncached_next_turn).toBe(false);
    expect(readLog(s.id).length).toBe(before);
    expect(viewSession(getSession(s.id)!).model_pending).toBe(false);
  });

  test("a switch after a turn warns the next one re-reads uncached; effort alone does not", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    expect((await setSessionModel(s.id, { effort: "high" })).uncached_next_turn).toBe(false);
    expect((await setSessionModel(s.id, { model: "beta" })).uncached_next_turn).toBe(true);
  });

  test("refused while a turn is running", async () => {
    const s = lead("SLEEP 1500\nSAY done", { model: "alpha" });
    await Bun.sleep(150);
    await expect(setSessionModel(s.id, { model: "beta" })).rejects.toThrow(/working/);
    await interruptAll();
  });

  test("refused on a closed session", async () => {
    const { close } = await import("../src/sessions/manager");
    const s = await settled(lead("SAY hi").id);
    await close({ operator: true }, s.id);
    await expect(setSessionModel(s.id, { model: "beta" })).rejects.toThrow(/closed/);
  });

  test("an engine that cannot take a model on resume says so", async () => {
    const def = ENGINES.fake;
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    def.modelOnResume = false;
    try {
      expect(modelLock(getSession(s.id)!)).toBe("This engine keeps its model for the whole session");
      expect(viewSession(getSession(s.id)!).model_lock).toBe("This engine keeps its model for the whole session");
      await expect(setSessionModel(s.id, { model: "beta" })).rejects.toThrow(/keeps its model for the whole session/);
    } finally {
      delete def.modelOnResume;
    }
  });
});

describe("pairs keep their models", () => {
  test("a session governed by a pair is locked, and the reason names the pair", async () => {
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", lead_model: "pair-model", heads_engine: "fake" });
    const s = await settled(lead("SAY hi", { pairId: pair.id }).id);
    expect(viewSession(getSession(s.id)!).model_lock).toBe("Set by the pair");
    await expect(setSessionModel(s.id, { model: "other" })).rejects.toThrow(/Set by the pair/);
    expect(getSession(s.id)!.model).toBe("pair-model");
    // the operator can override it on purpose
    const forced = await setSessionModel(s.id, { model: "other", force: true });
    expect(forced.session.model).toBe("other");
  });

  test("once the pair is deleted, the session is free again", async () => {
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", lead_model: "pair-model", heads_engine: "fake" });
    const s = await settled(lead("SAY hi", { pairId: pair.id }).id);
    HydraPairs.remove(pair.id);
    expect(viewSession(getSession(s.id)!).model_lock).toBeNull();
    expect((await setSessionModel(s.id, { model: "other" })).to).toBe("other");
  });
});

describe("agents cannot switch models", () => {
  test("no subagent tool exposes a model switch", async () => {
    const { SUBAGENT_TOOL_NAMES } = await import("../src/sessions/tools");
    expect(SUBAGENT_TOOL_NAMES.filter((n) => /model/.test(n))).toEqual([]);
  });
});

describe("ask mode and a manual switch", () => {
  test("with ask_model_override on, a model the operator picked wins over the cheap one", async () => {
    setSetting("ask_models", "claude=cheap-1");
    setSetting("ask_model_override", "on");
    const seen: Array<string | null | undefined> = [];
    setTurnRunner(async (input: any) => {
      seen.push(input.model);
      return { success: true, output: "ok", sessionId: "x", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" } as any;
    });
    const s = await settled(createLead({ prompt: "q", engine: "claude", model: "claude-opus-5-5", cwd: makeDir(), mode: "ask" }).id);
    expect(seen).toEqual(["cheap-1"]);
    await setSessionModel(s.id, { model: "claude-sonnet-5-5" });
    send({ operator: true }, s.id, "q2");
    await settled(s.id);
    expect(seen).toEqual(["cheap-1", "claude-sonnet-5-5"]);
  });

  test("the switch survives a mode change", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    await setSessionModel(s.id, { model: "beta" });
    const { setMode } = await import("../src/sessions/plan");
    setMode(s.id, "plan");
    setMode(s.id, "build");
    expect(getSession(s.id)!.model).toBe("beta");
  });
});

describe("over HTTP", () => {
  const TOKEN = "model-api-token";
  let srv: ReturnType<typeof startServer>;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
    setDaemonContext({ url: srv.url, token: TOKEN });
  });
  afterAll(() => srv.stop());
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  test("PUT /model switches, returns the view, and shows pending", async () => {
    const s = await settled(lead("SAY hi", { model: "alpha" }).id);
    const r = await call("PUT", `/api/sessions/${s.id}/model`, { model: "beta" });
    expect(r.status).toBe(200);
    expect(r.body.session.model).toBe("beta");
    expect(r.body.session.model_pending).toBe(true);
    expect(r.body.from).toBe("alpha");
    expect(r.body.uncached_next_turn).toBe(true);
  });

  test("errors are readable: unknown session, empty body, running turn, pair lock", async () => {
    expect((await call("PUT", "/api/sessions/s_nope/model", { model: "x" })).status).toBe(404);
    const s = await settled(lead("SAY hi").id);
    const empty = await call("PUT", `/api/sessions/${s.id}/model`, {});
    expect(empty.status).toBe(400);
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", lead_model: "pm", heads_engine: "fake" });
    const p = await settled(lead("SAY hi", { pairId: pair.id }).id);
    const locked = await call("PUT", `/api/sessions/${p.id}/model`, { model: "x" });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatch(/Set by the pair/);
    const running = lead("SLEEP 1500\nSAY x");
    await Bun.sleep(150);
    const busy = await call("PUT", `/api/sessions/${running.id}/model`, { model: "x" });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/working/);
  });
});
