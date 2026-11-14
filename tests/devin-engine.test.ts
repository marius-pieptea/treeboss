/**
 * devin engine: the ACP stream branch, the launch spec, and a full turn against a fake `devin acp` server.
 */
import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createStreamAccumulator } from "../src/engines/stream";
import { ENGINES } from "../src/engines/registry";
import { runTurn } from "../src/engines/runner";
import { discoverAcpModels, modelsFromSession } from "../src/engines/acp";

const rpc = (o: unknown) => JSON.stringify(o) + "\n";
const update = (u: unknown) => rpc({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });

describe("devin stream", () => {
  it("collects the answer, tools and usage, and only the prompt response ends the turn", () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const acc = createStreamAccumulator((l) => lines.push(l), (id) => void seen.push(id), "devin");
    acc.push(rpc({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }));
    acc.push(rpc({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1" } }));
    expect(acc.completed()).toBe(false);
    expect(seen).toEqual(["s1"]);
    acc.push(update({ sessionUpdate: "agent_message_chunk", content: { text: "Looking around." } }));
    acc.push(update({ sessionUpdate: "tool_call", toolCallId: "c1", rawInput: { command: "git status" } }));
    acc.push(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }));
    acc.push(update({ sessionUpdate: "agent_message_chunk", content: { text: "Clean." } }));
    acc.push(rpc({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 2 } } }));
    acc.end();
    expect(acc.completed()).toBe(true);
    expect(acc.isError()).toBe(false);
    expect(acc.finalText()).toBe("Clean.");
    expect(lines.some((l) => l.includes("[devin] → execute: git status"))).toBe(true);
    expect(acc.cliUsage()?.inputTokens).toBe(8);
  });

  it("ignores replayed history and reads a refused session as a rejected resume", () => {
    const acc = createStreamAccumulator(() => {}, undefined, "devin");
    acc.setReplaying(true);
    acc.push(update({ sessionUpdate: "agent_message_chunk", content: { text: "old answer" } }));
    acc.setReplaying(false);
    expect(acc.finalText()).toBe("");
    acc.push(rpc({ jsonrpc: "2.0", id: 2, error: { code: -32016, message: "Session not found" } }));
    expect(acc.isError()).toBe(true);
    expect(acc.resumeRejected()).toBe(true);
  });

  it("keeps usage from an interrupted turn", () => {
    const acc = createStreamAccumulator(() => {}, undefined, "devin");
    acc.push(update({ sessionUpdate: "usage_update", _meta: { "cognition.ai/inputTokens": 91915, "cognition.ai/outputTokens": 28 } }));
    expect(acc.completed()).toBe(false);
    expect(acc.cliUsage()?.outputTokens).toBe(28);
  });

  it("reports how full the context is and its window", () => {
    const seen: any[] = [];
    const acc = createStreamAccumulator(() => {}, undefined, "devin", { onUsage: (e) => seen.push(e) });
    acc.push(update({ sessionUpdate: "usage_update", used: 91943, size: 262000, _meta: { "cognition.ai/inputTokens": 91915, "cognition.ai/outputTokens": 28 } }));
    expect(acc.context()).toMatchObject({ tokens: 91943, window: 262000 });
    expect(seen.some((e) => e.kind === "context")).toBe(true);
  });
});

describe("devin models", () => {
  it("reads the model option, grouped or not, and the legacy models field", () => {
    const opt = { id: "model", category: "model", currentValue: "b", options: [{ value: "a", name: "A" }, { options: [{ value: "b" }] }] };
    expect(modelsFromSession({ configOptions: [opt] })).toEqual([{ id: "a", name: "A", description: undefined, isDefault: false }, { id: "b", name: undefined, description: undefined, isDefault: true }]);
    expect(modelsFromSession({ models: { currentModelId: "x", availableModels: [{ modelId: "x", name: "X" }] } })[0]).toMatchObject({ id: "x", isDefault: true });
    expect(modelsFromSession({})).toEqual([]);
  });
});

