import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START context\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END context\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { startServer } from "../src/daemon/server";
import { checkFetchable, fetchUrlText, htmlToText, isBlockedAddress, MAX_URL_BYTES, UrlRefused } from "../src/context/url";
import { fence, parseChips, resolveChips, stripAnsi, withContext } from "../src/context/resolve";
import { splitContext } from "../web/src/features/context/wrap";
import { searchAll, searchCommits, searchFiles, searchSymbols, fuzzy } from "../src/context/search";
import { registerConsoleSource } from "../src/context/sources";
import { saveImage } from "../src/context/images";
import type { TurnResult } from "../src/engines/runner";
import { createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "context-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());
beforeEach(() => {
  resetState();
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
  registerConsoleSource(null);
});

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const publicLookup = async () => ["93.184.216.34"];
const page = (body: string, type = "text/html", status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": type, ...headers } });

describe("@url guard", () => {
  test("blocked address ranges", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "not-an-ip"]) expect(isBlockedAddress(a)).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(a)).toBe(false);
  });

  test("localhost, private hosts, odd schemes and credentials are refused", async () => {
    for (const u of ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]/", "http://192.168.0.5/admin", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/x", "http://user:pw@example.com/", "http://app.localhost/"]) {
      await expect(checkFetchable(u, { lookup: publicLookup })).rejects.toBeInstanceOf(UrlRefused);
    }
  });

  test("a public name that resolves to a private address is refused, mixed answers too", async () => {
    await expect(checkFetchable("https://evil.example/", { lookup: async () => ["10.0.0.7"] })).rejects.toThrow(/Private/);
    await expect(checkFetchable("https://evil.example/", { lookup: async () => ["93.184.216.34", "192.168.1.9"] })).rejects.toThrow(/Private/);
    await expect(checkFetchable("https://ok.example/", { lookup: publicLookup })).resolves.toBeInstanceOf(URL);
  });

  test("loopback is allowed only for the exact preview origin, and never the daemon itself", async () => {
    await expect(checkFetchable("http://localhost:5173/app", { allowOrigin: "http://localhost:5173" })).resolves.toBeInstanceOf(URL);
    await expect(checkFetchable("http://localhost:5174/app", { allowOrigin: "http://localhost:5173" })).rejects.toBeInstanceOf(UrlRefused);
    await expect(checkFetchable("http://127.0.0.1:5173/app", { allowOrigin: "http://localhost:5173" })).rejects.toBeInstanceOf(UrlRefused);
    await expect(checkFetchable("http://localhost:7000/", { allowOrigin: "http://localhost:7000", selfPort: 7000 })).rejects.toThrow(/daemon/);
    // The preview exception never extends to the LAN.
    await expect(checkFetchable("http://192.168.1.4:5173/", { allowOrigin: "http://192.168.1.4:5173", lookup: async () => ["192.168.1.4"] })).rejects.toBeInstanceOf(UrlRefused);
  });

  test("every redirect hop is checked", async () => {
    const hops: string[] = [];
    const fetchImpl = (async (u: string) => {
      hops.push(u);
      return u.includes("start") ? page("", "text/html", 302, { location: "http://169.254.169.254/latest" }) : page("secret");
    }) as unknown as typeof fetch;
    await expect(fetchUrlText("https://ok.example/start", { lookup: async (h) => (h === "ok.example" ? ["93.184.216.34"] : ["169.254.169.254"]), fetchImpl })).rejects.toThrow(/Private|refused/i);
    expect(hops).toEqual(["https://ok.example/start"]); // the second request was never made
  });

  test("html becomes text, scripts and styles are dropped", async () => {
    const html = "<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><script>alert(1)</script><h1>Title</h1><p>one &lt;two&gt;</p></body></html>";
    const r = await fetchUrlText("https://ok.example/", { lookup: publicLookup, fetchImpl: (async () => page(html)) as unknown as typeof fetch });
    expect(r.text).toContain("Hi & bye");
    expect(r.text).toContain("one <two>");
    expect(r.text).not.toContain("alert");
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
  });

  test("the body is capped and non-text is refused", async () => {
    const big = "x".repeat(MAX_URL_BYTES + 5000);
    const r = await fetchUrlText("https://ok.example/", { lookup: publicLookup, fetchImpl: (async () => page(big, "text/plain")) as unknown as typeof fetch });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    await expect(fetchUrlText("https://ok.example/a.png", { lookup: publicLookup, fetchImpl: (async () => page("x", "image/png")) as unknown as typeof fetch })).rejects.toThrow(/Not a text page/);
  });
});

