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
  parseArtifactHeader,
  parseFilesList,
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
    // usage_limit is checked first across every limit phrasing.
    expect(classify("You've hit your 5-hour limit")).toBe("usage_limit");
    expect(classify("Usage limit exceeded")).toBe("usage_limit");
    expect(classify("Rate limit reached by API")).toBe("usage_limit");
    expect(classify("Limit reached, please wait")).toBe("usage_limit");
    expect(classify("You are out of usage until reset")).toBe("usage_limit");
    expect(classify("You are out of extra usage")).toBe("usage_limit");
    expect(classify("HTTP 429 Too Many Requests")).toBe("usage_limit");
    expect(classify("429 rate limit: /login 403", { toolMissing: true })).toBe("usage_limit");

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

  test("usage_limit updates account state from stderr/result, formats artifact_read errors, and resets to ok on later success", async () => {
    let mode: "limit_result" | "limit_stderr" | "not_signed_in" | "ok" = "limit_result";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (mode === "limit_result") {
        return {
          exitCode: 1,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "result", is_error: true, result: "You've hit your 5-hour limit · resets 6pm" },
          ]),
          stderr: "",
        };
      }
      if (mode === "limit_stderr") {
        return {
          exitCode: 1,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_u", name: "Artifact", input: { action: "read" } }] } },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_u", is_error: true, content: "Request failed" }] } },
          ]),
          stderr: "Error: HTTP 429 rate limit",
        };
      }
      if (mode === "not_signed_in") {
        return {
          exitCode: 1,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "result", is_error: true, result: "Please run /login" },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: sharedReadStream("Recovered summary."), stderr: "" };
    });

    const limRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/lim-1" }, { sessionId: "s_1" });
    expect(getArtifact("lim-1")?.error).toBe("usage_limit");
    expect(getAccount().state).toBe("usage_limit");
    expect(limRes.text).toBe(
      "Error: Claude's usage limit is reached, so artifacts can't be read right now. artifact_read runs Claude Code on the owner's subscription; try again after the limit resets.",
    );

    mode = "not_signed_in";
    const authRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/auth-1" }, { sessionId: "s_1" });
    expect(getArtifact("auth-1")?.error).toBe("not_signed_in");
    expect(getAccount().state).toBe("not_signed_in");
    expect(authRes.text).toBe("Error: Claude Code is not signed in to claude.ai, so artifacts can't be read.");

    mode = "limit_stderr";
    const lim2 = addPasted("https://claude.ai/artifact/lim-2");
    expect((await readArtifact(lim2.id))?.error).toBe("usage_limit");
    expect(getAccount().state).toBe("usage_limit");

    mode = "ok";
    const ok = await readArtifact("lim-2");
    expect(ok?.error).toBeNull();
    expect(getAccount().state).toBe("ok");
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
    mode = "own";
    if (mode === "own") {
      // keep type inference happy
    }
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (mode === "own") return { exitCode: 0, stdout: ownReadStream(input.cwd, "<div>" + "x".repeat(25000) + "</div>"), stderr: "" };
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
    expect(ownRes.text.split("\n\n")[1]).toHaveLength(20000);
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

  test("parseArtifactHeader classifies Docs, Design, plain owned, writer, and shared headers", () => {
    const docsHeader = [
      "Artifact 11111111-2222-3333-4444-555555555555 (version 3) — owned by you, private",
      'an Artifact of type "Docs"',
      "Created from the Artifact type https://claude.ai/artifact/type-docs-1",
      'Its content is a Claude Docs document that already exists; its Claude Docs id is this Artifact\'s own id, "11111111-2222-3333-4444-555555555555".',
      "<artifact-type-instructions>\n---\nname: pages\n---\n</artifact-type-instructions>",
    ].join("\n");
    expect(parseArtifactHeader(docsHeader)).toEqual({
      artifactUuid: "11111111-2222-3333-4444-555555555555",
      owned: true,
      typeName: "Docs",
      typeId: "type-docs-1",
      docsId: "11111111-2222-3333-4444-555555555555",
      title: null,
      isTyped: true,
    });

    const designHeader = [
      "Artifact aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee (version 1) — owned by you, private",
      'an Artifact of type "Design"',
      "Created from the Artifact type https://claude.ai/artifact/type-design-1",
    ].join("\n");
    expect(parseArtifactHeader(designHeader)).toEqual({
      artifactUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      owned: true,
      typeName: "Design",
      typeId: "type-design-1",
      docsId: null,
      title: null,
      isTyped: true,
    });

    const plainHeader = "Artifact 99999999-aaaa-bbbb-cccc-dddddddddddd (version 1) — owned by you, private";
    expect(parseArtifactHeader(plainHeader)).toEqual({
      artifactUuid: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      owned: true,
      typeName: null,
      typeId: null,
      docsId: null,
      title: null,
      isTyped: false,
    });

    const writerHeader = "Artifact 22222222-bbbb-cccc-dddd-eeeeeeeeeeee (version 2) — owned by Alice, writer";
    expect(parseArtifactHeader(writerHeader).owned).toBe(true);

    const sharedHeader = [
      "Artifact 33333333-bbbb-cccc-dddd-eeeeeeeeeeee (version 2) — owned by Bob",
      "Summary: This document describes a writer in Paris.",
    ].join("\n");
    expect(parseArtifactHeader(sharedHeader).owned).toBe(false);
    expect(parseArtifactHeader("Summary of a shared artifact with a writer.").owned).toBe(false);
  });

  test("parseFilesList extracts project/ paths, skips >2MB binaries, and caps at 60", () => {
    const lines = [
      'Artifact abc (version 1), an Artifact of type "Design", 65 files',
      "- project/canvas.json (512 bytes)",
      "- project/Home.dc.html (12.5 KB)",
      "- project/assets/big-video.mp4 (3.2 MB)",
      "- project/assets/huge-text.json (3.0 MB)",
      "- project/../escape.txt (10 bytes)",
      "- src/ignored.ts (100 bytes)",
      ...Array.from({ length: 65 }, (_, i) => `- project/board-${i}.dc.html (1 KB)`),
    ].join("\n");
    const parsed = parseFilesList(lines);
    expect(parsed.typeName).toBe("Design");
    expect(parsed.paths).toHaveLength(60);
    expect(parsed.paths).toContain("project/canvas.json");
    expect(parsed.paths).toContain("project/Home.dc.html");
    expect(parsed.paths).toContain("project/assets/huge-text.json");
    expect(parsed.paths).not.toContain("project/assets/big-video.mp4");
    expect(parsed.paths).not.toContain("project/../escape.txt");
    expect(parsed.paths).not.toContain("src/ignored.ts");
  });

  test("Docs two-step flow writes content.md with tabs, fills title, and artifact_read formats markdown", async () => {
    const calls: SpawnInput[] = [];
    const docsUuid = "aaaaaaaa-1111-2222-3333-444444444444";
    setClaudeSpawner(async (input) => {
      calls.push(input);
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.includes("--strict-mcp-config")) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_a",
                    is_error: false,
                    content: [
                      `Artifact ${docsUuid} (version 2) — owned by you, private`,
                      'an Artifact of type "Docs"',
                      "Created from the Artifact type https://claude.ai/artifact/docs-type",
                      `Its content is a Claude Docs document that already exists; its Claude Docs id is this Artifact's own id, "${docsUuid}".`,
                    ].join("\n"),
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      // Step B: non-strict Docs run
      return {
        exitCode: 0,
        stdout: streamLines([
          {
            type: "system",
            subtype: "init",
            tools: ["ToolSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__claude_ai_Claude_Docs__export"],
          },
          {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_r", name: "mcp__claude_ai_Claude_Docs__read", input: { ref: { object: "project", id: docsUuid } } },
                { type: "tool_use", id: "tu_e1", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { kind: "project", id: docsUuid }, file: "tab-1", format: "markdown" } },
                { type: "tool_use", id: "tu_e2", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { kind: "project", id: docsUuid }, file: "tab-2", format: "markdown" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_r",
                  is_error: false,
                  content:
                    JSON.stringify({
                      value: { name: "Architecture Doc" },
                      files: [
                        { id: "tab-1", name: "Overview" },
                        { id: "tab-2", name: "API" },
                      ],
                    }) + "\n\nThis doc takes suggestions.",
                },
                {
                  type: "tool_result",
                  tool_use_id: "tu_e1",
                  is_error: false,
                  content: JSON.stringify({
                    verdict: "allow",
                    data: { bytes_b64: Buffer.from("First tab body.", "utf-8").toString("base64") },
                  }),
                },
                { type: "tool_result", tool_use_id: "tu_e2", is_error: false, content: "Second tab body." },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const toolRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/docs-1" }, { sessionId: "s_1" });
    const item = getArtifact("docs-1")!;
    const expectedMdPath = path.join(home(), "artifacts", "docs-1", "content.md");

    expect(item.owner).toBe("mine");
    expect(item.typeName).toBe("Docs");
    expect(item.intent).toBe("document");
    expect(item.title).toBe("Architecture Doc");
    expect(item.contentKind).toBe("markdown");
    expect(item.contentPath).toBe(expectedMdPath);
    expect(fs.readFileSync(expectedMdPath, "utf-8")).toBe(
      "# Architecture Doc\n\n## Overview\n\nFirst tab body.\n\n## API\n\nSecond tab body.\n",
    );

    const stepB = calls.find((c) => c.args.includes("default"))!;
    expect(stepB).toBeDefined();
    expect(stepB.args).not.toContain("--strict-mcp-config");
    expect(stepB.args).not.toContain("--mcp-config");
    expect(stepB.args).not.toContain("bypassPermissions");
    expect(stepB.args).toContain("--setting-sources");
    expect(stepB.args[stepB.args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(stepB.args).toContain("--tools");
    expect(stepB.args[stepB.args.indexOf("--tools") + 1]).toBe("");
    expect(stepB.args).toContain("ToolSearch,mcp__claude_ai_Claude_Docs__read,mcp__claude_ai_Claude_Docs__export");

    expect(toolRes.text).toContain('Claude Docs document "Architecture Doc", saved as ');
    expect(toolRes.text).toContain("## Overview\n\nFirst tab body.");
  });

  test("Docs connector missing from init tools returns exact error", async () => {
    const docsUuid = "bbbbbbbb-1111-2222-3333-444444444444";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.includes("--strict-mcp-config")) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_a",
                    is_error: false,
                    content: `Artifact ${docsUuid} (version 1) — owned by you, private\nan Artifact of type "Docs"`,
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([{ type: "system", subtype: "init", tools: ["ToolSearch"] }]),
        stderr: "",
      };
    });

    const item = addPasted("https://claude.ai/artifact/docs-missing");
    const res = await readArtifact(item.id);
    expect(res?.error).toBe("read_failed");
    expect(res?.errorText).toBe(
      "Claude Docs isn't connected in Claude Code. Open claude.ai → Settings → Connectors, or run /mcp in Claude Code.",
    );
  });

  test("files-type flow reads project/ files into files dir and artifact_read includes canvas.json", async () => {
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      const prompt = input.args.at(-1)!;
      if (prompt.includes('action "list"')) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_l", name: "Artifact", input: { action: "list" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_l",
                    is_error: false,
                    content: '- project/canvas.json (42 bytes)\n- project/Home.dc.html (18 bytes)',
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (prompt.includes("paths ")) {
        const projDir = path.join(input.cwd, "project");
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, "canvas.json"), '{"v":1,"title":"Mock","boards":["Home"]}', "utf-8");
        fs.writeFileSync(path.join(projDir, "Home.dc.html"), "<div>Home</div>", "utf-8");
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_f", name: "Artifact", input: { action: "read" } }] } },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_f", is_error: false, content: "Saved 2 files." }] } },
          ]),
          stderr: "",
        };
      }
      // Step A
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "system", subtype: "init", tools: ["Artifact"] },
          { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_a",
                  is_error: false,
                  content:
                    'Artifact cccccccc-1111-2222-3333-444444444444 (version 1) — owned by you, private\nan Artifact of type "Design"',
                },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const toolRes = await executeArtifactTool("artifact_read", { url: "https://claude.ai/artifact/des-flow" }, { sessionId: "s_1" });
    const item = getArtifact("des-flow")!;
    const expectedFilesDir = path.join(home(), "artifacts", "des-flow", "files");

    expect(item.owner).toBe("mine");
    expect(item.title).toBe("Mock");
    expect(item.typeName).toBe("Design");
    expect(item.intent).toBe("design");
    expect(item.contentKind).toBe("files");
    expect(item.contentPath).toBe(expectedFilesDir);
    expect(toolRes.text).toContain(`Artifact of type "Design" with 2 files saved under ${expectedFilesDir}:`);
    expect(toolRes.text).toContain("- project/canvas.json");
    expect(toolRes.text).toContain('{"v":1,"title":"Mock","boards":["Home"]}');
    expect(toolRes.text).toContain("Read the files with your file tool.");
  });

  test("Docs run discards result when a disallowed tool is used", async () => {
    const docsUuid = "cccccccc-2222-3333-4444-555555555555";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.includes("--strict-mcp-config")) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_a",
                    is_error: false,
                    content: `Artifact ${docsUuid} (version 1) — owned by you, private\nan Artifact of type "Docs"`,
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([
          {
            type: "system",
            subtype: "init",
            tools: ["ToolSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__claude_ai_Claude_Docs__export"],
          },
          {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_bad", name: "Bash", input: { command: "echo pwned" } },
                { type: "tool_use", id: "tu_r", name: "mcp__claude_ai_Claude_Docs__read", input: { ref: { id: docsUuid } } },
                { type: "tool_use", id: "tu_e", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { id: docsUuid }, file: "t1", format: "markdown" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "tu_r", is_error: false, content: JSON.stringify({ files: [{ id: "t1", name: "Tab" }] }) },
                { type: "tool_result", tool_use_id: "tu_e", is_error: false, content: "Body" },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const item = addPasted("https://claude.ai/artifact/docs-disallowed");
    const res = await readArtifact(item.id);
    expect(res?.error).toBe("read_failed");
    expect(res?.errorText).toBe("The Claude Docs read used a tool it was not allowed to use, so its result was discarded.");
    expect(fs.existsSync(path.join(home(), "artifacts", "docs-disallowed", "content.md"))).toBe(false);
  });

  test("Docs run ignores mismatched read/export containers and notes failed tabs", async () => {
    const docsUuid = "dddddddd-1111-2222-3333-444444444444";
    const otherUuid = "eeeeeeee-1111-2222-3333-444444444444";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.includes("--strict-mcp-config")) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_a",
                    is_error: false,
                    content: `Artifact ${docsUuid} (version 1) — owned by you, private\nan Artifact of type "Docs"`,
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([
          {
            type: "system",
            subtype: "init",
            tools: ["ToolSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__claude_ai_Claude_Docs__export"],
          },
          {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_r_wrong", name: "mcp__claude_ai_Claude_Docs__read", input: { ref: { id: otherUuid } } },
                { type: "tool_use", id: "tu_r_ok", name: "mcp__claude_ai_Claude_Docs__read", input: { ref: { id: docsUuid } } },
                { type: "tool_use", id: "tu_e_wrong_id", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { id: otherUuid }, file: "tab-2", format: "markdown" } },
                { type: "tool_use", id: "tu_e_wrong_fmt", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { id: docsUuid }, file: "tab-2", format: "html" } },
                { type: "tool_use", id: "tu_e_ok", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { id: docsUuid }, file: "tab-1", format: "markdown" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "tu_r_wrong", is_error: false, content: JSON.stringify({ value: { name: "Wrong Doc" }, files: [{ id: "tab-x", name: "Wrong" }] }) },
                { type: "tool_result", tool_use_id: "tu_r_ok", is_error: false, content: JSON.stringify({ value: { name: "Right Doc" }, files: [{ id: "tab-1", name: "Intro" }, { id: "tab-2", name: "MissingTab" }] }) },
                { type: "tool_result", tool_use_id: "tu_e_wrong_id", is_error: false, content: "Leaked other doc content" },
                { type: "tool_result", tool_use_id: "tu_e_wrong_fmt", is_error: false, content: "<p>Wrong format</p>" },
                { type: "tool_result", tool_use_id: "tu_e_ok", is_error: false, content: "Valid tab content." },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const item = addPasted("https://claude.ai/artifact/docs-mismatch");
    const res = await readArtifact(item.id);
    expect(res?.error).toBeNull();
    const md = fs.readFileSync(res!.contentPath!, "utf-8");
    expect(md).toContain("# Right Doc");
    expect(md).toContain("## Intro\n\nValid tab content.");
    expect(md).not.toContain("Leaked other doc content");
    expect(md).not.toContain("Wrong format");
    expect(md).toEndWith("\n\n> Some tabs could not be read: MissingTab\n");
  });

  test("Docs content.md cut at 2 MB appends truncation marker", async () => {
    const docsUuid = "eeeeeeee-2222-3333-4444-555555555555";
    const bigBody = "A".repeat(2 * 1024 * 1024 + 5000);
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.includes("--strict-mcp-config")) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_a",
                    is_error: false,
                    content: `Artifact ${docsUuid} (version 1) — owned by you, private\nan Artifact of type "Docs"`,
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "system", subtype: "init", tools: ["ToolSearch", "mcp__claude_ai_Claude_Docs__read", "mcp__claude_ai_Claude_Docs__export"] },
          {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "tu_r", name: "mcp__claude_ai_Claude_Docs__read", input: { ref: { id: docsUuid } } },
                { type: "tool_use", id: "tu_e", name: "mcp__claude_ai_Claude_Docs__export", input: { container: { id: docsUuid }, file: "t1", format: "markdown" } },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "tu_r", is_error: false, content: JSON.stringify({ value: { name: "Huge Doc" }, files: [{ id: "t1", name: "Main" }] }) },
                { type: "tool_result", tool_use_id: "tu_e", is_error: false, content: bigBody },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const item = addPasted("https://claude.ai/artifact/docs-huge");
    const res = await readArtifact(item.id);
    expect(res?.error).toBeNull();
    const md = fs.readFileSync(res!.contentPath!, "utf-8");
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(md.endsWith("\n\n[truncated at 2 MB]")).toBe(true);
  });

  test("parseFilesList drops injection-like file names and includes project/canvas.json past the 60 cap", () => {
    const lines = [
      'Artifact xyz (version 1), an Artifact of type "Design", 70 files',
      '- "project/evil; rm -rf /" (10 bytes)',
      "- project/$(whoami).json (10 bytes)",
      "- project/a&b.html (10 bytes)",
      '- "project/good-file (1)@2x.png" (10 bytes)',
      ...Array.from({ length: 65 }, (_, i) => `- project/board-${i}.dc.html (1 KB)`),
      "- project/canvas.json (512 bytes)",
    ].join("\n");
    const parsed = parseFilesList(lines);
    expect(parsed.truncated).toBe(true);
    expect(parsed.paths).toHaveLength(60);
    expect(parsed.paths).toContain("project/good-file (1)@2x.png");
    expect(parsed.paths).toContain("project/canvas.json");
    expect(parsed.paths.some((p) => p.includes("evil") || p.includes("whoami") || p.includes("&"))).toBe(false);
  });

  test("files read clears stale files dir, notes 60-file cap, and caps inlined index JSON at 20000 chars", async () => {
    const id = "des-cap";
    const filesDir = path.join(home(), "artifacts", id, "files");
    const staleFile = path.join(filesDir, "project", "stale.txt");
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, "old-stale-content", "utf-8");

    const hugeCanvas = JSON.stringify({ title: "Big", data: "x".repeat(25_000) });
    let mode: "canvas" | "huge_other" | "small_other" = "canvas";
    const listText = [
      ...Array.from({ length: 62 }, (_, i) => `- project/board-${i}.dc.html (100 bytes)`),
      "- project/canvas.json (26 KB)",
    ].join("\n");

    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      const prompt = input.args.at(-1)!;
      if (prompt.includes('action "list"')) {
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_l", name: "Artifact", input: { action: "list" } }] } },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tu_l",
                    is_error: false,
                    content:
                      mode === "canvas"
                        ? listText
                        : mode === "huge_other"
                          ? "- project/huge.json (66 KB)"
                          : "- project/huge.json (66 KB)\n- project/small.json (11 bytes)",
                  },
                ],
              },
            },
          ]),
          stderr: "",
        };
      }
      if (prompt.includes("paths ")) {
        const projDir = path.join(input.cwd, "project");
        fs.mkdirSync(projDir, { recursive: true });
        if (mode === "canvas") {
          fs.writeFileSync(path.join(projDir, "canvas.json"), hugeCanvas, "utf-8");
          fs.writeFileSync(path.join(projDir, "board-0.dc.html"), "<div>0</div>", "utf-8");
        } else if (mode === "huge_other") {
          fs.writeFileSync(path.join(projDir, "huge.json"), JSON.stringify({ big: "y".repeat(66_000) }), "utf-8");
        } else {
          fs.writeFileSync(path.join(projDir, "huge.json"), JSON.stringify({ big: "y".repeat(66_000) }), "utf-8");
          fs.writeFileSync(path.join(projDir, "small.json"), JSON.stringify({ ok: true }), "utf-8");
        }
        return {
          exitCode: 0,
          stdout: streamLines([
            { type: "system", subtype: "init", tools: ["Artifact"] },
            { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_f", name: "Artifact", input: { action: "read" } }] } },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_f", is_error: false, content: "Saved." }] } },
          ]),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: streamLines([
          { type: "system", subtype: "init", tools: ["Artifact"] },
          { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "Artifact", input: { action: "read" } }] } },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu_a",
                  is_error: false,
                  content: 'Artifact ffffffff-1111-2222-3333-444444444444 (version 1) — owned by you, private\nan Artifact of type "Design"',
                },
              ],
            },
          },
        ]),
        stderr: "",
      };
    });

    const res = await executeArtifactTool("artifact_read", { url: `https://claude.ai/artifact/${id}` }, { sessionId: "s_1" });
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(res.text).toContain("Only the first 60 files were read.");
    expect(res.text).toContain("project/canvas.json:");
    const afterCanvas = res.text.split("project/canvas.json:\n")[1]!;
    const inlinedJson = afterCanvas.split("\n[truncated]")[0]!;
    expect(inlinedJson).toHaveLength(20_000);
    expect(afterCanvas).toContain("\n[truncated]");

    // Without project/canvas.json, a >= 64 KB .json is skipped, and a < 64 KB .json is inlined.
    mode = "huge_other";
    const resNoSmall = await executeArtifactTool("artifact_read", { url: `https://claude.ai/artifact/${id}` }, { sessionId: "s_1" });
    expect(resNoSmall.text).not.toContain("project/huge.json:");
    expect(resNoSmall.text).not.toContain("Only the first 60 files were read.");

    mode = "small_other";
    const resWithSmall = await executeArtifactTool("artifact_read", { url: `https://claude.ai/artifact/${id}` }, { sessionId: "s_1" });
    expect(resWithSmall.text).toContain('project/small.json:\n{"ok":true}');
  });
});
