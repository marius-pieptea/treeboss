import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START pairattach\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END pairattach\n"); });
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HydraPairs } from "../src/hydra/pairs";
import { createLead, getSession, interruptAll, readLog, send, setTurnRunner, viewSession } from "../src/sessions/manager";
import { setSessionPair } from "../src/sessions/pairattach";
import { setSessionModel } from "../src/sessions/model";
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
const pairOf = () => HydraPairs.create({ title: "Duo", lead_engine: "fake", lead_model: "pair-model", heads_engine: "fake" });

describe("attaching a Hydra pair to a session that exists", () => {
  test("the next turn carries the heads preamble, the lead keeps its own model, and the log says so", async () => {
    const s = await settled(lead("SAY hi", { model: "mine", subagents: false }).id);
    send({ operator: true }, s.id, "ECHO_PROMPT subagent_create");
    expect((await settled(s.id)).last_output ?? "").toContain("subagent_create]=no");

    const pair = pairOf();
    const r = setSessionPair(s.id, pair.id);
    expect(r.pair_id).toBe(pair.id);
    expect(r.model).toBe("mine");
    expect(viewSession(getSession(s.id)!).pair).toBe(pair.id);
    expect(readLog(s.id).some((l) => l.kind === "info" && l.text.includes("Hydra pair attached: Duo"))).toBe(true);

    send({ operator: true }, s.id, "ECHO_PROMPT subagent_create");
    expect((await settled(s.id)).last_output ?? "").toContain("subagent_create]=yes");
  });

  test("the operator can still change the lead's model afterwards (pair override)", async () => {
    const s = await settled(lead("SAY hi", { model: "mine" }).id);
    setSessionPair(s.id, pairOf().id);
    await expect(setSessionModel(s.id, { model: "other" })).rejects.toThrow(/Set by the pair/);
    expect((await setSessionModel(s.id, { model: "other", force: true })).session.model).toBe("other");
  });

  test("adopting the lead: the session takes the pair's model and effort, and a different lead engine is refused", async () => {
    const pair = HydraPairs.create({ title: "Duo", lead_engine: "fake", lead_model: "pair-model", lead_effort: "high", heads_engine: "fake" });
    const s = await settled(lead("SAY hi", { model: "mine" }).id);
    const r = setSessionPair(s.id, pair.id, { adoptLead: true });
    expect(r.model).toBe("pair-model");
    expect(r.effort).toBe("high");
    expect(viewSession(getSession(s.id)!).model_pending).toBe(true);
    const other = HydraPairs.create({ title: "Other", lead_engine: "claude", lead_model: "x", heads_engine: "fake" });
    const t = await settled(lead("SAY hi").id);
    expect(() => setSessionPair(t.id, other.id, { adoptLead: true })).toThrow(/Continue with the pair in a new session/);
  });

  test("detaching removes the pair, and attaching again to the same one is a no-op", async () => {
    const pair = pairOf();
    const s = await settled(lead("SAY hi", { pairId: pair.id }).id);
    expect(setSessionPair(s.id, pair.id).id).toBe(s.id);
    expect(setSessionPair(s.id, null).pair_id).toBeNull();
    expect(readLog(s.id).some((l) => l.text.includes("Hydra pair detached"))).toBe(true);
    send({ operator: true }, s.id, "ECHO_PROMPT subagent_create");
    expect((await settled(s.id)).last_output ?? "").toContain("subagent_create]=no");
  });

  test("refused: unknown pair, running turn, closed session, a head", async () => {
    const s = await settled(lead("SAY hi").id);
    expect(() => setSessionPair(s.id, "nope")).toThrow(/No pair/);
    const busy = lead("SLEEP 400");
    expect(() => setSessionPair(busy.id, pairOf().id)).toThrow(/working/);
    await interruptAll();
  });
});
