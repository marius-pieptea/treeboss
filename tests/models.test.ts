import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { clearModelCache, effortsFor, listModels, parseAgyModels, parseCodexModels, parseCursorModels, parseGrokModels, parseOpencodeModels } from "../src/engines/models";
import { startServer } from "../src/daemon/server";

const fx = (name: string) => fs.readFileSync(path.join(import.meta.dir, "fixtures", "models", name), "utf-8");

describe("parsers (real CLI output)", () => {
  test("cursor: id - Label, the default flagged and stripped from the label", () => {
    const m = parseCursorModels(fx("cursor.txt"));
    expect(m.length).toBeGreaterThan(8);
    expect(m[0]).toMatchObject({ id: "auto", label: "Auto", default: true });
    expect(m.find((x) => x.id === "gpt-5.3-codex-high")).toMatchObject({ label: "Codex 5.3 High" });
    expect(m.some((x) => x.id === "Available")).toBe(false);
  });

  test("opencode: provider/model, grouped by provider", () => {
    const m = parseOpencodeModels(fx("opencode.txt"));
    expect(m.length).toBeGreaterThan(15);
    expect(m[0]).toMatchObject({ id: "opencode/big-pickle", group: "opencode", label: "big-pickle" });
    expect(m.find((x) => x.group === "opencode-go")).toBeTruthy();
  });

  test("grok: the starred entry is the default", () => {
    const m = parseGrokModels(fx("grok.txt"));
    expect(m.map((x) => x.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]);
    expect(m.filter((x) => x.default).map((x) => x.id)).toEqual(["grok-4.7"]);
  });

  test("agy: tab separated, grouped by family", () => {
    const m = parseAgyModels(fx("agy.txt"));
    expect(m.length).toBeGreaterThan(5);
    expect(m[0]).toEqual({ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", group: "Gemini 3.8 Flash" });
    expect(m.some((x) => x.id.startsWith("Fetching"))).toBe(false);
  });

  test("codex: JSON catalog with each model's reasoning levels; hidden models are skipped", () => {
    const m = parseCodexModels(fx("codex.json"));
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].efforts).toEqual(expect.arrayContaining(["low", "high"]));
    const hidden = JSON.stringify({ models: [{ slug: "secret", display_name: "secret", visibility: "hide" }, { slug: "shown", display_name: "Shown", visibility: "list" }] });
    expect(parseCodexModels(hidden).map((x) => x.id)).toEqual(["shown"]);
    expect(parseCodexModels("not json")).toEqual([]);
  });
});

describe("catalog", () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = oldPath;
  });
  beforeEach(() => {
    process.env.PATH = oldPath;
    clearModelCache();
  });

  /** A stand-in `cursor-agent` that prints a model list and counts how often it was asked. */
  function stubCursor(body: string, exit = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-stub-"));
    dirs.push(dir);
    const counter = path.join(dir, "calls");
    if (process.platform === "win32") {
      // Windows finds a program by PATHEXT, so an extensionless script is never found: the real CLI would answer.
      const out = path.join(dir, "out.txt");
      fs.writeFileSync(out, `${body}\n`);
      fs.writeFileSync(path.join(dir, "cursor-agent.cmd"), `@echo off\r\necho x>>"${counter}"\r\ntype "${out}"\r\nexit /b ${exit}\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, "cursor-agent"), `#!/bin/sh\necho x >> ${counter}\ncat <<'EOF'\n${body}\nEOF\nexit ${exit}\n`, { mode: 0o755 });
    }
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    return () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf-8").trim().split("\n").length : 0);
  }

  test("claude, which cannot list models, gets a built-in list with aliases and efforts", async () => {
    const c = await listModels("claude");
    expect(c.source).toBe("static");
    expect(c.models.map((m) => m.id)).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku", "claude-opus-5-5"]));
    expect(c.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(c.error).toBeUndefined();
  });

  test("an engine that can list asks its CLI once, then serves the cache; refresh asks again", async () => {
    const calls = stubCursor("Available models\n\nauto - Auto (current, default)\nfast-one - Fast One");
    const a = await listModels("cursor");
    expect(a).toMatchObject({ source: "cli", models: [{ id: "auto", default: true }, { id: "fast-one" }] });
    await listModels("cursor");
    expect(calls()).toBe(1);
    await listModels("cursor", { refresh: true });
    expect(calls()).toBe(2);
  });

  test("the list is also kept on disk, so a restarted daemon does not re-ask a slow CLI", async () => {
    const calls = stubCursor("auto - Auto");
    await listModels("cursor");
    expect(calls()).toBe(1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.TRB_HOME!, "models-cache.json"), "utf-8"));
    expect(onDisk.cursor.models[0].id).toBe("auto");
  });

  test("a failing CLI falls back to the static answer with the reason, and keeps an older good list", async () => {
    stubCursor("auto - Auto");
    const good = await listModels("cursor");
    expect(good.source).toBe("cli");
    stubCursor("Error: not signed in", 1);
    const after = await listModels("cursor", { refresh: true });
    expect(after.source).toBe("cli"); // the earlier list is not thrown away…
    expect(after.models).toEqual(good.models);
    expect(after.error).toContain("not signed in"); // …but the problem is reported
  });

  test("a CLI that is not installed says so", async () => {
    process.env.PATH = "/usr/bin:/bin"; // no cursor-agent
    const c = await listModels("opencode");
    expect(c.source).toBe("static");
    expect(c.models).toEqual([]);
    expect(c.error).toBeTruthy();
  });

  test("efforts per engine", () => {
    expect(effortsFor("claude")).toContain("xhigh");
    expect(effortsFor("cursor")).toEqual([]);
  });
});

describe("API", () => {
  test("GET /api/engines/:id/models, and 404 for an unknown engine", async () => {
    const srv = startServer({ port: 0, token: "t" });
    const get = (p: string) => fetch(`${srv.url}${p}`, { headers: { authorization: "Bearer t" } });
    const ok = await get("/api/engines/claude/models");
    expect(ok.status).toBe(200);
    expect((await ok.json()).models.some((m: any) => m.id === "haiku")).toBe(true);
    expect((await get("/api/engines/nope/models")).status).toBe(404);
    srv.stop();
  });
});