describe("chips", () => {
  test("parseChips drops unknown kinds, bad values and anything past the cap", () => {
    const chips = parseChips([{ kind: "file", value: "a.ts" }, { kind: "evil", value: "x" }, { kind: "file", value: 5 }, null, ...Array.from({ length: 30 }, (_, i) => ({ kind: "file", value: `f${i}` }))]);
    expect(chips[0]).toEqual({ kind: "file", value: "a.ts", label: undefined });
    expect(chips.length).toBe(12);
    expect(parseChips("nope")).toEqual([]);
  });

  test("fence is longer than any backtick run in the content", () => {
    expect(fence("a\n```js\nb\n```")).toStartWith("````");
    expect(withContext("hi", null)).toBe("hi");
    expect(withContext("hi", "BLOCK")).toContain("BLOCK");
    expect(withContext("hi", "BLOCK")).toEndWith("hi");
    // The thread folds the block away using the same markers.
    expect(splitContext(withContext("hi", "BLOCK\n\n---\n\nmore"))).toEqual({ text: "hi", context: "BLOCK\n\n---\n\nmore" });
  });

  test("stripAnsi removes colour and cursor codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m ok\r\nnext")).toBe("red ok\nnext");
  });
});

describe("resolving chips", () => {
  const project = () =>
    makeRepo({
      "src/greet.ts": "export function greetUser(name: string) {\n  return `hello ${name}`;\n}\n\nexport class Mailer {}\n",
      "README.md": "# demo\n",
      "img.bin": "a\0b",
    });

  test("file, symbol and commit become one block; a missing file is a note, not an error", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    const sha = (await searchCommits(dir, "init"))[0].value;
    const r = await resolveChips(
      [
        { kind: "file", value: "README.md" },
        { kind: "symbol", value: "src/greet.ts:1-3", label: "greetUser" },
        { kind: "commit", value: sha },
        { kind: "file", value: "nope.txt" },
        { kind: "file", value: "../outside" },
        { kind: "file", value: "img.bin" },
      ],
      { root: ws.id },
    );
    const b = r.block!;
    expect(b).toStartWith("# Attached context");
    expect(b).toContain("## File `README.md`");
    expect(b).toContain("# demo");
    expect(b).toContain("Symbol `greetUser` in `src/greet.ts` lines 1-3");
    expect(b).toContain("1\texport function greetUser");
    expect(b).toContain(`Commit ${sha.slice(0, 7)}`);
    expect(b).toContain("README.md");
    expect(r.items.map((i) => i.ok)).toEqual([true, true, true, false, false, false]);
    expect(b).toContain("Could not attach this");
  });

  test("terminal and browser degrade to a clear note when there is nothing", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    const r = await resolveChips([{ kind: "terminal", value: "" }, { kind: "browser", value: "" }], { root: ws.id });
    expect(r.items.every((i) => !i.ok)).toBe(true);
    expect(r.block).toContain("no terminal output yet");
    expect(r.block).toContain("no preview console");
  });

  test("in-view chips: a diff, the roadmap and an open browser tab", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    writeFileSync(join(dir, "README.md"), "# changed\n");
    writeFileSync(join(dir, "ROADMAP.md"), "# Roadmap\n\n## Now\n- ship it\n");
    registerConsoleSource(() => ["TypeError: y"]);
    const r = await resolveChips(
      [
        { kind: "diff", value: "work:README.md" },
        { kind: "diff", value: "bogus" },
        { kind: "roadmap", value: "roadmap" },
        { kind: "browser", value: "http://localhost:5173/", label: "App" },
      ],
      { root: ws.id },
    );
    expect(r.items.map((i) => i.ok)).toEqual([true, false, true, true]);
    expect(r.block).toContain("+# changed");
    expect(r.block).toContain("ship it");
    expect(r.block).toContain("URL: http://localhost:5173/");
    expect(r.block).toContain("TypeError: y");
  });

  test("browser reads a registered preview console", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    registerConsoleSource(() => ["TypeError: x is undefined", "404 /api/me"]);
    const r = await resolveChips([{ kind: "browser", value: "" }], { root: ws.id });
    expect(r.block).toContain("TypeError: x is undefined");
  });

  test("a url chip to localhost is refused inside the block", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    const r = await resolveChips([{ kind: "url", value: "http://localhost:9999/x" }], { root: ws.id });
    expect(r.items[0].ok).toBe(false);
    expect(r.block).toContain("refused");
  });

  test("an image chip carries the stored file's absolute path", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    const img = saveImage(PNG);
    const r = await resolveChips([{ kind: "image", value: img.id, label: "shot.png" }], { root: ws.id });
    expect(r.block).toContain(img.file);
    expect(() => saveImage(Buffer.from("not an image"))).toThrow(/PNG/);
  });

  test("total size is capped", async () => {
    const dir = makeRepo({ "big.txt": "y".repeat(40_000), "big2.txt": "z".repeat(40_000) });
    const ws = Workspaces.open(dir);
    const r = await resolveChips([{ kind: "file", value: "big.txt" }, { kind: "file", value: "big2.txt" }], { root: ws.id });
    expect(r.block!.length).toBeLessThan(60_000);
    expect(r.block).toContain("(truncated)");
  });
});

