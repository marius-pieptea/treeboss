import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START settings-api\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END settings-api\n"); });
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { probeHttp, probeStdio } from "../src/mcp/probe";
import { McpStore } from "../src/mcp/store";
import { SkillStore } from "../src/skills/store";
import { paths } from "../src/paths";
import { makeDir, resetState } from "./helpers";

const TOKEN = "settings-test-token";
const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let srv: ReturnType<typeof startServer>;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  setDaemonContext(null);
  srv.stop();
});
beforeEach(() => {
  resetState();
  // Skill directories live on disk, not only in the database: a previous test's leftovers (a symlinked one) must not leak.
  for (const e of fs.readdirSync(paths.skills())) fs.rmSync(path.join(paths.skills(), e), { recursive: true, force: true });
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** A minimal MCP server over HTTP, as JSON or as an SSE stream. */
function mcpHttpServer(mode: "json" | "sse" | "unauthorized" | "garbage") {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (mode === "unauthorized") return new Response("no", { status: 401 });
      const msg: any = await req.json().catch(() => ({}));
      if (mode === "garbage") return new Response("<html>hello</html>", { headers: { "content-type": "text/html" } });
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "http-demo", version: "9.9" }, capabilities: {} } : { tools: [{ name: "echo", description: "Echoes input" }, { name: "ping" }] };
      const rpc = { jsonrpc: "2.0", id: msg.id, result };
      const headers: Record<string, string> = { "mcp-session-id": "sess-1" };
      if (mode === "sse") return new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } });
      return Response.json(rpc, { headers });
    },
  });
}

