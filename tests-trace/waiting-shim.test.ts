import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START waiting-shim\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END waiting-shim\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { createLead, getSession, interruptAll, readLog } from "../src/sessions/manager";
import { HydraPairs } from "../src/hydra/pairs";
import { setSetting } from "../src/settings";
import { openWaitCount } from "../src/sessions/waiting";
import { makeRepo, resetState } from "./helpers";

// settled() waits through wait(), which this test deliberately clamps to one second: poll instead.
async function idle(id: string) {
  for (let i = 0; i < 400; i++) {
    const s = getSession(id)!;
    if (s.status !== "running") return s;
    await Bun.sleep(100);
  }
  throw new Error("lead never settled");
}

setDefaultTimeout(60_000);

const TOKEN = "test-token-wait";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN, onShutdown: () => {} });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});
beforeEach(() => resetState());
afterEach(async () => {
  await interruptAll();
});

test("through the real MCP shim a head that outlives several daemon blocks costs the lead ONE wait call", async () => {
  setSetting("wait_max_sec", "1"); // every block the daemon holds is one second
  const pair = HydraPairs.create({ title: "W", lead_engine: "fake", heads_engine: "fake", max_heads: 2 } as any);
  const prompt = [`CALL_TOOL subagent_create {"brief":"SLEEP 3200\\nSAY slow head done","title":"slow"}`, `CALL_TOOL subagent_wait {"mode":"all"}`].join("\n");
  const l = createLead({ prompt, engine: "fake", cwd: makeRepo(), pairId: pair.id } as any);
  const t0 = Date.now();
  const done = await idle(l.id);
  expect(Date.now() - t0).toBeGreaterThan(3000);
  expect(done.status).toBe("idle");
  // The lead got the head's answer as the result of that single call: no "still running, call again" in between.
  expect(done.last_output).toContain("slow head done");
  expect(done.last_output).not.toContain("still_running");
  const waitCalls = readLog(l.id).filter((r) => r.kind === "tool" && r.text.includes("subagent_wait"));
  expect(waitCalls).toHaveLength(1);
  expect(openWaitCount()).toBe(0);
  expect(getSession(l.id)!.turns).toBe(1);
});
