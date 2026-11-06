import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START remote-cli\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END remote-cli\n"); });
/** `trb remote`: against a real daemon on a throwaway home (loopback only). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const MAIN = path.resolve(import.meta.dir, "..", "src", "cli", "main.ts");
let home: string;

async function trb(args: string[]) {
  const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
    cwd: os.tmpdir(),
    // Nothing real is bound: the daemon never opens the second listener, and the interfaces are injected.
    env: { ...process.env, TRB_HOME: home, TRB_NO_AUTOSTART: "", NO_COLOR: "1", TRB_REMOTE_NO_LISTEN: "1", TRB_TAILSCALE_BIN: "none", TRB_REMOTE_INTERFACES: JSON.stringify({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] }) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-cli-remote-home-"));
});
afterAll(async () => {
  await trb(["daemon", "stop"]);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trb remote", () => {
  test("off by default: status says so and pairing is refused", async () => {
    const st = await trb(["remote", "status"]);
    expect(st.code).toBe(0);
    expect(st.stdout).toContain("remote mode    off");
    expect(st.stdout).toContain("0 paired devices");
    const pair = await trb(["remote", "pair"]);
    expect(pair.code).not.toBe(0);
    expect(pair.stderr).toContain("Remote access is off");
    expect((await trb(["remote", "pair", "--local"])).code).not.toBe(0);
  });

  test("tailscale is refused with a plain instruction while it is not installed", async () => {
    const r = await trb(["config", "set", "remote_mode", "tailscale"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Tailscale is not installed");
    expect(r.stderr).not.toMatch(/https?:/);
  });

  test("lan: pair prints the LAN link, QR, the warning; --local is loopback and says so", async () => {
    expect((await trb(["config", "set", "remote_mode", "lan"])).code).toBe(0);
    const pair = await trb(["remote", "pair", "--label", "My phone"]);
    expect(pair.code).toBe(0);
    expect(pair.stdout).toMatch(/http:\/\/192\.168\.1\.20:\d+\/_pair\?code=[A-Za-z0-9_-]{20,}/);
    expect(pair.stdout).not.toContain("127.0.0.1");
    expect(pair.stdout).toContain("One use, expires in 120 seconds");
    expect(pair.stdout).toContain("anyone on the same");
    const json = JSON.parse((await trb(["remote", "pair", "--json"])).stdout);
    expect(json.qr_svg).toContain("<svg");
    expect(json.local).toBe(false);

    const local = await trb(["remote", "pair", "--local"]);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain("not for phones");
    expect(local.stdout).toContain("http://127.0.0.1:");

    const st = await trb(["remote", "status"]);
    expect(st.stdout).toContain("remote mode    lan");
    expect(st.stdout).toContain("http://192.168.1.20:");

    expect((await trb(["remote", "ls"])).stdout).toContain("No paired devices");
    expect((await trb(["remote", "revoke", "rt_nope"])).code).not.toBe(0);
    expect((await trb(["remote", "revoke", "all"])).stdout).toContain("revoked 0 devices");
    expect((await trb(["config", "set", "remote_mode", "wan"])).code).not.toBe(0);
    expect((await trb(["config", "set", "remote_bind", "lan"])).code).not.toBe(0);
  });
});
