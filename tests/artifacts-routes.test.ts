import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { home } from "../src/paths";
import { HttpError, makeCtx, type RouteModule } from "../src/daemon/http";
import { artifactRoutes } from "../src/daemon/routes/artifacts";
import { coreRoutes } from "../src/daemon/routes/core";
import { drainReads, setClaudeSpawner } from "../src/artifacts/reader";
import { addPasted, getArtifact } from "../src/artifacts/store";
import { createLead, interruptAll } from "../src/sessions/manager";
import { UserError } from "../src/util";
import { makeDir, resetState, settled } from "./helpers";

async function callRoute(
  route: RouteModule,
  method: string,
  p: string,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: () => Promise<any>; text: () => Promise<string> }> {
  const url = new URL(`http://127.0.0.1${p}`);
  const req = new Request(url, { method, headers });
  try {
    const res = await route(makeCtx(req, url, body));
    if (!res) throw new Error(`no route answered ${method} ${p}`);
    return {
      status: res.status,
      headers: res.headers,
      json: () => res.json(),
      text: () => res.text(),
    };
  } catch (err: any) {
    if (err instanceof HttpError) {
      return {
        status: err.status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: err.message }),
        text: async () => JSON.stringify({ error: err.message }),
      };
    }
    if (err instanceof UserError) {
      return {
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: err.message }),
        text: async () => JSON.stringify({ error: err.message }),
      };
    }
    throw err;
  }
}

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM artifacts");
  setClaudeSpawner(async (input) => {
    if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
    return {
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Artifact", input: { action: "read" } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "Shared summary." }] } }),
      ].join("\n") + "\n",
      stderr: "",
    };
  });
});

afterEach(async () => {
  await drainReads();
  await interruptAll();
  setClaudeSpawner(null);
  resetState();
  db().exec("DELETE FROM artifacts");
});

describe("artifacts HTTP routes", () => {
  test("adds a good URL, rejects chat and invalid links with exact error copy, and handles duplicates", async () => {
    const addedRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/art-1" });
    expect(addedRes.status).toBe(200);
    const added = await addedRes.json();
    expect(added.item.id).toBe("art-1");
    expect(added.item.lastReadAt).toBeNull();
    await drainReads();

    const dupRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/art-1" });
    expect(dupRes.status).toBe(200);
    expect((await dupRes.json()).item.id).toBe("art-1");

    const chatRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/chat/1234-5678" });
    expect(chatRes.status).toBe(400);
    expect((await chatRes.json()).error).toBe(
      "That is a chat link. Paste a link that starts with claude.ai/artifact/.",
    );

    const badRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://example.com/nope" });
    expect(badRes.status).toBe(400);
    expect((await badRes.json()).error).toBe("Paste a link that starts with claude.ai/artifact/.");
  });

  test("delete and restore round-trip", async () => {
    addPasted("https://claude.ai/artifact/del-1");

    const del = await callRoute(artifactRoutes, "DELETE", "/api/artifacts/del-1");
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(getArtifact("del-1")).toBeNull();

    const restored = await callRoute(artifactRoutes, "POST", "/api/artifacts/del-1/restore");
    expect(restored.status).toBe(200);
    expect((await restored.json()).item.id).toBe("del-1");
    expect(getArtifact("del-1")).not.toBeNull();

    // Re-adding a soft-removed artifact via POST /api/artifacts restores it with 200.
    await callRoute(artifactRoutes, "DELETE", "/api/artifacts/del-1");
    const repasted = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/del-1" });
    expect(repasted.status).toBe(200);
    expect((await repasted.json()).item.id).toBe("del-1");
    expect(getArtifact("del-1")).not.toBeNull();
    await drainReads();
  });

  test("lists 40+ items newest createdAt first with account info", async () => {
    const base = 1_700_000_000_000;
    const insert = db().prepare(
      "INSERT INTO artifacts (id, url, title, intent, owner, source, created_at) VALUES (?, ?, ?, 'other', 'mine', 'created', ?)",
    );
    for (let i = 0; i < 45; i++) {
      insert.run(`a_${i}`, `https://claude.ai/artifact/a_${i}`, `Art ${i}`, base + i * 1000);
    }

    const res = await callRoute(artifactRoutes, "GET", "/api/artifacts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(45);
    expect(body.items[0].id).toBe("a_44");
    expect(body.items[44].id).toBe("a_0");
    expect(body.account).toEqual({ state: "unknown", version: null });
  });

  test("refresh single item returns 409 when already reading, html endpoint serves saved HTML, and account refresh updates known items", async () => {
    let releaseRead!: () => void;
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.at(-1)?.includes('action "list"')) {
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_l", name: "Artifact", input: { action: "list" } }] } }),
            JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_l", is_error: false, content: "- (mine) Updated Name — https://claude.ai/artifact/r-1 — updated 2026-11-26T12:00:00Z" }] } }),
          ].join("\n") + "\n",
          stderr: "",
        };
      }
      await new Promise<void>((r) => (releaseRead = r));
      const outFile = path.join(input.cwd, "index.html");
      fs.writeFileSync(outFile, "<h1>Rendered</h1>", "utf-8");
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_r", name: "Artifact", input: { action: "read" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_r", is_error: false, content: `File saved: "${outFile}"` }] } }),
        ].join("\n") + "\n",
        stderr: "",
      };
    });

    addPasted("https://claude.ai/artifact/r-1");
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/r-1/html")).status).toBe(404);

    const first = callRoute(artifactRoutes, "POST", "/api/artifacts/r-1/refresh");
    await Bun.sleep(20);
    const second = await callRoute(artifactRoutes, "POST", "/api/artifacts/r-1/refresh");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Already reading." });

    releaseRead();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect((await firstRes.json()).item.owner).toBe("mine");

    const htmlRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/r-1/html");
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    expect(await htmlRes.text()).toBe("<h1>Rendered</h1>");

    const listRes = await callRoute(artifactRoutes, "POST", "/api/artifacts/refresh");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ account: { state: "ok", version: "2.1.318" }, updated: 1 });
    expect(getArtifact("r-1")?.title).toBe("Updated Name");

    // Verify /api/tools/call in coreRoutes dispatches artifact_read.
    const lead = await settled(createLead({ prompt: "SAY ok", engine: "fake", cwd: makeDir() }).id);
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      const outFile = path.join(home(), "artifacts", "r-2", "index.html");
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, "<p>MCP</p>", "utf-8");
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_m", name: "Artifact", input: { action: "read" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_m", is_error: false, content: `File saved: "${outFile}"` }] } }),
        ].join("\n") + "\n",
        stderr: "",
      };
    });
    const core = coreRoutes({});
    const toolRes = await callRoute(
      core,
      "POST",
      "/api/tools/call",
      { name: "artifact_read", args: { url: "https://claude.ai/artifact/r-2" } },
      { "x-trb-session": lead.id },
    );
    expect(toolRes.status).toBe(200);
    expect((await toolRes.json()).text).toContain("<p>MCP</p>");
  });
});
