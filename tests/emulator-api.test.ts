/** The emulator's HTTP API and live stream, over a real daemon with a fake adb and installer behind the device owner. */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/daemon/server";
import { EMULATOR_TOOL_NAMES } from "../src/emulator/defs";
import { buildRunMcpConfig } from "../src/mcp/store";
import { createEmulator, setEmulator, type Emulator } from "../src/emulator/emulator";
import type { EmulatorView, SdkState } from "../src/emulator/types";
import { AVD, PLAN, fakeDeps, fakeInstaller, type FakeDevice, type FakeInstaller } from "./emulator-fakes";

const TOKEN = "emulator-api-token";
const INSTALLED: SdkState = { kind: "installed", root: "/sdk", owned: true, avd: AVD };
const ALL_LICENSES = PLAN.licenses.map((l) => l.id);

let srv: ReturnType<typeof startServer>;
let emu: Emulator | null = null;
let dev: FakeDevice;
let installer: FakeInstaller;
let tmp: string;

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trb-emu-api-"));
});
afterEach(async () => {
  setEmulator(null);
  await emu?.shutdown();
  emu = null;
});

function use(disk: SdkState, running = false) {
  const f = fakeDeps();
  dev = f.dev;
  if (running) dev.avd = "trb";
  installer = fakeInstaller(disk);
  emu = createEmulator(f.deps, installer, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))), frameMs: 5, bootPollMs: 1, auditFile: () => path.join(tmp, "audit.log") });
  setEmulator(emu);
}

