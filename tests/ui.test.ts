import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { setDaemonContext } from "../src/sessions/context";
import { interruptAll } from "../src/sessions/manager";
import { killAllTerminals } from "../src/terminal/pty";
import { makeDir, makeRepo, resetState, sh } from "./helpers";

const TOKEN = "ui-test-token";
let srv: ReturnType<typeof startServer>;
let web: string;

beforeAll(() => {
  web = makeDir();
  fs.mkdirSync(path.join(web, "assets"));
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>trb</title><div id=root></div>");
  fs.writeFileSync(path.join(web, "assets", "app-abc123.js"), "console.log(1)");
  process.env.TRB_WEB_DIR = web;
  srv = startServer({ port: 0, token: TOKEN });
  setDaemonContext({ url: srv.url, token: TOKEN });
});
afterAll(() => {
  delete process.env.TRB_WEB_DIR;
  setDaemonContext(null);
  killAllTerminals();
  srv.stop();
});
afterEach(async () => {
  await interruptAll();
});

const bearer = { authorization: `Bearer ${TOKEN}` };
const api = async (method: string, p: string, body?: unknown, headers: Record<string, string> = bearer) => {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json() : await res.text() } as { status: number; headers: Headers; body: any };
};

/** Sign in the way a browser does: ticket → /_auth → cookie. */
async function signIn(): Promise<string> {
  const { body } = await api("POST", "/api/ui/ticket");
  const res = await fetch(`${srv.url}/_auth?ticket=${body.ticket}`, { redirect: "manual" });
  const setCookie = res.headers.get("set-cookie")!;
  return setCookie.split(";")[0];
}