describe("search", () => {
  test("fuzzy ranks name matches above scattered ones", () => {
    expect(fuzzy("grt", "src/greet.ts")).not.toBeNull();
    expect(fuzzy("zzz", "src/greet.ts")).toBeNull();
    expect(fuzzy("greet", "src/greet.ts")!).toBeGreaterThan(fuzzy("greet", "src/g/r/e/e/t.ts")!);
  });

  test("files, symbols (grep fallback without an index) and commits", async () => {
    const dir = makeRepo({ "src/greet.ts": "export function greetUser() {}\nexport class Mailer {}\n", "docs/a.md": "x\n" });
    expect((await searchFiles(dir, "greet"))[0].value).toBe("src/greet.ts");
    const sym = await searchSymbols(dir, "mailer");
    expect(sym.engine).toBe("grep");
    expect(sym.items[0]).toMatchObject({ kind: "symbol", label: "Mailer" });
    expect(sym.items[0].value).toStartWith("src/greet.ts:2-");
    expect((await searchCommits(dir, "ini"))[0].label).toBe("init");
    const all = await searchAll(dir, "greet");
    expect(all.items.map((i) => i.kind)).toContain("file");
    expect(all.items.map((i) => i.kind)).toContain("symbol");
  });
});

describe("API", () => {
  test("search, resolve and image upload", async () => {
    const dir = makeRepo({ "src/greet.ts": "export function greetUser() {}\n" });
    const ws = Workspaces.open(dir);
    const s = await call("GET", `/api/context/search?root=${ws.id}&q=greet`);
    expect(s.status).toBe(200);
    expect(s.body.items.some((i: any) => i.value === "src/greet.ts")).toBe(true);
    const r = await call("POST", "/api/context/resolve", { root: ws.id, context: [{ kind: "file", value: "src/greet.ts" }] });
    expect(r.body.block).toContain("greetUser");
    const up = await call("POST", "/api/context/images", { data: `data:image/png;base64,${PNG.toString("base64")}` });
    expect(up.status).toBe(201);
    const got = await fetch(`${srv.url}/api/context/images/${up.body.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(got.headers.get("content-type")).toBe("image/png");
    expect((await call("POST", "/api/context/images", { data: Buffer.from("<svg onload=alert(1)>").toString("base64") })).status).toBe(400);
    expect((await call("GET", "/api/context/images/img_0000000000000000")).status).toBe(404);
    expect((await call("GET", `/api/context/search?root=w_nope&q=x`)).status).toBe(404);
  });

  test("chips on a new session and on a follow-up reach the engine as text", async () => {
    const dir = makeRepo({ "notes.txt": "remember the milk\n", "other.txt": "second file\n" });
    const ws = Workspaces.open(dir);
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("done");
    });
    const created = await call("POST", "/api/sessions", { prompt: "do the thing", cwd: dir, engine: "fake", context: [{ kind: "file", value: "notes.txt" }] });
    expect(created.status).toBe(201);
    const id = created.body.session.id;
    await settled(id);
    expect(prompts[0]).toContain("# Attached context");
    expect(prompts[0]).toContain("remember the milk");
    expect(prompts[0].indexOf("remember the milk")).toBeLessThan(prompts[0].indexOf("do the thing"));
    const sent = await call("POST", `/api/sessions/${id}/send`, { message: "and now this", context: [{ kind: "file", value: "other.txt" }] });
    expect(sent.status).toBe(200);
    await settled(id);
    expect(prompts[1]).toContain("second file");
    expect(prompts[1]).toContain("and now this");
    // No chips: the prompt is untouched.
    await call("POST", `/api/sessions/${id}/send`, { message: "plain" });
    await settled(id);
    expect(prompts[2]).not.toContain("Attached context");
    void ws;
  });
});