const bearer = { authorization: `Bearer ${TOKEN}` };
async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${srv.url}${p}`, { method, headers: { ...bearer, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) } as { status: number; headers: Headers; body: any };
}

describe("state and install", () => {
  test("GET /state is an EmulatorView, and needs the token", async () => {
    use({ kind: "absent" });
    const r = await api("GET", "/api/emulator/state");
    expect(r.status).toBe(200);
    const v = r.body as EmulatorView;
    expect(v).toMatchObject({ enabled: true, sdk: { kind: "absent" }, device: { kind: "stopped" }, metro: { kind: "off" }, jobs: [], lastActor: null });
    expect(v.host).toMatchObject({ os: "windows", abi: "x86_64", accel: { state: "ok" } });
    expect((await fetch(`${srv.url}/api/emulator/state`)).status).toBe(401);
  });

  test("plan, then accept the licenses, installs and returns the view", async () => {
    use({ kind: "absent" });
    const planned = await api("POST", "/api/emulator/install", { op: "plan" });
    expect(planned.body.sdk).toMatchObject({ kind: "needs-license", plan: { licenses: [{ id: "android-sdk-license" }, { id: "android-sdk-preview-license" }] } });
    const partial = await api("POST", "/api/emulator/license", { accept: ["android-sdk-license"] });
    expect(partial.status).toBe(409);
    expect(partial.body.error).toContain("android-sdk-preview-license");
    const accepted = await api("POST", "/api/emulator/license", { accept: ALL_LICENSES });
    expect(accepted.status).toBe(200);
    await emu!.settled();
    expect((await api("GET", "/api/emulator/state")).body.sdk).toMatchObject({ kind: "installed", owned: true });
  });

  test("install only takes plan, cancel and retry; accepting and removing are not reachable through it", async () => {
    use({ kind: "absent" });
    expect((await api("POST", "/api/emulator/install", { op: "accept", licenses: ALL_LICENSES })).status).toBe(400);
    expect((await api("POST", "/api/emulator/install", { op: "remove" })).status).toBe(400);
    expect((await api("POST", "/api/emulator/license", { accept: "yes" })).status).toBe(400);
    expect((await api("POST", "/api/emulator/license", { accept: ALL_LICENSES })).status).toBe(409); // nothing to accept yet
    expect(installer.log).toEqual([]);
  });

  test("remove: 409 unless installed and owned, then deletes and returns the view", async () => {
    use({ kind: "absent" });
    expect((await api("POST", "/api/emulator/remove", {})).status).toBe(409);
    use({ kind: "installed", root: "/theirs", owned: false, avd: AVD });
    const reused = await api("POST", "/api/emulator/remove", {});
    expect(reused.status).toBe(409);
    expect(reused.body.error).toContain("not installed by treeboss");
    expect(installer.log).toEqual([]);

    use(INSTALLED);
    const r = await api("POST", "/api/emulator/remove", {});
    expect(r.status).toBe(200);
    expect(r.body.sdk).toEqual({ kind: "absent" });
    expect(installer.log).toEqual(["remove"]);
  });
});

describe("device", () => {
  test("boot, input, screenshot, logs and shutdown", async () => {
    use(INSTALLED);
    const boot = await api("POST", "/api/emulator/boot");
    expect(boot.body).toMatchObject({ ok: true });
    expect((await api("GET", "/api/emulator/state")).body.device).toMatchObject({ kind: "running", serial: "emulator-5554", screen: { width: 720, height: 1600 } });

    const tap = await api("POST", "/api/emulator/input", { kind: "tap", x: 100, y: 200 });
    expect(tap.body).toEqual({ ok: true, text: "Tapped (100, 200)." });
    expect(dev.calls.some((c) => c.join(" ") === "shell input tap 100 200")).toBe(true);
    expect((await api("GET", "/api/emulator/state")).body.lastActor).toMatchObject({ actor: { kind: "you" } });

    const shot = await api("GET", "/api/emulator/screenshot?seq=1");
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(Number(shot.headers.get("x-frame-seq"))).toBeGreaterThanOrEqual(1);
    expect((shot.body as Buffer).subarray(1, 4).toString()).toBe("PNG");

    dev.logcat = "I ReactNativeJS: hello\n";
    expect((await api("GET", "/api/emulator/logs?lines=10")).body).toEqual({ ok: true, text: "I ReactNativeJS: hello" });

    expect((await api("POST", "/api/emulator/shutdown")).body).toMatchObject({ ok: true });
    expect((await api("GET", "/api/emulator/state")).body.device.kind).toBe("stopped");
  });

  test("a bad input is a 400, and input to a stopped device is an error result", async () => {
    use(INSTALLED);
    expect((await api("POST", "/api/emulator/input", { kind: "teleport" })).status).toBe(400);
    expect((await api("POST", "/api/emulator/input", { kind: "tap", x: "1", y: 2 })).status).toBe(400);
    expect((await api("POST", "/api/emulator/input", { kind: "key", key: "nope" })).status).toBe(400);
    const r = await api("POST", "/api/emulator/input", { kind: "tap", x: 1, y: 2 });
    expect(r.body).toMatchObject({ ok: false });
    expect((await api("GET", "/api/emulator/screenshot")).status).toBe(404);
  });

  test("the live finger needs numbers and a down flag, and a device with the live channel", async () => {
    use(INSTALLED);
    expect((await api("POST", "/api/emulator/pointer", { x: "1", y: 2, down: true })).status).toBe(400);
    expect((await api("POST", "/api/emulator/pointer", { x: 1, y: 2 })).status).toBe(400);
    expect((await api("POST", "/api/emulator/pointer", { x: 1, y: 2, down: true })).body).toMatchObject({ ok: false }); // stopped
    expect((await api("POST", "/api/emulator/boot")).body).toMatchObject({ ok: true });
    expect((await api("POST", "/api/emulator/pointer", { x: 1, y: 2, down: true })).body).toMatchObject({ ok: false, error: expect.stringContaining("gRPC") }); // no channel: adb only
  });

  test("run-expo needs a known workspace", async () => {
    use(INSTALLED, true);
    expect((await api("POST", "/api/emulator/run-expo", {})).status).toBe(400);
    expect((await api("POST", "/api/emulator/run-expo", { workspaceId: "w_missing" })).status).toBe(404);
    expect((await api("POST", "/api/emulator/stop-expo")).body).toMatchObject({ ok: true });
  });
});

describe("the live stream", () => {
  test("SSE sends the view, then another whenever the picture changes", async () => {
    use(INSTALLED, true);
    const ctrl = new AbortController();
    const res = await fetch(`${srv.url}/api/emulator/stream`, { headers: bearer, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const states: EmulatorView[] = [];
    let buf = "";
    const end = Date.now() + 4000;
    let flipped = false;
    const seqOf = (v: EmulatorView) => (v.device.kind === "running" ? v.device.seq : -1);
    while (Date.now() < end && !(states.length >= 2 && Math.max(...states.map(seqOf)) > Math.min(...states.map(seqOf)))) {
      const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 500))]);
      if (!next) continue; // quiet for a moment: look at the clock again
      const { value, done } = next;
      if (done) break;
      buf += dec.decode(value);
      for (const block of buf.split("\n\n").slice(0, -1)) {
        const m = /^event: state\ndata: (.*)$/m.exec(block);
        if (m) states.push(JSON.parse(m[1]!));
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      if (!flipped && states.length >= 1) {
        flipped = true;
        dev.screen = { tag: "new-frame", width: 720, height: 1600 };
      }
    }
    ctrl.abort();
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]!.device).toMatchObject({ kind: "running" });
    const seqs = states.map(seqOf);
    expect(Math.max(...seqs)).toBeGreaterThan(Math.min(...seqs));
  });
});

describe("live socket and MCP wiring", () => {
  test("stream:emulator on the live socket delivers the view", async () => {
    use(INSTALLED, true);
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/api/live`, { headers: bearer } as any);
    const frames: Array<{ id: string; event: string; data: EmulatorView }> = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    ws.send(JSON.stringify({ op: "sub", id: "e", stream: "emulator" }));
    const end = Date.now() + 4000;
    while (!frames.some((f) => f.id === "e" && f.event === "state") && Date.now() < end) await Bun.sleep(10);
    ws.close();
    const f = frames.find((x) => x.id === "e" && x.event === "state");
    expect(f?.data).toMatchObject({ enabled: true, sdk: { kind: "installed" }, device: { kind: "running" } });
  });

  test("the run config sets TRB_EMULATOR, and the MCP shim lists the emulator tools only when it is 1", async () => {
    const cfg = (emulator: boolean) => buildRunMcpConfig({ sessionId: "s_x", subagents: false, daemonUrl: "http://x", token: "t", emulator }).trb;
    expect((cfg(true) as { env: Record<string, string> }).env.TRB_EMULATOR).toBe("1");
    expect(cfg(false)).toBeUndefined(); // nothing else needs the shim, and the emulator alone must not be what is missing

    const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
    const list = async (flag: string) => {
      const child = Bun.spawn(["bun", "run", MAIN, "mcp-serve"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, TRB_URL: srv.url, TRB_TOKEN: TOKEN, TRB_SESSION: "s_x", TRB_SUBAGENTS: "0", TRB_EMULATOR: flag } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      child.stdin.flush();
      const reader = child.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) out += new TextDecoder().decode((await reader.read()).value);
      child.kill();
      return (JSON.parse(out).result.tools as Array<{ name: string }>).map((t) => t.name);
    };
    expect(await list("1")).toEqual([...EMULATOR_TOOL_NAMES]);
    expect(await list("0")).toEqual([]);
  });
});
