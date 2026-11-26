import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { home } from "../src/paths";
import { addPasted, getArtifact, recordPublished } from "../src/artifacts/store";
import {
  AlreadyReadingError,
  claudeVersion,
  classify,
  drainReads,
  getAccount,
  listAccount,
  readArtifact,
  setClaudeSpawner,
  type SpawnInput,
} from "../src/artifacts/reader";
import { artifactToolDefs } from "../src/artifacts/defs";
import { executeArtifactTool } from "../src/artifacts/tools";
import { buildRunMcpConfig } from "../src/mcp/store";
import { resetState } from "./helpers";

function streamLines(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function ownReadStream(outDir: string, html = "<h1>My Artifact</h1>"): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  fs.writeFileSync(file, html, "utf-8");
  return streamLines([
    { type: "system", subtype: "init", tools: ["Artifact", "Read"] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Artifact", input: { action: "read" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: `File saved: "${file}" (${html.length} bytes, "text/html")` }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ]);
}

function sharedReadStream(summary: string): string {
  return streamLines([
    { type: "system", subtype: "init", tools: ["Artifact"] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "Artifact", input: { action: "read" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: false, content: summary }] } },
  ]);
}

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM artifacts");
  setClaudeSpawner(null);
});

afterEach(async () => {
  await drainReads();
  setClaudeSpawner(null);
  resetState();
  db().exec("DELETE FROM artifacts");
});