describe("probing MCP servers", () => {
  test("a real stdio server: handshake, tools with descriptions, latency", async () => {
    const r = await probeStdio("bun", ["run", MAIN, "mcp-serve"], {});
    expect(r.ok).toBe(true);
    expect(r.server?.name).toBe("trb");
    expect(r.tools.map((t) => t.name)).toContain("subagent_create");
    expect(r.tools.find((t) => t.name === "subagent_wait")!.description.length).toBeGreaterThan(20);
    expect(r.latencyMs).toBeGreaterThan(0);
  });

  test("a command that does not exist says so", async () => {
    const r = await probeStdio("definitely-not-a-real-binary-xyz", [], {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  test("a server that crashes on start: the exit and its stderr tail come back", async () => {
    const r = await probeStdio("bash", ["-c", "echo 'missing API key' >&2; exit 3"], {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited with code 3/);
    expect(r.stderrTail).toContain("missing API key");
  });

  test("a process that is not an MCP server times out instead of hanging", async () => {
    const t0 = Date.now();
    const r = await probeStdio("bash", ["-c", "sleep 30"], {}, { timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No answer to initialize/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("environment is passed to the server", async () => {
    const script = `read -r line; echo '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"'"$MY_NAME"'","version":"1"}}}'; read -r l2; read -r l3; echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'`;
    const r = await probeStdio("bash", ["-c", script], { MY_NAME: "from-env" });
    expect(r.ok).toBe(true);
    expect(r.server?.name).toBe("from-env");
  });

  test("http: JSON and SSE responses, the session header, tool listing", async () => {
    for (const mode of ["json", "sse"] as const) {
      const s = mcpHttpServer(mode);
      const r = await probeHttp(`http://127.0.0.1:${s.port}/mcp`, {});
      s.stop(true);
      expect(r).toMatchObject({ ok: true, transport: "http", server: { name: "http-demo", version: "9.9" } });
      expect(r.tools).toEqual([{ name: "echo", description: "Echoes input" }, { name: "ping", description: "" }]);
    }
  });

  test("http: refused credentials, not-MCP, and unreachable are distinct messages", async () => {
    const un = mcpHttpServer("unauthorized");
    expect((await probeHttp(`http://127.0.0.1:${un.port}/`, {})).error).toMatch(/refused the credentials/);
    un.stop(true);
    const g = mcpHttpServer("garbage");
    expect((await probeHttp(`http://127.0.0.1:${g.port}/`, {})).error).toMatch(/not an MCP initialize/);
    g.stop(true);
    const dead = await probeHttp("http://127.0.0.1:1/mcp", {});
    expect(dead.ok).toBe(false);
    expect(dead.error).toMatch(/Could not reach/);
  });
});

describe("MCP routes", () => {
  test("POST /api/mcp/:name/test probes a registered server, stdio and http", async () => {
    McpStore.put({ name: "shim", command: "bun", args: ["run", MAIN, "mcp-serve"] });
    const ok = await call("POST", "/api/mcp/shim/test");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "shim", ok: true, transport: "stdio" });
    expect(ok.body.tools.length).toBe(7);

    McpStore.put({ name: "broken", command: "bash", args: ["-c", "echo nope >&2; exit 1"] });
    const bad = await call("POST", "/api/mcp/broken/test");
    expect(bad.status).toBe(200); // a failed probe is a result, not an error
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.stderrTail).toContain("nope");

    const s = mcpHttpServer("json");
    McpStore.put({ name: "remote", url: `http://127.0.0.1:${s.port}/mcp` });
    expect((await call("POST", "/api/mcp/remote/test")).body).toMatchObject({ ok: true, transport: "http" });
    s.stop(true);

    expect((await call("POST", "/api/mcp/ghost/test")).status).toBe(404);
  });

  test("PUT /api/mcp/:name edits in place and keeps the enabled flag", async () => {
    McpStore.put({ name: "ctx", command: "npx", args: ["-y", "old"], env: { A: "1" } });
    McpStore.setEnabled("ctx", false);
    const r = await call("PUT", "/api/mcp/ctx", { command: "npx", args: ["-y", "new"], env: { A: "2", B: "3" } });
    expect(r.status).toBe(200);
    expect(r.body.server).toMatchObject({ args: ["-y", "new"], env: { A: "2", B: "3" }, enabled: false });
    expect((await call("PUT", "/api/mcp/ghost", { command: "x" })).status).toBe(404);
    expect((await call("PUT", "/api/mcp/ctx", { command: "x", url: "https://y" })).status).toBe(400); // command XOR url, in the daemon's words
  });

  test("import: dry run previews without writing, real run writes, bad inputs are clear", async () => {
    const file = path.join(makeDir(), "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { fresh: { command: "node", args: ["s.js"] }, web: { url: "https://h/mcp" }, bad: { nothing: 1 }, trb: { command: "x" } } }));
    McpStore.put({ name: "web", url: "https://old/mcp" });

    const dry = await call("POST", "/api/mcp/import", { from: file, dryRun: true });
    expect(dry.body).toMatchObject({ added: ["fresh"], skipped: ["web"] });
    expect(dry.body.invalid.sort()).toEqual(["bad", "trb"]);
    expect(dry.body.servers.fresh).toEqual({ transport: "stdio", target: "node s.js" });
    expect(McpStore.get("fresh")).toBeNull(); // nothing written

    const real = await call("POST", "/api/mcp/import", { from: file });
    expect(real.body.added).toEqual(["fresh"]);
    expect(McpStore.get("fresh")).not.toBeNull();
    expect(McpStore.get("web")!.url).toBe("https://old/mcp");

    const over = await call("POST", "/api/mcp/import", { from: file, overwrite: true });
    expect(over.body.added.sort()).toEqual(["fresh", "web"]);
    expect(McpStore.get("web")!.url).toBe("https://h/mcp");

    expect((await call("POST", "/api/mcp/import", { from: "/definitely/not/here.json" })).status).toBe(404);
    const junk = path.join(makeDir(), "junk.json");
    fs.writeFileSync(junk, "{not json");
    expect((await call("POST", "/api/mcp/import", { from: junk })).status).toBe(400);
  });
});

describe("skill files", () => {
  const make = (name = "deploy") => SkillStore.create(name, "Deploys things");

  test("create / list / read: content, mtime and the directory listing", async () => {
    const created = await call("POST", "/api/skills/create", { name: "deploy", description: "Deploys things" });
    expect(created.status).toBe(201);
    fs.writeFileSync(path.join(created.body.skill.path, "helper.sh"), "echo hi\n");
    const r = await call("GET", "/api/skills/deploy/file");
    expect(r.status).toBe(200);
    expect(r.body.content).toContain("name: deploy");
    expect(r.body.files.map((f: any) => f.name).sort()).toEqual(["SKILL.md", "helper.sh"]);
    expect((await call("POST", "/api/skills/create", { name: "Bad Name", description: "" })).status).toBe(400);
    expect((await call("POST", "/api/skills/create", { name: "deploy", description: "" })).status).toBe(400); // exists
  });

  test("saving re-parses the description; an optimistic lock refuses a stale write", async () => {
    make();
    const opened = (await call("GET", "/api/skills/deploy/file")).body;
    const put = await call("PUT", "/api/skills/deploy/file", { content: "---\nname: deploy\ndescription: Ship to production\n---\n\nbody\n", expectedMtime: opened.mtime });
    expect(put.status).toBe(200);
    expect(put.body.description).toBe("Ship to production");
    expect(SkillStore.get("deploy")!.description).toBe("Ship to production");
    expect(fs.readFileSync(path.join(SkillStore.get("deploy")!.path, "SKILL.md"), "utf-8")).toContain("body");

    await Bun.sleep(15);
    fs.writeFileSync(path.join(SkillStore.get("deploy")!.path, "SKILL.md"), "changed elsewhere");
    const stale = await call("PUT", "/api/skills/deploy/file", { content: "mine", expectedMtime: put.body.mtime });
    expect(stale.status).toBe(409);
    expect(stale.body.conflict).toBe(true);
    expect(fs.readFileSync(path.join(SkillStore.get("deploy")!.path, "SKILL.md"), "utf-8")).toBe("changed elsewhere");
  });

  test("unknown and malformed names are 404, including traversal spellings", async () => {
    make();
    for (const bad of ["ghost", "..", "%2e%2e", "..%2f..%2fetc%2fpasswd", "Deploy", "a%00b"]) {
      expect((await call("GET", `/api/skills/${bad}/file`)).status).toBe(404);
    }
  });

  test("a SKILL.md symlinked outside is refused for reading and writing, and the target is untouched", async () => {
    const rec = make();
    const outside = path.join(makeDir(), "secret.txt");
    fs.writeFileSync(outside, "TOP SECRET");
    fs.rmSync(path.join(rec.path, "SKILL.md"));
    fs.symlinkSync(outside, path.join(rec.path, "SKILL.md"));
    expect((await call("GET", "/api/skills/deploy/file")).status).toBe(403);
    expect((await call("PUT", "/api/skills/deploy/file", { content: "pwned" })).status).toBe(403);
    expect(fs.readFileSync(outside, "utf-8")).toBe("TOP SECRET");
  });

  test("a skill directory swapped for a symlink out of the skills home is refused", async () => {
    const rec = make();
    const outside = makeDir();
    fs.writeFileSync(path.join(outside, "SKILL.md"), "TOP SECRET");
    fs.rmSync(rec.path, { recursive: true });
    fs.symlinkSync(outside, rec.path);
    expect((await call("GET", "/api/skills/deploy/file")).status).toBe(403);
    expect((await call("PUT", "/api/skills/deploy/file", { content: "pwned" })).status).toBe(403);
    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf-8")).toBe("TOP SECRET");
  });

  test("an oversized SKILL.md is refused on write", async () => {
    make();
    expect((await call("PUT", "/api/skills/deploy/file", { content: "x".repeat(600 * 1024) })).status).toBe(413);
  });

  test("import a directory of skills; a missing directory is a 404", async () => {
    const root = makeDir();
    for (const n of ["one", "two"]) {
      fs.mkdirSync(path.join(root, n));
      fs.writeFileSync(path.join(root, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n} skill\n---\n`);
    }
    const r = await call("POST", "/api/skills/import", { dir: root });
    expect(r.body.added.sort()).toEqual(["one", "two"]);
    expect((await call("POST", "/api/skills/import", { dir: root })).body.skipped.sort()).toEqual(["one", "two"]);
    expect((await call("POST", "/api/skills/import", { dir: "/nope/nope" })).status).toBe(404);
    expect((await call("POST", "/api/skills/import", {})).status).toBe(400);
    expect(fs.existsSync(path.join(paths.skills(), "one", "SKILL.md"))).toBe(true);
  });
});

describe("doctor", () => {
  test("a structured report with engines, counts and the shim handshake", async () => {
    const r = await call("GET", "/api/doctor");
    expect(r.status).toBe(200);
    expect(["ok", "warn", "fail"]).toContain(r.body.status);
    expect(r.body.checks.find((c: any) => c.id === "git")).toMatchObject({ level: "ok" });
    expect(r.body.checks.find((c: any) => c.id === "shim")).toMatchObject({ level: "ok", text: expect.stringContaining("7 tools") });
    expect(r.body.checks.find((c: any) => c.id === "daemon")).toMatchObject({ level: "ok" });
    const fake = r.body.engines.find((e: any) => e.id === "fake");
    expect(fake).toMatchObject({ installed: true, canLead: true, mcp: "config-file" });
    expect(r.body.engines.find((e: any) => e.id === "opencode")).toMatchObject({ canLead: false });
    expect(r.body.counts).toMatchObject({ pairs: 0, mcp: 0, skills: 0 });
  });
});
