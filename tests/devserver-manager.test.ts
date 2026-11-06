/** The run manager against real child processes: ports, logs, stop, restart, two roots in parallel. */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { _resetRuns, getInstance, readLogs, restartService, runningDev, startService, stopAllRuns, stopService } from "../src/devserver/manager";
import { makeDir } from "./helpers";

const SERVER = `const s = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("hi") });
console.log("ready on http://localhost:" + s.port); console.error("a warning");
process.on("SIGTERM", () => { console.log("bye"); process.exit(0); });`;

const app = (extra: Record<string, string> = {}) => {
  const d = makeDir();
  fs.writeFileSync(path.join(d, "server.ts"), SERVER);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { dev: "bun server.ts", "db:seed": "echo seeding && exit 3", migrate: "echo migrated", ...extra } }));
  return d;
};

const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
  if (!fn()) throw new Error("timed out");
};

afterEach(async () => {
  await stopAllRuns();
  _resetRuns();
});
afterAll(() => _resetRuns());

describe("run manager", () => {
  test("starts a server on its own port, reaches running, streams logs, stops by its own process group", async () => {
    const d = app();
    const i = await startService({ rootDir: d, owner: "w_t", service: "dev" });
    expect(i.port).toBeGreaterThanOrEqual(4100);
    expect(i.status).toBe("starting");
    await until(() => getInstance(fs.realpathSync(d), "dev")?.status === "running");
    expect((await fetch(`http://127.0.0.1:${i.port}`).then((r) => r.text()))).toBe("hi");
    const real = fs.realpathSync(d);
    expect(runningDev(real)?.url).toBe(`http://localhost:${i.port}`);
    const logs = readLogs(real, "dev").lines.map((l) => `${l.stream}:${l.text}`);
    expect(logs.some((l) => l.startsWith("sys:$ npm run dev"))).toBe(true);
    expect(logs.some((l) => l.includes("out:ready on http://localhost:"))).toBe(true);
    expect(logs).toContain("err:a warning");
    const pid = i.pid!;
    stopService(d, "dev");
    await until(() => getInstance(real, "dev")?.status === "stopped");
    expect(() => process.kill(pid, 0)).toThrow();
    // Windows ends the tree outright; there is no SIGTERM for the handler to see.
    if (process.platform !== "win32") expect(readLogs(real, "dev").lines.some((l) => l.text === "bye")).toBe(true);
  });

  test("two directories run the same app at once on different ports", async () => {
    const a = app();
    const b = app();
    const [x, y] = [await startService({ rootDir: a, owner: "s_a", service: "dev" }), await startService({ rootDir: b, owner: "s_b", service: "dev" })];
    expect(x.port).not.toBe(y.port);
    await until(() => getInstance(fs.realpathSync(a), "dev")?.status === "running" && getInstance(fs.realpathSync(b), "dev")?.status === "running");
  });

  test("restart gives a fresh process; a second start of a live one is a no-op", async () => {
    const d = app();
    const real = fs.realpathSync(d);
    const first = await startService({ rootDir: d, owner: "w_t", service: "dev" });
    await until(() => getInstance(real, "dev")?.status === "running");
    expect((await startService({ rootDir: d, owner: "w_t", service: "dev" })).pid).toBe(first.pid);
    const again = await restartService({ rootDir: d, owner: "w_t", service: "dev" });
    expect(again.pid).not.toBe(first.pid);
    await until(() => getInstance(real, "dev")?.status === "running");
    expect(() => process.kill(first.pid!, 0)).toThrow();
  });

  test("database tasks run to completion and record the exit code", async () => {
    const d = app();
    const real = fs.realpathSync(d);
    await startService({ rootDir: d, owner: "w_t", service: "migrate" });
    await until(() => getInstance(real, "migrate")?.status === "exited");
    expect(getInstance(real, "migrate")?.exitCode).toBe(0);
    expect(getInstance(real, "migrate")?.port).toBeNull();
    await startService({ rootDir: d, owner: "w_t", service: "db:seed" });
    await until(() => getInstance(real, "db:seed")?.status === "failed");
    expect(getInstance(real, "db:seed")?.exitCode).toBe(3);
  });

  test("a server that dies is reported failed with its exit code; unknown services are refused", async () => {
    const d = app({ boom: "exit 7" });
    // `boom` is not a dev script name, so it is not runnable.
    await expect(startService({ rootDir: d, owner: "w_t", service: "boom" })).rejects.toThrow(/No runnable/);
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { dev: "exit 7" } }));
    await startService({ rootDir: d, owner: "w_t", service: "dev" });
    await until(() => getInstance(fs.realpathSync(d), "dev")?.status === "failed");
    expect(getInstance(fs.realpathSync(d), "dev")?.exitCode).toBe(7);
  });

  test("trb's own token is not handed to the child", async () => {
    process.env.TRB_TOKEN = "must-not-leak";
    const d = makeDir();
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { dev: "bun -e \"console.log('token=[' + (process.env.TRB_TOKEN ?? '') + ']')\"" } }));
    await startService({ rootDir: d, owner: "w_t", service: "dev" });
    const real = fs.realpathSync(d);
    await until(() => getInstance(real, "dev")?.status !== "starting" || readLogs(real, "dev").lines.some((l) => l.text.startsWith("token=")));
    const text = readLogs(real, "dev").lines.map((l) => l.text).join("\n");
    expect(text).toContain("token=[]");
    expect(text).not.toContain("must-not-leak");
    delete process.env.TRB_TOKEN;
  });

  test("a trivial service runs through the platform shell: reaches running, logs a line, stop leaves no orphan", async () => {
    const d = makeDir();
    const real = fs.realpathSync(d);
    // The shell runs `bun child.ts`, which starts a grandchild that holds the port; stopping must take both down.
    fs.writeFileSync(path.join(d, "child.ts"), `Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("hi") }); console.log("up"); setInterval(() => {}, 1000);`);
    fs.writeFileSync(path.join(d, "parent.ts"), `const p = Bun.spawn(["bun", "child.ts"], { stdout: "inherit", stderr: "inherit", env: process.env }); console.log("grandchild " + p.pid); await p.exited;`);
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { dev: "bun parent.ts" } }));
    const i = await startService({ rootDir: d, owner: "w_t", service: "dev" });
    await until(() => getInstance(real, "dev")?.status === "running");
    const text = () => readLogs(real, "dev").lines.map((l) => l.text);
    await until(() => text().some((t) => t === "up"));
    const grand = Number(text().find((t) => t.startsWith("grandchild "))!.split(" ")[1]);
    expect(() => process.kill(grand, 0)).not.toThrow();
    stopService(d, "dev");
    await until(() => getInstance(real, "dev")?.status === "stopped");
    await until(() => {
      try {
        process.kill(grand, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(i.pid!, 0)).toThrow();
    expect(await fetch(`http://127.0.0.1:${i.port}`).then(() => true, () => false)).toBe(false);
  });
});