describe("serving the UI", () => {
  test("index at /, the app shell for client routes, hashed assets cached forever", async () => {
    const root = await api("GET", "/", undefined, {});
    expect(root.status).toBe(200);
    expect(root.body).toContain("<div id=root>");
    expect(root.headers.get("cache-control")).toBe("no-cache");
    const spa = await api("GET", "/w/w_abc123", undefined, {});
    expect(spa.body).toContain("<div id=root>");
    const asset = await api("GET", "/assets/app-abc123.js", undefined, {});
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  test("a missing asset is a 404, never the app shell", async () => {
    expect((await api("GET", "/assets/missing.js", undefined, {})).status).toBe(404);
  });

  test("traversal out of the web root serves nothing from outside it", async () => {
    const r = await fetch(`${srv.url}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect(await r.text()).not.toContain("root:");
  });

  test("security headers on the app: CSP, nosniff, no framing, no referrer", async () => {
    const h = (await api("GET", "/", undefined, {})).headers;
    expect(h.get("content-security-policy")).toContain("script-src 'self'");
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("no-referrer");
  });

  test("when the UI is not built, say how to build it", async () => {
    const keep = process.env.TRB_WEB_DIR;
    process.env.TRB_WEB_DIR = makeDir();
    const r = await api("GET", "/", undefined, {});
    process.env.TRB_WEB_DIR = keep;
    expect(r.status).toBe(503);
    expect(r.body).toContain("bun run build:web");
  });
});

describe("signing in", () => {
  test("a ticket is traded for an HttpOnly, SameSite=Strict cookie, once", async () => {
    const { body } = await api("POST", "/api/ui/ticket");
    const first = await fetch(`${srv.url}/_auth?ticket=${body.ticket}&to=${encodeURIComponent("/w/w_x")}`, { redirect: "manual" });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/w/w_x");
    const cookie = first.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure"); // plain http on loopback: Secure would make the browser drop it
    expect((await fetch(`${srv.url}/_auth?ticket=${body.ticket}`, { redirect: "manual" })).status).toBe(401); // single use
  });

  test("a bogus or expired ticket is refused", async () => {
    expect((await fetch(`${srv.url}/_auth?ticket=nope`, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(`${srv.url}/_auth`, { redirect: "manual" })).status).toBe(401);
  });

  test("the redirect target can only be inside the app", async () => {
    for (const evil of ["//evil.example", "https://evil.example", "javascript:alert(1)"]) {
      const { body } = await api("POST", "/api/ui/ticket");
      const r = await fetch(`${srv.url}/_auth?ticket=${body.ticket}&to=${encodeURIComponent(evil)}`, { redirect: "manual" });
      expect(r.headers.get("location")).toBe("/");
    }
  });

  test("the cookie authenticates the API; no cookie does not", async () => {
    expect((await api("GET", "/api/workspaces", undefined, {})).status).toBe(401);
    const cookie = await signIn();
    expect((await api("GET", "/api/workspaces", undefined, { cookie })).status).toBe(200);
    expect((await api("GET", "/api/workspaces", undefined, { cookie: "trb_session=wrong" })).status).toBe(401);
  });

  test("cookie-authenticated writes from another origin are refused (CSRF); same-origin and bearer are fine", async () => {
    const cookie = await signIn();
    const evil = await api("POST", "/api/workspaces", { path: makeDir() }, { cookie, origin: "http://evil.example" });
    expect(evil.status).toBe(403);
    const same = await api("POST", "/api/workspaces", { path: makeDir() }, { cookie, origin: srv.url });
    expect(same.status).toBe(201);
    // The CLI authenticates with the bearer token and sends no Origin.
    expect((await api("POST", "/api/workspaces", { path: makeDir() })).status).toBe(201);
  });

  test("only the CLI can mint tickets, not a browser session", async () => {
    const cookie = await signIn();
    expect((await api("POST", "/api/ui/ticket", undefined, { cookie })).status).toBe(403);
  });
});

describe("files over HTTP", () => {
  const setup = async () => {
    resetState();
    const repo = makeRepo({ "a.txt": "hello\n", "page.html": "<script>alert(1)</script>", "pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>" });
    const ws = (await api("POST", "/api/workspaces", { path: repo })).body.workspace;
    return { repo, ref: ws.id as string };
  };

  test("tree, read, write with an optimistic lock, create, rename, delete", async () => {
    const { repo, ref } = await setup();
    const tree = await api("GET", `/api/fs/${ref}/tree?path=`);
    expect(tree.body.entries.map((e: any) => e.name)).toContain("a.txt");
    const file = await api("GET", `/api/fs/${ref}/file?path=a.txt`);
    expect(file.body).toMatchObject({ content: "hello\n", eol: "lf" });
    await Bun.sleep(15);
    fs.writeFileSync(path.join(repo, "a.txt"), "changed elsewhere\n");
    const conflict = await api("PUT", `/api/fs/${ref}/file`, { path: "a.txt", content: "mine", expectedMtime: file.body.mtime });
    expect(conflict.status).toBe(409);
    expect(conflict.body.conflict).toBe(true);
    const ok = await api("PUT", `/api/fs/${ref}/file`, { path: "a.txt", content: "mine\n", expectedMtime: conflict.body.mtime });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf-8")).toBe("mine\n");
    expect((await api("POST", `/api/fs/${ref}/create`, { path: "new/dir/f.ts", type: "file" })).status).toBe(201);
    expect((await api("POST", `/api/fs/${ref}/rename`, { from: "new/dir/f.ts", to: "new/g.ts" })).status).toBe(200);
    expect((await api("DELETE", `/api/fs/${ref}/file?path=new`)).status).toBe(200);
    expect(fs.existsSync(path.join(repo, "new"))).toBe(false);
  });

  test("traversal and unknown roots are refused over the wire too", async () => {
    const { ref } = await setup();
    expect((await api("GET", `/api/fs/${ref}/file?path=../../../etc/passwd`)).status).toBe(403);
    expect((await api("GET", `/api/fs/${ref}/file?path=${encodeURIComponent("/etc/passwd")}`)).status).toBe(404); // a leading slash is relative to the root
    expect((await api("GET", `/api/fs/w_ghost/tree?path=`)).status).toBe(404);
    expect((await api("GET", `/api/fs/..%2f..%2fetc/tree`)).status).toBeGreaterThanOrEqual(400);
    expect((await api("DELETE", `/api/fs/${ref}/file?path=.git`)).status).toBe(403);
  });

  test("raw files: images inline under a sandbox CSP, everything else forced to download", async () => {
    const { ref } = await setup();
    const svg = await api("GET", `/api/fs/${ref}/raw?path=pic.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await api("GET", `/api/fs/${ref}/raw?path=page.html`);
    expect(html.headers.get("content-type")).toBe("application/octet-stream"); // workspace HTML must never render on this origin
    expect(html.headers.get("content-disposition")).toContain("attachment");
  });

  test("find and grep", async () => {
    const { ref } = await setup();
    expect((await api("GET", `/api/fs/${ref}/find`)).body.files).toContain("a.txt");
    const g = await api("GET", `/api/fs/${ref}/grep?q=hello`);
    expect(g.body.matches[0]).toMatchObject({ path: "a.txt", line: 1 });
  });
});

describe("git over HTTP", () => {
  test("status → stage → commit → log, and git's own message on failure", async () => {
    resetState();
    const repo = makeRepo();
    const ref = (await api("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    fs.writeFileSync(path.join(repo, "n.txt"), "n\n");
    expect((await api("GET", `/api/git/${ref}/status`)).body.files).toEqual([{ path: "n.txt", index: ".", worktree: "?" }]);
    const bad = await api("POST", `/api/git/${ref}/commit`, { message: "nothing staged" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/nothing|untracked/i);
    await api("POST", `/api/git/${ref}/stage`, { paths: ["n.txt"] });
    const c = await api("POST", `/api/git/${ref}/commit`, { message: "add n" });
    expect(c.body.summary).toBe("add n");
    expect((await api("GET", `/api/git/${ref}/log`)).body.commits[0].subject).toBe("add n");
    expect((await api("POST", `/api/git/${ref}/stage`, {})).status).toBe(400);
    expect((await api("GET", `/api/git/${ref}/info`)).body).toMatchObject({ isRepo: true });
  });

  test("a session's working directory is a root of its own", async () => {
    resetState();
    const repo = makeRepo();
    const created = await api("POST", "/api/sessions", { prompt: "WRITE head.txt from the head\nGIT_COMMIT head work", engine: "fake", cwd: repo, isolate: true });
    const sid = created.body.session.id as string;
    for (let i = 0; i < 100; i++) {
      if ((await api("GET", `/api/sessions/${sid}`)).body.session.status !== "running") break;
      await Bun.sleep(100);
    }
    expect((await api("GET", `/api/git/${sid}/log`)).body.commits[0].subject).toBe("head work");
    expect((await api("GET", `/api/fs/${sid}/file?path=head.txt`)).body.content).toBe("from the head\n");
    expect(sh("git status --short", repo)).toBe(""); // the operator's checkout is untouched
  });
});

describe("terminals over WebSocket", () => {
  const open = (id: string, headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; msgs: any[]; closed: Promise<number> }>((resolve, reject) => {
      const msgs: any[] = [];
      const ws = new WebSocket(`${srv.url.replace("http", "ws")}/api/terminals/${id}/ws`, { headers } as any);
      const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
      ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
      ws.addEventListener("open", () => resolve({ ws, msgs, closed }));
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await Bun.sleep(25);
    expect(pred()).toBe(true);
  };

  test("a real shell: type a command, see its output, reload and get the scrollback back", async () => {
    resetState();
    const repo = makeRepo();
    const ref = (await api("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    const cookie = await signIn();
    const t = (await api("POST", "/api/terminals", { root: ref, cols: 100, rows: 30 })).body.terminal;
    expect(t).toMatchObject({ rootRef: ref, alive: true, cols: 100, rows: 30 });

    const a = await open(t.id, { cookie });
    await until(() => a.msgs.some((m) => m.t === "replay"));
    a.ws.send(JSON.stringify({ type: "input", data: "echo marker-$((20+22)); pwd\n" }));
    await until(() => a.msgs.filter((m) => m.t === "out").map((m) => m.d).join("").includes("marker-42"));
    const out = a.msgs.filter((m) => m.t === "out").map((m) => m.d).join("");
    expect(out).toContain(fs.realpathSync(repo)); // it starts in the workspace
    a.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await until(() => true);
    a.ws.close();

    const b = await open(t.id, { cookie }); // a "page reload"
    await until(() => b.msgs.some((m) => m.t === "replay"));
    expect(b.msgs.find((m) => m.t === "replay").d).toContain("marker-42");
    b.ws.send(JSON.stringify({ type: "input", data: "exit\n" }));
    await until(() => b.msgs.some((m) => m.t === "exit"), 8000);
    b.ws.close();
    expect((await api("GET", `/api/terminals/${t.id}`)).body.terminal).toMatchObject({ alive: false });
    expect((await api("DELETE", `/api/terminals/${t.id}`)).body.killed).toBe(true);
    expect((await api("GET", `/api/terminals/${t.id}`)).status).toBe(404);
  });

  test("the WebSocket needs the session, and refuses a foreign Origin", async () => {
    const repo = makeRepo();
    const ref = (await api("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    const t = (await api("POST", "/api/terminals", { root: ref })).body.terminal;
    await expect(open(t.id, {})).rejects.toThrow();
    const cookie = await signIn();
    await expect(open(t.id, { cookie, origin: "http://evil.example" })).rejects.toThrow();
    const ok = await open(t.id, { cookie, origin: srv.url });
    ok.ws.close();
    await api("DELETE", `/api/terminals/${t.id}`);
  });

  test("the daemon's own token is not handed to shells", async () => {
    const repo = makeRepo();
    const ref = (await api("POST", "/api/workspaces", { path: repo })).body.workspace.id;
    const cookie = await signIn();
    process.env.TRB_TOKEN = "super-secret-daemon-token";
    const t = (await api("POST", "/api/terminals", { root: ref })).body.terminal;
    delete process.env.TRB_TOKEN;
    const a = await open(t.id, { cookie });
    await until(() => a.msgs.some((m) => m.t === "replay"));
    a.ws.send(JSON.stringify({ type: "input", data: 'echo "token=[$TRB_TOKEN]"\n' }));
    await until(() => a.msgs.filter((m) => m.t === "out").map((m) => m.d).join("").includes("token=["));
    expect(a.msgs.filter((m) => m.t === "out").map((m) => m.d).join("")).not.toContain("super-secret-daemon-token");
    a.ws.close();
    await api("DELETE", `/api/terminals/${t.id}`);
  });
});

describe("live stream and the event log", () => {
  test("log lines carry a kind and parsed detail; the global stream announces state changes", async () => {
    resetState();
    const repo = makeRepo();
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/api/stream`, { headers: bearer, signal: ac.signal });
    const seen: string[] = [];
    const dec = new TextDecoder();
    const reading = (async () => {
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) seen.push(dec.decode(chunk));
      } catch {}
    })();
    const created = await api("POST", "/api/sessions", { prompt: "WRITE a.txt x\nSAY finished", engine: "fake", cwd: repo });
    const id = created.body.session.id;
    for (let i = 0; i < 100; i++) {
      if ((await api("GET", `/api/sessions/${id}`)).body.session.status !== "running") break;
      await Bun.sleep(100);
    }
    const stream = seen.join("");
    expect(stream).toContain("event: turn_start");
    expect(stream).toContain("event: turn_end");
    expect(stream).not.toContain("event: log"); // logs are opt-in on the global stream
    const lines = (await api("GET", `/api/sessions/${id}/logs`)).body.lines as any[];
    expect(lines.find((l) => l.text.includes("→ Write(a.txt)"))).toMatchObject({ kind: "tool", data: { kind: "tool", name: "Write", arg: "a.txt" } });
    expect(lines.find((l) => l.text === "finished")).toMatchObject({ kind: "text" });
    expect(lines.find((l) => l.text.startsWith("[trb]"))).toMatchObject({ kind: "info" });
    ac.abort();
    await reading;
  });
});
