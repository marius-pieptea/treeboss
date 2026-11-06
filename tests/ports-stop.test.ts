/** Stop in the ports list: the server it names is really gone afterwards, whatever the platform's idea of a polite signal. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { startServer } from "../src/daemon/server";

const TOKEN = "ports-stop-token";
let srv: ReturnType<typeof startServer>;
const started: ChildProcess[] = [];

beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());
afterEach(() => {
  for (const c of started.splice(0)) c.kill("SIGKILL");
});

// The ports list reads netstat on Windows and lsof elsewhere; with neither there is nothing to stop.
const canList = process.platform === "win32" || !!Bun.which("lsof");

const SERVER = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hi") }); console.log(s.port);`;

/** A listener without a console window: how everything the daemon, or a shell inside one of its terminals, starts runs on Windows. */
function listen(): Promise<{ pid: number; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", SERVER], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    started.push(child);
    child.once("error", reject);
    child.stdout!.once("data", (d: Buffer) => resolve({ pid: child.pid!, port: Number(d.toString().trim()) }));
  });
}

const stop = (port: number, pid: number) =>
  fetch(`${srv.url}/api/ports/stop`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ port, pid }) });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
};

describe("stop in the ports list", () => {
  test.skipIf(!canList)("ends the server it names", async () => {
    const { pid, port } = await listen();
    expect(alive(pid)).toBe(true);
    expect((await stop(port, pid)).status).toBe(200);
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test.skipIf(!canList)("signals only a pid that is listening on that exact port", async () => {
    const { pid, port } = await listen();
    expect((await stop(port + 1, pid)).status).toBe(404);
    expect(alive(pid)).toBe(true);
  }, 30_000);
});