describe("devin launch", () => {
  const input = { key: "k", prompt: "hi", cwd: process.cwd(), mcp: {}, timeoutSec: 60 };
  it("puts global flags before acp and the model after it, with the turn carried over ACP", () => {
    const spec = ENGINES.devin.build({ ...input, model: "swe" }, "devin");
    expect(spec.args).toEqual(["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp", "--model", "swe"]);
    expect(spec.stdin).toBeNull();
    expect(spec.acp).toMatchObject({ prompt: "hi", allowTools: true });
  });
  it("does not bypass permissions on a read-only turn", () => {
    const spec = ENGINES.devin.build({ ...input, mode: "plan" }, "devin");
    expect(spec.args).not.toContain("dangerous");
    expect(spec.acp?.allowTools).toBe(false);
  });
});

describe("devin turn against a fake ACP server", () => {
  const SERVER = `
let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    require("fs").appendFileSync(process.env.FAKE_RPC_LOG, m.method + "\\n");
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "fake-1", configOptions: [{ id: "model", category: "model", currentValue: "swe", options: [{ value: "swe", name: "SWE" }, { group: "g", options: [{ value: "opus", name: "Opus" }] }] }] } });
    else if (m.method === "session/load") {
      if (m.params.sessionId === "gone") out({ jsonrpc: "2.0", id: m.id, error: { code: -32016, message: "Session not found" } });
      else out({ jsonrpc: "2.0", id: m.id, result: { sessionId: m.params.sessionId } });
    } else if (m.method === "session/prompt") {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "FAKE ANSWER" } } } });
      out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

  async function withFake<T>(fn: (rpcLog: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-fake-devin-"));
    const server = path.join(dir, "server.js");
    const rpcLog = path.join(dir, "rpc.log");
    fs.writeFileSync(server, SERVER);
    fs.writeFileSync(rpcLog, "");
    if (process.platform === "win32") fs.writeFileSync(path.join(dir, "devin.cmd"), `@echo off\r\nnode "${server}"\r\n`);
    else fs.writeFileSync(path.join(dir, "devin"), `#!/bin/sh\nexec node "${server}"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    process.env.FAKE_RPC_LOG = rpcLog;
    try {
      return await fn(rpcLog);
    } finally {
      process.env.PATH = oldPath;
      delete process.env.FAKE_RPC_LOG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const turn = (cwd: string, resumeId?: string) =>
    runTurn({ engine: "devin", key: "t", prompt: "say hi", cwd, mcp: {}, timeoutSec: 30, resumeId, idleMs: 20_000, ceilingMs: 30_000 });

  it("discovers models from a throwaway session", async () => {
    await withFake(async () => {
      const models = await discoverAcpModels(Bun.which("devin", { PATH: process.env.PATH })!, ["acp"], 15_000);
      expect(models.map((m) => m.id)).toEqual(["swe", "opus"]);
      expect(models[0].isDefault).toBe(true);
    });
  }, 30_000);

  it("runs new and resumed turns through the ACP lifecycle, and reports a refused resume", async () => {
    await withFake(async (rpcLog) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trb-devin-ws-"));
      try {
        const fresh = await turn(cwd);
        expect(fresh.success).toBe(true);
        expect(fresh.output).toBe("FAKE ANSWER");
        expect(fresh.sessionId).toBe("fake-1");
        expect(fresh.usage?.inputTokens).toBe(12);

        const resumed = await turn(cwd, "live");
        expect(resumed.success).toBe(true);
        expect(resumed.sessionId).toBe("live");

        const refused = await turn(cwd, "gone");
        expect(refused.success).toBe(false);
        expect(refused.resumeRejected).toBe(true);

        expect(fs.readFileSync(rpcLog, "utf-8").trim().split("\n")).toEqual([
          "initialize", "session/new", "session/prompt",
          "initialize", "session/load", "session/prompt",
          "initialize", "session/load",
        ]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }, 60_000);
});
