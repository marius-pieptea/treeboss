import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START runner\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END runner\n"); });
import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { runTurn } from "../src/engines/runner";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
const engine = path.join(dir, "engine");
// Answers like a CLI, then leaves a background child holding its stdout open: the turn is over, the pipe is not.
fs.writeFileSync(
  engine,
  [
    "#!/bin/sh",
    `echo '{"type":"system","subtype":"init","model":"fake","tools":[]}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"all done","num_turns":1}'`,
    "sleep 5 &",
    "exit 0",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const prev = process.env.TRB_FAKE_ENGINE;
process.env.TRB_FAKE_ENGINE = engine;
afterAll(() => {
  process.env.TRB_FAKE_ENGINE = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runTurn", () => {
  test("settles when the CLI exits, not when a background child lets go of stdout", async () => {
    const started = Date.now();
    const r = await runTurn({ engine: "fake", key: "k-runner", prompt: "x", cwd: dir, mcp: {}, timeoutSec: 60, idleMs: 60_000, ceilingMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.success).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.output).toBe("all done");
  });
});