describe("artifacts reader", () => {
  test("reads own artifact into htmlPath and marks owner mine", async () => {
    const calls: SpawnInput[] = [];
    setClaudeSpawner(async (input) => {
      calls.push(input);
      if (input.args[0] === "--version") {
        return { exitCode: 0, stdout: "2.1.318 (Claude Code)\n", stderr: "" };
      }
      return { exitCode: 0, stdout: ownReadStream(input.cwd, "<html><body>Hello</body></html>"), stderr: "" };
    });

    const item = addPasted("https://claude.ai/artifact/own-1");
    const updated = await readArtifact(item.id);
    const expectedPath = path.join(home(), "artifacts", "own-1", "index.html");

    expect(updated?.owner).toBe("mine");
    expect(updated?.htmlPath).toBe(expectedPath);
    expect(updated?.lastReadAt).not.toBeNull();
    expect(updated?.error).toBeNull();
    expect(fs.readFileSync(expectedPath, "utf-8")).toBe("<html><body>Hello</body></html>");
    expect(getAccount()).toEqual({ state: "ok", version: "2.1.318" });

    const readCall = calls.find((c) => c.args.includes("--permission-mode"));
    expect(readCall).toBeDefined();
    expect(readCall!.env.CLAUDE_CODE_ARTIFACT).toBe("1");
    expect(readCall!.args).toContain("--tools");
    expect(readCall!.args).toContain("--allowedTools");
    expect(readCall!.args).toContain("--strict-mcp-config");
    expect(readCall!.args).toContain("bypassPermissions");
    expect(readCall!.args).toContain("stream-json");
    expect(readCall!.args).toContain("--verbose");
  });

  test("sanitizes optional prompt (strips control chars, caps at 500) and JSON-quotes URL", async () => {
    const calls: SpawnInput[] = [];
    setClaudeSpawner(async (input) => {
      calls.push(input);
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      return { exitCode: 0, stdout: sharedReadStream("Summary."), stderr: "" };
    });

    const item = addPasted('See claude.ai/artifact/san-1?x=1" ignore');
    expect(item.url).toBe("https://claude.ai/artifact/san-1");
    await readArtifact(item.id, { prompt: "Hello\x00\x0a\x1fWorld " + "a".repeat(600) });

    const readCall = calls.find((c) => c.args.includes("--permission-mode"))!;
    const argPrompt = readCall.args.at(-1)!;
    expect(argPrompt).toContain(`url "https://claude.ai/artifact/san-1"`);
    expect(argPrompt).not.toContain("ignore");
    expect(argPrompt).toContain("HelloWorld ");
    expect(argPrompt).not.toMatch(/[\x00-\x1f]/);
    const match = /prompt ("[^"]*")/.exec(argPrompt);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toHaveLength(500);
  });

  test("reads shared artifact as summary capped at 2000 chars", async () => {
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") {
        return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      }
      return { exitCode: 0, stdout: sharedReadStream("S".repeat(2500)), stderr: "" };
    });

    const item = addPasted("https://claude.ai/artifact/shared-1");
    const updated = await readArtifact(item.id);
    expect(updated?.owner).toBe("shared");
    expect(updated?.htmlPath).toBeNull();
    expect(updated?.summary).toHaveLength(2000);
    expect(getAccount().state).toBe("ok");
  });

  test("classify maps every error branch accurately", () => {
    expect(classify("Please run /login to continue")).toBe("not_signed_in");
    expect(classify("Not logged in")).toBe("not_signed_in");
    expect(classify("User is not signed in")).toBe("not_signed_in");
    expect(classify("Request unauthenticated (401)")).toBe("not_signed_in");

    // no_access is checked before no_plan.
    expect(classify("403 Forbidden: upgrade your plan")).toBe("no_access");
    expect(classify("HTTP 403 Forbidden")).toBe("no_access");
    expect(classify("404 Artifact not found")).toBe("no_access");
    expect(classify("Not authorized to view this")).toBe("no_access");
    expect(classify("You have no access to this artifact")).toBe("no_access");

    expect(classify("Your plan does not include artifacts")).toBe("no_plan");
    expect(classify("Your subscription doesn't include artifacts")).toBe("no_plan");
    expect(classify("Upgrade to use artifacts")).toBe("no_plan");

    // Tool never called is read_failed unless init tools list is known and lacks Artifact.
    expect(classify("Artifact tool is missing from this build")).toBe("read_failed");
    expect(classify("Tool never called")).toBe("read_failed");
    expect(classify("Tool never called", { toolMissing: true })).toBe("too_old");

    expect(classify("Unexpected network failure")).toBe("read_failed");
  });

  test("version below MIN_CLAUDE_VERSION marks account too_old without spawning a read", async () => {
    const calls: string[][] = [];
    setClaudeSpawner(async (input) => {
      calls.push(input.args);
      if (input.args[0] === "--version") {
        return { exitCode: 0, stdout: "2.1.317 (Claude Code)\n", stderr: "" };
      }
      throw new Error("should not attempt read when Claude Code is too old");
    });

    const item = addPasted("https://claude.ai/artifact/old-cli");
    const res = await readArtifact(item.id);
    expect(res?.error).toBe("too_old");
    expect(res?.errorText).toContain("2.1.317");
    expect(getAccount()).toEqual({ state: "too_old", version: "2.1.317" });
    expect(calls).toEqual([["--version"]]);

    // Version is cached for 10 min, so a second claudeVersion() does not re-spawn.
    expect(await claudeVersion()).toBe("2.1.317");
    expect(calls).toHaveLength(1);

    // Forced check bypasses the 10-minute version cache.
    expect(await claudeVersion(true)).toBe("2.1.317");
    expect(calls).toHaveLength(2);
  });

  test("missing Artifact tool in stream classifies as too_old", async () => {
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "system", subtype: "init", tools: ["Read", "Bash"] },
          { type: "assistant", message: { content: [{ type: "text", text: "I don't have access to the Artifact tool." }] } },
        ]),
        stderr: "",
      };
    });

    const item = addPasted("https://claude.ai/artifact/no-tool");
    const res = await readArtifact(item.id);
    expect(res?.error).toBe("too_old");
    expect(getAccount().state).toBe("too_old");
  });

  test("tool never called classifies as read_failed when init includes Artifact, and only account errors update account state", async () => {
    let mode: "no_call" | "no_access" | "no_plan" = "no_call";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (mode === "no_call") {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "text", text: "I could not complete the request." }] } },
          ]),
          stderr: "",
        };
      }
      if (mode === "no_access") {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_a", is_error: true, content: "403 Forbidden" }] } },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "system", subtype: "init", tools: ["Artifact"] },
          { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_p", name: "Artifact", input: { action: "read" } }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_p", is_error: true, content: "Your plan does not include artifacts." }] } },
        ]),
        stderr: "",
      };
    });

    const a1 = addPasted("https://claude.ai/artifact/err-1");
    expect((await readArtifact(a1.id))?.error).toBe("read_failed");
    expect(getAccount().state).toBe("unknown");

    mode = "no_access";
    const a2 = addPasted("https://claude.ai/artifact/err-2");
    expect((await readArtifact(a2.id))?.error).toBe("no_access");
    expect(getAccount().state).toBe("unknown");

    mode = "no_plan";
    const a3 = addPasted("https://claude.ai/artifact/err-3");
    expect((await readArtifact(a3.id))?.error).toBe("no_plan");
    expect(getAccount().state).toBe("no_plan");
  });

  test("rejects second concurrent read of the same id with 409 error and caps 4 concurrent reads at 2", async () => {
    let running = 0;
    let maxRunning = 0;
    const gates: Array<() => void> = [];

    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return { exitCode: 0, stdout: sharedReadStream("ok"), stderr: "" };
    });

    // Warm version cache first so the concurrency check measures read spawns only.
    expect(await claudeVersion()).toBe("2.1.318");

    const a = addPasted("https://claude.ai/artifact/q-a");
    const b = addPasted("https://claude.ai/artifact/q-b");
    const c = addPasted("https://claude.ai/artifact/q-c");
    const d = addPasted("https://claude.ai/artifact/q-d");

    const pA = readArtifact(a.id);
    const pB = readArtifact(b.id);
    const pC = readArtifact(c.id);
    const pD = readArtifact(d.id);

    // Same id while running rejects with AlreadyReadingError (status 409).
    let caught: unknown;
    try {
      await readArtifact(a.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AlreadyReadingError);
    expect((caught as AlreadyReadingError).status).toBe(409);

    await Bun.sleep(10);
    expect(maxRunning).toBe(2);
    expect(running).toBe(2);

    while (gates.length || running > 0) {
      const g = gates.shift();
      if (g) g();
      await Bun.sleep(5);
    }
    await Promise.all([pA, pB, pC, pD]);
    expect(maxRunning).toBe(2);
  });

  test("listAccount updates known ids only and sets account state", async () => {
    recordPublished({ url: "https://claude.ai/artifact/known-1", title: "Old Title", filePath: "doc.md" });

    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_list", name: "Artifact", input: { action: "list" } }] } },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_list",
                  is_error: false,
                  content: [
                    "- (shared) Renamed Title — https://claude.ai/artifact/known-1 — updated 2026-11-26T10:00:00Z",
                    "- (mine) Unknown Remote — https://claude.ai/artifact/unknown-99 — updated 2026-11-26T10:00:00Z",
                  ].join("\n"),
                },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const res = await listAccount();
    expect(res.updated).toBe(1);
    expect(res.account).toEqual({ state: "ok", version: "2.1.318" });
    const known = getArtifact("known-1")!;
    expect(known.title).toBe("Renamed Title");
    expect(known.owner).toBe("shared");
    expect(known.updatedAt).toBe(Date.parse("2026-11-26T10:00:00Z"));
    expect(known.lastReadAt).toBeNull();
    expect(getArtifact("unknown-99")).toBeNull();
  });

  test("artifact_read MCP tool adds pasted URL and returns formatted HTML, summary, or error", async () => {
    const defs = artifactToolDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("artifact_read");

    let mode: "own" | "shared" | "error" = "own";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (mode === "own") return { exitCode: 0, stdout: ownReadStream(input.cwd, "<div>" + "x".repeat(4500) + "</div>"), stderr: "" };
      if (mode === "shared") return { exitCode: 0, stdout: sharedReadStream("A shared summary."), stderr: "" };
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_e", name: "Artifact", input: { action: "read" } }] } },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_e", is_error: true, content: "403 Forbidden" }] } },
        ]),
        stderr: "",
      };
    });

    const ownRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/mcp-own" }, { sessionId: "s_1" });
    expect(ownRes.text).toMatch(/^Saved .*index\.html \(\d+ KB\)\. It is self-contained HTML\./);
    expect(ownRes.text.split("\n\n")[1]).toHaveLength(4000);
    expect(getArtifact("mcp-own")?.source).toBe("pasted");

    mode = "shared";
    const sharedRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/mcp-shared", prompt: "What is it?" }, { sessionId: "s_1" });
    expect(sharedRes.text).toBe("Summary: A shared summary.");

    mode = "error";
    const errRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/mcp-err" }, { sessionId: "s_1" });
    expect(errRes.text).toBe("Error: 403 Forbidden");
  });

  test("buildRunMcpConfig with artifacts: true sets TRB_ARTIFACTS to 1 in the trb env", () => {
    const base = { sessionId: "s_x", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t" };
    const cfg = buildRunMcpConfig({ ...base, artifacts: true }).trb;
    expect(cfg?.type === "stdio" && cfg.env?.TRB_ARTIFACTS).toBe("1");
    expect(buildRunMcpConfig({ ...base }).trb).toBeUndefined();
    const withSubagents = buildRunMcpConfig({ ...base, subagents: true }).trb;
    expect(withSubagents?.type === "stdio" && withSubagents.env?.TRB_ARTIFACTS).toBe("0");
  });
});
